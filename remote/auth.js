'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { execFile } = require('child_process');

const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const CODE_RE = /^\d{6}$/;
const DEVICE_ID_RE = /^dev-[0-9a-f]{12}$/;
const PAIRING_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING = 3;
const MAX_FAILED_APPROVALS = 5;
const FAILED_WINDOW_MS = 10 * 60 * 1000;
const LOCKOUT_MS = 10 * 60 * 1000;
const LAST_SEEN_PERSIST_MS = 60 * 1000;
const ADMIN_BODY_LIMIT = 4096;
const NAME_MAX = 64;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const DAY_MS = 86400000;
const DEFAULT_IDLE_DAYS = 30;
const limits = Object.freeze({ maxUnauthed: 8, helloTimeoutMs: 30000 });
const DEFAULT_MAX_DEVICES = 12;
const DEFAULT_PROXY_PROCESSES = ['io.tailscale.ipn.macsys.network-extension', 'tailscaled'];
const PEER_PID_CACHE_MS = 60 * 1000;
const IP_RE = /^[0-9a-fA-F.:]{2,45}$/;

class AuthError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (typeof p === 'string' && p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function randomToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function safeEqual(a, b) {
  const ha = sha256(a);
  const hb = sha256(b);
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

function cleanName(name) {
  const s = typeof name === 'string' ? name : '';
  const cleaned = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').trim().slice(0, NAME_MAX);
  return cleaned || 'device';
}

function idleDays(config) {
  const n = Number(config && config.tokenIdleDays);
  return n > 0 ? n : DEFAULT_IDLE_DAYS;
}

function publicDevice(d) {
  return { id: d.id, name: d.name, createdAt: d.createdAt, lastSeen: d.lastSeen, node: d.node || null };
}

function cleanSource(source) {
  const s = source && typeof source === 'object' ? source : {};
  const n = s.node && typeof s.node === 'object' ? s.node : null;
  const ip = typeof s.ip === 'string' && IP_RE.test(s.ip) ? s.ip : null;
  return {
    via: s.via === 'serve' || s.via === 'loopback' ? s.via : 'unknown',
    ip,
    node: n && n.name ? { name: cleanName(n.name), os: n.os ? cleanName(n.os).slice(0, 32) : null } : null,
  };
}

const auditSource = (src) => ({ via: src.via, ip: src.ip, node: src.node ? src.node.name : null, os: src.node ? src.node.os : null });

function runFile(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 3000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(String(out))));
  });
}

function parseNetstatPeer(text, localPort, remotePort) {
  const client = `127.0.0.1.${remotePort}`;
  const server = `127.0.0.1.${localPort}`;
  for (const line of String(text).split('\n')) {
    const t = line.trim().split(/\s+/);
    if (t[0] !== 'tcp4' || t[3] !== client || t[4] !== server) continue;
    for (let i = 6; i < t.length; i++) {
      const m = /:(\d+)$/.exec(t[i]);
      if (m) return Number(m[1]);
    }
  }
  return null;
}

