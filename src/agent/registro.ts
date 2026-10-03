import { z } from "zod"
import type { DefinicionHerramienta } from "../llm/adapter.ts"
import type { ContextoHerramienta, Herramienta } from "../tools/lib/contrato.ts"
import * as proveedor from "../tools/proveedor.ts"

/** Herramienta registrada con su esquema zod ya armado para validar antes de ejecutar. */
interface Registrada {
  definicion: DefinicionHerramienta
  esquema: z.ZodObject<z.ZodRawShape>
  ejecutar: (args: unknown, ctx: ContextoHerramienta) => Promise<string>
}

/** Cada export de src/tools/<archivo>.ts se publica al modelo como <archivo>_<export>. */
const MODULOS: Record<string, Record<string, Herramienta>> = { proveedor }

function registrar(): Map<string, Registrada> {
  const mapa = new Map<string, Registrada>()
  for (const [archivo, exportes] of Object.entries(MODULOS)) {
    for (const [nombreExport, h] of Object.entries(exportes)) {
      const nombre = `${archivo}_${nombreExport}`
      const esquema = z.object(h.args).strict()
      const { $schema: _omitido, ...json } = z.toJSONSchema(esquema) as Record<string, unknown>
      mapa.set(nombre, {
        definicion: { nombre, descripcion: h.description, esquema: json },
        esquema,
        ejecutar: (args, ctx) => h.execute(args as never, ctx),
      })
    }
  }
  return mapa
}

export const HERRAMIENTAS = registrar()
export const DEFINICIONES = [...HERRAMIENTAS.values()].map((h) => h.definicion)

/**
 * Valida los argumentos con zod y ejecuta. Un nombre desconocido o argumentos inválidos
 * se devuelven al modelo como error para que corrija; nunca se lanza.
 */
export async function ejecutarHerramienta(nombre: string, args: unknown, ctx: ContextoHerramienta): Promise<string> {
  const h = HERRAMIENTAS.get(nombre)
  if (!h) return JSON.stringify({ ok: false, error: `Herramienta desconocida: ${nombre}` })
  const validacion = h.esquema.safeParse(args ?? {})
  if (!validacion.success) {
    const detalle = validacion.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")
    return JSON.stringify({ ok: false, error: `Argumentos inválidos para ${nombre}: ${detalle}` })
  }
  return h.ejecutar(validacion.data, ctx)
}
