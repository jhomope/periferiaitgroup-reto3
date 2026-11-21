# SOLUCION.md — Reto 03 · Agente conversacional de Órdenes de Compra (SAP)

> Equipo Perxia 2.0 · Periferia IT Group · TypeScript (Bun) · sin base de datos

---

## 1. Problema en una frase

Cada compra en Periferia se digita a mano en SAP a partir de tres correos (solicitud,
cotización y aprobación del líder), y **a la analista administrativa le duele el tiempo
y el error**: un centro de costo mal digitado se corrige en cierre contable, la
validación de que quien aprueba puede aprobar ese monto es mental y nadie sabe qué
porcentaje de órdenes son retroactivas.

---

## 2. Arquitectura

```
┌────────────────┐  POST /api/chat   ┌──────────────────────────────────────────────┐
│ web/ (chat)    │ ────────────────▶ │ src/server.ts                               │
│  index.html    │ ◀──────────────── │  · /api/chat · /api/sessions · /api/health   │
│  app.js        │   JSON            │  · sesiones → out/sesiones/ (src/sesiones.ts)│
└────────────────┘                   └──────────────┬───────────────────────────────┘
                                                    │
                       ┌────────────────────────────▼────────────────────────────┐
                       │ src/ciclo.ts  — ciclo del agente                        │
                       │   prompt → modelo → herramientas → resultado → …        │
                       │   tope CA1 · validación zod · log CA4 · errores CA5     │
                       │   system prompt = agent/prompt.md                       │
                       │              + src/knowledge/ordenes-compra.md          │
                       └──────────┬─────────────────────────────┬────────────────┘
                                  │                             │
                       ┌──────────▼──────────┐       ┌──────────▼──────────┐
                       │ src/llm/            │       │ src/tools/oc.ts     │
                       │  adapter.ts (interfaz)      │  oc_leer_paquete     │
                       │  anthropic.ts       │       │  oc_validar          │
                       │  openai.ts          │       │  oc_construir_payload│
                       │  (fetch, sin SDK)   │       │  oc_generar_evidencia│
                       └─────────────────────┘       │  oc_crear            │
                                                     └──────────┬──────────┘
                                  ┌─────────────────────────────▼────────────────┐
                                  │ src/core/  (ejecución pura, sin HTTP ni LLM) │
                                  │  lectura.ts  validacion.ts (RC1–RC10)        │
                                  │  payload.ts  evidencia.ts  salida.ts        │
                                  └───────┬──────────────────────────┬───────────┘
                                          │                          │
                          ┌───────────────▼──────┐       ┌───────────▼───────────┐
                          │ fixtures/reto-03/    │       │ out/                  │
                          │  (solo lectura)      │       │  <caso>/ log.jsonl    │
                          └──────────────────────┘       │  control.csv          │
                                          │              │  sap/ordenes.jsonl    │
                          ┌───────────────▼──────┐       └───────────────────────┘
                          │ src/sap/adapter.ts   │  interfaz obligatoria (PRD 7.4)
                          │ src/sap/mock.ts      │  implementación en archivos
                          └──────────────────────┘
```

**Dónde vive cada cosa** (separación que evalúa el PRD):

| Pieza | Archivo | Por qué allí |
|---|---|---|
| Comportamiento | `agent/prompt.md` | Cambiar el tono o las reglas de conversación no toca código |
| Conocimiento | `src/knowledge/ordenes-compra.md` | Cambiar una regla de negocio no toca el prompt ni el servidor |
| Ejecución | `src/tools/oc.ts` + `src/core/` | Importable desde `demo.ts` y desde `modulo/` sin servidor |
| Infraestructura | `src/server.ts`, `src/ciclo.ts`, `src/llm/` | Reemplazar el proveedor o el front no toca el dominio |

El system prompt que recibe el modelo es `prompt.md + conocimiento`, leído en cada
arranque del servidor (no está embebido en código).

---

## 3. Ciclo del agente

`src/ciclo.ts` implementa el bucle:

