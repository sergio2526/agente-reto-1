# Agente · Registro como Proveedor (Reto técnico 01)

Agente conversacional en TypeScript que lee una solicitud de registro como proveedor, cruza los campos con el repositorio maestro, genera el formulario (Excel o PDF) y arma el paquete para la firma del representante legal. Nunca firma ni envía: prepara el paquete y pregunta antes de cualquier acción externa.

- **Link de prueba:** _pendiente de despliegue (ver "Despliegue")_
- **Clave de acceso:** _la que se defina en `ACCESS_KEY` (vacía = link abierto)_

## Requisitos

Node 20 o superior (probado con Node 22). Bun también funciona.

## Levantar en local (un comando)

```bash
npm install && npm run dev        # o: bun install && bun run dev
```

Abre **http://localhost:3002**. La cabecera del chat debe mostrar `Proveedor: openai · Modelo: gpt-5.4-mini`. Sin clave del proveedor (`OPENAI_API_KEY`), el servidor arranca con el proveedor `simulado` (un guion determinista sin modelo) para que el chat funcione igual de punta a punta.

Con Docker:

```bash
docker compose up --build
```

## Configurar la clave de OpenAI

1. Copia `.env.example` a `.env` (el archivo `.env` está en `.gitignore`: la clave nunca entra al repositorio).
2. Pega tu clave en la línea `OPENAI_API_KEY=sk-...`.
3. Reinicia el servidor (`Ctrl+C` y `npm run dev`) y, en el chat, pulsa **Nueva sesión**.

## Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `OPENAI_API_KEY` | Para usar el modelo real | Clave de OpenAI. Solo vive en el backend. |
| `LLM_PROVIDER` | No | `openai` (por defecto), `anthropic` (usa `ANTHROPIC_API_KEY`) o `simulado`. |
| `LLM_MODEL` | No | Por defecto `gpt-5.4-mini` (OpenAI) o `claude-opus-5` (Anthropic). |
| `LLM_EFFORT` | No | `low`, `medium` (por defecto) o `high`. Solo lo usa el adaptador de Anthropic: con OpenAI no se envía `reasoning_effort`, porque `gpt-5.4-mini` lo rechaza junto con herramientas en `/v1/chat/completions` (error 400). |
| `LLM_TIMEOUT_MS` | No | Timeout por llamada al modelo. Por defecto 90000. |
| `MAX_ITERACIONES` | No | Tope de iteraciones herramienta → modelo por turno. Por defecto 25. |
| `MAX_TOKENS_SESION` | No | Tope de tokens por sesión. Por defecto 400000. |
| `ACCESS_KEY` | No | Si se define, la API exige la cabecera `x-access-key` y el chat la pide una vez. |
| `FECHA_EJECUCION` | No | Fecha (YYYY-MM-DD) para evaluar vigencias. Vacía = hoy. |
| `PORT` | No | Por defecto 3002. |

## Verificación sin modelo

```bash
npm run demo          # o: bun run demo.ts
```

Limpia `out/`, ejecuta las herramientas sobre los 4 casos e imprime un resumen por caso. No necesita ninguna clave.

