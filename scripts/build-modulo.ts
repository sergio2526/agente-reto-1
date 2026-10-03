// Genera modulo/ a partir de las MISMAS fuentes que usa la aplicación (sin copias divergentes):
//   agent/prompt.md                      → modulo/agent.md
//   src/knowledge/registro-proveedor.md  → modulo/skill/registro-proveedor/SKILL.md
//   src/tools/proveedor.ts               ← modulo/tools/proveedor.ts (re-export, no copia)
// Uso: npm run build:modulo · `npm test` verifica que no estén desactualizados.
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..")

async function esperado(): Promise<Record<string, string>> {
  const prompt = await readFile(join(raiz, "agent/prompt.md"), "utf8")
  const conocimiento = await readFile(join(raiz, "src/knowledge/registro-proveedor.md"), "utf8")
  return {
    "modulo/agent.md": [
      "---",
      "description: Agente que procesa solicitudes de registro como proveedor, llena formularios Excel/PDF desde el repositorio maestro y arma el paquete para firma del representante legal.",
      "mode: primary",
      "permission:",
      "  edit: deny",
      "  bash: deny",
      "---",
      "",
      prompt.trim(),
      "",
    ].join("\n"),
    "modulo/skill/registro-proveedor/SKILL.md": [
      "---",
      "name: registro-proveedor",
      "description: Conocimiento del proceso de registro de Periferia como proveedor ante clientes (CO, EC, PE, PA, HN) - identificadores tributarios por país, estados de campo, soportes, vigencias, reglas de firma y confirmación humana.",
      "---",
      "",
      conocimiento.trim(),
      "",
    ].join("\n"),
    "modulo/tools/proveedor.ts": [
      "// Las mismas herramientas que usa la aplicación, importables sin el servidor.",
      "// Contrato: cada export { description, args (zod), execute(args, ctx) → JSON string }.",
      'export * from "../../src/tools/proveedor.ts"',
      'export type { ContextoHerramienta, Herramienta } from "../../src/tools/lib/contrato.ts"',
      "",
    ].join("\n"),
  }
}

/** Devuelve los archivos de modulo/ que no coinciden con sus fuentes. */
export async function comprobarModulo(): Promise<string[]> {
  const archivos = await esperado()
  const distintos: string[] = []
  for (const [ruta, contenido] of Object.entries(archivos)) {
    const actual = await readFile(join(raiz, ruta), "utf8").catch(() => "")
    if (actual !== contenido) distintos.push(ruta)
  }
  return distintos
}

async function construir(): Promise<void> {
  for (const [ruta, contenido] of Object.entries(await esperado())) {
    await mkdir(dirname(join(raiz, ruta)), { recursive: true })
    await writeFile(join(raiz, ruta), contenido)
    console.log(`✔ ${ruta}`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await construir()