1. El turno entra por `POST /api/chat` con `{ sessionId, message }`; la sesión (historial,
   pendiente de confirmación y contador de tokens) vive en `src/sesiones.ts` y persiste en
   `out/sesiones/<id>.json`.
2. Se envía el system prompt + historial + el listado de herramientas (cuyo esquema JSON
   se genera con `z.toJSONSchema` desde los mismos esquemas zod que validan).
3. Si el modelo devuelve llamadas, cada una se **valida con zod antes de ejecutar**; un
   argumento inválido no llega a la función: se le devuelve `{ ok: false, error }` al
   modelo para que corrija (PRD 6.2).
4. Cada resultado se agrega al historial y al chat, y toda llamada queda en
   `out/log.jsonl` (CA4).
5. Se repite hasta que el modelo responda sin herramientas.

| Regla | Implementación |
|---|---|
| **CA1** tope de iteraciones | `LLM_MAX_ITERACIONES` (defecto 25). Al llegar al tope se le pide al modelo una respuesta **sin herramientas** y se le informa el corte; la historia nunca queda con un `tool_use` sin su `tool_result` (los adaptadores omiten `tools` cuando la lista está vacía). |
| **CA2** sin valores inventados | Las herramientas son la única fuente: `oc_validar` y `oc_crear` releen el caso desde disco en cada llamada, así que el modelo no puede “editar” el paquete pasando argumentos alterados. El prompt lo prohíbe y el diseño lo hace inútil. |
| **CA3** confirmación humana | Cuando `oc_validar` devuelve `confirmaciones` o `oc_crear` responde `requiere confirmación`, la sesión guarda `pendiente = { caso, confirmaciones }`, el turno termina con `needsConfirmation: true` y el front resalta la burbuja y muestra el banner de confirmación. `oc_crear` rechaza crear salvo `confirmado: true`; el flag se limpia cuando la creación sale bien. |
| **CA4** trazabilidad | `out/log.jsonl` con `{ ts, herramienta, mensaje_id, ok, resumen }` más el historial visible en el chat. |
| **CA5** errores | Ninguna herramienta lanza: todo se convierte en `{ ok: false, error }`. Un fallo del proveedor o falta de clave se muestra como frase normal en el chat y la sesión sigue viva. |

Tope de tokens por sesión (`LLM_MAX_TOKENS_SESION`) y timeout contra el proveedor
(`LLM_TIMEOUT_MS`) cubren el requisito de costo.

---

## 4. Elección del modelo

| Decisión | Detalle |
|---|---|
| Proveedor | **Anthropic** por defecto (`LLM_PROVIDER=anthropic`), con **OpenAI-compatible** como segunda implementación (`openai.ts` + `OPENAI_BASE_URL`, sirve para Groq, Mistral, OpenRouter u Ollama local). |
| Modelo | `LLM_MODEL` configurable; defecto `claude-sonnet-4-5` / `gpt-4o`. Se eligió un modelo con **function calling nativo**: las 5 herramientas viajan como `tools` y el modelo devuelve `tool_use` estructurado en vez de parsear JSON del texto. |
| Por qué | El trabajo es de orquestación (leer → validar → armar → crear), no de razonamiento largo: se necesita tool calling confiable, buena cobertura de español y costo bajo. La interfaz `AdaptadorLlm` hace que cambiar de proveedor sea tocar un archivo. |
| Sin SDK | Los adaptadores usan `fetch` directo: cero dependencias de proveedor, timeout propio con `AbortController` y mensajes de error en español. |

**Costo estimado por caso procesado** (estimación propia, verifica tu tarifa vigente):

| Concepto | Tokens aprox. | Nota |
|---|---|---|
| System prompt (prompt.md + conocimiento) | ~3.000 | se reenvía en cada llamada |
| Llamadas al modelo por caso | 6 – 9 | una por iteración de herramienta |
| Entrada acumulada por caso | ~25.000 – 35.000 | crece con el historial |
| Salida por caso | ~2.000 | texto + argumentos |