function createPeerCheck(config = {}, { run = runFile, now = Date.now } = {}) {
  const allowed = Array.isArray(config.proxyProcesses) && config.proxyProcesses.length ? config.proxyProcesses.map(String) : DEFAULT_PROXY_PROCESSES;
  const uids = Array.isArray(config.proxyUids) && config.proxyUids.length ? config.proxyUids.map(Number) : [0];
  const bySocket = new WeakMap();
  const byPid = new Map();

  async function processOf(pid) {
    const hit = byPid.get(pid);
    if (hit && now() - hit.at < PEER_PID_CACHE_MS) return hit.proc;
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(await run('/bin/ps', ['-o', 'uid=,comm=', '-p', String(pid)]));
    const proc = m ? { uid: Number(m[1]), path: m[2] } : null;
    byPid.set(pid, { at: now(), proc });
    return proc;
  }

  async function check(socket) {
    if (!socket || !LOOPBACK.has(socket.remoteAddress)) return { ok: false, reason: 'not-loopback' };
    let pid;
    let proc;
    try {
      pid = parseNetstatPeer(await run('/usr/sbin/netstat', ['-anv', '-p', 'tcp']), socket.localPort, socket.remotePort);
      if (!pid) return { ok: false, reason: 'peer-unknown' };
      proc = await processOf(pid);
    } catch {
      return { ok: false, reason: 'peer-unknown' };
    }
    if (!proc) return { ok: false, reason: 'peer-unknown', pid };
    const name = path.basename(proc.path);
    if (!uids.includes(proc.uid) || !allowed.includes(name)) return { ok: false, reason: 'peer-not-proxy', pid, process: name, uid: proc.uid };
    return { ok: true, reason: null, pid, process: name };
  }

  return {
    verify(socket) {
      if (socket && typeof socket === 'object' && bySocket.has(socket)) return bySocket.get(socket);
      const p = check(socket);
      if (socket && typeof socket === 'object') bySocket.set(socket, p);
      return p;
    },
  };
}

function header(req, name) {
  const v = req.headers[name];
  return Array.isArray(v) ? v.join(', ') : v;
}

function originOf(scheme, host, port) {
  const defaultPort = scheme === 'https' ? 443 : 80;
  return Number(port) === defaultPort || port === '' ? `${scheme}://${host}` : `${scheme}://${host}:${port}`;
}

function allowedOrigins(config, host, port) {
  const scheme = config.publicScheme === 'https' ? 'https' : 'http';
  const socketScheme = scheme === 'https' ? 'wss:' : 'ws:';
  const origins = new Set([originOf(scheme, host, port)]);
  for (const peer of Array.isArray(config.peers) ? config.peers : []) {
    let url;
    try {
      url = new URL(String(peer && peer.url));
    } catch {
      continue;
    }
    if (url.protocol === socketScheme && url.hostname) origins.add(originOf(scheme, url.hostname.toLowerCase(), url.port));
  }
  return origins;
}

function checkRequest(req, config) {
  const host = config && typeof config.publicHost === 'string' ? config.publicHost.toLowerCase() : '';
  const allowedLogin = config && typeof config.allowedLogin === 'string' ? config.allowedLogin : '';
  if (!host || !allowedLogin) return { ok: false, login: null, reason: 'not-configured' };
  const port = Number(config.publicPort);
  const gotHost = String(header(req, 'host') || '').toLowerCase();
  if (gotHost !== host && gotHost !== `${host}:${port}`) return { ok: false, login: null, reason: 'bad-host' };
  const login = header(req, 'tailscale-user-login');
  if (!login) return { ok: false, login: null, reason: 'no-identity' };
  if (login !== allowedLogin) return { ok: false, login: null, reason: 'wrong-identity' };
  const upgrade = String(header(req, 'upgrade') || '').toLowerCase();
  if (upgrade) {
    if (upgrade !== 'websocket' || req.method !== 'GET') return { ok: false, login, reason: 'bad-upgrade' };
    const origin = header(req, 'origin');
    const okOrigin = (typeof origin === 'string' && allowedOrigins(config, host, port).has(origin)) || (typeof origin === 'string' && /^vscode-webview:\/\/[A-Za-z0-9.-]+$/.test(origin));
    if (!okOrigin) return { ok: false, login, reason: 'bad-origin' };
  } else if (req.method !== 'GET' && req.method !== 'HEAD') {
    return { ok: false, login, reason: 'bad-method' };
  }
  return { ok: true, login, reason: null };
}

