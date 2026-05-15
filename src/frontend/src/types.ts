import type { WTerm } from "@wterm/dom";

import type { Session } from "./gen/lazycat/webshell/v1/capability_pb";

export type Tone = "ok" | "error" | "neutral";
export type TabLayout = "horizontal" | "vertical";
export type CursorShape = "block" | "bar" | "underline";

export type TerminalTheme = {
  id: string;
  label: string;
  ghosttyName: string;
  className?: string;
};

export type FontPreset = {
  id: string;
  label: string;
  family: string;
  custom?: boolean;
};

export type StoredFont = {
  id: string;
  label: string;
  family: string;
  mimeType?: string;
  size: number;
  url: string;
};

export type Settings = {
  themeId: string;
  fontFamilyId: string;
  tabLayout: TabLayout;
  fontSize: number;
  lineHeight: number;
  cursorBlink: boolean;
  cursorShape: CursorShape;
  copyOnSelect: boolean;
  scrollbackLimit: number;
  debugMode: boolean;
  aiProvider: string;
  aiBaseUrl: string;
  aiApiKey: string;
  aiModel: string;
};

export type TerminalPane = {
  id: string;
  tabId: string;
  selector: string;
  label: string;
  title: string;
  status: string;
  tone: Tone;
  controlState: string;
  mount: HTMLDivElement;
  session?: Session;
  term?: WTerm;
  socket?: WebSocket;
  reconnectTimer?: number;
  reconnectDelay: number;
  closing: boolean;
  cols: number;
  rows: number;
};

export type TerminalTab = {
  id: string;
  selector: string;
  label: string;
  customTitle?: string;
  mount: HTMLDivElement;
  panes: TerminalPane[];
  activePaneId?: string;
  closing: boolean;
};
