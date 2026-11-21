import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dirOut } from "./core/salida.ts";
import type { MensajeChat } from "./llm/adapter.ts";

export type PendienteConfirmacion = {
  caso: string;
  confirmaciones: { codigo: string; detalle: string }[];
};

export type Sesion = {
  id: string;
  historial: MensajeChat[];
  pendiente: PendienteConfirmacion | null;
  tokensEstimados: number;
  creada: string;
  actualizada: string;
};

/** Persistencia de sesiones en out/sesiones/<id>.json (sin base de datos). */
export class RepositorioSesiones {
  private mapa = new Map<string, Sesion>();
  private dir: string;
  private maxTokens: number;

  constructor(raiz: string, maxTokens: number) {
    this.dir = join(dirOut(raiz), "sesiones");
    mkdirSync(this.dir, { recursive: true });
    this.maxTokens = maxTokens;
  }

  obtener(id: string): Sesion {
    const existente = this.mapa.get(id) ?? this.cargar(id);
    if (existente) return existente;
    const ahora = new Date().toISOString();
    const nueva: Sesion = { id, historial: [], pendiente: null, tokensEstimados: 0, creada: ahora, actualizada: ahora };
    this.mapa.set(id, nueva);
    return nueva;
  }

  historial(id: string): Sesion {
    return this.obtener(id);
  }

  private cargar(id: string): Sesion | null {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
    try {
      const ruta = join(this.dir, `${id}.json`);
      return JSON.parse(readFileSync(ruta, "utf8")) as Sesion;
    } catch {
      return null;
    }
  }

  guardar(sesion: Sesion): void {
    sesion.actualizada = new Date().toISOString();
    this.mapa.set(sesion.id, sesion);
    if (sesion.historial.length === 0) return;
    try {
      writeFileSync(join(this.dir, `${sesion.id}.json`), `${JSON.stringify(sesion, null, 2)}\n`, "utf8");
    } catch {
      // La persistencia es best-effort: la sesión sigue viva en memoria.
    }
  }

  /** Tope de tokens por sesión (requisito de costo del PRD 8). */
  agotada(sesion: Sesion): boolean {
    return sesion.tokensEstimados > this.maxTokens;
  }
}

/** Estimación barata de tokens: ~4 caracteres por token. */
export function estimarTokens(texto: string): number {
  return Math.ceil(texto.length / 4);
}
