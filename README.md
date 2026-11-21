# Reto 03 — Compras Bot: Órdenes de Compra en SAP simulado

Agente conversacional completo (chat + backend + ciclo del agente + herramientas tipadas
con zod + modelo de lenguaje) que lee los paquetes de compra, los valida contra los
maestros con las reglas RC1–RC10, arma el payload de la OC, genera la evidencia de
aprobación y crea la orden en un SAP simulado.

> Prueba técnica · Periferia IT Group · PRD en [`PRD.md`](./PRD.md)

---

## Arranque en un comando

```bash
cp .env.example .env      # y pega tu clave del modelo en .env
bun install
bun run dev               # levanta backend + front en http://localhost:8787
```

En una máquina limpia con Bun y las variables de `.env.example` tarda menos de 2 minutos.

**Requisitos:** [Bun](https://bun.sh) ≥ 1.2 (o Node 20+ con `bun run start:node`).

---

## Variables de entorno (`.env`)

| Variable | Obligatoria | Descripción |
|---|---|---|
| `LLM_PROVIDER` | No | `anthropic` (por defecto) u `openai` (cualquier endpoint compatible: Groq, Mistral, OpenRouter, Ollama…) |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | **Sí** | Clave del modelo. Solo en el backend: nunca aparece en el repositorio, el front ni los logs |
| `LLM_MODEL` | No | Modelo a usar. Defecto: `claude-sonnet-4-5` o `gpt-4o` |
| `OPENAI_BASE_URL` | No | Para endpoints compatibles con OpenAI |
| `LLM_MAX_ITERACIONES` | No | Tope de iteraciones herramienta→modelo por turno (defecto 25, regla CA1) |
| `LLM_TIMEOUT_MS` | No | Timeout contra el proveedor (defecto 60000) |
| `LLM_MAX_TOKENS_SESION` | No | Tope de tokens por sesión (defecto 200000, control de costo) |
| `PORT` | No | Puerto del servidor (defecto 8787) |

`.env` está en `.gitignore`: no se versiona jamás.

---

## Verificación sin modelo

```bash
bun run demo        # procesa los 6 casos llamando a las herramientas, sin clave
bun test            # 5 tests del ciclo del agente con un adaptador falso
bun run typecheck   # TypeScript estricto, sin any
```

La demo imprime, por caso: `apta`, bloqueos, confirmaciones, `retroactiva`, el número de
OC o el motivo por el que no se creó, y cierra con `out/control.csv` y `out/log.jsonl`.

Resultados esperados (PRD 7.4):

| Caso | Resultado |
|---|---|
| `sol-001` | OC `4500000001`; una segunda llamada devuelve la misma (idempotencia) |
| `sol-002` | Bloqueado — RC1: proveedor inexistente en el maestro |
| `sol-003` | Bloqueado — RC2: el aprobador no es autorizado para ese centro de costo |
| `sol-004` | Pendiente de confirmación — RC5: cotización 6% por encima de la solicitud → tras confirmar, OC `4500000002` |
| `sol-005` | Retroactiva (RC8) → tras confirmar, OC `4500000003` con `retroactiva=true` en control |
| `sol-006` | IVA derivado del proveedor (RC6) + condiciones de pago derivadas (RC7) → tras confirmar, OC `4500000004` |

---

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId?, message }` → `{ sessionId, reply, toolCalls[], needsConfirmation }` |
| `GET` | `/api/sessions/:id` | `{ id, needsConfirmation, pendiente, historial }` |
| `GET` | `/api/health` | `{ ok, provider, model, configured }` — nunca expone claves |
| `GET` | `/api/casos` | `{ casos: [...] }` — casos disponibles en fixtures |
| `GET` | `/` | Front de chat (`web/`) |

---

## Estructura

```
├── agent/prompt.md                 # comportamiento del agente (system prompt)
├── src/
│   ├── server.ts                   # API HTTP + composición del system prompt
│   ├── ciclo.ts                    # bucle: prompt → modelo → herramientas → respuesta
│   ├── sesiones.ts                 # sesiones en out/sesiones/ + tope de tokens
│   ├── env.ts                      # carga .env sin exponer claves
│   ├── llm/                        # adaptador propio + anthropic.ts + openai.ts
│   ├── tools/oc.ts                 # 5 herramientas: oc_leer_paquete … oc_crear
│   ├── core/                       # lectura, RC1–RC10, payload, evidencia, out/
│   ├── sap/adapter.ts + mock.ts    # interfaz SAP (PRD 7.4) + simulación
│   ├── knowledge/ordenes-compra.md # conocimiento del proceso
│   └── ciclo.test.ts               # tests con adaptador falso
├── web/                            # front de chat (HTML/JS plano, sin build)
├── fixtures/reto-03/               # entregado por Periferia (solo lectura)
├── out/                            # generado en ejecución (no se versiona)
├── modulo/                         # bonus: agente empaquetado (bun run sync:modulo)
├── demo.ts                         # herramientas sin modelo
├── README.md · SOLUCION.md · PRD.md
```

---

## Link de prueba

Ver [sección "Link para probar"](#link-para-probar) al final de este archivo.

---

## Seguridad

- La clave del modelo vive solo en `.env` del backend; `/api/health` la reporta como
  `configured: true|false` sin mostrarla.
- Las herramientas no ejecutan comandos de shell ni aceptan rutas absolutas: el nombre
  del caso se valida con `^[A-Za-z0-9_-]+$` y se resuelve desde la raíz del proyecto.
- `fixtures/` es de solo lectura; todo lo generado queda en `out/`.
- Sin datos personales reales: los fixtures son ficticios.
- Control de costo: tope de iteraciones por turno y tope de tokens por sesión.
