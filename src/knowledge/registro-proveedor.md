# Conocimiento del proceso: registro como proveedor

## Contexto

Periferia recibe entre 8 y 12 solicitudes al mes de clientes en Colombia, Ecuador, Perú, Panamá y Honduras que quieren crearla como proveedor. Recepción deposita cada correo como un caso en `fixtures/reto-01/casos/<caso>/`. Los datos de la empresa viven en el repositorio maestro (`maestro.json`) y los soportes en `repositorio/soportes/`.

## Formatos de salida

| Formato | Qué se produce | Soporte |
|---|---|---|
| `xlsx` | `out/<caso>/formulario.xlsx`, cada etiqueta y valor en la hoja/celda indicada por el cliente | Automático |
| `pdf` | `out/<caso>/formulario.pdf` con todos los campos en el orden dado y línea de firma | Automático |
| `portal` | `out/<caso>/valores-portal.md` con los valores listos para copiar | **Formato no soportado**: una persona opera el portal |

## Identificador tributario por país (RN1)

| País | Identificador |
|---|---|
| Colombia (CO) | NIT |
| Ecuador (EC) | RUC |
| Perú (PE) | RUC |
| Panamá (PA) | RUC |
| Honduras (HN) | RTN |

Periferia solo tiene NIT colombiano. Para clientes de otros países el campo se llena con el NIT y queda en `requiere_confirmacion` con la nota "identificador extranjero". Etiquetas genéricas como "Identificación tributaria" son ambiguas: se propone el equivalente del país y se pide confirmación.

## Estados de un campo

- **lleno**: el dato existe en el maestro; se informa la ruta (trazabilidad).
- **faltante**: no hay fuente en el maestro. Nunca se inventa. No bloquea la firma, pero aparece en el checklist y en `out/<caso>/faltantes.md`.
- **requiere_confirmacion**: mapeo con confianza menor a 0.8 o regla de país. Se llena con el valor propuesto y la analista decide.

Los sinónimos del glosario (`glosario-campos.json`) se resuelven automáticamente con confianza 1.0.

## Datos bancarios (RN2)

Se llenan solo si la plantilla los pide explícitamente. Nunca van en el borrador de correo ni se muestran completos en el chat.

## Soportes y firma (RN3)

| Tipo | Documento |
|---|---|
| `camara_comercio` | Certificado de existencia y representación legal (vigencia corta, 30 días) |
| `rut` | Registro Único Tributario |
| `certificacion_bancaria` | Certificación de cuenta bancaria |
| `parafiscales` | Pago de aportes parafiscales y seguridad social |
| `estados_financieros` | Estados financieros auditados |
| `certificado_cumplimiento_tributario` | Certificado de cumplimiento tributario (no existe hoy en el repositorio) |

- Un soporte con `vigencia_hasta` anterior a la fecha de ejecución está **vencido** y bloquea `listo_para_firma`.
- Un soporte exigido que no existe en el repositorio está **ausente** y también bloquea.
- Los soportes son emitidos en Colombia; para clientes extranjeros conviene verificar si piden apostilla o traducción.

## El paquete para firma

`out/<caso>/paquete/` contiene el formulario, copia de los soportes existentes, `checklist.md` (presentes / vencidos / ausentes, faltantes y campos por confirmar) y `borrador-correo.md`.

## Cierre humano (RN4)

El agente prepara; la analista revisa y el representante legal firma. Cualquier acción externa (envío, firma, carga a portal) requiere confirmación explícita de la analista en el mensaje inmediatamente anterior. En este sistema "enviar" solo escribe `out/<caso>/ENVIO-SIMULADO.md`.
