// Pruebas end-to-end del ciclo del agente sin modelo real (npm test).
import assert from "node:assert/strict"
import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { procesarTurno, esConfirmacion, type Dependencias } from "../src/agent/loop.ts"
import { cargarSistema } from "../src/agent/prompt.ts"
import type { Sesion } from "../src/agent/sesiones.ts"
import { ErrorProveedor, type AdaptadorLLM, type RespuestaLLM } from "../src/llm/adapter.ts"
import { AdaptadorSimulado } from "../src/llm/simulado.ts"
import { CONFIG } from "../src/config.ts"
import { comprobarModulo } from "./build-modulo.ts"
import * as proveedor from "../src/tools/proveedor.ts"

const raiz = CONFIG.raiz
const existe = (r: string) => access(join(raiz, r)).then(() => true, () => false)
const nuevaSesion = (id: string): Sesion => ({ id, historial: [], eventos: [], tokens: 0, pendienteConfirmacion: false, ocupada: false })
const deps = async (llm: AdaptadorLLM, extra: Partial<Dependencias> = {}): Promise<Dependencias> => ({
  llm, sistema: await cargarSistema(raiz), raiz, maxIteraciones: 25, maxTokensSesion: 1_000_000, ...extra,
})

/** Proveedor de prueba que siempre responde con la misma llamada. */
const repetidor = (nombre: string, args: unknown): AdaptadorLLM => ({
  proveedor: "prueba", modelo: "repetidor",
  async enviar(): Promise<RespuestaLLM> {
    return { texto: "", llamadas: [{ id: `t${Math.random()}`, nombre, args }], uso: { entrada: 1, salida: 1 }, fin: "herramientas" }
  },
})

