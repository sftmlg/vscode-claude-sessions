'use strict';
const fs = require('fs');
const path = require('path');
const sessions = require('../sessions');

const TITLE_MAX = 80;
const SNIPPET_MAX = 120;
const ALL_DAYS = 3650;

function displayTitle(meta, autoName, given) {
  if (meta && meta.customTitle) return meta.customTitle;
  if (given) return given;
  const named = meta ? sessions.sessionName(meta) : '';
  if (named) return named;
  if (meta && meta.firstPrompt) return sessions.oneLine(meta.firstPrompt, TITLE_MAX);
  return autoName || null;
}

function lastPrompt(meta) {
  return meta && meta.lastUser && meta.lastUser.text ? sessions.oneLine(meta.lastUser.text, SNIPPET_MAX) : null;
}

const repoRoots = new Map();

function repoRoot(cwd, roots = []) {
  if (!cwd) return null;
  if (repoRoots.has(cwd)) return repoRoots.get(cwd);
  const stops = new Set(roots.map((r) => path.resolve(r)));
  let dir = path.resolve(cwd);
  let found = null;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      found = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (stops.has(dir) || parent === dir) break;
    dir = parent;
  }
  repoRoots.set(cwd, found);
  return found;
}

function repoName(cwd, roots = []) {
  if (!cwd) return null;
  return path.basename(repoRoot(cwd, roots) || cwd);
}

const states = new Map();

function extensionState(dir) {
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(path.join(dir, '.vscode', 'claude-sessions.json')).mtimeMs;
  } catch {
    return {};
  }
  const cached = states.get(dir);
  if (cached && cached.mtimeMs === mtimeMs) return cached.state;
  const state = sessions.readState(dir) || {};
  states.set(dir, { mtimeMs, state });
  return state;
}

function extensionInfo(sessionId, cwd, roots = []) {
  const dir = repoRoot(cwd, roots) || cwd;
  const state = dir ? extensionState(dir) : {};
  const favorite = Boolean(sessionId && state.favorites && state.favorites[sessionId] === true);
  const tab = Array.isArray(state.tabs) ? state.tabs.find((t) => t && t.sessionId === sessionId && typeof t.name === 'string' && t.name.trim()) : null;
  return { favorite, name: tab ? tab.name.trim() : null };
}

class Catalog {
  constructor(config, { days = ALL_DAYS, titleFor = () => null } = {}) {
    this.roots = config.roots;
    this.titleFor = titleFor;
    this.days = days;
    this.textRead = new Map();
    this.textInflight = new Map();
  }

  loadText(m) {
    if (!m.file || this.textRead.get(m.file) === m.mtimeMs) return Promise.resolve();
    let p = this.textInflight.get(m.file);
    if (!p) {
      p = sessions
        .conversationText(m.file)
        .catch(() => '')
        .then(() => {
          this.textRead.set(m.file, m.mtimeMs);
          this.textInflight.delete(m.file);
        });
      this.textInflight.set(m.file, p);
    }
    return p;
  }

  async list() {
    const byId = new Map();
    for (const root of this.roots) {
      for (const m of await sessions.listRepoSessions(root, this.days)) {
        const prev = byId.get(m.id);
        if (!prev || Date.parse(m.lastActivity) > Date.parse(prev.lastActivity)) byId.set(m.id, m);
      }
    }
    const { realUnder } = require('./registry');
    const kept = [];
    for (const m of byId.values()) if (m.cwd && (await realUnder(m.cwd, this.roots))) kept.push(m);
    return kept.sort((a, b) => Date.parse(b.lastActivity) - Date.parse(a.lastActivity));
  }

  async search(query, { limit = 20, running = new Map() } = {}) {
    const q = String(query || '').trim();
    const all = await this.list();
    if (q) for (const m of all) await this.loadText(m);
    const hits = q ? await sessions.searchSessions(all, q) : all;
    return Promise.all(hits.slice(0, limit).map(async (m) => {
      const run = running.get(m.id);
      const ext = extensionInfo(m.id, m.cwd, this.roots);
      return {
        sessionId: m.id,
        title: ext.name || displayTitle(m, null, this.titleFor(m.id)),
        favorite: ext.favorite,
        cwd: m.cwd,
        project: repoName(m.cwd, this.roots),
        running: run ? (run.managed ? 'service' : 'terminal') : null,
        name: run && run.managed ? run.name : null,
        pid: run && !run.managed ? run.pid : null,
        lastActivity: m.lastActivity || (m.mtimeMs ? new Date(m.mtimeMs).toISOString() : null),
        snippet: q ? sessions.matchSnippet(m, q) || (m.file ? await sessions.deepSnippet(m.file, q).catch(() => '') : '') : lastPrompt(m),
      };
    }));
  }

  async warm({ pauseMs = 10 } = {}) {
    await sessions.loadTextCache();
    const all = await this.list();
    for (const m of all) {
      await this.loadText(m);
      await sessions.sleep(pauseMs);
    }
    return all.length;
  }
}

module.exports = { Catalog, displayTitle, lastPrompt, repoName, repoRoot, extensionInfo };
