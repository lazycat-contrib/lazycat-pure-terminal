import "@wterm/dom/css";
import "./styles.css";

import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { WTerm } from "@wterm/dom";
import { GhosttyCore } from "@wterm/ghostty";
import { createIcons, icons } from "lucide";

import {
  DEFAULT_SETTINGS,
  FONT_EXTENSIONS,
  FONT_MIME_TYPES,
  FONT_PRESETS,
  INITIAL_COLS,
  INITIAL_ROWS,
  MAX_FONT_BYTES,
  STATUS_REFRESH_MS,
  THEMES,
} from "./config";
import { CapabilityService, type Instance } from "./gen/lazycat/webshell/v1/capability_pb";
import { keyEventToTerminalSequence } from "./keyboard";
import { loadSettings, saveSettings as persistSettings } from "./settings";
import { renderShell } from "./shell";
import type { FontPreset, StoredFont, TerminalPane, TerminalTab, TerminalTheme, Tone } from "./types";
import { clampNumber, errorMessage, escapeAttr, escapeHtml, newId, qs, selectorLabel } from "./utils";

const transport = createConnectTransport({ baseUrl: window.location.origin });
const client = createClient(CapabilityService, transport);
const terminalEncoder = new TextEncoder();

const params = new URLSearchParams(window.location.search);
const initialSelector = params.get("name") ?? "";

const elements = renderShell(qs<HTMLDivElement>("#app"));

let settings = loadSettings();
let instances: Instance[] = [];
let selectedSelector = initialSelector;
let tabs: TerminalTab[] = [];
let activeTabId: string | undefined;
let renamingTabId: string | undefined;
let contextPaneId: string | undefined;
let customFonts: FontPreset[] = [];
const loadedFontFaces = new Map<string, FontFace>();

init().catch((error) => setGlobalStatus(`Startup failed: ${errorMessage(error)}`, "error"));

async function init() {
  await loadUploadedFonts();
  renderOptions();
  bindSettings();
  bindActions();
  applySettings();
  createIcons({ icons });
  setInterval(updateActiveDetails, STATUS_REFRESH_MS);
  await loadInstances();
  if (selectedSelector) {
    elements.targetLabel.textContent = selectorLabel(selectedSelector);
    await createTerminalTab(selectedSelector);
  }
}

function saveSettings() {
  persistSettings(settings);
}

function renderOptions() {
  elements.themeSelect.innerHTML = THEMES.map(
    (theme) => `<option value="${theme.id}">${theme.label}</option>`,
  ).join("");
  const customOptions = customFonts.map(
    (font) => `<option value="${font.id}">${escapeHtml(font.label)}</option>`,
  ).join("");
  elements.fontFamily.innerHTML = `
    <optgroup label="Built in">
      ${FONT_PRESETS.map((font) => `<option value="${font.id}">${font.label}</option>`).join("")}
    </optgroup>
    <optgroup label="Uploaded">
      ${customOptions || "<option disabled>No uploaded fonts</option>"}
    </optgroup>
  `;
}

function bindSettings() {
  elements.themeSelect.addEventListener("change", () => {
    settings.themeId = elements.themeSelect.value;
    saveSettings();
    applySettings();
  });
  elements.fontFamily.addEventListener("change", () => {
    settings.fontFamilyId = elements.fontFamily.value;
    saveSettings();
    applySettings();
  });
  elements.tabLayout.addEventListener("change", () => {
    settings.tabLayout = elements.tabLayout.value === "vertical" ? "vertical" : "horizontal";
    saveSettings();
    applySettings();
  });
  elements.fontUpload.addEventListener("change", () => void uploadFont());
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
  elements.scrollbackLimit.addEventListener("change", () => {
    settings.scrollbackLimit = Math.round(
      clampNumber(elements.scrollbackLimit.value, 1000, 100000, DEFAULT_SETTINGS.scrollbackLimit),
    );
    saveSettings();
    applySettings();
  });
  elements.cursorBlink.addEventListener("change", () => {
    settings.cursorBlink = elements.cursorBlink.checked;
    saveSettings();
    applySettings();
  });
  elements.cursorShape.addEventListener("change", () => {
    settings.cursorShape = elements.cursorShape.value === "bar" || elements.cursorShape.value === "underline"
      ? elements.cursorShape.value
      : "block";
    saveSettings();
    applySettings();
  });
  elements.copyOnSelect.addEventListener("change", () => {
    settings.copyOnSelect = elements.copyOnSelect.checked;
    saveSettings();
  });
  elements.debugMode.addEventListener("change", () => {
    settings.debugMode = elements.debugMode.checked;
    saveSettings();
  });
}

