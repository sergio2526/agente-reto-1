# SOLUCIÓN · Agente "Registro como Proveedor"

## 1. Problema en una frase

El área administrativa transcribe a mano, en cada solicitud de un cliente, los mismos datos de Periferia y busca los mismos soportes para registrarla como proveedor. Le duele a la **analista administrativa**, que carga el retrabajo y el riesgo de equivocarse en datos sensibles (NIT, cuenta bancaria), y a la **empresa**, porque cada registro demorado retrasa la facturación.

## 2. Arquitectura

```
┌──────────────────────┐  POST /api/chat     ┌──────────────────────────────────────────────┐
│ web/index.html       │ ──────────────────▶ │ src/server.ts (node:http)                     │
│ · historial          │ ◀────────────────── │  · valida cuerpo (zod), clave de acceso,      │
│ · tarjetas de tools  │  {reply, toolCalls, │    límite por IP, una petición por sesión     │
│ · "pensando"         │   needsConfirmation}│                                               │
│ · banner confirmar   │                     │ src/agent/loop.ts  ← ciclo del agente         │
└──────────────────────┘                     │  prompt → LLM → tools → … → respuesta         │
                                             │      │                 │                      │
                                             │ src/llm/adapter.ts   src/agent/registro.ts    │
                                             │  ├ anthropic.ts       valida args con zod     │
                                             │  └ simulado.ts        → src/tools/proveedor.ts│
                                             └───────────────┬────────────────┬─────────────┘
                                                             │                │
                                          fixtures/ (solo lectura)   out/ (escritura)
                                          maestro, glosario,          <caso>/formulario.*, paquete/,
                                          casos, soportes             faltantes.md, log.jsonl, sesiones/
```

| Pieza | Dónde vive | Qué contiene |
|---|---|---|
| **Comportamiento** | `agent/prompt.md` | Rol, orden de herramientas, reglas (no inventar, no enviar sin confirmar), formato del resumen y marca `[[CONFIRMACION]]`. |
| **Conocimiento** | `src/knowledge/registro-proveedor.md` y `src/knowledge/reglas.ts` | El proceso explicado (se anexa al system prompt) y las reglas de negocio como datos: identificador por país, etiquetas ambiguas, umbrales, prefijo bancario, nombres de soportes. |
| **Ejecución** | `src/tools/proveedor.ts` + `src/tools/lib/` | Seis herramientas tipadas con zod. Son la única fuente de valores. |

Cambiar una regla de negocio (por ejemplo, el umbral de confianza o el identificador de un país nuevo) solo toca `src/knowledge/`, nunca el servidor ni el ciclo.

## 3. Ciclo del agente

`procesarTurno` en `src/agent/loop.ts`:

1. Calcula **antes de nada** si este mensaje es una confirmación válida: `confirmacionHumana = sesion.pendienteConfirmacion && esConfirmacion(mensaje)`. Así, una confirmación solo cuenta si el turno anterior terminó con una pregunta de confirmación (RN4). `esConfirmacion` da prioridad a las negaciones: "no envíes nada todavía" nunca confirma.
2. Envía al adaptador `[sistema, ...historial]` y las definiciones de herramientas (JSON Schema generado desde zod).
3. Si el modelo pide herramientas, cada llamada se **valida con zod** antes de ejecutarse; un nombre desconocido o argumentos inválidos vuelven al modelo como `{ ok: false, error }` para que se corrija. Los resultados se agregan al historial y se repite.
4. **Tope de iteraciones (CA1)**: `MAX_ITERACIONES` (25 por defecto). Al llegar, el agente responde con lo que completó y lo que falló o falta.
5. **Tope de tokens por sesión**: `MAX_TOKENS_SESION`. Se suman los tokens de entrada y salida de cada llamada.
6. **Confirmación humana (CA3)**: el prompt pide terminar la pregunta con `[[CONFIRMACION]]`; el ciclo la quita del texto y marca `needsConfirmation`. Como salvaguarda, si en el turno se armó un paquete y no se envió, el turno también queda esperando confirmación. El front resalta el mensaje y muestra los botones Sí / No.
7. **Defensa en profundidad**: `proveedor_simular_envio` exige `confirmado: true` **y** que el ciclo haya marcado `confirmacionHumana`. Si el modelo intenta enviar sin que la analista haya confirmado, la herramienta responde `requiere confirmación explícita` (hay una prueba e2e para eso).
8. **Errores (CA5)**: el adaptador traduce los errores del proveedor (timeout, clave inválida, límite de uso) a mensajes claros sin trazas; el turno termina con ese mensaje y la sesión sigue viva.
9. **Trazabilidad (CA4, RN5)**: cada herramienta registra `{ ts, herramienta, ok, resumen }` en `out/<caso>/log.jsonl` y, con `sessionId`, en `out/log.jsonl`. Los rechazos de validación se registran desde el ciclo. Los resúmenes nunca llevan valores sensibles.

