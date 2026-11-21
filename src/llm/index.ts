import { existeEnv } from "../env.ts";
import type { AdaptadorLlm } from "./adapter.ts";
import { crearAnthropic } from "./anthropic.ts";
import { crearOpenai } from "./openai.ts";

export type ConfigLlm = {
  proveedor: string;
  modelo: string;
  requiereClave: boolean;
  clavePresente: boolean;
};

const MODELOS: Record<string, string> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o",
};

export function leerConfigLlm(): ConfigLlm {
  const proveedor = (process.env["LLM_PROVIDER"] ?? "anthropic").toLowerCase();
  const modelo = process.env["LLM_MODEL"] ?? MODELOS[proveedor] ?? MODELOS["anthropic"]!;
  const clave = proveedor === "anthropic" ? process.env["ANTHROPIC_API_KEY"] : process.env["OPENAI_API_KEY"];
  return { proveedor, modelo, requiereClave: proveedor !== "ninguno", clavePresente: Boolean(clave) };
}

/** Crea el adaptador elegido en LLM_PROVIDER. Falla con mensaje claro si falta la clave. */
export function crearAdaptador(): AdaptadorLlm {
  const cfg = leerConfigLlm();
  const timeoutMs = Number(process.env["LLM_TIMEOUT_MS"] ?? 60_000);
  const maxTokens = Number(process.env["LLM_MAX_TOKENS_SALIDA"] ?? 2_048);

  if (cfg.proveedor === "anthropic") {
    const apiKey = existeEnv("ANTHROPIC_API_KEY");
    if (!apiKey) {
      throw new Error(
        "Falta ANTHROPIC_API_KEY. Copia .env.example a .env y define la clave del modelo (nunca va al repositorio ni al front).",
      );
    }
    return crearAnthropic({ apiKey, modelo: cfg.modelo, timeoutMs, maxTokens });
  }

  if (cfg.proveedor === "openai") {
    const apiKey = existeEnv("OPENAI_API_KEY");
    if (!apiKey) {
      throw new Error(
        "Falta OPENAI_API_KEY. Copia .env.example a .env y define la clave del modelo (nunca va al repositorio ni al front).",
      );
    }
    return crearOpenai({
      apiKey,
      modelo: cfg.modelo,
      baseUrl: process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1",
      timeoutMs,
      maxTokens,
    });
  }

  throw new Error(`LLM_PROVIDER desconocido: "${cfg.proveedor}". Usa "anthropic" o "openai".`);
}

export type { AdaptadorLlm };
