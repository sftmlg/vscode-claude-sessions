'use strict';
const crypto = require('crypto');
const { execFile } = require('child_process');
const os = require('os');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { loadConfig } = require('./config');
const { Registry, UUID_RE } = require('./registry');
const { Mirror } = require('./mirror');
const { Queue } = require('./queue');
const tmux = require('./tmux');

function optional(name) {
  try {
    return require(name);
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(name.slice(2))) return null;
    throw e;
  }
}

const WEB_DIR = path.join(__dirname, 'web');
const MAX_TEXT = 64 * 1024;
const MAX_SUBS = 8;
const MAX_TAILS = 4;
const MAX_EVENTS = 500;
const TOOL_USE_RE = /^[A-Za-z0-9_-]{1,128}$/;
const RATE_PER_SEC = 10;
const HEARTBEAT_MS = 30000;
const HELLO_TIMEOUT_MS = 30000;
const MAX_UNAUTHENTICATED = 8;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_KEEP = 3;
const LOG_FILES = ['server.out.log', 'server.err.log'];
const FOLDER_PROBE_TIMEOUT_MS = 3000;
const HEALTH_INTERVAL_MS = 10 * 60 * 1000;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

function csp(config) {
  const ws = config.publicHost ? ` ws://${config.publicHost}:${config.publicPort}` : '';
  return `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'${ws}; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`;
}

function baseHeaders(config) {
  return { 'Content-Security-Policy': csp(config), 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
}

function staticPath(url) {
  let rel;
  try {
    rel = decodeURIComponent(String(url).split('?')[0]);
  } catch {
    return null;
  }
  if (rel.includes('\0') || rel.split('/').some((s) => s === '..')) return null;
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR + path.sep)) return null;
  if (!TYPES[path.extname(file)]) return null;
  return file;
}

