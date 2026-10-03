// API HTTP + archivos estáticos del chat. El ciclo del agente vive en src/agent/loop.ts.
import { randomUUID, timingSafeEqual } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { extname, join, normalize, sep } from "node:path"
import { z } from "zod"
import { procesarTurno } from "./agent/loop.ts"
import { cargarSistema } from "./agent/prompt.ts"
import { buscarSesion, guardarSesion, idValido, obtenerSesion } from "./agent/sesiones.ts"
import { CONFIG } from "./config.ts"
import { crearAdaptador } from "./llm/index.ts"
import { listarCasos, leerSolicitud } from "./tools/lib/fixtures.ts"

const llm = crearAdaptador()
const sistema = await cargarSistema(CONFIG.raiz)

const TIPOS: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}

const ChatSchema = z.object({
  sessionId: z.string().refine(idValido, "sessionId inválido").optional(),
  message: z.string().trim().min(1, "El mensaje está vacío").max(4000, "El mensaje es demasiado largo"),
})

function json(res: ServerResponse, estado: number, cuerpo: unknown): void {
  res.writeHead(estado, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(JSON.stringify(cuerpo))
}

async function leerCuerpo(req: IncomingMessage): Promise<unknown> {
  let texto = ""
  for await (const trozo of req) {
    texto += String(trozo)
    if (texto.length > 64_000) throw new Error("cuerpo demasiado grande")
  }
  return JSON.parse(texto || "{}")
}

function autorizado(req: IncomingMessage, url: URL): boolean {
  if (!CONFIG.claveAcceso) return true
  const dada = Buffer.from(String(req.headers["x-access-key"] ?? url.searchParams.get("key") ?? ""))
  const esperada = Buffer.from(CONFIG.claveAcceso)
  return dada.length === esperada.length && timingSafeEqual(dada, esperada)
}

// Límite simple por IP para que nadie gaste la clave sin control.
const ventanas = new Map<string, { inicio: number; cuenta: number }>()
function dentroDelLimite(ip: string, maximoPorMinuto = 20): boolean {
  const ahora = Date.now()
  const v = ventanas.get(ip)
  if (!v || ahora - v.inicio > 60_000) {
    ventanas.set(ip, { inicio: ahora, cuenta: 1 })
    return true
  }
  v.cuenta++
  return v.cuenta <= maximoPorMinuto
}

async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!dentroDelLimite(req.socket.remoteAddress ?? "?")) return json(res, 429, { error: "Demasiadas solicitudes. Espera un minuto." })
  let cuerpo: z.infer<typeof ChatSchema>
  try {
    const r = ChatSchema.safeParse(await leerCuerpo(req))
    if (!r.success) return json(res, 400, { error: r.error.issues.map((i) => i.message).join("; ") })
    cuerpo = r.data
  } catch {
    return json(res, 400, { error: "Cuerpo JSON inválido" })
  }
  const sesion = await obtenerSesion(CONFIG.raiz, cuerpo.sessionId ?? randomUUID())
  if (sesion.ocupada) return json(res, 409, { error: "La sesión está procesando otro mensaje." })
  sesion.ocupada = true
  try {
    const turno = await procesarTurno(sesion, cuerpo.message, {
      llm,
      sistema,
      raiz: CONFIG.raiz,
      maxIteraciones: CONFIG.maxIteraciones,
      maxTokensSesion: CONFIG.maxTokensSesion,
    })
    json(res, 200, { sessionId: sesion.id, ...turno, tokensSesion: sesion.tokens })
  } catch {
    json(res, 500, { sessionId: sesion.id, reply: "⚠️ Ocurrió un error inesperado procesando el turno. La sesión sigue activa.", toolCalls: [], needsConfirmation: false })
  } finally {
    sesion.ocupada = false
    await guardarSesion(CONFIG.raiz, sesion)
  }
}

/** Sirve un archivo bajo `base` sin permitir salir de ella. */
async function servirArchivo(res: ServerResponse, base: string, relativa: string, descarga = false): Promise<void> {
  const ruta = normalize(join(base, relativa))
  if (!ruta.startsWith(base + sep) && ruta !== base) return json(res, 403, { error: "Ruta no permitida" })
  try {
    if (!(await stat(ruta)).isFile()) throw new Error()
    const cabeceras: Record<string, string> = { "content-type": TIPOS[extname(ruta)] ?? "application/octet-stream" }
    if (descarga) cabeceras["content-disposition"] = `inline; filename="${ruta.split(sep).pop() ?? "archivo"}"`
    res.writeHead(200, cabeceras)
    res.end(await readFile(ruta))
  } catch {
    json(res, 404, { error: "No encontrado" })
  }
}

async function casos(res: ServerResponse): Promise<void> {
  const nombres = await listarCasos(CONFIG.raiz)
  const lista = await Promise.all(nombres.map((n) => leerSolicitud(CONFIG.raiz, n).then((s) => ({ caso: n, cliente: s.cliente, pais: s.pais, formato: s.formato }), () => ({ caso: n }))))
  json(res, 200, { casos: lista })
}

const servidor = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  const ruta = url.pathname
  try {
    if (req.method === "GET" && ruta === "/api/health") return json(res, 200, { ok: true, provider: llm.proveedor, model: llm.modelo, protegido: CONFIG.claveAcceso !== null })
    if (ruta.startsWith("/api/") && !autorizado(req, url)) return json(res, 401, { error: "Clave de acceso requerida" })
    if (req.method === "POST" && ruta === "/api/chat") return await chat(req, res)
    if (req.method === "GET" && ruta === "/api/casos") return await casos(res)
    if (req.method === "GET" && ruta.startsWith("/api/sessions/")) {
      const id = decodeURIComponent(ruta.slice("/api/sessions/".length))
      const sesion = idValido(id) ? await buscarSesion(CONFIG.raiz, id) : null
      return sesion ? json(res, 200, { id: sesion.id, eventos: sesion.eventos, tokens: sesion.tokens, pendienteConfirmacion: sesion.pendienteConfirmacion }) : json(res, 404, { error: "Sesión no encontrada" })
    }
    if (req.method === "GET" && ruta.startsWith("/api/out/")) {
      const relativa = decodeURIComponent(ruta.slice("/api/out/".length))
      // Solo artefactos de casos; el historial de otras sesiones no se expone.
      if (relativa.startsWith("sesiones")) return json(res, 403, { error: "Ruta no permitida" })
      return await servirArchivo(res, join(CONFIG.raiz, "out"), relativa, true)
    }
    if (req.method === "GET" && !ruta.startsWith("/api/")) return await servirArchivo(res, join(CONFIG.raiz, "web"), ruta === "/" ? "index.html" : ruta.slice(1))
    json(res, 404, { error: "Ruta no encontrada" })
  } catch {
    if (!res.headersSent) json(res, 500, { error: "Error interno" })
  }
})

servidor.listen(CONFIG.puerto, () => {
  console.log(`Agente listo en http://localhost:${CONFIG.puerto} · proveedor=${llm.proveedor} · modelo=${llm.modelo}`)
})
