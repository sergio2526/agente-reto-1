import { CONFIG, claveProveedor } from "../config.ts"
import type { AdaptadorLLM } from "./adapter.ts"
import { AdaptadorAnthropic } from "./anthropic.ts"
import { AdaptadorOpenAI } from "./openai.ts"
import { AdaptadorSimulado } from "./simulado.ts"

const IMPLEMENTACIONES = { anthropic: AdaptadorAnthropic, openai: AdaptadorOpenAI } as const

/** Único punto que conoce las implementaciones concretas de proveedor. */
export function crearAdaptador(): AdaptadorLLM {
  if (CONFIG.proveedor === "simulado") return new AdaptadorSimulado()
  if (!(CONFIG.proveedor in IMPLEMENTACIONES)) throw new Error(`LLM_PROVIDER desconocido: ${CONFIG.proveedor}`)
  const nombre = CONFIG.proveedor as keyof typeof IMPLEMENTACIONES
  const apiKey = claveProveedor(nombre)
  if (!apiKey) {
    console.warn(`No hay clave para '${nombre}': se usa el proveedor 'simulado' (sin modelo).`)
    return new AdaptadorSimulado()
  }
  return new IMPLEMENTACIONES[nombre]({ apiKey, modelo: CONFIG.modelo, esfuerzo: CONFIG.esfuerzo, timeoutMs: CONFIG.timeoutMs })
}
