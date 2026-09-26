'use strict';
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { filesForSession, readStateFile, writeStatePatch } = require('./sessions');

const SESSION_FILE = /^[0-9a-zA-Z-]+\.jsonl$/;

function repoKey(wsPath) {
  return path.basename(path.resolve(wsPath));
}

function projectDir(wsPath) {
  const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(home, 'projects', path.resolve(wsPath).replace(/[^a-zA-Z0-9]/g, '-'));
}

function normalizeServer(server) {
  return String(server || '').trim().replace(/\/+$/, '');
}

class WebDav {
  constructor({ server, loginName, appPassword }, fetchImpl = fetch) {
    if (!server || !loginName || !appPassword) throw new Error('Nextcloud is not connected');
    this.root = `${normalizeServer(server)}/remote.php/dav/files/${encodeURIComponent(loginName)}`;
    this.auth = `Basic ${Buffer.from(`${loginName}:${appPassword}`).toString('base64')}`;
    this.fetch = fetchImpl;
  }

  url(parts) {
    return `${this.root}/${parts.map(encodeURIComponent).join('/')}`;
  }

  async request(method, parts, { body, headers = {}, ok = [200, 201, 204, 207] } = {}) {
    const res = await this.fetch(this.url(parts), { method, body, headers: { Authorization: this.auth, ...headers } });
    if (!ok.includes(res.status)) throw new Error(`${method} ${parts.join('/') || '/'}: HTTP ${res.status}`);
    return res;
  }

  async ensureFolder(parts) {
    for (let i = 1; i <= parts.length; i++) await this.request('MKCOL', parts.slice(0, i), { ok: [201, 405] });
  }

  async list(parts) {
    const res = await this.request('PROPFIND', parts, { headers: { Depth: '1', 'Content-Type': 'application/xml' }, ok: [207, 404] });
    if (res.status === 404) return new Map();
    const xml = await res.text();
    const entries = new Map();
    const blocks = xml.split(/<(?:[\w-]+:)?response[\s>]/i).slice(1);
    if (!blocks.length) throw new Error(`Unreadable folder listing for ${parts.join('/')}`);
    for (const block of blocks) {
      const href = (block.match(/<(?:[\w-]+:)?href>([^<]+)</i) || [])[1];
      const modified = (block.match(/<(?:[\w-]+:)?getlastmodified>([^<]+)</i) || [])[1];
      if (!href || !modified) continue;
      const name = decodeURIComponent(href.replace(/\/$/, '').split('/').pop());
      entries.set(name, { mtimeSec: Math.floor(Date.parse(modified) / 1000) });
    }
    return entries;
  }

  async put(parts, body, mtimeSec) {
    await this.request('PUT', parts, { body, headers: { 'X-OC-MTime': String(mtimeSec) }, ok: [200, 201, 204] });
  }

  async get(parts) {
    const res = await this.request('GET', parts, { ok: [200] });
    return Buffer.from(await res.arrayBuffer());
  }
}

async function startLogin(server, fetchImpl = fetch) {
  const base = normalizeServer(server);
  const res = await fetchImpl(`${base}/index.php/login/v2`, { method: 'POST', headers: { 'User-Agent': 'Claude Sessions (VS Code)' } });
  if (res.status !== 200) throw new Error(`Login flow could not start: HTTP ${res.status}`);
  const data = await res.json();
  return { login: data.login, poll: data.poll };
}

async function finishLogin(poll, { timeoutMs = 600000, intervalMs = 2000, fetchImpl = fetch, cancelled = () => false } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until && !cancelled()) {
    const res = await fetchImpl(poll.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(poll.token)}` });
    if (res.status === 200) {
      const data = await res.json();
      return { server: normalizeServer(data.server), loginName: data.loginName, appPassword: data.appPassword };
    }
    if (res.status !== 404) throw new Error(`Login flow failed: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Login was not completed in the browser');
}

function localState(stateFile) {
  try {
    return readStateFile(stateFile);
  } catch {
    return {};
  }
}

async function newestFile(sessionId) {
  const files = await filesForSession(sessionId);
  return files.length ? files.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a)) : null;
}

const LOCK_STALE_MS = 10 * 60 * 1000;

function takeLock(stateFile) {
  const key = require('crypto').createHash('sha1').update(path.resolve(stateFile)).digest('hex').slice(0, 16);
  const lock = path.join(os.tmpdir(), `claude-sessions-sync-${key}.lock`);
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  } catch {
    let age = 0;
    try {
      age = Date.now() - fs.statSync(lock).mtimeMs;
    } catch {}
    if (age < LOCK_STALE_MS) throw new Error('A sync of this repository is already running');
    fs.writeFileSync(lock, String(process.pid));
  }
  return () => fs.rmSync(lock, { force: true });
}

