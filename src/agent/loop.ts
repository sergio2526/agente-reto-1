// Ciclo del agente: prompt → modelo → herramientas → ... → respuesta.
// Independiente del proveedor (solo usa AdaptadorLLM) y del servidor HTTP.
import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { ErrorProveedor, type AdaptadorLLM, type Mensaje, type ResultadoHerramienta } from "../llm/adapter.ts"
import { DEFINICIONES, ejecutarHerramienta } from "./registro.ts"
import type { LlamadaVisible, Sesion } from "./sesiones.ts"

/** Marca que el prompt pide al modelo al cerrar con una pregunta de confirmación. */
const MARCA_CONFIRMACION = "[[CONFIRMACION]]"

export interface Dependencias {
  llm: AdaptadorLLM
  sistema: string
  raiz: string
  maxIteraciones: number
  maxTokensSesion: number
}

export interface ResultadoTurno {
  reply: string
  toolCalls: LlamadaVisible[]
  needsConfirmation: boolean
}

/** RN4 · ¿El mensaje confirma explícitamente? Una negación siempre gana. */
export function esConfirmacion(texto: string): boolean {
  const t = texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  if (/\b(no|todavia|aun no|espera|cancela|cancelar|detente)\b/.test(t)) return false
  return /\b(si|confirmo|confirmado|envia|envialo|enviar|adelante|procede|dale|hazlo|de acuerdo|ok|autorizo)\b/.test(t)
}

export async function procesarTurno(sesion: Sesion, entrada: string, deps: Dependencias): Promise<ResultadoTurno> {
  // CA3/RN4 · La confirmación solo vale si responde a una pregunta pendiente del turno anterior.
  const ctx = { directory: deps.raiz, sessionId: sesion.id, confirmacionHumana: sesion.pendienteConfirmacion && esConfirmacion(entrada) }
  sesion.historial.push({ rol: "usuario", texto: entrada })
  if (sesion.tokens >= deps.maxTokensSesion) {
    return cerrar(sesion, entrada, `Esta sesión alcanzó el tope de ${deps.maxTokensSesion} tokens. Abre una sesión nueva para continuar.`, [], false)
  }
  const llamadas: LlamadaVisible[] = []

  for (let i = 0; i < deps.maxIteraciones; i++) {
    let respuesta
    try {
      respuesta = await deps.llm.enviar([{ rol: "sistema", texto: deps.sistema }, ...sesion.historial], DEFINICIONES)
    } catch (e) {
      // CA5 · El error se muestra en lenguaje claro y la sesión sigue viva.
      const msg = e instanceof ErrorProveedor ? e.message : "Error inesperado al consultar el modelo."
      return cerrar(sesion, entrada, `⚠️ ${msg}`, llamadas, false)
    }
    sesion.tokens += respuesta.uso.entrada + respuesta.uso.salida
    sesion.historial.push({ rol: "asistente", texto: respuesta.texto, llamadas: respuesta.llamadas, crudo: respuesta.crudo })

    if (respuesta.llamadas.length === 0) {
      const texto = respuesta.fin === "rechazo" ? "El proveedor del modelo declinó responder esta solicitud. Reformúlala, por favor." : respuesta.texto
      return finalizar(sesion, entrada, texto, llamadas)
    }
    sesion.historial.push({ rol: "herramientas", resultados: await ejecutarTodas(respuesta.llamadas, ctx, llamadas, deps.raiz) })
    if (sesion.tokens >= deps.maxTokensSesion) break
  }
  // CA1 · Tope alcanzado: se responde con lo que hay y lo que falta.
  return cerrar(sesion, entrada, mensajeTope(deps.maxIteraciones, llamadas), llamadas, false)
}

