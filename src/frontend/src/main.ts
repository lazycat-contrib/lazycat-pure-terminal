import "./styles.css";

import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createIcons, icons } from "lucide";
import { getBuiltinTheme, parseGhosttyTheme, type GhosttyTheme, type ResttyFontSource } from "restty";
import { Terminal } from "restty/xterm";

import {
  DEFAULT_SETTINGS,
  FONT_EXTENSIONS,
  FONT_MIME_TYPES,
  FONT_PRESETS,
  INITIAL_COLS,
  INITIAL_ROWS,
  MAX_FONT_BYTES,
  PREINSTALLED_FONT_BASE,
  STATUS_REFRESH_MS,
  THEMES,
} from "./config";
import { CapabilityService, type Instance, type Session } from "./gen/lazycat/webshell/v1/capability_pb";
import { translate, type MessageKey } from "./i18n";
import { encodeMobileShortcutKeyInput } from "./keyboard";
import { loadSettings, saveSettings as persistSettings } from "./settings";
import { renderShell } from "./shell";
import { MAX_PENDING_INPUT_BYTES, monotonicSequence, parseTerminalServerMessage } from "./terminal-protocol";
import type { FontPreset, SplitAxis, SplitNode, SplitPlacement, StoredFont, TerminalPane, TerminalTab, TerminalTheme, Tone } from "./types";
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
const mobileSticky = {
  ctrl: false,
  alt: false,
  shift: false,
};
let mobileRepeatTimer: number | undefined;
let mobileRepeatInterval: number | undefined;
let terminalResizeTimer: number | undefined;

init().catch((error) => setGlobalStatus(tr("status.startupFailed", { message: errorMessage(error) }), "error"));

async function init() {
  await loadUploadedFonts();
  renderOptions();
  bindSettings();
  bindActions();
  applySettings();
  createIcons({ icons });
  setInterval(updateActiveDetails, STATUS_REFRESH_MS);
  await loadInstances();
  await restoreSessions();
  if (selectedSelector) {
    elements.targetLabel.textContent = selectorLabel(selectedSelector);
    if (!tabs.some((tab) => tab.selector === selectedSelector)) {
      await createTerminalTab(selectedSelector);
    }
  }
}

function saveSettings() {
  persistSettings(settings);
}

function tr(key: MessageKey, values?: Record<string, string | number>): string {
  return translate(settings.locale, key, values);
}

function applyI18n() {
  document.documentElement.lang = settings.locale === "zh-CN" ? "zh-CN" : settings.locale === "en" ? "en" : navigator.language || "en";
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((element) => {
    const key = element.dataset.i18n as MessageKey | undefined;
    if (key) element.textContent = tr(key);
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((element) => {
    const key = element.dataset.i18nTitle as MessageKey | undefined;
    if (key) element.title = tr(key);
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-aria]").forEach((element) => {
    const key = element.dataset.i18nAria as MessageKey | undefined;
    if (key) element.setAttribute("aria-label", tr(key));
  });
}

function renderOptions() {
  elements.themeSelect.innerHTML = THEMES.map(
    (theme) => `<option value="${theme.id}">${theme.label}</option>`,
  ).join("");
  const customOptions = customFonts.map(
    (font) => `<option value="${font.id}">${escapeHtml(font.label)}</option>`,
  ).join("");
  elements.fontFamily.innerHTML = `
    <optgroup label="${escapeAttr(tr("font.builtIn"))}">
      ${FONT_PRESETS.map((font) => `<option value="${font.id}">${font.label}</option>`).join("")}
    </optgroup>
    <optgroup label="${escapeAttr(tr("font.uploaded"))}">
      ${customOptions || `<option disabled>${escapeHtml(tr("font.noUploaded"))}</option>`}
    </optgroup>
  `;
}

function bindSettings() {
  elements.localeSelect.addEventListener("change", () => {
    settings.locale = elements.localeSelect.value === "en" || elements.localeSelect.value === "zh-CN"
      ? elements.localeSelect.value
      : "auto";
    saveSettings();
    renderOptions();
    applySettings();
  });
  elements.themeSelect.addEventListener("change", () => {
    settings.themeId = elements.themeSelect.value;
    saveSettings();
    applySettings();
  });
  elements.fontFamily.addEventListener("change", () => {
    settings.fontFamilyId = elements.fontFamily.value;
    saveSettings();
    applySettings({ resizeTerminals: true });
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
    applySettings({ resizeTerminals: true });
  });
  elements.lineHeight.addEventListener("input", () => {
    settings.lineHeight = Number(elements.lineHeight.value);
    saveSettings();
    applySettings({ resizeTerminals: true });
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
  elements.autoRestartSessions.addEventListener("change", () => {
    settings.autoRestartSessions = elements.autoRestartSessions.checked;
    saveSettings();
    syncRestartPolicyToServer();
    if (settings.autoRestartSessions) {
      void connectRestoredPanes();
    }
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
  elements.homeButton.addEventListener("click", () => void navigateLightOSHome());
  elements.settingsButton.addEventListener("click", () => openSettings());
  elements.closeSettings.addEventListener("click", () => closeSettings());
  bindLifecycleEvents();
  bindMobileShortcuts();
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
    } else if (event.code === "ArrowLeft") {
      event.preventDefault();
      void splitActivePane("left");
    } else if (event.code === "ArrowRight") {
      event.preventDefault();
      void splitActivePane("right");
    }
  });
}

function bindLifecycleEvents() {
  window.addEventListener("online", () => void connectRestoredPanes());
  window.addEventListener("focus", () => {
    scheduleTerminalSizeRefresh();
    void connectRestoredPanes();
  });
  window.addEventListener("resize", scheduleTerminalSizeRefresh);
  window.addEventListener("orientationchange", scheduleTerminalSizeRefresh);
  window.visualViewport?.addEventListener("resize", scheduleTerminalSizeRefresh);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    scheduleTerminalSizeRefresh();
    void connectRestoredPanes();
  });
}

