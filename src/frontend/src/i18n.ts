import type { LocaleSetting } from "./types";

type Language = "en" | "zh-CN";

export type MessageKey =
  | "action.closeSettings"
  | "action.copySelection"
  | "action.focusTerminal"
  | "action.newTab"
  | "action.refreshInstances"
  | "action.removeFont"
  | "action.settings"
  | "action.closeTab"
  | "action.renameTab"
  | "action.splitDown"
  | "action.splitLeft"
  | "action.splitRight"
  | "action.splitUp"
  | "action.switchInstance"
  | "action.uploadFont"
  | "app.title"
  | "cursor.bar"
  | "cursor.block"
  | "cursor.underline"
  | "field.cursor"
  | "field.font"
  | "field.fontSize"
  | "field.language"
  | "field.lineHeight"
  | "field.scrollback"
  | "field.tabs"
  | "field.theme"
  | "font.builtIn"
  | "font.noUploaded"
  | "font.uploaded"
  | "layout.horizontal"
  | "layout.vertical"
  | "locale.auto"
  | "locale.en"
  | "locale.zhCN"
  | "menu.instances"
  | "menu.pane"
  | "section.appearance"
  | "setting.copyOnSelect"
  | "setting.cursorBlink"
  | "setting.debugAdapter"
  | "status.closed"
  | "status.connected"
  | "status.connectFailed"
  | "status.copyFailed"
  | "status.creatingSession"
  | "status.fontDeleteFailed"
  | "status.fontLoadFailed"
  | "status.fontReady"
  | "status.fontsReady"
  | "status.fontRegistrationFailed"
  | "status.fontRemoved"
  | "status.fontUploadFailed"
  | "status.idle"
  | "status.instance"
  | "status.instanceLoadFailed"
  | "status.instancesLoaded"
  | "status.loadingGhostty"
  | "status.loadingInstances"
  | "status.noInstances"
  | "status.noInstancesVisible"
  | "status.noSelection"
  | "status.noSessions"
  | "status.noTarget"
  | "status.processExited"
  | "status.reconnecting"
  | "status.selectRunningInstance"
  | "status.selectionCopied"
  | "status.shellReady"
  | "status.socketError"
  | "status.startupFailed"
  | "status.terminalError"
  | "validation.fontExtension"
  | "validation.fontMime"
  | "validation.fontSize";

