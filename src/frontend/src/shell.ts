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
  mobileShortcuts: HTMLDivElement;
  emptyState: HTMLDivElement;
  homeButton: HTMLButtonElement;
  settingsButton: HTMLButtonElement;
  closeSettings: HTMLButtonElement;
  settingsPage: HTMLElement;
  localeSelect: HTMLSelectElement;
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
  autoRestartSessions: HTMLInputElement;
  debugMode: HTMLInputElement;
  paneMenu: HTMLDivElement;
  fitTerminal: HTMLButtonElement;
};

export function renderShell(app: HTMLElement): ShellElements {
  app.innerHTML = `
    <main class="webshell" id="webshell" aria-label="Pure Terminal workspace" data-i18n-aria="app.title">
      <header class="topbar" aria-label="Terminal controls" data-i18n-aria="app.title">
        <div class="tabs-shell">
          <div id="tabList" class="tab-list" role="tablist" aria-label="Terminal tabs" data-i18n-aria="action.newTab"></div>
          <button class="tab-add" id="newTabButton" type="button" aria-label="New terminal tab" title="New terminal tab" data-i18n-aria="action.newTab" data-i18n-title="action.newTab">
            <i data-lucide="plus"></i>
          </button>
        </div>
        <div class="topbar-actions">
          <div class="instance-switcher" id="instanceSwitcher">
            <button class="icon-button status-icon" id="instanceButton" type="button" aria-haspopup="listbox" aria-expanded="false" aria-label="Switch instance" title="Switch instance" data-i18n-aria="action.switchInstance" data-i18n-title="action.switchInstance">
              <span class="status-dot" id="instanceStatusDot" data-status="unknown"></span>
              <i data-lucide="server"></i>
              <span id="targetLabel" class="sr-only" data-i18n="status.noTarget">No instance selected</span>
            </button>
            <div class="switcher-menu" id="instanceMenu" hidden>
              <div class="menu-head">
                <span data-i18n="menu.instances">Instances</span>
                <button class="icon-button" id="refreshInstances" type="button" aria-label="Refresh instances" title="Refresh instances" data-i18n-aria="action.refreshInstances" data-i18n-title="action.refreshInstances">
                  <i data-lucide="refresh-cw"></i>
                </button>
              </div>
              <div id="instanceList" class="instance-list" role="listbox" aria-label="Running instances" aria-live="polite"></div>
            </div>
          </div>
          <button class="icon-button" id="fitTerminal" type="button" aria-label="Focus terminal" title="Focus terminal" data-i18n-aria="action.focusTerminal" data-i18n-title="action.focusTerminal">
            <i data-lucide="scan"></i>
          </button>
          <button class="icon-button" id="homeButton" type="button" aria-label="LightOS home" title="LightOS home" data-i18n-aria="action.lightosHome" data-i18n-title="action.lightosHome">
            <i data-lucide="house"></i>
          </button>
          <button class="icon-button" id="settingsButton" type="button" aria-label="Settings" title="Settings" data-i18n-aria="action.settings" data-i18n-title="action.settings">
            <i data-lucide="settings"></i>
          </button>
        </div>
      </header>

      <section id="terminalStage" class="terminal-stage" aria-label="Terminal" data-i18n-aria="app.title">
        <div class="empty-state" id="emptyState">
          <button class="command-button primary icon-only-large" id="emptyNewTab" type="button" aria-label="New terminal tab" title="New terminal tab" data-i18n-aria="action.newTab" data-i18n-title="action.newTab">
            <i data-lucide="square-plus"></i>
          </button>
          <p id="statusLine" data-i18n="status.idle">Idle</p>
        </div>
        <div class="mobile-shortcuts" id="mobileShortcuts" aria-label="Terminal shortcuts" data-i18n-aria="menu.mobileShortcuts">
          <button type="button" data-mobile-shortcut="escape" aria-label="Escape">Esc</button>
          <button type="button" data-mobile-shortcut="tab" aria-label="Tab">Tab</button>
          <button type="button" data-mobile-shortcut="ctrl" data-mobile-modifier="ctrl" aria-label="Control">Ctrl</button>
          <button type="button" data-mobile-shortcut="alt" data-mobile-modifier="alt" aria-label="Alt">Alt</button>
          <button type="button" data-mobile-shortcut="shift" data-mobile-modifier="shift" aria-label="Shift">Shift</button>
          <button type="button" data-mobile-shortcut="left" data-mobile-repeat="true" aria-label="Left"><i data-lucide="arrow-left"></i></button>
          <button type="button" data-mobile-shortcut="down" data-mobile-repeat="true" aria-label="Down"><i data-lucide="arrow-down"></i></button>
          <button type="button" data-mobile-shortcut="up" data-mobile-repeat="true" aria-label="Up"><i data-lucide="arrow-up"></i></button>
          <button type="button" data-mobile-shortcut="right" data-mobile-repeat="true" aria-label="Right"><i data-lucide="arrow-right"></i></button>
          <button type="button" data-mobile-shortcut="enter" data-mobile-repeat="true" aria-label="Enter"><i data-lucide="corner-down-left"></i></button>
          <button type="button" data-mobile-shortcut="paste" aria-label="Paste"><i data-lucide="clipboard-paste"></i></button>
        </div>
      </section>

      <section class="settings-page" id="settingsPage" hidden aria-label="Settings" data-i18n-aria="action.settings">
        <header class="settings-header">
          <div>
            <h2 data-i18n="action.settings">Settings</h2>
          </div>
          <button class="icon-button" id="closeSettings" type="button" aria-label="Close settings" title="Close settings" data-i18n-aria="action.closeSettings" data-i18n-title="action.closeSettings">
            <i data-lucide="x"></i>
          </button>
        </header>

        <div class="settings-grid">
          <section class="settings-section">
            <div class="section-head">
              <i data-lucide="palette"></i>
              <div>
                <h3 data-i18n="section.appearance">Appearance</h3>
              </div>
            </div>
            <label class="field">
              <span data-i18n="field.language">Language</span>
              <select id="localeSelect">
                <option value="auto" data-i18n="locale.auto">Auto</option>
                <option value="en" data-i18n="locale.en">English</option>
                <option value="zh-CN" data-i18n="locale.zhCN">Chinese</option>
              </select>
            </label>
            <label class="field">
              <span data-i18n="field.theme">Theme</span>
              <select id="themeSelect"></select>
            </label>
            <label class="field">
              <span data-i18n="field.font">Font</span>
              <select id="fontFamily"></select>
            </label>
            <label class="field">
              <span data-i18n="field.tabs">Tabs</span>
              <select id="tabLayout">
                <option value="horizontal" data-i18n="layout.horizontal">Horizontal</option>
                <option value="vertical" data-i18n="layout.vertical">Vertical</option>
              </select>
            </label>
            <label class="field">
              <span data-i18n="field.cursor">Cursor</span>
              <select id="cursorShape">
                <option value="block" data-i18n="cursor.block">Block</option>
                <option value="bar" data-i18n="cursor.bar">Bar</option>
                <option value="underline" data-i18n="cursor.underline">Underline</option>
              </select>
            </label>
            <div class="font-actions">
              <label class="file-button icon-only-large" aria-label="Upload font" title="Upload font" data-i18n-aria="action.uploadFont" data-i18n-title="action.uploadFont">
                <input id="fontUpload" type="file" accept=".woff,.woff2,.ttf,.otf,font/woff,font/woff2,font/ttf,font/otf" />
                <i data-lucide="upload"></i>
              </label>
              <button class="command-button icon-only-large" id="removeFont" type="button" aria-label="Remove selected font" title="Remove selected font" data-i18n-aria="action.removeFont" data-i18n-title="action.removeFont">
                <i data-lucide="trash-2"></i>
              </button>
            </div>
            <p id="fontStatus" class="field-status"></p>
            <label class="field">
              <span><span data-i18n="field.fontSize">Font size</span> <output id="fontSizeValue"></output></span>
              <input id="fontSize" type="range" min="11" max="22" step="1" />
            </label>
            <label class="field">
              <span><span data-i18n="field.lineHeight">Line height</span> <output id="lineHeightValue"></output></span>
              <input id="lineHeight" type="range" min="1.05" max="1.6" step="0.01" />
            </label>
            <label class="field">
              <span data-i18n="field.scrollback">Scrollback</span>
              <input id="scrollbackLimit" type="number" min="1000" max="100000" step="1000" />
            </label>
            <label class="switch">
              <input id="cursorBlink" type="checkbox" />
              <span data-i18n="setting.cursorBlink">Cursor blink</span>
            </label>
            <label class="switch">
              <input id="copyOnSelect" type="checkbox" />
              <span data-i18n="setting.copyOnSelect">Copy on select</span>
            </label>
            <label class="switch">
              <input id="autoRestartSessions" type="checkbox" />
              <span data-i18n="setting.autoRestartSessions">Restart sessions after provider restart</span>
            </label>
            <label class="switch">
              <input id="debugMode" type="checkbox" />
              <span data-i18n="setting.debugAdapter">Debug adapter</span>
            </label>
          </section>
        </div>
      </section>

      <div class="pane-menu" id="paneMenu" hidden role="menu" aria-label="Pane menu" data-i18n-aria="menu.pane">
        <button type="button" data-pane-action="split-up" role="menuitem">
          <i data-lucide="panel-top"></i>
          <span data-i18n="action.splitUp">Split up</span>
        </button>
        <button type="button" data-pane-action="split-down" role="menuitem">
          <i data-lucide="panel-bottom"></i>
          <span data-i18n="action.splitDown">Split down</span>
        </button>
        <button type="button" data-pane-action="split-left" role="menuitem">
          <i data-lucide="panel-left"></i>
          <span data-i18n="action.splitLeft">Split left</span>
        </button>
        <button type="button" data-pane-action="split-right" role="menuitem">
          <i data-lucide="panel-right"></i>
          <span data-i18n="action.splitRight">Split right</span>
        </button>
        <button type="button" data-pane-action="copy-selection" role="menuitem">
          <i data-lucide="copy"></i>
          <span data-i18n="action.copySelection">Copy selection</span>
        </button>
        <button type="button" data-pane-action="promote-session-to-tab" role="menuitem" hidden>
          <i data-lucide="external-link"></i>
          <span data-i18n="action.promoteSessionToTab">Move session to new tab</span>
        </button>
        <button type="button" data-pane-action="close-active-session" data-tone="danger" role="menuitem">
          <i data-lucide="square-x"></i>
          <span data-i18n="action.closeActiveSession">Close active session</span>
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
    mobileShortcuts: qs<HTMLDivElement>("#mobileShortcuts"),
    emptyState: qs<HTMLDivElement>("#emptyState"),
    homeButton: qs<HTMLButtonElement>("#homeButton"),
    settingsButton: qs<HTMLButtonElement>("#settingsButton"),
    closeSettings: qs<HTMLButtonElement>("#closeSettings"),
    settingsPage: qs<HTMLElement>("#settingsPage"),
    localeSelect: qs<HTMLSelectElement>("#localeSelect"),
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
    autoRestartSessions: qs<HTMLInputElement>("#autoRestartSessions"),
    debugMode: qs<HTMLInputElement>("#debugMode"),
    paneMenu: qs<HTMLDivElement>("#paneMenu"),
    fitTerminal: qs<HTMLButtonElement>("#fitTerminal"),
  };
}
