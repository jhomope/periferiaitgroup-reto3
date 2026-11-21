import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Raíz del proyecto (la carpeta que contiene package.json).
 * Se calcula desde la ubicación de este módulo para no depender del cwd.
 */
export function raizProyecto(): string {
  // src/core/raiz.ts → src/core → src → raíz del proyecto
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}
