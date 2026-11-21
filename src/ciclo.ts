import { registrarLog } from "./core/salida.ts";
import type { AdaptadorLlm, HerramientaLlm, LlamadaHerramienta } from "./llm/adapter.ts";
import type { Ctx } from "./tools/oc.ts";
import { estimarTokens, type Sesion } from "./sesiones.ts";
import { z } from "zod";

/**
 * Ciclo del agente (PRD 6.3):
 *  CA1 tope de iteraciones por turno,
 *  CA2 el modelo solo afirma lo que salió de una herramienta,
 *  CA3 confirmación humana antes de crear la OC,
 *  CA4 cada llamada queda en el historial y en out/log.jsonl,
 *  CA5 los errores se muestran en lenguaje claro sin matar la sesión.
 */

export type HerramientaEjecutable = {
  description: string;
  args: Record<string, z.ZodType>;
  execute: (args: Record<string, unknown>, ctx: Ctx) => Promise<string>;
};

export type ToolCallVisible = {
  nombre: string;
  argumentos: unknown;
  resultado: string;
  ok: boolean;
};

export type ResultadoTurno = {
  reply: string;
  toolCalls: ToolCallVisible[];
  needsConfirmation: boolean;
};

export type DependenciasCiclo = {
  adaptador: AdaptadorLlm;
  herramientas: Record<string, HerramientaEjecutable>;
  prefijo: string;
  sistema: string;
  ctx: Ctx;
  maxIteraciones: number;
};

type Envoltura = {
  ok?: boolean;
  data?: { confirmaciones?: unknown; caso?: string };
  error?: string;
};

const INSTRUCCION_TOPE =
  "Alcanzaste el tope de iteraciones de herramientas de este turno. " +
  "Responde SOLO con texto, resumiendo qué se logró, qué falta y qué decisión necesita el usuario. " +
  "No vuelvas a llamar herramientas.";

function resumir(valor: string, max = 400): string {
  return valor.length <= max ? valor : `${valor.slice(0, max)}…`;
}

function definirHerramientas(dep: DependenciasCiclo): HerramientaLlm[] {
  return Object.entries(dep.herramientas).map(([nombre, def]) => ({
    nombre: `${dep.prefijo}_${nombre}`,
    descripcion: def.description,
    esquema: esquemaJson(def.args),
  }));
}

function esquemaJson(args: Record<string, z.ZodType>): Record<string, unknown> {
  const json = z.toJSONSchema(z.object(args as z.ZodRawShape)) as Record<string, unknown>;
  delete json["$schema"];
  return json;
}

