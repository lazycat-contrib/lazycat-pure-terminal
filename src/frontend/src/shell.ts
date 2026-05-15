import { qs } from "./utils";

export type ShellElements = {
  webshell: HTMLElement;
  instanceList: HTMLDivElement;
  instanceSwitcher: HTMLDivElement;
  instanceButton: HTMLButtonElement;
  instanceMenu: HTMLDivElement;
  instanceStatusDot: HTMLSpanElement;
  refreshInstances: HTMLButtonElement;
  newTabButton: HTMLButtonElement;
  emptyNewTab: HTMLButtonElement;
  statusLine: HTMLParagraphElement;
  targetLabel: HTMLElement;
  tabList: HTMLDivElement;
  terminalStage: HTMLDivElement;
  emptyState: HTMLDivElement;
  settingsButton: HTMLButtonElement;
  closeSettings: HTMLButtonElement;
  settingsPage: HTMLElement;
  themeSelect: HTMLSelectElement;
  fontFamily: HTMLSelectElement;
  tabLayout: HTMLSelectElement;
  fontUpload: HTMLInputElement;
  removeFont: HTMLButtonElement;
  fontStatus: HTMLElement;
  fontSize: HTMLInputElement;
  fontSizeValue: HTMLOutputElement;
  lineHeight: HTMLInputElement;
  lineHeightValue: HTMLOutputElement;
  scrollbackLimit: HTMLInputElement;
  cursorBlink: HTMLInputElement;
  cursorShape: HTMLSelectElement;
  copyOnSelect: HTMLInputElement;
  debugMode: HTMLInputElement;
  paneMenu: HTMLDivElement;
  fitTerminal: HTMLButtonElement;
  humanControl: HTMLButtonElement;
};

