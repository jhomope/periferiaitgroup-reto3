import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { raizProyecto } from "./core/raiz.ts";

let cargado = false;

/**
 * Carga .env si existe (Bun ya lo hace solo; Node necesita este apoyo).
 * Las variables ya definidas en el entorno tienen prioridad: nunca se
 * sobreescribe una clave real con el archivo.
 */
export function cargarEnv(): void {
  if (cargado) return;
  cargado = true;
  const ruta = join(raizProyecto(), ".env");
  if (!existsSync(ruta)) return;
  for (const linea of readFileSync(ruta, "utf8").split(/\r?\n/)) {
    const m = linea.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || m[1] === undefined) continue;
    const clave = m[1];
    if (process.env[clave] !== undefined) continue;
    let valor = m[2] ?? "";
    if ((valor.startsWith('"') && valor.endsWith('"')) || (valor.startsWith("'") && valor.endsWith("'"))) {
      valor = valor.slice(1, -1);
    }
    process.env[clave] = valor;
  }
}

/** Devuelve la clave o undefined (sin imprimirla jamás). */
export function existeEnv(clave: string): string | undefined {
  cargarEnv();
  const valor = process.env[clave];
  return valor && valor.trim() !== "" ? valor : undefined;
}
