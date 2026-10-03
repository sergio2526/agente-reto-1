// Lógica de cada paso del proceso. Las herramientas (proveedor.ts) solo la envuelven con el contrato.
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { ETIQUETAS_AMBIGUAS, FORMATOS_SOPORTADOS, IDENTIFICADOR_TRIBUTARIO, NOMBRE_SOPORTE } from "../../knowledge/reglas.ts"
import { ErrorClaro } from "./contrato.ts"
import {
  existe, leerCeldas, leerGlosario, leerIndiceSoportes, leerMaestro, leerPlantilla, leerSoportesExigidos, leerSolicitud,
  rutaSalida, rutaSoportes, type CampoSolicitado, type Solicitud,
} from "./fixtures.ts"
import { escribirPdf, escribirReporteFaltantes, escribirValoresPortal, escribirXlsx } from "./formularios.ts"
import { faltante, mapearCampo, normalizar, resolverRuta, valorVisible, type CampoMapeado, type Estado } from "./mapeo.ts"
import { bloqueos, borradorCorreoMd, checklistMd, contieneDatosBancarios, evaluarSoportes, fechaEjecucion } from "./paquete.ts"

export type CampoGuardado = CampoMapeado & { obligatorio: boolean }

export interface AjusteMapeo {
  etiqueta: string
  ruta?: string | null | undefined
  estado: Estado
}

const rel = (dir: string, ruta: string) => relative(dir, ruta).split("\\").join("/")

// ---------- HU-1 ----------

export async function leerCaso(dir: string, caso: string) {
  const solicitud = await leerSolicitud(dir, caso)
  const advertencias: string[] = []
  const campos = await leerPlantilla(dir, caso, solicitud.formato).catch((e: unknown) => {
    advertencias.push(`${mensaje(e)} Se puede continuar indicando los campos manualmente; el formulario no podrá generarse.`)
    return [] as CampoSolicitado[]
  })
  const soportes = await leerSoportesExigidos(dir, caso).catch((e: unknown) => {
    advertencias.push(mensaje(e))
    return [] as string[]
  })
  const idPais = IDENTIFICADOR_TRIBUTARIO[solicitud.pais]
  const camposConEstado = campos.map((c) => {
    const ambiguo = ETIQUETAS_AMBIGUAS.some((a) => normalizar(a) === normalizar(c.etiqueta))
    return ambiguo ? { ...c, estado: "requiere_confirmacion" as const, propuesta: idPais, nota: `Etiqueta ambigua; en ${solicitud.pais} el equivalente es ${idPais}` } : c
  })
  if (!(FORMATOS_SOPORTADOS as readonly string[]).includes(solicitud.formato)) {
    advertencias.push(`Formato "${solicitud.formato}": formato no soportado para generación automática; se producirán valores listos para copiar.`)
  }
  return {
    caso,
    pais: solicitud.pais,
    cliente: solicitud.cliente,
    remitente: solicitud.de,
    asunto: solicitud.asunto,
    fecha: solicitud.fecha,
    formato: solicitud.formato,
    identificador_tributario_pais: idPais,
    campos: camposConEstado,
    soportes: soportes.map((tipo) => ({ tipo, nombre: NOMBRE_SOPORTE[tipo] ?? tipo })),
    advertencias,
  }
}

function mensaje(e: unknown): string {
  return e instanceof ErrorClaro ? e.message : "Error leyendo un archivo del caso."
}

// ---------- HU-2 ----------

export async function mapear(dir: string, caso: string, etiquetas?: string[]): Promise<CampoGuardado[]> {
  const solicitud = await leerSolicitud(dir, caso)
  const [maestro, glosario] = await Promise.all([leerMaestro(dir), leerGlosario(dir)])
  const plantilla = await leerPlantilla(dir, caso, solicitud.formato).catch(() => null)
  const solicitados = etiquetas?.length ? etiquetas : plantilla?.map((c) => c.etiqueta)
  if (!solicitados?.length) throw new ErrorClaro("La plantilla no se pudo leer y no se indicaron campos. Indica la lista de campos a mapear.")

  const campos = solicitados.map((etiqueta) => ({
    ...mapearCampo(etiqueta, solicitud.pais, glosario, maestro),
    obligatorio: plantilla?.find((p) => p.etiqueta === etiqueta)?.obligatorio ?? true,
  }))
  await guardarMapeo(dir, solicitud, campos)
  return campos
}

async function guardarMapeo(dir: string, solicitud: Solicitud, campos: CampoGuardado[]): Promise<void> {
  const salida = rutaSalida(dir, solicitud.id)
  await mkdir(salida, { recursive: true })
  await writeFile(join(salida, "mapeo.json"), JSON.stringify(campos, null, 2))
  await escribirReporteFaltantes(join(salida, "faltantes.md"), solicitud, campos)
}

