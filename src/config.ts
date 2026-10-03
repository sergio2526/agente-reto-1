import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

try {
  process.loadEnvFile()
} catch {
  // Sin .env: se usan las variables del entorno (p. ej. en el despliegue).
}

const entero = (valor: string | undefined, defecto: number) => {
  const n = Number.parseInt(valor ?? "", 10)
  return Number.isFinite(n) && n > 0 ? n : defecto
}

const esfuerzo = (valor: string | undefined): "low" | "medium" | "high" =>
  valor === "low" || valor === "high" ? valor : "medium"

const proveedor = process.env.LLM_PROVIDER?.trim() || "openai"
const MODELO_POR_DEFECTO: Record<string, string> = { openai: "gpt-5.4-mini", anthropic: "claude-opus-5" }

export const CONFIG = {
  raiz: join(dirname(fileURLToPath(import.meta.url)), ".."),
  puerto: entero(process.env.PORT, 3002),
  proveedor,
  modelo: process.env.LLM_MODEL?.trim() || MODELO_POR_DEFECTO[proveedor] || "",
  esfuerzo: esfuerzo(process.env.LLM_EFFORT),
  timeoutMs: entero(process.env.LLM_TIMEOUT_MS, 90_000),
  maxIteraciones: entero(process.env.MAX_ITERACIONES, 25),
  maxTokensSesion: entero(process.env.MAX_TOKENS_SESION, 400_000),
  claveAcceso: process.env.ACCESS_KEY?.trim() || null,
} as const

/** La clave del proveedor no se guarda en CONFIG para que nunca termine serializada. */
export const claveProveedor = (nombre: string) =>
  (nombre === "openai" ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY)?.trim() || ""
