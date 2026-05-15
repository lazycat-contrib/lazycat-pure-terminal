import "@wterm/dom/css";
import "./styles.css";

import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { WTerm } from "@wterm/dom";
import { GhosttyCore } from "@wterm/ghostty";
import { createIcons, icons } from "lucide";

import {
  CapabilityService,
  type Instance,
  type PluginDescriptor,
  type Session,
} from "./gen/lazycat/webshell/v1/capability_pb";

type TerminalTheme = {
  id: string;
  label: string;
  ghosttyName: string;
  className?: string;
  colors?: Record<string, string>;
};

type Settings = {
  themeId: string;
  fontSize: number;
  lineHeight: number;
  cursorBlink: boolean;
  scrollbackLimit: number;
};

const THEMES: TerminalTheme[] = [
  { id: "ghostty", label: "Ghostty Default", ghosttyName: "Ghostty Default" },
  {
    id: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    ghosttyName: "Catppuccin Mocha",
    colors: {
      "--term-bg": "#1e1e2e",
      "--term-fg": "#cdd6f4",
      "--term-cursor": "#f5e0dc",
      "--term-color-0": "#45475a",
      "--term-color-1": "#f38ba8",
      "--term-color-2": "#a6e3a1",
      "--term-color-3": "#f9e2af",
      "--term-color-4": "#89b4fa",
      "--term-color-5": "#f5c2e7",
      "--term-color-6": "#94e2d5",
      "--term-color-7": "#bac2de",
      "--term-color-8": "#585b70",
      "--term-color-9": "#f38ba8",
      "--term-color-10": "#a6e3a1",
      "--term-color-11": "#f9e2af",
      "--term-color-12": "#89b4fa",
      "--term-color-13": "#f5c2e7",
      "--term-color-14": "#94e2d5",
      "--term-color-15": "#a6adc8",
    },
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    ghosttyName: "TokyoNight",
    colors: {
      "--term-bg": "#1a1b26",
      "--term-fg": "#c0caf5",
      "--term-cursor": "#c0caf5",
      "--term-color-0": "#15161e",
      "--term-color-1": "#f7768e",
      "--term-color-2": "#9ece6a",
      "--term-color-3": "#e0af68",
      "--term-color-4": "#7aa2f7",
      "--term-color-5": "#bb9af7",
      "--term-color-6": "#7dcfff",
      "--term-color-7": "#a9b1d6",
      "--term-color-8": "#414868",
      "--term-color-9": "#f7768e",
      "--term-color-10": "#9ece6a",
      "--term-color-11": "#e0af68",
      "--term-color-12": "#7aa2f7",
      "--term-color-13": "#bb9af7",
      "--term-color-14": "#7dcfff",
      "--term-color-15": "#c0caf5",
    },
  },
  { id: "solarized-dark", label: "Solarized Dark", ghosttyName: "Solarized Dark", className: "theme-solarized-dark" },
  { id: "monokai", label: "Monokai", ghosttyName: "Monokai", className: "theme-monokai" },
  { id: "light", label: "Classic Light", ghosttyName: "Light", className: "theme-light" },
];

const DEFAULT_SETTINGS: Settings = {
  themeId: "catppuccin-mocha",
  fontSize: 14,
  lineHeight: 1.22,
  cursorBlink: true,
  scrollbackLimit: 10000,
};

const transport = createConnectTransport({ baseUrl: window.location.origin });
const client = createClient(CapabilityService, transport);

const params = new URLSearchParams(window.location.search);
const initialSelector = params.get("name") ?? "";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("missing #app");

