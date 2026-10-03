import OpenAI from "openai"
import { ErrorProveedor, type AdaptadorLLM, type DefinicionHerramienta, type Mensaje, type RespuestaLLM } from "./adapter.ts"

export interface OpcionesOpenAI {
  apiKey: string
  modelo: string
  esfuerzo: "low" | "medium" | "high"
  timeoutMs: number
}

type MensajeOpenAI = OpenAI.Chat.Completions.ChatCompletionMessageParam

export class AdaptadorOpenAI implements AdaptadorLLM {
  readonly proveedor = "openai"
  readonly modelo: string
  private readonly cliente: OpenAI

  constructor(opciones: OpcionesOpenAI) {
    this.modelo = opciones.modelo
    this.cliente = new OpenAI({ apiKey: opciones.apiKey, timeout: opciones.timeoutMs, maxRetries: 2 })
  }

  async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLLM> {
    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = herramientas.map((h) => ({
      type: "function",
      function: { name: h.nombre, description: h.descripcion, parameters: h.esquema },
    }))
    let respuesta: OpenAI.Chat.Completions.ChatCompletion
    try {
      respuesta = await this.cliente.chat.completions.create({
        model: this.modelo,
        messages: aMensajesOpenAI(mensajes),
        tools,
        max_completion_tokens: 16000,
        // No se envía reasoning_effort: en /v1/chat/completions algunos modelos (p. ej. gpt-5.4-mini)
        // rechazan herramientas + reasoning_effort con un 400.
      })
    } catch (e) {
      registrarDetalle(e)
      throw new ErrorProveedor(traducirError(e))
    }
    return deRespuesta(respuesta)
  }
}

function aMensajesOpenAI(mensajes: Mensaje[]): MensajeOpenAI[] {
  return mensajes.flatMap((m): MensajeOpenAI[] => {
    if (m.rol === "sistema") return [{ role: "system", content: m.texto }]
    if (m.rol === "usuario") return [{ role: "user", content: m.texto }]
    if (m.rol === "herramientas") return m.resultados.map((r) => ({ role: "tool", tool_call_id: r.id, content: r.contenido }))
    return [{
      role: "assistant",
      content: m.texto || null,
      ...(m.llamadas.length
        ? { tool_calls: m.llamadas.map((l) => ({ id: l.id, type: "function" as const, function: { name: l.nombre, arguments: JSON.stringify(l.args ?? {}) } })) }
        : {}),
    }]
  })
}

/** Argumentos que no son JSON válido se pasan como texto: la validación zod los rechaza y el modelo corrige. */
function parsearArgs(texto: string): unknown {
  try {
    return JSON.parse(texto || "{}")
  } catch {
    return texto
  }
}

function deRespuesta(r: OpenAI.Chat.Completions.ChatCompletion): RespuestaLLM {
  const opcion = r.choices[0]
  const mensaje = opcion?.message
  const llamadas = (mensaje?.tool_calls ?? [])
    .filter((t) => t.type === "function")
    .map((t) => ({ id: t.id, nombre: t.function.name, args: parsearArgs(t.function.arguments) }))
  const motivo = opcion?.finish_reason
  const fin = llamadas.length ? "herramientas" : motivo === "length" ? "limite" : motivo === "content_filter" ? "rechazo" : "fin"
  return {
    texto: (mensaje?.content ?? mensaje?.refusal ?? "").trim(),
    llamadas,
    uso: { entrada: r.usage?.prompt_tokens ?? 0, salida: r.usage?.completion_tokens ?? 0 },
    fin,
  }
}

/** Detalle del error solo en la consola del servidor (para diagnóstico), con cualquier clave enmascarada. */
function registrarDetalle(e: unknown): void {
  const estado = e instanceof OpenAI.APIError ? e.status : undefined
  const mensaje = e instanceof Error ? e.message.replace(/sk-[A-Za-z0-9_*-]+/g, "sk-***") : String(e)
  console.error(`[openai] ${estado ?? "sin código"}: ${mensaje}`)
}

/** Traduce errores del SDK a mensajes claros. Nunca incluye la clave ni la traza. */
function traducirError(e: unknown): string {
  if (e instanceof OpenAI.APIConnectionTimeoutError) return "El proveedor del modelo tardó demasiado en responder (timeout). Intenta de nuevo."
  if (e instanceof OpenAI.AuthenticationError) return "La clave del proveedor del modelo no es válida o no está configurada en el servidor."
  if (e instanceof OpenAI.RateLimitError) return "El proveedor del modelo está limitando las solicitudes o la cuenta no tiene saldo. Espera un momento e intenta de nuevo."
  if (e instanceof OpenAI.NotFoundError) return "El modelo configurado (LLM_MODEL) no existe o la cuenta no tiene acceso a él."
  if (e instanceof OpenAI.BadRequestError) return "El proveedor del modelo rechazó la solicitud (petición inválida). Inicia una sesión nueva si persiste."
  if (e instanceof OpenAI.APIConnectionError) return "No fue posible conectar con el proveedor del modelo. Revisa la conexión del servidor."
  if (e instanceof OpenAI.APIError) return `El proveedor del modelo devolvió un error (${e.status ?? "sin código"}). Intenta de nuevo.`
  return "Error inesperado al llamar al proveedor del modelo."
}
