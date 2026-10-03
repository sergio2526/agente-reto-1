import { writeFile } from "node:fs/promises"
import ExcelJS from "exceljs"
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib"
import type { Celda, Solicitud } from "./fixtures.ts"
import type { CampoMapeado } from "./mapeo.ts"

/** P0 · Escribe cada etiqueta y su valor exactamente en la hoja y celda de plantilla-celdas.json. */
export async function escribirXlsx(ruta: string, celdas: Celda[], campos: CampoMapeado[]): Promise<void> {
  const libro = new ExcelJS.Workbook()
  libro.creator = "Agente Registro como Proveedor"
  for (const celda of celdas) {
    const hoja = libro.getWorksheet(celda.hoja) ?? crearHoja(libro, celda.hoja)
    const campo = campos.find((c) => c.etiqueta === celda.etiqueta)
    hoja.getCell(celda.celda_etiqueta).value = celda.etiqueta
    hoja.getCell(celda.celda_etiqueta).font = { bold: true }
    hoja.getCell(celda.celda_valor).value = campo?.valor ?? null
  }
  await libro.xlsx.writeFile(ruta)
}

function crearHoja(libro: ExcelJS.Workbook, nombre: string): ExcelJS.Worksheet {
  const hoja = libro.addWorksheet(nombre)
  hoja.columns = [{ width: 4 }, { width: 34 }, { width: 60 }]
  return hoja
}

// ---------- PDF ----------

const MARGEN = 50
const ANCHO = 595.28 // A4
const ALTO = 841.89

/** pdf-lib con fuentes estándar solo admite WinAnsi: se sustituye lo que no se pueda codificar. */
function seguro(texto: string): string {
  return texto.replace(/[^\x20-\x7E -ÿ]/g, "?")
}

function partirLineas(texto: string, fuente: PDFFont, tamano: number, ancho: number): string[] {
  const lineas: string[] = []
  let actual = ""
  for (const palabra of seguro(texto).split(" ")) {
    const prueba = actual ? `${actual} ${palabra}` : palabra
    if (fuente.widthOfTextAtSize(prueba, tamano) > ancho && actual) {
      lineas.push(actual)
      actual = palabra
    } else {
      actual = prueba
    }
  }
  return [...lineas, actual]
}

interface Lienzo {
  doc: PDFDocument
  pagina: PDFPage
  y: number
  normal: PDFFont
  negrita: PDFFont
}

function escribir(l: Lienzo, texto: string, opciones: { tamano?: number; negrita?: boolean; x?: number; color?: number } = {}): void {
  const tamano = opciones.tamano ?? 10
  const fuente = opciones.negrita ? l.negrita : l.normal
  const x = opciones.x ?? MARGEN
  for (const linea of partirLineas(texto, fuente, tamano, ANCHO - x - MARGEN)) {
    if (l.y < MARGEN + 20) {
      l.pagina = l.doc.addPage([ANCHO, ALTO])
      l.y = ALTO - MARGEN
    }
    const gris = opciones.color ?? 0
    l.pagina.drawText(linea, { x, y: l.y, size: tamano, font: fuente, color: rgb(gris, gris, gris) })
    l.y -= tamano + 4
  }
}

/** P1 · PDF generado con todos los campos (etiqueta y valor) en el orden de plantilla-campos.json. */
export async function escribirPdf(ruta: string, solicitud: Solicitud, campos: Array<CampoMapeado & { obligatorio: boolean }>): Promise<void> {
  const doc = await PDFDocument.create()
  doc.setTitle(`Formulario de registro de proveedor - ${solicitud.cliente}`)
  doc.setCreator("Agente Registro como Proveedor")
  const l: Lienzo = { doc, pagina: doc.addPage([ANCHO, ALTO]), y: ALTO - MARGEN, normal: await doc.embedFont(StandardFonts.Helvetica), negrita: await doc.embedFont(StandardFonts.HelveticaBold) }

  escribir(l, "Formulario de registro de proveedor", { tamano: 16, negrita: true })
  escribir(l, `Cliente: ${solicitud.cliente} (${solicitud.pais})`, { tamano: 10 })
  escribir(l, `Documento de origen: ${solicitud.adjuntos.join(", ") || "-"}`, { tamano: 9, color: 0.4 })
  l.y -= 10

  for (const campo of campos) {
    escribir(l, `${campo.etiqueta}${campo.obligatorio ? " *" : ""}`, { negrita: true })
    escribir(l, campo.valor === null ? "(sin dato en el repositorio maestro)" : String(campo.valor), { x: MARGEN + 12, color: campo.valor === null ? 0.5 : 0 })
    l.y -= 6
  }

  l.y -= 30
  escribir(l, "______________________________________")
  escribir(l, "Firma del representante legal", { tamano: 9 })
  escribir(l, "* Campo obligatorio", { tamano: 8, color: 0.5 })
  await writeFile(ruta, await doc.save({ useObjectStreams: false }))
}

// ---------- Markdown ----------

const celdaMd = (v: unknown) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ")

/** P2 · Portal web no soportado: valores listos para copiar y pegar. */
export async function escribirValoresPortal(ruta: string, solicitud: Solicitud, campos: CampoMapeado[], soportes: string[]): Promise<void> {
  const url = solicitud.cuerpo.match(/https?:\/\/\S+/)?.[0]?.replace(/[.,)]+$/, "")
  const filas = campos.map((c) => `| ${celdaMd(c.etiqueta)} | ${celdaMd(c.valor ?? "— faltante —")} | ${c.estado}${c.nota ? ` · ${celdaMd(c.nota)}` : ""} |`)
  const md = [
    `# Valores para el portal · ${solicitud.cliente}`,
    "",
    "> **Formato no soportado:** el agente no opera portales web. Una persona debe ingresar al portal, digitar las credenciales y hacer clic en \"Enviar\".",
    "",
    `- Portal: ${url ?? "(ver correo del cliente)"}`,
    "- Credenciales: las tiene el representante legal (enviadas por separado). **No se registran aquí.**",
    "",
    "## Campos",
    "",
    "| Campo | Valor | Estado |",
    "|---|---|---|",
    ...filas,
    "",
    "## Soportes a cargar",
    "",
    ...soportes.map((s) => `- [ ] ${s}`),
    "",
  ].join("\n")
  await writeFile(ruta, md)
}

/** O2 · Reporte de faltantes y campos por confirmar. */
export async function escribirReporteFaltantes(ruta: string, solicitud: Solicitud, campos: CampoMapeado[]): Promise<void> {
  const faltantes = campos.filter((c) => c.estado === "faltante")
  const confirmar = campos.filter((c) => c.estado === "requiere_confirmacion")
  const md = [
    `# Reporte de faltantes · ${solicitud.id}`,
    "",
    `Cliente: ${solicitud.cliente} (${solicitud.pais}) · Campos solicitados: ${campos.length} · Llenos: ${campos.length - faltantes.length - confirmar.length}`,
    "",
    "## Faltantes (no existen en el maestro; no se inventan)",
    "",
    ...(faltantes.length ? faltantes.map((c) => `- **${c.etiqueta}** — ${c.nota ?? "sin fuente"}`) : ["- Ninguno"]),
    "",
    "## Requieren confirmación",
    "",
    ...(confirmar.length ? confirmar.map((c) => `- **${c.etiqueta}** ← \`${c.ruta}\` — ${c.nota ?? ""}`) : ["- Ninguno"]),
    "",
  ].join("\n")
  await writeFile(ruta, md)
}
