#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const { createAuth, expandHome, idleDays, DEVICE_ID_RE } = require('./auth');

const TAILSCALE_APP = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

const USAGE = [
  'Usage:',
  '  node remote/cli.js pair <code> [name]   (approve a pending pairing shown on the new device)',
  '  node remote/cli.js devices [--json]',
  '  node remote/cli.js revoke <device-id>',
  '  node remote/cli.js status [--json]   (exit 0 only when every check passes)',
].join('\n');

function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 10000, ...opts }, (error, stdout, stderr) => resolve({ error, stdout: String(stdout), stderr: String(stderr) }));
  });
}

async function tailscale(args) {
  const r = await run('tailscale', args);
  if (r.error && r.error.code === 'ENOENT') return run(TAILSCALE_APP, args);
  return r;
}

function request(config, { method = 'GET', url, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: config.port, method, path: url, headers, timeout: 5000 }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try {
          json = data ? JSON.parse(data) : null;
        } catch {}
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function readAdminToken(config) {
  try {
    return fs.readFileSync(path.join(expandHome(config.stateDir), 'admin.token'), 'utf8').trim();
  } catch {
    return null;
  }
}

async function admin(config, method, url, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = readAdminToken(config);
    if (!token) throw Object.assign(new Error('no admin token'), { code: 'NO_ADMIN_TOKEN' });
    const headers = { host: `127.0.0.1:${config.port}`, authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await request(config, { method, url, headers, body });
    if (r.status !== 403) return r;
  }
  return { status: 403, body: { error: 'forbidden' } };
}

async function serviceDown(config, e) {
  if (e && e.code === 'ECONNREFUSED') return true;
  if (!e || e.code !== 'NO_ADMIN_TOKEN') return false;
  try {
    await request(config, { url: '/admin/status', headers: { host: `127.0.0.1:${config.port}` } });
    return false;
  } catch (probe) {
    return probe.code === 'ECONNREFUSED';
  }
}

async function listenerAddresses(port) {
  const r = await run('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fn']);
  return r.stdout.split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1));
}

function serveEntry(serve, config) {
  const key = `${config.publicHost}:${config.publicPort}`;
  const web = serve && serve.Web && serve.Web[key];
  const proxy = web && web.Handlers && web.Handlers['/'] && web.Handlers['/'].Proxy;
  const tcp = serve && serve.TCP && serve.TCP[String(config.publicPort)];
  const funnel = Boolean(serve && serve.AllowFunnel && Object.values(serve.AllowFunnel).some(Boolean));
  return { proxy: proxy || null, http: Boolean(tcp && tcp.HTTP && !tcp.HTTPS), https: Boolean(tcp && tcp.HTTPS), funnel };
}

function publicReachable(config) {
  const scheme = config.publicScheme === 'https' ? 'https' : 'http';
  const lib = scheme === 'https' ? https : http;
  return new Promise((resolve) => {
    const req = lib.get(`${scheme}://${config.publicHost}:${config.publicPort}/`, { timeout: 8000 }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode === 200, detail: res.statusCode });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => resolve({ ok: false, detail: e.code || 'error' }));
  });
}

function folderWarning(body) {
  const access = body && body.folderAccess;
  if (!access || (access.desktop !== 'blocked' && access.documents !== 'blocked')) return null;
  const blocked = ['desktop', 'documents'].filter((k) => access[k] === 'blocked').map((k) => k[0].toUpperCase() + k.slice(1)).join(' and ');
  return `node has no access to ${blocked}. On this Mac: System Settings › Privacy & Security › Full Disk Access › add ${body.nodePath || 'the node binary'} — sessions touching Desktop/Documents hang until then.`;
}

