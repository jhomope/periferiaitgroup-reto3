/**
 * Genera `modulo/` a partir de las piezas MISMAS que usa la aplicación (PRD 9.4).
 * Nada se escribe a mano dentro de `modulo/`: si cambia el prompt, las herramientas
 * o el conocimiento, vuelve a correrse para que no existan copias divergentes.
 *
 *   bun run sync:modulo
 *
 * - modulo/agent.md              ← agent/prompt.md + frontmatter
 * - modulo/tools/oc.ts           ← src/tools/oc.ts (solo se reescriben los import)
 * - modulo/skill/ordenes-compra/SKILL.md ← src/knowledge/ordenes-compra.md + frontmatter
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { raizProyecto } from "../src/core/raiz.ts";

const raiz = raizProyecto();

function leer(ruta: string): string {
  return readFileSync(join(raiz, ruta), "utf8");
}

function escribir(rutaRelativa: string, contenido: string): void {
  const ruta = join(raiz, rutaRelativa);
  mkdirSync(join(ruta, ".."), { recursive: true });
  writeFileSync(ruta, contenido.endsWith("\n") ? contenido : `${contenido}\n`, "utf8");
  console.log(`  ✓ ${rutaRelativa}`);
}

// 1. agent.md — frontmatter del agente + el system prompt real.
const prompt = leer("agent/prompt.md").trimEnd();
const agentMd = [
  "---",
  "name: compras-bot",
  "description: Agente de Órdenes de Compra que lee paquetes, valida RC1-RC10 y crea la OC en SAP simulado.",
  "mode: primary",
  "permission:",
  "  edit: deny",
  "  bash: deny",
  "---",
  "",
  prompt,
  "",
].join("\n");
escribir("modulo/agent.md", agentMd);

// 2. tools/oc.ts — el mismo archivo de herramientas, con import apuntando a ../src.
const herramientas = leer("src/tools/oc.ts")
  .replace(/from "\.\.\/core\//g, 'from "../../src/core/')
  .replace(/from "\.\.\/sap\//g, 'from "../../src/sap/');
escribir("modulo/tools/oc.ts", herramientas);

// 3. skill/ordenes-compra/SKILL.md — el mismo conocimiento, con frontmatter de skill.
const conocimiento = leer("src/knowledge/ordenes-compra.md").trimEnd();
const skillMd = [
  "---",
  "name: ordenes-compra",
  "description: Conocimiento del proceso de Órdenes de Compra de Periferia — reglas RC1-RC10, payload SAP, maestros y salidas en out/.",
  "---",
  "",
  conocimiento,
  "",
].join("\n");
escribir("modulo/skill/ordenes-compra/SKILL.md", skillMd);

// Verificación: el módulo debe importarse y cumplir el contrato sin el servidor.
const modulo = (await import(join(raiz, "modulo/tools/oc.ts"))) as {
  herramientasOc: Record<
    string,
    {
      description: string;
      args: unknown;
      execute: (args: Record<string, unknown>, ctx: { directory: string; sessionId: string }) => Promise<string>;
    }
  >;
  herramientasCompletas: () => boolean;
};
if (!modulo.herramientasCompletas()) {
  console.error("  ✗ modulo/tools/oc.ts no cumple el contrato { description, args, execute }");
  process.exit(1);
}
const nombres = Object.keys(modulo.herramientasOc).map((n) => `oc_${n}`);
console.log(`  ✓ contrato cumplido: ${nombres.join(", ")}`);

// Prueba de humo real: leer un fixture desde el módulo.
const ctx = { directory: raiz, sessionId: "sync-modulo" };
const texto = await modulo.herramientasOc["leer_paquete"]!.execute({ caso: "sol-001" }, ctx);
const resultado = JSON.parse(texto) as { ok: boolean; data?: { solicitud?: { solicitud_id?: string } } };
if (!resultado.ok) {
  console.error(`  ✗ la herramienta del módulo falló: ${texto}`);
  process.exit(1);
}
console.log(`  ✓ lectura de fixture desde el módulo: ${resultado.data?.solicitud?.solicitud_id}`);
console.log("\nmodulo/ regenerado desde las fuentes de la aplicación.");