El historial se guarda en un formato neutro (`Mensaje`), y el adaptador conserva el contenido original del proveedor (`crudo`) para reenviar intactos los bloques de razonamiento entre iteraciones.

## 4. Elección del modelo

- **Proveedor:** OpenAI, por SDK oficial (`openai`, Chat Completions con *function calling*) detrás de la interfaz `AdaptadorLLM` (`src/llm/openai.ts`). También existe una implementación para Anthropic (`src/llm/anthropic.ts`): cambiar de proveedor es cambiar `LLM_PROVIDER`, sin tocar el ciclo.
- **Modelo:** `gpt-5.4-mini` (configurable con `LLM_MODEL`). No se envía `reasoning_effort`: en `/v1/chat/completions` este modelo rechaza herramientas + `reasoning_effort` (error 400 encontrado al probar). Para razonamiento con herramientas habría que migrar el adaptador a `/v1/responses`.
- **Por qué:** el trabajo pesado (mapeo, formularios, vigencias) es determinista y lo hacen las herramientas. El modelo solo orquesta cinco llamadas y redacta un resumen fiel a los resultados, así que un modelo pequeño basta y abarata cada caso. Si el seguimiento de las reglas fallara, se sube a `gpt-5.4` cambiando una variable de entorno.
- **Costo estimado por caso:** un caso típico son unas 5 llamadas al modelo. El prompt con el conocimiento y las herramientas son unos 4 000 tokens y el contexto crece con los resultados hasta unos 10 000. En total son unos 35 000 tokens de entrada y entre 2 000 y 4 000 de salida (con razonamiento). Con precios del orden de décimas de dólar por millón de tokens de entrada y pocos dólares por millón de salida, el costo queda en **centavos de dólar por caso**; con 12 casos al mes, el gasto mensual es marginal. _(Verifica la tarifa vigente del modelo elegido en la página de precios de OpenAI.)_
- **Proveedor `simulado`:** es una tercera implementación del adaptador, determinista y sin modelo. Se usa en las pruebas e2e y como respaldo si no hay clave. Demuestra que cambiar de proveedor no toca el ciclo.

## 5. Diseño del portal web (sección 7.4)

**Hoy:** `formato = portal` responde "formato no soportado" y genera `out/<caso>/valores-portal.md`, con los valores en una tabla lista para copiar, el estado de cada campo, la URL del portal y la lista de soportes para cargar.

**Estrategia propuesta (fase 2): copiloto en el navegador de la analista, no un robot desatendido.**

| Opción | A favor | En contra | Decisión |
|---|---|---|---|
| Navegador controlado por el agente (Playwright en servidor) | Automatiza todo el flujo | Las credenciales tendrían que vivir en el servidor; se rompe con CAPTCHA, MFA y cambios de layout; cada portal es un script frágil | Descartado como opción principal |
| RPA tradicional | Herramienta conocida | Mismo problema de credenciales y fragilidad, más licencias | Descartado |
| **Extensión de navegador (copiloto)** | La sesión, las credenciales y el MFA son de la persona; el agente solo sugiere valores en los campos visibles | Hay que instalar una extensión; el mapeo de campos del portal no siempre es obvio | **Elegida** |

**Cómo funciona:**

1. La analista abre el portal en su navegador e **ingresa ella misma** usuario, contraseña y MFA. Si hay CAPTCHA, también lo resuelve ella.
2. La extensión lee las etiquetas de los campos visibles (DOM o `aria-label`) y las envía a `proveedor_mapear_campos`. Es la misma herramienta y el mismo glosario que usan el Excel y el PDF.
3. La extensión **resalta y prellena** los campos con valores del maestro. Los campos en `faltante` y `requiere_confirmacion` quedan marcados en otro color y no se llenan solos.
4. La analista revisa, adjunta los soportes (la extensión indica cuáles y dónde están en el paquete) y **hace clic en "Enviar" ella misma**. La extensión nunca dispara el envío.

**Credenciales:** nunca están en el repositorio, en el prompt, en los logs ni en el servidor del agente. Viven en el gestor de contraseñas corporativo o las tiene el representante legal (como indica el correo del caso de Panamá). El agente no las pide ni las recibe. Si en el futuro hiciera falta automatización desatendida, las credenciales irían a un gestor de secretos (Key Vault o 1Password Connect), con acceso de corta duración y con auditoría, y se inyectarían al navegador sin pasar nunca por el modelo.

