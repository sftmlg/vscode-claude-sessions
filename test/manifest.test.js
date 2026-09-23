'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const source = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
const contributes = manifest.contributes;

const contributedCommands = new Set(contributes.commands.map((c) => c.command));
const registeredCommands = new Set([...source.matchAll(/registerCommand\('([^']+)'/g)].map((m) => m[1]));
const contributedViews = new Set(Object.values(contributes.views).flat().map((v) => v.id));
const createdViews = new Set([...source.matchAll(/createTreeView\('([^']+)'/g)].map((m) => m[1]));
const menuEntries = Object.values(contributes.menus).flat();

function viewItemNames(when) {
  const names = [...when.matchAll(/viewItem == ([A-Za-z.]+)/g)].map((m) => m[1]);
  for (const m of when.matchAll(/viewItem =~ \/\^\(?([A-Za-z|]+)\)?/g)) names.push(...m[1].split('|'));
  return names.map((n) => n.replace(/\.fav$/, ''));
}

test('every contributed command is registered and every registered command is contributed', () => {
  assert.deepStrictEqual([...contributedCommands].filter((c) => !registeredCommands.has(c)), []);
  assert.deepStrictEqual([...registeredCommands].filter((c) => !contributedCommands.has(c)), []);
});

test('every contributed view is created in code and vice versa', () => {
  assert.deepStrictEqual([...contributedViews].sort(), [...createdViews].sort());
});

test('every command hidden from the palette is reachable from a menu or a tree item', () => {
  const hidden = (contributes.menus.commandPalette || []).filter((m) => m.when === 'false').map((m) => m.command);
  const inMenus = new Set(Object.entries(contributes.menus).filter(([k]) => k !== 'commandPalette').flatMap(([, v]) => v.map((m) => m.command)));
  const asItemCommand = new Set([...source.matchAll(/command: '([^']+)', title:/g)].map((m) => m[1]));
  assert.deepStrictEqual(hidden.filter((c) => !inMenus.has(c) && !asItemCommand.has(c)), []);
});

test('every menu entry points to a contributed command', () => {
  assert.deepStrictEqual(menuEntries.filter((m) => !contributedCommands.has(m.command)).map((m) => m.command), []);
});

test('every context value used in a when clause is produced by the code', () => {
  const used = new Set(menuEntries.flatMap((m) => viewItemNames(m.when || '')));
  const missing = [...used].filter((name) => !new RegExp(`['\`]${name}['\`$]`).test(source));
  assert.deepStrictEqual(missing, []);
});

test('activation registers every contributed command in a mocked VS Code', () => {
  const registered = [];
  const disposable = { dispose() {} };
  const event = () => disposable;
  class EventEmitter {
    constructor() {
      this.event = event;
    }
    fire() {}
  }
  const vscodeMock = {
    EventEmitter,
    TreeItem: class {
      constructor(label, state) {
        this.label = label;
        this.collapsibleState = state;
      }
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class {},
    ThemeColor: class {},
    MarkdownString: class {
      appendMarkdown() {}
      appendText() {}
    },
    QuickPickItemKind: { Separator: -1 },
    Uri: { file: (p) => ({ fsPath: p }) },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: fs.mkdtempSync(path.join(os.tmpdir(), 'claude-manifest-ws-')) } }],
      getConfiguration: () => ({ get: () => undefined }),
      onDidChangeConfiguration: event,
    },
    window: {
      terminals: [],
      activeTerminal: undefined,
      state: { focused: false },
      createTreeView: () => ({ onDidChangeSelection: event, dispose() {}, badge: undefined }),
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      showWarningMessage() {},
      showInformationMessage() {},
      onDidOpenTerminal: event,
      onDidCloseTerminal: event,
      onDidChangeActiveTerminal: event,
      onDidChangeWindowState: event,
      onDidChangeTextEditorSelection: event,
      onDidChangeActiveTextEditor: event,
    },
    commands: {
      registerCommand: (id) => {
        registered.push(id);
        return disposable;
      },
      executeCommand: async () => undefined,
    },
    env: { clipboard: { writeText: async () => undefined } },
  };
  const originalLoad = Module._load;
  Module._load = (request, ...rest) => (request === 'vscode' ? vscodeMock : originalLoad(request, ...rest));
  const realSetTimeout = global.setTimeout;
  const realSetInterval = global.setInterval;
  global.setTimeout = () => 0;
  global.setInterval = () => 0;
  try {
    const modulePath = require.resolve('../extension');
    delete require.cache[modulePath];
    const extension = require('../extension');
    const context = { subscriptions: [], storageUri: undefined };
    extension.activate(context);
  } finally {
    Module._load = originalLoad;
    global.setTimeout = realSetTimeout;
    global.setInterval = realSetInterval;
  }
  assert.deepStrictEqual([...contributedCommands].filter((c) => !registered.includes(c)), []);
});
