const NORMAL_KEYS: Record<string, string> = {
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
};

const APP_KEYS: Record<string, string> = {
  ArrowUp: "\x1bOA",
  ArrowDown: "\x1bOB",
  ArrowRight: "\x1bOC",
  ArrowLeft: "\x1bOD",
  Home: "\x1bOH",
  End: "\x1bOF",
};

const FIXED_KEYS: Record<string, string> = {
  Enter: "\r",
  Backspace: "\x7f",
  Tab: "\t",
  Escape: "\x1b",
  Insert: "\x1b[2~",
  Delete: "\x1b[3~",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  F1: "\x1bOP",
  F2: "\x1bOQ",
  F3: "\x1bOR",
  F4: "\x1bOS",
  F5: "\x1b[15~",
  F6: "\x1b[17~",
  F7: "\x1b[18~",
  F8: "\x1b[19~",
  F9: "\x1b[20~",
  F10: "\x1b[21~",
  F11: "\x1b[23~",
  F12: "\x1b[24~",
};

export function keyEventToTerminalSequence(event: KeyboardEvent, cursorKeysApp = false): string | undefined {
  if (event.metaKey || event.altKey) return undefined;
  if (event.ctrlKey) {
    if (event.key.length === 1) {
      const code = event.key.toLowerCase().charCodeAt(0);
      if (code >= 97 && code <= 122) return String.fromCharCode(code - 96);
    }
    if (event.key === "[") return "\x1b";
    if (event.key === "\\") return "\x1c";
    if (event.key === "]") return "\x1d";
    if (event.key === "^") return "\x1e";
    if (event.key === "_") return "\x1f";
    if (event.key === " ") return "\x00";
    return undefined;
  }
  const keyMap = cursorKeysApp ? APP_KEYS : NORMAL_KEYS;
  if (FIXED_KEYS[event.key] || keyMap[event.key]) {
    return FIXED_KEYS[event.key] ?? keyMap[event.key];
  }
  if (event.key.length === 1) return event.key;
  return undefined;
}
