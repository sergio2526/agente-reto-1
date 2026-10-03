import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Mensaje } from "../llm/adapter.ts"

/** Llamada a herramienta tal como se muestra en el chat. */
export interface LlamadaVisible {
  nombre: string
  args: unknown
  ok: boolean
  resumen: string
  resultado: unknown
}

/** Evento visible del historial (lo que el front pinta). */
export interface Evento {
  rol: "usuario" | "asistente"
  texto: string
  toolCalls: LlamadaVisible[]
  needsConfirmation: boolean
  ts: string
}

export interface Sesion {
  id: string
  /** Historial en el formato neutro que se envía al proveedor LLM. */
  historial: Mensaje[]
  eventos: Evento[]
  tokens: number
  /** CA3 · El último turno terminó con una pregunta de confirmación pendiente. */
  pendienteConfirmacion: boolean
  ocupada: boolean
}

const memoria = new Map<string, Sesion>()

const archivo = (raiz: string, id: string) => join(raiz, "out", "sesiones", `${id}.json`)

export function idValido(id: string): boolean {
  return /^[A-Za-z0-9_-]{6,64}$/.test(id)
}

/** Obtiene la sesión de memoria; si el proceso se reinició, la recupera de out/sesiones/. */
export async function obtenerSesion(raiz: string, id: string): Promise<Sesion> {
  const enMemoria = memoria.get(id)
  if (enMemoria) return enMemoria
  let sesion: Sesion = { id, historial: [], eventos: [], tokens: 0, pendienteConfirmacion: false, ocupada: false }
  try {
    sesion = { ...(JSON.parse(await readFile(archivo(raiz, id), "utf8")) as Sesion), ocupada: false }
  } catch {
    // Sesión nueva.
  }
  memoria.set(id, sesion)
  return sesion
}

export async function buscarSesion(raiz: string, id: string): Promise<Sesion | null> {
  if (memoria.has(id)) return memoria.get(id) ?? null
  try {
    await readFile(archivo(raiz, id), "utf8")
    return obtenerSesion(raiz, id)
  } catch {
    return null
  }
}

export async function guardarSesion(raiz: string, sesion: Sesion): Promise<void> {
  try {
    await mkdir(join(raiz, "out", "sesiones"), { recursive: true })
    await writeFile(archivo(raiz, sesion.id), JSON.stringify({ ...sesion, ocupada: false }))
  } catch {
    // La sesión sigue en memoria aunque no se pueda escribir el archivo.
  }
}
