import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { z } from "zod"

/** Contexto que el backend (o demo.ts) entrega a cada herramienta. */
export interface ContextoHerramienta {
  /** Raíz del proyecto. Todas las rutas se resuelven desde aquí. */
  directory: string
  sessionId: string
  /**
   * RN4 · Lo calcula el ciclo del agente: true solo si el mensaje inmediatamente anterior
   * del usuario confirma explícitamente una pregunta de confirmación. Si se omite
   * (uso fuera del servidor), la herramienta se basa solo en su argumento `confirmado`.
   */
  confirmacionHumana?: boolean
}

/** Contrato de herramienta del PRD (sección 6.2). */
export interface Herramienta<S extends z.ZodRawShape = z.ZodRawShape> {
  description: string
  args: S
  execute(args: z.infer<z.ZodObject<S>>, ctx: ContextoHerramienta): Promise<string>
}

export type Resultado<T> = { ok: true; data: T } | { ok: false; error: string }

/** Error esperado, con un mensaje apto para mostrar a la analista. */
export class ErrorClaro extends Error {}

interface Salida<T> {
  data: T
  /** Resumen corto para el log (sin valores sensibles). */
  resumen: string
}

/**
 * Ejecuta el cuerpo de una herramienta garantizando el contrato:
 * nunca lanza, siempre devuelve `{ ok, data }` o `{ ok: false, error }` serializado,
 * y deja registro en out/log.jsonl y out/<caso>/log.jsonl (RN5, CA4).
 */
export async function ejecutar<T>(
  ctx: ContextoHerramienta,
  herramienta: string,
  caso: string | null,
  cuerpo: () => Promise<Salida<T>>,
): Promise<string> {
  let resultado: Resultado<T>
  let resumen: string
  try {
    const salida = await cuerpo()
    resultado = { ok: true, data: salida.data }
    resumen = salida.resumen
  } catch (e) {
    const error = e instanceof ErrorClaro ? e.message : `Error interno en ${herramienta}. Revisa los archivos del caso.`
    resultado = { ok: false, error }
    resumen = error
  }
  await registrar(ctx, caso, { herramienta, ok: resultado.ok, resumen })
  return JSON.stringify(resultado)
}

interface EntradaLog {
  herramienta: string
  ok: boolean
  resumen: string
}

async function registrar(ctx: ContextoHerramienta, caso: string | null, entrada: EntradaLog): Promise<void> {
  const registro = { ts: new Date().toISOString(), ...entrada }
  const out = join(ctx.directory, "out")
  try {
    await mkdir(out, { recursive: true })
    await appendFile(join(out, "log.jsonl"), JSON.stringify({ ...registro, sessionId: ctx.sessionId, caso }) + "\n")
    if (caso && esNombreCasoValido(caso)) {
      await mkdir(join(out, caso), { recursive: true })
      await appendFile(join(out, caso, "log.jsonl"), JSON.stringify(registro) + "\n")
    }
  } catch {
    // El log nunca debe tumbar una herramienta.
  }
}

export function esNombreCasoValido(caso: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,80}$/.test(caso)
}