function bindMobileShortcuts() {
  elements.mobileShortcuts.addEventListener("click", (event) => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-mobile-shortcut]")
      : null;
    if (!button || button.dataset.mobileRepeat === "true") return;
    void runMobileShortcut(button.dataset.mobileShortcut ?? "");
  });

  elements.mobileShortcuts.querySelectorAll<HTMLButtonElement>("[data-mobile-repeat='true']").forEach((button) => {
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      button.setPointerCapture?.(event.pointerId);
      const shortcut = button.dataset.mobileShortcut ?? "";
      void runMobileShortcut(shortcut, { keepModifiers: true });
      window.clearTimeout(mobileRepeatTimer);
      window.clearInterval(mobileRepeatInterval);
      mobileRepeatTimer = window.setTimeout(() => {
        mobileRepeatInterval = window.setInterval(() => void runMobileShortcut(shortcut, { keepModifiers: true }), 86);
      }, 360);
    });
    const stopRepeat = () => {
      stopMobileShortcutRepeat();
      clearMobileSticky();
    };
    button.addEventListener("pointerup", stopRepeat);
    button.addEventListener("pointercancel", stopRepeat);
    button.addEventListener("lostpointercapture", stopRepeat);
  });
  updateMobileShortcutState();
}

function stopMobileShortcutRepeat() {
  window.clearTimeout(mobileRepeatTimer);
  window.clearInterval(mobileRepeatInterval);
  mobileRepeatTimer = undefined;
  mobileRepeatInterval = undefined;
}

async function runMobileShortcut(shortcut: string, options: { keepModifiers?: boolean } = {}) {
  if (shortcut === "ctrl" || shortcut === "alt" || shortcut === "shift") {
    mobileSticky[shortcut] = !mobileSticky[shortcut];
    updateMobileShortcutState();
    activePane()?.term?.focus();
    return;
  }

  if (shortcut === "paste") {
    let text = "";
    try {
      text = await navigator.clipboard?.readText?.() ?? "";
    } catch {
      text = "";
    }
    if (text) sendActivePaneInput(text);
    clearMobileSticky();
    activePane()?.term?.focus();
    return;
  }

  const data = encodeMobileShortcutKeyInput(shortcut, mobileSticky);
  if (data) {
    sendActivePaneInput(data);
  }
  if (!options.keepModifiers) {
    clearMobileSticky();
  }
  activePane()?.term?.focus();
}

function clearMobileSticky() {
  mobileSticky.ctrl = false;
  mobileSticky.alt = false;
  mobileSticky.shift = false;
  updateMobileShortcutState();
}