function bindActions() {
  elements.refreshInstances.addEventListener("click", () => void loadInstances());
  elements.newTabButton.addEventListener("click", () => void createSelectedTab());
  elements.emptyNewTab.addEventListener("click", () => void createSelectedTab());
  elements.removeFont.addEventListener("click", () => void removeSelectedFont());
  elements.fitTerminal.addEventListener("click", () => activePane()?.term?.focus());
  elements.humanControl.addEventListener("click", () => void requestHumanControl());
  elements.settingsButton.addEventListener("click", () => openSettings());
  elements.closeSettings.addEventListener("click", () => closeSettings());
  elements.instanceButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleInstanceMenu();
  });
  elements.terminalStage.addEventListener("pointerdown", () => {
    activePane()?.term?.focus();
    requestAnimationFrame(() => activePane()?.term?.focus());
  });
  document.addEventListener("click", (event) => {
    if (event.target instanceof Node && !elements.instanceSwitcher.contains(event.target)) {
      closeInstanceMenu();
    }
    if (event.target instanceof Node && !elements.paneMenu.contains(event.target)) {
      closePaneMenu();
    }
  });
  elements.paneMenu.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-pane-action]") : null;
    if (!button) return;
    void runPaneMenuAction(button.dataset.paneAction ?? "");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeInstanceMenu();
      closePaneMenu();
      closeSettings();
      return;
    }
    if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) {
      return;
    }
    if (event.code === "KeyT") {
      event.preventDefault();
      void createSelectedTab();
    } else if (event.code === "KeyW") {
      event.preventDefault();
      closeActiveTab();
    } else if (event.code === "Comma") {
      event.preventDefault();
      openSettings();
    } else if (event.code === "ArrowUp") {
      event.preventDefault();
      void splitActivePane("up");
    } else if (event.code === "ArrowDown") {
      event.preventDefault();
      void splitActivePane("down");
    }
  });
  document.addEventListener("beforeinput", (event) => {
    if (shouldIgnoreGlobalTerminalInput(event.target)) return;
    const data = event.data;
    if (!data) return;
    if (sendActivePaneInput(data)) {
      event.preventDefault();
    }
  });
  document.addEventListener("paste", (event) => {
    if (shouldIgnoreGlobalTerminalInput(event.target)) return;
    const text = event.clipboardData?.getData("text");
    if (!text) return;
    if (sendActivePaneInput(text)) {
      event.preventDefault();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (shouldIgnoreGlobalTerminalInput(event.target)) return;
    const sequence = keyEventToTerminalSequence(event, Boolean(activePane()?.term?.bridge?.cursorKeysApp()));
    if (!sequence) return;
    if (sendActivePaneInput(sequence)) {
      event.preventDefault();
    }
  });
}

function openSettings() {
  elements.settingsPage.hidden = false;
  closeInstanceMenu();
  requestAnimationFrame(() => elements.closeSettings.focus());
}

function closeSettings() {
  elements.settingsPage.hidden = true;
  activePane()?.term?.focus();
}

function toggleInstanceMenu() {
  const open = elements.instanceMenu.hidden;
  elements.instanceMenu.hidden = !open;
  elements.instanceSwitcher.classList.toggle("is-open", open);
  elements.instanceButton.setAttribute("aria-expanded", String(open));
}

function closeInstanceMenu() {
  elements.instanceMenu.hidden = true;
  elements.instanceSwitcher.classList.remove("is-open");
  elements.instanceButton.setAttribute("aria-expanded", "false");
}

function openPaneMenu(clientX: number, clientY: number, paneId: string) {
  contextPaneId = paneId;
  elements.paneMenu.hidden = false;
  elements.paneMenu.style.left = "0";
  elements.paneMenu.style.top = "0";
  updateIcons();
  requestAnimationFrame(() => {
    const margin = 8;
    const rect = elements.paneMenu.getBoundingClientRect();
    const left = Math.max(margin, Math.min(clientX, window.innerWidth - rect.width - margin));
    const top = Math.max(margin, Math.min(clientY, window.innerHeight - rect.height - margin));
    elements.paneMenu.style.left = `${left}px`;
    elements.paneMenu.style.top = `${top}px`;
  });
}

function closePaneMenu() {
  elements.paneMenu.hidden = true;
  elements.paneMenu.style.left = "";
  elements.paneMenu.style.top = "";
  contextPaneId = undefined;
}