Con tarifas de ~USD 2–3 / millón de entrada y ~USD 10–15 / millón de salida:
**≈ USD 0,06 – 0,12 por caso**; con caché de prompt (lectura ~USD 0,10–1,25 / millón)
baja a **≈ USD 0,02 – 0,05**. El tope de iteraciones y el de tokens por sesión impiden
que un usuario malintencionado gaste sin límite.

---

## 5. Matriz de controles (RC1–RC10)

| Regla | Cómo se implementó | Tipo |
|---|---|---|
| RC1 | Búsqueda del proveedor **por NIT normalizado** (solo dígitos: `900.555.111-2` ≡ `900555111`) y, si no hay NIT, **por nombre normalizado** (minúsculas, sin acentos ni puntuación). Luego `activo === true`. | Bloqueo |
| RC2 | Tres condiciones: existe el correo, el cuerpo contiene “Aprobado” (`/\baprobado\b/i`) y el `de` está en `aprobadores[]` del `centro_costo` (comparación sin mayúsculas). | Bloqueo |
| RC3 | `valor_total ≤ tope` del aprobador resuelto en RC2 (se salta si RC2 no encontró aprobador). | Bloqueo |
| RC4 | `subarea ∈ centro.subareas`; también bloquea si el centro no existe. | Bloqueo |
| RC5 | `abs(cot − sol) / sol ≤ 0.02`. Si excede o no hay cotización: **confirmación** con ambos valores. | Confirmación |
| RC6 | Si falta `indicador_iva` se deriva del proveedor y se pide confirmación; si el código existe pero no está en el maestro: bloqueo. | Confirmación + derivado |
| RC7 | Si faltan `condiciones_pago` se derivan del proveedor y **solo se informa**; código desconocido: bloqueo. | Derivado |
| RC8 | `factura.fecha < solicitud.fecha_solicitud` → `retroactiva = true` + confirmación; la columna queda en `out/control.csv`. | Confirmación |
| RC9 | `aprobacion.fecha.slice(0,10) < fecha_solicitud` → confirmación (solo la parte de fecha, no la hora ni el huso). | Confirmación |
| RC10 | `abs(cantidad × valor_unitario − valor_total) ≤ 1`. | Bloqueo |

**La más difícil fue RC1**, por la normalización: los fixtures traen el NIT del proveedor
en tres formas distintas (maestro `900555111`, solicitud `900555111`, cotización
`900.555.111-2` con dígito de verificación) y una comparación ingenua habría marcado
como “inexistente” a proveedores válidos o, peor, habría emparejado por nombre y
aceptado un proveedor equivocado. La solución fue descartar todo lo que no sea dígito en
ambos lados y caer al nombre solo cuando la solicitud no trae NIT.
En segundo lugar RC2+RC3, que forman una cadena: no se puede evaluar el tope sin
resolver primero el centro de costo y dentro de él al aprobador.

Los derivados (`codigo_sap`, `indicador_iva`, `condiciones_pago`) se informan siempre
en el chat y quedan en `derivados`, porque el usuario debe saber qué se completó solo.

---

## 6. Diseño del adaptador SAP real (PRD 7.5)

**Opción elegida: OData `API_PURCHASEORDER_PROCESS_SRV` sobre SAP S/4HANA**, expuesta
por Integration Suite o directamente, con autenticación OAuth2 *client credentials*.

| Opción | Por qué / por qué no |
|---|---|
| OData `API_PURCHASEORDER_PROCESS_SRV` | API oficial, REST, versionada, soporta POST de OC con posiciones y devuelve el número. Es la que mejor se ajusta al payload 7.4 y permite lectura previa para idempotencia. **Elegida.** |
| BAPI `BAPI_PO_CREATE1` + `BAPI_TRANSACTION_COMMIT` | Muy madura y disponible en ECC, pero exige RFC/IDoc, conectividad (SAP Cloud Connector) y manejo de `BAPIRET2` con rollback manual. Descartada por la viabilidad no confirmada. |
| SAP Integration Suite / Event Mesh | Añade gobernabilidad y colas, pero más piezas móviles para un volumen de 20–40 OC/mes. Queda como fase 2 si entra la API. |
| Carga por archivo (SHDB / MASS / plantilla) | La más simple y la que no depende de API, pero sin validación en línea. Es el **plan B**. |