async function status(config) {
  const checks = {};
  const warnings = [];
  try {
    const r = await admin(config, 'GET', '/admin/status');
    checks.service = { ok: r.status === 200, detail: r.status === 200 ? { pid: r.body.pid, devices: r.body.devices, pendingPairings: r.body.pendingPairings } : r.body };
    const warning = r.status === 200 ? folderWarning(r.body) : null;
    if (warning) warnings.push(warning);
  } catch (e) {
    checks.service = { ok: false, detail: e.code || 'error' };
  }
  const addrs = await listenerAddresses(config.port);
  checks.loopbackOnly = { ok: addrs.length > 0 && addrs.every((a) => a === `127.0.0.1:${config.port}`), detail: addrs };
  const s = await tailscale(['serve', 'status', '--json']);
  let serve = null;
  try {
    serve = JSON.parse(s.stdout || '{}');
  } catch {}
  const entry = serveEntry(serve, config);
  checks.serve = { ok: entry.proxy === `http://127.0.0.1:${config.port}` && (config.publicScheme === 'https' ? entry.https : entry.http), detail: entry };
  checks.noFunnel = { ok: serve !== null && !entry.funnel, detail: serve === null ? 'serve status unreadable' : entry.funnel };
  try {
    const r = await request(config, { url: '/', headers: { host: `${config.publicHost}:${config.publicPort}` } });
    checks.rejectsAnonymous = { ok: r.status === 403, detail: r.status };
  } catch (e) {
    checks.rejectsAnonymous = { ok: false, detail: e.code || 'error' };
  }
  checks.publicReachable = await publicReachable(config);
  return { ok: Object.values(checks).every((c) => c.ok), checks, warnings };
}

function span(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function formatDevices(items, config, now = Date.now()) {
  if (!items.length) return 'No paired devices.';
  const limitMs = idleDays(config) * 86400000;
  return items
    .map((d) => {
      const idle = now - Date.parse(d.lastSeen);
      return `${d.id}  ${d.name}  age ${span(now - Date.parse(d.createdAt))}  idle ${span(idle)}  expires in ${Math.ceil(Math.max(0, limitMs - idle) / 86400000)}d`;
    })
    .join('\n');
}

async function main(argv, { config, out = console.log, err = console.error } = {}) {
  const [command, ...rest] = argv;
  const json = rest.includes('--json');
  const args = rest.filter((a) => a !== '--json');
  if (!config) config = require('./config').loadConfig();

  if (command === 'pair') {
    const [code, ...nameParts] = args;
    if (!/^\d{6}$/.test(code || '')) {
      err('Pass the 6-digit code shown on the new device.');
      return 2;
    }
    let r;
    try {
      r = await admin(config, 'POST', '/admin/approve', { code, name: nameParts.join(' ') || undefined });
    } catch (e) {
      err((await serviceDown(config, e)) ? 'The service is not running; pairing needs the running service.' : `Request failed: ${e.code || e.message}`);
      return 1;
    }
    if (r.status !== 200) {
      err(`Pairing refused: ${(r.body && r.body.error) || r.status}`);
      return 1;
    }
    out(`Paired ${r.body.device.id} (${r.body.device.name}).`);
    return 0;
  }

  if (command === 'devices') {
    let items;
    try {
      const r = await admin(config, 'GET', '/admin/devices');
      if (r.status !== 200) {
        err(`Listing refused: ${(r.body && r.body.error) || r.status}`);
        return 1;
      }
      items = r.body.items;
    } catch (e) {
      if (!(await serviceDown(config, e))) throw e;
      items = createAuth(config).listDevices();
    }
    out(json ? JSON.stringify(items, null, 2) : formatDevices(items, config));
    return 0;
  }

  if (command === 'revoke') {
    const [id] = args;
    if (!DEVICE_ID_RE.test(id || '')) {
      err('Pass a device id as shown by `devices`.');
      return 2;
    }
    try {
      const r = await admin(config, 'POST', '/admin/revoke', { deviceId: id });
      if (r.status !== 200) {
        err(`Revoke refused: ${(r.body && r.body.error) || r.status}`);
        return 1;
      }
    } catch (e) {
      if (!(await serviceDown(config, e))) throw e;
      if (!createAuth(config).revoke(id)) {
        err('Unknown device.');
        return 1;
      }
    }
    out(`Revoked ${id}.`);
    return 0;
  }

  if (command === 'status') {
    const s = await status(config);
    if (json) out(JSON.stringify(s, null, 2));
    else {
      for (const [name, c] of Object.entries(s.checks)) out(`${c.ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(c.detail)}`);
      for (const w of s.warnings) out(`WARN folderAccess: ${w}`);
    }
    return s.ok ? 0 : 1;
  }

  err(USAGE);
  return 2;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e.message);
      process.exit(1);
    },
  );
}

module.exports = { main, status, folderWarning, serveEntry, publicReachable, admin, TAILSCALE_APP };
