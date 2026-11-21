import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  archivoEvidencia,
  contenidoEvidencia,
  lineasPdf,
  sha256De,
} from "../../src/core/evidencia.ts";
import { leerPaquete } from "../../src/core/lectura.ts";
import { construirOrden, esquemaOrdenCompra, type OrdenCompra } from "../../src/core/payload.ts";
import { ErrorLectura, agregarControl, asegurarCaso, registrarLog } from "../../src/core/salida.ts";
import type { Paquete, ResultadoValidacion } from "../../src/core/tipos.ts";
import { validarPaquete } from "../../src/core/validacion.ts";
import { crearSapMock } from "../../src/sap/mock.ts";

/**
 * Herramientas del reto 03 (PRD 6.2).
 * Cada export es una herramienta: el modelo la ve como `oc_<export>`.
 * Contrato: { description, args (zod), execute(args, ctx) → JSON string }.
 * `execute` NUNCA lanza: siempre devuelve { ok: true, data } o { ok: false, error }.
 */

export type Ctx = { directory: string; sessionId: string };

type Resumen = { data: unknown; resumen: string };

function hoy(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Envuelve el cuerpo de una herramienta: convierte excepciones en { ok: false } y registra en out/log.jsonl (CA5/RN7). */
async function envolver(
  herramienta: string,
  caso: string,
  ctx: Ctx,
  cuerpo: () => Resumen | Promise<Resumen>,
): Promise<string> {
  try {
    const { data, resumen } = await cuerpo();
    registrarLog(ctx.directory, {
      ts: new Date().toISOString(),
      herramienta,
      mensaje_id: caso,
      ok: true,
      resumen,
    });
    return JSON.stringify({ ok: true, data });
  } catch (e) {
    const mensaje = e instanceof Error ? e.message : String(e);
    registrarLog(ctx.directory, {
      ts: new Date().toISOString(),
      herramienta,
      mensaje_id: caso,
      ok: false,
      resumen: mensaje,
    });
    return JSON.stringify({ ok: false, error: mensaje });
  }
}

function guardar(raiz: string, caso: string, archivo: string, valor: unknown): string {
  const dir = asegurarCaso(raiz, caso);
  const ruta = join(dir, archivo);
  writeFileSync(ruta, `${JSON.stringify(valor, null, 2)}\n`, "utf8");
  return ruta;
}

function resumenValidacion(v: ResultadoValidacion): string {
  return `${v.bloqueos.length} bloqueo(s), ${v.confirmaciones.length} confirmación(es), retroactiva=${v.retroactiva}`;
}

const argCaso = z
  .string()
  .describe("Carpeta del caso dentro de fixtures/reto-03/solicitudes/, por ejemplo sol-001");

const argPaquete = z
  .unknown()
  .optional()
  .describe("Paquete devuelto por oc_leer_paquete. Es informativo: la herramienta relee el caso desde disco (CA2)");

const argDerivados = z
  .record(z.string(), z.string())
  .optional()
  .describe("Derivados devueltos por oc_validar. Es informativo: la herramienta los recalcula desde disco");

// ---------------------------------------------------------------------------

export const leer_paquete = {
  description:
    "Lee el paquete de una solicitud (correo, solicitud, cotización, aprobación y factura) desde fixtures/reto-03/solicitudes/<caso> y lo devuelve normalizado, listando los adjuntos que falten.",
  args: { caso: argCaso },
  async execute(args: { caso: string }, ctx: Ctx): Promise<string> {
    return envolver("oc_leer_paquete", args.caso, ctx, () => {
      const paquete = leerPaquete(ctx.directory, args.caso);
      guardar(ctx.directory, args.caso, "paquete.json", paquete);
      const faltantes = paquete.faltantes.length > 0 ? paquete.faltantes.join(", ") : "ninguno";
      return { data: paquete, resumen: `paquete leído; faltantes: ${faltantes}` };
    });
  },
};

export const validar = {
  description:
    "Aplica las reglas de control RC1–RC10 al paquete del caso y devuelve apta, bloqueos, confirmaciones pendientes, valores derivados de los maestros y si es una compra retroactiva.",
  args: { caso: argCaso, paquete: argPaquete },
  async execute(args: { caso: string; paquete?: unknown }, ctx: Ctx): Promise<string> {
    return envolver("oc_validar", args.caso, ctx, () => {
      const paquete = leerPaquete(ctx.directory, args.caso);
      const resultado = validarPaquete(ctx.directory, paquete);
      guardar(ctx.directory, args.caso, "validacion.json", resultado);
      return { data: resultado, resumen: resumenValidacion(resultado) };
    });
  },
};

export const construir_payload = {
  description:
    "Construye el payload exacto de la orden de compra en SAP a partir del paquete y sus derivados, y escribe out/<caso>/trazabilidad.json con la fuente de cada valor.",
  args: { caso: argCaso, paquete: argPaquete, derivados: argDerivados },
  async execute(
    args: { caso: string; paquete?: unknown; derivados?: Record<string, string> },
    ctx: Ctx,
  ): Promise<string> {
    return envolver("oc_construir_payload", args.caso, ctx, () => {
      const paquete = leerPaquete(ctx.directory, args.caso);
      const validacion = validarPaquete(ctx.directory, paquete);
      const { orden, trazabilidad } = construirOrden(paquete, validacion, null);
      const rutaTrazabilidad = guardar(ctx.directory, args.caso, "trazabilidad.json", trazabilidad);
      guardar(ctx.directory, args.caso, "payload.json", orden);
      return {
        data: { orden, ruta_trazabilidad: rutaTrazabilidad.replace(/\\/g, "/") },
        resumen: `payload armado: OC ${orden.proveedor.codigo_sap} ${orden.moneda} ${orden.posiciones[0]?.precio_unitario ?? 0} × ${orden.posiciones[0]?.cantidad ?? 0}; ${orden.excepciones.length} excepción(es)`,
      };
    });
  },
};

export const generar_evidencia = {
  description:
    "Genera la evidencia de aprobación del líder en out/<caso>/aprobacion.txt (encabezados, cuerpo y sha256) y su versión PDF, y devuelve la ruta con el hash.",
  args: { caso: argCaso },
  async execute(args: { caso: string }, ctx: Ctx): Promise<string> {
    return envolver("oc_generar_evidencia", args.caso, ctx, async () => {
      const paquete = leerPaquete(ctx.directory, args.caso);
      const ap = paquete.aprobacion;
      if (!ap) {
        throw new ErrorLectura("no hay correo de aprobación en el caso: no existe evidencia que generar");
      }
      const dir = asegurarCaso(ctx.directory, args.caso);
      const contenido = contenidoEvidencia(ap);
      const hash = sha256De(contenido);
      const rutaTxt = join(dir, "aprobacion.txt");
      writeFileSync(rutaTxt, archivoEvidencia(contenido, hash), "utf8");
      const rutaPdf = await escribirPdf(join(dir, "aprobacion.pdf"), contenido, hash);
      return {
        data: { ruta: rutaTxt.replace(/\\/g, "/"), ruta_pdf: rutaPdf.replace(/\\/g, "/"), sha256: hash },
        resumen: `evidencia generada; sha256 ${hash.slice(0, 16)}…`,
      };
    });
  },
};

export const crear = {
  description:
    "Crea la orden de compra en el SAP simulado. Solo crea si la solicitud está apta y no tiene confirmaciones pendientes, o si el usuario confirmó explícitamente (confirmado: true). Es idempotente por solicitud_id.",
  args: {
    caso: argCaso,
    payload: z
      .unknown()
      .optional()
      .describe("Payload devuelto por oc_construir_payload. Es opcional: si no llega, se reconstruye desde disco"),
    confirmado: z
      .boolean()
      .optional()
      .describe("Debe ser true únicamente cuando el usuario confirmó explícitamente en el turno anterior"),
  },
  async execute(args: { caso: string; payload?: unknown; confirmado?: boolean }, ctx: Ctx): Promise<string> {
    return envolver("oc_crear", args.caso, ctx, async () => {
      const paquete: Paquete = leerPaquete(ctx.directory, args.caso);
      const validacion = validarPaquete(ctx.directory, paquete);
      const solicitudId = paquete.solicitud.solicitud_id;
      const sap = crearSapMock(ctx.directory);
      const confirmado = args.confirmado === true;

      const registrar = (resultado: "creada" | "idempotente" | "bloqueada" | "pendiente", numero: string): void => {
        agregarControl(ctx.directory, {
          solicitud_id: solicitudId,
          resultado,
          numero_oc: numero,
          retroactiva: validacion.retroactiva,
          bloqueos: validacion.bloqueos.join("; "),
          confirmaciones: validacion.confirmaciones.map((c) => `${c.codigo}: ${c.detalle}`).join("; "),
          ts: new Date().toISOString(),
        });
      };

      // RC: sin apta no se crea nada (HU-5 / O2).
      if (!validacion.apta) {
        registrar("bloqueada", "");
        throw new ErrorLectura(`no se creó la OC: ${validacion.bloqueos.join(" | ")}`);
      }

      // Confirmaciones pendientes sin confirmación explícita (HU-5 / O3).
      if (validacion.confirmaciones.length > 0 && !confirmado) {
        const detalle = validacion.confirmaciones.map((c) => `${c.codigo}: ${c.detalle}`).join(" | ");
        registrar("pendiente", "");
        throw new ErrorLectura(`requiere confirmación antes de crear la OC — ${detalle}`);
      }

      // Idempotencia: dos veces el mismo solicitud_id devuelve el número existente.
      const existente = await sap.buscarOrdenPorReferencia(solicitudId);
      if (existente) {
        registrar("idempotente", existente.numero_oc);
        return {
          data: {
            numero_oc: existente.numero_oc,
            fecha: hoy(),
            idempotente: true,
            retroactiva: validacion.retroactiva,
          },
          resumen: `idempotente: ${solicitudId} ya es la OC ${existente.numero_oc}`,
        };
      }

      const orden = decidirPayload(ctx, paquete, validacion, confirmado ? ctx.sessionId : null, args.payload);
      const { numero_oc, fecha } = await sap.crearOrden(orden);
      registrar("creada", numero_oc);
      guardar(ctx.directory, args.caso, "oc-creada.json", { numero_oc, fecha, orden });
      return {
        data: { numero_oc, fecha, idempotente: false, retroactiva: validacion.retroactiva },
        resumen: `OC ${numero_oc} creada${validacion.retroactiva ? " (retroactiva, confirmada)" : ""}`,
      };
    });
  },
};

/**
 * Usa el payload recibido si es válido y corresponde al caso; si no llega,
 * lo reconstruye desde disco. El modelo nunca puede alterar los valores:
 * todo pasa por el esquema zod y el cruce con la solicitud original.
 */
function decidirPayload(
  ctx: Ctx,
  paquete: Paquete,
  validacion: ResultadoValidacion,
  confirmadoPor: string | null,
  recibido: unknown,
): OrdenCompra {
  if (recibido === undefined || recibido === null) {
    return construirOrden(paquete, validacion, confirmadoPor).orden;
  }
  const parsed = esquemaOrdenCompra.safeParse(recibido);
  if (!parsed.success) {
    const detalle = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ErrorLectura(`payload inválido — ${detalle}`);
  }
  const orden = parsed.data;
  const s = paquete.solicitud;
  if (orden.referencia.solicitud_id !== s.solicitud_id) {
    throw new ErrorLectura(
      `el payload corresponde a ${orden.referencia.solicitud_id} y no a ${s.solicitud_id} del caso ${paquete.caso}`,
    );
  }
  const total = orden.posiciones.reduce((suma, p) => suma + p.cantidad * p.precio_unitario, 0);
  if (Math.abs(total - s.valor_total) > 1) {
    throw new ErrorLectura(`el total del payload (${total}) no coincide con valor_total de la solicitud (${s.valor_total})`);
  }
  if (s.proveedor_nit && orden.proveedor.nit.replace(/\D/g, "") !== s.proveedor_nit.replace(/\D/g, "")) {
    throw new ErrorLectura(`el NIT del proveedor en el payload (${orden.proveedor.nit}) no corresponde a la solicitud`);
  }
  return { ...orden, excepciones: orden.excepciones.map((e) => ({ ...e, confirmado_por: e.confirmado_por ?? confirmadoPor })) };
}

/** P1: genera el PDF de la evidencia con pdf-lib. */
async function escribirPdf(ruta: string, contenido: string, hash: string): Promise<string> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const fuente = await doc.embedFont(StandardFonts.Helvetica);
  const lineas = lineasPdf(`${contenido}---\nsha256: ${hash}`);
  let page = doc.addPage([595, 842]);
  let y = 800;
  for (const linea of lineas) {
    if (y < 60) {
      page = doc.addPage([595, 842]);
      y = 800;
    }
    page.drawText(linea, { x: 50, y, size: 9, font: fuente });
    y -= 13;
  }
  const bytes = await doc.save();
  writeFileSync(ruta, bytes);
  return ruta;
}

export const herramientasOc = { leer_paquete, validar, construir_payload, generar_evidencia, crear };

/** Existe para que demo.ts y el servidor verifiquen que todos los exports siguen el contrato. */
export function herramientasCompletas(): boolean {
  return Object.values(herramientasOc).every(
    (h) => typeof h.description === "string" && typeof h.execute === "function" && typeof h.args === "object",
  );
}
