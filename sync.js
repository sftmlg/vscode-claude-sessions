'use strict';
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { filesForSession, readStateFile, writeStatePatch } = require('./sessions');

const SESSION_FILE = /^[0-9a-zA-Z-]+\.jsonl$/;
// Proxies in front of Nextcloud cap request bodies (Cloudflare: 100 MB); larger files go up in chunks of this size.
const CHUNK_BYTES = 32 * 1024 * 1024;

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
  constructor({ server, loginName, appPassword }, fetchImpl = fetch, { chunkBytes = CHUNK_BYTES } = {}) {
    if (!server || !loginName || !appPassword) throw new Error('Nextcloud is not connected');
    this.root = `${normalizeServer(server)}/remote.php/dav/files/${encodeURIComponent(loginName)}`;
    this.uploadsRoot = `${normalizeServer(server)}/remote.php/dav/uploads/${encodeURIComponent(loginName)}`;
    this.chunkBytes = chunkBytes;
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
    if (body.length > this.chunkBytes) return this.putChunked(parts, body, mtimeSec);
    await this.request('PUT', parts, { body, headers: { 'X-OC-MTime': String(mtimeSec) }, ok: [200, 201, 204] });
  }

  async putChunked(parts, body, mtimeSec) {
    const folder = `${this.uploadsRoot}/claude-sessions-${crypto.randomUUID()}`;
    const destination = this.url(parts);
    const call = async (method, url, headers, chunk, ok) => {
      const res = await this.fetch(url, { method, body: chunk, headers: { Authorization: this.auth, Destination: destination, ...headers } });
      if (!ok.includes(res.status)) throw new Error(`${method} ${parts.join('/')} (chunked upload): HTTP ${res.status}`);
    };
    await call('MKCOL', folder, {}, undefined, [201]);
    try {
      for (let offset = 0, n = 1; offset < body.length; offset += this.chunkBytes, n++) {
        await call('PUT', `${folder}/${n}`, { 'OC-Total-Length': String(body.length) }, body.subarray(offset, offset + this.chunkBytes), [201, 204]);
      }
      await call('MOVE', `${folder}/.file`, { 'OC-Total-Length': String(body.length), 'X-OC-MTime': String(mtimeSec) }, undefined, [201, 204]);
    } catch (err) {
      await this.fetch(folder, { method: 'DELETE', headers: { Authorization: this.auth } }).catch(() => {});
      throw err;
    }
  }

  async create(parts, body) {
    const res = await this.request('PUT', parts, { body, headers: { 'If-None-Match': '*' }, ok: [201, 204, 412] });
    return res.status !== 412;
  }

  async getJson(parts) {
    const res = await this.request('GET', parts, { ok: [200, 404] });
    if (res.status === 404) return null;
    try {
      return JSON.parse(await res.text());
    } catch {
      return null;
    }
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
  if (!files.length) return null;
  const newest = files.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
  return { ...newest, size: (await fsp.stat(newest.file)).size };
}

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const shortMachine = (machine) => String(machine).split('#')[0].split('@').pop().split('.')[0].toLowerCase().replace(/[^a-z0-9-]+/g, '-');

const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_TTL_MS = 30 * 60 * 1000;

function legacyMachineId() {
  return `${os.userInfo().username}@${os.hostname().replace(/\.local$/, '')}`;
}

function machineName() {
  if (process.platform === 'darwin') {
    try {
      const name = require('child_process').execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 2000 }).trim();
      if (name) return name;
    } catch {}
  }
  const host = os.hostname().split('.')[0];
  return host && !/^unknown/i.test(host) ? host : os.userInfo().username;
}