function auditWriter(stateDir) {
  const file = path.join(stateDir, 'audit.log');
  return (action, fields = {}) => {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), action, ...fields })}\n`;
    try {
      const fd = fs.openSync(file, 'a', 0o600);
      try {
        fs.writeSync(fd, line);
      } finally {
        fs.closeSync(fd);
      }
    } catch {}
  };
}

function rotateLogs(dir, names = LOG_FILES, { maxBytes = LOG_MAX_BYTES, keep = LOG_KEEP } = {}) {
  for (const name of names) {
    const file = path.join(dir, name);
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      continue;
    }
    if (size <= maxBytes) continue;
    for (let i = keep - 1; i >= 1; i--) {
      try {
        fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      } catch {}
    }
    fs.copyFileSync(file, `${file}.1`);
    fs.chmodSync(`${file}.1`, 0o600);
    fs.truncateSync(file, 0);
  }
}

function probeFolder(dir, { cmd = '/bin/ls', args, timeoutMs = FOLDER_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args || [dir], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }, (err, _out, stderr) => {
      if (!err) return resolve('ok');
      if (err.killed || /not permitted/i.test(String(stderr))) return resolve('blocked');
      return resolve('ok');
    });
  });
}

async function checkFolderAccess(probe = probeFolder, home = os.homedir()) {
  const [desktop, documents] = await Promise.all([probe(path.join(home, 'Desktop')), probe(path.join(home, 'Documents'))]);
  return { desktop, documents, checkedAt: new Date().toISOString() };
}

function realNodePath() {
  try {
    return fs.realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

const clientItem = ({ transcriptPath, ...rest }) => ({ ...rest, hasTranscript: Boolean(transcriptPath) });

async function start(config, deps = {}) {
  const log = deps.log || ((msg) => console.log(`${new Date().toISOString()} ${msg}`));
  const authModule = optional('./auth');
  const auth = deps.auth || (authModule && authModule.createAuth(config, { admin: true, log }));
  if (!auth) throw new Error('remote/auth.js is required');
  const checkRequest = deps.checkRequest || (authModule && authModule.checkRequest);
  const transcript = deps.transcript === undefined ? optional('./transcript') : deps.transcript;
  const audit = deps.audit || auditWriter(config.stateDir);
  const ctx = { socket: config.tmuxSocket, bin: config.tmuxPath, childPath: config.childPath };
  const registry = deps.registry || new Registry(config, { ctx, audit });
  const queue = deps.queue || new Queue(path.join(config.stateDir, 'queue.json'));
  const mirrors = new Map();
  const liveTails = new Set();
  const closeTail = (t) => {
    liveTails.delete(t);
    t.close();
  };
  const conns = new Set();
  const buckets = new Map();
  const headers = baseHeaders(config);
  const limits = auth.limits || {};
  const maxUnauthed = limits.maxUnauthed || MAX_UNAUTHENTICATED;
  const helloTimeoutMs = deps.helloTimeoutMs || limits.helloTimeoutMs || HELLO_TIMEOUT_MS;

  const server = http.createServer((req, res) => {
    if (String(req.url).startsWith('/admin/')) return auth.handleAdmin(req, res, { sessions: registry.listAll().length, mirrors: mirrors.size, connections: conns.size, ...health });
    const check = checkRequest(req, config);
    if (!check.ok) {
      log(`http denied reason=${check.reason}`);
      res.writeHead(403, { ...headers, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('Forbidden\n');
    }
    const file = String(req.url).split('?')[0] === '/ws' ? null : staticPath(req.url);
    const notFound = () => {
      res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('Not found\n');
    };
    if (!file) return notFound();
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return notFound();
      res.writeHead(200, { ...headers, 'Content-Type': TYPES[path.extname(file)], 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: { threshold: 128, zlibDeflateOptions: { level: 6 } } });

  server.on('upgrade', (req, socket, head) => {
    const deny = (code, text) => {
      socket.end(`HTTP/1.1 ${code} ${text}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n`);
    };
    if (String(req.url).split('?')[0] !== '/ws') return deny(404, 'Not Found');
    const check = checkRequest(req, config);
    if (!check.ok) {
      log(`ws denied reason=${check.reason}`);
      return deny(403, 'Forbidden');
    }
    if ([...conns].filter((c) => !c.device).length >= maxUnauthed) {
      log('ws denied reason=too-many-unauthenticated');
      return deny(503, 'Service Unavailable');
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  });

  wss.on('headers', (h) => h.push('Cache-Control: no-store'));

  function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const c of conns) if (c.device && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  }

  registry.on('sessions', (items) => broadcast({ t: 'sessions', items: items.map(clientItem) }));
  registry.on('status', (s) => broadcast({ t: 'status', ...s }));
  registry.on('error', (e) => log(`registry error ${e.code || e.message}`));
  auth.on('revoked', (id) => {
    for (const c of conns) if (c.device && c.device.id === id) c.ws.close(4001, 'revoked');
  });

  function allow(deviceId) {
    const now = Date.now();
    const b = buckets.get(deviceId) || { tokens: RATE_PER_SEC, at: now };
    b.tokens = Math.min(RATE_PER_SEC, b.tokens + ((now - b.at) / 1000) * RATE_PER_SEC);
    b.at = now;
    buckets.set(deviceId, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  function mirrorFor(name) {
    let m = mirrors.get(name);
    if (m && !m.closed) return m;
    m = new Mirror(ctx, name).start();
    m.on('error', (e) => log(`mirror error session=${name} ${e.code || e.message}`));
    m.on('closed', () => {
      if (mirrors.get(name) === m) mirrors.delete(name);
      for (const c of conns) if (c.subs.get(name) === m) c.subs.delete(name);
    });
    mirrors.set(name, m);
    return m;
  }

  function onConnection(ws) {
    const conn = { id: crypto.randomBytes(6).toString('hex'), ws, device: null, subs: new Map(), tails: new Map(), alive: true, pairing: false };
    conns.add(conn);
    log(`ws open conn=${conn.id}`);
    const helloTimer = setTimeout(() => {
      if (!conn.device && !conn.pairing) ws.close(4008, 'hello timeout');
    }, helloTimeoutMs);
    helloTimer.unref();
    const send = (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
    const viewer = { id: conn.id, sendJson: send, sendBinary: (b) => ws.readyState === WebSocket.OPEN && ws.send(b, { binary: true }), bufferedAmount: () => ws.bufferedAmount };
    ws.on('pong', () => (conn.alive = true));
    ws.on('error', (e) => log(`ws error conn=${conn.id} ${e.code || 'error'}`));
    ws.on('message', (data, isBinary) => {
      conn.alive = true;
      if (isBinary) return send({ t: 'error', code: 'bad-request', msg: 'binary frames are not accepted' });
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return send({ t: 'error', code: 'bad-request', msg: 'invalid JSON' });
      }
      if (!msg || typeof msg.t !== 'string') return send({ t: 'error', code: 'bad-request', msg: 'missing type' });
      for (const m of conn.subs.values()) m.touch(conn.id);
      handle(conn, msg, send, viewer).catch((e) => {
        log(`ws handler error conn=${conn.id} type=${msg.t} ${e.code || e.message}`);
        send({ t: 'error', code: e.code || 'internal', msg: e.code ? e.message : 'internal error', ref: msg.t });
      });
    });
    ws.on('close', () => {
      conns.delete(conn);
      clearTimeout(helloTimer);
      for (const m of conn.subs.values()) m.removeViewer(conn.id);
      conn.subs.clear();
      conn.closed = true;
      for (const t of conn.tails.values()) if (t) closeTail(t);
      conn.tails.clear();
      log(`ws close conn=${conn.id}`);
    });
  }

  function sessionFor(key, { managed = false } = {}) {
    const item = typeof key === 'string' ? registry.resolve(key) : null;
    if (!item) throw Object.assign(new Error('Unknown session'), { code: 'not-found' });
    if (managed && !item.managed) throw Object.assign(new Error('Session runs outside the service; take it over to steer it'), { code: 'read-only' });
    return item;
  }

  async function transcriptFor(key) {
    if (!transcript) throw Object.assign(new Error('Chat view is not available'), { code: 'unavailable' });
    const item = sessionFor(key);
    if (!item.sessionId || !UUID_RE.test(item.sessionId)) throw Object.assign(new Error('No transcript yet'), { code: 'not-found' });
    const file = item.transcriptPath && (await transcript.safeTranscriptPath(item.transcriptPath));
    if (!file) throw Object.assign(new Error('No transcript yet'), { code: 'not-found' });
    return { item, file };
  }

  async function handle(conn, msg, send, viewer) {
    if (!conn.device && !['hello', 'pair', 'ping'].includes(msg.t)) return send({ t: 'error', code: 'unauthorized', msg: 'hello first' });
    switch (msg.t) {
      case 'ping':
        return send({ t: 'pong', t0: msg.t0, ts: msg.ts });
      case 'hello': {
        const device = typeof msg.token === 'string' ? await auth.verifyToken(msg.token) : null;
        if (!device) return send({ t: 'pairRequired', autoPair: config.autoApprovePairing === true });
        conn.device = device;
        log(`ws hello conn=${conn.id} device=${device.id}`);
        send({ t: 'helloOk', device, defaultDir: config.defaultDir, health });
        return send({ t: 'sessions', items: registry.listAll().map(clientItem) });
      }
      case 'pair': {
        if (conn.device || conn.pairing) return send({ t: 'error', code: 'bad-state', msg: 'pairing not possible now' });
        conn.pairing = true;
        let p;
        try {
          p = await auth.createPairing(String(msg.deviceName || ''));
        } catch (e) {
          conn.pairing = false;
          return send({ t: 'error', code: e.code || 'pair-failed', msg: 'pairing refused', ref: 'pair' });
        }
        send({ t: 'pairCode', code: p.code, expiresAt: p.expiresAt });
        if (config.autoApprovePairing === true) {
          try {
            auth.approvePairing(p.code, { id: 'auto' }, String(msg.deviceName || ''));
          } catch (e) {
            log(`auto-approve failed conn=${conn.id} ${e.code || 'error'}`);
          }
        }
        auth.awaitPairing(p.waitToken).then(
          async (token) => {
            conn.pairing = false;
            const device = await auth.verifyToken(token);
            if (!device || conn.ws.readyState !== WebSocket.OPEN) return;
            conn.device = device;
            send({ t: 'paired', token, device });
            send({ t: 'helloOk', device, defaultDir: config.defaultDir, health });
            send({ t: 'sessions', items: registry.listAll().map(clientItem) });
          },
          (e) => {
            conn.pairing = false;
            send({ t: 'error', code: e.code || 'pair-failed', msg: 'pairing ended', ref: 'pair' });
          },
        );
        return undefined;
      }
      case 'approvePair':
        try {
          await auth.approvePairing(String(msg.code || ''), conn.device);
        } catch (e) {
          return send({ t: 'error', code: e.code || 'approve-failed', msg: 'approval refused', ref: 'approvePair' });
        }
        return send({ t: 'devices', items: await auth.listDevices() });
      case 'devices':
        return send({ t: 'devices', items: await auth.listDevices() });
      case 'revoke':
        if (!(await auth.revoke(String(msg.deviceId || ''), conn.device.id))) return send({ t: 'error', code: 'not-found', msg: 'unknown device', ref: 'revoke' });
        return conn.ws.readyState === WebSocket.OPEN && send({ t: 'devices', items: await auth.listDevices() });
      case 'list':
        return send({ t: 'sessions', items: registry.listAll().map(clientItem) });
      case 'sub': {
        const item = sessionFor(msg.sessionId, { managed: true });
        if (!conn.subs.has(item.name) && conn.subs.size >= MAX_SUBS) return send({ t: 'error', code: 'too-many', msg: 'too many subscriptions' });
        const m = mirrorFor(item.name);
        conn.subs.set(item.name, m);
        return m.addViewer({ ...viewer, label: conn.device.name });
      }
      case 'unsub': {
        const item = typeof msg.sessionId === 'string' ? registry.resolve(msg.sessionId) : null;
        const name = item && item.name ? item.name : msg.sessionId;
        const m = conn.subs.get(name);
        if (m) {
          conn.subs.delete(name);
          m.removeViewer(conn.id);
        }
        for (const key of [msg.sessionId, item && item.sessionId]) {
          if (key && conn.tails.has(key)) {
            const t = conn.tails.get(key);
            conn.tails.delete(key);
            if (t) closeTail(t);
          }
        }
        return undefined;
      }
      case 'claimSize':
      case 'releaseSize': {
        const item = sessionFor(msg.sessionId, { managed: true });
        const m = conn.subs.get(item.name);
        if (!m) return send({ t: 'error', code: 'not-subscribed', msg: 'subscribe first' });
        if (msg.t === 'releaseSize') return m.release(conn.id);
        try {
          return await m.claim(conn.id, conn.device.name, msg.cols, msg.rows);
        } catch (e) {
          return send({ t: 'error', code: 'bad-size', msg: e.message, ref: 'claimSize' });
        }
      }
      case 'send':
      case 'key':
      case 'new':
      case 'takeover': {
        if (!Queue.validId(msg.id)) return send({ t: 'error', code: 'bad-request', msg: 'id must match [A-Za-z0-9_-]{1,64}' });
        const ack = await queue.run(`${conn.device.id}:${msg.id}`, () => mutate(conn, msg));
        if (ack.error === 'busy-dialog') send({ t: 'error', code: 'busy-dialog', msg: 'Claude is showing a dialog; send one line or use the keys', sessionId: msg.sessionId });
        return send({ t: 'ack', id: msg.id, ok: ack.ok, ...(ack.error ? { error: ack.error } : {}), ...(ack.name ? { name: ack.name } : {}) });
      }
      case 'takeoverPrepare': {
        let info;
        try {
          info = await registry.prepareTakeover(msg.pid);
        } catch (e) {
          return send({ t: 'error', code: e.code || 'takeover-failed', msg: e.message, ref: 'takeoverPrepare' });
        }
        return send({ t: 'takeoverInfo', ...info });
      }
      case 'events': {
        const { file } = await transcriptFor(msg.sessionId);
        const limit = Math.max(1, Math.min(MAX_EVENTS, Number(msg.limit) || 100));
        const before = Number.isFinite(msg.before) && msg.before >= 0 ? Math.floor(msg.before) : undefined;
        const r = await transcript.readEvents(file, { before, limit });
        return send({ t: 'events', sessionId: msg.sessionId, from: r.from, to: r.to, size: r.size, items: r.events, unknown: r.unknown });
      }
      case 'agentEvents': {
        if (typeof msg.toolUseId !== 'string' || !TOOL_USE_RE.test(msg.toolUseId)) return send({ t: 'error', code: 'bad-request', msg: 'invalid toolUseId', ref: 'agentEvents' });
        const { item, file } = await transcriptFor(msg.sessionId);
        const agent = (await transcript.listSubagents(file)).find((a) => a.toolUseId === msg.toolUseId);
        const agentFile = agent && (await transcript.resolveSubagent(item.sessionId, agent.agentId));
        if (!agentFile) return send({ t: 'error', code: 'not-found', msg: 'No subagent transcript for this tool call', ref: 'agentEvents' });
        const limit = Math.max(1, Math.min(MAX_EVENTS, Number(msg.limit) || 100));
        const before = Number.isFinite(msg.before) && msg.before >= 0 ? Math.floor(msg.before) : undefined;
        const r = await transcript.readEvents(agentFile, { before, limit });
        return send({ t: 'agentEvents', sessionId: msg.sessionId, toolUseId: msg.toolUseId, from: r.from, to: r.to, size: r.size, items: r.events, unknown: r.unknown });
      }
      case 'subEvents': {
        const key = msg.sessionId;
        if (typeof key !== 'string' || conn.tails.has(key)) return undefined;
        if (conn.tails.size >= MAX_TAILS) return send({ t: 'error', code: 'too-many', msg: 'too many chat subscriptions' });
        conn.tails.set(key, null);
        let tail = null;
        try {
          const { file } = await transcriptFor(key);
          if (conn.closed || conn.tails.get(key) !== null) return undefined;
          const from = Number.isFinite(msg.from) && msg.from >= 0 ? Math.floor(msg.from) : undefined;
          tail = new transcript.Tail(file, { from });
          conn.tails.set(key, tail);
          liveTails.add(tail);
          tail.on('events', (e) => send({ t: 'eventsLive', sessionId: key, items: e.events, from: e.from, to: e.to, size: e.size }));
          tail.on('reset', () => send({ t: 'reset', sessionId: key }));
          tail.on('error', (e) => log(`tail error conn=${conn.id} ${e.code || e.message}`));
          await tail.start();
          if (conn.closed || conn.tails.get(key) !== tail) closeTail(tail);
        } catch (e) {
          if (conn.tails.get(key) === tail) conn.tails.delete(key);
          if (tail) closeTail(tail);
          throw e;
        }
        return undefined;
      }
      default:
        return send({ t: 'error', code: 'bad-request', msg: `unknown type ${msg.t.slice(0, 32)}` });
    }
  }

  const inputChains = new Map();
  function serialized(name, fn) {
    const prev = inputChains.get(name) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    inputChains.set(name, tail);
    tail.then(() => inputChains.get(name) === tail && inputChains.delete(name));
    return run;
  }

  async function mutate(conn, msg) {
    const device = conn.device;
    try {
      if (msg.t === 'send' || msg.t === 'key') {
        if (!allow(device.id)) return { ok: false, error: 'rate-limited', retry: true };
        const item = sessionFor(msg.sessionId, { managed: true });
        if (msg.t === 'key') {
          if (!tmux.KEYS.has(msg.key)) return { ok: false, error: 'bad-key' };
          await serialized(item.name, () => tmux.sendKey(ctx, item.name, msg.key));
          audit('key', { device: device.id, session: item.name, key: msg.key });
          return { ok: true };
        }
        if (typeof msg.text !== 'string') return { ok: false, error: 'bad-request' };
        const text = tmux.stripControls(msg.text);
        if (!text.trim()) return { ok: false, error: 'empty' };
        if (text.length > MAX_TEXT) return { ok: false, error: 'too-long' };
        if (item.status === 'waiting' && text.trim().includes('\n')) return { ok: false, error: 'busy-dialog' };
        await serialized(item.name, () => tmux.paste(ctx, item.name, msg.id, text));
        audit('send', { device: device.id, session: item.name, length: text.length });
        return { ok: true };
      }
      if (msg.t === 'new') {
        const r = await registry.newSession({ name: msg.name, dir: msg.dir, resumeId: msg.resumeId }, { device });
        return { ok: true, name: r.name };
      }
      const r = await registry.takeover(msg.token, { device, force: msg.force === true });
      return { ok: true, name: r.name };
    } catch (e) {
      if (e.code && typeof e.code === 'string' && !/^E[A-Z]+$/.test(e.code)) return { ok: false, error: e.code };
      log(`mutate failed type=${msg.t} ${e.code || e.message}`);
      return { ok: false, error: 'failed' };
    }
  }

  rotateLogs(config.stateDir);
  const rotation = setInterval(() => rotateLogs(config.stateDir), 3600000);
  rotation.unref();

  const heartbeat = setInterval(() => {
    for (const c of conns) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {}
    }
  }, deps.heartbeatMs || HEARTBEAT_MS);
  heartbeat.unref();

  const health = { folderAccess: null, nodePath: realNodePath() };
  async function checkHealth() {
    const folderAccess = await checkFolderAccess(deps.probeFolder || probeFolder);
    const changed = !health.folderAccess || health.folderAccess.desktop !== folderAccess.desktop || health.folderAccess.documents !== folderAccess.documents;
    health.folderAccess = folderAccess;
    if (folderAccess.desktop === 'blocked' || folderAccess.documents === 'blocked') log(`health folder access blocked desktop=${folderAccess.desktop} documents=${folderAccess.documents}`);
    if (changed) broadcast({ t: 'health', ...health });
    return health;
  }
  await checkHealth();
  const healthTimer = setInterval(() => checkHealth().catch(() => {}), HEALTH_INTERVAL_MS);
  healthTimer.unref();

  await registry.start();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  log(`listening 127.0.0.1:${port} socket=${config.tmuxSocket}`);

  return {
    port,
    server,
    registry,
    checkHealth,
    stats: () => ({ tails: liveTails.size, mirrors: mirrors.size, connections: conns.size }),
    async close() {
      clearInterval(heartbeat);
      clearInterval(rotation);
      clearInterval(healthTimer);
      registry.stop();
      for (const c of conns) c.ws.terminate();
      for (const m of mirrors.values()) m.close();
      wss.close();
      if (!deps.auth && auth.close) auth.close();
      await new Promise((r) => server.close(r));
    },
  };
}

if (require.main === module) {
  process.umask(0o077);
  const config = loadConfig();
  start(config).then(
    (s) => {
      const stop = () => s.close().then(() => process.exit(0));
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
    },
    (e) => {
      console.error(`remote server failed to start: ${e.message}`);
      process.exit(1);
    },
  );
}

module.exports = { start, csp, staticPath, rotateLogs, probeFolder, checkFolderAccess };