function writePrivateFile(file, content) {
  const tmp = `${file}.tmp-${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

class Auth extends EventEmitter {
  constructor(config, opts = {}) {
    super();
    if (!config || !config.stateDir) throw new Error('auth: config.stateDir is required');
    this.config = config;
    this.stateDir = expandHome(config.stateDir);
    this.devicesFile = path.join(this.stateDir, 'devices.json');
    this.auditFile = path.join(this.stateDir, 'audit.log');
    this.adminFile = path.join(this.stateDir, 'admin.token');
    this.limits = limits;
    this.maxDevices = Number(config.maxDevices) > 0 ? Number(config.maxDevices) : DEFAULT_MAX_DEVICES;
    this.log = typeof opts.log === 'function' ? opts.log : () => {};
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.pending = new Map();
    this.failed = [];
    this.lockedUntil = 0;
    this.adminToken = null;
    this.lastPersist = 0;
    ensurePrivateDir(this.stateDir);
    this.devices = this._load();
    if (opts.admin) this.rotateAdminToken();
  }

  _load() {
    if (!fs.existsSync(this.devicesFile)) return [];
    fs.chmodSync(this.devicesFile, 0o600);
    const data = JSON.parse(fs.readFileSync(this.devicesFile, 'utf8'));
    const list = Array.isArray(data.devices) ? data.devices : [];
    return list.filter((d) => d && DEVICE_ID_RE.test(d.id) && /^[0-9a-f]{64}$/.test(d.tokenHash));
  }

  _persist() {
    const body = JSON.stringify({ version: 1, devices: this.devices }, null, 2) + '\n';
    writePrivateFile(this.devicesFile, body);
    this.lastPersist = this.now();
  }

  _audit(action, fields = {}) {
    const line = JSON.stringify({ ts: new Date(this.now()).toISOString(), action, ...fields }) + '\n';
    const fd = fs.openSync(this.auditFile, 'a', 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      fs.writeSync(fd, line);
    } finally {
      fs.closeSync(fd);
    }
  }

  _purgeExpired() {
    const now = this.now();
    for (const [code, p] of this.pending) {
      if (p.expiresAt <= now) this._dropPending(code, 'expired');
    }
  }

  _dropPending(code, reason) {
    const p = this.pending.get(code);
    if (!p) return;
    this.pending.delete(code);
    clearTimeout(p.timer);
    if (p.state === 'approved') {
      this.devices = this.devices.filter((d) => d.id !== p.deviceId);
      this._persist();
    }
    if (p.reject) p.reject(new AuthError(reason));
    this.log(`auth pairing-dropped pairing=${p.id} reason=${reason}`);
  }

  createPairing(deviceName, { source } = {}) {
    this._purgeExpired();
    if (this.now() < this.lockedUntil) throw new AuthError('locked');
    if (this.pending.size >= MAX_PENDING) throw new AuthError('too-many-pending');
    let code;
    do code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    while (this.pending.has(code));
    const entry = {
      id: crypto.randomBytes(4).toString('hex'),
      code,
      waitToken: randomToken(),
      name: cleanName(deviceName),
      source: cleanSource(source),
      expiresAt: this.now() + PAIRING_TTL_MS,
      state: 'pending',
      rawToken: null,
      deviceId: null,
      resolve: null,
      reject: null,
    };
    entry.timer = setTimeout(() => this._dropPending(code, 'expired'), PAIRING_TTL_MS);
    entry.timer.unref();
    this.pending.set(code, entry);
    this._audit('pair', { pairing: entry.id, nameLength: entry.name.length, src: auditSource(entry.source) });
    this.log(`auth pairing-created pairing=${entry.id} pending=${this.pending.size}`);
    return { code, waitToken: entry.waitToken, expiresAt: entry.expiresAt };
  }

  _fail(by) {
    const now = this.now();
    this.failed = this.failed.filter((t) => t > now - FAILED_WINDOW_MS);
    this.failed.push(now);
    this._audit('approve-failed', { by });
    if (this.failed.length >= MAX_FAILED_APPROVALS) {
      this.lockedUntil = now + LOCKOUT_MS;
      this.failed = [];
      for (const code of [...this.pending.keys()]) this._dropPending(code, 'locked');
      this._audit('lockout', { ms: LOCKOUT_MS });
      this.log('auth pairing-lockout');
    }
  }

  approvePairing(code, approverDevice, name) {
    const by = approverDevice && approverDevice.id ? approverDevice.id : 'cli';
    if (this.now() < this.lockedUntil) throw new AuthError('locked');
    this._purgeExpired();
    const entry = typeof code === 'string' && CODE_RE.test(code) ? this.pending.get(code) : null;
    if (!entry || entry.state !== 'pending') {
      this._fail(by);
      throw new AuthError('unknown-code');
    }
    const rawToken = randomToken();
    const ts = new Date(this.now()).toISOString();
    const device = {
      id: `dev-${crypto.randomBytes(6).toString('hex')}`,
      name: name ? cleanName(name) : entry.name,
      createdAt: ts,
      lastSeen: ts,
      tokenHash: sha256(rawToken).toString('hex'),
      node: entry.source.node,
    };
    this.devices.push(device);
    this._persist();
    this._audit('approve', { pairing: entry.id, device: device.id, by, src: auditSource(entry.source) });
    this.log(`auth pairing-approved pairing=${entry.id} device=${device.id} by=${by} via=${entry.source.via}`);
    entry.deviceId = device.id;
    if (entry.resolve) {
      this.pending.delete(code);
      clearTimeout(entry.timer);
      entry.resolve(rawToken);
    } else {
      entry.state = 'approved';
      entry.rawToken = rawToken;
    }
    this.emit('added', publicDevice(device), entry.source);
    return publicDevice(device);
  }

  autoApprove(code, name) {
    this._purgeExpired();
    const entry = typeof code === 'string' && CODE_RE.test(code) ? this.pending.get(code) : null;
    if (!entry || entry.state !== 'pending') return this.approvePairing(code, { id: 'auto' }, name);
    const reason = entry.source.via !== 'serve' ? 'not-serve' : this.devices.length >= this.maxDevices ? 'max-devices' : null;
    if (reason) {
      this._audit('auto-refused', { pairing: entry.id, reason, src: auditSource(entry.source) });
      this.log(`auth auto-approve-refused pairing=${entry.id} reason=${reason}`);
      throw new AuthError('needs-approval');
    }
    return this.approvePairing(code, { id: 'auto' }, name);
  }

  awaitPairing(waitToken) {
    const entry = [...this.pending.values()].find((p) => typeof waitToken === 'string' && safeEqual(p.waitToken, waitToken));
    if (!entry) return Promise.reject(new AuthError('unknown-pairing'));
    if (entry.resolve) return Promise.reject(new AuthError('already-awaited'));
    if (entry.state === 'approved') {
      const token = entry.rawToken;
      this.pending.delete(entry.code);
      clearTimeout(entry.timer);
      return Promise.resolve(token);
    }
    return new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
  }

  _expireIdle() {
    const days = idleDays(this.config);
    const cutoff = this.now() - days * DAY_MS;
    const expired = this.devices.filter((d) => !(Date.parse(d.lastSeen) >= cutoff));
    if (!expired.length) return;
    this.devices = this.devices.filter((d) => !expired.includes(d));
    this._persist();
    for (const d of expired) {
      this._audit('expire', { device: d.id, idleDays: days });
      this.log(`auth device-expired device=${d.id}`);
      this.emit('revoked', d.id);
    }
  }

  verifyToken(token) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    this._expireIdle();
    const hash = sha256(token);
    let match = null;
    for (const d of this.devices) {
      if (crypto.timingSafeEqual(hash, Buffer.from(d.tokenHash, 'hex'))) match = d;
    }
    if (!match) return null;
    match.lastSeen = new Date(this.now()).toISOString();
    if (this.now() - this.lastPersist >= LAST_SEEN_PERSIST_MS) this._persist();
    return publicDevice(match);
  }

  listDevices() {
    this._expireIdle();
    return this.devices.map(publicDevice);
  }

  pendingCount() {
    this._purgeExpired();
    return this.pending.size;
  }

  revoke(deviceId, by = 'cli') {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== deviceId);
    if (this.devices.length === before) return false;
    this._persist();
    this._audit('revoke', { device: deviceId, by });
    this.log(`auth device-revoked device=${deviceId} by=${by}`);
    this.emit('revoked', deviceId);
    return true;
  }

  rotateAdminToken() {
    this.adminToken = randomToken();
    writePrivateFile(this.adminFile, this.adminToken + '\n');
  }

  checkAdmin(req) {
    if (!LOOPBACK.has(req.socket && req.socket.remoteAddress)) return { ok: false, reason: 'not-loopback' };
    if (header(req, 'tailscale-user-login') !== undefined) return { ok: false, reason: 'forwarded' };
    if (header(req, 'origin') !== undefined) return { ok: false, reason: 'has-origin' };
    const port = Number(this.config.port);
    const host = String(header(req, 'host') || '');
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return { ok: false, reason: 'bad-host' };
    if (!this.adminToken) return { ok: false, reason: 'no-admin-token' };
    const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(String(header(req, 'authorization') || ''));
    if (!m || !safeEqual(m[1], this.adminToken)) return { ok: false, reason: 'bad-admin-token' };
    this.rotateAdminToken();
    return { ok: true, reason: null };
  }

  handleAdmin(req, res, status = {}) {
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const check = this.checkAdmin(req);
    if (!check.ok) {
      this.log(`auth admin-denied reason=${check.reason}`);
      return send(403, { error: 'forbidden' });
    }
    const route = `${req.method} ${String(req.url).split('?')[0]}`;
    if (route === 'GET /admin/status') {
      return send(200, { ok: true, pid: process.pid, port: this.config.port, publicHost: this.config.publicHost, publicPort: this.config.publicPort, devices: this.devices.length, pendingPairings: this.pendingCount(), ...status });
    }
    if (route === 'GET /admin/devices') return send(200, { items: this.listDevices() });
    if (route !== 'POST /admin/approve' && route !== 'POST /admin/revoke') return send(404, { error: 'not-found' });
    if (!/^application\/json\b/.test(String(header(req, 'content-type') || ''))) return send(415, { error: 'json-required' });
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > ADMIN_BODY_LIMIT) {
        send(413, { error: 'too-large' });
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (size > ADMIN_BODY_LIMIT) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(400, { error: 'bad-json' });
      }
      try {
        if (route === 'POST /admin/approve') return send(200, { device: this.approvePairing(body.code, null, body.name) });
        if (typeof body.deviceId !== 'string' || !DEVICE_ID_RE.test(body.deviceId)) return send(400, { error: 'bad-device-id' });
        return this.revoke(body.deviceId) ? send(200, { ok: true }) : send(404, { error: 'unknown-device' });
      } catch (e) {
        const code = e instanceof AuthError ? e.code : 'internal';
        return send(code === 'locked' ? 429 : code === 'internal' ? 500 : 404, { error: code });
      }
    });
  }

  close() {
    for (const code of [...this.pending.keys()]) this._dropPending(code, 'closed');
    if (this.adminToken) {
      this.adminToken = null;
      fs.rmSync(this.adminFile, { force: true });
    }
  }
}

function createAuth(config, opts) {
  return new Auth(config, opts);
}

module.exports = {
  checkRequest,
  allowedOrigins,
  parseNetstatPeer,
  createPeerCheck,
  DEFAULT_PROXY_PROCESSES,
  createAuth,
  writePrivateFile,
  ensurePrivateDir,
  idleDays,
  limits,
  Auth,
  AuthError,
  expandHome,
  TOKEN_RE,
  DEVICE_ID_RE,
  PAIRING_TTL_MS,
  MAX_PENDING,
  MAX_FAILED_APPROVALS,
};
