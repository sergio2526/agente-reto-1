import {
  CLAVE_ID_TRIBUTARIO,
  ETIQUETAS_AMBIGUAS,
  IDENTIFICADOR_TRIBUTARIO,
  PAIS_MAESTRO,
  PALABRAS_VACIAS,
  PREFIJO_BANCARIO,
  UMBRAL_CONFIANZA,
  UMBRAL_PROPUESTA,
  type Pais,
} from "../../knowledge/reglas.ts"
import type { Maestro } from "./fixtures.ts"

export type Valor = string | number | boolean
export type Estado = "lleno" | "faltante" | "requiere_confirmacion"

/** Resultado del cruce de un campo solicitado con el maestro. */
export interface CampoMapeado {
  etiqueta: string
  estado: Estado
  /** Ruta del dato en el maestro (trazabilidad). null si no hay fuente. */
  ruta: string | null
  /** Valor tomado del maestro. Nunca se infiere ni se compone. */
  valor: Valor | null
  confianza: number
  fuente: "glosario" | "similitud" | "confirmado_por_usuario" | "sin_fuente"
  sensible: boolean
  nota?: string
}

interface Candidato {
  ruta: string
  confianza: number
  fuente: "glosario" | "similitud"
}

export function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim()
}

function tokens(texto: string): Set<string> {
  const raiz = (t: string) => t.replace(/(es|s)$/, "")
  return new Set(normalizar(texto).split(" ").filter((t) => t && !PALABRAS_VACIAS.includes(t)).map(raiz))
}

/** Coeficiente de Dice entre conjuntos de palabras: 1 = misma etiqueta, 0 = nada en común. */
function similitud(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  const comunes = [...ta].filter((t) => tb.has(t)).length
  return (2 * comunes) / (ta.size + tb.size)
}

/** Lee un valor del maestro por ruta con puntos ("banco.numero_cuenta"). */
export function leerRuta(maestro: Maestro, ruta: string): Valor | null {
  let actual: unknown = maestro
  for (const parte of ruta.split(".")) {
    if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return null
    actual = (actual as Record<string, unknown>)[parte]
  }
  if (Array.isArray(actual) && actual.every((v) => typeof v === "string")) return actual.join(", ")
  if (typeof actual === "string") return actual.trim() === "" ? null : actual
  if (typeof actual === "number" || typeof actual === "boolean") return actual
  return null
}

/** Todas las rutas hoja del maestro, para el cruce por similitud. */
function rutasHoja(objeto: Record<string, unknown>, prefijo = ""): string[] {
  return Object.entries(objeto).flatMap(([clave, valor]) => {
    const ruta = prefijo ? `${prefijo}.${clave}` : clave
    const esObjeto = typeof valor === "object" && valor !== null && !Array.isArray(valor)
    return esObjeto ? rutasHoja(valor as Record<string, unknown>, ruta) : [ruta]
  })
}

function buscarCandidato(etiqueta: string, glosario: Record<string, string>, maestro: Maestro): Candidato | null {
  const n = normalizar(etiqueta)
  const exacta = Object.entries(glosario).find(([sinonimo]) => normalizar(sinonimo) === n)
  if (exacta) return { ruta: exacta[1], confianza: 1, fuente: "glosario" }

  const opciones: Array<[string, string]> = [
    ...Object.entries(glosario),
    ...rutasHoja(maestro).map((r): [string, string] => [r.replace(/[._]/g, " "), r]),
  ]
  let mejor: Candidato | null = null
  for (const [texto, ruta] of opciones) {
    const confianza = Math.round(similitud(etiqueta, texto) * 100) / 100
    if (!mejor || confianza > mejor.confianza) mejor = { ruta, confianza, fuente: "similitud" }
  }
  return mejor && mejor.confianza >= UMBRAL_PROPUESTA ? mejor : null
}

/** RN1 · Nota de confirmación para el identificador tributario, o null si no aplica. */
function notaIdentificador(etiqueta: string, pais: Pais): string | null {
  const esperado = IDENTIFICADOR_TRIBUTARIO[pais]
  const notas: string[] = []
  if (ETIQUETAS_AMBIGUAS.some((a) => normalizar(a) === normalizar(etiqueta))) {
    notas.push(`Etiqueta ambigua; en ${pais} el equivalente es ${esperado}`)
  }
  if (pais !== PAIS_MAESTRO) {
    notas.push(`identificador extranjero: el cliente (${pais}) pide ${esperado}; se usa el NIT colombiano de Periferia`)
  }
  return notas.length ? notas.join(". ") : null
}

/** HU-2 · Cruza una etiqueta con el maestro. Un campo sin fuente es faltante: nunca se inventa. */
export function mapearCampo(etiqueta: string, pais: Pais, glosario: Record<string, string>, maestro: Maestro): CampoMapeado {
  const candidato = buscarCandidato(etiqueta, glosario, maestro)
  if (!candidato) return faltante(etiqueta, "No existe un dato equivalente en el repositorio maestro")
  return resolverRuta(etiqueta, candidato, pais, maestro)
}

/** Resuelve un campo a partir de una ruta conocida (del cruce o de un mapeo confirmado). */
export function resolverRuta(etiqueta: string, candidato: Candidato | { ruta: string; confianza: number; fuente: "confirmado_por_usuario" }, pais: Pais, maestro: Maestro): CampoMapeado {
  const valor = leerRuta(maestro, candidato.ruta)
  if (valor === null) return faltante(etiqueta, `La clave "${candidato.ruta}" no tiene valor en el maestro`)

  const base = { etiqueta, ruta: candidato.ruta, valor, confianza: candidato.confianza, fuente: candidato.fuente, sensible: candidato.ruta.startsWith(PREFIJO_BANCARIO) }
  const notaId = candidato.ruta === CLAVE_ID_TRIBUTARIO ? notaIdentificador(etiqueta, pais) : null
  if (notaId && candidato.fuente !== "confirmado_por_usuario") return { ...base, estado: "requiere_confirmacion", nota: notaId }
  if (candidato.confianza < UMBRAL_CONFIANZA) {
    return { ...base, estado: "requiere_confirmacion", nota: `Mapeo por similitud con confianza ${candidato.confianza} (< ${UMBRAL_CONFIANZA}); confirmar que "${etiqueta}" corresponde a "${candidato.ruta}"` }
  }
  const contexto = notaContexto(maestro, candidato.ruta)
  return contexto ? { ...base, estado: "lleno", nota: contexto } : { ...base, estado: "lleno" }
}

/** Para montos ("x.valor") agrega moneda y año del mismo nodo del maestro, sin transformarlos. */
function notaContexto(maestro: Maestro, ruta: string): string | null {
  if (!ruta.endsWith(".valor")) return null
  const padre = ruta.slice(0, -".valor".length)
  const moneda = leerRuta(maestro, `${padre}.moneda`)
  const ano = leerRuta(maestro, `${padre}.ano`)
  return moneda ? `Moneda: ${moneda}${ano ? `, año ${ano}` : ""}` : null
}

export function faltante(etiqueta: string, nota: string): CampoMapeado {
  return { etiqueta, estado: "faltante", ruta: null, valor: null, confianza: 0, fuente: "sin_fuente", sensible: false, nota }
}

/** Valor apto para mostrar fuera del formulario (chat, logs): los datos bancarios se enmascaran. */
export function valorVisible(campo: CampoMapeado): Valor | null {
  if (campo.valor === null || !campo.sensible) return campo.valor
  const texto = String(campo.valor)
  return /\d{4,}/.test(texto) ? `****${texto.slice(-4)}` : texto
}
