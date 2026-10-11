// Minimal stand-in for the `vscode` module, for driving adapters from plain Node.
class EventEmitter {
  constructor() { this.listeners = []; this.event = (fn) => { this.listeners.push(fn); return { dispose: () => {} }; }; }
  fire(e) { for (const l of this.listeners) l(e); }
  dispose() {}
}
class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
class ThemeColor { constructor(id) { this.id = id; } }
class MarkdownString { constructor(v) { this.value = v; } }
module.exports = {
  EventEmitter, TreeItem, ThemeIcon, ThemeColor, MarkdownString,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ProgressLocation: { Window: 10, Notification: 15 },
  QuickPickItemKind: { Separator: -1 },
  window: {}, commands: { executeCommand: () => undefined },
  workspace: { getConfiguration: () => ({ get: (k) => (globalThis.__oprofConfig || {})[k] }) },
  Uri: { file: (p) => ({ fsPath: p }), joinPath: (u, ...p) => ({ fsPath: require('path').join(u.fsPath, ...p) }) },
};
