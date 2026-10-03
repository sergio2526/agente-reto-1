// Proveedor determinista SIN modelo de lenguaje. Sirve para pruebas end-to-end del ciclo y para
// demostrar que cambiar de proveedor no toca el ciclo del agente. Sigue un guion fijo:
// leer → mapear → generar → armar → resumen + pregunta; y simular_envio tras confirmación.
import type { AdaptadorLLM, DefinicionHerramienta, LlamadaHerramienta, Mensaje, RespuestaLLM } from "./adapter.ts"

const SIGUIENTE: Record<string, string> = {
  proveedor_leer_solicitud: "proveedor_mapear_campos",
  proveedor_mapear_campos: "proveedor_generar_formulario",
  proveedor_generar_formulario: "proveedor_armar_paquete",
}

type Datos = Record<string, unknown>

export class AdaptadorSimulado implements AdaptadorLLM {
  readonly proveedor = "simulado"
  readonly modelo = "guion-determinista"
  private contador = 0

  async enviar(mensajes: Mensaje[], _herramientas: DefinicionHerramienta[]): Promise<RespuestaLLM> {
    const ultimo = mensajes.at(-1)
    if (ultimo?.rol === "herramientas") return this.trasHerramientas(mensajes, ultimo.resultados[0]?.nombre ?? "")
    if (ultimo?.rol === "usuario") return this.trasUsuario(mensajes, ultimo.texto)
    return texto("No entendí la solicitud.")
  }

  private trasUsuario(mensajes: Mensaje[], entrada: string): RespuestaLLM {
    const caso = entrada.match(/\b[a-z]{2}-[a-z0-9]+(?:-[a-z0-9]+)*\b/)?.[0]
    const confirma = /\b(s[ií]|confirmo|env[ií]a(lo)?|adelante|procede)\b/i.test(entrada) && !/\bno\b/i.test(entrada)
    if (caso && !confirma) return this.llamar("proveedor_leer_solicitud", { caso })
    const anterior = casoAnterior(mensajes)
    if (confirma && anterior) return this.llamar("proveedor_simular_envio", { caso: anterior, confirmado: true })
    if (/casos|lista/i.test(entrada)) return this.llamar("proveedor_listar_casos", {})
    return texto('Indícame el caso a procesar, por ejemplo: procesa el caso "ec-corp-andina".')
  }

  private trasHerramientas(mensajes: Mensaje[], nombre: string): RespuestaLLM {
    const datos = ultimoResultado(mensajes)
    if (!datos.ok) return texto(`No pude completar ${nombre}: ${String(datos.error)}`)
    const caso = casoAnterior(mensajes)
    const siguiente = SIGUIENTE[nombre]
    if (siguiente && caso) return this.llamar(siguiente, { caso })
    if (nombre === "proveedor_armar_paquete") return texto(resumenPaquete(mensajes, datos.data as Datos))
    if (nombre === "proveedor_simular_envio") return texto(`Listo. Envío simulado registrado en \`${String((datos.data as Datos).ruta)}\`. No se envió ningún correo real.`)
    return texto("```json\n" + JSON.stringify(datos.data, null, 2) + "\n```")
  }

  private llamar(nombre: string, args: Datos): RespuestaLLM {
    const llamada: LlamadaHerramienta = { id: `sim_${++this.contador}`, nombre, args }
    return { texto: "", llamadas: [llamada], uso: { entrada: 0, salida: 0 }, fin: "herramientas" }
  }
}

function texto(t: string): RespuestaLLM {
  return { texto: t, llamadas: [], uso: { entrada: 0, salida: 0 }, fin: "fin" }
}

function casoAnterior(mensajes: Mensaje[]): string | undefined {
  for (const m of [...mensajes].reverse()) {
    const args = m.rol === "asistente" ? (m.llamadas[0]?.args as Datos | undefined) : undefined
    if (typeof args?.caso === "string") return args.caso
  }
  return undefined
}

function ultimoResultado(mensajes: Mensaje[]): Datos {
  const m = mensajes.at(-1)
  return m?.rol === "herramientas" && m.resultados[0] ? (JSON.parse(m.resultados[0].contenido) as Datos) : {}
}

function resultadoDe(mensajes: Mensaje[], nombre: string): Datos {
  for (const m of [...mensajes].reverse()) {
    const r = m.rol === "herramientas" ? m.resultados.find((x) => x.nombre === nombre) : undefined
    if (r) return (JSON.parse(r.contenido) as { data?: Datos }).data ?? {}
  }
  return {}
}

const etiquetas = (v: unknown) => (Array.isArray(v) && v.length ? v.map((x: Datos) => String(x.etiqueta)).join(", ") : "ninguno")

function resumenPaquete(mensajes: Mensaje[], paquete: Datos): string {
  const mapeo = resultadoDe(mensajes, "proveedor_mapear_campos")
  const form = resultadoDe(mensajes, "proveedor_generar_formulario")
  const checklist = paquete.checklist as { bloqueos: string[] }
  return [
    `**Formulario:** \`${String(form.ruta)}\`${form.aviso ? ` (${String(form.aviso)})` : ""}`,
    `**Campos llenos (${(mapeo.llenos as unknown[]).length}):** ${etiquetas(mapeo.llenos)}`,
    `**Faltantes:** ${etiquetas(mapeo.faltantes)}`,
    `**Requieren confirmación:** ${etiquetas(mapeo.requiere_confirmacion)}`,
    `**Paquete:** \`${String(paquete.ruta)}\` · listo_para_firma: **${paquete.listo_para_firma ? "sí" : "no"}**`,
    ...checklist.bloqueos.map((b) => `- ${b}`),
    "",
    "¿Confirmas que simule el envío del paquete? Responde \"sí, envía\" para confirmar. [[CONFIRMACION]]",
  ].join("\n")
}
