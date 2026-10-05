'use strict';
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const sessions = require('../sessions');
const tmux = require('./tmux');
const { displayTitle, lastPrompt, repoName, extensionInfo } = require('./catalog');

let transcript = null;
try {
  transcript = require('./transcript');
} catch {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READY_WAIT_MS = 45000;
const EXIT_WAIT_MS = 10000;
const META_TTL_MS = 15000;
const STARTING_MS = 60000;

class RegistryError extends Error {
  constructor(code, msg) {
    super(msg || code);
    this.code = code;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function processTable() {
  return new Promise((resolve) => {
    execFile('ps', ['-Ax', '-o', 'pid=,ppid=,tty=,lstart='], { env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      const procs = new Map();
      const children = new Map();
      for (const line of err ? [] : out.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
        if (!m) continue;
        const pid = Number(m[1]);
        const ppid = Number(m[2]);
        procs.set(pid, { pid, ppid, tty: m[3] === '??' ? null : m[3], lstart: m[4] });
        if (!children.has(ppid)) children.set(ppid, []);
        children.get(ppid).push(pid);
      }
      resolve({ procs, children });
    });
  });
}

async function readPidRecords() {
  const records = new Map();
  for (const dir of sessions.claudeDirs()) {
    const sdir = path.join(dir, 'sessions');
    let files = [];
    try {
      files = await fsp.readdir(sdir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!/^\d+\.json$/.test(f)) continue;
      let j;
      let touched = null;
      try {
        j = JSON.parse(await fsp.readFile(path.join(sdir, f), 'utf8'));
        touched = (await fsp.stat(path.join(sdir, f))).mtimeMs;
      } catch {
        continue;
      }
      const pid = Number(j.pid || parseInt(f, 10));
      if (!j.sessionId || !isAlive(pid)) continue;
      records.set(pid, {
        pid,
        sessionId: String(j.sessionId),
        status: ['idle', 'busy', 'waiting'].includes(j.status) ? j.status : 'unknown',
        waitingFor: j.waitingFor || null,
        cwd: j.cwd || null,
        name: typeof j.name === 'string' ? j.name : null,
        tmux: j.tmux || null,
        procStart: j.procStart === undefined ? null : j.procStart,
        slot: path.basename(dir),
        touched,
      });
    }
  }
  return records;
}

const TITLE_MAX = 80;
const SESSION_TITLES_MAX = 2000;

function slug(text) {
  return sessions
    .foldText(text)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/, '');
}

async function realUnder(dir, roots) {
  let real;
  try {
    real = await fsp.realpath(String(dir));
    if (!(await fsp.stat(real)).isDirectory()) return null;
  } catch {
    return null;
  }
  for (const root of roots) {
    let r;
    try {
      r = await fsp.realpath(root);
    } catch {
      continue;
    }
    if (real === r || real.startsWith(r.endsWith(path.sep) ? r : r + path.sep)) return real;
  }
  return null;
}

class Registry extends EventEmitter {
  constructor(config, { ctx, audit = () => {}, pollMs = 1000, exitWaitMs = EXIT_WAIT_MS, readyWaitMs = READY_WAIT_MS } = {}) {
    super();
    this.config = config;
    this.ctx = ctx || { socket: config.tmuxSocket, bin: config.tmuxPath, childPath: config.childPath };
    this.audit = audit;
    this.pollMs = pollMs;
    this.exitWaitMs = exitWaitMs;
    this.readyWaitMs = readyWaitMs;
    this.items = [];
    this.signature = '';
    this.statuses = new Map();
    this.meta = new Map();
    this.continuing = new Map();
    this.starting = new Map();
    this.refreshing = null;
    this.titlesFile = config.stateDir ? path.join(config.stateDir, 'titles.json') : null;
    this.titles = new Map();
    this.titledAt = new Map();
    this.sessionTitles = new Map();
    try {
      const stored = JSON.parse(fs.readFileSync(this.titlesFile, 'utf8'));
      for (const [k, v] of Object.entries(stored.names || {})) if (tmux.NAME_RE.test(k) && typeof v === 'string') this.titles.set(k, v);
      for (const [k, v] of Object.entries(stored.sessions || {})) if (UUID_RE.test(k) && typeof v === 'string') this.sessionTitles.set(k, v);
    } catch {}
  }

  titleFor(sessionId) {
    return this.sessionTitles.get(sessionId) || null;
  }

  linkTitle(sessionId, title) {
    if (this.sessionTitles.get(sessionId) === title) return;
    this.sessionTitles.delete(sessionId);
    this.sessionTitles.set(sessionId, title);
    while (this.sessionTitles.size > SESSION_TITLES_MAX) this.sessionTitles.delete(this.sessionTitles.keys().next().value);
    this.saveTitles();
  }

  saveTitles() {
    if (!this.titlesFile) return;
    try {
      fs.writeFileSync(this.titlesFile, JSON.stringify({ names: Object.fromEntries(this.titles), sessions: Object.fromEntries(this.sessionTitles) }), { mode: 0o600 });
    } catch {}
  }

  start() {
    this.timer = setInterval(() => this.refresh().catch((e) => this.emit('error', e)), this.pollMs);
    this.timer.unref();
    return this.refresh();
  }

  stop() {
    clearInterval(this.timer);
  }

  listAll() {
    return this.items;
  }

  resolve(key) {
    return this.items.find((i) => (i.managed && i.name === key) || (i.sessionId && i.sessionId === key)) || null;
  }

  async metaFor(sessionId) {
    const cached = this.meta.get(sessionId);
    if (cached && Date.now() - cached.at < META_TTL_MS) return cached;
    const entry = { at: Date.now(), meta: null, lastActivity: null, transcriptPath: null };
    try {
      const m = await sessions.metaForSession(sessionId);
      if (m) {
        entry.meta = m;
        entry.lastActivity = m.lastActivity || null;
      }
    } catch {}
    try {
      entry.transcriptPath = transcript ? await transcript.resolveTranscript(sessionId) : null;
    } catch {}
    this.meta.set(sessionId, entry);
    return entry;
  }

  refresh() {
    if (this.refreshing) {
      if (!this.queued) {
        this.queued = this.refreshing.catch(() => {}).then(() => {
          this.queued = null;
          return this.refresh();
        });
      }
      return this.queued;
    }
    this.refreshing = this.doRefresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  async doRefresh() {
    const startedAt = Date.now();
    const [managed, records, { procs, children }] = await Promise.all([tmux.listSessions(this.ctx), readPidRecords(), processTable()]);
    const claimed = new Set();
    const items = [];
    for (const s of managed) {
      const rec = sessions.findSession(s.panePid, children, records);
      if (rec) claimed.add(rec.pid);
      items.push(await this.item(rec, procs, { managed: true, name: s.name, cwd: s.cwd, tty: s.paneTty ? s.paneTty.replace(/^\/dev\//, '') : null, activity: s.activity, cols: s.cols, rows: s.rows }));
    }
    const before = this.titles.size;
    for (const n of [...this.titles.keys()]) if (!managed.some((s) => s.name === n) && (this.titledAt.get(n) || 0) < startedAt) this.titles.delete(n);
    if (this.titles.size !== before) this.saveTitles();
    for (const rec of records.values()) {
      if (claimed.has(rec.pid)) continue;
      items.push(await this.item(rec, procs, { managed: false, name: null }));
    }
    this.items = items;
    for (const id of [...this.starting.keys()]) if (items.some((i) => i.sessionId === id) || this.starting.get(id) <= Date.now()) this.starting.delete(id);
    const sig = JSON.stringify(items);
    if (sig !== this.signature) {
      this.signature = sig;
      this.emit('sessions', items);
    }
    const seen = new Set();
    for (const i of items) {
      const key = i.managed ? i.name : i.sessionId;
      seen.add(key);
      const st = `${i.status}|${i.waitingFor || ''}`;
      if (this.statuses.get(key) !== st) {
        this.statuses.set(key, st);
        this.emit('status', { sessionId: key, status: i.status, waitingFor: i.waitingFor });
      }
    }
    for (const key of [...this.statuses.keys()]) if (!seen.has(key)) this.statuses.delete(key);
    return items;
  }

  async item(rec, procs, extra) {
    const m = rec ? await this.metaFor(rec.sessionId) : {};
    const proc = rec ? procs.get(rec.pid) : null;
    const cwd = (rec && rec.cwd) || extra.cwd || null;
    const named = (extra.managed && this.titles.get(extra.name)) || null;
    if (named && rec) this.linkTitle(rec.sessionId, named);
    const given = named || (rec && this.titleFor(rec.sessionId)) || null;
    const ext = rec ? extensionInfo(rec.sessionId, cwd, this.config.roots) : { favorite: false, name: null };
    let transcriptSize = null;
    let written = null;
    if (m.transcriptPath) {
      try {
        const st = await fsp.stat(m.transcriptPath);
        transcriptSize = st.size;
        written = st.mtimeMs;
      } catch {}
    }
    const fallback = written || extra.activity || (rec && rec.touched);
    const lastActivity = m.lastActivity || (fallback ? new Date(fallback).toISOString() : null);
    return {
      sessionId: rec ? rec.sessionId : null,
      name: extra.name,
      managed: extra.managed,
      pid: rec ? rec.pid : null,
      procStart: rec ? rec.procStart : null,
      tty: (proc && proc.tty) || extra.tty || null,
      cwd,
      project: repoName(cwd, this.config.roots),
      slot: rec ? rec.slot : null,
      status: rec ? rec.status : 'none',
      waitingFor: rec ? rec.waitingFor : null,
      title: rec ? ext.name || displayTitle(m.meta, rec.name, given) : given,
      favorite: ext.favorite,
      lastPrompt: lastPrompt(m.meta),
      transcriptPath: m.transcriptPath || null,
      transcriptSize,
      lastActivity,
    };
  }

  buildArgv(resumeId) {
    const c = this.config;
    return ['/usr/bin/env', ...c.launcher, ...c.claudeCommand, ...c.claudeArgs, ...(resumeId ? ['--resume', resumeId] : [])];
  }

  async newSession({ name, dir, resumeId, title } = {}, { device } = {}) {
    const resumeKey = resumeId && UUID_RE.test(String(resumeId)) ? String(resumeId) : null;
    if (resumeKey) {
      const until = this.starting.get(resumeKey);
      if (until && until > Date.now()) throw new RegistryError('session-starting', 'This session is being started; it appears in the list in a moment');
      this.starting.set(resumeKey, Date.now() + STARTING_MS);
    }
    try {
      return await this.startSession({ name, dir, resumeId, title }, { device });
    } catch (e) {
      if (resumeKey) this.starting.delete(resumeKey);
      throw e;
    }
  }

  async startSession({ name, dir, resumeId, title } = {}, { device } = {}) {
    let given = null;
    if (title !== undefined && title !== null) {
      if (typeof title !== 'string') throw new RegistryError('bad-title', 'Title must be text');
      given = tmux.stripControls(title).replace(/\s+/g, ' ').trim() || null;
      if (given && given.length > TITLE_MAX) throw new RegistryError('bad-title', `Title must be at most ${TITLE_MAX} characters`);
      if (!name && !resumeId) name = await this.freeName(given && slug(given) ? `cc-${slug(given)}` : `cc-${crypto.randomBytes(3).toString('hex')}`);
    }
    if (!name && resumeId && UUID_RE.test(String(resumeId))) {
      const meta = await sessions.metaForSession(resumeId).catch(() => null);
      const base = `cc-${slug(displayTitle(meta, null, this.titleFor(resumeId))) || resumeId.slice(0, 8)}`;
      name = await this.freeName(tmux.NAME_RE.test(base) ? base : `cc-${resumeId.slice(0, 8)}`);
      dir = dir || (meta && meta.cwd) || undefined;
    }
    if (!tmux.NAME_RE.test(String(name))) throw new RegistryError('bad-name', 'Name must match cc-[a-z0-9-]{1,40}');
    if (resumeId !== undefined && resumeId !== null && resumeId !== '' && !UUID_RE.test(String(resumeId))) throw new RegistryError('bad-resume-id', 'Resume id must be a session UUID');
    const resume = resumeId || null;
    const real = await realUnder(dir || this.config.defaultDir, this.config.roots);
    if (!real) throw new RegistryError('dir-not-allowed', 'Directory is not under a configured root');
    if (await tmux.hasSession(this.ctx, name)) throw new RegistryError('name-taken', `Session ${name} exists`);
    if (resume && [...(await readPidRecords()).values()].some((r) => r.sessionId === resume)) throw new RegistryError('session-running', 'A running process holds this session');
    await tmux.newSession(this.ctx, { name, dir: real, argv: this.buildArgv(resume) });
    if (given) {
      this.titles.set(name, given);
      this.titledAt.set(name, Date.now());
      this.saveTitles();
    }
    this.audit('new', { device: device && device.id, name, resume: resume || undefined });
    await this.refresh();
    return { name };
  }

  async freeName(base) {
    const taken = new Set((await tmux.listSessions(this.ctx)).map((s) => s.name));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 100; i++) {
      const n = `${base.slice(0, 40)}-${i}`;
      if (tmux.NAME_RE.test(n) && !taken.has(n)) return n;
    }
    return `cc-${crypto.randomBytes(4).toString('hex')}`;
  }

  async openForTerminal({ dir, resumeId, attachOnly = false } = {}, { device } = {}) {
    await this.refresh();
    const item = resumeId ? this.resolve(resumeId) : null;
    if (item && item.managed) return { name: item.name };
    if (attachOnly) throw new RegistryError('not-found', 'The service does not run this session');
    if (item) return this.continueSession(resumeId, { device });
    if (resumeId) return this.newSession({ resumeId, dir }, { device });
    const real = await realUnder(dir || this.config.defaultDir, this.config.roots);
    if (!real) throw new RegistryError('dir-not-allowed', 'Directory is not under a configured root');
    const name = await this.freeName(`cc-${slug(path.basename(real)).slice(0, 30) || 'session'}`);
    return this.newSession({ name, dir: real }, { device });
  }

  continueSession(sessionId, { device } = {}) {
    if (!UUID_RE.test(String(sessionId))) return Promise.reject(new RegistryError('not-found'));
    let p = this.continuing.get(sessionId);
    if (!p) {
      p = this.bringIn(sessionId, { device }).finally(() => this.continuing.delete(sessionId));
      this.continuing.set(sessionId, p);
    }
    return p;
  }

  async bringIn(sessionId, { device }) {
    await this.refresh();
    let item = this.resolve(sessionId);
    if (item && item.managed) return item;
    if (item) {
      if (item.status === 'busy') throw new RegistryError('working', 'Claude is working in this session; the message waits until it finishes');
      if (!(await realUnder(item.cwd, this.config.roots))) throw new RegistryError('dir-not-allowed');
      await this.stopProcess(item, { device });
    }
    const base = item ? `cc-${slug(item.title) || sessionId.slice(0, 8)}` : null;
    const wanted = base ? await this.freeName(tmux.NAME_RE.test(base) ? base : `cc-${sessionId.slice(0, 8)}`) : undefined;
    const { name } = await this.newSession({ name: wanted, resumeId: sessionId, dir: item ? item.cwd : undefined }, { device });
    this.audit('continue', { device: device && device.id, sessionId, name, from: item ? 'terminal' : 'past' });
    const until = Date.now() + this.readyWaitMs;
    for (;;) {
      await this.refresh();
      item = this.resolve(name);
      if (item && item.sessionId === sessionId && item.status === 'idle') return item;
      if (Date.now() > until) throw new RegistryError('not-ready', 'The session started but is not ready for input yet');
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async stopProcess(item, { device }) {
    const rec = (await readPidRecords()).get(item.pid);
    if (!rec || rec.sessionId !== item.sessionId || rec.procStart !== item.procStart) throw new RegistryError('changed', 'The session changed; try again');
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      this.audit('continue-stop', { device: device && device.id, pid: item.pid, sessionId: item.sessionId, signal });
      process.kill(item.pid, signal);
      const until = Date.now() + this.exitWaitMs;
      while (isAlive(item.pid) && Date.now() <= until) await new Promise((r) => setTimeout(r, 100));
      if (!isAlive(item.pid)) return;
    }
    throw new RegistryError('still-running', 'The earlier Claude process did not exit');
  }
}

module.exports = { Registry, RegistryError, readPidRecords, processTable, realUnder, UUID_RE };