**Límites:** CAPTCHA y MFA siempre los resuelve una persona. Ante cambios de layout, el mapeo se hace por etiqueta y no por selector, y si la confianza es baja el campo queda sin llenar. Cuando los campos se cargan dinámicamente, la extensión vuelve a escanear el formulario al cambiar de paso.

**Agente vs. humano:** el agente lee la solicitud, mapea, sugiere valores y prepara los soportes. El humano ingresa las credenciales, resuelve CAPTCHA y MFA, confirma los campos dudosos, adjunta los archivos y hace clic en "Enviar".

## 6. Decisiones y trade-offs

| # | Decisión | Alternativa descartada | Por qué |
|---|---|---|---|
| 1 | **Mapeo determinista** (glosario exacto y luego similitud de palabras con umbrales 0.8 y 0.6) dentro de la herramienta | Pedirle al LLM que mapee las etiquetas | Es reproducible, la confianza se puede auditar, `demo.ts` funciona sin modelo y el modelo no puede "llenar" un campo con un valor plausible. El costo es que los sinónimos fuera del glosario dependen del umbral; por eso caen en `requiere_confirmacion` en vez de llenarse. |
| 2 | `generar_formulario` recibe **rutas del maestro, nunca valores** | Aceptar `{ etiqueta, valor }` del modelo | Hace innecesaria la regla CA2: aunque el modelo "alucine", el valor siempre se relee del maestro. El costo es que la analista no puede escribir un valor libre desde el chat (por ejemplo, unas referencias comerciales); eso se completa a mano o actualizando el maestro, que es lo correcto. |
| 3 | **Ciclo manual** propio con adaptador neutro | Los *runners* de herramientas de los SDK (OpenAI / Anthropic) | Atan el ciclo a un proveedor. El PRD exige que cambiar de proveedor no toque el ciclo, y además necesitaba controlar el tope, la confirmación y los logs en cada iteración. |
| 4 | **PDF generado con pdf-lib** | Rellenar un AcroForm | No hay PDF original en los fixtures (solo la lista de campos) y el PRD lo acepta. pdf-lib es JavaScript puro, sin binarios ni fuentes externas. Si un cliente envía un AcroForm real, pdf-lib también puede rellenarlo. |
| 5 | **Confirmación en dos capas** (marca del modelo + estado en la sesión + verificación en la herramienta) | Confiar solo en el prompt | Un prompt se puede desobedecer. La regla RN4 queda garantizada por código. |
| 6 | **Enmascarar datos bancarios** en lo que ve el modelo (`****2345`) | Devolver el número completo | El modelo no necesita el número para orquestar. Así se reduce la exposición al proveedor y en el chat, mientras el formulario lleva el valor completo. |
| 7 | **`simular_envio` no se bloquea** si el paquete no está listo, pero lo advierte en el archivo y el agente debe avisar antes de preguntar | Bloquear el envío | El PRD solo pide confirmación explícita. Bloquear impediría, por ejemplo, enviar a firma interna mientras se renueva la Cámara de Comercio. Es una decisión de negocio que conviene validar (ver Supuestos). |
| 8 | **node:http sin framework** | Express o Hono | Son cinco rutas. Así hay una dependencia menos que justificar. |

**Dependencias:** `zod` (obligatoria; v4 trae `toJSONSchema` para generar el esquema de las herramientas), `openai` y `@anthropic-ai/sdk` (adaptadores de proveedor), `exceljs` (escribe `.xlsx` en hoja y celda exactas), `pdf-lib` (PDF sin binarios nativos) y `tsx` (ejecuta TypeScript en Node 20+ sin paso de build). En desarrollo: `typescript` y `@types/node`.

## 7. Supuestos

- La **fecha de ejecución** es la fecha del sistema al correr (configurable con `FECHA_EJECUCION`). Con la fecha de hoy (2026-10-02), la Cámara de Comercio (vence el 2026-09-30) y los parafiscales (vencen el 2026-08-31) están vencidos, así que **ningún caso queda `listo_para_firma`**. Es el comportamiento esperado de RN3.
- El soporte vencido **se copia igual** al paquete ("copias de los soportes exigidos que existan") y se marca como vencido en el checklist.
- "Correo electrónico" se resuelve como `contacto_comercial.email`, porque así lo define el glosario entregado.
- Para clientes extranjeros, el identificador tributario se llena con el NIT **sin dígito de verificación** (el valor tal cual está en el maestro) y queda `requiere_confirmacion`.
- `requiere_confirmacion` **no bloquea** la firma (RN3 solo menciona soportes), pero aparece en el checklist como pendiente.
- Montos como "Ingresos anuales" se escriben como número, sin convertir moneda. La moneda y el año se informan en una nota del mapeo.
- Los soportes son emitidos en Colombia. Para clientes de otros países, el checklist sugiere verificar apostilla o traducción (es informativo y no bloquea).
- En el caso de portal, los campos se toman de `plantilla-campos.json`, que el fixture trae aunque el formato sea portal.
- "Enviar" significa responder al cliente con el paquete. En el reto solo se escribe `ENVIO-SIMULADO.md`.

