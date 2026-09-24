'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const updater = require('./updater');
const {
  readRunningSessions,
  processChildren,
  findSession,
  cwdOfPid,
  withTimeout,
  sleep,
  oneLine,
  sessionSummary,
  metaForSession,
  listRepoSessions,
  tabPresentation,
  timeAgo,
  searchSessions,
  sessionPaths,
  loadCache,
  loadTextCache,
  peekMeta,
  matchSnippet,
  conversationText,
  readStateFile,
  writeStatePatch,
  filesForSession,
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

function escapeMd(text) {
  return String(text || '').replace(/[\\`*_{}[\]()#+!|<>]/g, '\\$&');
}

function sessionTooltip(title, meta, rows = []) {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${escapeMd(title)}**\n\n`);
  const facts = rows.filter(([, v]) => v);
  if (meta) {
    facts.push(['Last activity', timeAgo(meta.lastActivity)], ['Started', timeAgo(meta.startedAt)]);
    if (meta.aiTitle && meta.aiTitle !== title) facts.push(['Claude title', meta.aiTitle]);
    facts.push(['Session', meta.id]);
  }
  md.appendMarkdown('| | |\n|---|---|\n');
  facts.filter(([, v]) => v).forEach(([k, v]) => md.appendMarkdown(`| **${k}** | ${escapeMd(v)} |\n`));
  if (meta && meta.lastUser) {
    md.appendMarkdown(`\n---\n\n**Last message** · ${timeAgo(meta.lastUser.at)}\n\n${escapeMd(oneLine(meta.lastUser.text, 400))}\n`);
  }
  if (meta && meta.lastAssistant) {
    md.appendMarkdown(`\n---\n\n**Last reply** · ${timeAgo(meta.lastAssistant.at)}\n\n${escapeMd(oneLine(meta.lastAssistant.text, 400))}\n`);
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

  readState() {
    try {
      return readStateFile(this.file());
    } catch (err) {
      vscode.window.showWarningMessage(err.message);
      return {};
    }
  }

  writeState(patch) {
    try {
      writeStatePatch(this.file(), patch);
    } catch (err) {
      vscode.window.showWarningMessage(`${err.message}. Nothing was saved.`);
    }
  }

  read() {
    const tabs = this.readState().tabs;
    return Array.isArray(tabs) ? tabs : [];
  }

  write(tabs) {
    this.writeState({ tabs });
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


class Notifications {
  constructor(store) {
    this.store = store;
    this.onChange = new vscode.EventEmitter();
  }

  list() {
    const items = this.store.readState().notifications;
    return Array.isArray(items) ? items : [];
  }

  favorites() {
    return this.store.readState().favorites || {};
  }

  isFavorite(sessionId) {
    return Boolean(sessionId && this.favorites()[sessionId]);
  }

  save(items) {
    this.store.writeState({ notifications: items });
    this.onChange.fire();
  }

  add(sessionId, name, kind) {
    const items = this.list().filter((n) => n.sessionId !== sessionId);
    items.push({ sessionId, name, kind, at: new Date().toISOString() });
    this.save(items);
  }

  dismiss(sessionId) {
    const items = this.list();
    const kept = items.filter((n) => n.sessionId !== sessionId);
    if (kept.length !== items.length) this.save(kept);
  }

  setFavorite(sessionId, value) {
    const favorites = { ...this.favorites() };
    if (value) favorites[sessionId] = true;
    else delete favorites[sessionId];
    this.store.writeState({ favorites });
    this.onChange.fire();
  }

  onStatus(sessionId, name, previous, current, visible) {
    if (!sessionId || previous === current) return;
    if (current === 'busy') return this.dismiss(sessionId);
    if (visible || !previous || previous === 'exited') return;
    if (current === 'waiting') return this.add(sessionId, name, 'waiting');
    if (current === 'idle' && previous === 'busy') return this.add(sessionId, name, 'finished');
  }
}

class Tracker {
  constructor(store, notifications) {
    this.store = store;
    this.notifications = notifications;
    this.groups = [];
    this.meta = new Map();
    this.titles = new Map();
    this.restoring = false;
    this.scanning = false;
    this.placing = 0;
    this.terminalFocused = true;
    this.onChange = new vscode.EventEmitter();
    this.onFocusChange = new vscode.EventEmitter();
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



  editorFocusedSince(time) {
    return Boolean(this.editorFocusAt && this.editorFocusAt > (time || 0));
  }

  rememberName(sessionId, name) {
    const names = this.store.readState().names || {};
    if (names[sessionId] === name) return;
    this.store.writeState({ names: { ...names, [sessionId]: name } });
  }

  setTerminalFocus(value) {
    if (!value) this.editorFocusAt = Date.now();
    if (this.terminalFocused === value) return;
    this.terminalFocused = value;
    this.onFocusChange.fire();
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

  async hasSessionFile(sessionId) {
    this.knownFiles = this.knownFiles || new Set();
    if (this.knownFiles.has(sessionId)) return true;
    if ((await filesForSession(sessionId)).length === 0) return false;
    this.knownFiles.add(sessionId);
    return true;
  }

  poll() {
    if (this.scanning) return Promise.resolve();
    if (this.pollRun) {
      this.pollAgain = true;
      return this.pollRun;
    }
    this.pollRun = (async () => {
      do {
        this.pollAgain = false;
        try {
          await this.pollOnce();
        } catch (err) {
          if (this.log) this.log(`poll failed: ${err && err.stack ? err.stack : err}`);
        }
      } while (this.pollAgain && !this.scanning);
    })().finally(() => {
      this.pollRun = null;
    });
    return this.pollRun;
  }

  async pollOnce() {
    this.syncGroups();
    const [running, children] = await Promise.all([readRunningSessions(), processChildren()]);
    for (const t of this.liveTerminals()) {
      const m = this.meta.get(t) || { name: '', nameSource: 'auto', sessionId: null, cwd: null };
      const pid = await withTimeout(t.processId, 1000).catch(() => undefined);
      const s = pid ? findSession(pid, children, running) : null;
      if (s && !m.sessionId && !(await this.hasSessionFile(s.sessionId))) {
        const claimed = new Set([...this.meta.values()].map((x) => x.sessionId));
        const saved = this.store.read().find((tab) => tab.name === t.name && !claimed.has(tab.sessionId));
        if (saved && (await this.hasSessionFile(saved.sessionId))) Object.assign(m, { name: saved.name, nameSource: 'user', sessionId: saved.sessionId, cwd: saved.cwd });
      }
      const expecting = m.expectedSessionId && Date.now() < (m.expectedUntil || 0);
      const staleRegistry = s && expecting && s.sessionId !== m.expectedSessionId;
      const switching = s && !staleRegistry && m.sessionId && m.sessionId !== s.sessionId;
      const unbacked = switching && !(await this.hasSessionFile(s.sessionId)) && (await this.hasSessionFile(m.sessionId));
      if (s && !staleRegistry && !unbacked) {
        if (m.sessionId && m.sessionId !== s.sessionId) this.forget(m.sessionId);
        m.sessionId = s.sessionId;
        m.cwd = s.cwd;
        m.expectedSessionId = null;
      }
      if (!m.cwd) {
        const si = t.shellIntegration && t.shellIntegration.cwd;
        m.cwd = si ? si.fsPath : pid ? await cwdOfPid(pid) : null;
      }
      this.observeName(t, m);
      if (m.nameSource === 'user' && m.sessionId && m.name) this.rememberName(m.sessionId, m.name);
      const status = s ? s.status || 'idle' : m.sessionId ? 'exited' : null;
      if (status === 'busy' && m.status !== 'busy' && vscode.window.activeTerminal === t && vscode.window.state.focused && !this.editorFocusedSince(m.statusChangedAt)) this.setTerminalFocus(true);
      if (status !== m.status) m.statusChangedAt = Date.now();
      const visible = this.terminalFocused && vscode.window.state.focused && vscode.window.activeTerminal === t;
      this.notifications.onStatus(m.sessionId, m.name, m.status, status, visible);
      m.status = status;
      this.meta.set(t, m);
    }
    const signature = JSON.stringify(this.groups.map((g) => g.map((t) => [(this.meta.get(t) || {}).name, (this.meta.get(t) || {}).sessionId, (this.meta.get(t) || {}).status])));
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

  async waitForActive(previous, ms = 250) {
    if (vscode.window.activeTerminal !== previous) return;
    await new Promise((resolve) => {
      const sub = vscode.window.onDidChangeActiveTerminal(() => {
        sub.dispose();
        resolve();
      });
      setTimeout(() => {
        sub.dispose();
        resolve();
      }, ms);
    });
  }

  async command(id) {
    const before = vscode.window.activeTerminal;
    await vscode.commands.executeCommand(id);
    await this.waitForActive(before, this.stepMs);
  }

  noteOpened(t) {
    this.openCount = (this.openCount || 0) + 1;
    this.lastOpened = t;
    clearTimeout(this.placeTimer);
    this.placeTimer = setTimeout(() => this.placeNewTerminal(t), 600);
  }

  async placeNewTerminal(t) {
    if (this.scanning || this.placing || vscode.window.activeTerminal !== t) return;
    const opened = this.openCount;
    this.syncGroups();
    const own = this.groups.find((g) => g.includes(t));
    if (!own || own.length > 1) return;
    this.scanning = true;
    this.stepMs = 250;
    try {
      await this.command('workbench.action.terminal.focusPreviousPane');
      const neighbour = vscode.window.activeTerminal;
      if (this.openCount !== opened) {
        if (this.lastOpened && vscode.window.activeTerminal !== this.lastOpened) this.lastOpened.show(false);
      } else if (neighbour && neighbour !== t) {
        await this.command('workbench.action.terminal.focusNextPane');
        if (vscode.window.activeTerminal !== t) t.show(false);
        const group = this.groups.find((g) => g.includes(neighbour));
        if (group && group !== own) {
          this.groups = this.groups.filter((g) => g !== own);
          group.splice(group.indexOf(neighbour) + 1, 0, t);
        }
      }
    } finally {
      this.scanning = false;
    }
    await this.poll();
  }

  async scanLayout(stepMs = 250) {
    const live = this.liveTerminals();
    if (!live.length || this.scanning) return;
    this.scanning = true;
    this.stepMs = stepMs;
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
    await this.openTabs(tabs);
    vscode.window.showInformationMessage(`Restored ${tabs.length} Claude tabs.`);
  }

  async openTabs(tabs) {
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
        this.meta.set(t, { name: tab.name, nameSource: 'user', sessionId: tab.sessionId, cwd, expectedSessionId: tab.sessionId, expectedUntil: Date.now() + 30000 });
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
  }
}

function pickerOrder(sessions, isFavorite, isArchived) {
  const newest = (a, b) => Date.parse(b.meta.lastActivity) - Date.parse(a.meta.lastActivity);
  const live = sessions.filter((s) => !isArchived(s.id));
  return live
    .filter((s) => isFavorite(s.id))
    .sort(newest)
    .concat(live.filter((s) => !isFavorite(s.id)).sort(newest))
    .concat(sessions.filter((s) => isArchived(s.id)).sort(newest));
}

const terminalKeys = new WeakMap();
let nextTerminalKey = 1;
function terminalKey(t) {
  if (!terminalKeys.has(t)) terminalKeys.set(t, nextTerminalKey++);
  return terminalKeys.get(t);
}

function sortSessions(sessions, isFavorite) {
  const favorites = sessions.filter((s) => isFavorite(s.id)).sort((a, b) => a.title.localeCompare(b.title));
  const others = sessions.filter((s) => !isFavorite(s.id)).sort((a, b) => Date.parse(b.meta.lastActivity) - Date.parse(a.meta.lastActivity));
  return favorites.concat(others);
}

class SessionsProvider {
  constructor(mode, store, tracker, notifications) {
    this.mode = mode;
    this.store = store;
    this.tracker = tracker;
    this.notifications = notifications;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.loadingMeta = new Set();
  }

  refresh(fast = false) {
    if (!fast) this.needsFull = true;
    this.emitter.fire();
  }

  getTreeItem(e) {
    return e;
  }

  label(sessionId, name) {
    return sessionId ? `${this.notifications.isFavorite(sessionId) ? '★' : '☆'} ${name}` : name;
  }

  favSuffix(sessionId) {
    return this.notifications.isFavorite(sessionId) ? '.fav' : '';
  }

  async activeTabItem(t, inSplit) {
    const m = this.tracker.meta.get(t) || {};
    const known = m.sessionId && (this.store.readState().names || {})[m.sessionId];
    const name = (m.nameSource === 'user' && m.name) || known || m.name || t.name;
    const item = new vscode.TreeItem(this.label(m.sessionId, name));
    item.id = `terminal:${terminalKey(t)}`;
    item.contextValue = m.sessionId
      ? `${inSplit ? 'activeTabInSplit' : 'activeTab'}${this.favSuffix(m.sessionId)}`
      : inSplit ? 'activeTerminalInSplit' : 'activeTerminal';
    const focused = this.tracker.terminalFocused && vscode.window.state.focused && vscode.window.activeTerminal === t;
    const look = tabPresentation({ status: m.status, focused });
    const notice = m.sessionId && this.notifications.list().find((n) => n.sessionId === m.sessionId);
    item.label = `${this.label(m.sessionId, name)}${look.nameSuffix}`;
    item.iconPath = notice
      ? new vscode.ThemeIcon(notice.kind === 'waiting' ? 'bell-dot' : 'bell', new vscode.ThemeColor('charts.yellow'))
      : new vscode.ThemeIcon(look.icon);
    let meta = m.sessionId ? peekMeta(m.sessionId) : null;
    if (m.sessionId && !meta && !this.loadingMeta.has(m.sessionId)) {
      this.loadingMeta.add(m.sessionId);
      metaForSession(m.sessionId)
        .then(() => this.refresh(true))
        .finally(() => this.loadingMeta.delete(m.sessionId));
    }
    const noticeText = notice ? `${notice.kind === 'waiting' ? 'waiting for input' : 'finished'} ${timeAgo(notice.at)}` : '';
    item.description = noticeText || sessionSummary(meta);
    item.tooltip = m.sessionId
      ? sessionTooltip(name, meta, [['Status', noticeText || look.hoverLine], ['Folder', m.cwd]])
      : `${name}\n${look.hoverLine}`;
    item.command = { command: 'claudeSessions.focusTab', title: 'Focus tab', arguments: [t] };
    item.data = { terminal: t, tab: { name, sessionId: m.sessionId, cwd: m.cwd } };
    return item;
  }

  activeChildren() {
    this.tracker.syncGroups();
    const groups = this.tracker.groups.filter((g) => g.length);
    return Promise.all(
      groups.map(async (g) => {
        if (g.length === 1) return this.activeTabItem(g[0], false);
        const item = new vscode.TreeItem('split', vscode.TreeItemCollapsibleState.Expanded);
        item.id = `split:${terminalKey(g[0])}`;
        item.contextValue = 'split';
        item.iconPath = new vscode.ThemeIcon('split-horizontal');
        item.data = { terminals: g };
        return item;
      })
    );
  }

  async inactiveSessions() {
    const [metas, running] = await Promise.all([
      listRepoSessions(this.store.wsPath, settings().get('historyDays') || 30),
      readRunningSessions(),
    ]);
    const live = new Set([...running.values()].map((s) => s.sessionId));
    const saved = new Map(this.store.read().map((t) => [t.sessionId, t.name]));
    const names = this.store.readState().names || {};
    return metas
      .filter((m) => !live.has(m.id))
      .map((m) => ({
        id: m.id,
        meta: m,
        saved: saved.has(m.id),
        title: names[m.id] || saved.get(m.id) || m.customTitle || m.aiTitle || oneLine(m.firstPrompt || (m.lastUser && m.lastUser.text), 60) || m.id,
      }));
  }

  sessionItem(s, archived) {
    const item = new vscode.TreeItem(this.label(s.id, s.title));
    item.id = `${archived ? 'archived' : 'session'}:${s.id}`;
    item.contextValue = `${archived ? 'archivedSession' : s.saved ? 'savedTab' : 'session'}${this.favSuffix(s.id)}`;
    item.iconPath = new vscode.ThemeIcon(archived ? 'archive' : s.saved ? 'bookmark' : 'comment-discussion');
    item.description = sessionSummary(s.meta);
    item.tooltip = sessionTooltip(s.title, s.meta, [['Folder', s.meta.cwd]]);
    item.data = { tab: { name: s.title, sessionId: s.id, cwd: s.meta.cwd } };
    item.command = { command: 'claudeSessions.openSessionFile', title: 'Open session file', arguments: [item] };
    return item;
  }

  async getChildren(e) {
    if (this.mode === 'active') {
      if (!e) return this.activeChildren();
      if (e.data.terminals) return Promise.all(e.data.terminals.map((t) => this.activeTabItem(t, true)));
      return [];
    }
    if (e && e.data.kind === 'archiveFolder') return this.archive.map((s) => this.sessionItem(s, true));
    if (e) return [];
    const full = this.needsFull || !this.sessionsCache;
    this.needsFull = false;
    const sessions = full ? await this.inactiveSessions() : this.sessionsCache;
    this.sessionsCache = sessions;
    const archived = this.store.readState().archived || {};
    const isFavorite = (id) => this.notifications.isFavorite(id);
    if (this.filter) {
      const hits = await searchSessions(sessions, this.filter);
      if (this.onSearched) this.onSearched(hits.length);
      return hits.map((s) => this.sessionItem(s, Boolean(archived[s.id])));
    }
    const inactive = sortSessions(sessions.filter((s) => !archived[s.id]), isFavorite);
    this.archive = sortSessions(sessions.filter((s) => archived[s.id]), isFavorite);
    const folder = new vscode.TreeItem(`archive (${this.archive.length})`, vscode.TreeItemCollapsibleState.Collapsed);
    folder.id = 'archive-folder';
    folder.contextValue = 'archiveFolder';
    folder.iconPath = new vscode.ThemeIcon('archive');
    folder.data = { kind: 'archiveFolder' };
    return inactive.map((s) => this.sessionItem(s, false)).concat([folder]);
  }
}

function activate(context) {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!folder) return;
  const store = new Store(folder.uri.fsPath);
  if (context.globalStorageUri) loadCache(context.globalStorageUri.fsPath);
  store.migrateLegacy();
  const notifications = new Notifications(store);
  const tracker = new Tracker(store, notifications);
  if (store.readState().priorities) store.writeState({ priorities: undefined });
  const activeView = new SessionsProvider('active', store, tracker, notifications);
  const inactiveView = new SessionsProvider('inactive', store, tracker, notifications);
  const activeTree = vscode.window.createTreeView('claudeSessions.active', { treeDataProvider: activeView });
  const inactiveTree = vscode.window.createTreeView('claudeSessions.inactive', { treeDataProvider: inactiveView });
  inactiveView.onSearched = (count) => {
    inactiveTree.message = `Search "${inactiveView.filter}" · ${count} matching sessions`;
  };
  const view = {
    refresh: (fast = false) => {
      activeView.refresh(fast);
      inactiveView.refresh(fast);
    },
    inactiveSessions: () => inactiveView.inactiveSessions(),
  };
  const currentVersion = (context.extension && context.extension.packageJSON.version) || '0.0.0';
  let updating = false;
  const checkForUpdates = async (manual) => {
    if (updating) return;
    updating = true;
    try {
      const release = await updater.latestRelease();
      if (!release || !updater.isNewer(release.version, currentVersion)) {
        if (manual) vscode.window.showInformationMessage(`Claude Sessions ${currentVersion} is up to date.`);
        return;
      }
      const file = await updater.downloadRelease(release, context.globalStorageUri.fsPath);
      await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
      inactiveTree.description = `updated to ${release.version} · reload to use it`;
      vscode.commands.executeCommand('setContext', 'claudeSessions.updated', true);
      tracker.log(`updated from ${currentVersion} to ${release.version}`);
    } catch (err) {
      tracker.log(`update check failed: ${err.message}`);
      if (manual) vscode.window.showWarningMessage(`Update check failed: ${err.message}`);
    } finally {
      updating = false;
    }
  };

  const updateBadge = () => {
    const count = notifications.list().length;
    activeTree.badge = count ? { value: count, tooltip: `${count} Claude sessions finished or are waiting for input` } : undefined;
  };

  const renameTerminal = async (t, name) => {
    if (vscode.window.activeTerminal !== t) {
      const shown = new Promise((resolve) => {
        const sub = vscode.window.onDidChangeActiveTerminal((a) => {
          if (a === t) {
            sub.dispose();
            resolve();
          }
        });
        setTimeout(() => {
          sub.dispose();
          resolve();
        }, 1000);
      });
      t.show(false);
      await shown;
    } else {
      t.show(false);
    }
    await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name });
  };

  const askName = (value) => vscode.window.showInputBox({ prompt: 'Tab and session name', value: value || '' });

  const resumeInNewTab = (tab) => {
    const cwd = tab.cwd && fs.existsSync(tab.cwd) ? tab.cwd : store.wsPath;
    const t = vscode.window.createTerminal({ name: tab.name, cwd, iconPath: new vscode.ThemeIcon('sparkle') });
    tracker.meta.set(t, { name: tab.name, nameSource: 'user', sessionId: tab.sessionId, cwd, expectedSessionId: tab.sessionId, expectedUntil: Date.now() + 30000 });
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
    await renameTerminal(t, tab.name);
    tracker.meta.set(t, { name: tab.name, nameSource: 'user', sessionId: tab.sessionId, cwd, expectedSessionId: tab.sessionId, expectedUntil: Date.now() + 30000 });
    tracker.save();
    view.refresh();
  };

  let pickerOpen = false;
  let splitting = Promise.resolve();
  const splitNextTo = (parent) => {
    const run = splitting.then(() => splitOnce(parent));
    splitting = run.catch(() => {});
    return run;
  };

  const splitOnce = async (parent) => {
    tracker.placing++;
    try {
      return await splitInto(parent);
    } finally {
      tracker.placing--;
    }
  };

  const splitInto = async (parent) => {
    if (vscode.window.activeTerminal !== parent) {
      const shown = new Promise((resolve) => {
        const sub = vscode.window.onDidChangeActiveTerminal((a) => {
          if (a === parent) {
            sub.dispose();
            resolve();
          }
        });
        setTimeout(() => {
          sub.dispose();
          resolve();
        }, 1500);
      });
      parent.show(false);
      await shown;
    }
    let t = null;
    if (vscode.window.activeTerminal === parent) {
      const before = new Set(vscode.window.terminals);
      await vscode.commands.executeCommand('workbench.action.terminal.split');
      for (let i = 0; i < 40 && !t; i++) {
        t = vscode.window.terminals.find((x) => !before.has(x)) || null;
        if (!t) await sleep(50);
      }
    }
    if (!t) t = vscode.window.createTerminal({ cwd: store.wsPath, location: { parentTerminal: parent } });
    tracker.groups = tracker.groups.map((g) => g.filter((x) => x !== t)).filter((g) => g.length);
    const group = tracker.groups.find((g) => g.includes(parent));
    if (group) group.splice(group.indexOf(parent) + 1, 0, t);
    else tracker.groups.push([parent, t]);
    return t;
  };

  const choose = async ({ allowPlain }) => {
    pickerOpen = true;
    const qp = vscode.window.createQuickPick();
    try {
      qp.placeholder = 'Search sessions by name or content, or start a new Claude session';
      qp.matchOnDescription = false;
      qp.busy = true;
      qp.show();
      const sessions = await view.inactiveSessions().catch(() => []);
      const archived = store.readState().archived || {};
      const isFavorite = (id) => notifications.isFavorite(id);
      const fixed = [
        { label: '$(sparkle) New Claude session', alwaysShow: true, choice: { kind: 'newSession' } },
        ...(allowPlain ? [{ label: '$(terminal) New plain terminal', alwaysShow: true, choice: { kind: 'terminal' } }] : []),
      ];
      const toItem = (s, query) => ({
        label: `${isFavorite(s.id) ? '★' : '☆'} ${s.title}`,
        description: `${sessionSummary(s.meta)}${archived[s.id] ? ' · archived' : ''}`,
        detail: query ? matchSnippet(s, query) : undefined,
        alwaysShow: true,
        choice: { kind: 'session', tab: { name: s.title, sessionId: s.id, cwd: s.meta.cwd } },
      });
      let run = 0;
      const render = async (query) => {
        const mine = ++run;
        qp.busy = true;
        const list = query.trim() ? await searchSessions(sessions, query) : pickerOrder(sessions, isFavorite, (id) => Boolean(archived[id]));
        if (mine !== run) return;
        qp.items = [...fixed, { label: query.trim() ? `${list.length} matching sessions` : 'Sessions', kind: vscode.QuickPickItemKind.Separator }, ...list.map((x) => toItem(x, query))];
        qp.busy = false;
      };
      let debounce;
      qp.onDidChangeValue((value) => {
        clearTimeout(debounce);
        debounce = setTimeout(() => render(value), 150);
      });
      await render('');
      const picked = await new Promise((resolve) => {
        qp.onDidAccept(() => resolve(qp.selectedItems[0]));
        qp.onDidHide(() => resolve(undefined));
      });
      return picked ? picked.choice : null;
    } finally {
      qp.dispose();
      pickerOpen = false;
    }
  };


  const applyChoice = async (t, choice) => {
    if (!vscode.window.terminals.includes(t)) return;
    t.show(false);
    if (choice.kind === 'terminal') return;
    if (choice.kind === 'newSession') {
      t.sendText(claudeCommand());
      return;
    }
    const tab = choice.tab;
    const cwd = tab.cwd && fs.existsSync(tab.cwd) ? tab.cwd : store.wsPath;
    t.sendText(`cd ${shellQuote(cwd)} && ${claudeCommand()} --resume ${tab.sessionId}`);
    tracker.meta.set(t, { name: tab.name, nameSource: 'user', sessionId: tab.sessionId, cwd, expectedSessionId: tab.sessionId, expectedUntil: Date.now() + 30000 });
    await renameTerminal(t, tab.name);
    tracker.save();
    view.refresh();
  };

  const openFreshThenPick = async (parent) => {
    const choice = await choose({ allowPlain: true });
    if (!choice) return;
    let t;
    if (parent && vscode.window.terminals.includes(parent)) {
      t = await splitNextTo(parent);
    } else {
      t = vscode.window.createTerminal({ cwd: store.wsPath });
      tracker.groups.push([t]);
    }
    view.refresh(true);
    await applyChoice(t, choice);
  };

  const terminalOf = (item) => (item && item.data && item.data.terminal) || vscode.window.activeTerminal;

  const pickIntoExisting = async (t) => {
    const [running, children] = await Promise.all([readRunningSessions(), processChildren()]);
    const pid = await withTimeout(t.processId, 1000).catch(() => undefined);
    const current = pid ? findSession(pid, children, running) : null;
    if (current) {
      if (current.status === 'busy') {
        vscode.window.showWarningMessage('This Claude session is working right now; switch it once it is idle.');
        return;
      }
      const choice = await choose({ allowPlain: false });
      if (!choice || !vscode.window.terminals.includes(t)) return;
      t.show(false);
      if (choice.kind === 'newSession') {
        t.sendText('/clear');
        tracker.meta.set(t, { ...(tracker.meta.get(t) || {}), name: '', nameSource: 'auto', sessionId: null });
        view.refresh();
        return;
      }
      if (choice.tab.sessionId === current.sessionId) return;
      const tab = choice.tab;
      t.sendText(`/resume ${tab.sessionId}`);
      await renameTerminal(t, tab.name);
      tracker.meta.set(t, { name: tab.name, nameSource: 'user', sessionId: tab.sessionId, cwd: tab.cwd || current.cwd, expectedSessionId: tab.sessionId, expectedUntil: Date.now() + 30000 });
      tracker.rememberName(tab.sessionId, tab.name);
      tracker.save();
      view.refresh();
      return;
    }
    const idle = pid && (children.get(pid) || []).length === 0;
    if (!idle) {
      vscode.window.showWarningMessage('This terminal is busy; pick a session for a new tab instead.');
      return openFreshThenPick(null);
    }
    const choice = await choose({ allowPlain: false });
    if (choice) await applyChoice(t, choice);
  };


  const setArchived = (sessionId, value) => {
    const archived = { ...(store.readState().archived || {}) };
    if (value) archived[sessionId] = true;
    else delete archived[sessionId];
    store.writeState({ archived });
    view.refresh(true);
  };

  let focusRefresh = null;
  const minuteTimer = setInterval(() => view.refresh(true), 60000);
  updateBadge();

  const log = vscode.window.createOutputChannel('Claude Sessions');
  tracker.log = (line) => log.appendLine(`${new Date().toISOString()} ${line}`);
  const canScan = () => !tracker.restoring && !tracker.scanning && !pickerOpen && vscode.window.state.focused;
  const stateDb = context.storageUri ? path.join(path.dirname(context.storageUri.fsPath), 'state.vscdb') : null;
  const sizesOf = (groups) => JSON.stringify(groups.map((g) => g.length));
  const scan = async (reason) => {
    await tracker.scanLayout();
    const expected = await vscodeGroupSizes(stateDb);
    let result = sizesOf(tracker.groups);
    if (expected && JSON.stringify(expected) !== result) {
      await tracker.scanLayout(900);
      result = sizesOf(tracker.groups);
    }
    log.appendLine(`${new Date().toISOString()} layout scan (${reason}): ${result}${expected ? ` · VS Code ${JSON.stringify(expected)}` : ''}`);
    view.refresh(true);
  };

  let debounce = null;
  const scheduleScan = () => {
    lastTerminalChange = Date.now();
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (!settings().get('autoCaptureLayout')) return;
      if (!canScan()) return scheduleScan();
      scan('terminal opened or closed');
    }, 1500);
  };

  let lastVscodeLayout = null;
  let layoutStale = false;
  const setLayoutStale = (value) => {
    if (layoutStale === value) return;
    layoutStale = value;
    vscode.commands.executeCommand('setContext', 'claudeSessions.layoutStale', value);
    activeTree.message = value ? 'The split layout changed. Use the capture button above to update it (focus briefly cycles through the terminals).' : undefined;
  };
  let lastTerminalChange = 0;
  const checkLayout = async () => {
    const sizes = await vscodeGroupSizes(stateDb);
    if (!sizes) return;
    const signature = JSON.stringify(sizes);
    if (Date.now() - lastTerminalChange < 5000) return;
    let savedAt = 0;
    try {
      savedAt = fs.statSync(stateDb).mtimeMs;
    } catch {}
    if (savedAt < lastTerminalChange) return;
    tracker.syncGroups();
    const ours = JSON.stringify(tracker.groups.map((g) => g.length));
    setLayoutStale(ours !== signature);
    if (ours === signature || signature === lastVscodeLayout || !settings().get('autoCaptureLayout') || !canScan()) return;
    lastVscodeLayout = signature;
    await scan(`VS Code layout ${signature} differs from ${ours}`);
    const after = JSON.stringify(tracker.groups.map((g) => g.length));
    if (after !== signature) tracker.log(`layout still differs after one capture (${after} vs ${signature}); not retrying until VS Code's layout changes`);
  };
  const layoutTimer = setInterval(checkLayout, 10000);

  let timer = null;
  const startTimer = () => {
    clearInterval(timer);
    timer = setInterval(() => tracker.poll(), Math.max(1, settings().get('pollSeconds') || 5) * 1000);
  };
  startTimer();

  context.subscriptions.push(
    log,
    { dispose: () => clearInterval(layoutTimer) },
    vscode.window.onDidChangeWindowState((w) => w.focused && checkLayout()),
    activeTree,
    inactiveTree,
    activeTree.onDidChangeSelection((e) => {
      const item = e.selection[0];
      if (item && item.data && item.data.terminal) return;
      tracker.setTerminalFocus(false);
    }),
    inactiveTree.onDidChangeSelection(() => tracker.setTerminalFocus(false)),
    vscode.window.onDidChangeTextEditorSelection(() => tracker.setTerminalFocus(false)),
    vscode.window.onDidChangeActiveTextEditor((e) => e && tracker.setTerminalFocus(false)),
    tracker.onFocusChange.event(() => {
      clearTimeout(focusRefresh);
      focusRefresh = setTimeout(() => view.refresh(), 30);
    }),
    notifications.onChange.event(() => {
      view.refresh(true);
      updateBadge();
    }),
    vscode.commands.registerCommand('claudeSessions.archive', (item) => setArchived(item.data.tab.sessionId, true)),
    vscode.commands.registerCommand('claudeSessions.unarchive', (item) => setArchived(item.data.tab.sessionId, false)),
    vscode.commands.registerCommand('claudeSessions.favorite', (item) => {
      const id = item.data.tab && item.data.tab.sessionId;
      if (id) notifications.setFavorite(id, true);
    }),
    vscode.commands.registerCommand('claudeSessions.unfavorite', (item) => {
      const id = item.data.tab && item.data.tab.sessionId;
      if (id) notifications.setFavorite(id, false);
    }),
    vscode.commands.registerCommand('claudeSessions.closeTab', (item) => item.data.terminal && item.data.terminal.dispose()),
    vscode.commands.registerCommand('claudeSessions.deleteSession', async (item) => {
      const tab = item.data.tab;
      if (!tab || !tab.sessionId) return;
      const { files, dirs } = await sessionPaths(tab.sessionId);
      if (!files.length) {
        vscode.window.showWarningMessage(`No session files found for ${tab.name}.`);
        return;
      }
      const meta = await metaForSession(tab.sessionId);
      const open = item.data.terminal;
      const answer = await vscode.window.showWarningMessage(
        `Delete the session "${tab.name}" completely?`,
        {
          modal: true,
          detail: [
            meta ? sessionSummary(meta) : '',
            `${files.length} session file(s)${dirs.length ? ` and ${dirs.length} folder(s)` : ''} go to the system Trash.`,
            open ? 'Its tab is closed first.' : '',
          ].filter(Boolean).join('\n'),
        },
        'Delete'
      );
      if (answer !== 'Delete') return;
      if (open) {
        open.dispose();
        for (let i = 0; i < 50; i++) {
          const running = [...(await readRunningSessions()).values()].some((r) => r.sessionId === tab.sessionId);
          if (!running) break;
          await sleep(100);
        }
      }
      if ([...(await readRunningSessions()).values()].some((r) => r.sessionId === tab.sessionId)) {
        vscode.window.showWarningMessage(`${tab.name} is still running in another window; nothing was deleted.`);
        return;
      }
      for (const p of [...files, ...dirs]) {
        await vscode.workspace.fs.delete(vscode.Uri.file(p), { recursive: true, useTrash: true });
      }
      const state = store.readState();
      const drop = (map) => {
        const next = { ...(map || {}) };
        delete next[tab.sessionId];
        return next;
      };
      store.writeState({
        names: drop(state.names),
        favorites: drop(state.favorites),
        archived: drop(state.archived),
        tabs: (state.tabs || []).filter((t) => t.sessionId !== tab.sessionId),
        notifications: (state.notifications || []).filter((n) => n.sessionId !== tab.sessionId),
      });
      tracker.log(`deleted session ${tab.sessionId} (${tab.name}): ${[...files, ...dirs].join(', ')}`);
      view.refresh();
    }),
    vscode.commands.registerCommand('claudeSessions.addToSplit', (item) => openFreshThenPick(item && item.data.terminals ? item.data.terminals[0] : terminalOf(item))),
    vscode.commands.registerCommand('claudeSessions.splitTab', (item) => openFreshThenPick(terminalOf(item))),
    vscode.commands.registerCommand('claudeSessions.openNew', () => openFreshThenPick(null)),
    vscode.commands.registerCommand('claudeSessions.openInTerminal', (item) => terminalOf(item) && pickIntoExisting(terminalOf(item))),
    vscode.commands.registerCommand('claudeSessions.switchSession', (item) => terminalOf(item) && pickIntoExisting(terminalOf(item))),
    vscode.window.onDidChangeWindowState(() => view.refresh()),
    vscode.window.onDidChangeActiveTerminal((t) => {
      if (tracker.scanning || !t) return;
      const m = tracker.meta.get(t);
      if (m && m.sessionId && vscode.window.state.focused) notifications.dismiss(m.sessionId);
      const known = m && m.sessionId && (store.readState().names || {})[m.sessionId];
      if (known && (m.nameSource !== 'user' || m.name !== known)) {
        vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name: known });
        tracker.meta.set(t, { ...m, name: known, nameSource: 'user' });
      }
      tracker.setTerminalFocus(true);
      clearTimeout(focusRefresh);
      focusRefresh = setTimeout(() => view.refresh(), 30);
    }),
    { dispose: () => clearInterval(minuteTimer) },
    tracker.onChange.event(() => view.refresh()),
    vscode.window.onDidOpenTerminal((t) => {
      scheduleScan();
      tracker.noteOpened(t);
    }),
    vscode.window.onDidCloseTerminal((t) => {
      const m = tracker.meta.get(t);
      if (m && m.sessionId) {
        tracker.forget(m.sessionId);
        notifications.dismiss(m.sessionId);
      }
      tracker.meta.delete(t);
      scheduleScan();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('claudeSessions') && startTimer()),
    { dispose: () => clearInterval(timer) },
    vscode.commands.registerCommand('claudeSessions.restore', () => tracker.restore()),
    vscode.commands.registerCommand('claudeSessions.openSessionFile', async (item) => {
      const id = item && item.data && item.data.tab && item.data.tab.sessionId;
      const meta = id ? await metaForSession(id) : null;
      if (!meta || !meta.file) {
        vscode.window.showWarningMessage('No session file found.');
        return;
      }
      await vscode.window.showTextDocument(vscode.Uri.file(meta.file), { preview: true, preserveFocus: false });
    }),
    vscode.commands.registerCommand('claudeSessions.checkForUpdates', () => checkForUpdates(true)),
    vscode.commands.registerCommand('claudeSessions.reloadWindow', () => vscode.commands.executeCommand('workbench.action.reloadWindow')),
    vscode.commands.registerCommand('claudeSessions.captureLayout', async () => {
      await scan('manual');
      lastTerminalChange = 0;
      await checkLayout();
    }),
    vscode.commands.registerCommand('claudeSessions.refresh', () => view.refresh()),
    vscode.commands.registerCommand('claudeSessions.focusTab', (t) => {
      if (!t) return;
      t.show(false);
      setTimeout(() => tracker.setTerminalFocus(true), 50);
    }),
    vscode.commands.registerCommand('claudeSessions.openStateFile', () => vscode.window.showTextDocument(vscode.Uri.file(store.file()))),
    vscode.commands.registerCommand('claudeSessions.resume', (item) => resume(item.data.tab)),
    vscode.commands.registerCommand('claudeSessions.resumeNewTab', (item) => resumeInNewTab(item.data.tab)),
    vscode.commands.registerCommand('claudeSessions.copyResume', (item) => {
      const { tab } = item.data;
      vscode.env.clipboard.writeText(`cd ${shellQuote(tab.cwd || store.wsPath)} && ${claudeCommand()} --resume ${tab.sessionId}`);
    }),
    vscode.commands.registerCommand('claudeSessions.renameSaved', async (item) => {
      const { tab } = item.data;
      const name = await askName(tab.name);
      if (!name) return;
      const tabs = store.read();
      if (tabs.some((t) => t.sessionId === tab.sessionId)) store.write(tabs.map((t) => (t.sessionId === tab.sessionId ? { ...t, name } : t)));
      tracker.rememberName(tab.sessionId, name);
      const open = tracker.liveTerminals().find((t) => (tracker.meta.get(t) || {}).sessionId === tab.sessionId);
      if (open) {
        await renameTerminal(open, name);
        tracker.meta.set(open, { ...tracker.meta.get(open), name, nameSource: 'user' });
      }
      view.refresh();
    }),
    vscode.commands.registerCommand('claudeSessions.searchInactive', async () => {
      const box = vscode.window.createInputBox();
      box.placeholder = 'Search inactive sessions by name or content';
      box.value = inactiveView.filter || '';
      let debounce;
      const apply = (value) => {
        inactiveView.filter = value.trim();
        vscode.commands.executeCommand('setContext', 'claudeSessions.searching', Boolean(inactiveView.filter));
        if (!inactiveView.filter) inactiveTree.message = undefined;
        inactiveView.refresh(true);
      };
      box.onDidChangeValue((value) => {
        clearTimeout(debounce);
        debounce = setTimeout(() => apply(value), 200);
      });
      box.onDidAccept(() => box.hide());
      box.onDidHide(() => box.dispose());
      box.show();
    }),
    vscode.commands.registerCommand('claudeSessions.clearSearch', () => {
      inactiveView.filter = '';
      inactiveTree.message = undefined;
      vscode.commands.executeCommand('setContext', 'claudeSessions.searching', false);
      inactiveView.refresh(true);
    }),
    vscode.commands.registerCommand('claudeSessions.removeSaved', (item) => tracker.forget(item.data.tab.sessionId)),
    vscode.commands.registerCommand('claudeSessions.renameTab', async (arg) => {
      const fromItem = arg && arg.data && arg.data.terminal;
      const t = fromItem || (arg && typeof arg.sendText === 'function' ? arg : vscode.window.activeTerminal);
      if (!t) return;
      const m = tracker.meta.get(t) || { nameSource: 'auto', sessionId: null, cwd: null };
      const name = await askName(m.name || t.name);
      if (!name) return;
      await renameTerminal(t, name);
      const updated = { ...m, name, nameSource: 'user' };
      tracker.meta.set(t, updated);
      if (updated.sessionId) tracker.rememberName(updated.sessionId, name);
      tracker.save();
    })
  );

  tracker.poll();
  setTimeout(() => {
    tracker.poll();
    if (settings().get('autoCaptureLayout') && tracker.liveTerminals().length > 1 && canScan()) scan('startup');
  }, 4000);
  setTimeout(checkLayout, 15000);
  if (settings().get('autoUpdate') !== false && context.globalStorageUri) {
    setTimeout(() => checkForUpdates(false), 30000);
    const updateTimer = setInterval(() => checkForUpdates(false), 60 * 60 * 1000);
    context.subscriptions.push({ dispose: () => clearInterval(updateTimer) });
  }
  setTimeout(async () => {
    const started = Date.now();
    await loadTextCache();
    const sessions = await view.inactiveSessions().catch(() => []);
    for (const s of sessions) {
      if (s.meta.file) await conversationText(s.meta.file).catch(() => '');
      await sleep(10);
    }
    tracker.log(`search cache ready for ${sessions.length} sessions in ${Date.now() - started} ms`);
  }, 5000);
  return { tracker, store, notifications, activeView, inactiveView };
}

function vscodeGroupSizes(stateDb) {
  if (!stateDb || !fs.existsSync(stateDb)) return Promise.resolve(null);
  return new Promise((resolve) =>
    execFile('sqlite3', ['-readonly', stateDb, "select value from ItemTable where key='terminal.integrated.layoutInfo'"], (err, out) => {
      if (err || !out.trim()) return resolve(null);
      try {
        resolve(parseGroupSizes(out));
      } catch {
        resolve(null);
      }
    })
  );
}

function parseGroupSizes(layoutJson) {
  const layout = JSON.parse(layoutJson);
  return (layout.tabs || []).map((t) => (t.terminals || []).length).filter((n) => n > 0);
}

function deactivate() {}

module.exports = { activate, deactivate, Notifications, Store, Tracker, sortSessions, pickerOrder, parseGroupSizes };