export function renderShell(app: HTMLElement): ShellElements {
  app.innerHTML = `
    <main class="webshell" id="webshell" aria-label="Pure Terminal workspace">
      <header class="topbar" aria-label="Terminal controls">
        <div class="tabs-shell">
          <div id="tabList" class="tab-list" role="tablist" aria-label="Terminal tabs"></div>
          <button class="tab-add" id="newTabButton" type="button" aria-label="New terminal tab" title="New terminal tab">
            <i data-lucide="plus"></i>
          </button>
        </div>
        <div class="topbar-actions">
          <div class="instance-switcher" id="instanceSwitcher">
            <button class="icon-button status-icon" id="instanceButton" type="button" aria-haspopup="listbox" aria-expanded="false" aria-label="Switch instance" title="Switch instance">
              <span class="status-dot" id="instanceStatusDot" data-status="unknown"></span>
              <i data-lucide="server"></i>
              <span id="targetLabel" class="sr-only">No instance selected</span>
            </button>
            <div class="switcher-menu" id="instanceMenu" hidden>
              <div class="menu-head">
                <span>Instances</span>
                <button class="icon-button" id="refreshInstances" type="button" aria-label="Refresh instances" title="Refresh instances">
                  <i data-lucide="refresh-cw"></i>
                </button>
              </div>
              <div id="instanceList" class="instance-list" role="listbox" aria-label="Running instances" aria-live="polite"></div>
            </div>
          </div>
          <button class="icon-button" id="humanControl" type="button" aria-label="Request human control" title="Request human control">
            <i data-lucide="user-round-check"></i>
          </button>
          <button class="icon-button" id="fitTerminal" type="button" aria-label="Focus terminal" title="Focus terminal">
            <i data-lucide="scan"></i>
          </button>
          <button class="icon-button" id="settingsButton" type="button" aria-label="Settings" title="Settings">
            <i data-lucide="settings"></i>
          </button>
        </div>
      </header>

      <section id="terminalStage" class="terminal-stage" aria-label="Terminal">
        <div class="empty-state" id="emptyState">
          <button class="command-button primary icon-only-large" id="emptyNewTab" type="button" aria-label="New terminal tab" title="New terminal tab">
            <i data-lucide="square-plus"></i>
          </button>
          <p id="statusLine">Idle</p>
        </div>
      </section>

      <section class="settings-page" id="settingsPage" hidden aria-label="Settings">
        <header class="settings-header">
          <div>
            <h2>Settings</h2>
          </div>
          <button class="icon-button" id="closeSettings" type="button" aria-label="Close settings" title="Close settings">
            <i data-lucide="x"></i>
          </button>
        </header>

        <div class="settings-grid">
          <section class="settings-section">
            <div class="section-head">
              <i data-lucide="palette"></i>
              <div>
                <h3>Appearance</h3>
              </div>
            </div>
            <label class="field">
              <span>Theme</span>
              <select id="themeSelect"></select>
            </label>
            <label class="field">
              <span>Font</span>
              <select id="fontFamily"></select>
            </label>
            <label class="field">
              <span>Tabs</span>
              <select id="tabLayout">
                <option value="horizontal">Horizontal</option>
                <option value="vertical">Vertical</option>
              </select>
            </label>
            <label class="field">
              <span>Cursor</span>
              <select id="cursorShape">
                <option value="block">Block</option>
                <option value="bar">Bar</option>
                <option value="underline">Underline</option>
              </select>
            </label>
            <div class="font-actions">
              <label class="file-button icon-only-large" aria-label="Upload font" title="Upload font">
                <input id="fontUpload" type="file" accept=".woff,.woff2,.ttf,.otf,font/woff,font/woff2,font/ttf,font/otf" />
                <i data-lucide="upload"></i>
              </label>
              <button class="command-button icon-only-large" id="removeFont" type="button" aria-label="Remove selected font" title="Remove selected font">
                <i data-lucide="trash-2"></i>
              </button>
            </div>
            <p id="fontStatus" class="field-status"></p>
            <label class="field">
              <span>Font size <output id="fontSizeValue"></output></span>
              <input id="fontSize" type="range" min="11" max="22" step="1" />
            </label>
            <label class="field">
              <span>Line height <output id="lineHeightValue"></output></span>
              <input id="lineHeight" type="range" min="1.05" max="1.6" step="0.01" />
            </label>
            <label class="field">
              <span>Scrollback</span>
              <input id="scrollbackLimit" type="number" min="1000" max="100000" step="1000" />
            </label>
            <label class="switch">
              <input id="cursorBlink" type="checkbox" />
              <span>Cursor blink</span>
            </label>
            <label class="switch">
              <input id="copyOnSelect" type="checkbox" />
              <span>Copy on select</span>
            </label>
            <label class="switch">
              <input id="debugMode" type="checkbox" />
              <span>Debug adapter</span>
            </label>
          </section>
        </div>
      </section>

      <div class="pane-menu" id="paneMenu" hidden role="menu" aria-label="Pane menu">
        <button type="button" data-pane-action="split-up" role="menuitem">
          <i data-lucide="panel-top"></i>
          <span>Split up</span>
        </button>
        <button type="button" data-pane-action="split-down" role="menuitem">
          <i data-lucide="panel-bottom"></i>
          <span>Split down</span>
        </button>
        <button type="button" data-pane-action="copy-selection" role="menuitem">
          <i data-lucide="copy"></i>
          <span>Copy selection</span>
        </button>
      </div>
    </main>
  `;

  return {
    webshell: qs<HTMLElement>("#webshell"),
    instanceList: qs<HTMLDivElement>("#instanceList"),
    instanceSwitcher: qs<HTMLDivElement>("#instanceSwitcher"),
    instanceButton: qs<HTMLButtonElement>("#instanceButton"),
    instanceMenu: qs<HTMLDivElement>("#instanceMenu"),
    instanceStatusDot: qs<HTMLSpanElement>("#instanceStatusDot"),
    refreshInstances: qs<HTMLButtonElement>("#refreshInstances"),
    newTabButton: qs<HTMLButtonElement>("#newTabButton"),
    emptyNewTab: qs<HTMLButtonElement>("#emptyNewTab"),
    statusLine: qs<HTMLParagraphElement>("#statusLine"),
    targetLabel: qs<HTMLElement>("#targetLabel"),
    tabList: qs<HTMLDivElement>("#tabList"),
    terminalStage: qs<HTMLDivElement>("#terminalStage"),
    emptyState: qs<HTMLDivElement>("#emptyState"),
    settingsButton: qs<HTMLButtonElement>("#settingsButton"),
    closeSettings: qs<HTMLButtonElement>("#closeSettings"),
    settingsPage: qs<HTMLElement>("#settingsPage"),
    themeSelect: qs<HTMLSelectElement>("#themeSelect"),
    fontFamily: qs<HTMLSelectElement>("#fontFamily"),
    tabLayout: qs<HTMLSelectElement>("#tabLayout"),
    fontUpload: qs<HTMLInputElement>("#fontUpload"),
    removeFont: qs<HTMLButtonElement>("#removeFont"),
    fontStatus: qs<HTMLElement>("#fontStatus"),
    fontSize: qs<HTMLInputElement>("#fontSize"),
    fontSizeValue: qs<HTMLOutputElement>("#fontSizeValue"),
    lineHeight: qs<HTMLInputElement>("#lineHeight"),
    lineHeightValue: qs<HTMLOutputElement>("#lineHeightValue"),
    scrollbackLimit: qs<HTMLInputElement>("#scrollbackLimit"),
    cursorBlink: qs<HTMLInputElement>("#cursorBlink"),
    cursorShape: qs<HTMLSelectElement>("#cursorShape"),
    copyOnSelect: qs<HTMLInputElement>("#copyOnSelect"),
    debugMode: qs<HTMLInputElement>("#debugMode"),
    paneMenu: qs<HTMLDivElement>("#paneMenu"),
    fitTerminal: qs<HTMLButtonElement>("#fitTerminal"),
    humanControl: qs<HTMLButtonElement>("#humanControl"),
  };
}
