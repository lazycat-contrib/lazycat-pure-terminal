import { DEFAULT_SETTINGS } from "./config";
import type { Settings } from "./types";
import { clampNumber } from "./utils";

const SETTINGS_KEY = "pure-terminal.settings";

export function loadSettings(): Settings {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    return normalizeSettings(JSON.parse(raw) as Partial<Settings>);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function normalizeSettings(value: Partial<Settings>): Settings {
  return {
    themeId: typeof value.themeId === "string" ? value.themeId : DEFAULT_SETTINGS.themeId,
    fontFamilyId: typeof value.fontFamilyId === "string" ? value.fontFamilyId : DEFAULT_SETTINGS.fontFamilyId,
    fontSize: clampNumber(value.fontSize, 11, 22, DEFAULT_SETTINGS.fontSize),
    lineHeight: clampNumber(value.lineHeight, 1.05, 1.6, DEFAULT_SETTINGS.lineHeight),
    cursorBlink: value.cursorBlink ?? DEFAULT_SETTINGS.cursorBlink,
    cursorShape: value.cursorShape === "bar" || value.cursorShape === "underline" ? value.cursorShape : "block",
    copyOnSelect: value.copyOnSelect ?? DEFAULT_SETTINGS.copyOnSelect,
    scrollbackLimit: Math.round(
      clampNumber(value.scrollbackLimit, 1000, 100000, DEFAULT_SETTINGS.scrollbackLimit),
    ),
    tabLayout: value.tabLayout === "vertical" ? "vertical" : DEFAULT_SETTINGS.tabLayout,
    debugMode: value.debugMode ?? DEFAULT_SETTINGS.debugMode,
    aiProvider: typeof value.aiProvider === "string" ? value.aiProvider : DEFAULT_SETTINGS.aiProvider,
    aiBaseUrl: typeof value.aiBaseUrl === "string" ? value.aiBaseUrl : DEFAULT_SETTINGS.aiBaseUrl,
    aiApiKey: typeof value.aiApiKey === "string" ? value.aiApiKey : DEFAULT_SETTINGS.aiApiKey,
    aiModel: typeof value.aiModel === "string" ? value.aiModel : DEFAULT_SETTINGS.aiModel,
  };
}

export function saveSettings(settings: Settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
