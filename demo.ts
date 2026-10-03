// Verificación sin modelo: ejecuta las herramientas sobre todos los casos e imprime un resumen.
// Uso: npm run demo   (o: bun run demo.ts). No requiere clave de ningún proveedor.
import { rm } from "node:fs/promises"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import * as proveedor from "./src/tools/proveedor.ts"
import { listarCasos } from "./src/tools/lib/fixtures.ts"
import type { ContextoHerramienta } from "./src/tools/lib/contrato.ts"

const directory = dirname(fileURLToPath(import.meta.url))
const ctx: ContextoHerramienta = { directory, sessionId: "demo" }

type Respuesta = { ok: true; data: Record<string, unknown> } | { ok: false; error: string }
const parse = (s: string) => JSON.parse(s) as Respuesta
const lista = (v: unknown) => (Array.isArray(v) && v.length ? v.map((x) => (typeof x === "string" ? x : (x as { etiqueta?: string; tipo?: string }).etiqueta ?? (x as { tipo?: string }).tipo)).join(", ") : "—")

async function procesar(caso: string): Promise<void> {
  console.log(`\n━━━ ${caso} ━━━`)
  const sol = parse(await proveedor.leer_solicitud.execute({ caso }, ctx))
  if (!sol.ok) return void console.log(`  ✗ leer_solicitud: ${sol.error}`)
  console.log(`  País ${sol.data.pais} · ${sol.data.cliente} · formato ${sol.data.formato}`)
  console.log(`  Soportes exigidos: ${lista(sol.data.soportes)}`)

  const map = parse(await proveedor.mapear_campos.execute({ caso }, ctx))
  if (map.ok) {
    console.log(`  Llenos (${(map.data.llenos as unknown[]).length}): ${lista(map.data.llenos)}`)
    console.log(`  Faltantes: ${lista(map.data.faltantes)}`)
    console.log(`  Requiere confirmación: ${lista(map.data.requiere_confirmacion)}`)
  } else console.log(`  ✗ mapear_campos: ${map.error}`)

  const form = parse(await proveedor.generar_formulario.execute({ caso }, ctx))
  console.log(form.ok ? `  Formulario: ${form.data.ruta}${form.data.aviso ? `  ⚠ ${form.data.aviso}` : ""}` : `  ✗ generar_formulario: ${form.error}`)

  const paq = parse(await proveedor.armar_paquete.execute({ caso }, ctx))
  if (paq.ok) {
    const checklist = paq.data.checklist as { bloqueos: string[] }
    console.log(`  Paquete: ${paq.data.ruta} · listo_para_firma=${paq.data.listo_para_firma}`)
    for (const b of checklist.bloqueos) console.log(`    ⛔ ${b}`)
  } else console.log(`  ✗ armar_paquete: ${paq.error}`)

  const envio = parse(await proveedor.simular_envio.execute({ caso, confirmado: false }, ctx))
  console.log(`  Envío sin confirmación → ${envio.ok ? "¡procedió! (error)" : `bloqueado: ${envio.error}`}`)
}

async function main(): Promise<void> {
  await rm(`${directory}/out`, { recursive: true, force: true })
  const casos = await listarCasos(directory)
  console.log(`Demo sin modelo · ${casos.length} casos · fecha de ejecución ${process.env.FECHA_EJECUCION || new Date().toISOString().slice(0, 10)}`)
  for (const caso of casos) await procesar(caso)

  console.log("\n━━━ Manejo de errores (HU-5) ━━━")
  const inexistente = parse(await proveedor.leer_solicitud.execute({ caso: "no-existe" }, ctx))
  console.log(`  Caso inexistente → ${inexistente.ok ? "ok?" : inexistente.error}`)
  console.log("\nSalida en out/. Log en out/log.jsonl y out/<caso>/log.jsonl.")
}

await main()
