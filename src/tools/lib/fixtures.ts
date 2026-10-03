import { access, readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { ErrorClaro, esNombreCasoValido } from "./contrato.ts"

// Esquemas de los archivos de entrada. Validarlos permite reportar "plantilla corrupta" con claridad.

export const SolicitudSchema = z.object({
  id: z.string(),
  de: z.string(),
  asunto: z.string(),
  fecha: z.string(),
  pais: z.enum(["CO", "EC", "PE", "PA", "HN"]),
  cliente: z.string(),
  cuerpo: z.string(),
  formato: z.string(),
  adjuntos: z.array(z.string()),
})
export type Solicitud = z.infer<typeof SolicitudSchema>

export const CeldaSchema = z.object({
  hoja: z.string().min(1),
  celda_etiqueta: z.string().regex(/^[A-Z]+\d+$/),
  etiqueta: z.string().min(1),
  celda_valor: z.string().regex(/^[A-Z]+\d+$/),
})
export type Celda = z.infer<typeof CeldaSchema>

export const CampoPdfSchema = z.object({ etiqueta: z.string().min(1), obligatorio: z.boolean() })

export const SoporteSchema = z.object({
  tipo: z.string(),
  archivo: z.string(),
  vigencia_hasta: z.string().nullable(),
  pais_emisor: z.string(),
  descripcion: z.string().optional(),
})
export type Soporte = z.infer<typeof SoporteSchema>

export type Maestro = Record<string, unknown>

/** Campo solicitado por el cliente, independiente del formato de la plantilla. */
export interface CampoSolicitado {
  etiqueta: string
  obligatorio: boolean
  hoja?: string
  celda_etiqueta?: string
  celda_valor?: string
}

export const rutaFixtures = (dir: string) => join(dir, "fixtures", "reto-01")
export const rutaCaso = (dir: string, caso: string) => join(rutaFixtures(dir), "casos", caso)
export const rutaSoportes = (dir: string) => join(rutaFixtures(dir), "repositorio", "soportes")
export const rutaSalida = (dir: string, caso: string) => join(dir, "out", caso)

async function existe(ruta: string): Promise<boolean> {
  return access(ruta).then(() => true, () => false)
}

async function leerJson<T>(ruta: string, esquema: z.ZodType<T>, descripcion: string): Promise<T> {
  let texto: string
  try {
    texto = await readFile(ruta, "utf8")
  } catch {
    throw new ErrorClaro(`No se encontró ${descripcion}.`)
  }
  let crudo: unknown
  try {
    crudo = JSON.parse(texto)
  } catch {
    throw new ErrorClaro(`${descripcion} está corrupto: no es JSON válido.`)
  }
  const r = esquema.safeParse(crudo)
  if (!r.success) throw new ErrorClaro(`${descripcion} está corrupto: no cumple la estructura esperada.`)
  return r.data
}

export async function listarCasos(dir: string): Promise<string[]> {
  try {
    const entradas = await readdir(join(rutaFixtures(dir), "casos"), { withFileTypes: true })
    return entradas.filter((e) => e.isDirectory()).map((e) => e.name).sort()
  } catch {
    return []
  }
}

/** Verifica que el caso exista; si no, lanza un error claro con los casos disponibles. */
export async function validarCaso(dir: string, caso: string): Promise<void> {
  if (esNombreCasoValido(caso) && (await existe(join(rutaCaso(dir, caso), "solicitud.json")))) return
  const disponibles = await listarCasos(dir)
  throw new ErrorClaro(`Caso inexistente: "${caso}". Casos disponibles: ${disponibles.join(", ") || "ninguno"}.`)
}

export async function leerSolicitud(dir: string, caso: string): Promise<Solicitud> {
  await validarCaso(dir, caso)
  return leerJson(join(rutaCaso(dir, caso), "solicitud.json"), SolicitudSchema, `La solicitud del caso "${caso}"`)
}

/** Lee la plantilla según el formato. Portal: los campos vienen en plantilla-campos.json si existe. */
export async function leerPlantilla(dir: string, caso: string, formato: string): Promise<CampoSolicitado[]> {
  if (formato === "xlsx") {
    const celdas = await leerCeldas(dir, caso)
    return celdas.map((c) => ({ ...c, obligatorio: true }))
  }
  const ruta = join(rutaCaso(dir, caso), "plantilla-campos.json")
  return leerJson(ruta, z.array(CampoPdfSchema).min(1), "La plantilla de campos (plantilla-campos.json)")
}

export async function leerCeldas(dir: string, caso: string): Promise<Celda[]> {
  return leerJson(join(rutaCaso(dir, caso), "plantilla-celdas.json"), z.array(CeldaSchema).min(1), "La plantilla Excel (plantilla-celdas.json)")
}

export async function leerSoportesExigidos(dir: string, caso: string): Promise<string[]> {
  return leerJson(join(rutaCaso(dir, caso), "soportes-exigidos.json"), z.array(z.string()), "La lista de soportes exigidos")
}

export async function leerMaestro(dir: string): Promise<Maestro> {
  const ruta = join(rutaFixtures(dir), "repositorio", "maestro.json")
  return leerJson(ruta, z.record(z.string(), z.unknown()), "El repositorio maestro (maestro.json)")
}

export async function leerGlosario(dir: string): Promise<Record<string, string>> {
  return leerJson(join(rutaFixtures(dir), "glosario-campos.json"), z.record(z.string(), z.string()), "El glosario de campos")
}

export async function leerIndiceSoportes(dir: string): Promise<Soporte[]> {
  return leerJson(join(rutaSoportes(dir), "index.json"), z.array(SoporteSchema), "El índice de soportes")
}

export { existe }
