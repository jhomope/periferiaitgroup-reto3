/**
 * Tests del ciclo del agente con un adaptador FALSO (sin clave, sin red).
 * Verifican CA1 (tope), CA3 (confirmación), CA5 (errores), la validación de
 * argumentos y el flujo completo de herramientas sobre los fixtures reales.
 *
 *   bun test
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { ejecutarTurno, type DependenciasCiclo, type HerramientaEjecutable } from "./ciclo.ts";
import { raizProyecto } from "./core/raiz.ts";
import { limpiarOut } from "./core/salida.ts";
import type { AdaptadorLlm, PeticionLlm, RespuestaLlm } from "./llm/adapter.ts";
import type { Sesion } from "./sesiones.ts";
import { herramientasOc } from "./tools/oc.ts";

const raiz = raizProyecto();

beforeAll(() => {
  limpiarOut(raiz, ["sesiones"]);
});

class AdaptadorFalso implements AdaptadorLlm {
  readonly proveedor = "falso";
  readonly modelo = "guion";
  peticiones: PeticionLlm[] = [];
  private guion: RespuestaLlm[];

  constructor(guion: RespuestaLlm[]) {
    this.guion = [...guion];
  }

  async enviar(peticion: PeticionLlm): Promise<RespuestaLlm> {
    this.peticiones.push(peticion);
    const siguiente = this.guion.shift();
    if (!siguiente) throw new Error("el guion del adaptador falso se quedó sin respuestas");
    return siguiente;
  }
}

function llamada(nombre: string, argumentos: unknown): RespuestaLlm {
  return { texto: "", llamadas: [{ id: `call-${nombre}-${Math.random().toString(36).slice(2, 6)}`, nombre, argumentos }] };
}

function frase(texto: string): RespuestaLlm {
  return { texto, llamadas: [] };
}

function crearDep(guion: RespuestaLlm[], maxIteraciones = 10): { dep: DependenciasCiclo; falso: AdaptadorFalso } {
  const falso = new AdaptadorFalso(guion);
  const dep: DependenciasCiclo = {
    adaptador: falso,
    herramientas: herramientasOc as unknown as Record<string, HerramientaEjecutable>,
    prefijo: "oc",
    sistema: "prompt de prueba",
    ctx: { directory: raiz, sessionId: `test-${Math.random().toString(36).slice(2, 8)}` },
    maxIteraciones,
  };
  return { dep, falso };
}

function crearSesion(): Sesion {
  return { id: "test", historial: [], pendiente: null, tokensEstimados: 0, creada: "", actualizada: "" };
}

describe("ciclo del agente", () => {
  test("flujo completo sobre sol-001: lee, valida, arma payload, evidencia y crea la OC", async () => {
    const { dep } = crearDep([
      llamada("oc_leer_paquete", { caso: "sol-001" }),
      llamada("oc_validar", { caso: "sol-001" }),
      llamada("oc_construir_payload", { caso: "sol-001" }),
      llamada("oc_generar_evidencia", { caso: "sol-001" }),
      llamada("oc_crear", { caso: "sol-001" }),
      frase("OC 4500000001 creada. Caso cerrado."),
    ]);
    const sesion = crearSesion();

    const resultado = await ejecutarTurno(dep, sesion, "procesa sol-001");

    expect(resultado.toolCalls).toHaveLength(5);
    expect(resultado.toolCalls.every((t) => t.ok)).toBe(true);
    expect(resultado.needsConfirmation).toBe(false);
    expect(resultado.reply).toContain("4500000001");
    expect(sesion.historial.filter((m) => m.rol === "herramienta")).toHaveLength(5);
    expect(sesion.tokensEstimados).toBeGreaterThan(0);
  });

  test("CA3: sol-004 deja el turno esperando confirmación y solo crea al confirmar", async () => {
    const { dep } = crearDep([
      llamada("oc_leer_paquete", { caso: "sol-004" }),
      llamada("oc_validar", { caso: "sol-004" }),
      frase("La cotización difiere 6% de la solicitud. ¿Confirmas?"),
    ]);
    const sesion = crearSesion();

    const primero = await ejecutarTurno(dep, sesion, "procesa sol-004");
    expect(primero.needsConfirmation).toBe(true);
    expect(sesion.pendiente?.caso).toBe("sol-004");
    expect(sesion.pendiente?.confirmaciones.map((c) => c.codigo)).toEqual(["RC5"]);

    // Segundo turno: el usuario confirma y el agente crea la OC.
    const { dep: dep2 } = crearDep([
      llamada("oc_crear", { caso: "sol-004", confirmado: true }),
      frase("Confirmado: OC creada."),
    ]);
    const segundo = await ejecutarTurno(dep2, sesion, "confirmo");
    expect(segundo.needsConfirmation).toBe(false);
    expect(segundo.toolCalls[0]?.ok).toBe(true);
    expect(segundo.toolCalls[0]?.resultado).toContain("numero_oc");
  });

  test("sol-002 bloqueado: oc_crear devuelve el motivo y no crea OC", async () => {
    const { dep } = crearDep([
      llamada("oc_validar", { caso: "sol-002" }),
      llamada("oc_crear", { caso: "sol-002" }),
      frase("No se creó: proveedor inexistente."),
    ]);
    const sesion = crearSesion();

    const resultado = await ejecutarTurno(dep, sesion, "procesa sol-002");

    expect(resultado.toolCalls[1]?.ok).toBe(false);
    expect(resultado.toolCalls[1]?.resultado).toContain("RC1");
    expect(resultado.needsConfirmation).toBe(false);
  });

  test("CA5: argumentos inválidos y herramienta desconocida se devuelven al modelo sin romper el turno", async () => {
    const { dep } = crearDep([
      llamada("oc_leer_paquete", { caso: 123 }),
      llamada("oc_inexistente", {}),
      frase("No pude procesarlo."),
    ]);
    const sesion = crearSesion();

    const resultado = await ejecutarTurno(dep, sesion, "hola");

    expect(resultado.reply).toBe("No pude procesarlo.");
    const textos = sesion.historial.filter((m) => m.rol === "herramienta").map((m) => m.texto);
    expect(textos[0]).toContain("argumentos inválidos");
    expect(textos[1]).toContain("herramienta desconocida");
    expect(resultado.toolCalls.every((t) => t.ok === false)).toBe(true);
  });

  test("CA1: al alcanzar el tope pide respuesta final sin herramientas", async () => {
    const { dep, falso } = crearDep(
      [
        llamada("oc_leer_paquete", { caso: "sol-001" }),
        llamada("oc_leer_paquete", { caso: "sol-001" }),
        frase("Resumen con lo avanzado y lo que falta."),
      ],
      2,
    );
    const sesion = crearSesion();

    const resultado = await ejecutarTurno(dep, sesion, "procesa sol-001");

    expect(resultado.reply).toContain("Resumen");
    expect(resultado.toolCalls).toHaveLength(2);
    expect(falso.peticiones).toHaveLength(3);
    expect(falso.peticiones[2]?.herramientas).toHaveLength(0);
    // La historia no queda con un tool_use sin su tool_result correspondiente.
    const conLlamadas = sesion.historial.filter((m) => m.rol === "asistente" && m.llamadas.length > 0);
    expect(conLlamadas).toHaveLength(2);
  });
});