app.innerHTML = `
  <main class="shell" aria-label="Pure Terminal workspace">
    <aside class="rail" aria-label="Instances and sessions">
      <header class="brand">
        <div class="brand-mark">PT</div>
        <div>
          <h1>Pure Terminal</h1>
          <p>LightOS WebShell</p>
        </div>
      </header>
      <section class="panel">
        <div class="panel-head">
          <h2>Instances</h2>
          <button class="icon-button" id="refreshInstances" type="button" aria-label="Refresh instances" title="Refresh instances">
            <i data-lucide="refresh-cw"></i>
          </button>
        </div>
        <div id="instanceList" class="instance-list" aria-live="polite"></div>
      </section>
      <section class="panel compact">
        <div class="panel-head">
          <h2>Control</h2>
        </div>
        <div class="control-grid">
          <button class="command-button primary" id="connectButton" type="button">
            <i data-lucide="plug-zap"></i>
            Connect
          </button>
          <button class="command-button" id="closeButton" type="button">
            <i data-lucide="x"></i>
            Close
          </button>
        </div>
        <p id="statusLine" class="status-line">Idle</p>
      </section>
    </aside>

    <section class="terminal-pane" aria-label="Terminal">
      <div class="terminal-toolbar">
        <div>
          <span class="eyebrow">Target</span>
          <strong id="targetLabel">No instance selected</strong>
        </div>
        <div class="toolbar-actions">
          <button class="icon-button" id="humanControl" type="button" aria-label="Request human control" title="Request human control">
            <i data-lucide="user-round-check"></i>
          </button>
          <button class="icon-button" id="fitTerminal" type="button" aria-label="Fit terminal" title="Fit terminal">
            <i data-lucide="scan"></i>
          </button>
        </div>
      </div>
      <div id="terminalMount" class="terminal-mount" tabindex="0"></div>
    </section>

    <aside class="inspector" aria-label="Terminal settings and plugins">
      <section class="panel">
        <div class="panel-head">
          <h2>Appearance</h2>
        </div>
        <label class="field">
          <span>Theme</span>
          <select id="themeSelect"></select>
        </label>
        <label class="field">
          <span>Font size</span>
          <input id="fontSize" type="range" min="11" max="22" step="1" />
          <output id="fontSizeValue"></output>
        </label>
        <label class="field">
          <span>Line height</span>
          <input id="lineHeight" type="range" min="1.05" max="1.6" step="0.01" />
          <output id="lineHeightValue"></output>
        </label>
        <label class="switch">
          <input id="cursorBlink" type="checkbox" />
          <span>Cursor blink</span>
        </label>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2>Plugins</h2>
          <button class="icon-button" id="refreshPlugins" type="button" aria-label="Refresh plugins" title="Refresh plugins">
            <i data-lucide="rotate-cw"></i>
          </button>
        </div>
        <div id="pluginList" class="plugin-list" aria-live="polite"></div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2>Session</h2>
        </div>
        <dl class="session-meta">
          <div><dt>Session</dt><dd id="sessionId">-</dd></div>
          <div><dt>Control</dt><dd id="controlState">human ready</dd></div>
          <div><dt>Ghostty theme</dt><dd id="ghosttyTheme">-</dd></div>
        </dl>
      </section>
    </aside>
  </main>
`;

const elements = {
  instanceList: qs<HTMLDivElement>("#instanceList"),
  pluginList: qs<HTMLDivElement>("#pluginList"),
  refreshInstances: qs<HTMLButtonElement>("#refreshInstances"),
  refreshPlugins: qs<HTMLButtonElement>("#refreshPlugins"),
  connectButton: qs<HTMLButtonElement>("#connectButton"),
  closeButton: qs<HTMLButtonElement>("#closeButton"),
  statusLine: qs<HTMLParagraphElement>("#statusLine"),
  targetLabel: qs<HTMLElement>("#targetLabel"),
  terminalMount: qs<HTMLDivElement>("#terminalMount"),
  themeSelect: qs<HTMLSelectElement>("#themeSelect"),
  fontSize: qs<HTMLInputElement>("#fontSize"),
  fontSizeValue: qs<HTMLOutputElement>("#fontSizeValue"),
  lineHeight: qs<HTMLInputElement>("#lineHeight"),
  lineHeightValue: qs<HTMLOutputElement>("#lineHeightValue"),
  cursorBlink: qs<HTMLInputElement>("#cursorBlink"),
  fitTerminal: qs<HTMLButtonElement>("#fitTerminal"),
  humanControl: qs<HTMLButtonElement>("#humanControl"),
  sessionId: qs<HTMLElement>("#sessionId"),
  controlState: qs<HTMLElement>("#controlState"),
  ghosttyTheme: qs<HTMLElement>("#ghosttyTheme"),
};

let settings = loadSettings();
let instances: Instance[] = [];
let pluginsState: PluginDescriptor[] = [];
let selectedSelector = initialSelector;
let session: Session | undefined;
let term: WTerm | undefined;
let socket: WebSocket | undefined;
let reconnectTimer: number | undefined;
let reconnectDelay = 1000;

init().catch((error) => setStatus(`Startup failed: ${errorMessage(error)}`, "error"));

async function init() {
  renderThemeOptions();
  bindSettings();
  bindActions();
  applySettings();
  createIcons({ icons });
  await Promise.all([loadInstances(), loadPlugins()]);
  if (selectedSelector) {
    elements.targetLabel.textContent = selectedSelector;
  }
}

function qs<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`missing selector ${selector}`);
  return found;
}

function loadSettings(): Settings {
  const raw = localStorage.getItem("pure-terminal.settings");
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  localStorage.setItem("pure-terminal.settings", JSON.stringify(settings));
}

function renderThemeOptions() {
  elements.themeSelect.innerHTML = THEMES.map(
    (theme) => `<option value="${theme.id}">${theme.label}</option>`,
  ).join("");
}

