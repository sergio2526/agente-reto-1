import { NOMBRE_SOPORTE } from "../../knowledge/reglas.ts"
import type { Maestro, Soporte, Solicitud } from "./fixtures.ts"
import { leerRuta, type CampoMapeado } from "./mapeo.ts"

export type EstadoSoporte = "presente" | "vencido" | "ausente"

export interface SoporteEvaluado {
  tipo: string
  nombre: string
  estado: EstadoSoporte
  archivo: string | null
  vigencia_hasta: string | null
  nota?: string
}

/** Fecha de ejecución (YYYY-MM-DD). FECHA_EJECUCION permite fijarla para pruebas reproducibles. */
export function fechaEjecucion(): string {
  const fija = process.env.FECHA_EJECUCION?.trim()
  return fija && /^\d{4}-\d{2}-\d{2}$/.test(fija) ? fija : new Date().toISOString().slice(0, 10)
}

/** RN3 · Un soporte con vigencia_hasta anterior a la fecha de ejecución está vencido. */
export function evaluarSoportes(exigidos: string[], indice: Soporte[], hoy: string, paisCliente: string): SoporteEvaluado[] {
  return exigidos.map((tipo) => {
    const nombre = NOMBRE_SOPORTE[tipo] ?? tipo
    const soporte = indice.find((s) => s.tipo === tipo)
    if (!soporte) return { tipo, nombre, estado: "ausente", archivo: null, vigencia_hasta: null, nota: "No existe en el repositorio de soportes" }
    const vencido = soporte.vigencia_hasta !== null && soporte.vigencia_hasta < hoy
    const nota = soporte.pais_emisor !== paisCliente ? `Emitido en ${soporte.pais_emisor}; verificar si el cliente exige apostilla o traducción` : undefined
    return { tipo, nombre, estado: vencido ? "vencido" : "presente", archivo: soporte.archivo, vigencia_hasta: soporte.vigencia_hasta, ...(nota ? { nota } : {}) }
  })
}

export function bloqueos(soportes: SoporteEvaluado[], formularioGenerado: boolean): string[] {
  const lista = soportes
    .filter((s) => s.estado !== "presente")
    .map((s) => (s.estado === "vencido" ? `Soporte vencido: ${s.nombre} (vigente hasta ${s.vigencia_hasta})` : `Soporte ausente: ${s.nombre}`))
  return formularioGenerado ? lista : ["El formulario no pudo generarse", ...lista]
}

interface DatosChecklist {
  solicitud: Solicitud
  hoy: string
  formulario: string | null
  soportes: SoporteEvaluado[]
  campos: CampoMapeado[]
  bloqueos: string[]
}

const ICONO: Record<EstadoSoporte, string> = { presente: "✅ presente", vencido: "⛔ vencido", ausente: "❌ ausente" }

export function checklistMd(d: DatosChecklist): string {
  const listo = d.bloqueos.length === 0
  const faltantes = d.campos.filter((c) => c.estado === "faltante")
  const confirmar = d.campos.filter((c) => c.estado === "requiere_confirmacion")
  return [
    `# Checklist del paquete · ${d.solicitud.id}`,
    "",
    `- Cliente: ${d.solicitud.cliente} (${d.solicitud.pais})`,
    `- Fecha de ejecución: ${d.hoy}`,
    `- Formulario: ${d.formulario ?? "NO GENERADO"}`,
    `- **Estado: ${listo ? "LISTO PARA FIRMA" : "BLOQUEADO — no listo para firma"}**`,
    "",
    "## Soportes exigidos",
    "",
    "| Soporte | Estado | Archivo | Vigente hasta | Nota |",
    "|---|---|---|---|---|",
    ...d.soportes.map((s) => `| ${s.nombre} | ${ICONO[s.estado]} | ${s.archivo ?? "—"} | ${s.vigencia_hasta ?? "no aplica"} | ${s.nota ?? ""} |`),
    "",
    "## Bloqueos para firma",
    "",
    ...(listo ? ["- Ninguno"] : d.bloqueos.map((b) => `- ${b}`)),
    "",
    "## Campos del formulario (no bloquean la firma)",
    "",
    `- Llenos: ${d.campos.length - faltantes.length - confirmar.length} de ${d.campos.length}`,
    ...faltantes.map((c) => `- [ ] Faltante: **${c.etiqueta}** — completar a mano o actualizar el maestro`),
    ...confirmar.map((c) => `- [ ] Confirmar: **${c.etiqueta}** — ${c.nota ?? ""}`),
    "",
    "## Cierre humano",
    "",
    "- [ ] Revisión de la analista",
    "- [ ] Firma del representante legal",
    "- [ ] Envío al cliente (el agente solo simula el envío tras confirmación explícita)",
    "",
  ].join("\n")
}

/** RN2 · El borrador solo usa datos de identificación y contacto: nunca datos bancarios. */
export function borradorCorreoMd(solicitud: Solicitud, maestro: Maestro, adjuntos: string[], pendientes: string[]): string {
  const razon = leerRuta(maestro, "razon_social") ?? "Periferia IT Group"
  const firmante = leerRuta(maestro, "contacto_financiero.nombre")
  const cargo = leerRuta(maestro, "contacto_financiero.cargo")
  return [
    `**Para:** ${solicitud.de}`,
    `**Asunto:** RE: ${solicitud.asunto}`,
    "",
    "---",
    "",
    "Buen día,",
    "",
    `En atención a su solicitud del ${solicitud.fecha}, remitimos el formulario de registro de ${razon} como proveedor de ${solicitud.cliente}, firmado por nuestro representante legal, junto con los siguientes soportes:`,
    "",
    ...adjuntos.map((a) => `- ${a}`),
    "",
    ...(pendientes.length ? ["Quedan pendientes y los remitiremos en cuanto estén disponibles:", "", ...pendientes.map((p) => `- ${p}`), ""] : []),
    "Quedamos atentos a cualquier información adicional.",
    "",
    "Cordialmente,",
    "",
    [firmante, cargo, razon].filter(Boolean).join("  \n"),
    "",
    "---",
    "_Borrador generado por el agente. Revisar antes de enviar. No incluye datos bancarios (van solo en el formulario)._",
    "",
  ].join("\n")
}

/** Verificación defensiva de RN2: ningún valor bancario del maestro puede aparecer en el correo. */
export function contieneDatosBancarios(texto: string, maestro: Maestro): boolean {
  const sensibles = ["banco.numero_cuenta", "banco.swift"].map((r) => leerRuta(maestro, r)).filter((v) => v !== null)
  return sensibles.some((v) => texto.includes(String(v)))
}
