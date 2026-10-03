// Interfaz propia del proveedor LLM. El ciclo del agente solo conoce estos tipos:
// cambiar de proveedor = escribir otra implementación de AdaptadorLLM.

export interface DefinicionHerramienta {
  nombre: string
  descripcion: string
  /** JSON Schema (objeto) de los argumentos. */
  esquema: Record<string, unknown>
}

export interface LlamadaHerramienta {
  id: string
  nombre: string
  args: unknown
}

export interface ResultadoHerramienta {
  id: string
  nombre: string
  contenido: string
  esError: boolean
}

export type Mensaje =
  | { rol: "sistema"; texto: string }
  | { rol: "usuario"; texto: string }
  | {
      rol: "asistente"
      texto: string
      llamadas: LlamadaHerramienta[]
      /** Contenido original del proveedor (p. ej. bloques de razonamiento) para reenviarlo intacto. */
      crudo?: unknown
    }
  | { rol: "herramientas"; resultados: ResultadoHerramienta[] }

export interface RespuestaLLM {
  texto: string
  llamadas: LlamadaHerramienta[]
  crudo?: unknown
  uso: { entrada: number; salida: number }
  /** fin = respuesta final · herramientas = pide ejecutar llamadas · limite = cortada por max_tokens · rechazo = el proveedor declinó */
  fin: "fin" | "herramientas" | "limite" | "rechazo"
}

export interface AdaptadorLLM {
  readonly proveedor: string
  readonly modelo: string
  enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLLM>
}

/** Error del proveedor con un mensaje apto para el chat (nunca incluye claves ni trazas). */
export class ErrorProveedor extends Error {}
