'use strict';
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const TOKEN_FILE = 'launch.token';
const BODY_LIMIT = 4096;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function readToken(stateDir) {
  try {
    const t = fs.readFileSync(path.join(stateDir, TOKEN_FILE), 'utf8').trim();
    return TOKEN_RE.test(t) ? t : null;
  } catch {
    return null;
  }
}

function ensureToken(stateDir) {
  const existing = readToken(stateDir);
  if (existing) return existing;
  const token = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(path.join(stateDir, TOKEN_FILE), `${token}\n`, { mode: 0o600 });
  return token;
}

function checkLaunch(req, port, token) {
  const h = req.headers;
  if (!LOOPBACK.has(req.socket && req.socket.remoteAddress)) return 'not-loopback';
  if (h['tailscale-user-login'] !== undefined || h.origin !== undefined) return 'forwarded';
  if (h.host !== `127.0.0.1:${port}` && h.host !== `localhost:${port}`) return 'bad-host';
  const m = /^Bearer (\S+)$/.exec(String(h.authorization || ''));
  const given = m ? Buffer.from(m[1]) : Buffer.alloc(0);
  const want = Buffer.from(token);
  return given.length === want.length && crypto.timingSafeEqual(given, want) ? null : 'bad-token';
}

function handleLaunch(req, res, { port, token, registry, log }) {
  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const denied = checkLaunch(req, port, token);
  if (denied) {
    log(`launch denied reason=${denied}`);
    return send(403, { error: 'forbidden' });
  }
  if (req.method !== 'POST') return send(405, { error: 'post-only' });
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size <= BODY_LIMIT) chunks.push(c);
  });
  req.on('end', async () => {
    if (size > BODY_LIMIT) return send(413, { error: 'too-large' });
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return send(400, { error: 'bad-json' });
    }
    try {
      const r = await registry.openForTerminal({ dir: body.dir, resumeId: body.resumeId || null, attachOnly: body.attachOnly === true }, { device: { id: 'editor' } });
      return send(200, { name: r.name });
    } catch (e) {
      return send(409, { error: e.code || 'failed', msg: e.message });
    }
  });
  return undefined;
}

function requestLaunch(config, body, { timeoutMs = 60000 } = {}) {
  const token = readToken(config.stateDir);
  if (!token) return Promise.resolve({ status: 0, body: { error: 'no-service' } });
  const data = JSON.stringify(body);
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: config.port, method: 'POST', path: '/admin/session', timeout: timeoutMs, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, body: json || {} });
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 0, body: { error: 'no-service' } }));
    req.end(data);
  });
}

module.exports = { ensureToken, readToken, checkLaunch, handleLaunch, requestLaunch, TOKEN_FILE };