**Mapeo del payload 7.4 → OData:**

| Payload | Campo OData (`PurchaseOrder`) |
|---|---|
| `sociedad` / `organizacion_compras` | `CompanyCode` / `PurchasingOrganization` (fijos en 1000) |
| `proveedor.codigo_sap` | `Supplier` |
| `proveedor.nit` | `SupplierTaxNumber` (validación cruzada) |
| `condiciones_pago` | `PaymentTerms` |
| `moneda` | `DocumentCurrency` |
| `referencia.solicitud_id` | `ReferenceExtension1` + item `ReferenceItem` (clave de idempotencia) |
| `posiciones[].numero` | `PurchaseOrderItem` (10, 20, 30…) |
| `posiciones[].descripcion` | `PurchaseOrderItemText` (máx. 40) |
| `posiciones[].cantidad` / `unidad` | `OrderQuantity` / `PurchaseOrderQuantityUnit` |
| `posiciones[].precio_unitario` | `NetPrice` + `PriceUnit` |
| `posiciones[].centro_costo` / `subarea` | `CostCenter` + `WBSElement`/`InternalOrder` (subárea como extensión) |
| `posiciones[].indicador_iva` | `TaxCode` |
| `aprobador.*` / `evidencia_sha256` | Archivo adjunto (`DocumentAttachment`) + `CreatedBy` trazado en `textos` |

**Autenticación y credenciales:** usuario técnico con *client credentials* en un gestor
de secretos (Azure Key Vault / AWS Secrets Manager) o, en su defecto, variables de
entorno del backend. Nunca en el repositorio, nunca en el prompt, nunca en logs: el
adaptador real viviría en `src/sap/sapReal.ts` y solo leería `SAP_CLIENT_ID` /
`SAP_CLIENT_SECRET` / `SAP_BASE_URL` desde `process.env`.

**Idempotencia y errores parciales:** antes de crear se consulta por
`referencia.solicitud_id` (`$filter`); si existe se devuelve el número existente — la
misma semántica que ya implementa el mock. Si SAP responde error parcial (alguna
posición rechazada), no se hace commit: se devuelve `BAPIRET2`/`error` al agente, que
informa a la analista y deja la OC sin crear en `control.csv` con `resultado=pendiente`,
para reintentar sin duplicados.

**Plan B si la conexión no es viable:** el agente ya genera `out/<caso>/payload.json`
con trazabilidad completa; se puede (a) entregar un CSV/Excel listo para carga masiva
por `SHDB`/`LSMW`, (b) generar el texto de la OC para pegar en SAP GUI, o (c) publicar
un endpoint que un RPA interno consuma. En los tres casos el ahorro de digitación se
mantiene: el 100% de los datos ya salió de las herramientas.

---

## 7. Lectura del proceso: las OC retroactivas

**Qué le diría a la dirección:** las órdenes retroactivas no son un problema de la
analista, son un problema de proceso: hoy la factura llega antes que la OC porque nadie
obliga al solicitante a pedir la compra antes de comprar. Medir “% de OC retroactivas”
sin cambiar nada solo convierte el problema en una métrica. De lo que vimos en los
fixtures, la causa raíz es que **el disparador de la OC es la factura**, cuando debería
ser la solicitud aprobada. Mientras eso no cambie, el agente detecta y marca el caso
(`retroactiva = true` en `out/control.csv`) pero no puede evitarlo: la confirmación
humana sigue siendo obligatoria porque una compra retroactiva tiene implicaciones
contables y de control interno que no decide una máquina.

