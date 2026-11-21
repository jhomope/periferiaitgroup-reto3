import { createHash } from "node:crypto";
import type { Aprobacion } from "./tipos.ts";

/**
 * Evidencia de aprobación (HU-4).
 * P0: out/<caso>/aprobacion.txt con encabezados, cuerpo y sha256.
 * P1: out/<caso>/aprobacion.pdf con el mismo contenido.
 *
 * El hash se calcula sobre los encabezados + cuerpo (el contenido propiamente
 * dicho), de modo que el `evidencia_sha256` del payload de la OC y el valor
 * escrito en el archivo son idénticos.
 */

export function contenidoEvidencia(ap: Aprobacion): string {
  return [`DE: ${ap.de}`, `PARA: ${ap.para}`, `FECHA: ${ap.fecha}`, `ASUNTO: ${ap.asunto}`, "", ap.cuerpo, ""].join(
    "\n",
  );
}

export function sha256De(texto: string): string {
  return createHash("sha256").update(texto, "utf8").digest("hex");
}

export function archivoEvidencia(contenido: string, hash: string): string {
  return `${contenido}---\nsha256: ${hash}\n`;
}

export function lineasPdf(texto: string, ancho = 92): string[] {
  const lineas: string[] = [];
  for (const original of texto.split(/\r?\n/)) {
    if (original.length <= ancho) {
      lineas.push(original);
      continue;
    }
    let resto = original;
    while (resto.length > ancho) {
      let corte = resto.lastIndexOf(" ", ancho);
      if (corte < ancho / 2) corte = ancho;
      lineas.push(resto.slice(0, corte));
      resto = resto.slice(corte).trimStart();
    }
    lineas.push(resto);
  }
  return lineas;
}