## 8. Cobertura

| Historia | Estado | Evidencia | Falta para producción |
|---|---|---|---|
| HU-1 Leer la solicitud | Hecho | `proveedor_leer_solicitud`: país, cliente, formato, campos (las etiquetas ambiguas salen como `requiere_confirmacion` con el equivalente del país) y soportes | Leer el correo y los adjuntos reales (Graph API o IMAP) y extraer las celdas de un `.xlsx` real en vez de un JSON |
| HU-2 Mapear al maestro | Hecho | Tres estados, ruta y confianza por campo; glosario exacto; RN1; nada se inventa | Que un dueño del dato apruebe el glosario; aprender sinónimos nuevos a partir de las confirmaciones |
| HU-3 Generar formulario | Hecho (P0 xlsx, P1 pdf, P2 portal con `valores-portal.md`) | `out/<caso>/formulario.xlsx` / `.pdf` | Escribir sobre la plantilla original del cliente (conservando estilos); rellenar AcroForm; extensión para portales |
| HU-4 Paquete para firma | Hecho | `paquete/` con formulario, soportes, `checklist.md`, `borrador-correo.md`; vencidos y ausentes bloquean; pregunta final; `ENVIO-SIMULADO.md` solo tras confirmar | Firma electrónica e integración con correo real |
| HU-5 Errores | Hecho | Herramientas que nunca lanzan, caso inexistente, plantilla corrupta (pruebas e2e), timeout del proveedor | Alertas y monitoreo |
| Bonus módulo | Hecho | `modulo/` se genera desde las mismas fuentes y `npm test` falla si se desincroniza | Publicarlo como paquete npm |

## 9. Uso de IA

- **Claude Code (modelo Claude Opus 5.5)** fue el asistente principal. Lo usé para leer el PRD y los fixtures, proponer la arquitectura, escribir el código de las herramientas, el ciclo, el adaptador, el front, las pruebas e2e y un primer borrador de esta documentación. También lo usé para verificar el resultado: ejecuté `demo.ts`, las pruebas y la API por HTTP, y revisé visualmente el PDF generado.
- **Lo que descarté o corregí de lo propuesto:**
  - Usar el Tool Runner del SDK: ataba el ciclo a un proveedor (ver Decisión 3).
  - Dejar que el modelo pasara valores en `mapeo`: se cambió a rutas del maestro (Decisión 2).
  - Un umbral de similitud de 0.5: con ese valor, "Referencias comerciales" se proponía como "Contacto comercial". Lo subí a 0.6 para que quede como faltante.
  - Servir `out/` completo por HTTP: exponía el historial de otras sesiones (`out/sesiones/`), así que se bloqueó esa ruta.
- _(Candidato: agrega aquí cualquier otro asistente que hayas usado y confirma tu revisión del código.)_

## 10. Riesgos de llevar esto a producción

| Riesgo | Mitigación |
|---|---|
| El modelo afirma un valor que no salió de una herramienta | Las herramientas son la única fuente; `generar_formulario` solo acepta rutas; el prompt lo prohíbe. Siguiente paso: un validador que compare el texto final con los valores devueltos. |
| El maestro está desactualizado (por ejemplo, cambia el representante legal) | Un dueño del dato y una fecha de última revisión por clave; alertar si es antigua. |
| Plantillas reales más desordenadas que los fixtures | Extraer las etiquetas del `.xlsx` o PDF real, que las que tengan baja confianza vayan siempre a confirmación, y medir la tasa de faltantes por cliente. |
| Datos sensibles (cuenta bancaria) expuestos al proveedor LLM o en logs | Enmascarado hacia el modelo, logs sin valores, borrador de correo verificado contra RN2 y retención cero con el proveedor. |
| Abuso del link público (costo) | `ACCESS_KEY`, límite por IP, tope de iteraciones y de tokens por sesión. En producción: SSO corporativo. |
| Envío sin control | Confirmación en dos capas verificada por código. En producción, el envío real requeriría además un rol autorizado y una bitácora firmada. |
| Pérdida de estado (contenedor efímero) | Mover sesiones y `out/` a almacenamiento persistente (SharePoint o blob) cuando se integre con el repositorio real. |
| Portales con CAPTCHA o MFA | Copiloto en el navegador; credenciales y clic final siempre humanos (sección 5). |
