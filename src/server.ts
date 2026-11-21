import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { cargarEnv } from "./env.ts";
import { raizProyecto } from "./core/raiz.ts";
import { ejecutarTurno, type HerramientaEjecutable } from "./ciclo.ts";
import { leerConfigLlm, crearAdaptador } from "./llm/index.ts";
import type { AdaptadorLlm } from "./llm/adapter.ts";
import { RepositorioSesiones } from "./sesiones.ts";
import { herramientasOc } from "./tools/oc.ts";

/**
 * Backend del reto 03: API del chat + ciclo del agente.
 *   POST /api/chat              { sessionId?, message } → { sessionId, reply, toolCalls[], needsConfirmation }
 *   GET  /api/sessions/:id      historial completo de la sesión
 *   GET  /api/health            { ok, provider, model, configured } sin exponer claves
 *   GET  /api/casos             casos disponibles en fixtures (extra)
 *   GET  /*                     front estático desde web/
 */

cargarEnv();

const raiz = raizProyecto();
const puerto = Number(process.env["PORT"] ?? 8787);
const maxIteraciones = Number(process.env["LLM_MAX_ITERACIONES"] ?? 25);
const maxTokensSesion = Number(process.env["LLM_MAX_TOKENS_SESION"] ?? 200_000);
const maxMensaje = 4_000;

function leer(archivo: string): string {
  const ruta = join(raiz, archivo);
  if (!existsSync(ruta)) throw new Error(`falta el archivo ${archivo}`);
  return readFileSync(ruta, "utf8");
}

/** Separación evaluada por el PRD: comportamiento + conocimiento componen el system prompt. */
const sistema = `${leer("agent/prompt.md")}\n\n---\n\n${leer("src/knowledge/ordenes-compra.md")}`;

const sesiones = new RepositorioSesiones(raiz, maxTokensSesion);
const herramientas = herramientasOc as unknown as Record<string, HerramientaEjecutable>;

let adaptadorCache: AdaptadorLlm | null = null;
function obtenerAdaptador(): AdaptadorLlm {
  if (!adaptadorCache) adaptadorCache = crearAdaptador();
  return adaptadorCache;
}

// --- HTTP -------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
};

function responder(res: ServerResponse, estado: number, cuerpo: unknown): void {
  const texto = JSON.stringify(cuerpo);
  res.writeHead(estado, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(texto);
}

async function leerCuerpo(req: IncomingMessage, maxBytes = 1_000_000): Promise<string> {
  const trozos: Buffer[] = [];
  let total = 0;
  for await (const trozo of req) {
    const buf = Buffer.isBuffer(trozo) ? trozo : Buffer.from(trozo as string);
    total += buf.length;
    if (total > maxBytes) throw new Error("cuerpo demasiado grande");
    trozos.push(buf);
  }
  return Buffer.concat(trozos).toString("utf8");
}

function servirEstatico(res: ServerResponse, rutaRelativa: string): void {
  const webDir = join(raiz, "web");
  const relativa = rutaRelativa === "/" || rutaRelativa === "" ? "index.html" : rutaRelativa.replace(/^\/+/, "");
  const destino = normalize(join(webDir, relativa));
  if (destino !== webDir && !destino.startsWith(webDir + sep)) {
    responder(res, 403, { error: "ruta no permitida" });
    return;
  }
  if (!existsSync(destino) || !statSync(destino).isFile()) {
    responder(res, 404, { error: `no encontrado: ${relativa}` });
    return;
  }
  const tipo = MIME[extname(destino).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": tipo, "cache-control": "no-cache" });
  res.end(readFileSync(destino));
}

async function manejarChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let datos: unknown;
  try {
    datos = JSON.parse(await leerCuerpo(req));
  } catch {
    responder(res, 400, { error: "JSON inválido en el cuerpo de la petición" });
    return;
  }

  const cuerpo = (datos ?? {}) as { sessionId?: unknown; message?: unknown };
  if (typeof cuerpo.message !== "string" || cuerpo.message.trim() === "") {
    responder(res, 400, { error: "Falta el campo message (texto no vacío)" });
    return;
  }
  const id =
    typeof cuerpo.sessionId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(cuerpo.sessionId)
      ? cuerpo.sessionId
      : randomUUID();
  const sesion = sesiones.obtener(id);
  const mensaje = cuerpo.message.trim().slice(0, maxMensaje);

  if (sesiones.agotada(sesion)) {
    responder(res, 200, {
      sessionId: id,
      reply:
        "Se alcanzó el límite de tokens de esta sesión (control de costo). " +
        "Empieza una sesión nueva para continuar.",
      toolCalls: [],
      needsConfirmation: sesion.pendiente !== null,
    });
    return;
  }

  const ctx = { directory: raiz, sessionId: id };
  try {
    const adaptador = obtenerAdaptador();
    const resultado = await ejecutarTurno(
      { adaptador, herramientas, prefijo: "oc", sistema, ctx, maxIteraciones },
      sesion,
      mensaje,
    );
    sesiones.guardar(sesion);
    responder(res, 200, { sessionId: id, ...resultado });
  } catch (e) {
    // CA5: el error se muestra en lenguaje claro y la sesión sigue viva.
    const detalle = e instanceof Error ? e.message : String(e);
    sesiones.guardar(sesion);
    responder(res, 200, {
      sessionId: id,
      reply: `No pude completar el turno: ${detalle}`,
      toolCalls: [],
      needsConfirmation: sesion.pendiente !== null,
      error: true,
    });
  }
}

function manejarSesion(res: ServerResponse, id: string): void {
  const sesion = sesiones.historial(id);
  responder(res, 200, {
    id: sesion.id,
    needsConfirmation: sesion.pendiente !== null,
    pendiente: sesion.pendiente,
    historial: sesion.historial,
  });
}

function manejarCasos(res: ServerResponse): void {
  const dir = join(raiz, "fixtures", "reto-03", "solicitudes");
  const casos = existsSync(dir)
    ? readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory()).sort()
    : [];
  responder(res, 200, { casos });
}

const servidor = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const ruta = url.pathname;

  void (async () => {
    try {
      if (req.method === "POST" && ruta === "/api/chat") {
        await manejarChat(req, res);
        return;
      }
      if (req.method === "GET" && ruta === "/api/health") {
        const cfg = leerConfigLlm();
        responder(res, 200, {
          ok: true,
          provider: cfg.proveedor,
          model: cfg.modelo,
          configured: cfg.clavePresente,
        });
        return;
      }
      if (req.method === "GET" && ruta === "/api/casos") {
        manejarCasos(res);
        return;
      }
      const sesionRuta = ruta.match(/^\/api\/sessions\/([A-Za-z0-9_-]{1,64})$/);
      if (req.method === "GET" && sesionRuta?.[1]) {
        manejarSesion(res, sesionRuta[1]);
        return;
      }
      if (req.method === "GET" || req.method === "HEAD") {
        servirEstatico(res, ruta);
        return;
      }
      responder(res, 405, { error: `método ${req.method ?? "?"} no permitido` });
    } catch (e) {
      responder(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  })();
});

servidor.listen(puerto, () => {
  const cfg = leerConfigLlm();
  console.log(`Compras Bot escuchando en http://localhost:${puerto}`);
  console.log(`  proveedor: ${cfg.proveedor} · modelo: ${cfg.modelo}`);
  console.log(`  clave configurada: ${cfg.clavePresente ? "sí" : "NO — define .env a partir de .env.example"}`);
  console.log(`  tope de iteraciones por turno: ${maxIteraciones}`);
});
