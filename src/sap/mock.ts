import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { leerMaestros } from "../core/lectura.ts";
import { dirOut } from "../core/salida.ts";
import type { OrdenCompra } from "../core/payload.ts";
import type { SapAdapter } from "./adapter.ts";

const PRIMER_NUMERO = 4_500_000_001;

type LineaOrden = {
  numero_oc: string;
  fecha: string;
  solicitud_id: string;
  orden: OrdenCompra;
};

function soloDigitos(valor: string): string {
  return valor.replace(/\D/g, "");
}

function hoy(): string {
  return new Date().toISOString().slice(0, 10);
}

function archivoOrdenes(raiz: string): string {
  return join(dirOut(raiz), "sap", "ordenes.jsonl");
}

function leerTodas(raiz: string): LineaOrden[] {
  const ruta = archivoOrdenes(raiz);
  if (!existsSync(ruta)) return [];
  return readFileSync(ruta, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as LineaOrden);
}

/**
 * Adaptador SAP simulado (PRD 7.4): escribe en out/sap/ordenes.jsonl,
 * asigna números secuenciales desde 4500000001 y es idempotente por
 * solicitud_id.
 */
export function crearSapMock(raiz: string): SapAdapter {
  return {
    async consultarProveedor(nit: string) {
      const objetivo = soloDigitos(nit);
      const proveedor = leerMaestros(raiz).proveedores.find((p) => soloDigitos(p.nit) === objetivo);
      if (!proveedor) return null;
      return { codigo_sap: proveedor.codigo_sap, activo: proveedor.activo };
    },

    async crearOrden(orden: OrdenCompra) {
      const ruta = archivoOrdenes(raiz);
      mkdirSync(join(dirOut(raiz), "sap"), { recursive: true });
      const existentes = leerTodas(raiz);
      const numero = String(PRIMER_NUMERO + existentes.length);
      const fecha = hoy();
      const linea: LineaOrden = { numero_oc: numero, fecha, solicitud_id: orden.referencia.solicitud_id, orden };
      appendFileSync(ruta, `${JSON.stringify(linea)}\n`, "utf8");
      return { numero_oc: numero, fecha };
    },

    async buscarOrdenPorReferencia(solicitud_id: string) {
      const encontrada = leerTodas(raiz).find((l) => l.solicitud_id === solicitud_id);
      return encontrada ? { numero_oc: encontrada.numero_oc } : null;
    },
  };
}
