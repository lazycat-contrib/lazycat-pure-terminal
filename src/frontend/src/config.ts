import type { FontPreset, Settings, TerminalTheme } from "./types";

export const INITIAL_COLS = 120;
export const INITIAL_ROWS = 32;
export const STATUS_REFRESH_MS = 700;
export const MAX_FONT_BYTES = 10 * 1024 * 1024;

export const FONT_EXTENSIONS = [".woff2", ".woff", ".ttf", ".otf"];

export const FONT_MIME_TYPES = new Set([
  "font/woff2",
  "font/woff",
  "font/ttf",
  "font/otf",
  "application/font-woff",
  "application/font-woff2",
  "application/x-font-ttf",
  "application/x-font-otf",
  "application/octet-stream",
]);

export const THEMES: TerminalTheme[] = [
  { id: "ghostty", label: "Ghostty Default", ghosttyName: "Ghostty Default" },
  { id: "catppuccin-mocha", label: "Catppuccin Mocha", ghosttyName: "Catppuccin Mocha", className: "theme-catppuccin-mocha" },
  { id: "tokyo-night", label: "Tokyo Night", ghosttyName: "Tokyo Night", className: "theme-tokyo-night" },
  { id: "nord", label: "Nord", ghosttyName: "Nord", className: "theme-nord" },
  { id: "gruvbox-dark", label: "Gruvbox Dark", ghosttyName: "Gruvbox Dark", className: "theme-gruvbox-dark" },
  { id: "dracula", label: "Dracula", ghosttyName: "Dracula", className: "theme-dracula" },
  { id: "one-dark", label: "One Dark", ghosttyName: "One Dark", className: "theme-one-dark" },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    ghosttyName: "Solarized Dark",
    className: "theme-solarized-dark",
  },
  { id: "github-dark", label: "GitHub Dark", ghosttyName: "GitHub Dark", className: "theme-github-dark" },
  { id: "monokai", label: "Monokai", ghosttyName: "Monokai", className: "theme-monokai" },
  { id: "light", label: "Classic Light", ghosttyName: "Light", className: "theme-light" },
];

export const FONT_PRESETS: FontPreset[] = [
  {
    id: "system-mono",
    label: "System Mono",
    family: "\"SFMono-Regular\", \"Cascadia Mono\", \"Consolas\", \"Liberation Mono\", monospace",
  },
  {
    id: "jetbrains",
    label: "JetBrains Mono",
    family: "\"JetBrains Mono\", \"SFMono-Regular\", \"Cascadia Mono\", monospace",
  },
  {
    id: "ibm-plex",
    label: "IBM Plex Mono",
    family: "\"IBM Plex Mono\", \"SFMono-Regular\", \"Cascadia Mono\", monospace",
  },
  {
    id: "fira-code",
    label: "Fira Code",
    family: "\"Fira Code\", \"SFMono-Regular\", \"Cascadia Mono\", monospace",
  },
  {
    id: "source-code-pro",
    label: "Source Code Pro",
    family: "\"Source Code Pro\", \"SFMono-Regular\", \"Cascadia Mono\", monospace",
  },
  {
    id: "ui-monospace",
    label: "UI Monospace",
    family: "ui-monospace, \"SFMono-Regular\", \"Menlo\", \"Consolas\", monospace",
  },
];

export const DEFAULT_SETTINGS: Settings = {
  themeId: "catppuccin-mocha",
  fontFamilyId: "system-mono",
  tabLayout: "horizontal",
  fontSize: 14,
  lineHeight: 1.22,
  cursorBlink: true,
  cursorShape: "block",
  copyOnSelect: false,
  scrollbackLimit: 10000,
  debugMode: false,
  aiProvider: "openai-compatible",
  aiBaseUrl: "",
  aiApiKey: "",
  aiModel: "",
};
