/**
 * demo.ts — verifica el reto 03 SIN modelo de lenguaje (PRD 6.6).
 *
 * Recorre los 6 casos de fixtures/reto-03/solicitudes/ llamando directamente a
 * las herramientas: leer_paquete → validar → generar_evidencia →
 * construir_payload → crear. Muestra apta, bloqueos, confirmaciones,
 * retroactiva, el número de OC o el motivo por el que no se creó.
 *
 *   bun install && bun run demo.ts
 *
 * No requiere clave de ningún proveedor. out/ se limpia al inicio para que las
 * ejecuciones consecutivas sean deterministas (salvo timestamps).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { limpiarOut } from "./src/core/salida.ts";
import { raizProyecto } from "./src/core/raiz.ts";
import type { OrdenCompra } from "./src/core/payload.ts";
import type { Paquete, ResultadoValidacion } from "./src/core/tipos.ts";
import { herramientasOc, herramientasCompletas, type Ctx } from "./src/tools/oc.ts";

type Respuesta<T> = { ok: true; data: T } | { ok: false; error: string };

type CrearData = {
  numero_oc: string;
  fecha: string;
  idempotente: boolean;
  retroactiva: boolean;
};

type EvidenciaData = { ruta: string; ruta_pdf: string; sha256: string };

type PayloadData = { orden: OrdenCompra; ruta_trazabilidad: string };

const raiz = raizProyecto();
const ctx: Ctx = { directory: raiz, sessionId: "demo" };

async function ejecutar<T>(nombre: string, args: Record<string, unknown>): Promise<Respuesta<T>> {
  const herramienta = herramientasOc[nombre as keyof typeof herramientasOc] as unknown as {
    execute: (args: Record<string, unknown>, ctx: Ctx) => Promise<string>;
  };
  const texto = await herramienta.execute(args, ctx);
  return JSON.parse(texto) as Respuesta<T>;
}

function linea(titulo: string, detalle: string): void {
  console.log(`  ${titulo.padEnd(20)}→ ${detalle}`);
}

function fallo(paso: string, error: string): never {
  console.error(`  ✗ ${paso}: ${error}`);
  process.exit(1);
}

/** Confirmaciones que el usuario daría en el chat, una por caso que las pide. */
const CONFIRMACIONES: Record<string, string> = {
  "sol-004": "confirmo la diferencia entre cotización y solicitud",
  "sol-005": "confirmo la compra retroactiva",
  "sol-006": "confirmo el indicador de IVA derivado",
};

async function procesarCaso(caso: string): Promise<void> {
  console.log(`\n${"─".repeat(78)}\n${caso}`);

  const paq = await ejecutar<Paquete>("leer_paquete", { caso });
  if (!paq.ok) return fallo("oc_leer_paquete", paq.error);
  const faltantes = paq.data.faltantes.length > 0 ? ` · faltantes: ${paq.data.faltantes.join(", ")}` : "";
  linea("1. leer_paquete", `${paq.data.solicitud.solicitud_id} · ${paq.data.solicitud.proveedor_nombre}${faltantes}`);

  const val = await ejecutar<ResultadoValidacion>("validar", { caso, paquete: paq.data });
  if (!val.ok) return fallo("oc_validar", val.error);
  const v = val.data;
  linea("2. validar", `apta=${v.apta} · retroactiva=${v.retroactiva}`);
  for (const bloqueo of v.bloqueos) console.log(`       ✗ ${bloqueo}`);
  for (const c of v.confirmaciones) console.log(`       ? ${c.codigo}: ${c.detalle}`);
  const derivados = Object.entries(v.derivados);
  if (derivados.length > 0) {
    console.log(`       → derivados: ${derivados.map(([k, val]) => `${k}=${val}`).join(", ")}`);
  }

  const ev = await ejecutar<EvidenciaData>("generar_evidencia", { caso });
  if (ev.ok) {
    linea("3. generar_evidencia", `${ev.data.ruta} · sha256 ${ev.data.sha256.slice(0, 16)}…`);
  } else {
    console.log(`  3. generar_evidencia  → ${ev.error}`);
  }

  let payload: PayloadData | null = null;
  if (v.apta) {
    const pay = await ejecutar<PayloadData>("construir_payload", {
      caso,
      paquete: paq.data,
      derivados: v.derivados,
    });
    if (!pay.ok) return fallo("oc_construir_payload", pay.error);
    linea("4. construir_payload", `${pay.data.ruta_trazabilidad} · ${pay.data.orden.excepciones.length} excepción(es)`);
    payload = pay.data;
  } else {
    linea("4. construir_payload", "no se construye: el caso no está apto (bloqueos de control)");
  }

  let creacion = await ejecutar<CrearData>("crear", { caso, payload: payload?.orden });
  if (creacion.ok) {
    linea("5. crear", `OC ${creacion.data.numero_oc} (idempotente=${creacion.data.idempotente})`);
    return;
  }

  linea("5. crear", `sin crear → ${creacion.error}`);

  // Segunda pasada con confirmación explícita del usuario (CA3 / HU-5).
  if (v.confirmaciones.length > 0) {
    const frase = CONFIRMACIONES[caso] ?? "confirmo";
    console.log(`     ⟳ turno del usuario: "${frase}"`);
    creacion = await ejecutar<CrearData>("crear", { caso, payload: payload?.orden, confirmado: true });
    if (!creacion.ok) return fallo("oc_crear (confirmado)", creacion.error);
    linea(
      "6. crear (confirmado)",
      `OC ${creacion.data.numero_oc} · idempotente=${creacion.data.idempotente} · retroactiva=${creacion.data.retroactiva}`,
    );
  }
}

async function main(): Promise<void> {
  const inicio = Date.now();
  console.log("Reto 03 — demo de herramientas SIN modelo de lenguaje");
  console.log(`Proyecto: ${raiz}`);
  limpiarOut(raiz, ["sesiones"]);

  if (!herramientasCompletas()) fallo("contrato", "alguna herramienta no cumple { description, args, execute }");
  linea("contrato", "5/5 herramientas cumplen { description, args(zod), execute }");

  const casos = ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"];
  for (const caso of casos) {
    await procesarCaso(caso);
    if (caso === "sol-001") {
      // Idempotencia: crear dos veces el mismo solicitud_id devuelve el mismo número.
      const otra = await ejecutar<CrearData>("crear", { caso });
      if (!otra.ok) return fallo("oc_crear (idempotencia)", otra.error);
      linea(
        "7. crear (2ª vez)",
        `OC ${otra.data.numero_oc} · idempotente=${otra.data.idempotente} → no se duplica la orden`,
      );
    }
  }

  const control = readFileSync(join(raiz, "out", "control.csv"), "utf8").trim().split(/\r?\n/);
  console.log(`\n${"═".repeat(78)}\nout/control.csv (${control.length - 1} intentos registrados)`);
  for (const fila of control) console.log(`  ${fila}`);

  const log = readFileSync(join(raiz, "out", "log.jsonl"), "utf8").trim().split(/\r?\n/);
  console.log(`\nout/log.jsonl: ${log.length} llamadas a herramienta registradas (CA4)`);
  console.log(`\n✔ demo completada en ${((Date.now() - inicio) / 1000).toFixed(1)}s — sin usar clave de modelo.`);
}

await main();