**Cambio de proceso que propondría:** (1) disparador único: la OC se pide **antes** de
la compra, con la solicitud aprobada como evidencia mínima; (2) tolerancia cero con
escalamiento: si llega una factura sin OC, el sistema la registra como excepción y la
escala al líder del centro de costo en 24 horas, en lugar de aceptarla en silencio;
(3) medición semanal del indicador `% de facturas sin OC previa` con dueño nombrado;
(4) corte de pago: sin OC no hay pago, salvo aprobación expresa de gerencia — esa es la
única regla que realmente cambia el comportamiento. El agente aporta la medición y la
evidencia, no la sanción.

---

## 8. Decisiones y trade-offs

| # | Decisión | Alternativa descartada | Por qué |
|---|---|---|---|
| 1 | Las herramientas **releen el caso de disco** y los argumentos `paquete`/`derivados`/`payload` son opcionales e informativos | Confiar en el objeto que el modelo devuelve en sus argumentos | El modelo podría “suavizar” un valor al reenviarlo (riesgo del PRD §10). Releer garantiza CA2 sin sacrificar el contrato de entrada exigido. El `payload` sí se acepta, pero se valida con zod y se cruza contra la solicitud (solicitud_id, total y NIT) antes de crear. |
| 2 | **Fetch propio sin SDK** de Anthropic/OpenAI | `@anthropic-ai/sdk` / `openai` | Menos dependencias, timeout propio y misma interfaz para ambos. El costo es escribir el mapeo de mensajes (bloques `tool_use` / `tool_calls`), que está cubierto por tests con adaptador falso. |
| 3 | Front **HTML/JS plano** servido por el mismo proceso | React + build | El PRD pide front libre; sin paso de build el arranque es un comando y el despliegue no necesita Node en el host. La interacción requerida (historial, tarjetas de herramientas, resaltado de confirmación) no justifica un bundler. |
| 4 | **SAP simulado con archivos** (`out/sap/ordenes.jsonl`) y numeración secuencial | SQLite / JSON único | Determinismo y legibilidad en la defensa: se puede leer con cualquier editor y la idempotencia se verifica inspeccionando el archivo. La interfaz `SapAdapter` deja el cambio a producción en un archivo. |
| 5 | **Evidencia: hash sobre encabezados+cuerpo** y el PDF generado por `pdf-lib` | Hashear el archivo completo | El mismo hash se calcula en `oc_generar_evidencia` y en `oc_construir_payload` desde la misma función `contenidoEvidencia`, así el `evidencia_sha256` de la OC coincide byte a byte con `out/<caso>/aprobacion.txt` aunque se genere en otro orden. |

---

## 9. Supuestos

1. Los fixtures representan la variabilidad real; en producción habrá solicitudes en
   Excel/PDF reales y correos con adjuntos rotos (el P1 `oc_leer_excel` quedó fuera).
2. El maestro de proveedores/centros/IVA/pago está actualizado y es la única fuente de
   verdad de esos datos.
3. El correo de aprobación es evidencia suficiente (auditoría podría exigir firma
   digital: fuera de alcance).
4. Moneda siempre COP o USD (el esquema SAP lo restringe; otra moneda produce
   `{ ok: false }` en lugar de un payload inválido).
5. Una sola posición por OC (los fixtures son de un ítem); múltiples posiciones ya están
   soportadas por el esquema y serían un `posiciones[]` de más elementos.
6. Unidad `H` cuando la descripción menciona horas, `UN` en el resto (`MES` previsto
   para suscripciones): heurística documentada, no derivada del maestro.
7. El campo `descripcion` se trunca a 40 caracteres por el límite de texto breve de SAP.
8. `nombre` del proveedor se usa como fallback de identificación solo cuando la
   solicitud no trae NIT.
9. Los nombres de caso son seguros (`^[A-Za-z0-9_-]+$`): no hay path traversal.

---

## 10. Cobertura de historias de usuario