const pruebas: Array<[string, () => Promise<void>]> = [
  ["detecta confirmaciones y negaciones", async () => {
    assert.equal(esConfirmacion("sí, envía"), true)
    assert.equal(esConfirmacion("envía"), true)
    assert.equal(esConfirmacion("No envíes nada todavía"), false)
  }],
  ["flujo del PRD: procesar, confirmar, enviar", async () => {
    await rm(join(raiz, "out/ec-corp-andina/ENVIO-SIMULADO.md"), { force: true })
    const s = nuevaSesion("e2e-flujo")
    const d = await deps(new AdaptadorSimulado())
    const t1 = await procesarTurno(s, 'Procesa el caso "ec-corp-andina". No envíes nada todavía.', d)
    assert.deepEqual(t1.toolCalls.map((t) => t.nombre), ["proveedor_leer_solicitud", "proveedor_mapear_campos", "proveedor_generar_formulario", "proveedor_armar_paquete"])
    assert.equal(t1.needsConfirmation, true)
    assert.equal(await existe("out/ec-corp-andina/ENVIO-SIMULADO.md"), false)
    const t2 = await procesarTurno(s, "envía", d)
    assert.equal(t2.toolCalls[0]?.ok, true)
    assert.equal(await existe("out/ec-corp-andina/ENVIO-SIMULADO.md"), true)
    assert.equal(t2.needsConfirmation, false)
  }],
  ["RN4: el envío sin pregunta previa se bloquea aunque el modelo diga confirmado=true", async () => {
    await rm(join(raiz, "out/co-industrias-delta/ENVIO-SIMULADO.md"), { force: true })
    const s = nuevaSesion("e2e-rn4")
    const t = await procesarTurno(s, "sí, envía", await deps(repetidor("proveedor_simular_envio", { caso: "co-industrias-delta", confirmado: true }), { maxIteraciones: 1 }))
    assert.equal(t.toolCalls[0]?.ok, false)
    assert.equal(t.toolCalls[0]?.resumen, "requiere confirmación explícita")
    assert.equal(await existe("out/co-industrias-delta/ENVIO-SIMULADO.md"), false)
  }],
  ["CA1: tope de iteraciones responde con lo que tiene", async () => {
    const t = await procesarTurno(nuevaSesion("e2e-tope"), "x", await deps(repetidor("proveedor_listar_casos", {}), { maxIteraciones: 3 }))
    assert.equal(t.toolCalls.length, 3)
    assert.match(t.reply, /tope de 3 iteraciones/)
  }],
  ["valida argumentos con zod antes de ejecutar", async () => {
    const t = await procesarTurno(nuevaSesion("e2e-zod"), "x", await deps(repetidor("proveedor_leer_solicitud", { caso: 42 }), { maxIteraciones: 1 }))
    assert.match(t.toolCalls[0]?.resumen ?? "", /Argumentos inválidos/)
  }],
  ["CA5: error del proveedor en lenguaje claro y la sesión sigue viva", async () => {
    const roto: AdaptadorLLM = { proveedor: "x", modelo: "x", enviar: async () => { throw new ErrorProveedor("El proveedor tardó demasiado (timeout).") } }
    const s = nuevaSesion("e2e-error")
    const t = await procesarTurno(s, "hola", await deps(roto))
    assert.match(t.reply, /timeout/)
    const t2 = await procesarTurno(s, "lista los casos", await deps(new AdaptadorSimulado()))
    assert.equal(t2.toolCalls[0]?.ok, true)
  }],
  ["caso inexistente: error claro sin traza", async () => {
    const t = await procesarTurno(nuevaSesion("e2e-404"), "procesa el caso zz-no-existe", await deps(new AdaptadorSimulado()))
    assert.match(t.reply, /Caso inexistente/)
  }],
  ["HU-5: plantilla corrupta → error claro y el proceso continúa", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reto01-"))
    await cp(join(raiz, "fixtures"), join(dir, "fixtures"), { recursive: true })
    await writeFile(join(dir, "fixtures/reto-01/casos/co-industrias-delta/plantilla-celdas.json"), "{ corrupto")
    const ctx = { directory: dir, sessionId: "e2e-corrupta" }
    const caso = "co-industrias-delta"
    const leer = JSON.parse(await proveedor.leer_solicitud.execute({ caso }, ctx))
    assert.equal(leer.ok, true)
    assert.match(leer.data.advertencias[0], /corrupto/)
    const mapeo = JSON.parse(await proveedor.mapear_campos.execute({ caso, campos: ["NIT", "Referencias comerciales"] }, ctx))
    assert.equal(mapeo.data.faltantes[0].etiqueta, "Referencias comerciales")
    const form = JSON.parse(await proveedor.generar_formulario.execute({ caso }, ctx))
    assert.equal(form.ok, false)
    assert.doesNotMatch(form.error, /at |Error:/)
    const paquete = JSON.parse(await proveedor.armar_paquete.execute({ caso }, ctx))
    assert.equal(paquete.data.listo_para_firma, false)
    assert.ok(await access(join(dir, "out", caso, "faltantes.md")).then(() => true))
    await rm(dir, { recursive: true, force: true })
  }],
  ["RN2: el borrador de correo no tiene datos bancarios", async () => {
    const correo = await readFile(join(raiz, "out/ec-corp-andina/paquete/borrador-correo.md"), "utf8")
    assert.equal(correo.includes("03100012345"), false)
    assert.equal(correo.includes("COLOCOBM"), false)
  }],
  ["RN5: log por caso con { ts, herramienta, ok, resumen }", async () => {
    const linea = (await readFile(join(raiz, "out/ec-corp-andina/log.jsonl"), "utf8")).trim().split("\n")[0] ?? "{}"
    assert.deepEqual(Object.keys(JSON.parse(linea)), ["ts", "herramienta", "ok", "resumen"])
  }],
  ["módulo reutilizable sincronizado con la aplicación", async () => {
    assert.deepEqual(await comprobarModulo(), [])
  }],
]

let fallos = 0
for (const [nombre, prueba] of pruebas) {
  try {
    await prueba()
    console.log(`✔ ${nombre}`)
  } catch (e) {
    fallos++
    console.log(`✘ ${nombre}\n  ${e instanceof Error ? e.message : String(e)}`)
  }
}
console.log(fallos ? `\n${fallos} prueba(s) fallaron` : `\nTodas las pruebas pasaron (${pruebas.length})`)
process.exitCode = fallos ? 1 : 0
