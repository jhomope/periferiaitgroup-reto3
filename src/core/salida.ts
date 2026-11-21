import { existsSync, mkdirSync, readdirSync, rmSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Error de lectura/dominio: siempre se convierte en { ok: false, error }. */
export class ErrorLectura extends Error {
  override name = "ErrorLectura";
}

export type EntradaLog = {
  ts: string;
  herramienta: string;
  mensaje_id: string;
  ok: boolean;
  resumen: string;
};

export type FilaControl = {
  solicitud_id: string;
  resultado: "creada" | "idempotente" | "bloqueada" | "pendiente";
  numero_oc: string;
  retroactiva: boolean;
  bloqueos: string;
  confirmaciones: string;
  ts: string;
};

export const COLUMNAS_CONTROL: (keyof FilaControl)[] = [
  "solicitud_id",
  "resultado",
  "numero_oc",
  "retroactiva",
  "bloqueos",
  "confirmaciones",
  "ts",
];

export function dirOut(raiz: string): string {
  return join(raiz, "out");
}

export function dirCaso(raiz: string, caso: string): string {
  return join(dirOut(raiz), caso);
}

export function asegurarOut(raiz: string): string {
  const out = dirOut(raiz);
  mkdirSync(out, { recursive: true });
  return out;
}

/**
 * Limpia out/ al inicio de la demo para garantizar determinismo,
 * conservando las sesiones del chat si el servidor está corriendo.
 */
export function limpiarOut(raiz: string, conservar: string[] = []): void {
  const out = asegurarOut(raiz);
  for (const nombre of readdirSync(out)) {
    if (conservar.includes(nombre)) continue;
    rmSync(join(out, nombre), { recursive: true, force: true });
  }
}

export function asegurarCaso(raiz: string, caso: string): string {
  const ruta = dirCaso(raiz, caso);
  mkdirSync(ruta, { recursive: true });
  return ruta;
}

export function escribirJson(raiz: string, caso: string, archivo: string, valor: unknown): string {
  const dir = caso === "" ? asegurarOut(raiz) : asegurarCaso(raiz, caso);
  const ruta = join(dir, archivo);
  writeFileSync(ruta, `${JSON.stringify(valor, null, 2)}\n`, "utf8");
  return ruta;
}

/** RN7: toda ejecución deja su traza en out/log.jsonl. */
export function registrarLog(raiz: string, entrada: EntradaLog): void {
  asegurarOut(raiz);
  appendFileSync(join(dirOut(raiz), "log.jsonl"), `${JSON.stringify(entrada)}\n`, "utf8");
}

function escaparCsv(valor: string): string {
  return /[",\n]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor;
}

/** Cada intento de OC (creada, idempotente, bloqueada o pendiente) deja fila en out/control.csv. */
export function agregarControl(raiz: string, fila: FilaControl): string {
  const out = asegurarOut(raiz);
  const ruta = join(out, "control.csv");
  const existe = existsSync(ruta);
  const linea = COLUMNAS_CONTROL.map((col) => escaparCsv(String(fila[col]))).join(",");
  const contenido = existe ? `${linea}\n` : `${COLUMNAS_CONTROL.join(",")}\n${linea}\n`;
  appendFileSync(ruta, contenido, "utf8");
  return ruta;
}
