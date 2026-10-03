import Anthropic from "@anthropic-ai/sdk"
import { ErrorProveedor, type AdaptadorLLM, type DefinicionHerramienta, type Mensaje, type RespuestaLLM } from "./adapter.ts"

export interface OpcionesAnthropic {
  apiKey: string
  modelo: string
  esfuerzo: "low" | "medium" | "high"
  timeoutMs: number
}

export class AdaptadorAnthropic implements AdaptadorLLM {
  readonly proveedor = "anthropic"
  readonly modelo: string
  private readonly cliente: Anthropic
  private readonly esfuerzo: OpcionesAnthropic["esfuerzo"]

  constructor(opciones: OpcionesAnthropic) {
    this.modelo = opciones.modelo
    this.esfuerzo = opciones.esfuerzo
    this.cliente = new Anthropic({ apiKey: opciones.apiKey, timeout: opciones.timeoutMs, maxRetries: 2 })
  }

  async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLLM> {
    const sistema = mensajes.filter((m) => m.rol === "sistema").map((m) => m.texto).join("\n\n")
    const tools: Anthropic.Tool[] = herramientas.map((h) => ({
      name: h.nombre,
      description: h.descripcion,
      input_schema: h.esquema as Anthropic.Tool.InputSchema,
    }))
    let respuesta: Anthropic.Message
    try {
      respuesta = await this.cliente.messages.create({
        model: this.modelo,
        max_tokens: 16000,
        // El prompt y las herramientas son estables: se cachean para abaratar cada iteración.
        system: [{ type: "text", text: sistema, cache_control: { type: "ephemeral" } }],
        tools,
        messages: aMensajesAnthropic(mensajes),
        thinking: { type: "adaptive" },
        output_config: { effort: this.esfuerzo },
      })
    } catch (e) {
      throw new ErrorProveedor(traducirError(e))
    }
    return deRespuesta(respuesta)
  }
}

function aMensajesAnthropic(mensajes: Mensaje[]): Anthropic.MessageParam[] {
  const salida: Anthropic.MessageParam[] = []
  for (const m of mensajes) {
    if (m.rol === "usuario") salida.push({ role: "user", content: m.texto })
    if (m.rol === "asistente") salida.push({ role: "assistant", content: (m.crudo as Anthropic.ContentBlockParam[] | undefined) ?? aBloques(m) })
    if (m.rol === "herramientas") {
      salida.push({
        role: "user",
        content: m.resultados.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.contenido, is_error: r.esError })),
      })
    }
  }
  return salida
}

/** Para mensajes de asistente sin contenido original (p. ej. generados por el ciclo al llegar al tope). */
function aBloques(m: Extract<Mensaje, { rol: "asistente" }>): Anthropic.ContentBlockParam[] {
  const bloques: Anthropic.ContentBlockParam[] = m.texto ? [{ type: "text", text: m.texto }] : []
  return [...bloques, ...m.llamadas.map((l): Anthropic.ToolUseBlockParam => ({ type: "tool_use", id: l.id, name: l.nombre, input: l.args }))]
}

function deRespuesta(r: Anthropic.Message): RespuestaLLM {
  const texto = r.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim()
  const llamadas = r.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
    .map((b) => ({ id: b.id, nombre: b.name, args: b.input }))
  const fin = r.stop_reason === "tool_use" ? "herramientas" : r.stop_reason === "max_tokens" ? "limite" : r.stop_reason === "refusal" ? "rechazo" : "fin"
  return { texto, llamadas, crudo: r.content, uso: { entrada: totalEntrada(r.usage), salida: r.usage.output_tokens }, fin }
}

function totalEntrada(u: Anthropic.Usage): number {
  return u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
}

/** Traduce errores del SDK a mensajes claros. Nunca incluye la clave ni la traza. */
function traducirError(e: unknown): string {
  if (e instanceof Anthropic.APIConnectionTimeoutError) return "El proveedor del modelo tardó demasiado en responder (timeout). Intenta de nuevo."
  if (e instanceof Anthropic.AuthenticationError) return "La clave del proveedor del modelo no es válida o no está configurada en el servidor."
  if (e instanceof Anthropic.RateLimitError) return "El proveedor del modelo está limitando las solicitudes. Espera un momento e intenta de nuevo."
  if (e instanceof Anthropic.BadRequestError) return "El proveedor del modelo rechazó la solicitud (petición inválida). Inicia una sesión nueva si persiste."
  if (e instanceof Anthropic.APIConnectionError) return "No fue posible conectar con el proveedor del modelo. Revisa la conexión del servidor."
  if (e instanceof Anthropic.APIError) return `El proveedor del modelo devolvió un error (${e.status ?? "sin código"}). Intenta de nuevo.`
  return "Error inesperado al llamar al proveedor del modelo."
}
