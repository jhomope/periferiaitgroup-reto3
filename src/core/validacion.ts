import { leerMaestros } from "./lectura.ts";
import type { ConfirmacionControl, Paquete, ProveedorMaestro, ResultadoValidacion } from "./tipos.ts";

function soloDigitos(valor: string): string {
  return valor.replace(/\D/g, "");
}

function nombreNormalizado(valor: string): string {
  return valor
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buscarProveedor(proveedores: ProveedorMaestro[], nit: string | undefined, nombre: string): ProveedorMaestro | null {
  if (nit) {
    const objetivo = soloDigitos(nit);
    const porNit = proveedores.find((p) => soloDigitos(p.nit) === objetivo);
    if (porNit) return porNit;
  }
  return proveedores.find((p) => nombreNormalizado(p.nombre) === nombreNormalizado(nombre)) ?? null;
}

/**
 * Reglas de control RC1–RC10 (PRD 7.3).
 * Devuelve `apta`, `bloqueos`, `confirmaciones`, `derivados` y `retroactiva`.
 * Nunca lanza: las ausencias se traducen en bloqueos o confirmaciones.
 */
export function validarPaquete(raiz: string, paquete: Paquete): ResultadoValidacion {
  const m = leerMaestros(raiz);
  const s = paquete.solicitud;
  const bloqueos: string[] = [];
  const confirmaciones: ConfirmacionControl[] = [];
  const derivados: Record<string, string> = {};

  // RC1 — proveedor existente y activo en el maestro.
  const proveedor = buscarProveedor(m.proveedores, s.proveedor_nit, s.proveedor_nombre);
  if (!proveedor) {
    const ident = s.proveedor_nit ? `NIT ${s.proveedor_nit}` : "sin NIT en la solicitud";
    bloqueos.push(`RC1: el proveedor "${s.proveedor_nombre}" (${ident}) no existe en el maestro de proveedores`);
  } else if (!proveedor.activo) {
    bloqueos.push(`RC1: el proveedor "${proveedor.nombre}" está inactivo en SAP`);
  } else {
    derivados["codigo_sap"] = proveedor.codigo_sap;
  }

  // RC4 — la subárea debe pertenecer al centro de costo.
  const centro = m.centros.find((c) => c.centro_costo === s.centro_costo);
  if (!centro) {
    bloqueos.push(`RC4: el centro de costo ${s.centro_costo} no existe en el maestro`);
  } else if (!centro.subareas.includes(s.subarea)) {
    bloqueos.push(`RC4: la subárea "${s.subarea}" no pertenece al centro de costo ${s.centro_costo}`);
  }

  // RC2 — la aprobación debe existir, decir "Aprobado" y venir de un aprobador del centro.
  const ap = paquete.aprobacion;
  let aprobador: { email: string; nombre: string; tope: number } | null = null;
  if (!ap) {
    bloqueos.push("RC2: falta la evidencia de aprobación del líder (correo de aprobación)");
  } else {
    if (!ap.aprobado) {
      bloqueos.push(`RC2: el correo de aprobación de ${ap.de} no contiene la palabra "Aprobado"`);
    }
    if (centro) {
      aprobador = centro.aprobadores.find((a) => a.email.toLowerCase() === ap.de.toLowerCase()) ?? null;
      if (!aprobador) {
        bloqueos.push(`RC2: ${ap.de} no es aprobador autorizado del centro ${s.centro_costo}`);
      }
    }
  }

  // RC3 — el valor no puede superar el tope del aprobador en ese centro.
  if (aprobador && s.valor_total > aprobador.tope) {
    bloqueos.push(
      `RC3: el valor ${s.valor_total} supera el tope de ${aprobador.tope} del aprobador ${aprobador.nombre}`,
    );
  }

  // RC10 — cantidad × valor_unitario debe cuadrar con valor_total (±1 unidad monetaria).
  const calculado = s.cantidad * s.valor_unitario;
  if (Math.abs(calculado - s.valor_total) > 1) {
    bloqueos.push(`RC10: cantidad × valor_unitario = ${calculado} no coincide con valor_total = ${s.valor_total}`);
  }

  // RC5 — la cotización debe cuadrar con la solicitud (≤ 2%); si no existe, se pide confirmación.
  const cot = paquete.cotizacion;
  if (!cot) {
    confirmaciones.push({ codigo: "RC5", detalle: "No hay cotización adjunta: confirma que la OC procede sin ella" });
  } else if (s.valor_total !== 0) {
    const diferencia = Math.abs(cot.total - s.valor_total) / s.valor_total;
    if (diferencia > 0.02) {
      confirmaciones.push({
        codigo: "RC5",
        detalle: `La cotización (${cot.total}) difiere ${(diferencia * 100).toFixed(1)}% del valor de la solicitud (${s.valor_total})`,
      });
    }
  }

  // RC6 — indicador de IVA: si falta se deriva del proveedor y se confirma.
  if (!s.indicador_iva) {
    if (proveedor) {
      derivados["indicador_iva"] = proveedor.indicador_iva_default;
      confirmaciones.push({
        codigo: "RC6",
        detalle: `La solicitud no informa indicador de IVA; se deriva ${proveedor.indicador_iva_default} del maestro del proveedor. Confirma para continuar`,
      });
    } else {
      bloqueos.push("RC6: no hay indicador de IVA en la solicitud ni proveedor del cual derivarlo");
    }
  } else if (!m.indicadores.some((i) => i.codigo === s.indicador_iva)) {
    bloqueos.push(`RC6: el indicador de IVA "${s.indicador_iva}" no existe en el maestro`);
  }

  // RC7 — condiciones de pago: si faltan se derivan del proveedor (solo se informa).
  if (!s.condiciones_pago) {
    if (proveedor) {
      derivados["condiciones_pago"] = proveedor.condiciones_pago_default;
    } else {
      bloqueos.push("RC7: no hay condiciones de pago en la solicitud ni proveedor del cual derivarlas");
    }
  } else if (!m.condiciones.some((c) => c.codigo === s.condiciones_pago)) {
    bloqueos.push(`RC7: la condición de pago "${s.condiciones_pago}" no existe en el maestro`);
  }

  // RC8 — factura anterior a la solicitud = compra retroactiva.
  let retroactiva = false;
  const factura = paquete.factura;
  if (factura && factura.fecha && factura.fecha < s.fecha_solicitud) {
    retroactiva = true;
    confirmaciones.push({
      codigo: "RC8",
      detalle: `Factura ${factura.numero} con fecha ${factura.fecha} anterior a la solicitud ${s.fecha_solicitud}: es una compra retroactiva. Confirma para crear la OC`,
    });
  }

  // RC9 — la aprobación no puede ser anterior a la solicitud.
  if (ap && ap.fecha.slice(0, 10) < s.fecha_solicitud) {
    confirmaciones.push({
      codigo: "RC9",
      detalle: `La aprobación (${ap.fecha.slice(0, 10)}) es anterior a la fecha de solicitud (${s.fecha_solicitud})`,
    });
  }

  return { apta: bloqueos.length === 0, bloqueos, confirmaciones, derivados, retroactiva };
}
