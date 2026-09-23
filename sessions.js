'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) =>
  new Promise((res) => execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024 }, (err, out) => res(err ? '' : out)));

function claudeDirs() {
  const home = os.homedir();
  const dirs = [];
  let entries = [];
  try {
    entries = fs.readdirSync(home);
  } catch {}
  for (const e of entries) {
    if (e !== '.claude' && !e.startsWith('.claude-')) continue;
    const d = path.join(home, e);
    if (fs.existsSync(path.join(d, 'projects')) || fs.existsSync(path.join(d, 'sessions'))) dirs.push(d);
  }
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env && !dirs.includes(env)) dirs.push(env);
  return dirs;
}

async function readRunningSessions() {
  const byPid = new Map();
  for (const d of claudeDirs()) {
    const dir = path.join(d, 'sessions');
    let files = [];
    try {
      files = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!/^\d+\.json$/.test(f)) continue;
      try {
        const j = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'));
        const pid = Number(j.pid || parseInt(f, 10));
        if (j.sessionId && isAlive(pid)) byPid.set(pid, { sessionId: j.sessionId, cwd: j.cwd, status: j.status });
      } catch {}
    }
  }
  return byPid;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function processChildren() {
  const out = await run('ps', ['-Ao', 'pid=,ppid=']);
  const children = new Map();
  for (const line of out.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  return children;
}

function findSession(rootPid, children, running) {
  const queue = [rootPid];
  const seen = new Set();
  while (queue.length) {
    const p = queue.shift();
    if (seen.has(p)) continue;
    seen.add(p);
    if (running.has(p)) return running.get(p);
    for (const c of children.get(p) || []) queue.push(c);
  }
  return null;
}

async function cwdOfPid(pid) {
  const out = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  const line = out.split('\n').find((l) => l.startsWith('n'));
  return line ? line.slice(1) : null;
}

function withTimeout(promise, ms) {
  return Promise.race([promise, sleep(ms).then(() => undefined)]);
}

const metaCache = new Map();

function decodeJsonString(s) {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s;
  }
}

function isSyntheticPrompt(text) {
  return text.startsWith('<') || text.startsWith('Stop hook feedback') || text.startsWith('[Your previous response') || text.startsWith('[Request interrupted');
}

function formatTime(iso, withDate = true) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return withDate ? `${p(d.getDate())}.${p(d.getMonth() + 1)}. ${time}` : time;
}

function oneLine(text, max) {
  const flat = (text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function sessionSummary(meta) {
  if (!meta) return '';
  const sameDay = meta.startedAt && meta.lastActivity && new Date(meta.startedAt).toDateString() === new Date(meta.lastActivity).toDateString();
  return `last ${formatTime(meta.lastActivity)} · started ${formatTime(meta.startedAt, !sameDay)}`;
}


function lastMatch(text, re) {
  let m;
  let v = null;
  while ((m = re.exec(text))) v = m[1];
  return v === null ? null : decodeJsonString(v);
}

async function readRange(handle, position, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead).toString('utf8');
}

function messageText(o) {
  const content = o.message && o.message.content;
  const raw = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') : '';
  return raw.replace(/<\/?pasted_content[^>]*>/g, '').trim();
}

async function sessionMeta(file) {
  const st = await fsp.stat(file);
  const cached = metaCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.meta;
  const handle = await fsp.open(file, 'r');
  let head;
  let tail;
  try {
    if (st.size <= HEAD_BYTES + TAIL_BYTES) {
      head = await readRange(handle, 0, st.size);
      tail = head;
    } else {
      head = await readRange(handle, 0, HEAD_BYTES);
      tail = await readRange(handle, st.size - TAIL_BYTES, TAIL_BYTES);
    }
  } finally {
    await handle.close();
  }
  let firstPrompt = null;
  for (const line of head.split('\n')) {
    if (!line.includes('"type":"user"')) continue;
    try {
      const o = JSON.parse(line);
      const text = messageText(o);
      if (!o.isMeta && text && !isSyntheticPrompt(text)) {
        firstPrompt = text;
        break;
      }
    } catch {}
  }
  const lines = tail.split('\n');
  let lastUser = null;
  let lastAssistant = null;
  let lastActivity = null;
  for (let i = lines.length - 1; i >= 0 && !(lastUser && lastAssistant); i--) {
    const line = lines[i];
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    if (!lastActivity && o.timestamp) lastActivity = o.timestamp;
    const text = messageText(o);
    if (!text || o.isMeta) continue;
    if (o.type === 'user' && !lastUser && !isSyntheticPrompt(text)) lastUser = { text, at: o.timestamp };
    if (o.type === 'assistant' && !lastAssistant) lastAssistant = { text, at: o.timestamp };
  }
  const firstOf = (re) => {
    const m = re.exec(head);
    return m ? decodeJsonString(m[1]) : null;
  };
  const meta = {
    id: path.basename(file, '.jsonl'),
    file,
    mtimeMs: st.mtimeMs,
    customTitle: lastMatch(tail, /"customTitle":"((?:[^"\\]|\\.)*)"/g) || lastMatch(head, /"customTitle":"((?:[^"\\]|\\.)*)"/g),
    aiTitle: lastMatch(tail, /"aiTitle":"((?:[^"\\]|\\.)*)"/g) || lastMatch(head, /"aiTitle":"((?:[^"\\]|\\.)*)"/g),
    cwd: firstOf(/"cwd":"((?:[^"\\]|\\.)*)"/),
    startedAt: firstOf(/"timestamp":"([^"]+)"/),
    lastActivity: lastActivity || lastMatch(tail, /"timestamp":"([^"]+)"/g) || firstOf(/"timestamp":"([^"]+)"/) || new Date(st.mtimeMs).toISOString(),
    firstPrompt,
    lastUser,
    lastAssistant,
  };
  if (!meta.customTitle && !meta.aiTitle && st.size > HEAD_BYTES + TAIL_BYTES) {
    const full = await fsp.readFile(file, 'utf8');
    meta.customTitle = lastMatch(full, /"customTitle":"((?:[^"\\]|\\.)*)"/g);
    meta.aiTitle = lastMatch(full, /"aiTitle":"((?:[^"\\]|\\.)*)"/g);
  }
  metaCache.set(file, { mtimeMs: st.mtimeMs, meta });
  return meta;
}