function completeLines(buffer) {
  const end = buffer.lastIndexOf(0x0a);
  return end === buffer.length - 1 ? buffer : buffer.subarray(0, end + 1);
}

async function syncFavorites(options) {
  const release = takeLock(options.stateFile);
  try {
    return await syncLocked(options);
  } finally {
    release();
  }
}

async function syncLocked({ creds, wsPath, stateFile, folder = 'Claude Sessions', running = new Set(), fetchImpl }) {
  const dav = new WebDav(creds, fetchImpl);
  const folderParts = [folder, repoKey(wsPath)];
  await dav.ensureFolder(folderParts);
  const remote = await dav.list(folderParts);
  const result = { downloaded: [], uploaded: [], skippedRunning: [], favorites: 0 };

  let remoteState = {};
  if (remote.has('state.json')) {
    try {
      remoteState = JSON.parse((await dav.get([...folderParts, 'state.json'])).toString('utf8'));
    } catch {}
  }

  const state = localState(stateFile);
  const localFav = new Set(Object.keys(state.favorites || {}));
  const remoteFav = new Set(Object.keys(remoteState.favorites || {}));
  const syncBase = new Set((state.sync && state.sync.favorites) || []);
  const merged = [...new Set([...localFav, ...remoteFav])].filter((id) => (localFav.has(id) && remoteFav.has(id)) || !syncBase.has(id)).sort();
  const removed = [...syncBase].filter((id) => !merged.includes(id));
  const names = { ...(remoteState.names || {}), ...(state.names || {}) };

  const target = projectDir(wsPath);
  for (const [name, entry] of remote) {
    if (!SESSION_FILE.test(name)) continue;
    const id = name.replace(/\.jsonl$/, '');
    if (!merged.includes(id)) continue;
    const local = await newestFile(id);
    const localSec = local ? Math.floor(local.mtimeMs / 1000) : -1;
    if (entry.mtimeSec <= localSec) continue;
    if (running.has(id)) {
      result.skippedRunning.push(id);
      continue;
    }
    const file = local ? local.file : path.join(target, name);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.sync`;
    await fsp.writeFile(tmp, await dav.get([...folderParts, name]));
    await fsp.utimes(tmp, entry.mtimeSec, entry.mtimeSec);
    await fsp.rename(tmp, file);
    result.downloaded.push(id);
  }

  for (const id of merged) {
    const local = await newestFile(id);
    if (!local) continue;
    const localSec = Math.floor(local.mtimeMs / 1000);
    const entry = remote.get(`${id}.jsonl`);
    if (entry && entry.mtimeSec >= localSec) continue;
    const body = completeLines(await fsp.readFile(local.file));
    if (!body.length) continue;
    await dav.put([...folderParts, `${id}.jsonl`], body, localSec);
    result.uploaded.push(id);
  }
  for (const id of removed) {
    if (remote.has(`${id}.jsonl`)) await dav.request('DELETE', [...folderParts, `${id}.jsonl`], { ok: [204, 404] });
  }

  const current = localState(stateFile);
  const currentFav = new Set(Object.keys(current.favorites || {}));
  const toggledOff = [...localFav].filter((id) => !currentFav.has(id));
  const toggledOn = [...currentFav].filter((id) => !localFav.has(id));
  const final = [...new Set([...merged.filter((id) => !toggledOff.includes(id)), ...toggledOn])].sort();
  for (const id of toggledOff) await dav.request('DELETE', [...folderParts, `${id}.jsonl`], { ok: [204, 404] });
  const favorites = Object.fromEntries(final.map((id) => [id, true]));
  const favoriteNames = Object.fromEntries(final.filter((id) => names[id]).map((id) => [id, names[id]]));
  const localNow = { ...(current.favorites || {}) };
  for (const id of localFav) if (!merged.includes(id)) delete localNow[id];
  for (const id of merged) if (!localFav.has(id) && !toggledOff.includes(id)) localNow[id] = true;
  writeStatePatch(stateFile, { favorites: localNow, names: { ...favoriteNames, ...(current.names || {}) }, sync: { favorites: final, at: new Date().toISOString() } });
  const nextState = JSON.stringify({ favorites, names: favoriteNames }, null, 2);
  const previous = JSON.stringify({ favorites: remoteState.favorites || {}, names: remoteState.names || {} }, null, 2);
  if (nextState !== previous) await dav.put([...folderParts, 'state.json'], Buffer.from(`${nextState}\n`), Math.floor(Date.now() / 1000));
  result.favorites = final.length;
  result.removed = removed;
  return result;
}

module.exports = { WebDav, startLogin, finishLogin, syncFavorites, repoKey, projectDir, normalizeServer };
