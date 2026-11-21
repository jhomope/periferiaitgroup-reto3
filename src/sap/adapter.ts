import type { OrdenCompra } from "../core/payload.ts";

/**
 * Interfaz del adaptador SAP (PRD 7.4).
 * `src/sap/mock.ts` la implementa sobre archivos en out/sap/; en producción
 * aquí viviría la llamada real (OData / BAPI / Integration Suite) — ver
 * la sección 7.5 del PRD y SOLUCION.md.
 */
export interface SapAdapter {
  consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null>;
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }>;
  buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null>;
}
