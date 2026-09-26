'use strict';
const Module = require('module');

class Emitter {
  constructor() {
    this.listeners = new Set();
    this.event = (fn) => {
      this.listeners.add(fn);
      return { dispose: () => this.listeners.delete(fn) };
    };
  }

  fire(value) {
    for (const fn of [...this.listeners]) fn(value);
  }
}

function createFakeVscode({ workspacePath, globalStoragePath }) {
  const registered = new Map();
  const executed = [];
  const context = new Map();
  const treeViews = new Map();
  const open = new Emitter();
  const close = new Emitter();
  const active = new Emitter();
  const windowState = new Emitter();
  const quickPickAnswers = [];
  const inputAnswers = [];
  const warningAnswers = [];
  const panes = [];
  const lastActive = new Map();
  const opened = [];
  const config = {};
  const secretStore = new Map();
  const messages = [];
  let onOpenExternal = null;
  const groupOf = (t) => panes.find((g) => g.includes(t));
  const focusPane = (step) => {
    const t = vscode.window.activeTerminal;
    const g = t && groupOf(t);
    if (!g || g.length < 2) return;
    g[(g.indexOf(t) + step + g.length) % g.length].show();
  };

  class FakeTerminal {
    constructor(options = {}) {
      this.name = options.name || 'zsh';
      this.creationOptions = options;
      this.processId = Promise.resolve(options.pid || process.pid);
      this.sent = [];
      this.disposed = false;
    }

    sendText(text) {
      this.sent.push(text);
    }

    show() {
      const g = groupOf(this);
      if (g) lastActive.set(g, this);
      if (vscode.window.activeTerminal !== this) {
        vscode.window.activeTerminal = this;
        active.fire(this);
      }
    }

    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      vscode.window.terminals = vscode.window.terminals.filter((t) => t !== this);
      const g = groupOf(this);
      if (g) g.splice(g.indexOf(this), 1);
      if (g && !g.length) panes.splice(panes.indexOf(g), 1);
      if (vscode.window.activeTerminal === this) vscode.window.activeTerminal = vscode.window.terminals[0];
      close.fire(this);
    }
  }

  const vscode = {
    EventEmitter: Emitter,
    TreeItem: class {
      constructor(label, collapsibleState) {
        this.label = label;
        this.collapsibleState = collapsibleState;
      }
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class {
      constructor(id) {
        this.id = id;
      }
    },
    ThemeColor: class {},
    MarkdownString: class {
      constructor() {
        this.value = '';
      }
      appendMarkdown(t) {
        this.value += t;
      }
      appendText(t) {
        this.value += t;
      }
    },
    QuickPickItemKind: { Separator: -1 },
    ProgressLocation: { Notification: 15 },
    ConfigurationTarget: { Global: 1 },
    Uri: { file: (p) => ({ fsPath: p, path: p }), parse: (s) => ({ toString: () => s }) },
    env: { clipboard: { writeText: async () => undefined }, openExternal: async (uri) => opened.push(uri.toString()) && (onOpenExternal ? onOpenExternal(uri.toString()) : true) },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: workspacePath } }],
      getConfiguration: () => ({ get: (key) => ({ autoUpdate: false, ...config }[key]), update: async (key, value) => (config[key] = value) }),
      onDidChangeConfiguration: new Emitter().event,
      fs: { delete: async () => undefined },
    },
    window: {
      terminals: [],
      activeTerminal: undefined,
      state: { focused: true },
      createTerminal(options) {
        const t = new FakeTerminal(options);
        vscode.window.terminals.push(t);
        const parent = options && options.location && options.location.parentTerminal;
        const g = parent && groupOf(parent);
        if (g) g.splice(g.indexOf(parent) + 1, 0, t);
        else panes.push([t]);
        open.fire(t);
        return t;
      },
      createTreeView(id, { treeDataProvider }) {
        const view = { id, provider: treeDataProvider, onDidChangeSelection: new Emitter().event, dispose() {}, badge: undefined, message: undefined, description: undefined };
        treeViews.set(id, view);
        return view;
      },
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      createQuickPick() {
        const accept = new Emitter();
        const hide = new Emitter();
        const qp = {
          items: [],
          selectedItems: [],
          onDidChangeValue: new Emitter().event,
          onDidAccept: accept.event,
          onDidHide: hide.event,
          show() {
            setTimeout(async () => {
              for (let i = 0; i < 50 && qp.busy; i++) await new Promise((r) => setTimeout(r, 10));
              const pick = quickPickAnswers.shift();
              const item = pick ? qp.items.find(pick) : undefined;
              if (item) {
                qp.selectedItems = [item];
                accept.fire();
              } else hide.fire();
            }, 0);
          },
          dispose() {},
        };
        return qp;
      },
      createInputBox() {
        return { onDidChangeValue: new Emitter().event, onDidAccept: new Emitter().event, onDidHide: new Emitter().event, show() {}, hide() {}, dispose() {} };
      },
      showInputBox: async () => inputAnswers.shift(),
      showWarningMessage: async () => warningAnswers.shift(),
      showInformationMessage: async (text) => {
        messages.push(text);
        return undefined;
      },
      withProgress: (options, task) => task({ report() {} }, { isCancellationRequested: false }),
      showTextDocument: async () => undefined,
      onDidOpenTerminal: open.event,
      onDidCloseTerminal: close.event,
      onDidChangeActiveTerminal: active.event,
      onDidChangeWindowState: windowState.event,
      onDidChangeTextEditorSelection: new Emitter().event,
      onDidChangeActiveTextEditor: new Emitter().event,
    },
    commands: {
      registerCommand(id, fn) {
        registered.set(id, fn);
        return { dispose: () => registered.delete(id) };
      },
      async executeCommand(id, ...args) {
        executed.push([id, ...args]);
        if (id === 'setContext') {
          context.set(args[0], args[1]);
          return undefined;
        }
        if (id === 'workbench.action.terminal.renameWithArg' && vscode.window.activeTerminal) {
          vscode.window.activeTerminal.name = args[0].name;
          return undefined;
        }
        if (id === 'workbench.action.terminal.split' && vscode.window.activeTerminal) {
          const t = vscode.window.createTerminal({ cwd: workspacePath, location: { parentTerminal: vscode.window.activeTerminal } });
          t.show();
          return t;
        }
        if (id === 'workbench.action.terminal.focusAtIndex1') return panes[0] && panes[0][0].show();
        if (id === 'workbench.action.terminal.focusNext') {
          const i = panes.findIndex((g) => g.includes(vscode.window.activeTerminal));
          const next = panes.length && panes[(i + 1) % panes.length];
          return next && (lastActive.get(next) && next.includes(lastActive.get(next)) ? lastActive.get(next) : next[0]).show();
        }
        if (id === 'workbench.action.terminal.focusNextPane') return focusPane(1);
        if (id === 'workbench.action.terminal.focusPreviousPane') return focusPane(-1);
        if (registered.has(id)) return registered.get(id)(...args);
        return undefined;
      },
    },
  };

  const install = () => {
    const original = Module._load;
    Module._load = (request, ...rest) => (request === 'vscode' ? vscode : original(request, ...rest));
    return () => {
      Module._load = original;
    };
  };

  const activate = () => {
    const restore = install();
    const extPath = require.resolve('../extension');
    const sessionsPath = require.resolve('../sessions');
    delete require.cache[extPath];
    delete require.cache[sessionsPath];
    delete require.cache[require.resolve('../sync')];
    const extension = require('../extension');
    restore();
    const subscriptions = [];
    const secrets = {
      get: async (k) => secretStore.get(k),
      store: async (k, v) => secretStore.set(k, v),
      delete: async (k) => secretStore.delete(k),
    };
    const api = extension.activate({ subscriptions, storageUri: undefined, globalStorageUri: { fsPath: globalStoragePath }, secrets });
    return {
      ...api,
      deactivate: () => {
        for (const s of subscriptions) if (s && s.dispose) s.dispose();
      },
    };
  };

  return {
    vscode,
    activate,
    registered,
    executed,
    context,
    treeViews,
    quickPickAnswers,
    inputAnswers,
    warningAnswers,
    panes,
    opened,
    config,
    secretStore,
    messages,
    onOpenExternal: (fn) => {
      onOpenExternal = fn;
    },
    run: (id, ...args) => vscode.commands.executeCommand(id, ...args),
    fire: { windowState: (s) => windowState.fire(s) },
  };
}

module.exports = { createFakeVscode };
