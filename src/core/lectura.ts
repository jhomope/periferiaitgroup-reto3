import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  esquemaAprobacion,
  esquemaCentroCosto,
  esquemaCondicionPago,
  esquemaCorreo,
  esquemaIndicadorIva,
  esquemaProveedor,
  esquemaSolicitud,
  type Aprobacion,
  type Correo,
  type Cotizacion,
  type Factura,
  type Maestros,
  type Paquete,
  type Solicitud,
} from "./tipos.ts";
import { ErrorLectura } from "./salida.ts";

const ADJUNTOS: Record<string, string> = {
  "solicitud.xlsx": "solicitud.json",
  "cotizacion.pdf": "cotizacion.txt",
  "aprobacion.eml": "aprobacion.json",
  "factura.pdf": "factura.txt",
};

function decodificar<T>(esquema: z.ZodType<T>, valor: unknown, contexto: string): T {
  const r = esquema.safeParse(valor);
  if (!r.success) {
    const detalle = r.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ");
    throw new ErrorLectura(`${contexto} inválido — ${detalle}`);
  }
  return r.data;
}

function leerJson(ruta: string): unknown {
  try {
    return JSON.parse(readFileSync(ruta, "utf8"));
  } catch (e) {
    throw new ErrorLectura(`no se pudo leer ${ruta}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function leerTexto(ruta: string): string | null {
  if (!existsSync(ruta)) return null;
  const texto = readFileSync(ruta, "utf8").trim();
  return texto.length > 0 ? texto : null;
}

/** Convierte importes como "11.400.000" o "1.700.000.50" en número. */
export function parsearImporte(bruto: string): number | null {
  const limpio = bruto.replace(/[^\d.,]/g, "");
  if (limpio === "") return null;
  if (/^\d{1,3}(\.\d{3})+$/.test(limpio)) return Number(limpio.replace(/\./g, ""));
  if (/^\d{1,3}(,\d{3})+$/.test(limpio)) return Number(limpio.replace(/,/g, ""));
  const n = Number(limpio.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function sumarDias(fecha: string, dias: number): string | null {
  const t = Date.parse(`${fecha}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return new Date(t + dias * 86_400_000).toISOString().slice(0, 10);
}

function linea(texto: string, prefijo: string): string | null {
  const re = new RegExp(`^${prefijo}\\s*(.+)$`, "im");
  const m = texto.match(re);
  return m?.[1]?.trim() ?? null;
}

export function parsearCotizacion(texto: string): Cotizacion {
  const primera = texto.split(/\r?\n/)[0]?.trim() ?? "";
  const referencia = primera.replace(/^cotizaci[oó]n\s*/i, "").trim() || null;
  const nit = linea(texto, "NIT:");
  const totalBruto = texto.match(/TOTAL[^:]*:\s*[A-Z]{3}\s*([\d.,]+)/i)?.[1] ?? null;
  const moneda = texto.match(/TOTAL[^:]*:\s*([A-Z]{3})/i)?.[1] ?? "COP";
  const fecha = linea(texto, "Fecha:");
  const dias = Number(texto.match(/Validez de la oferta:\s*(\d+)/i)?.[1] ?? NaN);

  return {
    referencia,
    proveedor: linea(texto, "Proveedor:") ?? "",
    nit: nit ? nit.replace(/[^\dXx]/g, "") : null,
    total: totalBruto ? (parsearImporte(totalBruto) ?? 0) : 0,
    moneda,
    validez_hasta: fecha && Number.isFinite(dias) ? sumarDias(fecha, dias) : null,
    texto,
  };
}

export function parsearFactura(texto: string): Factura {
  const numero =
    texto.match(/No\.\s*([A-Za-z0-9-]+)/)?.[1] ??
    texto.match(/FACTURA[^:]*No\.?\s*([A-Za-z0-9-]+)/i)?.[1] ??
    "S/N";
  const fecha = texto.match(/Fecha de emisi[oó]n:\s*([\d-]+)/i)?.[1] ?? "";
  const totalBruto = texto.match(/TOTAL:\s*[A-Z]{3}\s*([\d.,]+)/i)?.[1] ?? "0";
  return { numero, fecha, total: parsearImporte(totalBruto) ?? 0 };
}

export function rutaCaso(raiz: string, caso: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(caso)) {
    throw new ErrorLectura(`nombre de caso inválido: "${caso}"`);
  }
  const ruta = join(raiz, "fixtures", "reto-03", "solicitudes", caso);
  if (!existsSync(ruta)) {
    throw new ErrorLectura(`caso inexistente: "${caso}" (esperado en fixtures/reto-03/solicitudes/)`);
  }
  return ruta;
}

/**
 * HU-1: devuelve el paquete normalizado. Un adjunto ausente queda como `null`
 * y su nombre aparece en `faltantes`; nunca lanza excepción por eso.
 */
export function leerPaquete(raiz: string, caso: string): Paquete {
  const dir = rutaCaso(raiz, caso);
  const faltantes: string[] = [];

  let correo: Correo | null = null;
  const rutaCorreo = join(dir, "correo.json");
  if (existsSync(rutaCorreo)) {
    correo = decodificar(esquemaCorreo, leerJson(rutaCorreo), `${caso}/correo.json`);
  } else {
    faltantes.push("correo.json");
  }

  const rutaSolicitud = join(dir, "solicitud.json");
  if (!existsSync(rutaSolicitud)) {
    throw new ErrorLectura(`falta solicitud.json en el caso ${caso}: sin solicitud no hay paquete`);
  }
  const solicitud: Solicitud = decodificar(esquemaSolicitud, leerJson(rutaSolicitud), `${caso}/solicitud.json`);

  const rutaCotizacion = join(dir, "cotizacion.txt");
  const textoCotizacion = leerTexto(rutaCotizacion);
  const cotizacion = textoCotizacion ? parsearCotizacion(textoCotizacion) : null;

  const rutaAprobacion = join(dir, "aprobacion.json");
  let aprobacion: Aprobacion | null = null;
  if (existsSync(rutaAprobacion)) {
    const base = decodificar(esquemaAprobacion, leerJson(rutaAprobacion), `${caso}/aprobacion.json`);
    aprobacion = { ...base, aprobado: /\baprobado\b/i.test(base.cuerpo) };
  }

  const rutaFactura = join(dir, "factura.txt");
  const textoFactura = leerTexto(rutaFactura);
  const factura = textoFactura ? parsearFactura(textoFactura) : null;

  // Adjuntos declarados en el correo que no tienen archivo correspondiente.
  for (const adjunto of correo?.adjuntos ?? []) {
    const esperado = ADJUNTOS[adjunto];
    if (esperado && !existsSync(join(dir, esperado))) faltantes.push(adjunto);
  }
  if (!cotizacion && !(correo?.adjuntos ?? []).includes("cotizacion.pdf")) faltantes.push("cotizacion.txt");
  if (!aprobacion && !(correo?.adjuntos ?? []).includes("aprobacion.eml")) faltantes.push("aprobacion.json");

  return { caso, correo, solicitud, cotizacion, aprobacion, factura, faltantes };
}

export function leerMaestros(raiz: string): Maestros {
  const dir = join(raiz, "fixtures", "reto-03", "maestros");
  const leer = <T>(archivo: string, esquema: z.ZodType<T>): T => {
    const ruta = join(dir, archivo);
    if (!existsSync(ruta)) throw new ErrorLectura(`falta el maestro ${archivo}`);
    return decodificar(esquema, leerJson(ruta), `maestros/${archivo}`);
  };
  return {
    proveedores: leer("proveedores.json", z.array(esquemaProveedor)),
    centros: leer("centros-costo.json", z.array(esquemaCentroCosto)),
    indicadores: leer("indicadores-iva.json", z.array(esquemaIndicadorIva)),
    condiciones: leer("condiciones-pago.json", z.array(esquemaCondicionPago)),
  };
}