function updateMobileShortcutState() {
  elements.mobileShortcuts.querySelectorAll<HTMLButtonElement>("[data-mobile-modifier]").forEach((button) => {
    const modifier = button.dataset.mobileModifier;
    const active = modifier === "ctrl" || modifier === "alt" || modifier === "shift" ? mobileSticky[modifier] : false;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

async function navigateLightOSHome() {
  closeInstanceMenu();
  closePaneMenu();
  elements.homeButton.disabled = true;
  setGlobalStatus(tr("status.lightosHomeLoading"));
  try {
    const target = await resolveLightOSHomeUrl();
    window.location.assign(target);
  } catch (error) {
    elements.homeButton.disabled = false;
    setGlobalStatus(tr("status.lightosHomeFailed", { message: errorMessage(error) }), "error");
  }
}

async function resolveLightOSHomeUrl(): Promise<string> {
  const response = await fetch(new URL("./api/lightos-admin-info", window.location.href), {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (response.ok) {
    const info = await response.json() as { base_url?: string };
    const baseUrl = info.base_url?.trim();
    if (baseUrl) return buildLightOSHomeUrl(baseUrl);
  }

  const referrerUrl = referrerHomeUrl();
  if (referrerUrl) return referrerUrl;
  throw new Error(response.ok ? "LightOS admin base_url is empty" : await response.text());
}

function buildLightOSHomeUrl(value: string): string {
  const target = new URL(value, window.location.href);
  target.searchParams.set("view", "home");
  return target.toString();
}

function referrerHomeUrl(): string {
  try {
    if (!document.referrer) return "";
    const referrer = new URL(document.referrer);
    if (referrer.origin === window.location.origin) return "";
    referrer.pathname = "/";
    referrer.search = "";
    referrer.hash = "";
    return buildLightOSHomeUrl(referrer.toString());
  } catch {
    return "";
  }
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
  updatePaneMenuForPane(paneId);
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

function updatePaneMenuForPane(paneId: string) {
  const pane = findPaneById(paneId);
  const tab = pane ? tabForPane(pane) : undefined;
  const promote = elements.paneMenu.querySelector<HTMLButtonElement>('[data-pane-action="promote-session-to-tab"]');
  if (promote) {
    promote.hidden = !tab || visiblePanes(tab).length <= 1;
  }
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
  } else if (action === "split-left") {
    await splitActivePane("left");
  } else if (action === "split-right") {
    await splitActivePane("right");
  } else if (action === "copy-selection") {
    await copySelection(true);
  } else if (action === "promote-session-to-tab" && tab && pane) {
    promoteSessionToNewTab(tab, pane);
  } else if (action === "close-active-session" && tab && pane) {
    closeActiveSession(tab, pane);
  }
}

function applySettings(options: { resizeTerminals?: boolean } = {}) {
  const theme = currentTheme();
  const font = currentFont();
  applyI18n();
  elements.localeSelect.value = settings.locale;
  elements.themeSelect.value = theme.id;
  elements.fontFamily.value = font.id;
  elements.tabLayout.value = settings.tabLayout;
  elements.webshell.dataset.tabLayout = settings.tabLayout;
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
  elements.autoRestartSessions.checked = settings.autoRestartSessions;
  elements.debugMode.checked = settings.debugMode;

  for (const pane of allPanes()) {
    applyTerminalAppearance(pane);
    if (options.resizeTerminals) {
      pane.term?.restty?.setFontSize(settings.fontSize);
      pane.term?.restty?.updateSize(true);
    }
  }
  renderTabs();
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
  if (theme.className) {
    mount.classList.add(theme.className);
  }
  mount.classList.remove("cursor-shape-block", "cursor-shape-bar", "cursor-shape-underline");
  mount.classList.add(`cursor-shape-${settings.cursorShape}`);
  mount.classList.toggle("cursor-blink", settings.cursorBlink);
  mount.style.setProperty("--term-font-family", font.family);
  mount.style.setProperty("--term-font-size", `${settings.fontSize}px`);
  mount.style.setProperty("--term-line-height", String(settings.lineHeight));
}

function applyTerminalAppearance(pane: TerminalPane) {
  applyThemeToMount(pane.mount);
  const term = pane.term;
  if (!term?.restty) return;
  const theme = currentResttyTheme();
  if (theme) {
    term.restty.applyTheme(theme, currentTheme().label);
  }
  term.restty.setFontSize(settings.fontSize);
  void term.restty.setFontSources(currentResttyFontSources()).catch((error) => {
    setFontStatus(tr("status.fontLoadFailed", { message: errorMessage(error) }), "error");
  });
  term.restty.updateSize(true);
}

function currentResttyTheme(): GhosttyTheme | null {
  const theme = currentTheme();
  if (theme.ghosttySource) return parseGhosttyTheme(theme.ghosttySource);
  return getBuiltinTheme(theme.ghosttyName) ?? getBuiltinTheme("Ghostty Default Style Dark");
}

function currentResttyFontSources(): ResttyFontSource[] {
  const font = currentFont();
  const sources = font.resttySources ?? FONT_PRESETS[0]?.resttySources ?? [];
  return sources.map(resolveResttyFontSource);
}

function resolveResttyFontSource(source: ResttyFontSource): ResttyFontSource {
  if (source.type !== "url") return source;
  return {
    ...source,
    url: new URL(source.url, window.location.href).toString(),
  };
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
    setFontStatus(customFonts.length ? tr("status.fontsReady", { count: customFonts.length }) : "");
  } catch (error) {
    setFontStatus(tr("status.fontLoadFailed", { message: errorMessage(error) }), "error");
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
    if (!preset) throw new Error(tr("status.fontRegistrationFailed"));
    customFonts = [...customFonts.filter((font) => font.id !== preset.id), preset];
    settings.fontFamilyId = preset.id;
    saveSettings();
    renderOptions();
    applySettings({ resizeTerminals: true });
    setFontStatus(tr("status.fontReady", { name: preset.label }), "ok");
  } catch (error) {
    setFontStatus(tr("status.fontUploadFailed", { message: errorMessage(error) }), "error");
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
    setFontStatus(tr("status.fontDeleteFailed", { message: await response.text() }), "error");
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
  applySettings({ resizeTerminals: true });
  setFontStatus(tr("status.fontRemoved", { name: font.label }));
}

function validateFontFile(file: File) {
  const lowerName = file.name.toLowerCase();
  if (!FONT_EXTENSIONS.some((extension) => lowerName.endsWith(extension))) {
    throw new Error(tr("validation.fontExtension"));
  }
  if (file.type && !FONT_MIME_TYPES.has(file.type)) {
    throw new Error(tr("validation.fontMime", { mimeType: file.type }));
  }
  if (file.size <= 0 || file.size > MAX_FONT_BYTES) {
    throw new Error(tr("validation.fontSize"));
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
      resttySources: [
        { type: "url", url: fontUrl, label: font.label },
        {
          type: "url",
          url: `${PREINSTALLED_FONT_BASE}SymbolsNerdFontMono-Regular.ttf`,
          label: "Symbols Nerd Font Mono",
        },
      ],
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
  setGlobalStatus(tr("status.loadingInstances"));
  try {
    const response = await client.listInstances({});
    instances = response.instances;
    selectDefaultInstance();
    renderInstances();
    setGlobalStatus(instances.length ? tr("status.instancesLoaded") : tr("status.noInstances"));
  } catch (error) {
    renderInstances();
    setGlobalStatus(tr("status.instanceLoadFailed", { message: errorMessage(error) }), "error");
  }
}

function selectDefaultInstance() {
  const selected = instances.find((instance) => instance.selector === selectedSelector && instance.status === "running");
  if (selected) return;
  const running = instances.find((instance) => instance.status === "running" && instance.selector);
  selectedSelector = running?.selector ?? selectedSelector;
  elements.targetLabel.textContent = selectedSelector ? selectorLabel(selectedSelector) : tr("status.noTarget");
  elements.instanceStatusDot.dataset.status = selectedSelector ? selectedInstance()?.status ?? "unknown" : "unknown";
}

function renderInstances() {
  if (!instances.length) {
    elements.instanceList.innerHTML = `<div class="empty">${escapeHtml(tr("status.noInstancesVisible"))}</div>`;
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
      elements.targetLabel.textContent = selectedSelector ? selectorLabel(selectedSelector) : tr("status.noTarget");
      closeInstanceMenu();
      renderInstances();
    });
  });
}

async function restoreSessions() {
  try {
    const response = await client.listSessions({});
    let sessions = response.sessions
      .filter((session) => session.id && session.selector && session.status !== "closed")
      .sort(compareSessionsForRestore);
    if (!settings.autoRestartSessions) {
      await cleanupStoppedSessions(sessions);
      sessions = sessions.filter((session) => session.status === "running");
    }
    if (!sessions.length) return;

    const restoredTabs = new Map<string, { tabId?: string; host: string; title?: string; order: number; sessions: Session[] }>();
    for (const session of sessions) {
      const key = sessionTabKey(session);
      const host = sessionHost(session);
      const title = sessionTabTitle(session);
      const order = sessionMetadataIndex(session, "tabOrder", Number.MAX_SAFE_INTEGER);
      const group = restoredTabs.get(key);
      if (group) {
        group.sessions.push(session);
        group.order = Math.min(group.order, order);
        group.title ??= title;
      } else {
        restoredTabs.set(key, {
          tabId: session.metadata.tabId?.trim() || undefined,
          host,
          title,
          order,
          sessions: [session],
        });
      }
    }

    const groups = [...restoredTabs.values()].sort(
      (left, right) => left.order - right.order || left.host.localeCompare(right.host) || (left.tabId ?? "").localeCompare(right.tabId ?? ""),
    );
    for (const group of groups) {
      const selector = group.sessions[0]?.selector;
      if (!selector) continue;
      const tab = makeTab(selector, group.tabId);
      tab.customTitle = group.title;
      tabs = [...tabs, tab];
      elements.terminalStage.appendChild(tab.mount);
      for (const session of group.sessions.sort(comparePanesForRestore)) {
        await restorePane(tab, session);
      }
      if (!activeTabId) {
        activateTab(tab.id);
      }
    }
    renderTabs();
    updateActiveDetails();
  } catch (error) {
    setGlobalStatus(tr("status.connectFailed", { message: errorMessage(error) }), "error");
  }
}

async function restorePane(tab: TerminalTab, session: Session) {
  const pane = makePane(tab);
  pane.session = session;
  pane.cols = session.cols || INITIAL_COLS;
  pane.rows = session.rows || INITIAL_ROWS;
  const referencePane = activePane(tab);
  tab.panes.push(pane);
  tab.layout = nextPaneLayout(tab.layout, referencePane?.id, pane.id, "down");
  tab.activePaneId ??= pane.id;
  renderPaneLayout(tab);
  setPaneStatus(pane, tr("status.loadingGhostty"));
  await mountTerminal(pane);
  if (shouldConnectRestoredSession(session)) {
    openSocket(pane);
  } else {
    setPaneStatus(pane, tr("status.sessionStopped"), "neutral");
  }
}

function shouldConnectRestoredSession(session: Session): boolean {
  return session.status === "running" || settings.autoRestartSessions;
}

async function cleanupStoppedSessions(sessions: Session[]) {
  await Promise.allSettled(
    sessions
      .filter((session) => session.id && session.status !== "running")
      .map((session) => client.closeSession({ sessionId: session.id })),
  );
}

async function connectRestoredPanes() {
  for (const pane of allPanes()) {
    if (pane.closing || pane.exited || !pane.session?.id) continue;
    if (pane.socket?.readyState === WebSocket.OPEN || pane.socket?.readyState === WebSocket.CONNECTING) continue;
    setPaneStatus(pane, tr("status.loadingGhostty"));
    if (!pane.term) {
      await mountTerminal(pane);
    }
    openSocket(pane);
  }
}

function sessionHost(session: Session): string {
  return session.metadata.host?.trim() || selectorLabel(session.selector || "");
}

function sessionTabKey(session: Session): string {
  return session.metadata.tabId?.trim() || `session:${session.id}`;
}

function sessionTabTitle(session: Session): string | undefined {
  const title = session.metadata.tabTitle?.trim();
  if (!title) return undefined;
  const explicit = session.metadata.tabCustomTitle?.trim().toLowerCase();
  if (explicit === "true") return title;
  if (explicit === "false") return undefined;
  return title === sessionHost(session) ? undefined : title;
}

function compareSessionsForRestore(left: Session, right: Session): number {
  return sessionMetadataIndex(left, "tabOrder", Number.MAX_SAFE_INTEGER) - sessionMetadataIndex(right, "tabOrder", Number.MAX_SAFE_INTEGER)
    || sessionHost(left).localeCompare(sessionHost(right))
    || sessionTabKey(left).localeCompare(sessionTabKey(right))
    || comparePanesForRestore(left, right);
}

function comparePanesForRestore(left: Session, right: Session): number {
  return sessionMetadataIndex(left, "paneOrder", Number.MAX_SAFE_INTEGER) - sessionMetadataIndex(right, "paneOrder", Number.MAX_SAFE_INTEGER)
    || left.id.localeCompare(right.id);
}

function sessionMetadataIndex(session: Session, key: string, fallback: number): number {
  const value = Number.parseInt(session.metadata[key] ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
}

async function createSelectedTab() {
  if (!selectedSelector) {
    setGlobalStatus(tr("status.selectRunningInstance"), "error");
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

function makeTab(selector: string, restoredId?: string): TerminalTab {
  const id = restoredId || newId();
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
  mount.addEventListener("pointerdown", () => {
    const current = findPaneById(id);
    if (current) {
      activatePane(current.tabId, id);
    }
  });
  mount.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const current = findPaneById(id);
    if (!current) return;
    activatePane(current.tabId, id);
    openPaneMenu(event.clientX, event.clientY, id);
  });
  const pane: TerminalPane = {
    id,
    tabId: tab.id,
    selector: tab.selector,
    label: tab.label,
    title: tab.label,
    status: tr("status.idle"),
    tone: "neutral",
    mount,
    reconnectDelay: 1000,
    pendingInput: [],
    pendingInputBytes: 0,
    replaying: false,
    lastOutputSequence: 0,
    exited: false,
    closing: false,
    titleBuffer: "",
    cols: INITIAL_COLS,
    rows: INITIAL_ROWS,
  };
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
  return pane;
}

async function createPane(tab: TerminalTab, placement: SplitPlacement) {
  const pane = makePane(tab);
  const referencePane = activePane(tab);
  tab.panes.push(pane);
  tab.layout = nextPaneLayout(tab.layout, referencePane?.id, pane.id, placement);
  tab.activePaneId = pane.id;
  renderPaneLayout(tab);
  activatePane(tab.id, pane.id, { focus: false });
  setPaneStatus(pane, tr("status.creatingSession"));

  try {
    const response = await client.createSession({
      selector: tab.selector,
      cols: INITIAL_COLS,
      rows: INITIAL_ROWS,
      metadata: {
        frontend: "restty-xterm",
        tabId: tab.id,
        paneId: pane.id,
        tabTitle: tab.customTitle?.trim() ?? "",
        tabCustomTitle: String(Boolean(tab.customTitle?.trim())),
        tabOrder: String(tabOrder(tab)),
        paneOrder: String(paneOrder(tab, pane)),
        split: placement,
        autoRestart: String(settings.autoRestartSessions),
        restartable: String(settings.autoRestartSessions),
      },
    });
    pane.session = response.session;
    syncAllTabMetadata();
    setPaneStatus(pane, tr("status.loadingGhostty"));
    await mountTerminal(pane);
    openSocket(pane);
  } catch (error) {
    setPaneStatus(pane, tr("status.connectFailed", { message: errorMessage(error) }), "error");
  }
}

async function splitActivePane(placement: SplitPlacement) {
  const tab = activeTab();
  if (!tab) {
    await createSelectedTab();
    return;
  }
  await createPane(tab, placement);
}

function renderPaneLayout(tab: TerminalTab) {
  tab.mount.replaceChildren();
  if (tab.layout) {
    tab.mount.appendChild(renderSplitNode(tab, tab.layout));
  }
  updatePaneActiveState(tab);
}

function nextPaneLayout(
  layout: SplitNode | undefined,
  referencePaneId: string | undefined,
  newPaneId: string,
  placement: SplitPlacement,
): SplitNode {
  const newPane = paneLayoutNode(newPaneId);
  if (!layout || !referencePaneId) return newPane;

  const axis = splitAxisForPlacement(placement);
  const insertBefore = placement === "up" || placement === "left";
  const result = insertPaneIntoLayout(layout, referencePaneId, newPane, axis, insertBefore);
  if (result.inserted) return result.node;

  return {
    type: "split",
    axis,
    children: insertBefore ? [newPane, layout] : [layout, newPane],
  };
}

function insertPaneIntoLayout(
  node: SplitNode,
  referencePaneId: string,
  newPane: SplitNode,
  axis: SplitAxis,
  insertBefore: boolean,
): { node: SplitNode; inserted: boolean } {
  if (node.type === "pane") {
    if (node.paneId !== referencePaneId) return { node, inserted: false };
    return {
      node: {
        type: "split",
        axis,
        children: insertBefore ? [newPane, node] : [node, newPane],
      },
      inserted: true,
    };
  }

  let inserted = false;
  const children = node.children.map((child) => {
    if (inserted) return child;
    const result = insertPaneIntoLayout(child, referencePaneId, newPane, axis, insertBefore);
    inserted = result.inserted;
    return result.node;
  });

  return {
    node: inserted ? { ...node, children } : node,
    inserted,
  };
}

function renderSplitNode(tab: TerminalTab, node: SplitNode): HTMLElement {
  if (node.type === "pane") {
    const pane = tab.panes.find((item) => item.id === node.paneId);
    return pane?.mount ?? missingPaneElement(node.paneId);
  }

  const container = document.createElement("div");
  container.className = "split-container";
  container.dataset.splitAxis = node.axis;
  container.style.setProperty("--split-count", String(Math.max(1, node.children.length)));
  for (const child of node.children) {
    container.appendChild(renderSplitNode(tab, child));
  }
  return container;
}

function paneLayoutNode(paneId: string): SplitNode {
  return { type: "pane", paneId };
}

function splitAxisForPlacement(placement: SplitPlacement): SplitAxis {
  return placement === "left" || placement === "right" ? "columns" : "rows";
}

function missingPaneElement(paneId: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "terminal-mount missing-pane";
  element.dataset.paneId = paneId;
  return element;
}

function updatePaneActiveState(tab: TerminalTab) {
  for (const pane of tab.panes) {
    pane.mount.classList.toggle("active-pane", pane.id === tab.activePaneId);
  }
}

async function mountTerminal(pane: TerminalPane) {
  pane.term?.dispose();
  pane.mount.innerHTML = "";
  applyThemeToMount(pane.mount);
  pane.decoder = new TextDecoder();

  const term = new Terminal({
    cols: pane.cols || INITIAL_COLS,
    rows: pane.rows || INITIAL_ROWS,
    createInitialPane: true,
    shortcuts: false,
    defaultContextMenu: false,
    paneStyles: {
      enabled: true,
      splitBackground: "var(--term-bg, #050a12)",
      paneBackground: "var(--term-bg, #050a12)",
      inactivePaneOpacity: 1,
      activePaneOpacity: 1,
      opacityTransitionMs: 0,
      dividerThicknessPx: 0,
    },
    searchUi: false,
    fontSources: currentResttyFontSources(),
    appOptions: {
      renderer: "auto",
      fontPreset: "none",
      fontSize: settings.fontSize,
      ligatures: true,
      autoResize: true,
      attachWindowEvents: true,
      attachCanvasEvents: true,
      touchSelectionMode: "long-press",
      maxScrollbackBytes: Math.max(1_000_000, settings.scrollbackLimit * 160),
      callbacks: {
        onGridSize: (cols, rows) => handleTerminalResize(pane, cols, rows),
      },
    },
  });
  if (pane.closing) return;
  term.onData((data) => {
    sendPaneInput(pane, data);
  });
  pane.term = term;
  term.open(pane.mount);
  applyTerminalAppearance(pane);
  if (activeTabId === pane.tabId && activePane()?.id === pane.id) {
    term.focus();
  }
}

function handleTerminalResize(pane: TerminalPane, cols: number, rows: number) {
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
  const nextCols = Math.max(1, Math.trunc(cols));
  const nextRows = Math.max(1, Math.trunc(rows));
  if (pane.cols === nextCols && pane.rows === nextRows) return;
  pane.cols = nextCols;
  pane.rows = nextRows;
  if (pane.term) {
    pane.term.cols = nextCols;
    pane.term.rows = nextRows;
  }
  if (pane.socket?.readyState === WebSocket.OPEN) {
    pane.socket.send(JSON.stringify({ type: "resize", cols: nextCols, rows: nextRows }));
  }
  updateActiveDetails();
}

function openSocket(pane: TerminalPane) {
  if (!pane.session?.id) return;
  if (pane.socket?.readyState === WebSocket.OPEN || pane.socket?.readyState === WebSocket.CONNECTING) return;
  const url = new URL("./ws/terminal", window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("session_id", pane.session.id);
  url.searchParams.set("cols", String(pane.cols || pane.term?.cols || INITIAL_COLS));
  url.searchParams.set("rows", String(pane.rows || pane.term?.rows || INITIAL_ROWS));
  url.searchParams.set("restart", String(settings.autoRestartSessions));
  url.searchParams.set("replay", "true");
  url.searchParams.set("after", String(pane.lastOutputSequence));
  url.searchParams.set("tab_id", pane.tabId);
  url.searchParams.set("pane_id", pane.id);
  url.searchParams.set("tab_title", tabForPane(pane)?.customTitle?.trim() ?? "");
  url.searchParams.set("tab_custom_title", String(Boolean(tabForPane(pane)?.customTitle?.trim())));
  url.searchParams.set("tab_order", String(tabOrder(tabForPane(pane))));
  url.searchParams.set("pane_order", String(paneOrder(tabForPane(pane), pane)));

  pane.exited = false;
  pane.replaying = true;
  pane.decoder = new TextDecoder();
  pane.socket = new WebSocket(url);
  pane.socket.binaryType = "arraybuffer";
  pane.socket.addEventListener("open", () => {
    pane.reconnectDelay = 1000;
    sendRestartPolicy(pane);
    sendPanePlacement(pane);
    setPaneStatus(pane, tr("status.connected"), "ok");
    if (activeTabId === pane.tabId && activePane()?.id === pane.id) {
      pane.term?.focus();
    }
  });
  pane.socket.addEventListener("message", (event) => handleSocketMessage(pane, event));
  pane.socket.addEventListener("close", () => {
    pane.replaying = false;
    flushPaneDecoder(pane);
    scheduleReconnect(pane);
  });
  pane.socket.addEventListener("error", () => setPaneStatus(pane, tr("status.socketError"), "error"));
}

function syncRestartPolicyToServer() {
  for (const pane of allPanes()) {
    if (pane.session) {
      pane.session.metadata.restartable = String(settings.autoRestartSessions);
    }
    sendRestartPolicy(pane);
  }
}

function sendRestartPolicy(pane: TerminalPane) {
  if (pane.socket?.readyState !== WebSocket.OPEN) return;
  pane.socket.send(JSON.stringify({ type: "restart-policy", enabled: settings.autoRestartSessions }));
}

function syncPanePlacement(pane: TerminalPane) {
  const tab = tabForPane(pane);
  if (pane.session) {
    pane.session.metadata.tabId = pane.tabId;
    pane.session.metadata.paneId = pane.id;
    pane.session.metadata.tabOrder = String(tabOrder(tab));
    pane.session.metadata.paneOrder = String(paneOrder(tab, pane));
    const title = tab?.customTitle?.trim() ?? "";
    if (title) {
      pane.session.metadata.tabTitle = title;
      pane.session.metadata.tabCustomTitle = "true";
    } else {
      delete pane.session.metadata.tabTitle;
      pane.session.metadata.tabCustomTitle = "false";
    }
  }
  sendPanePlacement(pane);
}

function syncAllTabMetadata() {
  for (const pane of allPanes()) {
    syncPanePlacement(pane);
  }
}

function sendPanePlacement(pane: TerminalPane) {
  if (pane.socket?.readyState !== WebSocket.OPEN) return;
  const tab = tabForPane(pane);
  pane.socket.send(JSON.stringify({
    type: "session-placement",
    tab_id: pane.tabId,
    pane_id: pane.id,
    tab_title: tab?.customTitle?.trim() ?? "",
    tab_custom_title: String(Boolean(tab?.customTitle?.trim())),
    tab_order: String(tabOrder(tab)),
    pane_order: String(paneOrder(tab, pane)),
  }));
}

function handleSocketMessage(pane: TerminalPane, event: MessageEvent) {
  if (pane.closing) return;
  if (event.data instanceof ArrayBuffer) {
    writeTerminalBytes(pane, new Uint8Array(event.data));
    return;
  }
  if (event.data instanceof Blob) {
    event.data.arrayBuffer().then((buffer) => {
      if (!pane.closing) writeTerminalBytes(pane, new Uint8Array(buffer));
    });
    return;
  }
  handleServerText(pane, String(event.data));
}

function handleServerText(pane: TerminalPane, text: string) {
  const event = parseTerminalServerMessage(text);
  if (!event) {
    writeTerminalText(pane, text);
    return;
  }
  if (event.type === "ready") {
    setPaneStatus(pane, tr("status.shellReady"), "ok");
  } else if (event.type === "error") {
    pane.replaying = false;
    setPaneStatus(pane, event.message ?? tr("status.terminalError"), "error");
  } else if (event.type === "process-exit") {
    pane.replaying = false;
    pane.exited = true;
    clearPendingInput(pane);
    if (pane.session) {
      pane.session.status = "exited";
    }
    setPaneStatus(pane, tr("status.processExited", { code: event.exit_code ?? -1 }), "error");
  } else if (event.type === "output-sequence") {
    pane.lastOutputSequence = monotonicSequence(pane.lastOutputSequence, event.sequence);
  } else if (event.type === "replay-complete") {
    pane.lastOutputSequence = monotonicSequence(pane.lastOutputSequence, event.last_sequence);
    pane.replaying = false;
    flushPendingInput(pane);
  }
}

function writeTerminalBytes(pane: TerminalPane, bytes: Uint8Array) {
  const decoder = pane.decoder ??= new TextDecoder();
  const text = decoder.decode(bytes, { stream: true });
  if (text) writeTerminalText(pane, text);
}

function flushPaneDecoder(pane: TerminalPane) {
  const text = pane.decoder?.decode();
  if (text) writeTerminalText(pane, text);
  pane.decoder = undefined;
}

function writeTerminalText(pane: TerminalPane, text: string) {
  observeTerminalTitle(pane, text);
  pane.term?.write(text);
}

function observeTerminalTitle(pane: TerminalPane, text: string) {
  pane.titleBuffer = `${pane.titleBuffer}${text}`.slice(-4096);
  const pattern = /\x1b\](?:0|2);([\s\S]*?)(?:\x07|\x1b\\)/g;
  let match: RegExpExecArray | null;
  let title: string | undefined;
  while ((match = pattern.exec(pane.titleBuffer)) !== null) {
    title = match[1]?.replace(/[\x00-\x1f\x7f]/g, "").trim();
  }
  if (title) updatePaneTitle(pane, title);
}

function scheduleReconnect(pane: TerminalPane) {
  if (pane.closing || pane.exited || !pane.session?.id) return;
  window.clearTimeout(pane.reconnectTimer);
  const delay = pane.reconnectDelay;
  pane.reconnectDelay = Math.min(pane.reconnectDelay * 2, 30000);
  setPaneStatus(pane, tr("status.reconnecting", { seconds: Math.round(delay / 1000) }), "error");
  pane.reconnectTimer = window.setTimeout(() => openSocket(pane), delay);
}

function scheduleTerminalSizeRefresh() {
  window.clearTimeout(terminalResizeTimer);
  terminalResizeTimer = window.setTimeout(() => {
    for (const pane of allPanes()) {
      pane.term?.restty?.updateSize(true);
    }
  }, 80);
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

function activatePane(tabId: string, paneId: string, options: { focus?: boolean } = {}) {
  const tab = tabs.find((item) => item.id === tabId);
  if (!tab) return;
  activeTabId = tabId;
  tab.activePaneId = paneId;
  updatePaneActiveState(tab);
  renderTabs();
  updateActiveDetails();
  if (options.focus !== false) {
    activePane(tab)?.term?.focus();
  }
}

function renderTabs() {
  updateTabChrome();
  if (!tabs.length) {
    elements.tabList.innerHTML = `<div class="empty-tab">${escapeHtml(tr("status.noSessions"))}</div>`;
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
      ? `<input class="tab-rename" data-rename-tab="${escapeAttr(tab.id)}" value="${escapeAttr(displayName)}" aria-label="${escapeAttr(tr("action.renameTab"))}" spellcheck="false" />`
      : `<span class="tab-title">${escapeHtml(displayName)}</span>`;
    return `
      <div class="tab ${active ? "active" : ""} ${named ? "named" : ""}">
        <div class="tab-main" id="tab-${escapeAttr(tab.id)}" role="tab" tabindex="0" aria-selected="${active}" data-tab-id="${escapeAttr(tab.id)}" title="${escapeAttr(title)}">
          <span class="tab-status" data-tone="${tabTone(tab)}"></span>
          ${label}
        </div>
        <button class="tab-close" data-close-tab="${escapeAttr(tab.id)}" type="button" aria-label="${escapeAttr(tr("action.closeTab"))}" title="${escapeAttr(tr("action.closeTab"))}">
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
      event.preventDefault();
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
  syncAllTabMetadata();
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
    closePaneSession(pane);
  }
  tab.mount.remove();

  const index = tabs.findIndex((item) => item.id === tabId);
  tabs = tabs.filter((item) => item.id !== tabId);
  if (activeTabId === tabId) {
    activeTabId = tabs[Math.max(0, index - 1)]?.id;
  }
  if (activeTabId) {
    activateTab(activeTabId);
    syncAllTabMetadata();
  } else {
    renderTabs();
    updateActiveDetails();
    setGlobalStatus(tr("status.closed"));
  }
}

function closeActiveSession(tab: TerminalTab, pane: TerminalPane) {
  if (visiblePanes(tab).length <= 1) {
    closeTab(tab.id);
    return;
  }

  const paneIndex = tab.panes.findIndex((item) => item.id === pane.id);
  if (paneIndex < 0) return;

  closePaneSession(pane);
  tab.panes = tab.panes.filter((item) => item.id !== pane.id);
  tab.layout = removePaneFromLayout(tab.layout, pane.id) ?? paneLayoutNode(tab.panes[0].id);
  if (tab.activePaneId === pane.id) {
    tab.activePaneId = tab.panes[Math.min(paneIndex, tab.panes.length - 1)]?.id;
  }
  renderPaneLayout(tab);
  renderTabs();
  updateActiveDetails();
  syncAllTabMetadata();
  activePane(tab)?.term?.focus();
}

function promoteSessionToNewTab(sourceTab: TerminalTab, pane: TerminalPane) {
  if (visiblePanes(sourceTab).length <= 1) return;
  const paneIndex = sourceTab.panes.findIndex((item) => item.id === pane.id);
  if (paneIndex < 0) return;

  sourceTab.panes = sourceTab.panes.filter((item) => item.id !== pane.id);
  sourceTab.layout = removePaneFromLayout(sourceTab.layout, pane.id) ?? paneLayoutNode(sourceTab.panes[0].id);
  if (sourceTab.activePaneId === pane.id) {
    sourceTab.activePaneId = sourceTab.panes[Math.min(paneIndex, sourceTab.panes.length - 1)]?.id;
  }

  const promotedTab = makeTab(sourceTab.selector);
  const title = pane.title.trim();
  if (title && title !== pane.label) {
    promotedTab.customTitle = title;
  }
  pane.tabId = promotedTab.id;
  promotedTab.panes = [pane];
  promotedTab.activePaneId = pane.id;
  promotedTab.layout = paneLayoutNode(pane.id);

  const sourceIndex = tabs.findIndex((item) => item.id === sourceTab.id);
  if (sourceIndex < 0) return;
  tabs = [
    ...tabs.slice(0, sourceIndex + 1),
    promotedTab,
    ...tabs.slice(sourceIndex + 1),
  ];
  sourceTab.mount.after(promotedTab.mount);
  renderPaneLayout(sourceTab);
  renderPaneLayout(promotedTab);
  activateTab(promotedTab.id);
  syncAllTabMetadata();
}

function closePaneSession(pane: TerminalPane) {
  pane.closing = true;
  window.clearTimeout(pane.reconnectTimer);
  pane.socket?.close();
  pane.socket = undefined;
  flushPaneDecoder(pane);
  clearPendingInput(pane);
  pane.term?.dispose();
  pane.term = undefined;
  if (pane.session?.id) {
    client.closeSession({ sessionId: pane.session.id }).catch(() => undefined);
  }
}

function removePaneFromLayout(node: SplitNode | undefined, paneId: string): SplitNode | undefined {
  if (!node) return undefined;
  if (node.type === "pane") {
    return node.paneId === paneId ? undefined : node;
  }
  const children = node.children
    .map((child) => removePaneFromLayout(child, paneId))
    .filter((child): child is SplitNode => Boolean(child));
  if (!children.length) return undefined;
  if (children.length === 1) return children[0];
  return { ...node, children };
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
    elements.targetLabel.textContent = selectedSelector ? selectorLabel(selectedSelector) : tr("status.instance");
    elements.instanceStatusDot.dataset.status = selectedInstance()?.status ?? "unknown";
    setGlobalStatus(tr("status.idle"));
    document.title = tr("app.title");
    return;
  }

  elements.emptyState.hidden = true;
  elements.targetLabel.textContent = selectorLabel(tab.selector);
  elements.instanceStatusDot.dataset.status = instanceForSelector(tab.selector)?.status ?? "running";
  setGlobalStatus(pane.status, pane.tone);
  document.title = `${tabCurrentTitle(tab)} - ${tr("app.title")}`;
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
  return Boolean(pane && sendPaneInput(pane, data));
}

function sendPaneInput(pane: TerminalPane, data: string): boolean {
  if (!pane || pane.closing || pane.exited || !pane.session?.id) {
    activePane()?.term?.focus();
    return false;
  }
  if (pane.socket?.readyState === WebSocket.OPEN && !pane.replaying) {
    pane.socket.send(terminalEncoder.encode(data));
    return true;
  }
  if (!queuePaneInput(pane, data)) {
    activePane()?.term?.focus();
    return false;
  }
  if (pane.socket?.readyState !== WebSocket.CONNECTING && pane.socket?.readyState !== WebSocket.OPEN) {
    openSocket(pane);
  }
  return true;
}

function queuePaneInput(pane: TerminalPane, data: string): boolean {
  const bytes = terminalEncoder.encode(data).byteLength;
  if (bytes <= 0 || bytes > MAX_PENDING_INPUT_BYTES) return false;
  while (pane.pendingInputBytes + bytes > MAX_PENDING_INPUT_BYTES) {
    const dropped = pane.pendingInput.shift();
    if (!dropped) break;
    pane.pendingInputBytes = Math.max(0, pane.pendingInputBytes - terminalEncoder.encode(dropped).byteLength);
  }
  pane.pendingInput.push(data);
  pane.pendingInputBytes += bytes;
  return true;
}

function flushPendingInput(pane: TerminalPane) {
  if (pane.socket?.readyState !== WebSocket.OPEN || pane.replaying) return;
  while (pane.pendingInput.length) {
    const data = pane.pendingInput.shift() ?? "";
    pane.pendingInputBytes = Math.max(0, pane.pendingInputBytes - terminalEncoder.encode(data).byteLength);
    try {
      pane.socket.send(terminalEncoder.encode(data));
    } catch {
      pane.pendingInput.unshift(data);
      pane.pendingInputBytes += terminalEncoder.encode(data).byteLength;
      scheduleReconnect(pane);
      return;
    }
  }
}

function clearPendingInput(pane: TerminalPane) {
  pane.pendingInput = [];
  pane.pendingInputBytes = 0;
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

function visiblePanes(tab: TerminalTab): TerminalPane[] {
  return tab.panes.filter((pane) => !pane.closing);
}

function findPaneById(id: string): TerminalPane | undefined {
  return allPanes().find((pane) => pane.id === id);
}

function tabForPane(pane: TerminalPane): TerminalTab | undefined {
  return tabs.find((tab) => tab.id === pane.tabId);
}

function tabOrder(tab: TerminalTab | undefined): number {
  if (!tab) return tabs.length;
  const index = tabs.findIndex((item) => item.id === tab.id);
  return index >= 0 ? index : tabs.length;
}

function paneOrder(tab: TerminalTab | undefined, pane: TerminalPane): number {
  if (!tab) return 0;
  const layoutOrder = paneIdsInLayout(tab.layout);
  const layoutIndex = layoutOrder.indexOf(pane.id);
  if (layoutIndex >= 0) return layoutIndex;
  const paneIndex = tab.panes.findIndex((item) => item.id === pane.id);
  return paneIndex >= 0 ? paneIndex : tab.panes.length;
}

function paneIdsInLayout(node: SplitNode | undefined): string[] {
  if (!node) return [];
  if (node.type === "pane") return [node.paneId];
  return node.children.flatMap(paneIdsInLayout);
}

function scheduleCopySelection() {
  requestAnimationFrame(() => void copySelection(false));
}

async function copySelection(report: boolean): Promise<boolean> {
  const restty = activePane()?.term?.restty;
  if (restty) {
    try {
      if (await restty.copySelectionToClipboard()) {
        if (report) setGlobalStatus(tr("status.selectionCopied"), "ok");
        return true;
      }
    } catch (error) {
      if (report) setGlobalStatus(tr("status.copyFailed", { message: errorMessage(error) }), "error");
      return false;
    }
  }

  const text = window.getSelection()?.toString() ?? "";
  if (!text) {
    if (report) setGlobalStatus(tr("status.noSelection"));
    return false;
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      fallbackCopyText(text);
    }
    if (report) setGlobalStatus(tr("status.selectionCopied"), "ok");
    return true;
  } catch (error) {
    if (report) setGlobalStatus(tr("status.copyFailed", { message: errorMessage(error) }), "error");
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

function selectedInstance(): Instance | undefined {
  return instances.find((instance) => instance.selector === selectedSelector);
}

function instanceForSelector(selector: string): Instance | undefined {
  return instances.find((instance) => instance.selector === selector);
}

function updateIcons() {
  createIcons({ icons });
}