async function ejecutarTodas(
  pedidas: Array<{ id: string; nombre: string; args: unknown }>,
  ctx: { directory: string; sessionId: string; confirmacionHumana: boolean },
  visibles: LlamadaVisible[],
  raiz: string,
): Promise<ResultadoHerramienta[]> {
  const resultados: ResultadoHerramienta[] = []
  for (const l of pedidas) {
    const contenido = await ejecutarHerramienta(l.nombre, l.args, ctx)
    const parsed = JSON.parse(contenido) as { ok: boolean; data?: unknown; error?: string }
    visibles.push({ nombre: l.nombre, args: l.args, ok: parsed.ok, resumen: parsed.ok ? "ok" : parsed.error ?? "error", resultado: parsed.ok ? parsed.data : parsed.error })
    resultados.push({ id: l.id, nombre: l.nombre, contenido, esError: !parsed.ok })
    if (!parsed.ok) await registrarRechazo(raiz, ctx.sessionId, l.nombre, parsed.error ?? "error")
  }
  return resultados
}

/** CA4 · Los rechazos de validación no llegan a la herramienta; se registran aquí. */
async function registrarRechazo(raiz: string, sessionId: string, herramienta: string, error: string): Promise<void> {
  if (!error.startsWith("Argumentos inválidos") && !error.startsWith("Herramienta desconocida")) return
  try {
    await mkdir(join(raiz, "out"), { recursive: true })
    await appendFile(join(raiz, "out", "log.jsonl"), JSON.stringify({ ts: new Date().toISOString(), sessionId, herramienta, ok: false, resumen: error }) + "\n")
  } catch {
    // El log nunca interrumpe el turno.
  }
}

function finalizar(sesion: Sesion, entrada: string, texto: string, llamadas: LlamadaVisible[]): ResultadoTurno {
  const marcada = texto.includes(MARCA_CONFIRMACION)
  // Salvaguarda: si se armó un paquete y no se envió, el turno queda esperando confirmación.
  const armado = llamadas.some((l) => l.nombre === "proveedor_armar_paquete" && l.ok)
  const enviado = llamadas.some((l) => l.nombre === "proveedor_simular_envio" && l.ok)
  const needsConfirmation = marcada || (armado && !enviado)
  const limpio = texto.replaceAll(MARCA_CONFIRMACION, "").trim() || "(sin respuesta del modelo)"
  return cerrar(sesion, entrada, limpio, llamadas, needsConfirmation)
}

function cerrar(sesion: Sesion, entrada: string, reply: string, toolCalls: LlamadaVisible[], needsConfirmation: boolean): ResultadoTurno {
  const ts = new Date().toISOString()
  // El historial del proveedor debe terminar en un mensaje final del asistente (sin llamadas pendientes).
  const ultimo: Mensaje | undefined = sesion.historial.at(-1)
  if (ultimo?.rol !== "asistente" || ultimo.llamadas.length > 0) sesion.historial.push({ rol: "asistente", texto: reply, llamadas: [] })
  sesion.eventos.push(
    { rol: "usuario", texto: entrada, toolCalls: [], needsConfirmation: false, ts },
    { rol: "asistente", texto: reply, toolCalls, needsConfirmation, ts },
  )
  sesion.pendienteConfirmacion = needsConfirmation
  return { reply, toolCalls, needsConfirmation }
}

function mensajeTope(max: number, llamadas: LlamadaVisible[]): string {
  const hechas = llamadas.filter((l) => l.ok).map((l) => l.nombre)
  const fallidas = llamadas.filter((l) => !l.ok).map((l) => `${l.nombre}: ${l.resumen}`)
  return [
    `Alcancé el tope de ${max} iteraciones en este turno y me detengo aquí.`,
    `**Lo que tengo:** ${hechas.length ? [...new Set(hechas)].join(", ") : "nada completado"}.`,
    `**Lo que falta o falló:** ${fallidas.length ? fallidas.join("; ") : "continuar el proceso"}.`,
    "Pídeme que continúe si quieres retomar desde aquí.",
  ].join("\n")
}