async function runPaneMenuAction(action: string) {
  const pane = contextPaneId ? findPaneById(contextPaneId) : activePane();
  const tab = pane ? tabForPane(pane) : undefined;
  closePaneMenu();
  if (tab && pane) {
    activatePane(tab.id, pane.id);
  }
  if (action === "split-up") {
    await splitActivePane("up");
  } else if (action === "split-down") {
    await splitActivePane("down");
  } else if (action === "copy-selection") {
    await copySelection(true);
  }
}

function applySettings() {
  const theme = currentTheme();
  const font = currentFont();
  elements.themeSelect.value = theme.id;
  elements.fontFamily.value = font.id;
  elements.tabLayout.value = settings.tabLayout;
  elements.webshell.dataset.tabLayout = settings.tabLayout;
  updateTabChrome();
  elements.removeFont.disabled = !font.custom;
  settings.themeId = theme.id;
  settings.fontFamilyId = font.id;
  elements.fontSize.value = String(settings.fontSize);
  elements.fontSizeValue.textContent = `${settings.fontSize}px`;
  elements.lineHeight.value = String(settings.lineHeight);
  elements.lineHeightValue.textContent = settings.lineHeight.toFixed(2);
  elements.scrollbackLimit.value = String(settings.scrollbackLimit);
  elements.cursorBlink.checked = settings.cursorBlink;
  elements.cursorShape.value = settings.cursorShape;
  elements.copyOnSelect.checked = settings.copyOnSelect;
  elements.debugMode.checked = settings.debugMode;

  for (const pane of allPanes()) {
    applyThemeToMount(pane.mount);
    pane.term?.resize(pane.term.cols, pane.term.rows);
    requestAnimationFrame(() => pane.term?.resize(pane.term?.cols ?? pane.cols, pane.term?.rows ?? pane.rows));
  }
  updateActiveDetails();
}

function currentTheme(): TerminalTheme {
  return THEMES.find((item) => item.id === settings.themeId) ?? THEMES[0];
}

function currentFont(): FontPreset {
  return [...FONT_PRESETS, ...customFonts].find((item) => item.id === settings.fontFamilyId) ?? FONT_PRESETS[0];
}

function applyThemeToMount(mount: HTMLElement) {
  const theme = currentTheme();
  const font = currentFont();
  const themeClasses = THEMES.map((item) => item.className).filter((value): value is string => Boolean(value));
  mount.classList.remove(...themeClasses);
  const wtermElement = getWTermElement(mount);
  wtermElement.classList.remove(...themeClasses);
  if (theme.className) {
    wtermElement.classList.add(theme.className);
  }
  wtermElement.classList.remove("cursor-shape-block", "cursor-shape-bar", "cursor-shape-underline");
  wtermElement.classList.add(`cursor-shape-${settings.cursorShape}`);
  wtermElement.classList.toggle("cursor-blink", settings.cursorBlink);
  wtermElement.style.setProperty("--term-font-family", font.family);
  wtermElement.style.setProperty("--term-font-size", `${settings.fontSize}px`);
  wtermElement.style.setProperty("--term-line-height", String(settings.lineHeight));
}

function getWTermElement(mount: HTMLElement): HTMLElement {
  if (mount.classList.contains("wterm")) return mount;
  return mount.querySelector<HTMLElement>(".wterm") ?? mount;
}

