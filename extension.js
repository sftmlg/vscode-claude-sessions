'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const {
  readRunningSessions,
  processChildren,
  findSession,
  cwdOfPid,
  withTimeout,
  sleep,
  formatTime,
  oneLine,
  sessionSummary,
  metaForSession,
  listRepoSessions,
} = require('./sessions');

const AUTO_TITLE = /^[\u2800-\u28ff✳✻✽✶✢✦·*●○◐◓◑◒]\s*/u;
const SHELL_NAMES = new Set(['', 'zsh', '-zsh', 'bash', '-bash', 'sh', 'fish', 'node', 'claude', 'login', 'Claude Code']);
const LEGACY_DIR = '.vscode/claude-sessions';

const settings = () => vscode.workspace.getConfiguration('claudeSessions');
const claudeCommand = () => settings().get('claudeCommand') || 'claude';
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function isAutoTitle(name) {
  return SHELL_NAMES.has(name) || AUTO_TITLE.test(name);
}

function stripAutoTitle(name) {
  const stripped = name.replace(AUTO_TITLE, '').trim();
  return SHELL_NAMES.has(stripped) ? '' : stripped;
}

function sessionTooltip(title, meta, extra = []) {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${title.replace(/[*_`[\]]/g, '\\$&')}**\n\n`);
  const facts = [...extra];
  if (meta) {
    if (meta.aiTitle && meta.aiTitle !== title) facts.push(`Claude title: ${meta.aiTitle}`);
    facts.push(sessionSummary(meta), `Session ${meta.id}`, meta.cwd || '');
  }
  md.appendText(`${facts.filter(Boolean).join('\n')}\n\n`);
  if (meta && meta.lastUser) {
    md.appendMarkdown(`**Last message (${formatTime(meta.lastUser.at)})**\n\n`);
    md.appendText(`${oneLine(meta.lastUser.text, 500)}\n\n`);
  }
  if (meta && meta.lastAssistant) {
    md.appendMarkdown(`**Last reply (${formatTime(meta.lastAssistant.at)})**\n\n`);
    md.appendText(oneLine(meta.lastAssistant.text, 500));
  }
  return md;
}

class Store {
  constructor(wsPath) {
    this.wsPath = wsPath;
  }

  file() {
    return path.resolve(this.wsPath, settings().get('storageFile') || '.vscode/claude-sessions.json');
  }

  read() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
      return Array.isArray(data.tabs) ? data.tabs : [];
    } catch {
      return [];
    }
  }

  write(tabs) {
    const file = this.file();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 2, updatedAt: new Date().toISOString(), tabs }, null, 2)}\n`);
    fs.renameSync(tmp, file);
  }

  migrateLegacy() {
    const legacy = path.resolve(this.wsPath, LEGACY_DIR);
    let files = [];
    try {
      if (!fs.statSync(legacy).isDirectory()) return;
      files = fs.readdirSync(legacy).filter((f) => f.endsWith('.json')).sort().reverse();
    } catch {
      return;
    }
    if (!fs.existsSync(this.file()) && files.length) {
      try {
        const snap = JSON.parse(fs.readFileSync(path.join(legacy, files[0]), 'utf8'));
        const tabs = [];
        (snap.groups || []).forEach((g, gi) => {
          for (const t of g.terminals || []) {
            if (t.nameSource === 'user' && t.sessionId) tabs.push({ name: t.name, sessionId: t.sessionId, cwd: t.cwd, group: `legacy-${gi}` });
          }
        });
        this.write(tabs);
      } catch {}
    }
    fs.rmSync(legacy, { recursive: true, force: true });
  }
}

class Tracker {
  constructor(store) {
    this.store = store;
    this.groups = [];
    this.meta = new Map();
    this.titles = new Map();
    this.syncedNames = new Map();
    this.restoring = false;
    this.scanning = false;
    this.onChange = new vscode.EventEmitter();
  }

  liveTerminals() {
    return vscode.window.terminals.filter((t) => !(t.creationOptions && t.creationOptions.hideFromUser));
  }

  syncGroups() {
    const live = this.liveTerminals();
    this.groups = this.groups.map((g) => g.filter((t) => live.includes(t))).filter((g) => g.length);
    const known = new Set(this.groups.flat());
    for (const t of live) if (!known.has(t)) this.groups.push([t]);
  }

  observeName(t, m) {
    const current = t.name || '';
    if (!isAutoTitle(current)) {
      m.name = current;
      m.nameSource = 'user';
    } else if (m.nameSource !== 'user') {
      const auto = stripAutoTitle(current);
      if (auto) m.name = auto;
      else if (!m.name) m.name = current;
    }
  }

  async syncSessionName(t, m, running) {
    if (!settings().get('syncSessionName') || m.nameSource !== 'user' || !running || !m.name) return;
    if (this.syncedNames.get(running.sessionId) === m.name) return;
    const meta = await metaForSession(running.sessionId);
    const current = meta && (meta.customTitle || meta.aiTitle);
    if (current !== m.name) {
      if (running.status === 'busy') return;
      t.sendText(`/rename ${m.name.replace(/[\r\n]+/g, ' ')}`);
    }
    this.syncedNames.set(running.sessionId, m.name);
  }

  forget(sessionId) {
    if (!sessionId) return;
    const tabs = this.store.read();
    const kept = tabs.filter((t) => t.sessionId !== sessionId);
    if (kept.length !== tabs.length) {
      this.store.write(kept);
      this.onChange.fire();
    }
  }

  async poll() {
    if (this.scanning) return;
    this.syncGroups();
    const [running, children] = await Promise.all([readRunningSessions(), processChildren()]);
    for (const t of this.liveTerminals()) {
      const m = this.meta.get(t) || { name: '', nameSource: 'auto', sessionId: null, cwd: null };
      const pid = await withTimeout(t.processId, 1000);
      const s = pid ? findSession(pid, children, running) : null;
      if (s) {
        if (m.sessionId && m.sessionId !== s.sessionId) this.forget(m.sessionId);
        m.sessionId = s.sessionId;
        m.cwd = s.cwd;
      }
      if (!m.cwd) {
        const si = t.shellIntegration && t.shellIntegration.cwd;
        m.cwd = si ? si.fsPath : pid ? await cwdOfPid(pid) : null;
      }
      this.observeName(t, m);
      await this.syncSessionName(t, m, s);
      this.meta.set(t, m);
    }
    const signature = JSON.stringify(this.groups.map((g) => g.map((t) => [(this.meta.get(t) || {}).name, (this.meta.get(t) || {}).sessionId])));
    if (signature !== this.lastSignature) {
      this.lastSignature = signature;
      this.onChange.fire();
    }
    this.save();
  }

  namedLiveTabs() {
    const tabs = [];
    for (const g of this.groups) {
      const named = g.map((t) => this.meta.get(t)).filter((m) => m && m.nameSource === 'user' && m.sessionId);
      const group = named.length ? named[0].sessionId : null;
      for (const m of named) tabs.push({ name: m.name, sessionId: m.sessionId, cwd: m.cwd, group });
    }
    return tabs;
  }

  save() {
    const live = this.namedLiveTabs();
    const liveIds = new Set(live.map((t) => t.sessionId));
    const saved = this.store.read();
    const tabs = live.concat(saved.filter((t) => !liveIds.has(t.sessionId)));
    if (JSON.stringify(tabs) === JSON.stringify(saved)) return;
    this.store.write(tabs);
    this.onChange.fire();
  }

  async waitForActive(previous) {
    if (vscode.window.activeTerminal !== previous) return;
    await new Promise((resolve) => {
      const sub = vscode.window.onDidChangeActiveTerminal(() => {
        sub.dispose();
        resolve();
      });
      setTimeout(() => {
        sub.dispose();
        resolve();
      }, 250);
    });
  }

  async command(id) {
    const before = vscode.window.activeTerminal;
    await vscode.commands.executeCommand(id);
    await this.waitForActive(before);
  }

  async scanLayout() {
    const live = this.liveTerminals();
    if (!live.length || this.scanning) return;
    this.scanning = true;
    const original = vscode.window.activeTerminal;
    const creationIndex = new Map(live.map((t, i) => [t, i]));
    const groups = [];
    const seen = new Set();
    try {
      await this.command('workbench.action.terminal.focusAtIndex1');
      for (let guard = 0; guard <= live.length; guard++) {
        const start = vscode.window.activeTerminal;
        if (!start || seen.has(start)) break;
        let members = [start];
        for (let i = 0; i < live.length; i++) {
          await this.command('workbench.action.terminal.focusNextPane');
          const a = vscode.window.activeTerminal;
          if (!a || a === start || members.includes(a)) break;
          members.push(a);
        }
        if (groups.length) {
          const anchor = members.reduce((best, t, i) => (creationIndex.get(t) < creationIndex.get(members[best]) ? i : best), 0);
          members = members.slice(anchor).concat(members.slice(0, anchor));
        }
        members.forEach((t) => seen.add(t));
        groups.push(members);
        await this.command('workbench.action.terminal.focusNext');
      }
    } finally {
      for (const t of live) if (!seen.has(t)) groups.push([t]);
      this.groups = groups;
      if (original) original.show(false);
      this.scanning = false;
    }
    await this.poll();
  }

  async restore() {
    const running = new Set([...(await readRunningSessions()).values()].map((s) => s.sessionId));
    const tabs = this.store.read().filter((t) => !running.has(t.sessionId));
    if (!tabs.length) {
      vscode.window.showInformationMessage('All saved Claude tabs are already open.');
      return;
    }
    const byGroup = new Map();
    for (const t of tabs) {
      const key = t.group || t.sessionId;
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(t);
    }
    const pending = [];
    let first = null;
    this.restoring = true;
    for (const group of byGroup.values()) {
      let parent = null;
      const created = [];
      for (const tab of group) {
        const cwd = tab.cwd && fs.existsSync(tab.cwd) ? tab.cwd : this.store.wsPath;
        const options = { name: tab.name, cwd, iconPath: new vscode.ThemeIcon('sparkle') };
        if (parent) options.location = { parentTerminal: parent };
        const t = vscode.window.createTerminal(options);
        this.meta.set(t, { name: tab.name, nameSource: 'user', sessionId: tab.sessionId, cwd });
        pending.push([t, `${claudeCommand()} --resume ${tab.sessionId}`]);
        parent = parent || t;
        first = first || t;
        created.push(t);
      }
      this.groups.push(created);
    }
    if (first) first.show(false);
    for (const [t, text] of pending) {
      t.sendText(text);
      await sleep(400);
    }
    this.restoring = false;
    await this.poll();
    vscode.window.showInformationMessage(`Restored ${tabs.length} Claude tabs.`);
  }
}

class SessionsProvider {
  constructor(store, tracker) {
    this.store = store;
    this.tracker = tracker;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }

  refresh() {
    this.emitter.fire();
  }

  getTreeItem(e) {
    return e;
  }

  folder(label, kind, count) {
    const item = new vscode.TreeItem(`${label} (${count})`, vscode.TreeItemCollapsibleState.Expanded);
    item.contextValue = kind;
    item.iconPath = new vscode.ThemeIcon(kind === 'openFolder' ? 'terminal' : 'archive');
    item.data = { kind };
    return item;
  }

  relative(cwd) {
    return cwd && cwd !== this.store.wsPath ? path.relative(this.store.wsPath, cwd) : '';
  }

  async openTabItem(t) {
    const m = this.tracker.meta.get(t) || {};
    const name = m.name || t.name;
    const item = new vscode.TreeItem(name);
    item.contextValue = 'openTab';
    item.iconPath = new vscode.ThemeIcon(m.sessionId ? 'pass-filled' : 'terminal');
    const meta = await metaForSession(m.sessionId);
    item.description = [sessionSummary(meta), this.relative(m.cwd)].filter(Boolean).join(' · ');
    item.tooltip = m.sessionId ? sessionTooltip(name, meta, [m.cwd]) : name;
    item.command = { command: 'claudeSessions.focusTab', title: 'Focus tab', arguments: [t] };
    item.data = { terminal: t, tab: { name, sessionId: m.sessionId, cwd: m.cwd } };
    return item;
  }

  async openChildren() {
    this.tracker.syncGroups();
    const groups = this.tracker.groups.map((g) => g.filter((t) => (this.tracker.meta.get(t) || {}).sessionId)).filter((g) => g.length);
    return Promise.all(
      groups.map(async (g) => {
        if (g.length === 1) return this.openTabItem(g[0]);
        const names = g.map((t) => (this.tracker.meta.get(t) || {}).name || t.name);
        const item = new vscode.TreeItem(`Split: ${names.join(' | ')}`, vscode.TreeItemCollapsibleState.Expanded);
        item.contextValue = 'split';
        item.iconPath = new vscode.ThemeIcon('split-horizontal');
        item.data = { terminals: g };
        return item;
      })
    );
  }

  async closedChildren() {
    const [metas, running] = await Promise.all([
      listRepoSessions(this.store.wsPath, settings().get('historyDays') || 14),
      readRunningSessions(),
    ]);
    const live = new Set([...running.values()].map((s) => s.sessionId));
    const saved = new Map(this.store.read().map((t) => [t.sessionId, t.name]));
    return metas
      .filter((m) => !live.has(m.id))
      .map((m) => {
        const title = saved.get(m.id) || m.customTitle || m.aiTitle || oneLine(m.firstPrompt || (m.lastUser && m.lastUser.text), 60) || m.id;
        const item = new vscode.TreeItem(title);
        item.contextValue = saved.has(m.id) ? 'savedTab' : 'session';
        item.iconPath = new vscode.ThemeIcon(saved.has(m.id) ? 'bookmark' : 'comment-discussion');
        item.description = [sessionSummary(m), this.relative(m.cwd)].filter(Boolean).join(' · ');
        item.tooltip = sessionTooltip(title, m, m.firstPrompt ? [`First message: ${oneLine(m.firstPrompt, 200)}`] : []);
        item.data = { tab: { name: title, sessionId: m.id, cwd: m.cwd } };
        return item;
      });
  }

  async getChildren(e) {
    if (!e) {
      const [open, closed] = await Promise.all([this.openChildren(), this.closedChildren()]);
      this.cache = { open, closed };
      const openCount = open.reduce((n, i) => n + (i.data.terminals ? i.data.terminals.length : 1), 0);
      return [this.folder('Open', 'openFolder', openCount), this.folder('Closed', 'closedFolder', closed.length)];
    }
    if (e.data.kind === 'openFolder') return this.cache ? this.cache.open : this.openChildren();
    if (e.data.kind === 'closedFolder') return this.cache ? this.cache.closed : this.closedChildren();
    if (e.data.terminals) return Promise.all(e.data.terminals.map((t) => this.openTabItem(t)));
    return [];
  }
}

function activate(context) {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!folder) return;
  const store = new Store(folder.uri.fsPath);
  store.migrateLegacy();
  const tracker = new Tracker(store);
  const view = new SessionsProvider(store, tracker);

  const resumeInNewTab = (tab) => {
    const cwd = tab.cwd && fs.existsSync(tab.cwd) ? tab.cwd : store.wsPath;
    const t = vscode.window.createTerminal({ name: tab.name, cwd, iconPath: new vscode.ThemeIcon('sparkle') });
    tracker.meta.set(t, { name: tab.name, nameSource: 'user', sessionId: tab.sessionId, cwd });
    t.show(false);
    t.sendText(`${claudeCommand()} --resume ${tab.sessionId}`);
  };

  const resume = async (tab) => {
    const t = vscode.window.activeTerminal;
    if (settings().get('openIn') === 'newTab' || !t) return resumeInNewTab(tab);
    const [running, children] = await Promise.all([readRunningSessions(), processChildren()]);
    const shellPid = await withTimeout(t.processId, 1000);
    if (!shellPid) return resumeInNewTab(tab);
    const current = findSession(shellPid, children, running);
    const cwd = tab.cwd && fs.existsSync(tab.cwd) ? tab.cwd : store.wsPath;
    if (current && current.sessionId === tab.sessionId) {
      t.show(false);
      return;
    }
    if (current) {
      t.sendText(`/resume ${tab.sessionId}`);
    } else if ((children.get(shellPid) || []).length === 0) {
      t.sendText(`cd ${shellQuote(cwd)} && ${claudeCommand()} --resume ${tab.sessionId}`);
    } else {
      return resumeInNewTab(tab);
    }
    t.show(false);
    await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name: tab.name });
    tracker.meta.set(t, { name: tab.name, nameSource: 'user', sessionId: tab.sessionId, cwd });
    tracker.save();
  };

  let debounce = null;
  const scheduleScan = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (tracker.restoring || !settings().get('autoCaptureLayout') || !vscode.window.state.focused) return;
      tracker.scanLayout();
    }, 1500);
  };

  let timer = null;
  const startTimer = () => {
    clearInterval(timer);
    timer = setInterval(() => tracker.poll(), Math.max(1, settings().get('pollSeconds') || 5) * 1000);
  };
  startTimer();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('claudeSessions.sessions', view),
    tracker.onChange.event(() => view.refresh()),
    vscode.window.onDidOpenTerminal(scheduleScan),
    vscode.window.onDidCloseTerminal((t) => {
      const m = tracker.meta.get(t);
      if (m && m.sessionId) tracker.forget(m.sessionId);
      tracker.meta.delete(t);
      scheduleScan();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('claudeSessions') && startTimer()),
    { dispose: () => clearInterval(timer) },
    vscode.commands.registerCommand('claudeSessions.restore', () => tracker.restore()),
    vscode.commands.registerCommand('claudeSessions.captureLayout', async () => {
      await tracker.scanLayout();
      vscode.window.showInformationMessage('Tab layout captured.');
    }),
    vscode.commands.registerCommand('claudeSessions.refresh', () => view.refresh()),
    vscode.commands.registerCommand('claudeSessions.focusTab', (t) => t && t.show(false)),
    vscode.commands.registerCommand('claudeSessions.openStateFile', () => vscode.window.showTextDocument(vscode.Uri.file(store.file()))),
    vscode.commands.registerCommand('claudeSessions.resume', (item) => resume(item.data.tab)),
    vscode.commands.registerCommand('claudeSessions.resumeNewTab', (item) => resumeInNewTab(item.data.tab)),
    vscode.commands.registerCommand('claudeSessions.copyResume', (item) => {
      const { tab } = item.data;
      vscode.env.clipboard.writeText(`cd ${shellQuote(tab.cwd || store.wsPath)} && ${claudeCommand()} --resume ${tab.sessionId}`);
    }),
    vscode.commands.registerCommand('claudeSessions.renameSaved', async (item) => {
      const { tab } = item.data;
      const name = await vscode.window.showInputBox({ prompt: 'Tab name', value: tab.name });
      if (!name) return;
      const tabs = store.read();
      const known = tabs.some((t) => t.sessionId === tab.sessionId);
      store.write(known ? tabs.map((t) => (t.sessionId === tab.sessionId ? { ...t, name } : t)) : tabs.concat([{ ...tab, name, group: tab.sessionId }]));
      view.refresh();
    }),
    vscode.commands.registerCommand('claudeSessions.removeSaved', (item) => tracker.forget(item.data.tab.sessionId)),
    vscode.commands.registerCommand('claudeSessions.renameTab', async (arg) => {
      const t = arg && typeof arg.sendText === 'function' ? arg : vscode.window.activeTerminal;
      if (!t) return;
      const m = tracker.meta.get(t) || { nameSource: 'auto', sessionId: null, cwd: null };
      const name = await vscode.window.showInputBox({ prompt: 'New tab name', value: m.name || t.name });
      if (!name) return;
      t.show(false);
      await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name });
      const updated = { ...m, name, nameSource: 'user' };
      tracker.meta.set(t, updated);
      const [running, children] = await Promise.all([readRunningSessions(), processChildren()]);
      const pid = await withTimeout(t.processId, 1000);
      await tracker.syncSessionName(t, updated, pid ? findSession(pid, children, running) : null);
      tracker.save();
    })
  );

  setTimeout(() => {
    tracker.poll();
    if (settings().get('autoCaptureLayout') && tracker.liveTerminals().length > 1 && vscode.window.state.focused) tracker.scanLayout();
  }, 4000);
}

function deactivate() {}

module.exports = { activate, deactivate };
