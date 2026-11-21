/**
 * Interfaz propia del proveedor LLM (PRD 6.1): `enviar(mensajes, herramientas) → respuesta`.
 * Cambiar de proveedor no toca el ciclo del agente.
 */

export type LlamadaHerramienta = {
  id: string;
  nombre: string;
  argumentos: unknown;
};

export type MensajeChat =
  | { rol: "usuario"; texto: string }
  | { rol: "asistente"; texto: string; llamadas: LlamadaHerramienta[] }
  | { rol: "herramienta"; llamadaId: string; nombre: string; texto: string };

export type HerramientaLlm = {
  nombre: string;
  descripcion: string;
  esquema: Record<string, unknown>;
};

export type RespuestaLlm = {
  texto: string;
  llamadas: LlamadaHerramienta[];
};

export type PeticionLlm = {
  sistema: string;
  mensajes: MensajeChat[];
  herramientas: HerramientaLlm[];
};

export interface AdaptadorLlm {
  readonly proveedor: string;
  readonly modelo: string;
  enviar(peticion: PeticionLlm): Promise<RespuestaLlm>;
}

/** Error del proveedor: siempre se muestra en lenguaje claro en el chat (CA5). */
export class ErrorLlm extends Error {
  override name = "ErrorLlm";
  readonly estado: number | undefined;

  constructor(mensaje: string, estado?: number) {
    super(mensaje);
    this.estado = estado;
  }
}

export async function pedirJson(url: string, init: RequestInit, timeoutMs: number, contexto: string): Promise<unknown> {
  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), timeoutMs);
  try {
    const respuesta = await fetch(url, { ...init, signal: control.signal });
    const cuerpo = (await respuesta.json().catch(() => ({}))) as Record<string, unknown>;
    if (!respuesta.ok) {
      const detalle =
        (cuerpo["error"] as { message?: string } | undefined)?.message ??
        (cuerpo["message"] as string | undefined) ??
        `HTTP ${respuesta.status}`;
      throw new ErrorLlm(`${contexto}: ${detalle}`, respuesta.status);
    }
    return cuerpo;
  } catch (e) {
    if (e instanceof ErrorLlm) throw e;
    if (e instanceof Error && e.name === "AbortError") {
      throw new ErrorLlm(`${contexto}: sin respuesta del proveedor tras ${timeoutMs} ms. Reintenta.`);
    }
    throw new ErrorLlm(`${contexto}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(reloj);
  }
}
