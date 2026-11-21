import { z } from "zod";

/**
 * Tipos de dominio del reto 03 — Órdenes de Compra en SAP.
 * Los esquemas zod son a la vez documentación y validación de los fixtures.
 */

export const esquemaSolicitud = z.object({
  solicitud_id: z.string().describe("Identificador de la solicitud, ej. SOL-2026-001"),
  solicitante: z.string().describe("Persona que pide la compra"),
  proveedor_nombre: z.string(),
  proveedor_nit: z.string().optional().describe("NIT del proveedor sin puntos ni dígito de verificación"),
  descripcion: z.string(),
  centro_costo: z.string().describe("Código del centro de costo, ej. CC-1010"),
  subarea: z.string(),
  cantidad: z.number(),
  valor_unitario: z.number(),
  valor_total: z.number(),
  moneda: z.string(),
  indicador_iva: z.string().optional().describe("Código del maestro de indicadores de IVA, ej. C1"),
  condiciones_pago: z.string().optional().describe("Código del maestro de condiciones de pago, ej. Z030"),
  fecha_solicitud: z.string().describe("YYYY-MM-DD"),
});

export type Solicitud = z.infer<typeof esquemaSolicitud>;

export const esquemaCorreo = z.object({
  id: z.string(),
  de: z.string(),
  para: z.string(),
  asunto: z.string(),
  fecha: z.string(),
  cuerpo: z.string(),
  adjuntos: z.array(z.string()),
});

export type Correo = z.infer<typeof esquemaCorreo>;

export const esquemaAprobacion = z.object({
  de: z.string(),
  para: z.string(),
  cc: z.array(z.string()).optional(),
  fecha: z.string(),
  asunto: z.string(),
  cuerpo: z.string(),
});

export type AprobacionBase = z.infer<typeof esquemaAprobacion>;

/** Aprobación normalizada: se agrega el flag `aprobado` derivado del cuerpo. */
export type Aprobacion = AprobacionBase & { aprobado: boolean };

export type Cotizacion = {
  referencia: string | null;
  proveedor: string;
  nit: string | null;
  total: number;
  moneda: string;
  validez_hasta: string | null;
  texto: string;
};

export type Factura = { numero: string; fecha: string; total: number };

/**
 * Paquete normalizado (PRD 7.2). Se agregan `caso` y `faltantes` porque la
 * HU-1 exige reportar el nombre de cada adjunto ausente.
 */
export type Paquete = {
  caso: string;
  correo: Correo | null;
  solicitud: Solicitud;
  cotizacion: Cotizacion | null;
  aprobacion: Aprobacion | null;
  factura: Factura | null;
  faltantes: string[];
};

// --- Maestros ---------------------------------------------------------------

export const esquemaProveedor = z.object({
  codigo_sap: z.string(),
  nit: z.string(),
  nombre: z.string(),
  condiciones_pago_default: z.string(),
  indicador_iva_default: z.string(),
  activo: z.boolean(),
});
export type ProveedorMaestro = z.infer<typeof esquemaProveedor>;

export const esquemaAprobador = z.object({
  email: z.string(),
  nombre: z.string(),
  tope: z.number().describe("Monto máximo que este aprobador puede autorizar en este centro"),
});
export type Aprobador = z.infer<typeof esquemaAprobador>;

export const esquemaCentroCosto = z.object({
  centro_costo: z.string(),
  nombre: z.string(),
  subareas: z.array(z.string()),
  aprobadores: z.array(esquemaAprobador),
});
export type CentroCosto = z.infer<typeof esquemaCentroCosto>;

export const esquemaIndicadorIva = z.object({
  codigo: z.string(),
  descripcion: z.string(),
  tasa: z.number(),
});
export type IndicadorIva = z.infer<typeof esquemaIndicadorIva>;

export const esquemaCondicionPago = z.object({
  codigo: z.string(),
  descripcion: z.string(),
  dias: z.number(),
});
export type CondicionPago = z.infer<typeof esquemaCondicionPago>;

export type Maestros = {
  proveedores: ProveedorMaestro[];
  centros: CentroCosto[];
  indicadores: IndicadorIva[];
  condiciones: CondicionPago[];
};

// --- Resultados -------------------------------------------------------------

export type ConfirmacionControl = {
  codigo: string;
  detalle: string;
};

export type ResultadoValidacion = {
  apta: boolean;
  bloqueos: string[];
  confirmaciones: ConfirmacionControl[];
  derivados: Record<string, string>;
  retroactiva: boolean;
};