const messages: Record<Language, Record<MessageKey, string>> = {
  en: {
    "action.closeSettings": "Close settings",
    "action.copySelection": "Copy selection",
    "action.focusTerminal": "Focus terminal",
    "action.newTab": "New terminal tab",
    "action.refreshInstances": "Refresh instances",
    "action.removeFont": "Remove selected font",
    "action.settings": "Settings",
    "action.closeTab": "Close tab",
    "action.renameTab": "Rename tab",
    "action.splitDown": "Split down",
    "action.splitLeft": "Split left",
    "action.splitRight": "Split right",
    "action.splitUp": "Split up",
    "action.switchInstance": "Switch instance",
    "action.uploadFont": "Upload font",
    "app.title": "Pure Terminal",
    "cursor.bar": "Bar",
    "cursor.block": "Block",
    "cursor.underline": "Underline",
    "field.cursor": "Cursor",
    "field.font": "Font",
    "field.fontSize": "Font size",
    "field.language": "Language",
    "field.lineHeight": "Line height",
    "field.scrollback": "Scrollback",
    "field.tabs": "Tabs",
    "field.theme": "Theme",
    "font.builtIn": "Built in",
    "font.noUploaded": "No uploaded fonts",
    "font.uploaded": "Uploaded",
    "layout.horizontal": "Horizontal",
    "layout.vertical": "Vertical",
    "locale.auto": "Auto",
    "locale.en": "English",
    "locale.zhCN": "Chinese",
    "menu.instances": "Instances",
    "menu.pane": "Pane menu",
    "section.appearance": "Appearance",
    "setting.copyOnSelect": "Copy on select",
    "setting.cursorBlink": "Cursor blink",
    "setting.debugAdapter": "Debug adapter",
    "status.closed": "Closed",
    "status.connected": "Connected",
    "status.connectFailed": "Connect failed: {message}",
    "status.copyFailed": "Copy failed: {message}",
    "status.creatingSession": "Creating session...",
    "status.fontDeleteFailed": "Font delete failed: {message}",
    "status.fontLoadFailed": "Font load failed: {message}",
    "status.fontReady": "{name} ready",
    "status.fontsReady": "{count} uploaded font(s) ready",
    "status.fontRegistrationFailed": "font registration failed",
    "status.fontRemoved": "{name} removed",
    "status.fontUploadFailed": "Font upload failed: {message}",
    "status.idle": "Idle",
    "status.instance": "Instance",
    "status.instanceLoadFailed": "Instance load failed: {message}",
    "status.instancesLoaded": "Instances loaded",
    "status.loadingGhostty": "Loading Ghostty core...",
    "status.loadingInstances": "Loading instances...",
    "status.noInstances": "No instances returned",
    "status.noInstancesVisible": "No LightOS instances visible.",
    "status.noSelection": "No selection to copy",
    "status.noSessions": "No sessions",
    "status.noTarget": "No instance selected",
    "status.processExited": "Process exited: {code}",
    "status.reconnecting": "Disconnected. Reconnecting in {seconds}s...",
    "status.selectRunningInstance": "Select a running instance first.",
    "status.selectionCopied": "Selection copied",
    "status.shellReady": "Shell ready",
    "status.socketError": "Socket error",
    "status.startupFailed": "Startup failed: {message}",
    "status.terminalError": "Terminal error",
    "validation.fontExtension": "only .woff, .woff2, .ttf, and .otf are allowed",
    "validation.fontMime": "unsupported font MIME type: {mimeType}",
    "validation.fontSize": "font must be between 1 byte and 10 MB",
  },
  "zh-CN": {
    "action.closeSettings": "关闭设置",
    "action.copySelection": "复制选区",
    "action.focusTerminal": "聚焦终端",
    "action.newTab": "新建终端标签",
    "action.refreshInstances": "刷新实例",
    "action.removeFont": "移除当前字体",
    "action.settings": "设置",
    "action.closeTab": "关闭标签",
    "action.renameTab": "重命名标签",
    "action.splitDown": "向下拆分",
    "action.splitLeft": "向左拆分",
    "action.splitRight": "向右拆分",
    "action.splitUp": "向上拆分",
    "action.switchInstance": "切换实例",
    "action.uploadFont": "上传字体",
    "app.title": "Pure Terminal",
    "cursor.bar": "竖线",
    "cursor.block": "块",
    "cursor.underline": "下划线",
    "field.cursor": "光标",
    "field.font": "字体",
    "field.fontSize": "字号",
    "field.language": "语言",
    "field.lineHeight": "行高",
    "field.scrollback": "回滚行数",
    "field.tabs": "标签栏",
    "field.theme": "主题",
    "font.builtIn": "内置",
    "font.noUploaded": "暂无上传字体",
    "font.uploaded": "已上传",
    "layout.horizontal": "横向",
    "layout.vertical": "竖向",
    "locale.auto": "跟随系统",
    "locale.en": "English",
    "locale.zhCN": "中文",
    "menu.instances": "实例",
    "menu.pane": "终端面板菜单",
    "section.appearance": "外观",
    "setting.copyOnSelect": "选中即复制",
    "setting.cursorBlink": "光标闪烁",
    "setting.debugAdapter": "调试适配器",
    "status.closed": "已关闭",
    "status.connected": "已连接",
    "status.connectFailed": "连接失败：{message}",
    "status.copyFailed": "复制失败：{message}",
    "status.creatingSession": "正在创建会话...",
    "status.fontDeleteFailed": "字体删除失败：{message}",
    "status.fontLoadFailed": "字体加载失败：{message}",
    "status.fontReady": "{name} 已就绪",
    "status.fontsReady": "{count} 个上传字体已就绪",
    "status.fontRegistrationFailed": "字体注册失败",
    "status.fontRemoved": "{name} 已移除",
    "status.fontUploadFailed": "字体上传失败：{message}",
    "status.idle": "空闲",
    "status.instance": "实例",
    "status.instanceLoadFailed": "实例加载失败：{message}",
    "status.instancesLoaded": "实例已加载",
    "status.loadingGhostty": "正在加载 Ghostty core...",
    "status.loadingInstances": "正在加载实例...",
    "status.noInstances": "没有返回实例",
    "status.noInstancesVisible": "没有可见的 LightOS 实例。",
    "status.noSelection": "没有可复制的选区",
    "status.noSessions": "没有会话",
    "status.noTarget": "未选择实例",
    "status.processExited": "进程已退出：{code}",
    "status.reconnecting": "连接已断开，{seconds}s 后重连...",
    "status.selectRunningInstance": "请先选择运行中的实例。",
    "status.selectionCopied": "选区已复制",
    "status.shellReady": "Shell 已就绪",
    "status.socketError": "Socket 错误",
    "status.startupFailed": "启动失败：{message}",
    "status.terminalError": "终端错误",
    "validation.fontExtension": "只允许 .woff、.woff2、.ttf 和 .otf",
    "validation.fontMime": "不支持的字体 MIME 类型：{mimeType}",
    "validation.fontSize": "字体大小必须在 1 字节到 10 MB 之间",
  },
};

export function resolveLanguage(locale: LocaleSetting): Language {
  if (locale === "en" || locale === "zh-CN") return locale;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function translate(locale: LocaleSetting, key: MessageKey, values: Record<string, string | number> = {}): string {
  const template = messages[resolveLanguage(locale)][key] ?? messages.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ""));
}
