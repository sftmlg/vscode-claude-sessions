'use strict';
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { filesForSession, readStateFile, writeStatePatch, listRepoSessions } = require('./sessions');

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

async function writeLocal(file, body, mtimeSec) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.sync`;
  await fsp.writeFile(tmp, body);
  await fsp.utimes(tmp, mtimeSec, mtimeSec);
  await fsp.rename(tmp, file);
}

function mergeNames({ local, remote, base, times, now }) {
  const names = {};
  const stamps = { ...times };
  const fromRemote = {};
  for (const id of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const l = local[id];
    const r = remote[id];
    if (l === undefined) {
      names[id] = fromRemote[id] = r;
      continue;
    }
    if (r === undefined || l === r) {
      names[id] = l;
      if (r === undefined) stamps[id] = stamps[id] || now;
      continue;
    }
    const localChanged = base ? l !== base[id] : !times[id];
    const remoteChanged = base ? r !== base[id] : true;
    if (localChanged && (!remoteChanged || now >= (times[id] || 0))) {
      names[id] = l;
      stamps[id] = now;
    } else {
      names[id] = fromRemote[id] = r;
    }
  }
  return { names, stamps, fromRemote };
}

const CONVERSATION = new Set(['user', 'assistant']);

function divergingLines(a, b) {
  const la = a.toString('utf8').split('\n');
  const lb = b.toString('utf8').split('\n');
  let i = 0;
  while (i < la.length && i < lb.length && la[i] === lb[i]) i++;
  return [la.slice(i), lb.slice(i)];
}

function holdsConversation(lines) {
  return lines.some((line) => {
    try {
      return CONVERSATION.has(JSON.parse(line).type);
    } catch {
      return false;
    }
  });
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

async function syncLocked({ creds, wsPath, stateFile, folder = 'Claude Sessions', running = new Set(), machine = machineId(), legacy = legacyMachineId(), now = Date.now(), fetchImpl, chunkBytes, recentDays = 0 }) {
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
  const merge = mergeNames({ local: state.names || {}, remote: remoteState.names || {}, base: (state.sync && state.sync.names) || null, times: remoteState.nameTimes || {}, now });
  const names = merge.names;

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
    const [localExtra, remoteExtra] = divergingLines(localBody, remoteBody);
    if (!holdsConversation(localExtra)) {
      if (running.has(id)) result.skippedRunning.push(id);
      else await download(id, local.file, remoteBody, entry, by);
      return;
    }
    if (!holdsConversation(remoteExtra)) {
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
  const recent = await syncRecent({ dav, folderParts, wsPath, machine, days: recentDays, favorites: new Set(final), cache: (state.sync && state.sync.recent) || {} });
  const adopted = Object.fromEntries(Object.entries(merge.fromRemote).filter(([id]) => (current.names || {})[id] === (state.names || {})[id]));
  const nameTimes = Object.fromEntries(final.filter((id) => favoriteNames[id] && merge.stamps[id]).map((id) => [id, merge.stamps[id]]));
  for (const f of forks) nameTimes[f.forkId] = now;
  writeStatePatch(stateFile, {
    favorites: localNow,
    names: { ...favoriteNames, ...(current.names || {}), ...adopted, ...forkNames },
    sync: { favorites: final, names: favoriteNames, at: new Date().toISOString(), locks: Object.fromEntries(Object.keys(locks).filter(heldElsewhere).map((id) => [id, locks[id]])), files, recent: recent ? recent.files : undefined },
  });
  const liveManifest = Object.fromEntries(final.filter((id) => manifest[id]).map((id) => [id, manifest[id]]));
  const nextState = JSON.stringify({ favorites, names: favoriteNames, nameTimes, files: liveManifest }, null, 2);
  const previous = JSON.stringify({ favorites: remoteState.favorites || {}, names: remoteState.names || {}, nameTimes: remoteState.nameTimes || {}, files: remoteState.files || {} }, null, 2);
  if (nextState !== previous) await dav.put([...folderParts, 'state.json'], Buffer.from(`${nextState}\n`), Math.floor(Date.now() / 1000));
  result.favorites = final.length;
  result.removed = removed;
  result.recent = recent;
  return result;
}

async function syncRecent({ dav, folderParts, wsPath, machine, days, favorites, cache }) {
  const parts = [...folderParts, 'recent', machineKey(machine)];
  if (days > 0) await dav.ensureFolder(parts);
  const remote = await dav.list(parts);
  const out = { uploaded: [], pruned: [], failed: [], files: {} };
  const keep = new Set();
  for (const meta of days > 0 ? await listRepoSessions(wsPath, days) : []) {
    if (favorites.has(meta.id)) continue;
    keep.add(meta.id);
    try {
      const local = await newestFile(meta.id);
      if (!local) continue;
      const seen = cache[meta.id];
      if (remote.has(`${meta.id}.jsonl`) && seen && seen.size === local.size && seen.mtimeMs === local.mtimeMs) {
        out.files[meta.id] = seen;
        continue;
      }
      const body = completeLines(await fsp.readFile(local.file));
      if (!body.length) continue;
      await dav.put([...parts, `${meta.id}.jsonl`], body, Math.floor(local.mtimeMs / 1000));
      out.files[meta.id] = { size: local.size, mtimeMs: local.mtimeMs };
      out.uploaded.push(meta.id);
    } catch (err) {
      out.failed.push({ id: meta.id, error: err.message });
    }
  }
  for (const name of remote.keys()) {
    if (!SESSION_FILE.test(name) || keep.has(name.replace(/\.jsonl$/, ''))) continue;
    await dav.request('DELETE', [...parts, name], { ok: [204, 404] });
    out.pruned.push(name.replace(/\.jsonl$/, ''));
  }
  return out;
}

async function loadRecent({ creds, wsPath, stateFile, id, owner, name, folder = 'Claude Sessions', fetchImpl }) {
  const dav = new WebDav(creds, fetchImpl);
  const parts = [folder, repoKey(wsPath), 'recent', machineKey(owner)];
  const entry = (await dav.list(parts)).get(`${id}.jsonl`);
  if (!entry) throw new Error('the other machine no longer has it in Nextcloud');
  const body = await dav.get([...parts, `${id}.jsonl`]);
  const local = await newestFile(id);
  if (local) {
    const mine = completeLines(await fsp.readFile(local.file));
    const grows = body.length >= mine.length && body.subarray(0, mine.length).equals(mine);
    if (!grows) throw new Error('this machine holds a different copy of it; star it on both machines to merge them');
  }
  await writeLocal(local ? local.file : path.join(projectDir(wsPath), `${id}.jsonl`), body, entry.mtimeSec);
  const state = localState(stateFile);
  writeStatePatch(stateFile, {
    favorites: { ...(state.favorites || {}), [id]: true },
    names: name && !(state.names || {})[id] ? { ...(state.names || {}), [id]: name } : state.names || {},
  });
  return { bytes: body.length };
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

const machineKey = (id) => String(id).replace(/[^A-Za-z0-9._-]+/g, '_');

async function heartbeat({ creds, wsPath, stateFile, folder = 'Claude Sessions', machine = machineId(), legacy = legacyMachineId(), name, sessions = [], running = new Set(), now = Date.now(), fetchImpl }) {
  const dav = new WebDav(creds, fetchImpl);
  const folderParts = [folder, repoKey(wsPath)];
  const machinesParts = [...folderParts, 'machines'];
  const requestsParts = [...folderParts, 'requests'];
  const lockParts = [...folderParts, 'locks'];
  await dav.ensureFolder(machinesParts);
  await dav.ensureFolder(requestsParts);
  await dav.ensureFolder(lockParts);
  const state = localState(stateFile);
  const registered = name ? null : await dav.getJson([...machinesParts, `${machineKey(machine)}.json`]);
  const entry = { id: machine, name: name || (registered && registered.name) || machineName(), lastSeen: new Date(now).toISOString(), lastSync: (state.sync && state.sync.at) || null, sessions };
  await dav.put([...machinesParts, `${machineKey(machine)}.json`], Buffer.from(JSON.stringify(entry)), Math.floor(now / 1000));

  const renewed = [];
  for (const lockName of (await dav.list(lockParts)).keys()) {
    if (!lockName.endsWith('.json')) continue;
    const id = lockName.replace(/\.json$/, '');
    if (!running.has(id)) continue;
    const lock = await dav.getJson([...lockParts, lockName]);
    if (!lock || (lock.machine !== machine && lock.machine !== legacy)) continue;
    await dav.put([...lockParts, lockName], Buffer.from(JSON.stringify({ ...lock, machine, heartbeat: now })), Math.floor(now / 1000));
    renewed.push(id);
  }

  const machines = (await readMachines(dav, folderParts)).map((m) => ({ ...m, self: m.id === machine || m.id === legacy }));
  machines.sort((a, b) => Number(b.self) - Number(a.self) || String(a.name).localeCompare(String(b.name)));

  const incoming = [];
  const outgoing = [];
  for (const file of (await dav.list(requestsParts)).keys()) {
    if (!file.endsWith('.json')) continue;
    const req = await dav.getJson([...requestsParts, file]);
    if (!req || !req.sessionId) continue;
    if (req.from === machine || req.from === legacy) incoming.push(req);
    else if (req.by === machine || req.by === legacy) outgoing.push(req);
  }
  const remoteState = (await dav.getJson([...folderParts, 'state.json'])) || {};
  const uploaded = {};
  for (const m of machines) {
    for (const [n, e] of await dav.list([...folderParts, 'recent', machineKey(m.id)])) {
      if (SESSION_FILE.test(n)) uploaded[n.replace(/\.jsonl$/, '')] = { mtimeSec: e.mtimeSec, by: m.id, recent: true };
    }
  }
  for (const [n, e] of await dav.list(folderParts)) {
    if (SESSION_FILE.test(n)) uploaded[n.replace(/\.jsonl$/, '')] = { mtimeSec: e.mtimeSec, by: ((remoteState.files || {})[n.replace(/\.jsonl$/, '')] || {}).machine || null };
  }
  return { name: entry.name, machines, incoming, outgoing, renewed, uploaded };
}

async function readMachines(dav, folderParts) {
  const machines = [];
  for (const file of (await dav.list([...folderParts, 'machines'])).keys()) {
    if (!file.endsWith('.json')) continue;
    const m = await dav.getJson([...folderParts, 'machines', file]);
    if (m && m.id) machines.push(m);
  }
  return machines;
}

async function listRemoteSessions({ creds, wsPath, folder = 'Claude Sessions', fetchImpl }) {
  const dav = new WebDav(creds, fetchImpl);
  const folderParts = [folder, repoKey(wsPath)];
  const machines = await readMachines(dav, folderParts);
  const state = (await dav.getJson([...folderParts, 'state.json'])) || {};
  const nameOf = (id) => (state.names || {})[id] || machines.flatMap((m) => m.sessions || []).find((x) => x.id === id)?.name || null;
  const machineName = (id) => (machines.find((m) => m.id === id) || {}).name || id;
  const sessions = [];
  const sizes = async (parts) => {
    const res = await dav.request('PROPFIND', parts, { headers: { Depth: '1' }, ok: [207, 404] });
    if (res.status === 404) return [];
    return (await res.text())
      .split(/<(?:[\w-]+:)?response[\s>]/i)
      .slice(1)
      .map((block) => ({
        name: decodeURIComponent(((block.match(/<(?:[\w-]+:)?href>([^<]+)</i) || [])[1] || '').replace(/\/$/, '').split('/').pop()),
        mtimeSec: Math.floor(Date.parse((block.match(/<(?:[\w-]+:)?getlastmodified>([^<]+)</i) || [])[1]) / 1000),
        bytes: Number((block.match(/<(?:[\w-]+:)?getcontentlength>(\d+)</i) || [])[1] || 0),
      }))
      .filter((e) => SESSION_FILE.test(e.name));
  };
  for (const e of await sizes(folderParts)) {
    const id = e.name.replace(/\.jsonl$/, '');
    const by = ((state.files || {})[id] || {}).machine;
    sessions.push({ id, name: nameOf(id), favorite: true, machine: by ? machineName(by) : null, path: [...folderParts, e.name].join('/'), lastSync: new Date(e.mtimeSec * 1000).toISOString(), bytes: e.bytes });
  }
  for (const m of machines) {
    for (const e of await sizes([...folderParts, 'recent', machineKey(m.id)])) {
      const id = e.name.replace(/\.jsonl$/, '');
      sessions.push({ id, name: nameOf(id), favorite: false, machine: m.name, path: [...folderParts, 'recent', machineKey(m.id), e.name].join('/'), lastSync: new Date(e.mtimeSec * 1000).toISOString(), bytes: e.bytes });
    }
  }
  const listed = new Set(sessions.map((x) => x.id));
  for (const m of machines) {
    for (const x of m.sessions || []) {
      if (listed.has(x.id)) continue;
      listed.add(x.id);
      sessions.push({ id: x.id, name: x.name || null, favorite: Boolean(x.favorite), machine: m.name, path: null, lastSync: null, lastActivity: x.lastActivity || null, running: Boolean(x.running), bytes: 0 });
    }
  }
  const when = (x) => Date.parse(x.lastSync || x.lastActivity) || 0;
  return sessions.sort((a, b) => Number(Boolean(b.path)) - Number(Boolean(a.path)) || Number(b.favorite) - Number(a.favorite) || when(b) - when(a));
}

async function getRemoteSession({ creds, wsPath, id, folder = 'Claude Sessions', fetchImpl }) {
  const all = (await listRemoteSessions({ creds, wsPath, folder, fetchImpl })).filter((x) => x.id === id || x.id.startsWith(id));
  const found = all.filter((x) => x.path);
  if (!found.length && all.length) throw new Error(`${all[0].id} is only listed by ${all[0].machine}; its content is not in Nextcloud. Load it in Remote, then that machine uploads it.`);
  if (!found.length) throw new Error(`No session ${id} in Nextcloud for ${repoKey(wsPath)}`);
  const pick = found.reduce((a, b) => (Date.parse(b.lastSync) > Date.parse(a.lastSync) ? b : a));
  return { session: pick, body: await new WebDav(creds, fetchImpl).get(pick.path.split('/')) };
}

async function requestSession({ creds, wsPath, stateFile, id, from, name, folder = 'Claude Sessions', machine = machineId(), now = Date.now(), fetchImpl }) {
  const dav = new WebDav(creds, fetchImpl);
  const requestsParts = [folder, repoKey(wsPath), 'requests'];
  await dav.ensureFolder(requestsParts);
  const state = localState(stateFile);
  writeStatePatch(stateFile, {
    favorites: { ...(state.favorites || {}), [id]: true },
    names: name && !(state.names || {})[id] ? { ...(state.names || {}), [id]: name } : state.names || {},
  });
  await dav.put([...requestsParts, `${id}.json`], Buffer.from(JSON.stringify({ sessionId: id, from, by: machine, name: name || null, at: new Date(now).toISOString() })), Math.floor(now / 1000));
}

async function closeRequests({ creds, wsPath, ids, folder = 'Claude Sessions', fetchImpl }) {
  const dav = new WebDav(creds, fetchImpl);
  for (const id of ids) await dav.request('DELETE', [folder, repoKey(wsPath), 'requests', `${id}.json`], { ok: [204, 404] });
}

module.exports = { heartbeat, loadRecent, listRemoteSessions, getRemoteSession, requestSession, closeRequests, machineKey, readRemoteStatus, WebDav, startLogin, finishLogin, syncFavorites, readLock, machineId, LOCK_TTL_MS, repoKey, projectDir, normalizeServer };
