import { readFile } from "node:fs/promises"
import { join } from "node:path"

/** System prompt = comportamiento (agent/prompt.md) + conocimiento del proceso (src/knowledge/). */
export async function cargarSistema(raiz: string): Promise<string> {
  const [comportamiento, conocimiento] = await Promise.all([
    readFile(join(raiz, "agent", "prompt.md"), "utf8"),
    readFile(join(raiz, "src", "knowledge", "registro-proveedor.md"), "utf8"),
  ])
  return `${comportamiento.trim()}\n\n---\n\n${conocimiento.trim()}\n`
}