async function ejecutarHerramienta(
  dep: DependenciasCiclo,
  llamada: LlamadaHerramienta,
): Promise<{ visible: ToolCallVisible; texto: string }> {
  const nombreCorto = llamada.nombre.startsWith(`${dep.prefijo}_`)
    ? llamada.nombre.slice(dep.prefijo.length + 1)
    : llamada.nombre;
  const def = dep.herramientas[nombreCorto];

  if (!def) {
    const texto = JSON.stringify({
      ok: false,
      error: `herramienta desconocida: "${llamada.nombre}". Disponibles: ${Object.keys(dep.herramientas)
        .map((n) => `${dep.prefijo}_${n}`)
        .join(", ")}`,
    });
    registrarLog(dep.ctx.directory, {
      ts: new Date().toISOString(),
      herramienta: llamada.nombre,
      mensaje_id: dep.ctx.sessionId,
      ok: false,
      resumen: "herramienta desconocida",
    });
    return { visible: { nombre: llamada.nombre, argumentos: llamada.argumentos, resultado: resumir(texto), ok: false }, texto };
  }

  // Validación zod antes de ejecutar (PRD 6.2): el error vuelve al modelo.
  const esquema = z.object(def.args as z.ZodRawShape);
  const validacion = esquema.safeParse(llamada.argumentos ?? {});
  if (!validacion.success) {
    const detalle = validacion.error.issues
      .map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`)
      .join("; ");
    const texto = JSON.stringify({ ok: false, error: `argumentos inválidos para ${llamada.nombre} — ${detalle}` });
    registrarLog(dep.ctx.directory, {
      ts: new Date().toISOString(),
      herramienta: llamada.nombre,
      mensaje_id: dep.ctx.sessionId,
      ok: false,
      resumen: `argumentos inválidos: ${detalle}`,
    });
    return { visible: { nombre: llamada.nombre, argumentos: llamada.argumentos, resultado: resumir(texto), ok: false }, texto };
  }

  let texto: string;
  try {
    texto = await def.execute(validacion.data as Record<string, unknown>, dep.ctx);
  } catch (e) {
    // CA5: ninguna herramienta debería llegar aquí, pero el ciclo no se rompe.
    texto = JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }

  let ok = true;
  try {
    ok = (JSON.parse(texto) as Envoltura).ok !== false;
  } catch {
    ok = true;
  }
  return { visible: { nombre: llamada.nombre, argumentos: llamada.argumentos, resultado: resumir(texto), ok }, texto };
}

/** CA3: recuerda si el turno quedó esperando confirmación del usuario. */
function actualizarPendiente(sesion: Sesion, llamada: LlamadaHerramienta, texto: string): void {
  let env: Envoltura;
  try {
    env = JSON.parse(texto) as Envoltura;
  } catch {
    return;
  }
  const caso =
    typeof (llamada.argumentos as { caso?: unknown } | undefined)?.caso === "string"
      ? ((llamada.argumentos as { caso: string }).caso)
      : undefined;

  if (llamada.nombre.endsWith("_validar")) {
    const confirmaciones = Array.isArray(env.data?.confirmaciones) ? (env.data.confirmaciones as { codigo: string; detalle: string }[]) : null;
    if (confirmaciones && caso) {
      sesion.pendiente = confirmaciones.length > 0 ? { caso, confirmaciones } : null;
    }
    return;
  }

  if (llamada.nombre.endsWith("_crear")) {
    if (env.ok) {
      sesion.pendiente = null;
      return;
    }
    if (typeof env.error === "string" && env.error.startsWith("requiere confirmación") && caso) {
      const detalle = env.error.split("—")[1] ?? "";
      const confirmaciones = detalle
        .split(" | ")
        .filter((f) => f.trim() !== "")
        .map((f) => {
          const [codigo, ...resto] = f.split(": ");
          return { codigo: codigo ?? "RC?", detalle: resto.join(": ") };
        });
      sesion.pendiente = { caso, confirmaciones };
    }
  }
}

/** Ejecuta un turno completo de chat y devuelve la respuesta final. */
export async function ejecutarTurno(
  dep: DependenciasCiclo,
  sesion: Sesion,
  mensaje: string,
): Promise<ResultadoTurno> {
  sesion.historial.push({ rol: "usuario", texto: mensaje });
  sesion.tokensEstimados += estimarTokens(mensaje);

  const defs = definirHerramientas(dep);
  const toolCalls: ToolCallVisible[] = [];

  for (let iteracion = 0; iteracion < dep.maxIteraciones; iteracion++) {
    const respuesta = await dep.adaptador.enviar({ sistema: dep.sistema, mensajes: sesion.historial, herramientas: defs });
    sesion.historial.push({ rol: "asistente", texto: respuesta.texto, llamadas: respuesta.llamadas });
    sesion.tokensEstimados += estimarTokens(respuesta.texto);

    if (respuesta.llamadas.length === 0) {
      return { reply: respuesta.texto, toolCalls, needsConfirmation: sesion.pendiente !== null };
    }

    for (const llamada of respuesta.llamadas) {
      const ejecutada = await ejecutarHerramienta(dep, llamada);
      toolCalls.push(ejecutada.visible);
      sesion.historial.push({ rol: "herramienta", llamadaId: llamada.id, nombre: llamada.nombre, texto: ejecutada.texto });
      sesion.tokensEstimados += estimarTokens(ejecutada.texto);
      actualizarPendiente(sesion, llamada, ejecutada.texto);
    }
  }

  // CA1: tope alcanzado → respuesta final sin herramientas, con lo que se tiene.
  sesion.historial.push({ rol: "usuario", texto: INSTRUCCION_TOPE });
  const final = await dep.adaptador.enviar({ sistema: dep.sistema, mensajes: sesion.historial, herramientas: [] });
  sesion.historial.push({ rol: "asistente", texto: final.texto, llamadas: [] });
  sesion.tokensEstimados += estimarTokens(final.texto);
  return {
    reply: final.texto || "Alcancé el tope de iteraciones sin poder completar la respuesta.",
    toolCalls,
    needsConfirmation: sesion.pendiente !== null,
  };
}