| HU | Estado | Evidencia / qué falta |
|---|---|---|
| HU-1 · Leer el paquete | **Hecho** | `oc_leer_paquete` normaliza correo, solicitud, cotización, aprobación y factura; adjuntos ausentes quedan en `faltantes` sin excepción. |
| HU-2 · Validar contra maestros y controles | **Hecho** | `oc_validar` aplica RC1–RC10 → `{ apta, bloqueos, confirmaciones, derivados, retroactiva }`; derivados informados en el chat. |
| HU-3 · Construir el payload | **Hecho** | `oc_construir_payload` valida con zod y escribe `out/<caso>/trazabilidad.json` con la fuente de cada valor. |
| HU-4 · Evidencia de aprobación | **Hecho** (P0 + P1) | `aprobacion.txt` con encabezados, cuerpo y sha256 (P0) + `aprobacion.pdf` con `pdf-lib` (P1). |
| HU-5 · Crear la OC en SAP simulado | **Hecho** | `oc_crear` exige `apta` y confirmación, numeración desde `4500000001`, idempotencia por `solicitud_id` y fila en `out/control.csv` en cada intento. |
| HU-6 · Manejo de errores | **Hecho** | Caso inexistente, JSON malformado, moneda no soportada, payload que no corresponde al caso: `{ ok: false, error }` legible; la sesión no muere. |

**Fuera de alcance / no hecho (y por qué):**

| Ítem | Estado | Motivo |
|---|---|---|
| `oc_leer_excel` (P1 opcional) | No hecho | Los fixtures traen la solicitud ya normalizada en JSON; leer `.xlsx` binario requeriría `exceljs` sin aportar a la evaluación. |
| Despliegue con clave del proveedor | Pendiente de clave | Ver §12; el código está listo: basta `.env` en el host. |
| Workflow de aprobación, multiusuario, BD | No objetivo | Explícitamente fuera de alcance en PRD 3.2. |

---

## 11. Uso de IA

| Asistente | Para qué | Qué se descartó |
|---|---|---|
| Asistente de IA con acceso directo al repositorio (sesión OpenCode) | Leer e interpretar el PRD, diseñar la arquitectura (capas `core` / `tools` / `llm` / `sap`), escribir y revisar el código TypeScript, redactar `prompt.md`, el conocimiento, este documento y los tests, y correr `demo`/`typecheck`/`bun test` de forma iterativa. | Propuestas de usar un ORM o base de datos (el PRD los prohíbe), de meter un SDK del proveedor (se eligió `fetch`) y de parserar la respuesta del modelo con expresiones regulares en el texto (se usó tool calling nativo). |

Toda la lógica de negocio está en `src/core/` con nombres propios del dominio
(`validarPaquete`, `construirOrden`) para que sea explicable línea por línea en la
defensa: la IA aceleró la escritura, la decisión de diseño y la verificación quedaron
documentadas en §8 y §9.

---

## 12. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| El modelo “arregla” un monto para que cuadre con la cotización | Los montos salen de `solicitud.json` vía herramientas; `oc_crear` valida el payload con zod y lo cruza contra `valor_total` y el NIT antes de crear (CA2). |
| El usuario gasta la clave sin límite | Tope de iteraciones por turno, tope de tokens por sesión, timeout al proveedor, `.env` fuera del repo y `configured: false` como única pista en `/api/health`. |
| La conexión a SAP no sea viable | Interfaz `SapAdapter` + plan B (§6): el ahorro de digitación se mantiene con carga masiva o pegado manual. |
| Falsos positivos de proveedor por nombre | Búsqueda por NIT primero, normalización agresiva del nombre como fallback (§5). |
| Confirmación “automatizada” por el modelo sin usuario real | `confirmado` solo se pasa desde el turno en que el usuario respondió; el prompt prohíbe auto-confirmarse y la sesión guarda `pendiente` hasta que `oc_crear` tenga éxito. |
| Duplicar una OC en reintentos | Idempotencia por `solicitud_id` en `SapAdapter.buscarOrdenPorReferencia` (verificada en la demo). |
| Traer datos reales de personas en producción | Fixtures ficticios; no hay PII ni credenciales en el repositorio. |