let cachedMachine = null;
function machineId() {
  if (process.env.CLAUDE_SESSIONS_MACHINE) return process.env.CLAUDE_SESSIONS_MACHINE;
  if (cachedMachine) return cachedMachine;
  const file = path.join(os.homedir(), '.claude-sessions-machine.json');
  try {
    cachedMachine = JSON.parse(fs.readFileSync(file, 'utf8')).id;
    if (cachedMachine) return cachedMachine;
  } catch {}
  const id = `${machineName()}#${crypto.randomUUID().slice(0, 8)}`;
  try {
    fs.writeFileSync(file, `${JSON.stringify({ id })}\n`, { flag: 'wx' });
    cachedMachine = id;
  } catch {
    cachedMachine = JSON.parse(fs.readFileSync(file, 'utf8')).id;
  }
  return cachedMachine;
}

const liveLock = (lock, now) => Boolean(lock && lock.machine && now - (lock.heartbeat || 0) < LOCK_TTL_MS);

async function readLock({ creds, wsPath, id, folder = 'Claude Sessions', machine = machineId(), legacy = legacyMachineId(), now = Date.now(), fetchImpl }) {
  const lock = await new WebDav(creds, fetchImpl).getJson([folder, repoKey(wsPath), 'locks', `${id}.json`]);
  return liveLock(lock, now) && lock.machine !== machine && lock.machine !== legacy ? lock : null;
}