```bash
npm test              # pruebas end-to-end del ciclo (confirmación, tope, errores, RN2, RN5, módulo)
npm run typecheck     # TypeScript estricto, sin any
npm run build:modulo  # regenera modulo/ desde las fuentes de la app
```

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId?, message }` → `{ sessionId, reply, toolCalls[], needsConfirmation, tokensSesion }` |
| `GET` | `/api/sessions/:id` | `{ id, eventos[], tokens, pendienteConfirmacion }` |
| `GET` | `/api/health` | `{ ok: true, provider, model, protegido }`, sin claves |
| `GET` | `/api/casos` | Casos disponibles con cliente, país y formato |
| `GET` | `/api/out/<caso>/<archivo>` | Descarga de los artefactos generados (formulario, checklist, etc.) |

Cada elemento de `toolCalls` tiene la forma `{ nombre, args, ok, resumen, resultado }`. Si no se envía `sessionId`, se crea una sesión nueva y se devuelve su id.

## Prueba sugerida

En una sesión nueva:

```
Procesa el caso "ec-corp-andina". Dime qué campos quedaron llenos, cuáles
faltan, si el paquete está listo para firma y qué soportes debo actualizar.
No envíes nada todavía.
```

Resultado esperado (verificado con OpenAI `gpt-5.4-mini`):

- Se ven 4 llamadas a herramientas en el chat: `leer_solicitud`, `mapear_campos`, `generar_formulario` y `armar_paquete`.
- Formulario `out/ec-corp-andina/formulario.pdf`: 13 campos llenos. Faltante: "Número de contribuyente especial". Por confirmar: "RUC" (identificador extranjero).
- Paquete `out/ec-corp-andina/paquete/`, **no listo para firma**: la Cámara de Comercio venció el 2026-09-30 y falta el certificado de cumplimiento tributario.
- El turno cierra con una pregunta de confirmación resaltada en el chat. Todavía no existe `ENVIO-SIMULADO.md`.

Luego escribe `envía` o usa el botón "Sí, confirmo el envío". Solo entonces se escribe `out/ec-corp-andina/ENVIO-SIMULADO.md`. Si escribes "envía" sin que el agente haya hecho antes la pregunta, el envío se rechaza (`requiere confirmación explícita`).

### Resultado de los 4 casos

| Caso | Formato | Faltantes | Por confirmar | Listo para firma |
|---|---|---|---|---|
| `co-industrias-delta` | xlsx (17/17 llenos) | — | — | no: Cámara de Comercio vencida |
| `ec-corp-andina` | pdf | Número de contribuyente especial | RUC | no: Cámara vencida y certificado de cumplimiento tributario ausente |
| `hn-agroexport-sula` | xlsx | Referencias comerciales | RTN | no: Cámara y parafiscales vencidos |
| `pa-logistica-istmo` | portal → "formato no soportado" y `valores-portal.md` | — | RUC | no: Cámara vencida |

Con la fecha de ejecución 2026-10-02, ningún caso queda listo para firma porque la Cámara de Comercio vence el 2026-09-30. Para simular otra fecha, usa `FECHA_EJECUCION`.

## Estructura

```
agent/prompt.md                 comportamiento (system prompt)
src/knowledge/                  conocimiento: registro-proveedor.md + reglas.ts (reglas de negocio como datos)
src/tools/proveedor.ts          herramientas (zod) → proveedor_<export>
src/tools/lib/                  lógica de las herramientas (mapeo, formularios, paquete, contrato { ok, data })
src/agent/                      ciclo del agente, registro de herramientas, sesiones, carga del prompt
src/llm/                        adaptador propio + OpenAI + Anthropic + simulado
src/server.ts                   API HTTP y estáticos
web/index.html                  chat
modulo/                         agente empaquetado para otras plataformas (bonus)
demo.ts                         herramientas sin modelo
scripts/                        pruebas e2e y generación de modulo/
```

## Solución de problemas

Cuando el proveedor falla, el chat muestra un mensaje claro y la terminal del servidor imprime el detalle real (`[openai] <código>: <mensaje>`) con la clave enmascarada.

| Síntoma en el chat | Causa probable | Qué hacer |
|---|---|---|
| La cabecera dice `Proveedor: simulado` | El servidor no encontró `OPENAI_API_KEY` | Revisa `.env` y reinicia el servidor |
| "La clave … no es válida" | Clave incorrecta o revocada | Genera otra en la consola de OpenAI |
| "El modelo configurado (LLM_MODEL) no existe…" | Tu cuenta no tiene acceso a ese modelo | Cambia `LLM_MODEL` (por ejemplo `gpt-5.4`) |
| "…limitando las solicitudes o la cuenta no tiene saldo" | Límite de uso o sin crédito | Espera o agrega saldo |
| "…rechazó la solicitud (petición inválida)" | Parámetro no soportado por el modelo | Mira el detalle en la terminal del servidor |
| El puerto 3002 está ocupado | Otro proceso lo usa | Define otro `PORT` en `.env` |

## Despliegue

El repositorio incluye `Dockerfile` y `render.yaml`. En Render: **New → Blueprint**, selecciona el repositorio y completa `OPENAI_API_KEY` (y opcionalmente `ACCESS_KEY`) como secretos. Funciona igual en Railway o Fly.io con el mismo Dockerfile. El sistema de archivos del contenedor es efímero: `out/` y las sesiones se pierden al reiniciar, lo cual es aceptable para este reto.
