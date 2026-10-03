'use strict';
const fs = require('fs');
const path = require('path');
const sessions = require('../sessions');

const TITLE_MAX = 80;
const SNIPPET_MAX = 120;
const ALL_DAYS = 3650;

function displayTitle(meta, autoName) {
  const named = meta ? sessions.sessionName(meta) : '';
  if (named) return named;
  if (meta && meta.firstPrompt) return sessions.oneLine(meta.firstPrompt, TITLE_MAX);
  return autoName || null;
}

function lastPrompt(meta) {
  return meta && meta.lastUser && meta.lastUser.text ? sessions.oneLine(meta.lastUser.text, SNIPPET_MAX) : null;
}

const repoNames = new Map();

function repoName(cwd, roots = []) {
  if (!cwd) return null;
  if (repoNames.has(cwd)) return repoNames.get(cwd);
  const stops = new Set(roots.map((r) => path.resolve(r)));
  let dir = path.resolve(cwd);
  let found = null;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      found = path.basename(dir);
      break;
    }
    const parent = path.dirname(dir);
    if (stops.has(dir) || parent === dir) break;
    dir = parent;
  }
  const name = found || path.basename(cwd);
  repoNames.set(cwd, name);
  return name;
}

class Catalog {
  constructor(config, { days = ALL_DAYS } = {}) {
    this.roots = config.roots;
    this.days = days;
  }

  async list() {
    const byId = new Map();
    for (const root of this.roots) {
      for (const m of await sessions.listRepoSessions(root, this.days)) {
        const prev = byId.get(m.id);
        if (!prev || Date.parse(m.lastActivity) > Date.parse(prev.lastActivity)) byId.set(m.id, m);
      }
    }
    return [...byId.values()].sort((a, b) => Date.parse(b.lastActivity) - Date.parse(a.lastActivity));
  }

  async search(query, { limit = 20, running = new Map() } = {}) {
    const q = String(query || '').trim();
    const all = await this.list();
    const hits = q ? await sessions.searchSessions(all, q) : all;
    return hits.slice(0, limit).map((m) => {
      const run = running.get(m.id);
      return {
        sessionId: m.id,
        title: displayTitle(m),
        cwd: m.cwd,
        project: repoName(m.cwd, this.roots),
        running: run ? (run.managed ? 'service' : 'terminal') : null,
        name: run && run.managed ? run.name : null,
        pid: run && !run.managed ? run.pid : null,
        lastActivity: m.lastActivity,
        snippet: q ? sessions.matchSnippet(m, q) : lastPrompt(m),
      };
    });
  }

  async warm({ pauseMs = 10 } = {}) {
    await sessions.loadTextCache();
    const all = await this.list();
    for (const m of all) {
      if (m.file) await sessions.conversationText(m.file).catch(() => '');
      await sessions.sleep(pauseMs);
    }
    return all.length;
  }
}

module.exports = { Catalog, displayTitle, lastPrompt, repoName };