async function loadUploadedFonts() {
  try {
    const response = await fetch(new URL("./api/fonts", window.location.href), {
      credentials: "same-origin",
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    const fonts = await response.json() as StoredFont[];
    const loaded = await Promise.all(fonts.map(registerStoredFont));
    customFonts = loaded.filter((font): font is FontPreset => Boolean(font));
    setFontStatus(customFonts.length ? `${customFonts.length} uploaded font(s) ready` : "");
  } catch (error) {
    setFontStatus(`Font load failed: ${errorMessage(error)}`, "error");
  }
}

async function uploadFont() {
  const file = elements.fontUpload.files?.[0];
  elements.fontUpload.value = "";
  if (!file) return;

  try {
    validateFontFile(file);
    const url = new URL("./api/fonts", window.location.href);
    url.searchParams.set("filename", file.name);
    const response = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": file.type || mimeTypeForFont(file.name) },
      body: file,
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    const stored = await response.json() as StoredFont;
    const preset = await registerStoredFont(stored);
    if (!preset) throw new Error("font registration failed");
    customFonts = [...customFonts.filter((font) => font.id !== preset.id), preset];
    settings.fontFamilyId = preset.id;
    saveSettings();
    renderOptions();
    applySettings();
    setFontStatus(`${preset.label} ready`, "ok");
  } catch (error) {
    setFontStatus(`Font upload failed: ${errorMessage(error)}`, "error");
  }
}

async function removeSelectedFont() {
  const font = currentFont();
  if (!font.custom) return;
  const id = font.id.replace(/^custom:/, "");
  const response = await fetch(new URL(`./api/fonts/${encodeURIComponent(id)}`, window.location.href), {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!response.ok && response.status !== 404) {
    setFontStatus(`Font delete failed: ${await response.text()}`, "error");
    return;
  }
  const face = loadedFontFaces.get(font.id);
  if (face) {
    document.fonts.delete(face);
    loadedFontFaces.delete(font.id);
  }
  customFonts = customFonts.filter((item) => item.id !== font.id);
  settings.fontFamilyId = DEFAULT_SETTINGS.fontFamilyId;
  saveSettings();
  renderOptions();
  applySettings();
  setFontStatus(`${font.label} removed`);
}

function validateFontFile(file: File) {
  const lowerName = file.name.toLowerCase();
  if (!FONT_EXTENSIONS.some((extension) => lowerName.endsWith(extension))) {
    throw new Error("only .woff, .woff2, .ttf, and .otf are allowed");
  }
  if (file.type && !FONT_MIME_TYPES.has(file.type)) {
    throw new Error(`unsupported font MIME type: ${file.type}`);
  }
  if (file.size <= 0 || file.size > MAX_FONT_BYTES) {
    throw new Error("font must be between 1 byte and 10 MB");
  }
}

async function registerStoredFont(font: StoredFont): Promise<FontPreset | undefined> {
  try {
    const presetId = `custom:${font.id}`;
    const fontUrl = new URL(font.url, window.location.href).toString();
    const face = new FontFace(font.family, `url("${fontUrl}")`, { display: "swap" });
    await face.load();
    const previous = loadedFontFaces.get(presetId);
    if (previous) {
      document.fonts.delete(previous);
    }
    document.fonts.add(face);
    loadedFontFaces.set(presetId, face);
    return {
      id: presetId,
      label: font.label,
      family: quoteFontFamily(font.family),
      custom: true,
    };
  } catch (error) {
    console.warn("failed to load uploaded font", font.label, error);
    return undefined;
  }
}

function mimeTypeForFont(name: string): string {
  const lowerName = name.toLowerCase();
  if (lowerName.endsWith(".woff2")) return "font/woff2";
  if (lowerName.endsWith(".woff")) return "font/woff";
  if (lowerName.endsWith(".ttf")) return "font/ttf";
  if (lowerName.endsWith(".otf")) return "font/otf";
  return "application/octet-stream";
}

function quoteFontFamily(family: string): string {
  return `"${family.replace(/["\\]/g, "\\$&")}", ui-monospace, monospace`;
}

function setFontStatus(message: string, tone: Tone = "neutral") {
  elements.fontStatus.textContent = message;
  elements.fontStatus.dataset.tone = tone;
}

async function loadInstances() {
  setGlobalStatus("Loading instances...");
  try {
    const response = await client.listInstances({});
    instances = response.instances;
    selectDefaultInstance();
    renderInstances();
    setGlobalStatus(instances.length ? "Instances loaded" : "No instances returned");
  } catch (error) {
    renderInstances();
    setGlobalStatus(`Instance load failed: ${errorMessage(error)}`, "error");
  }
}

function selectDefaultInstance() {
  const selected = instances.find((instance) => instance.selector === selectedSelector && instance.status === "running");
  if (selected) return;
  const running = instances.find((instance) => instance.status === "running" && instance.selector);
  selectedSelector = running?.selector ?? selectedSelector;
  elements.targetLabel.textContent = selectedSelector ? selectorLabel(selectedSelector) : "No instance selected";
  elements.instanceStatusDot.dataset.status = selectedSelector ? selectedInstance()?.status ?? "unknown" : "unknown";
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
        </span>
        <em class="${running ? "ok" : "muted"}">${escapeHtml(instance.status ?? "unknown")}</em>
      </button>
    `;
  }).join("");
  elements.instanceList.querySelectorAll<HTMLButtonElement>(".instance-row").forEach((button) => {
    button.addEventListener("click", () => {
      selectedSelector = button.dataset.selector ?? "";
      elements.targetLabel.textContent = selectedSelector ? selectorLabel(selectedSelector) : "No instance selected";
      closeInstanceMenu();
      renderInstances();
    });
  });
}

async function createSelectedTab() {
  if (!selectedSelector) {
    setGlobalStatus("Select a running instance first.", "error");
    return;
  }
  await createTerminalTab(selectedSelector);
}

async function createTerminalTab(selector: string) {
  const tab = makeTab(selector);
  tabs = [...tabs, tab];
  elements.terminalStage.appendChild(tab.mount);
  activateTab(tab.id);
  await createPane(tab, "down");
}

function makeTab(selector: string): TerminalTab {
  const id = newId();
  const mount = document.createElement("div");
  mount.className = "tab-mount";
  mount.dataset.tabId = id;
  mount.setAttribute("role", "tabpanel");
  mount.setAttribute("aria-label", selector);
  return {
    id,
    selector,
    label: selectorLabel(selector),
    mount,
    panes: [],
    closing: false,
  };
}

function makePane(tab: TerminalTab): TerminalPane {
  const id = newId();
  const mount = document.createElement("div");
  mount.className = "terminal-mount";
  mount.dataset.paneId = id;
  mount.tabIndex = 0;
  mount.setAttribute("role", "group");
  mount.setAttribute("aria-label", `${tab.label} pane`);
  mount.addEventListener("pointerdown", () => activatePane(tab.id, id));
  mount.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    activatePane(tab.id, id);
    openPaneMenu(event.clientX, event.clientY, id);
  });
  mount.addEventListener("mouseup", () => {
    if (settings.copyOnSelect) {
      scheduleCopySelection();
    }
  });
  mount.addEventListener("touchend", () => {
    if (settings.copyOnSelect) {
      scheduleCopySelection();
    }
  });
  applyThemeToMount(mount);
  return {
    id,
    tabId: tab.id,
    selector: tab.selector,
    label: tab.label,
    title: tab.label,
    status: "Idle",
    tone: "neutral",
    controlState: "human ready",
    mount,
    reconnectDelay: 1000,
    closing: false,
    cols: INITIAL_COLS,
    rows: INITIAL_ROWS,
  };
}

async function createPane(tab: TerminalTab, placement: "up" | "down") {
  const pane = makePane(tab);
  const referencePane = activePane(tab);
  const referenceIndex = referencePane ? tab.panes.findIndex((item) => item.id === referencePane.id) : -1;
  const insertIndex = referenceIndex < 0 ? tab.panes.length : placement === "up" ? referenceIndex : referenceIndex + 1;
  tab.panes.splice(insertIndex, 0, pane);
  const nextSibling = tab.mount.children[insertIndex] ?? null;
  tab.mount.insertBefore(pane.mount, nextSibling);
  tab.activePaneId = pane.id;
  renderPaneLayout(tab);
  activatePane(tab.id, pane.id);
  setPaneStatus(pane, "Creating session...");

  try {
    const response = await client.createSession({
      selector: tab.selector,
      cols: INITIAL_COLS,
      rows: INITIAL_ROWS,
      metadata: { frontend: "wterm-ghostty", tabId: tab.id, paneId: pane.id, split: placement },
    });
    pane.session = response.session;
    setPaneStatus(pane, "Loading Ghostty core...");
    await mountTerminal(pane);
    openSocket(pane);
  } catch (error) {
    setPaneStatus(pane, `Connect failed: ${errorMessage(error)}`, "error");
  }
}

async function splitActivePane(placement: "up" | "down") {
  const tab = activeTab();
  if (!tab) {
    await createSelectedTab();
    return;
  }
  await createPane(tab, placement);
}

function renderPaneLayout(tab: TerminalTab) {
  tab.mount.style.gridTemplateRows = `repeat(${Math.max(1, tab.panes.length)}, minmax(0, 1fr))`;
  for (const pane of tab.panes) {
    pane.mount.classList.toggle("active-pane", pane.id === tab.activePaneId);
  }
  requestAnimationFrame(() => {
    for (const pane of tab.panes) {
      pane.term?.resize(pane.term.cols, pane.term.rows);
    }
  });
}

async function mountTerminal(pane: TerminalPane) {
  pane.term?.destroy();
  pane.mount.innerHTML = "";
  applyThemeToMount(pane.mount);

  const core = await GhosttyCore.load({
    scrollbackLimit: settings.scrollbackLimit,
  });
  if (pane.closing) return;

  const term = new WTerm(pane.mount, {
    core,
    cols: INITIAL_COLS,
    rows: INITIAL_ROWS,
    autoResize: true,
    cursorBlink: settings.cursorBlink,
    debug: settings.debugMode,
    onTitle: (title) => updatePaneTitle(pane, title),
    onData: (data) => {
      if (pane.socket?.readyState === WebSocket.OPEN) {
        pane.socket.send(terminalEncoder.encode(data));
      }
    },
    onResize: (cols, rows) => {
      pane.cols = cols;
      pane.rows = rows;
      if (pane.socket?.readyState === WebSocket.OPEN) {
        pane.socket.send(JSON.stringify({ type: "resize", cols, rows }));
      }
      updateActiveDetails();
    },
  });
  pane.term = term;
  await term.init();
  applyThemeToMount(pane.mount);
  if (activeTabId === pane.tabId && activePane()?.id === pane.id) {
    term.focus();
  }
}

function openSocket(pane: TerminalPane) {
  if (!pane.session?.id) return;
  const url = new URL("./ws/terminal", window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("session_id", pane.session.id);
  url.searchParams.set("cols", String(pane.term?.cols ?? INITIAL_COLS));
  url.searchParams.set("rows", String(pane.term?.rows ?? INITIAL_ROWS));

  pane.socket = new WebSocket(url);
  pane.socket.binaryType = "arraybuffer";
  pane.socket.addEventListener("open", () => {
    pane.reconnectDelay = 1000;
    setPaneStatus(pane, "Connected", "ok");
    if (activeTabId === pane.tabId && activePane()?.id === pane.id) {
      pane.term?.focus();
    }
  });
  pane.socket.addEventListener("message", (event) => handleSocketMessage(pane, event));
  pane.socket.addEventListener("close", () => scheduleReconnect(pane));
  pane.socket.addEventListener("error", () => setPaneStatus(pane, "Socket error", "error"));
}

function handleSocketMessage(pane: TerminalPane, event: MessageEvent) {
  if (event.data instanceof ArrayBuffer) {
    pane.term?.write(new Uint8Array(event.data));
    return;
  }
  if (event.data instanceof Blob) {
    event.data.arrayBuffer().then((buffer) => pane.term?.write(new Uint8Array(buffer)));
    return;
  }
  handleServerText(pane, String(event.data));
}

function handleServerText(pane: TerminalPane, text: string) {
  try {
    const event = JSON.parse(text) as { type?: string; message?: string; exit_code?: number };
    if (event.type === "ready") setPaneStatus(pane, "Shell ready", "ok");
    if (event.type === "error") setPaneStatus(pane, event.message ?? "Terminal error", "error");
    if (event.type === "process-exit") setPaneStatus(pane, `Process exited: ${event.exit_code ?? -1}`, "error");
  } catch {
    pane.term?.write(text);
  }
}

function scheduleReconnect(pane: TerminalPane) {
  if (pane.closing || !pane.session?.id) return;
  window.clearTimeout(pane.reconnectTimer);
  const delay = pane.reconnectDelay;
  pane.reconnectDelay = Math.min(pane.reconnectDelay * 2, 30000);
  setPaneStatus(pane, `Disconnected. Reconnecting in ${Math.round(delay / 1000)}s...`, "error");
  pane.reconnectTimer = window.setTimeout(() => openSocket(pane), delay);
}

function activateTab(tabId: string) {
  activeTabId = tabId;
  for (const tab of tabs) {
    const active = tab.id === tabId;
    tab.mount.classList.toggle("active", active);
    tab.mount.setAttribute("aria-hidden", active ? "false" : "true");
  }
  renderTabs();
  updateActiveDetails();
  activePane()?.term?.focus();
}

function activatePane(tabId: string, paneId: string) {
  const tab = tabs.find((item) => item.id === tabId);
  if (!tab) return;
  activeTabId = tabId;
  tab.activePaneId = paneId;
  renderPaneLayout(tab);
  renderTabs();
  updateActiveDetails();
  activePane(tab)?.term?.focus();
}

function renderTabs() {
  updateTabChrome();
  if (!tabs.length) {
    elements.tabList.innerHTML = `<div class="empty-tab">No sessions</div>`;
    updateIcons();
    return;
  }
  elements.tabList.innerHTML = tabs.map((tab) => {
    const active = tab.id === activeTabId;
    const renaming = renamingTabId === tab.id;
    const displayName = tabDisplayName(tab);
    const named = Boolean(tab.customTitle?.trim());
    const title = tabCurrentTitle(tab);
    const label = renaming
      ? `<input class="tab-rename" data-rename-tab="${escapeAttr(tab.id)}" value="${escapeAttr(displayName)}" aria-label="Rename tab" spellcheck="false" />`
      : `<span class="tab-title">${escapeHtml(displayName)}</span>`;
    return `
      <div class="tab ${active ? "active" : ""} ${named ? "named" : ""}">
        <div class="tab-main" id="tab-${escapeAttr(tab.id)}" role="tab" tabindex="0" aria-selected="${active}" data-tab-id="${escapeAttr(tab.id)}" title="${escapeAttr(title)}">
          <span class="tab-status" data-tone="${tabTone(tab)}"></span>
          ${label}
        </div>
        <button class="tab-close" data-close-tab="${escapeAttr(tab.id)}" type="button" aria-label="Close tab" title="Close tab">
          <i data-lucide="x"></i>
        </button>
      </div>
    `;
  }).join("");
  elements.tabList.querySelectorAll<HTMLElement>(".tab-main[data-tab-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      if (event.target instanceof HTMLInputElement) return;
      activateTab(button.dataset.tabId ?? "");
    });
    button.addEventListener("dblclick", (event) => {
      event.preventDefault();
      startRenamingTab(button.dataset.tabId ?? "");
    });
    button.addEventListener("keydown", (event) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activateTab(button.dataset.tabId ?? "");
      } else if (event.key === "F2") {
        event.preventDefault();
        startRenamingTab(button.dataset.tabId ?? "");
      }
    });
  });
  elements.tabList.querySelectorAll<HTMLInputElement>(".tab-rename[data-rename-tab]").forEach((input) => {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commitTabRename(input.dataset.renameTab ?? "", input.value);
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelTabRename();
      }
    });
    input.addEventListener("blur", () => commitTabRename(input.dataset.renameTab ?? "", input.value));
  });
  elements.tabList.querySelectorAll<HTMLElement>("[data-close-tab]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      closeTab(button.dataset.closeTab ?? "");
    });
    button.addEventListener("auxclick", (event) => event.stopPropagation());
  });
  elements.tabList.querySelectorAll<HTMLElement>(".tab").forEach((tabElement) => {
    tabElement.addEventListener("auxclick", (event) => {
      if (event.button !== 1) return;
      const tabId = tabElement.querySelector<HTMLElement>("[data-tab-id]")?.dataset.tabId;
      if (tabId) closeTab(tabId);
    });
  });
  updateIcons();
  focusRenameInput();
}

function updateTabChrome() {
  elements.webshell.classList.toggle("has-named-tabs", tabs.some((tab) => Boolean(tab.customTitle?.trim())));
}

function tabDisplayName(tab: TerminalTab): string {
  return tab.customTitle?.trim() || String(tabs.findIndex((item) => item.id === tab.id) + 1);
}

function startRenamingTab(tabId: string) {
  const tab = tabs.find((item) => item.id === tabId);
  if (!tab) return;
  renamingTabId = tabId;
  renderTabs();
}

function focusRenameInput() {
  if (!renamingTabId) return;
  requestAnimationFrame(() => {
    const input = elements.tabList.querySelector<HTMLInputElement>(`.tab-rename[data-rename-tab="${CSS.escape(renamingTabId ?? "")}"]`);
    input?.focus();
    input?.select();
  });
}

function commitTabRename(tabId: string, value: string) {
  if (renamingTabId !== tabId) return;
  const tab = tabs.find((item) => item.id === tabId);
  renamingTabId = undefined;
  if (!tab) {
    renderTabs();
    return;
  }
  const trimmed = value.trim();
  const defaultName = String(tabs.findIndex((item) => item.id === tab.id) + 1);
  tab.customTitle = trimmed && trimmed !== defaultName ? trimmed : undefined;
  renderTabs();
  updateActiveDetails();
  activePane()?.term?.focus();
}

function cancelTabRename() {
  renamingTabId = undefined;
  renderTabs();
  activePane()?.term?.focus();
}

function closeActiveTab() {
  const tab = activeTab();
  if (!tab) return;
  closeTab(tab.id);
}

function closeTab(tabId: string) {
  const tab = tabs.find((item) => item.id === tabId);
  if (!tab) return;

  tab.closing = true;
  for (const pane of tab.panes) {
    pane.closing = true;
    window.clearTimeout(pane.reconnectTimer);
    pane.socket?.close();
    pane.socket = undefined;
    pane.term?.destroy();
    if (pane.session?.id) {
      client.closeSession({ sessionId: pane.session.id }).catch(() => undefined);
    }
  }
  tab.mount.remove();

  const index = tabs.findIndex((item) => item.id === tabId);
  tabs = tabs.filter((item) => item.id !== tabId);
  if (activeTabId === tabId) {
    activeTabId = tabs[Math.max(0, index - 1)]?.id;
  }
  if (activeTabId) {
    activateTab(activeTabId);
  } else {
    renderTabs();
    updateActiveDetails();
    setGlobalStatus("Closed");
  }
}

async function requestHumanControl() {
  const pane = activePane();
  if (!pane?.session?.id) {
    setGlobalStatus("Connect a session first.", "error");
    return;
  }
  try {
    const response = await client.requestControl({
      sessionId: pane.session.id,
      actorId: "human",
      actorKind: "human",
      reason: "manual operation",
    });
    pane.controlState = `${response.lease?.actorKind ?? "human"} active`;
    setPaneStatus(pane, "Human control lease active", "ok");
  } catch (error) {
    setPaneStatus(pane, `Control request failed: ${errorMessage(error)}`, "error");
  }
}

function updatePaneTitle(pane: TerminalPane, title: string) {
  pane.title = title.trim() || pane.label;
  renderTabs();
  updateActiveDetails();
}

function updateActiveDetails() {
  const tab = activeTab();
  const pane = activePane(tab);
  if (!tab || !pane) {
    elements.emptyState.hidden = false;
    elements.targetLabel.textContent = selectedSelector ? selectorLabel(selectedSelector) : "Instance";
    elements.instanceStatusDot.dataset.status = selectedInstance()?.status ?? "unknown";
    setGlobalStatus("Idle");
    document.title = "Pure Terminal";
    return;
  }

  elements.emptyState.hidden = true;
  elements.targetLabel.textContent = selectorLabel(tab.selector);
  elements.instanceStatusDot.dataset.status = instanceForSelector(tab.selector)?.status ?? "running";
  setGlobalStatus(pane.status, pane.tone);
  document.title = `${tabCurrentTitle(tab)} - Pure Terminal`;
}

function setPaneStatus(pane: TerminalPane, message: string, tone: Tone = "neutral") {
  pane.status = message;
  pane.tone = tone;
  renderTabs();
  if (activeTabId === pane.tabId && activePane()?.id === pane.id) {
    setGlobalStatus(message, tone);
    updateActiveDetails();
  }
}

function setGlobalStatus(message: string, tone: Tone = "neutral") {
  elements.statusLine.textContent = message;
  elements.statusLine.dataset.tone = tone;
}

function sendActivePaneInput(data: string): boolean {
  const pane = activePane();
  if (!pane || pane.socket?.readyState !== WebSocket.OPEN) {
    activePane()?.term?.focus();
    return false;
  }
  pane.socket.send(terminalEncoder.encode(data));
  return true;
}

function shouldIgnoreGlobalTerminalInput(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(".settings-page, .switcher-menu, .topbar, input, textarea, select, button")) return true;
  return Boolean(target.closest(".wterm textarea"));
}

function activeTab(): TerminalTab | undefined {
  return tabs.find((tab) => tab.id === activeTabId);
}

function activePane(tab = activeTab()): TerminalPane | undefined {
  if (!tab) return undefined;
  return tab.panes.find((pane) => pane.id === tab.activePaneId) ?? tab.panes[0];
}

function allPanes(): TerminalPane[] {
  return tabs.flatMap((tab) => tab.panes);
}

function findPaneById(id: string): TerminalPane | undefined {
  return allPanes().find((pane) => pane.id === id);
}

function tabForPane(pane: TerminalPane): TerminalTab | undefined {
  return tabs.find((tab) => tab.id === pane.tabId);
}

function scheduleCopySelection() {
  requestAnimationFrame(() => void copySelection(false));
}

async function copySelection(report: boolean): Promise<boolean> {
  const text = window.getSelection()?.toString() ?? "";
  if (!text) {
    if (report) setGlobalStatus("No selection to copy");
    return false;
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      fallbackCopyText(text);
    }
    if (report) setGlobalStatus("Selection copied", "ok");
    return true;
  } catch (error) {
    if (report) setGlobalStatus(`Copy failed: ${errorMessage(error)}`, "error");
    return false;
  }
}

function fallbackCopyText(text: string) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function tabTone(tab: TerminalTab): Tone {
  if (tab.panes.some((pane) => pane.tone === "error")) return "error";
  return activePane(tab)?.tone ?? "neutral";
}

function tabCurrentTitle(tab: TerminalTab): string {
  return activePane(tab)?.title || tab.label;
}

function selectorLabel(selector: string): string {
  return selector.split("@")[0] || selector;
}

function selectedInstance(): Instance | undefined {
  return instances.find((instance) => instance.selector === selectedSelector);
}

function instanceForSelector(selector: string): Instance | undefined {
  return instances.find((instance) => instance.selector === selector);
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function updateIcons() {
  createIcons({ icons });
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