function bindSettings() {
  elements.themeSelect.addEventListener("change", () => {
    settings.themeId = elements.themeSelect.value;
    saveSettings();
    applySettings();
  });
  elements.fontSize.addEventListener("input", () => {
    settings.fontSize = Number(elements.fontSize.value);
    saveSettings();
    applySettings();
  });
  elements.lineHeight.addEventListener("input", () => {
    settings.lineHeight = Number(elements.lineHeight.value);
    saveSettings();
    applySettings();
  });
  elements.cursorBlink.addEventListener("change", () => {
    settings.cursorBlink = elements.cursorBlink.checked;
    saveSettings();
    applySettings();
  });
}

function bindActions() {
  elements.refreshInstances.addEventListener("click", () => void loadInstances());
  elements.refreshPlugins.addEventListener("click", () => void loadPlugins());
  elements.connectButton.addEventListener("click", () => void connectTerminal());
  elements.closeButton.addEventListener("click", closeTerminal);
  elements.fitTerminal.addEventListener("click", () => term?.focus());
  elements.humanControl.addEventListener("click", () => void requestHumanControl());
}

function applySettings() {
  const theme = THEMES.find((item) => item.id === settings.themeId) ?? THEMES[0];
  elements.themeSelect.value = settings.themeId;
  elements.fontSize.value = String(settings.fontSize);
  elements.fontSizeValue.textContent = `${settings.fontSize}px`;
  elements.lineHeight.value = String(settings.lineHeight);
  elements.lineHeightValue.textContent = settings.lineHeight.toFixed(2);
  elements.cursorBlink.checked = settings.cursorBlink;
  elements.ghosttyTheme.textContent = theme.ghosttyName;

  elements.terminalMount.className = `terminal-mount ${theme.className ?? ""}`;
  elements.terminalMount.style.setProperty("--term-font-size", `${settings.fontSize}px`);
  elements.terminalMount.style.setProperty("--term-line-height", String(settings.lineHeight));
  for (const [key, value] of Object.entries(theme.colors ?? {})) {
    elements.terminalMount.style.setProperty(key, value);
  }
  if (!theme.colors) {
    for (const key of Array.from(elements.terminalMount.style)) {
      if (key.startsWith("--term-color") || ["--term-bg", "--term-fg", "--term-cursor"].includes(key)) {
        elements.terminalMount.style.removeProperty(key);
      }
    }
  }
  term?.resize(term.cols, term.rows);
}

async function loadInstances() {
  setStatus("Loading instances...");
  try {
    const response = await client.listInstances({});
    instances = response.instances;
    renderInstances();
    setStatus(instances.length ? "Instances loaded" : "No instances returned");
  } catch (error) {
    renderInstances();
    setStatus(`Instance load failed: ${errorMessage(error)}`, "error");
  }
}

function renderInstances() {
  if (!instances.length) {
    elements.instanceList.innerHTML = `<div class="empty">No LightOS instances visible.</div>`;
    return;
  }
  elements.instanceList.innerHTML = instances.map((instance) => {
    const selector = instance.selector ?? "";
    const running = instance.status === "running";
    const active = selector === selectedSelector;
    return `
      <button class="instance-row ${active ? "selected" : ""}" data-selector="${escapeAttr(selector)}" ${running ? "" : "disabled"} type="button">
        <span>
          <strong>${escapeHtml(instance.name || selector)}</strong>
          <small>${escapeHtml(instance.ownerDeployId ?? "")}</small>
        </span>
        <em class="${running ? "ok" : "muted"}">${escapeHtml(instance.status ?? "unknown")}</em>
      </button>
    `;
  }).join("");
  elements.instanceList.querySelectorAll<HTMLButtonElement>(".instance-row").forEach((button) => {
    button.addEventListener("click", () => {
      selectedSelector = button.dataset.selector ?? "";
      elements.targetLabel.textContent = selectedSelector || "No instance selected";
      renderInstances();
    });
  });
}

async function loadPlugins() {
  try {
    const response = await client.listPlugins({});
    pluginsState = response.plugins;
    renderPlugins();
  } catch (error) {
    elements.pluginList.innerHTML = `<div class="empty error">Plugin load failed: ${escapeHtml(errorMessage(error))}</div>`;
  }
}

function renderPlugins() {
  if (!pluginsState.length) {
    elements.pluginList.innerHTML = `<div class="empty">No plugins registered.</div>`;
    return;
  }
  elements.pluginList.innerHTML = pluginsState.map((plugin) => `
    <article class="plugin-card">
      <div>
        <h3>${escapeHtml(plugin.displayName ?? plugin.id ?? "Plugin")}</h3>
        <p>${escapeHtml(plugin.description ?? "")}</p>
        <span>${escapeHtml(plugin.kind ?? "generic")}</span>
      </div>
      <label class="switch compact-switch">
        <input type="checkbox" data-plugin-id="${escapeAttr(plugin.id ?? "")}" ${plugin.enabled ? "checked" : ""} />
        <span>${plugin.enabled ? "Enabled" : "Disabled"}</span>
      </label>
    </article>
  `).join("");
  elements.pluginList.querySelectorAll<HTMLInputElement>("input[data-plugin-id]").forEach((input) => {
    input.addEventListener("change", () => void configurePlugin(input.dataset.pluginId ?? "", input.checked));
  });
}