async function mapeoGuardado(dir: string, caso: string): Promise<CampoGuardado[] | null> {
  try {
    return JSON.parse(await readFile(join(rutaSalida(dir, caso), "mapeo.json"), "utf8")) as CampoGuardado[]
  } catch {
    return null
  }
}

/** Vista del mapeo apta para el modelo: valores bancarios enmascarados. */
export function resumirMapeo(campos: CampoGuardado[]) {
  const vista = (c: CampoGuardado) => ({ etiqueta: c.etiqueta, valor: valorVisible(c), ruta: c.ruta, confianza: c.confianza, ...(c.nota ? { nota: c.nota } : {}) })
  return {
    llenos: campos.filter((c) => c.estado === "lleno").map(vista),
    faltantes: campos.filter((c) => c.estado === "faltante").map((c) => ({ etiqueta: c.etiqueta, obligatorio: c.obligatorio, motivo: c.nota })),
    requiere_confirmacion: campos.filter((c) => c.estado === "requiere_confirmacion").map(vista),
  }
}

/**
 * Aplica ajustes de la analista sobre el mapeo. Los valores SIEMPRE se releen del maestro
 * por ruta: el modelo puede elegir una ruta, nunca escribir un valor.
 */
async function aplicarAjustes(dir: string, solicitud: Solicitud, base: CampoGuardado[], ajustes: AjusteMapeo[]): Promise<CampoGuardado[]> {
  if (!ajustes.length) return base
  const maestro = await leerMaestro(dir)
  return base.map((campo) => {
    const ajuste = ajustes.find((a) => normalizar(a.etiqueta) === normalizar(campo.etiqueta))
    if (!ajuste || (ajuste.estado === campo.estado && (ajuste.ruta ?? campo.ruta) === campo.ruta)) return campo
    if (ajuste.estado === "faltante") return { ...faltante(campo.etiqueta, "Marcado como faltante por la analista"), obligatorio: campo.obligatorio }
    const ruta = ajuste.ruta ?? campo.ruta
    if (!ruta) return campo
    const confirmado = ajuste.estado === "lleno"
    const resuelto = resolverRuta(campo.etiqueta, { ruta, confianza: confirmado ? 1 : campo.confianza, fuente: confirmado ? "confirmado_por_usuario" : "similitud" }, solicitud.pais, maestro)
    return { ...resuelto, obligatorio: campo.obligatorio }
  })
}

// ---------- HU-3 ----------

export interface FormularioGenerado {
  ruta: string
  formato: string
  soportado: boolean
  aviso?: string
  campos: CampoGuardado[]
}

export async function generar(dir: string, caso: string, ajustes: AjusteMapeo[] = []): Promise<FormularioGenerado> {
  const solicitud = await leerSolicitud(dir, caso)
  const base = (await mapeoGuardado(dir, caso)) ?? (await mapear(dir, caso))
  const campos = await aplicarAjustes(dir, solicitud, base, ajustes)
  await guardarMapeo(dir, solicitud, campos)
  const salida = rutaSalida(dir, caso)

  if (solicitud.formato === "xlsx") {
    const ruta = join(salida, "formulario.xlsx")
    await escribirXlsx(ruta, await leerCeldas(dir, caso), campos)
    return { ruta: rel(dir, ruta), formato: "xlsx", soportado: true, campos }
  }
  if (solicitud.formato === "pdf") {
    const ruta = join(salida, "formulario.pdf")
    await escribirPdf(ruta, solicitud, campos)
    return { ruta: rel(dir, ruta), formato: "pdf", soportado: true, campos }
  }
  const ruta = join(salida, "valores-portal.md")
  const soportes = (await leerSoportesExigidos(dir, caso).catch(() => [] as string[])).map((t) => NOMBRE_SOPORTE[t] ?? t)
  await escribirValoresPortal(ruta, solicitud, campos, soportes)
  const aviso = `formato no soportado: "${solicitud.formato}". No se automatiza el portal; se generaron los valores listos para copiar.`
  return { ruta: rel(dir, ruta), formato: solicitud.formato, soportado: false, aviso, campos }
}

// ---------- HU-4 ----------

async function formularioExistente(dir: string, caso: string): Promise<string | null> {
  for (const nombre of ["formulario.xlsx", "formulario.pdf", "valores-portal.md"]) {
    const ruta = join(rutaSalida(dir, caso), nombre)
    if (await existe(ruta)) return ruta
  }
  return null
}