function takeLock(stateFile) {
  const key = crypto.createHash('sha1').update(path.resolve(stateFile)).digest('hex').slice(0, 16);
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

async function syncLocked({ creds, wsPath, stateFile, folder = 'Claude Sessions', running = new Set(), machine = machineId(), legacy = legacyMachineId(), now = Date.now(), fetchImpl, chunkBytes }) {
  const isMine = (lock) => Boolean(lock) && (lock.machine === machine || lock.machine === legacy);
  const dav = new WebDav(creds, fetchImpl, { chunkBytes });
  const folderParts = [folder, repoKey(wsPath)];
  const lockParts = [...folderParts, 'locks'];
  await dav.ensureFolder(lockParts);
  const remote = await dav.list(folderParts);
  const remoteLocks = await dav.list(lockParts);
  const result = { downloaded: [], uploaded: [], failed: [], skippedRunning: [], locked: [], released: [], conflicts: [], diverged: [], forked: [], favorites: 0 };

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

  const locks = {};
  for (const name of remoteLocks.keys()) {
    const id = name.replace(/\.json$/, '');
    if (name.endsWith('.json') && merged.includes(id)) locks[id] = await dav.getJson([...lockParts, name]);
  }
  const heldElsewhere = (id) => liveLock(locks[id], now) && !isMine(locks[id]);
  for (const id of merged.filter((i) => running.has(i))) {
    const mine = isMine(locks[id]);
    if (heldElsewhere(id)) {
      result.conflicts.push({ id, machine: locks[id].machine });
      continue;
    }
    const lock = { machine, since: mine ? locks[id].since : now, heartbeat: now };
    const body = Buffer.from(JSON.stringify(lock));
    const parts = [...lockParts, `${id}.json`];
    if (locks[id]) await dav.put(parts, body, Math.floor(now / 1000));
    else if (!(await dav.create(parts, body))) {
      locks[id] = await dav.getJson(parts);
      result.conflicts.push({ id, machine: (locks[id] && locks[id].machine) || 'unknown' });
      continue;
    }
    locks[id] = lock;
    result.locked.push(id);
  }

  const target = projectDir(wsPath);
  const manifest = { ...(remoteState.files || {}) };
  const localCache = { ...((state.sync && state.sync.files) || {}) };
  const forks = [];
  const writeLocal = async (file, body, mtimeSec) => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.sync`;
    await fsp.writeFile(tmp, body);
    await fsp.utimes(tmp, mtimeSec, mtimeSec);
    await fsp.rename(tmp, file);
  };
  const record = (id, body, by, mtimeSec) => {
    manifest[id] = { bytes: body.length, hash: sha256(body), machine: by, mtimeSec };
  };
  const upload = async (id, body, mtimeSec) => {
    await dav.put([...folderParts, `${id}.jsonl`], body, mtimeSec);
    record(id, body, machine, mtimeSec);
    result.uploaded.push(id);
  };
  const download = async (id, file, body, entry, by) => {
    await writeLocal(file, body, entry.mtimeSec);
    manifest[id] = { ...(manifest[id] || {}), bytes: body.length, hash: sha256(body), machine: by, mtimeSec: entry.mtimeSec };
    result.downloaded.push(id);
  };

  const syncOne = async (id) => {
    const entry = remote.get(`${id}.jsonl`);
    const local = await newestFile(id);
    if (!entry && !local) return;
    if (!entry) {
      if (heldElsewhere(id)) return;
      const body = completeLines(await fsp.readFile(local.file));
      if (body.length) await upload(id, body, Math.floor(local.mtimeMs / 1000));
      return;
    }
    const rec = manifest[id] && manifest[id].mtimeSec === entry.mtimeSec ? manifest[id] : null;
    const by = (rec && rec.machine) || (manifest[id] && manifest[id].machine) || 'another machine';
    if (!local) {
      if (running.has(id)) return;
      await download(id, path.join(target, `${id}.jsonl`), await dav.get([...folderParts, `${id}.jsonl`]), entry, by);
      return;
    }
    const localSec = Math.floor(local.mtimeMs / 1000);
    const cached = localCache[id];
    const unchanged = cached && cached.size === local.size && cached.mtimeMs === local.mtimeMs;
    if (unchanged && rec && cached.hash === rec.hash) return;
    const localBody = completeLines(await fsp.readFile(local.file));
    const localHash = sha256(localBody);
    if (rec && localHash === rec.hash) return;
    if (rec && localBody.length > rec.bytes && sha256(localBody.subarray(0, rec.bytes)) === rec.hash) {
      if (!heldElsewhere(id)) await upload(id, localBody, localSec);
      return;
    }
    const remoteBody = await dav.get([...folderParts, `${id}.jsonl`]);
    if (remoteBody.equals(localBody)) {
      record(id, remoteBody, by, entry.mtimeSec);
      return;
    }
    if (remoteBody.length > localBody.length && remoteBody.subarray(0, localBody.length).equals(localBody)) {
      if (running.has(id)) result.skippedRunning.push(id);
      else await download(id, local.file, remoteBody, entry, by);
      return;
    }
    if (localBody.length > remoteBody.length && localBody.subarray(0, remoteBody.length).equals(remoteBody)) {
      if (!heldElsewhere(id)) await upload(id, localBody, localSec);
      return;
    }
    if (running.has(id)) {
      result.diverged.push({ id, machine: by, kept: 'running here; resolved once it stops' });
      return;
    }
    const forkId = crypto.randomUUID();
    const forkName = `${names[id] || 'session'}-${shortMachine(machine)}`;
    const forkBody = Buffer.from(localBody.toString('utf8').split(`"sessionId":"${id}"`).join(`"sessionId":"${forkId}"`));
    await writeLocal(path.join(path.dirname(local.file), `${forkId}.jsonl`), forkBody, localSec);
    await download(id, local.file, remoteBody, entry, by);
    names[forkId] = forkName;
    forks.push({ id, forkId, name: forkName, machine: by });
    await upload(forkId, forkBody, localSec);
  };
  for (const id of merged) {
    try {
      await syncOne(id);
    } catch (err) {
      result.failed.push({ id, error: err.message });
    }
  }
  result.forked = forks;

  const lockHolders = {};
  for (const name of remoteLocks.keys()) {
    const id = name.replace(/\.json$/, '');
    if (!name.endsWith('.json')) continue;
    lockHolders[id] = locks[id] || (await dav.getJson([...lockParts, name]));
  }
  for (const id of Object.keys(lockHolders)) {
    const lock = lockHolders[id];
    if (!isMine(lock) || (running.has(id) && merged.includes(id))) continue;
    await dav.request('DELETE', [...lockParts, `${id}.json`], { ok: [204, 404] });
    result.released.push(id);
  }
  for (const id of removed) {
    if (remote.has(`${id}.jsonl`)) await dav.request('DELETE', [...folderParts, `${id}.jsonl`], { ok: [204, 404] });
  }

  const current = localState(stateFile);
  const currentFav = new Set(Object.keys(current.favorites || {}));
  const toggledOff = [...localFav].filter((id) => !currentFav.has(id));
  const toggledOn = [...currentFav].filter((id) => !localFav.has(id));
  const final = [...new Set([...merged.filter((id) => !toggledOff.includes(id)), ...toggledOn, ...forks.map((f) => f.forkId)])].sort();
  for (const id of toggledOff) {
    await dav.request('DELETE', [...folderParts, `${id}.jsonl`], { ok: [204, 404] });
    delete manifest[id];
  }
  for (const id of removed) delete manifest[id];
  const favorites = Object.fromEntries(final.map((id) => [id, true]));
  const favoriteNames = Object.fromEntries(final.filter((id) => names[id]).map((id) => [id, names[id]]));
  const localNow = { ...(current.favorites || {}) };
  for (const id of localFav) if (!merged.includes(id)) delete localNow[id];
  for (const id of merged) if (!localFav.has(id) && !toggledOff.includes(id)) localNow[id] = true;
  for (const f of forks) localNow[f.forkId] = true;
  const files = {};
  for (const id of final) {
    const local = await newestFile(id);
    if (local && manifest[id]) files[id] = { size: local.size, mtimeMs: local.mtimeMs, hash: manifest[id].hash };
  }
  const forkNames = Object.fromEntries(forks.map((f) => [f.forkId, f.name]));
  writeStatePatch(stateFile, {
    favorites: localNow,
    names: { ...favoriteNames, ...(current.names || {}), ...forkNames },
    sync: { favorites: final, at: new Date().toISOString(), locks: Object.fromEntries(Object.keys(locks).filter(heldElsewhere).map((id) => [id, locks[id]])), files },
  });
  const liveManifest = Object.fromEntries(final.filter((id) => manifest[id]).map((id) => [id, manifest[id]]));
  const nextState = JSON.stringify({ favorites, names: favoriteNames, files: liveManifest }, null, 2);
  const previous = JSON.stringify({ favorites: remoteState.favorites || {}, names: remoteState.names || {}, files: remoteState.files || {} }, null, 2);
  if (nextState !== previous) await dav.put([...folderParts, 'state.json'], Buffer.from(`${nextState}\n`), Math.floor(Date.now() / 1000));
  result.favorites = final.length;
  result.removed = removed;
  return result;
}

async function readRemoteStatus(dav, folder = 'Claude Sessions', now = Date.now()) {
  const repos = [...(await dav.list([folder])).keys()].filter((name) => name !== folder);
  const out = [];
  for (const name of repos) {
    const listing = await dav.list([folder, name]);
    const state = (await dav.getJson([folder, name, 'state.json'])) || {};
    const lockNames = [...(await dav.list([folder, name, 'locks'])).keys()].filter((n) => n.endsWith('.json'));
    const locks = {};
    for (const n of lockNames) {
      const lock = await dav.getJson([folder, name, 'locks', n]);
      if (liveLock(lock, now)) locks[n.replace(/\.json$/, '')] = lock.machine;
    }
    const favorites = [];
    for (const id of Object.keys(state.favorites || {})) {
      favorites.push({ id, name: (state.names || {})[id], file: listing.has(`${id}.jsonl`), here: Boolean(await newestFile(id)), lock: locks[id] });
    }
    out.push({ name, favorites, files: [...listing.keys()].filter((n) => SESSION_FILE.test(n)).length, locks: Object.keys(locks) });
  }
  return out;
}

module.exports = { readRemoteStatus, WebDav, startLogin, finishLogin, syncFavorites, readLock, machineId, LOCK_TTL_MS, repoKey, projectDir, normalizeServer };
