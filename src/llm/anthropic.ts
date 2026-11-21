import {
  ErrorLlm,
  pedirJson,
  type AdaptadorLlm,
  type LlamadaHerramienta,
  type MensajeChat,
  type RespuestaLlm,
} from "./adapter.ts";

export type OpcionesAnthropic = {
  apiKey: string;
  modelo: string;
  timeoutMs: number;
  maxTokens: number;
};

type Bloque = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
};

/**
 * Adaptador para la API de Anthropic (Messages API) usando fetch,
 * sin SDK: menos dependencias y control total del contrato.
 */
export function crearAnthropic(op: OpcionesAnthropic): AdaptadorLlm {
  return {
    proveedor: "anthropic",
    modelo: op.modelo,

    async enviar({ sistema, mensajes, herramientas }): Promise<RespuestaLlm> {
      const cuerpo: Record<string, unknown> = {
        model: op.modelo,
        max_tokens: op.maxTokens,
        system: sistema,
        messages: agrupar(mensajes),
        ...(herramientas.length > 0
          ? {
              tools: herramientas.map((h) => ({
                name: h.nombre,
                description: h.descripcion,
                input_schema: h.esquema,
              })),
            }
          : {}),
      };

      const data = (await pedirJson(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": op.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(cuerpo),
        },
        op.timeoutMs,
        "Anthropic",
      )) as { content?: Bloque[] };

      const bloques = data.content ?? [];
      const texto = bloques
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n")
        .trim();
      const llamadas: LlamadaHerramienta[] = bloques
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          id: b.id ?? `call_${Math.random().toString(36).slice(2)}`,
          nombre: b.name ?? "",
          argumentos: b.input ?? {},
        }));

      if (texto === "" && llamadas.length === 0) {
        throw new ErrorLlm("Anthropic: la respuesta vino vacía (ni texto ni llamadas a herramientas)");
      }
      return { texto, llamadas };
    },
  };
}

/** Anthropic exige roles alternados: fusiona mensajes consecutivos del mismo rol. */
function agrupar(mensajes: MensajeChat[]): { role: string; content: unknown[] }[] {
  const salida: { role: string; content: unknown[] }[] = [];
  for (const m of mensajes) {
    let rol: string;
    let contenido: unknown[];
    if (m.rol === "usuario") {
      rol = "user";
      contenido = [{ type: "text", text: m.texto }];
    } else if (m.rol === "asistente") {
      rol = "assistant";
      contenido = [
        ...(m.texto.trim() ? [{ type: "text", text: m.texto }] : []),
        ...m.llamadas.map((l) => ({ type: "tool_use", id: l.id, name: l.nombre, input: l.argumentos })),
      ];
    } else {
      rol = "user";
      contenido = [{ type: "tool_result", tool_use_id: m.llamadaId, content: m.texto }];
    }
    if (contenido.length === 0) continue;
    const ultimo = salida[salida.length - 1];
    if (ultimo && ultimo.role === rol) {
      ultimo.content.push(...contenido);
    } else {
      salida.push({ role: rol, content: contenido });
    }
  }
  return salida;
}