export async function armar(dir: string, caso: string) {
  const solicitud = await leerSolicitud(dir, caso)
  const [maestro, indice, exigidos] = await Promise.all([leerMaestro(dir), leerIndiceSoportes(dir), leerSoportesExigidos(dir, caso)])
  const advertencias: string[] = []
  let formulario = await formularioExistente(dir, caso)
  if (!formulario) {
    formulario = await generar(dir, caso).then((f) => join(dir, f.ruta), (e: unknown) => {
      advertencias.push(mensaje(e))
      return null
    })
  }
  const campos = (await mapeoGuardado(dir, caso)) ?? []
  const hoy = fechaEjecucion()
  const soportes = evaluarSoportes(exigidos, indice, hoy, solicitud.pais)
  const lista = bloqueos(soportes, formulario !== null)

  const paquete = join(rutaSalida(dir, caso), "paquete")
  await rm(paquete, { recursive: true, force: true })
  await mkdir(join(paquete, "soportes"), { recursive: true })
  const archivos: string[] = []
  if (formulario) {
    const nombre = formulario.split(/[\\/]/).pop() ?? "formulario"
    await copyFile(formulario, join(paquete, nombre))
    archivos.push(nombre)
  }
  for (const s of soportes.filter((s) => s.archivo)) {
    await copyFile(join(rutaSoportes(dir), s.archivo as string), join(paquete, "soportes", s.archivo as string))
    archivos.push(`soportes/${s.archivo}`)
  }

  const checklist = checklistMd({ solicitud, hoy, formulario: formulario ? rel(dir, formulario) : null, soportes, campos, bloqueos: lista })
  const adjuntos = [formulario ? "Formulario diligenciado y firmado" : null, ...soportes.filter((s) => s.estado === "presente").map((s) => s.nombre)].filter((a): a is string => a !== null)
  const pendientes = soportes.filter((s) => s.estado !== "presente").map((s) => s.nombre)
  const correo = borradorCorreoMd(solicitud, maestro, adjuntos, pendientes)
  if (contieneDatosBancarios(correo, maestro)) throw new ErrorClaro("El borrador de correo contenía datos bancarios y se descartó (RN2).")
  await writeFile(join(paquete, "checklist.md"), checklist)
  await writeFile(join(paquete, "borrador-correo.md"), correo)
  archivos.push("checklist.md", "borrador-correo.md")

  const listo = lista.length === 0
  const estado = { caso, fecha_ejecucion: hoy, listo_para_firma: listo, bloqueos: lista }
  await writeFile(join(rutaSalida(dir, caso), "estado.json"), JSON.stringify(estado, null, 2))

  return {
    ruta: rel(dir, paquete),
    listo_para_firma: listo,
    checklist: {
      fecha_ejecucion: hoy,
      soportes: soportes.map(({ tipo, estado, archivo, vigencia_hasta, nota }) => ({ tipo, estado, archivo, vigencia_hasta, ...(nota ? { nota } : {}) })),
      bloqueos: lista,
      campos_faltantes: campos.filter((c) => c.estado === "faltante").map((c) => c.etiqueta),
      campos_por_confirmar: campos.filter((c) => c.estado === "requiere_confirmacion").map((c) => c.etiqueta),
    },
    archivos,
    advertencias,
  }
}

// ---------- Envío simulado ----------

export async function simularEnvio(dir: string, caso: string) {
  const solicitud = await leerSolicitud(dir, caso)
  let estado: { listo_para_firma: boolean; bloqueos: string[] }
  try {
    estado = JSON.parse(await readFile(join(rutaSalida(dir, caso), "estado.json"), "utf8")) as typeof estado
  } catch {
    throw new ErrorClaro(`El paquete del caso "${caso}" no existe. Primero arma el paquete.`)
  }
  const ruta = join(rutaSalida(dir, caso), "ENVIO-SIMULADO.md")
  const advertencia = estado.listo_para_firma ? null : `El paquete NO estaba listo para firma: ${estado.bloqueos.join("; ")}`
  const md = [
    "# ENVÍO SIMULADO",
    "",
    "> Simulación: no se envió ningún correo ni se firmó ningún documento.",
    "",
    `- Fecha: ${new Date().toISOString()}`,
    `- Para: ${solicitud.de}`,
    `- Asunto: RE: ${solicitud.asunto}`,
    `- Paquete: ${rel(dir, join(rutaSalida(dir, caso), "paquete"))}`,
    `- Listo para firma: ${estado.listo_para_firma ? "sí" : "no"}`,
    "- Confirmación: explícita de la analista en el chat",
    ...(advertencia ? ["", `**Advertencia:** ${advertencia}`] : []),
    "",
  ].join("\n")
  await writeFile(ruta, md)
  return { ruta: rel(dir, ruta), listo_para_firma: estado.listo_para_firma, ...(advertencia ? { advertencia } : {}) }
}
