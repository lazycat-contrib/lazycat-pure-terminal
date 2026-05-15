import type { WTerm } from "@wterm/dom";

import type { Session } from "./gen/lazycat/webshell/v1/capability_pb";

export type Tone = "ok" | "error" | "neutral";
export type TabLayout = "horizontal" | "vertical";
export type CursorShape = "block" | "bar" | "underline";
export type SplitPlacement = "up" | "down" | "left" | "right";
export type SplitAxis = "rows" | "columns";
export type LocaleSetting = "auto" | "en" | "zh-CN";

export type SplitPaneNode = {
  type: "pane";
  paneId: string;
};

export type SplitContainerNode = {
  type: "split";
  axis: SplitAxis;
  children: SplitNode[];
};

export type SplitNode = SplitPaneNode | SplitContainerNode;

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
  locale: LocaleSetting;
  themeId: string;
  fontFamilyId: string;
  tabLayout: TabLayout;
  fontSize: number;
  lineHeight: number;
  cursorBlink: boolean;
  cursorShape: CursorShape;
  copyOnSelect: boolean;
  scrollbackLimit: number;
  autoRestartSessions: boolean;
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
  mount: HTMLDivElement;
  session?: Session;
  term?: WTerm;
  socket?: WebSocket;
  reconnectTimer?: number;
  reconnectDelay: number;
  connectedOnce: boolean;
  exited: boolean;
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
  layout?: SplitNode;
  closing: boolean;
};
