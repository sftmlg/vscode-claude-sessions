'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
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
  renameSession,
  tabPresentation,
  timeAgo,
  readStateFile,
  writeStatePatch,
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

const AUTO_RENAME_INTERVAL_MS = 30 * 60 * 1000;
const STALE_MINUTES = 30;

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
    this.syncedNames = new Map();
    this.nameSeen = new Map();
    this.lastAutoRename = new Map();
    this.restoring = false;
    this.scanning = false;
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

  async syncSessionName(t, m, running, explicit = false) {
    if (m.nameSource !== 'user' || !running || !m.name || running.status === 'busy') return;
    if (!explicit) {
      if (!settings().get('syncSessionName')) return;
      const seen = this.nameSeen.get(t);
      this.nameSeen.set(t, m.name);
      if (seen !== m.name) return;
      const last = this.lastAutoRename.get(running.sessionId) || 0;
      if (Date.now() - last < AUTO_RENAME_INTERVAL_MS) return;
    }
    if (this.syncedNames.get(running.sessionId) === m.name) return;
    this.syncedNames.set(running.sessionId, m.name);
    const meta = await metaForSession(running.sessionId);
    if (meta && meta.customTitle === m.name) return;
    if (!explicit) this.lastAutoRename.set(running.sessionId, Date.now());
    t.sendText(`/rename ${m.name.replace(/[\r\n]+/g, ' ')}`);
  }

  editorFocusedSince(time) {
    return Boolean(this.editorFocusAt && this.editorFocusAt > (time || 0));
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

  async poll() {
    if (this.scanning || this.polling) return;
    this.polling = true;
    try {
      await this.pollOnce();
    } catch (err) {
      if (this.log) this.log(`poll failed: ${err && err.stack ? err.stack : err}`);
    } finally {
      this.polling = false;
    }
  }

  async pollOnce() {
    this.syncGroups();
    const [running, children] = await Promise.all([readRunningSessions(), processChildren()]);
    for (const t of this.liveTerminals()) {
      const m = this.meta.get(t) || { name: '', nameSource: 'auto', sessionId: null, cwd: null };
      const pid = await withTimeout(t.processId, 1000).catch(() => undefined);
      const s = pid ? findSession(pid, children, running) : null;
      const expecting = m.expectedSessionId && Date.now() < (m.expectedUntil || 0);
      const staleRegistry = s && expecting && s.sessionId !== m.expectedSessionId;
      if (s && !staleRegistry) {
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
      await this.syncSessionName(t, m, s);
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

  async scanLayout(stepMs = 250) {
    this.stepMs = stepMs;
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

function pickerOrder(sessions, isFavorite, isArchived) {
  const newest = (a, b) => Date.parse(b.meta.lastActivity) - Date.parse(a.meta.lastActivity);
  const live = sessions.filter((s) => !isArchived(s.id));
  return live
    .filter((s) => isFavorite(s.id))
    .sort(newest)
    .concat(live.filter((s) => !isFavorite(s.id)).sort(newest))
    .concat(sessions.filter((s) => isArchived(s.id)).sort(newest));
}

function sortSessions(sessions, isFavorite) {
  const favorites = sessions.filter((s) => isFavorite(s.id)).sort((a, b) => a.title.localeCompare(b.title));
  const others = sessions.filter((s) => !isFavorite(s.id)).sort((a, b) => Date.parse(b.meta.lastActivity) - Date.parse(a.meta.lastActivity));
  return favorites.concat(others);
}

class SessionsProvider {
  constructor(store, tracker, notifications) {
    this.store = store;
    this.tracker = tracker;
    this.notifications = notifications;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }

  refresh(fast = false) {
    this.fast = fast && Boolean(this.sessionsCache);
    this.emitter.fire();
  }

  getTreeItem(e) {
    return e;
  }

  folder(label, kind, count, collapsed) {
    const state = collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded;
    const item = new vscode.TreeItem(`${label} (${count})`, state);
    item.contextValue = kind;
    item.iconPath = new vscode.ThemeIcon({ activeFolder: 'terminal', inactiveFolder: 'history', archiveFolder: 'archive' }[kind]);
    item.data = { kind };
    return item;
  }

  relative(cwd) {
    return cwd && cwd !== this.store.wsPath ? path.relative(this.store.wsPath, cwd) : '';
  }

  label(sessionId, name) {
    return sessionId ? `${this.notifications.isFavorite(sessionId) ? '★' : '☆'} ${name}` : name;
  }

  favSuffix(sessionId) {
    return this.notifications.isFavorite(sessionId) ? '.fav' : '';
  }

  async activeTabItem(t, inSplit) {
    const m = this.tracker.meta.get(t) || {};
    const name = m.name || t.name;
    const item = new vscode.TreeItem(this.label(m.sessionId, name));
    item.contextValue = m.sessionId
      ? `${inSplit ? 'activeTabInSplit' : 'activeTab'}${this.favSuffix(m.sessionId)}`
      : inSplit ? 'activeTerminalInSplit' : 'activeTerminal';
    const focused = this.tracker.terminalFocused && vscode.window.state.focused && vscode.window.activeTerminal === t;
    const look = tabPresentation({ status: m.status, focused });
    item.label = `${this.label(m.sessionId, name)}${look.nameSuffix}`;
    item.iconPath = new vscode.ThemeIcon(look.icon);
    const meta = await metaForSession(m.sessionId);
    item.description = [sessionSummary(meta), this.relative(m.cwd)].filter(Boolean).join(' · ');
    item.tooltip = m.sessionId ? sessionTooltip(name, meta, [look.hoverLine, m.cwd]) : `${name}\n${look.hoverLine}`;
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
    return metas
      .filter((m) => !live.has(m.id))
      .map((m) => ({
        id: m.id,
        meta: m,
        saved: saved.has(m.id),
        title: saved.get(m.id) || m.customTitle || m.aiTitle || oneLine(m.firstPrompt || (m.lastUser && m.lastUser.text), 60) || m.id,
      }));
  }

  sessionItem(s, archived) {
    const item = new vscode.TreeItem(this.label(s.id, s.title));
    item.contextValue = `${archived ? 'archivedSession' : s.saved ? 'savedTab' : 'session'}${this.favSuffix(s.id)}`;
    item.iconPath = new vscode.ThemeIcon(archived ? 'archive' : s.saved ? 'bookmark' : 'comment-discussion');
    item.description = [sessionSummary(s.meta), this.relative(s.meta.cwd)].filter(Boolean).join(' · ');
    item.tooltip = sessionTooltip(s.title, s.meta, s.meta.firstPrompt ? [`First message: ${oneLine(s.meta.firstPrompt, 200)}`] : []);
    item.data = { tab: { name: s.title, sessionId: s.id, cwd: s.meta.cwd } };
    return item;
  }

  async getChildren(e) {
    if (!e) {
      const [active, sessions] = await Promise.all([
        this.activeChildren(),
        this.fast ? Promise.resolve(this.sessionsCache) : this.inactiveSessions(),
      ]);
      this.fast = false;
      this.sessionsCache = sessions;
      const archived = this.store.readState().archived || {};
      const isFavorite = (id) => this.notifications.isFavorite(id);
      const inactive = sortSessions(sessions.filter((s) => !archived[s.id]), isFavorite);
      const archive = sortSessions(sessions.filter((s) => archived[s.id]), isFavorite);
      this.cache = { active, inactive, archive };
      const activeCount = active.reduce((n, i) => n + (i.data.terminals ? i.data.terminals.length : 1), 0);
      return [
        this.folder('active', 'activeFolder', activeCount, false),
        this.folder('inactive', 'inactiveFolder', inactive.length, false),
        this.folder('archive', 'archiveFolder', archive.length, true),
      ];
    }
    if (!this.cache) await this.getChildren();
    if (e.data.kind === 'activeFolder') return this.cache.active;
    if (e.data.kind === 'inactiveFolder') return this.cache.inactive.map((s) => this.sessionItem(s, false));
    if (e.data.kind === 'archiveFolder') return this.cache.archive.map((s) => this.sessionItem(s, true));
    if (e.data.terminals) return Promise.all(e.data.terminals.map((t) => this.activeTabItem(t, true)));
    return [];
  }
}

class NotificationsProvider {
  constructor(notifications, tracker) {
    this.notifications = notifications;
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

  item(n) {
    const minutes = Math.round((Date.now() - Date.parse(n.at)) / 60000);
    const stale = minutes >= STALE_MINUTES;
    const favorite = this.notifications.isFavorite(n.sessionId);
    const item = new vscode.TreeItem(`${favorite ? '★' : '☆'} ${n.name || n.sessionId.slice(0, 8)}`);
    item.contextValue = favorite ? 'notification.fav' : 'notification';
    item.iconPath = new vscode.ThemeIcon(stale ? 'history' : n.kind === 'waiting' ? 'bell-dot' : 'check');
    const what = n.kind === 'waiting' ? 'waiting for input' : 'finished';
    item.description = `${what} ${timeAgo(n.at)}${stale ? ' · stale' : ''}`;
    item.tooltip = `${n.name}\n${what} at ${formatTime(n.at)}${favorite ? '\n★ Favorite' : ''}\nClick to focus the tab.`;
    item.command = { command: 'claudeSessions.openNotification', title: 'Focus session', arguments: [n] };
    item.data = { notification: n };
    return item;
  }

  getChildren(e) {
    if (e) return [];
    const fav = (n) => (this.notifications.isFavorite(n.sessionId) ? 0 : 1);
    return this.notifications
      .list()
      .sort((a, b) => fav(a) - fav(b) || Date.parse(b.at) - Date.parse(a.at))
      .map((n) => this.item(n));
  }
}

function activate(context) {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!folder) return;
  const store = new Store(folder.uri.fsPath);
  store.migrateLegacy();
  const notifications = new Notifications(store);
  const tracker = new Tracker(store, notifications);
  const notificationsView = new NotificationsProvider(notifications, tracker);
  const notificationsTree = vscode.window.createTreeView('claudeSessions.notifications', { treeDataProvider: notificationsView });
  const updateBadge = () => {
    const count = notifications.list().length;
    notificationsTree.badge = count ? { value: count, tooltip: `${count} Claude sessions need attention` } : undefined;
  };
  const terminalFor = (sessionId) => tracker.liveTerminals().find((t) => (tracker.meta.get(t) || {}).sessionId === sessionId);
  const view = new SessionsProvider(store, tracker, notifications);
  const sessionsTree = vscode.window.createTreeView('claudeSessions.sessions', { treeDataProvider: view });

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
    await renameTerminal(t, tab.name);
    tracker.meta.set(t, { name: tab.name, nameSource: 'user', sessionId: tab.sessionId, cwd, expectedSessionId: tab.sessionId, expectedUntil: Date.now() + 30000 });
    tracker.syncedNames.set(tab.sessionId, tab.name);
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

  const pickInto = async (t) => {
    pickerOpen = true;
    const sessions = await view.inactiveSessions().catch(() => []);
    const archived = store.readState().archived || {};
    const isFavorite = (id) => notifications.isFavorite(id);
    const ordered = pickerOrder(sessions, isFavorite, (id) => Boolean(archived[id]));
    let picked;
    try {
      picked = await vscode.window.showQuickPick(
        [
          { label: '$(sparkle) New Claude session', choice: { kind: 'newSession' } },
          { label: '$(terminal) Keep as plain terminal', choice: { kind: 'terminal' } },
          { label: 'Sessions', kind: vscode.QuickPickItemKind.Separator },
          ...ordered.map((s) => ({
            label: `${isFavorite(s.id) ? '★' : '☆'} ${s.title}`,
            description: `${sessionSummary(s.meta)}${archived[s.id] ? ' · archived' : ''}`,
            choice: { kind: 'session', tab: { name: s.title, sessionId: s.id, cwd: s.meta.cwd } },
          })),
        ],
        { placeHolder: 'Search a session, or start a new Claude session in this terminal', matchOnDescription: true }
      );
    } finally {
      pickerOpen = false;
    }
    if (!picked || picked.choice.kind === 'terminal') return;
    if (!vscode.window.terminals.includes(t)) {
      vscode.window.showWarningMessage('That terminal was closed while the picker was open.');
      return;
    }
    t.show(false);
    if (picked.choice.kind === 'newSession') {
      t.sendText(claudeCommand());
      return;
    }
    const tab = picked.choice.tab;
    const cwd = tab.cwd && fs.existsSync(tab.cwd) ? tab.cwd : store.wsPath;
    t.sendText(`cd ${shellQuote(cwd)} && ${claudeCommand()} --resume ${tab.sessionId}`);
    tracker.meta.set(t, { name: tab.name, nameSource: 'user', sessionId: tab.sessionId, cwd, expectedSessionId: tab.sessionId, expectedUntil: Date.now() + 30000 });
    tracker.syncedNames.set(tab.sessionId, tab.name);
    await renameTerminal(t, tab.name);
    tracker.save();
    view.refresh();
  };

  const openFreshThenPick = async (parent) => {
    let t;
    if (parent) {
      t = await splitNextTo(parent);
    } else {
      t = vscode.window.createTerminal({ cwd: store.wsPath });
      tracker.groups.push([t]);
    }
    t.show(false);
    view.refresh(true);
    await pickInto(t);
  };

  const pickIntoExisting = async (t) => {
    const [running, children] = await Promise.all([readRunningSessions(), processChildren()]);
    const pid = await withTimeout(t.processId, 1000);
    const idle = pid && !findSession(pid, children, running) && (children.get(pid) || []).length === 0;
    if (!idle) {
      vscode.window.showWarningMessage('This terminal is busy; opening the picker in a new tab instead.');
      return openFreshThenPick(null);
    }
    t.show(false);
    await pickInto(t);
  };


  const setArchived = (sessionId, value) => {
    const archived = { ...(store.readState().archived || {}) };
    if (value) archived[sessionId] = true;
    else delete archived[sessionId];
    store.writeState({ archived });
    view.refresh(true);
  };

  let focusRefresh = null;
  const minuteTimer = setInterval(() => notificationsView.refresh(), 60000);
  updateBadge();

  const log = vscode.window.createOutputChannel('Claude Sessions');
  tracker.log = (line) => log.appendLine(`${new Date().toISOString()} ${line}`);
  const canScan = () => settings().get('autoCaptureLayout') && !tracker.restoring && !tracker.scanning && !pickerOpen && vscode.window.state.focused;
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
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (!settings().get('autoCaptureLayout')) return;
      if (!canScan()) return scheduleScan();
      scan('terminal opened or closed');
    }, 1500);
  };

  let lastVscodeLayout = null;
  const checkLayout = async () => {
    const sizes = await vscodeGroupSizes(stateDb);
    if (!sizes) return;
    const signature = JSON.stringify(sizes);
    if (signature === lastVscodeLayout || !canScan()) return;
    tracker.syncGroups();
    const ours = JSON.stringify(tracker.groups.map((g) => g.length));
    if (ours === signature) {
      lastVscodeLayout = signature;
      return;
    }
    await scan(`VS Code layout ${signature} differs from ${ours}`);
    if (JSON.stringify(tracker.groups.map((g) => g.length)) === signature) lastVscodeLayout = signature;
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
    sessionsTree,
    sessionsTree.onDidChangeSelection((e) => {
      const item = e.selection[0];
      if (item && item.data && item.data.terminal) return;
      tracker.setTerminalFocus(false);
    }),
    notificationsTree.onDidChangeSelection(() => tracker.setTerminalFocus(false)),
    vscode.window.onDidChangeTextEditorSelection(() => tracker.setTerminalFocus(false)),
    vscode.window.onDidChangeActiveTextEditor((e) => e && tracker.setTerminalFocus(false)),
    tracker.onFocusChange.event(() => {
      clearTimeout(focusRefresh);
      focusRefresh = setTimeout(() => view.refresh(), 30);
    }),
    notificationsTree,
    notifications.onChange.event(() => {
      notificationsView.refresh();
      view.refresh(true);
      updateBadge();
    }),
    vscode.commands.registerCommand('claudeSessions.archive', (item) => setArchived(item.data.tab.sessionId, true)),
    vscode.commands.registerCommand('claudeSessions.unarchive', (item) => setArchived(item.data.tab.sessionId, false)),
    vscode.commands.registerCommand('claudeSessions.favorite', (item) => {
      const id = item.data.tab ? item.data.tab.sessionId : item.data.notification.sessionId;
      if (id) notifications.setFavorite(id, true);
    }),
    vscode.commands.registerCommand('claudeSessions.unfavorite', (item) => {
      const id = item.data.tab ? item.data.tab.sessionId : item.data.notification.sessionId;
      if (id) notifications.setFavorite(id, false);
    }),
    vscode.commands.registerCommand('claudeSessions.closeTab', (item) => item.data.terminal && item.data.terminal.dispose()),
    vscode.commands.registerCommand('claudeSessions.addToSplit', (item) => openFreshThenPick(item.data.terminals ? item.data.terminals[0] : item.data.terminal)),
    vscode.commands.registerCommand('claudeSessions.splitTab', (item) => openFreshThenPick(item.data.terminal)),
    vscode.commands.registerCommand('claudeSessions.openNew', () => openFreshThenPick(null)),
    vscode.commands.registerCommand('claudeSessions.openInTerminal', (item) => pickIntoExisting(item.data.terminal)),
    vscode.window.onDidChangeWindowState(() => view.refresh()),
    vscode.window.onDidChangeActiveTerminal((t) => {
      if (tracker.scanning || !t) return;
      const m = tracker.meta.get(t);
      if (m && m.sessionId && vscode.window.state.focused) notifications.dismiss(m.sessionId);
      tracker.setTerminalFocus(true);
      clearTimeout(focusRefresh);
      focusRefresh = setTimeout(() => view.refresh(), 30);
    }),
    { dispose: () => clearInterval(minuteTimer) },
    vscode.commands.registerCommand('claudeSessions.openNotification', (n) => {
      const t = terminalFor(n.sessionId);
      if (t) {
        t.show(false);
        setTimeout(() => tracker.setTerminalFocus(true), 50);
      }
      else vscode.window.showWarningMessage(`${n.name} is no longer open in this window.`);
      notifications.dismiss(n.sessionId);
    }),
    vscode.commands.registerCommand('claudeSessions.dismissNotification', (item) => notifications.dismiss(item.data.notification.sessionId)),
    vscode.commands.registerCommand('claudeSessions.dismissAll', () => notifications.save([])),
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
      try {
        await renameSession(tab.sessionId, name);
      } catch (err) {
        vscode.window.showWarningMessage(err.message);
      }
      view.refresh();
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
      const [running, children] = await Promise.all([readRunningSessions(), processChildren()]);
      const pid = await withTimeout(t.processId, 1000);
      tracker.syncedNames.delete(updated.sessionId);
      await tracker.syncSessionName(t, updated, pid ? findSession(pid, children, running) : null, true);
      tracker.save();
    })
  );

  setTimeout(() => {
    tracker.poll();
    if (tracker.liveTerminals().length > 1 && canScan()) scan('startup');
  }, 4000);
  setTimeout(checkLayout, 15000);
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
