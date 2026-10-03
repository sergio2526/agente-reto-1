// Herramientas del agente "Registro como Proveedor".
// Cada export es una herramienta; el modelo la ve como proveedor_<export>.
// Son la ÚNICA fuente de valores que el agente puede afirmar (CA2).
import { z } from "zod"
import { ejecutar, ErrorClaro, type ContextoHerramienta, type Herramienta } from "./lib/contrato.ts"
import { listarCasos, leerSolicitud } from "./lib/fixtures.ts"
import { armar, generar, leerCaso, mapear, resumirMapeo, simularEnvio } from "./lib/flujo.ts"

const caso = z.string().min(1).describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/ (ej. co-industrias-delta)")

export const listar_casos = {
  description: "Lista los casos (solicitudes de registro) disponibles en la carpeta de entrada con su cliente, país y formato.",
  args: {},
  async execute(_args: Record<string, never>, ctx: ContextoHerramienta) {
    return ejecutar(ctx, "proveedor_listar_casos", null, async () => {
      const nombres = await listarCasos(ctx.directory)
      const casos = await Promise.all(
        nombres.map((n) => leerSolicitud(ctx.directory, n).then(
          (s) => ({ caso: n, cliente: s.cliente, pais: s.pais, formato: s.formato, fecha: s.fecha }),
          () => ({ caso: n, error: "solicitud ilegible" }),
        )),
      )
      return { data: { casos }, resumen: `${casos.length} casos` }
    })
  },
} satisfies Herramienta

export const leer_solicitud = {
  description: "Lee el correo y la plantilla de un caso y devuelve país, cliente, formato de salida, campos solicitados (con los ambiguos marcados) y soportes exigidos.",
  args: { caso },
  async execute(args: { caso: string }, ctx: ContextoHerramienta) {
    return ejecutar(ctx, "proveedor_leer_solicitud", args.caso, async () => {
      const data = await leerCaso(ctx.directory, args.caso)
      return { data, resumen: `${data.pais} · ${data.formato} · ${data.campos.length} campos · ${data.soportes.length} soportes` }
    })
  },
} satisfies Herramienta

export const mapear_campos = {
  description: "Cruza los campos solicitados con el repositorio maestro y el glosario; clasifica cada uno en llenos (con ruta del dato), faltantes o requiere_confirmacion.",
  args: {
    caso,
    campos: z.array(z.string().min(1)).optional().describe("Etiquetas de los campos a mapear tal como las devolvió leer_solicitud. Si se omite, se usan todas las de la plantilla."),
  },
  async execute(args: { caso: string; campos?: string[] | undefined }, ctx: ContextoHerramienta) {
    return ejecutar(ctx, "proveedor_mapear_campos", args.caso, async () => {
      const data = resumirMapeo(await mapear(ctx.directory, args.caso, args.campos))
      return {
        data: { ...data, reporte_faltantes: `out/${args.caso}/faltantes.md` },
        resumen: `llenos=${data.llenos.length} faltantes=${data.faltantes.length} requiere_confirmacion=${data.requiere_confirmacion.length}`,
      }
    })
  },
} satisfies Herramienta

const ajuste = z.object({
  etiqueta: z.string().min(1).describe("Etiqueta del campo tal como aparece en la plantilla"),
  ruta: z.string().nullable().optional().describe("Ruta del dato en el maestro (ej. contacto_comercial.email). El valor se lee del maestro; nunca se acepta un valor escrito por el modelo."),
  estado: z.enum(["lleno", "faltante", "requiere_confirmacion"]).describe("Use 'lleno' solo para un campo que la analista confirmó explícitamente en el chat"),
})

export const generar_formulario = {
  description: "Genera el formulario lleno en el formato del cliente (xlsx o pdf) en out/<caso>/; para portal web produce valores-portal.md y avisa 'formato no soportado'.",
  args: {
    caso,
    mapeo: z.array(ajuste).optional().describe("Ajustes confirmados por la analista sobre el último mapeo. Si se omite, se usa el mapeo guardado por mapear_campos."),
  },
  async execute(args: { caso: string; mapeo?: Array<z.infer<typeof ajuste>> | undefined }, ctx: ContextoHerramienta) {
    return ejecutar(ctx, "proveedor_generar_formulario", args.caso, async () => {
      const f = await generar(ctx.directory, args.caso, args.mapeo ?? [])
      const mapeo = resumirMapeo(f.campos)
      const data = {
        ruta: f.ruta,
        formato: f.formato,
        soportado: f.soportado,
        ...(f.aviso ? { aviso: f.aviso } : {}),
        llenos: mapeo.llenos.length,
        faltantes: mapeo.faltantes.map((c) => c.etiqueta),
        requiere_confirmacion: mapeo.requiere_confirmacion.map((c) => c.etiqueta),
      }
      return { data, resumen: `${f.formato}${f.soportado ? "" : " (no soportado)"} → ${f.ruta}` }
    })
  },
} satisfies Herramienta

export const armar_paquete = {
  description: "Arma out/<caso>/paquete/ con formulario, soportes, checklist.md y borrador-correo.md, y calcula si está listo para firma (vencidos y ausentes bloquean).",
  args: { caso },
  async execute(args: { caso: string }, ctx: ContextoHerramienta) {
    return ejecutar(ctx, "proveedor_armar_paquete", args.caso, async () => {
      const data = await armar(ctx.directory, args.caso)
      return { data, resumen: `listo_para_firma=${data.listo_para_firma} bloqueos=${data.checklist.bloqueos.length}` }
    })
  },
} satisfies Herramienta

export const simular_envio = {
  description: "Simula el envío del paquete escribiendo out/<caso>/ENVIO-SIMULADO.md; solo procede si la analista confirmó explícitamente en su último mensaje.",
  args: {
    caso,
    confirmado: z.boolean().describe("true solo si el último mensaje de la analista confirma explícitamente el envío"),
  },
  async execute(args: { caso: string; confirmado: boolean }, ctx: ContextoHerramienta) {
    return ejecutar(ctx, "proveedor_simular_envio", args.caso, async () => {
      if (!args.confirmado || ctx.confirmacionHumana === false) throw new ErrorClaro("requiere confirmación explícita")
      const data = await simularEnvio(ctx.directory, args.caso)
      return { data, resumen: `envío simulado → ${data.ruta}` }
    })
  },
} satisfies Herramienta