function mergeMetas(metas) {
  const withMessages = metas.filter((m) => m.lastUser || m.lastAssistant);
  const pool = withMessages.length ? withMessages : metas;
  const primary = pool.reduce((best, m) => (Date.parse(m.lastActivity) > Date.parse(best.lastActivity) ? m : best));
  const merged = { ...primary };
  for (const key of ['customTitle', 'aiTitle', 'firstPrompt', 'cwd', 'lastUser', 'lastAssistant']) {
    if (!merged[key]) merged[key] = (metas.find((m) => m[key]) || {})[key] || null;
  }
  const starts = metas.map((m) => m.startedAt).filter(Boolean).sort();
  merged.startedAt = starts[0] || merged.startedAt;
  return merged;
}

async function collectSessionFiles(dirFilter) {
  const byId = new Map();
  const seen = new Set();
  for (const d of claudeDirs()) {
    const projects = path.join(d, 'projects');
    let dirs = [];
    try {
      dirs = await fsp.readdir(projects);
    } catch {
      continue;
    }
    for (const p of dirs) {
      if (!dirFilter(p)) continue;
      let files = [];
      try {
        files = await fsp.readdir(path.join(projects, p));
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const file = path.join(projects, p, f);
        let real;
        let st;
        try {
          real = await fsp.realpath(file);
          st = await fsp.stat(real);
        } catch {
          continue;
        }
        if (seen.has(real)) continue;
        seen.add(real);
        const id = f.slice(0, -6);
        if (!byId.has(id)) byId.set(id, []);
        byId.get(id).push({ file: real, mtimeMs: st.mtimeMs });
      }
    }
  }
  return byId;
}

async function metasFor(files) {
  const metas = [];
  for (const f of files) {
    try {
      metas.push(await sessionMeta(f.file));
    } catch {}
  }
  return metas.length ? mergeMetas(metas) : null;
}

let allFiles = null;
let allFilesAt = 0;

async function sessionIndex(sessionId) {
  if (!allFiles || Date.now() - allFilesAt > 30000 || (sessionId && !allFiles.has(sessionId))) {
    allFiles = await collectSessionFiles(() => true);
    allFilesAt = Date.now();
  }
  return allFiles;
}

async function metaForSession(sessionId) {
  if (!sessionId) return null;
  const byId = (await sessionIndex(sessionId)).get(sessionId);
  return byId ? metasFor(byId) : null;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+){0,4}$/;

async function renameSession(sessionId, name) {
  const clean = String(name || '').replace(/[\r\n]+/g, ' ').trim();
  if (!clean) throw new Error('Name must not be empty');
  const running = [...(await readRunningSessions()).values()].some((s) => s.sessionId === sessionId);
  if (running) throw new Error(`Session ${sessionId} is running; rename its tab instead`);
  const files = (await sessionIndex(sessionId)).get(sessionId);
  if (!files) throw new Error(`Session ${sessionId} not found`);
  const target = files.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a)).file;
  await fsp.appendFile(target, `${JSON.stringify({ type: 'custom-title', customTitle: clean, sessionId })}\n`);
  return target;
}

async function listRepoSessions(wsPath, days = 14) {
  const encoded = wsPath.replace(/[^a-zA-Z0-9]/g, '-');
  const byId = await collectSessionFiles((p) => p === encoded || p.startsWith(`${encoded}-`));
  const cutoff = Date.now() - Math.max(1, days) * 86400000;
  const metas = [];
  for (const files of byId.values()) {
    if (!files.some((f) => f.mtimeMs >= cutoff)) continue;
    const meta = await metasFor(files);
    if (meta && Date.parse(meta.lastActivity) >= cutoff) metas.push(meta);
  }
  return metas.sort((a, b) => Date.parse(b.lastActivity) - Date.parse(a.lastActivity));
}

module.exports = { SLUG_RE, renameSession, claudeDirs, readRunningSessions, processChildren, findSession, cwdOfPid, withTimeout, sleep, isSyntheticPrompt, formatTime, oneLine, sessionSummary, sessionMeta, metaForSession, listRepoSessions };
