// Las mismas herramientas que usa la aplicación, importables sin el servidor.
// Contrato: cada export { description, args (zod), execute(args, ctx) → JSON string }.
export * from "../../src/tools/proveedor.ts"
export type { ContextoHerramienta, Herramienta } from "../../src/tools/lib/contrato.ts"
