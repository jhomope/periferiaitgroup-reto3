/* Compras Bot — front de chat del reto 03 (sin build, vanilla JS). */

const chat = document.getElementById("chat");
const formulario = document.getElementById("formulario");
const entrada = document.getElementById("mensaje");
const botonEnviar = document.getElementById("enviar");
const badge = document.getElementById("salud");
const banner = document.getElementById("banner");
const contenedorSugerencias = document.getElementById("sugerencias");

const CLAVE_SESION = "reto03.sesion";
let sessionId = localStorage.getItem(CLAVE_SESION) || null;
let ocupado = false;

// --- utilidades -------------------------------------------------------------

function escapar(texto) {
  return String(texto)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatear(texto) {
  return escapar(texto)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

function bajarAlFinal() {
  chat.scrollTop = chat.scrollHeight;
}

function agregarBurbuja(clase, html) {
  const div = document.createElement("div");
  div.className = `mensaje ${clase}`;
  div.innerHTML = html;
  chat.appendChild(div);
  bajarAlFinal();
  return div;
}

function agregarSistema(texto) {
  return agregarBurbuja("sistema", formatear(texto));
}

function indicadorPensando() {
  const div = document.createElement("div");
  div.className = "mensaje asistente";
  div.innerHTML = '<span class="pensando"><i></i><i></i><i></i></span>';
  chat.appendChild(div);
  bajarAlFinal();
  return div;
}

function tarjetaHerramienta(tc) {
  const ok = tc.ok !== false;
  const detalles = document.createElement("details");
  detalles.className = `herramienta${ok ? "" : " error"}`;
  const argumentos = JSON.stringify(tc.argumentos ?? {}, null, 2);
  const resultado = String(tc.resultado ?? "");
  detalles.innerHTML = `
    <summary>
      <span class="etiqueta">herramienta</span>
      <span>${escapar(tc.nombre)}</span>
      <span class="estado ${ok ? "ok" : "err"}">${ok ? "ok" : "error"}</span>
    </summary>
    <div class="cuerpo">
      <div><h4>argumentos</h4><pre>${escapar(argumentos)}</pre></div>
      <div><h4>resultado</h4><pre>${escapar(resultado)}</pre></div>
    </div>`;
  chat.appendChild(detalles);
  bajarAlFinal();
}

function marcarConfirmacion() {
  banner.classList.remove("oculto");
  const burbujas = chat.querySelectorAll(".mensaje.asistente");
  const ultima = burbujas[burbujas.length - 1];
  if (ultima) ultima.classList.add("confirma");
}

function limpiarConfirmacion() {
  banner.classList.add("oculto");
  chat.querySelectorAll(".mensaje.asistente.confirma").forEach((b) => b.classList.remove("confirma"));
}

// --- red --------------------------------------------------------------------

async function llamarApi(ruta, opciones) {
  const respuesta = await fetch(ruta, opciones);
  let datos = null;
  try {
    datos = await respuesta.json();
  } catch {
    datos = null;
  }
  if (!respuesta.ok && datos === null) {
    throw new Error(`HTTP ${respuesta.status}`);
  }
  return datos;
}

async function enviar(texto) {
  if (ocupado || !texto.trim()) return;
  ocupado = true;
  botonEnviar.disabled = true;
  agregarBurbuja("usuario", formatear(texto));
  entrada.value = "";
  const pensando = indicadorPensando();

  try {
    const datos = await llamarApi("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, message: texto }),
    });
    pensando.remove();

    if (datos.sessionId) {
      sessionId = datos.sessionId;
      localStorage.setItem(CLAVE_SESION, sessionId);
    }
    for (const tc of datos.toolCalls ?? []) tarjetaHerramienta(tc);
    agregarBurbuja("asistente", formatear(datos.reply || "(sin respuesta)"));

    if (datos.needsConfirmation) marcarConfirmacion();
    else limpiarConfirmacion();
  } catch (e) {
    pensando.remove();
    agregarBurbuja("asistente", `No pude contactar al backend: ${formatear(String(e.message || e))}`);
  } finally {
    ocupado = false;
    botonEnviar.disabled = false;
    entrada.focus();
    bajarAlFinal();
  }
}

// --- arranque ---------------------------------------------------------------

async function cargarSalud() {
  try {
    const datos = await llamarApi("/api/health");
    badge.textContent = `${datos.provider} · ${datos.model}`;
    badge.className = `badge ${datos.configured ? "ok" : "warn"}`;
    badge.title = datos.configured
      ? "Clave del modelo configurada en el backend"
      : "Sin clave de modelo: define .env (ver README)";
  } catch {
    badge.textContent = "backend caído";
    badge.className = "badge warn";
  }
}

async function cargarSugerencias() {
  try {
    const datos = await llamarApi("/api/casos");
    const casos = datos.casos ?? [];
    const ideas = [
      ...casos.map((c) => ({ texto: `Procesa la solicitud "${c}". Dime si está apta, qué control falló y qué falta.`, etiqueta: c })),
      { texto: "¿Qué casos tengo disponibles y cómo funciona tu proceso?", etiqueta: "ayuda" },
    ];
    for (const idea of ideas) {
      const boton = document.createElement("button");
      boton.type = "button";
      boton.textContent = idea.etiqueta;
      boton.title = idea.texto;
      boton.addEventListener("click", () => enviar(idea.texto));
      contenedorSugerencias.appendChild(boton);
    }
  } catch {
    /* sin casos no hay sugerencias */
  }
}

formulario.addEventListener("submit", (evento) => {
  evento.preventDefault();
  void enviar(entrada.value);
});

document.getElementById("nueva").addEventListener("click", () => {
  sessionId = null;
  localStorage.removeItem(CLAVE_SESION);
  chat.innerHTML = "";
  limpiarConfirmacion();
  agregarSistema("Sesión nueva. Los cambios se guardan en out/sesiones/.");
  entrada.focus();
});

void cargarSalud();
void cargarSugerencias();
agregarSistema(
  "Soy Compras Bot, el agente de Órdenes de Compra. Proceso paquetes de fixtures/reto-03/solicitudes: " +
    "leo, valido con RC1–RC10, armo el payload, genero la evidencia y creo la OC en el SAP simulado. " +
    "Nunca creo nada sin tu confirmación.",
);