async function configurePlugin(pluginId: string, enabled: boolean) {
  if (!pluginId) return;
  try {
    const response = await client.configurePlugin({ pluginId, enabled });
    pluginsState = pluginsState.map((plugin) => plugin.id === pluginId ? response.plugin! : plugin);
    renderPlugins();
    setStatus(`${response.plugin?.displayName ?? pluginId} ${enabled ? "enabled" : "disabled"}`);
  } catch (error) {
    setStatus(`Plugin update failed: ${errorMessage(error)}`, "error");
    await loadPlugins();
  }
}

async function connectTerminal() {
  if (!selectedSelector) {
    setStatus("Select a running instance first.", "error");
    return;
  }
  closeTerminal();
  setStatus("Creating session...");
  try {
    session = await client.createSession({
      selector: selectedSelector,
      cols: 120,
      rows: 32,
      metadata: { frontend: "wterm-ghostty" },
    }).then((response) => response.session);
    elements.sessionId.textContent = session?.id ?? "-";
    await mountTerminal();
    openSocket();
  } catch (error) {
    setStatus(`Connect failed: ${errorMessage(error)}`, "error");
  }
}

async function mountTerminal() {
  term?.destroy();
  elements.terminalMount.innerHTML = "";
  const core = await GhosttyCore.load({ scrollbackLimit: settings.scrollbackLimit });
  term = new WTerm(elements.terminalMount, {
    core,
    cols: 120,
    rows: 32,
    autoResize: true,
    cursorBlink: settings.cursorBlink,
    onData: (data) => socket?.readyState === WebSocket.OPEN && socket.send(data),
    onResize: (cols, rows) => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: "resize", cols, rows })),
  });
  await term.init();
  applySettings();
}

function openSocket() {
  if (!session?.id) return;
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  const url = new URL(`${scheme}://${window.location.host}/ws/terminal`);
  url.searchParams.set("session_id", session.id);
  url.searchParams.set("cols", String(term?.cols ?? 120));
  url.searchParams.set("rows", String(term?.rows ?? 32));

  socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => {
    reconnectDelay = 1000;
    setStatus("Connected", "ok");
    term?.focus();
  });
  socket.addEventListener("message", (event) => {
    if (event.data instanceof ArrayBuffer) {
      term?.write(new Uint8Array(event.data));
      return;
    }
    if (event.data instanceof Blob) {
      event.data.arrayBuffer().then((buffer) => term?.write(new Uint8Array(buffer)));
      return;
    }
    handleServerText(String(event.data));
  });
  socket.addEventListener("close", () => scheduleReconnect());
  socket.addEventListener("error", () => setStatus("Socket error", "error"));
}

function handleServerText(text: string) {
  try {
    const event = JSON.parse(text) as { type?: string; message?: string; exit_code?: number };
    if (event.type === "ready") setStatus("Shell ready", "ok");
    if (event.type === "error") setStatus(event.message ?? "Terminal error", "error");
    if (event.type === "process-exit") setStatus(`Process exited: ${event.exit_code ?? -1}`, "error");
  } catch {
    term?.write(text);
  }
}

function scheduleReconnect() {
  if (!session?.id) return;
  window.clearTimeout(reconnectTimer);
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  setStatus(`Disconnected. Reconnecting in ${Math.round(delay / 1000)}s...`, "error");
  reconnectTimer = window.setTimeout(openSocket, delay);
}

function closeTerminal() {
  window.clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  socket?.close();
  socket = undefined;
  if (session?.id) {
    client.closeSession({ sessionId: session.id }).catch(() => undefined);
  }
  session = undefined;
  elements.sessionId.textContent = "-";
  setStatus("Closed");
}

async function requestHumanControl() {
  if (!session?.id) {
    setStatus("Connect a session first.", "error");
    return;
  }
  try {
    const response = await client.requestControl({
      sessionId: session.id,
      actorId: "human",
      actorKind: "human",
      reason: "manual operation",
    });
    elements.controlState.textContent = `${response.lease?.actorKind ?? "human"} active`;
    setStatus("Human control lease active", "ok");
  } catch (error) {
    setStatus(`Control request failed: ${errorMessage(error)}`, "error");
  }
}

function setStatus(message: string, tone: "ok" | "error" | "neutral" = "neutral") {
  elements.statusLine.textContent = message;
  elements.statusLine.dataset.tone = tone;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char] ?? char);
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}
