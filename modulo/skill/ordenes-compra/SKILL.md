---
name: ordenes-compra
description: Conocimiento del proceso de Órdenes de Compra de Periferia — reglas RC1-RC10, payload SAP, maestros y salidas en out/.
---

# Conocimiento del proceso: Órdenes de Compra

Documento de **conocimiento** (no de comportamiento): describe el proceso, los datos y
las reglas. El comportamiento del agente vive en `agent/prompt.md`.

## El proceso hoy

Cada compra llega a `compras@periferia-ficticia.com` con tres piezas: la solicitud de
compra del solicitante, la cotización del proveedor y el correo en el que el líder
responde "Aprobado". La analista digitaba a mano en SAP: proveedor, descripción, centro
de costos, subárea, valor, indicador de IVA, aprobador y condiciones de pago, y adjuntaba
el correo de aprobación convertido a PDF. El agente prepara esa OC y la crea en el SAP
simulado.

## Archivos

| Ruta | Qué contiene |
|---|---|
| `fixtures/reto-03/solicitudes/<caso>/correo.json` | Correo de entrada: `id`, `de`, `para`, `asunto`, `fecha`, `cuerpo`, `adjuntos[]` |
| `…/solicitud.json` | Solicitud normalizada: `solicitud_id`, `proveedor_nombre`, `proveedor_nit`, `descripcion`, `centro_costo`, `subarea`, `cantidad`, `valor_unitario`, `valor_total`, `moneda`, `indicador_iva?`, `condiciones_pago?`, `fecha_solicitud` |
| `…/cotizacion.txt` | Cotización en texto: proveedor, NIT, ítems, base gravable, IVA, `TOTAL`, validez |
| `…/aprobacion.json` | `de`, `para`, `fecha`, `asunto`, `cuerpo` (contiene o no "Aprobado") |
| `…/factura.txt` | Solo en casos retroactivos: número, fecha de emisión y total |
| `fixtures/reto-03/maestros/proveedores.json` | `codigo_sap`, `nit`, `nombre`, `condiciones_pago_default`, `indicador_iva_default`, `activo` |
| `…/centros-costo.json` | `centro_costo`, `subareas[]`, `aprobadores[{ email, nombre, tope }]` |
| `…/indicadores-iva.json` | `codigo`, `descripcion`, `tasa` (C0 excluido, C1 19%, C2 5%) |
| `…/condiciones-pago.json` | `codigo`, `descripcion`, `dias` (Z000, Z015, Z030, Z060) |

Todo lo que se genera vive en `out/` (nunca se escribe en `fixtures/`).

## Reglas de control (PRD 7.3)

| Regla | Qué verifica | Tipo |
|---|---|---|
| RC1 | El proveedor existe en el maestro (por NIT; si no hay NIT, por nombre normalizado) y está `activo` | Bloqueo |
| RC2 | La aprobación existe, contiene "Aprobado" y viene de un correo listado como aprobador del `centro_costo` | Bloqueo |
| RC3 | `valor_total` ≤ `tope` del aprobador para ese centro | Bloqueo |
| RC4 | `subarea` pertenece al `centro_costo` | Bloqueo |
| RC5 | `abs(cotizacion.total − solicitud.valor_total) / solicitud.valor_total` ≤ 2 %. Si excede, o si no hay cotización: confirmación | Confirmación |
| RC6 | `indicador_iva` ausente → se deriva del proveedor y se pide confirmación; si el código existe pero no está en el maestro: bloqueo | Confirmación + derivado |
| RC7 | `condiciones_pago` ausente → se deriva del proveedor. Solo se informa; código desconocido: bloqueo | Derivado |
| RC8 | Existe `factura` con `fecha` < `fecha_solicitud` → `retroactiva = true`, confirmación y queda en el log de control | Confirmación |
| RC9 | La fecha de aprobación es ≥ `fecha_solicitud`; si no: confirmación | Confirmación |
| RC10 | `cantidad × valor_unitario` = `valor_total` (± 1 unidad monetaria) | Bloqueo |

Consecuencias: sin `apta = true` no se crea nada; con `confirmaciones` solo se crea si el
usuario confirmó (`confirmado: true`); los `derivados` se informan siempre.

## Payload de la OC (SAP)

`sociedad = 1000`, `organización_compras = 1000`, una sola posición con `numero = 10`.
Restricciones del sistema: `descripcion` máximo 40 caracteres (texto breve de SAP),
`unidad ∈ {UN, H, MES}` (H si la descripción es por horas), `moneda ∈ {COP, USD}`,
`condiciones_pago` e `indicador_iva` son **códigos** de los maestros (Z030, C1…), no
textos. `aprobador.evidencia_sha256` es el sha256 de `out/<caso>/aprobacion.txt`.

## Salidas

| Ruta | Contenido |
|---|---|
| `out/<caso>/paquete.json` | Paquete normalizado leído |
| `out/<caso>/validacion.json` | Resultado de RC1–RC10 |
| `out/<caso>/trazabilidad.json` | Fuente de cada valor del payload (`solicitud`, `cotizacion`, `maestro.<nombre>`, `derivado`, `estatico`) |
| `out/<caso>/payload.json` / `oc-creada.json` | Payload armado y OC creada |
| `out/<caso>/aprobacion.txt` / `.pdf` | Evidencia con encabezados, cuerpo y sha256 |
| `out/sap/ordenes.jsonl` | SAP simulado: números desde `4500000001` |
| `out/control.csv` | Un intento por fila: `solicitud_id, resultado, numero_oc, retroactiva, bloqueos, confirmaciones, ts` |
| `out/log.jsonl` | Toda llamada a herramienta: `{ ts, herramienta, mensaje_id, ok, resumen }` |

## Errores frecuentes

- `falta solicitud.json` → sin solicitud no hay paquete: pide el archivo al solicitante.
- `caso inexistente` → el nombre debe ser exacto y estar en `fixtures/reto-03/solicitudes/`.
- `moneda no soportada` → el adaptador solo acepta COP o USD.
- `no se resolvió el código SAP` → falló RC1; corrige el proveedor antes de armar el payload.
