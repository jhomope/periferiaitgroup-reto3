import { z } from "zod";
import { contenidoEvidencia, sha256De } from "./evidencia.ts";
import type { Paquete, ResultadoValidacion } from "./tipos.ts";
import { ErrorLectura } from "./salida.ts";

/** Payload de la OC (PRD 7.4), validado con zod. */
export const esquemaOrdenCompra = z.object({
  referencia: z.object({
    solicitud_id: z.string(),
    correo_id: z.string(),
    cotizacion_ref: z.string().nullable(),
  }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({
    codigo_sap: z.string(),
    nit: z.string(),
    nombre: z.string(),
  }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string().describe("Código, ej. Z030"),
  aprobador: z.object({
    email: z.string(),
    fecha_aprobacion: z.string(),
    evidencia_sha256: z.string(),
  }),
  posiciones: z
    .array(
      z.object({
        numero: z.number(),
        descripcion: z.string().max(40, "SAP admite máximo 40 caracteres en texto breve"),
        cantidad: z.number(),
        unidad: z.enum(["UN", "H", "MES"]),
        precio_unitario: z.number(),
        centro_costo: z.string(),
        subarea: z.string(),
        indicador_iva: z.string(),
      }),
    )
    .min(1),
  excepciones: z.array(
    z.object({
      codigo: z.string(),
      detalle: z.string(),
      confirmado_por: z.string().nullable(),
    }),
  ),
});

export type OrdenCompra = z.infer<typeof esquemaOrdenCompra>;

export type TrazabilidadCampo = { valor: unknown; fuente: string };
export type Trazabilidad = Record<string, TrazabilidadCampo>;

/** Texto breve de SAP: máximo 40 caracteres. */
export function truncarSap(texto: string, max = 40): string {
  const limpio = texto.trim();
  return limpio.length <= max ? limpio : `${limpio.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Unidad de posición: "H" cuando la descripción es por horas, "MES" cuando es
 * por meses/suscripción y "UN" en el resto. (Supuesto documentado en SOLUCION.md.)
 */
export function unidadDe(descripcion: string): "UN" | "H" | "MES" {
  if (/\bhora(s)?\b/i.test(descripcion)) return "H";
  if (/\b(mes|meses|mensual|suscripci[oó]n)\b/i.test(descripcion)) return "MES";
  return "UN";
}

/**
 * Construye el payload de la OC trazando cada valor a su fuente
 * (solicitud | cotizacion | maestro.<nombre> | derivado | estatico).
 */
export function construirOrden(
  paquete: Paquete,
  validacion: ResultadoValidacion,
  confirmadoPor: string | null,
): { orden: OrdenCompra; trazabilidad: Trazabilidad } {
  const s = paquete.solicitud;
  const ap = paquete.aprobacion;
  if (!ap) throw new ErrorLectura("no hay correo de aprobación: no se puede construir el payload de la OC");

  const codigoSap = validacion.derivados["codigo_sap"];
  if (!codigoSap) throw new ErrorLectura("no se resolvió el código SAP del proveedor (fallo RC1)");

  const indicadorIva = s.indicador_iva ?? validacion.derivados["indicador_iva"];
  if (!indicadorIva) throw new ErrorLectura("no hay indicador de IVA disponible para la posición");

  const condicionesPago = s.condiciones_pago ?? validacion.derivados["condiciones_pago"];
  if (!condicionesPago) throw new ErrorLectura("no hay condiciones de pago disponibles para la OC");

  if (s.moneda !== "COP" && s.moneda !== "USD") {
    throw new ErrorLectura(`moneda no soportada por el adaptador SAP: "${s.moneda}" (se admite COP o USD)`);
  }

  const contenido = contenidoEvidencia(ap);
  const hash = sha256De(contenido);

  const orden: OrdenCompra = {
    referencia: {
      solicitud_id: s.solicitud_id,
      correo_id: paquete.correo?.id ?? "sin-correo",
      cotizacion_ref: paquete.cotizacion?.referencia ?? null,
    },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: {
      codigo_sap: codigoSap,
      nit: s.proveedor_nit ?? paquete.cotizacion?.nit ?? "",
      nombre: s.proveedor_nombre,
    },
    moneda: s.moneda,
    condiciones_pago: condicionesPago,
    aprobador: {
      email: ap.de,
      fecha_aprobacion: ap.fecha,
      evidencia_sha256: hash,
    },
    posiciones: [
      {
        numero: 10,
        descripcion: truncarSap(s.descripcion),
        cantidad: s.cantidad,
        unidad: unidadDe(s.descripcion),
        precio_unitario: s.valor_unitario,
        centro_costo: s.centro_costo,
        subarea: s.subarea,
        indicador_iva: indicadorIva,
      },
    ],
    excepciones: validacion.confirmaciones.map((c) => ({
      codigo: c.codigo,
      detalle: c.detalle,
      confirmado_por: confirmadoPor,
    })),
  };

  const trazabilidad: Trazabilidad = {
    "referencia.solicitud_id": { valor: s.solicitud_id, fuente: "solicitud" },
    "referencia.correo_id": { valor: paquete.correo?.id ?? null, fuente: "correo" },
    "referencia.cotizacion_ref": { valor: paquete.cotizacion?.referencia ?? null, fuente: "cotizacion" },
    sociedad: { valor: "1000", fuente: "estatico (sociedad de Periferia)" },
    organizacion_compras: { valor: "1000", fuente: "estatico (organización de compras)" },
    "proveedor.codigo_sap": { valor: codigoSap, fuente: "maestro.proveedores" },
    "proveedor.nit": { valor: orden.proveedor.nit, fuente: "solicitud.proveedor_nit" },
    "proveedor.nombre": { valor: s.proveedor_nombre, fuente: "solicitud.proveedor_nombre" },
    moneda: { valor: s.moneda, fuente: "solicitud.moneda" },
    condiciones_pago: {
      valor: condicionesPago,
      fuente: s.condiciones_pago ? "solicitud.condiciones_pago" : "maestro.proveedores (derivado)",
    },
    "aprobador.email": { valor: ap.de, fuente: "aprobacion" },
    "aprobador.fecha_aprobacion": { valor: ap.fecha, fuente: "aprobacion" },
    "aprobador.evidencia_sha256": { valor: hash, fuente: "sha256 de out/<caso>/aprobacion.txt" },
    "posiciones[0].numero": { valor: 10, fuente: "estatico (primera posición)" },
    "posiciones[0].descripcion": {
      valor: orden.posiciones[0]?.descripcion,
      fuente: "solicitud.descripcion (truncada a 40 caracteres)",
    },
    "posiciones[0].cantidad": { valor: s.cantidad, fuente: "solicitud.cantidad" },
    "posiciones[0].unidad": {
      valor: orden.posiciones[0]?.unidad,
      fuente: "derivado de solicitud.descripcion",
    },
    "posiciones[0].precio_unitario": { valor: s.valor_unitario, fuente: "solicitud.valor_unitario" },
    "posiciones[0].centro_costo": { valor: s.centro_costo, fuente: "solicitud.centro_costo" },
    "posiciones[0].subarea": { valor: s.subarea, fuente: "solicitud.subarea" },
    "posiciones[0].indicador_iva": {
      valor: indicadorIva,
      fuente: s.indicador_iva ? "solicitud.indicador_iva" : "maestro.proveedores (derivado)",
    },
    excepciones: {
      valor: orden.excepciones.map((e) => e.codigo),
      fuente: "reglas de control con confirmación pendiente",
    },
  };

  return { orden, trazabilidad };
}
