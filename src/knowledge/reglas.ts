// Reglas de negocio del registro como proveedor (datos, no lógica).
// Cambiar una regla aquí no toca el servidor ni el ciclo del agente.

export type Pais = "CO" | "EC" | "PE" | "PA" | "HN"

/** RN1 · Identificador tributario por país. */
export const IDENTIFICADOR_TRIBUTARIO: Record<Pais, string> = {
  CO: "NIT",
  EC: "RUC",
  PE: "RUC",
  PA: "RUC",
  HN: "RTN",
}

/** País de origen de los datos del maestro (Periferia solo tiene NIT colombiano). */
export const PAIS_MAESTRO: Pais = "CO"

/** Clave del maestro que contiene el identificador tributario. */
export const CLAVE_ID_TRIBUTARIO = "nit"

/** Etiquetas genéricas que no dicen qué identificador piden → requiere_confirmacion. */
export const ETIQUETAS_AMBIGUAS = ["Identificación tributaria", "Número de identificación fiscal"]

/** RN2 · Prefijo de claves bancarias: se llenan solo si la plantilla las pide; nunca van al correo. */
export const PREFIJO_BANCARIO = "banco."

/** HU-2 · Umbral de confianza: por debajo, el mapeo queda en requiere_confirmacion. */
export const UMBRAL_CONFIANZA = 0.8

/** Por debajo de este puntaje no se propone ningún mapeo: el campo es faltante. */
export const UMBRAL_PROPUESTA = 0.6

/** Palabras vacías ignoradas al comparar etiquetas. */
export const PALABRAS_VACIAS = ["de", "del", "la", "el", "los", "las", "y", "o", "e", "en", "a", "/", "para", "por"]

/** Nombre legible de cada tipo de soporte (para checklist y correo). */
export const NOMBRE_SOPORTE: Record<string, string> = {
  camara_comercio: "Certificado de Cámara de Comercio (existencia y representación legal)",
  rut: "RUT (Registro Único Tributario)",
  certificacion_bancaria: "Certificación bancaria",
  parafiscales: "Certificación de pago de parafiscales y seguridad social",
  estados_financieros: "Estados financieros",
  certificado_cumplimiento_tributario: "Certificado de cumplimiento tributario",
  certificado_iso_9001: "Certificado ISO 9001",
}

/** Formatos de salida soportados por generar_formulario. */
export const FORMATOS_SOPORTADOS = ["xlsx", "pdf"] as const
