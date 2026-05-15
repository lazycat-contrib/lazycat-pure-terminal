const NORMAL_CURSOR_KEYS: Record<string, string> = {
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
};

const APP_CURSOR_KEYS: Record<string, string> = {
  ArrowUp: "\x1bOA",
  ArrowDown: "\x1bOB",
  ArrowRight: "\x1bOC",
  ArrowLeft: "\x1bOD",
  Home: "\x1bOH",
  End: "\x1bOF",
};

const CURSOR_FINALS: Record<string, string> = {
  ArrowUp: "A",
  ArrowDown: "B",
  ArrowRight: "C",
  ArrowLeft: "D",
  Home: "H",
  End: "F",
};

const TILDE_KEYS: Record<string, string> = {
  Insert: "2",
  Delete: "3",
  PageUp: "5",
  PageDown: "6",
  F5: "15",
  F6: "17",
  F7: "18",
  F8: "19",
  F9: "20",
  F10: "21",
  F11: "23",
  F12: "24",
};

const FUNCTION_FINALS: Record<string, string> = {
  F1: "P",
  F2: "Q",
  F3: "R",
  F4: "S",
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
  if (event.metaKey) return undefined;
  if (event.key === "Tab" && event.shiftKey) return "\x1b[Z";
  if (event.key === "Enter" && event.shiftKey) return "\x1b[13;2u";
  const modifier = xtermModifier(event);
  if (modifier) {
    const cursorFinal = CURSOR_FINALS[event.key];
    if (cursorFinal) return `\x1b[1;${modifier}${cursorFinal}`;
    const tildeCode = TILDE_KEYS[event.key];
    if (tildeCode) return `\x1b[${tildeCode};${modifier}~`;
    const functionFinal = FUNCTION_FINALS[event.key];
    if (functionFinal) return `\x1b[1;${modifier}${functionFinal}`;
  }
  if (event.ctrlKey) {
    const sequence = controlKeySequence(event.key);
    if (sequence) return event.altKey ? `\x1b${sequence}` : sequence;
    if (event.key === "Backspace") return "\x17";
    return undefined;
  }
  const keyMap = cursorKeysApp ? APP_CURSOR_KEYS : NORMAL_CURSOR_KEYS;
  const fixed = FIXED_KEYS[event.key] ?? keyMap[event.key];
  if (fixed) {
    return event.altKey ? `\x1b${fixed}` : fixed;
  }
  if (event.key.length === 1) return event.altKey ? `\x1b${event.key}` : event.key;
  return undefined;
}

export function shouldHandleTerminalKeyDown(event: KeyboardEvent): boolean {
  if (event.isComposing || event.metaKey) return false;
  if (event.key === "Process" || event.key === "Dead") return false;
  if (event.key.length === 1) return event.ctrlKey || event.altKey;
  return event.key in FIXED_KEYS
    || event.key in NORMAL_CURSOR_KEYS
    || event.key in TILDE_KEYS
    || event.key in FUNCTION_FINALS;
}

function controlKeySequence(key: string): string | undefined {
  if (key.length === 1) {
    const code = key.toLowerCase().charCodeAt(0);
    if (code >= 97 && code <= 122) return String.fromCharCode(code - 96);
  }
  if (key === " " || key === "@" || key === "`") return "\x00";
  if (key === "[") return "\x1b";
  if (key === "\\") return "\x1c";
  if (key === "]") return "\x1d";
  if (key === "^" || key === "~" || key === "6") return "\x1e";
  if (key === "_" || key === "-" || key === "/") return "\x1f";
  return undefined;
}

function xtermModifier(event: KeyboardEvent): number | undefined {
  let modifier = 1;
  if (event.shiftKey) modifier += 1;
  if (event.altKey) modifier += 2;
  if (event.ctrlKey) modifier += 4;
  return modifier > 1 ? modifier : undefined;
}
