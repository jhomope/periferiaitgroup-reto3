import {
  ErrorLlm,
  pedirJson,
  type AdaptadorLlm,
  type LlamadaHerramienta,
  type MensajeChat,
  type RespuestaLlm,
} from "./adapter.ts";

export type OpcionesOpenai = {
  apiKey: string;
  modelo: string;
  baseUrl: string;
  timeoutMs: number;
  maxTokens: number;
};

type ToolCallOpenai = {
  id?: string;
  function?: { name?: string; arguments?: string };
};

type MensajeOpenai = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCallOpenai[];
  tool_call_id?: string;
};

type Elegido = { tool_calls?: ToolCallOpenai[]; content?: string | null };

/**
 * Adaptador para la API de Chat Completions compatible con OpenAI.
 * Con OPENAI_BASE_URL apunta a cualquier proveedor compatible
 * (Groq, Mistral, OpenRouter, Ollama local, etc.).
 */
export function crearOpenai(op: OpcionesOpenai): AdaptadorLlm {
  return {
    proveedor: "openai",
    modelo: op.modelo,

    async enviar({ sistema, mensajes, herramientas }): Promise<RespuestaLlm> {
      const cuerpo: Record<string, unknown> = {
        model: op.modelo,
        max_tokens: op.maxTokens,
        messages: construirMensajes(sistema, mensajes),
        ...(herramientas.length > 0
          ? {
              tools: herramientas.map((h) => ({
                type: "function",
                function: { name: h.nombre, description: h.descripcion, parameters: h.esquema },
              })),
              tool_choice: "auto",
            }
          : {}),
      };

      const data = (await pedirJson(
        `${op.baseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${op.apiKey}`,
          },
          body: JSON.stringify(cuerpo),
        },
        op.timeoutMs,
        "OpenAI",
      )) as { choices?: { message?: Elegido }[] };

      const mensaje = data.choices?.[0]?.message;
      if (!mensaje) throw new ErrorLlm("OpenAI: la respuesta no trae choices[0].message");

      const llamadas: LlamadaHerramienta[] = (mensaje.tool_calls ?? [])
        .map((tc) => ({
          id: tc.id ?? `call_${Math.random().toString(36).slice(2)}`,
          nombre: tc.function?.name ?? "",
          argumentos: parsear(tc.function?.arguments ?? "{}"),
        }))
        .filter((l) => l.nombre !== "");

      const texto = (mensaje.content ?? "").trim();
      if (texto === "" && llamadas.length === 0) {
        throw new ErrorLlm("OpenAI: la respuesta vino vacía (ni texto ni llamadas a herramientas)");
      }
      return { texto, llamadas };
    },
  };
}

function parsear(bruto: string): unknown {
  try {
    return JSON.parse(bruto);
  } catch {
    return { _error: "los argumentos no eran JSON válido" };
  }
}

function construirMensajes(sistema: string, mensajes: MensajeChat[]): MensajeOpenai[] {
  const salida: MensajeOpenai[] = [{ role: "system", content: sistema }];
  for (const m of mensajes) {
    if (m.rol === "usuario") {
      salida.push({ role: "user", content: m.texto });
    } else if (m.rol === "asistente") {
      const llamadas = m.llamadas.map((l) => ({
        id: l.id,
        function: { name: l.nombre, arguments: JSON.stringify(l.argumentos ?? {}) },
      }));
      salida.push({
        role: "assistant",
        content: m.texto.trim() ? m.texto : null,
        ...(llamadas.length > 0 ? { tool_calls: llamadas } : {}),
      });
    } else {
      salida.push({ role: "tool", tool_call_id: m.llamadaId, content: m.texto });
    }
  }
  return salida;
}
