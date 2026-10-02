'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { checkRequest, createAuth, limits, TOKEN_RE, MAX_PENDING, MAX_FAILED_APPROVALS } = require('../auth');

const HOST = 'hub.example.test';
const LOGIN = 'owner@example.test';

function tmpConfig(extra = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-auth-'));
  return { stateDir: path.join(base, 'state'), port: 39181, publicHost: HOST, publicPort: 39180, allowedLogin: LOGIN, ...extra };
}

function req(headers, method = 'GET', remoteAddress = '127.0.0.1') {
  return { headers, method, url: '/', socket: { remoteAddress } };
}

const ok = { host: `${HOST}:39180`, 'tailscale-user-login': LOGIN };
const ws = { ...ok, upgrade: 'websocket', origin: `http://${HOST}:39180` };

test('checkRequest accepts the public host with and without port and the exact login', () => {
  assert.deepStrictEqual(checkRequest(req(ok), tmpConfig()), { ok: true, login: LOGIN, reason: null });
  assert.strictEqual(checkRequest(req({ ...ok, host: HOST }), tmpConfig()).ok, true);
  assert.strictEqual(checkRequest(req({ ...ok, host: HOST.toUpperCase() }), tmpConfig()).ok, true);
});

test('checkRequest rejects foreign hosts, missing or wrong identity, and missing configuration', () => {
  const c = tmpConfig();
  assert.strictEqual(checkRequest(req({ ...ok, host: 'evil.example' }), c).reason, 'bad-host');
  assert.strictEqual(checkRequest(req({ ...ok, host: '127.0.0.1:39181' }), c).reason, 'bad-host');
  assert.strictEqual(checkRequest(req({ ...ok, host: `${HOST}:1` }), c).reason, 'bad-host');
  assert.strictEqual(checkRequest(req({ host: ok.host }), c).reason, 'no-identity');
  assert.strictEqual(checkRequest(req({ ...ok, 'tailscale-user-login': 'other@example.test' }), c).reason, 'wrong-identity');
  assert.strictEqual(checkRequest(req({ ...ok, 'tailscale-user-login': `${LOGIN}, other@example.test` }), c).reason, 'wrong-identity');
  assert.strictEqual(checkRequest(req({ ...ok, 'tailscale-user-login': LOGIN.toUpperCase() }), c).reason, 'wrong-identity');
  assert.strictEqual(checkRequest(req(ok), { ...c, allowedLogin: '' }).reason, 'not-configured');
  assert.strictEqual(checkRequest(req(ok), { ...c, publicHost: undefined }).reason, 'not-configured');
});

test('checkRequest allows only GET and HEAD over plain HTTP', () => {
  const c = tmpConfig();
  assert.strictEqual(checkRequest(req(ok, 'HEAD'), c).ok, true);
  assert.strictEqual(checkRequest(req(ok, 'POST'), c).reason, 'bad-method');
});

test('checkRequest requires an allowed Origin on WebSocket upgrades', () => {
  const c = tmpConfig();
  assert.strictEqual(checkRequest(req(ws), c).ok, true);
  assert.strictEqual(checkRequest(req({ ...ws, origin: 'vscode-webview://1a2b3c' }), c).ok, true);
  for (const origin of [undefined, 'null', 'http://evil.example', `https://${HOST}:39180`, `http://${HOST}`, `http://${HOST}:39180.evil.example`, 'vscode-webview://x/../evil', 'vscode-webview://']) {
    assert.strictEqual(checkRequest(req({ ...ws, origin }), c).reason, 'bad-origin', String(origin));
  }
  assert.strictEqual(checkRequest(req({ ...ws, upgrade: 'h2c' }), c).reason, 'bad-upgrade');
});

test('state dir is 0700 and devices.json and audit.log are 0600 with only hashes stored', async () => {
  const c = tmpConfig();
  const a = createAuth(c);
  const { code, waitToken } = a.createPairing('Phone');
  const pending = a.awaitPairing(waitToken);
  const device = a.approvePairing(code);
  const token = await pending;
  assert.match(token, TOKEN_RE);
  assert.strictEqual(fs.statSync(c.stateDir).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(path.join(c.stateDir, 'devices.json')).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(path.join(c.stateDir, 'audit.log')).mode & 0o777, 0o600);
  const stored = fs.readFileSync(path.join(c.stateDir, 'devices.json'), 'utf8');
  assert.ok(!stored.includes(token));
  assert.ok(!fs.readFileSync(path.join(c.stateDir, 'audit.log'), 'utf8').includes(token));
  assert.deepStrictEqual(Object.keys(device).sort(), ['createdAt', 'id', 'lastSeen', 'name']);
  assert.strictEqual(device.name, 'Phone');
});

test('verifyToken accepts the issued token only, also after a reload from disk', async () => {
  const c = tmpConfig();
  const a = createAuth(c);
  const { code, waitToken } = a.createPairing('Laptop');
  a.approvePairing(code);
  const token = await a.awaitPairing(waitToken);
  assert.strictEqual(a.verifyToken(token).name, 'Laptop');
  assert.strictEqual(a.verifyToken(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')), null);
  for (const bad of [undefined, null, '', 'x', token + 'A', 42, {}]) assert.strictEqual(a.verifyToken(bad), null);
  const b = createAuth(c);
  assert.strictEqual(b.verifyToken(token).name, 'Laptop');
});

test('awaitPairing resolves the raw token once, also when approval comes first', async () => {
  const a = createAuth(tmpConfig());
  const { code, waitToken } = a.createPairing('x');
  a.approvePairing(code);
  const token = await a.awaitPairing(waitToken);
  assert.ok(a.verifyToken(token));
  await assert.rejects(a.awaitPairing(waitToken), { code: 'unknown-pairing' });
  await assert.rejects(a.awaitPairing('nope'), { code: 'unknown-pairing' });
});

test('approval by a paired device is recorded with its id', async () => {
  const c = tmpConfig();
  const a = createAuth(c);
  const first = a.createPairing('a');
  const approver = a.approvePairing(first.code);
  const second = a.createPairing('b');
  a.approvePairing(second.code, approver);
  const audit = fs.readFileSync(path.join(c.stateDir, 'audit.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(audit.map((l) => l.action), ['pair', 'approve', 'pair', 'approve']);
  assert.strictEqual(audit[1].by, 'cli');
  assert.strictEqual(audit[3].by, approver.id);
});

test('at most three pairings are pending', () => {
  const a = createAuth(tmpConfig());
  for (let i = 0; i < MAX_PENDING; i++) a.createPairing(`d${i}`);
  assert.throws(() => a.createPairing('extra'), { code: 'too-many-pending' });
});

test('pairings expire after five minutes and the waiter is rejected', async () => {
  let now = 1_000_000;
  const a = createAuth(tmpConfig(), { now: () => now });
  const { code, waitToken } = a.createPairing('x');
  const waiting = a.awaitPairing(waitToken);
  now += 5 * 60 * 1000;
  assert.throws(() => a.approvePairing(code), { code: 'unknown-code' });
  await assert.rejects(waiting, { code: 'expired' });
  assert.strictEqual(a.pendingCount(), 0);
});

test('an approved pairing that is never collected removes its device on expiry', () => {
  let now = 1_000_000;
  const a = createAuth(tmpConfig(), { now: () => now });
  const { code } = a.createPairing('x');
  a.approvePairing(code);
  assert.strictEqual(a.listDevices().length, 1);
  now += 5 * 60 * 1000;
  a.pendingCount();
  assert.strictEqual(a.listDevices().length, 0);
});

test('repeated wrong codes lock approvals and cancel pending pairings', async () => {
  const a = createAuth(tmpConfig());
  const { code, waitToken } = a.createPairing('x');
  const waiting = a.awaitPairing(waitToken);
  const wrong = code === '000000' ? '000001' : '000000';
  for (let i = 0; i < MAX_FAILED_APPROVALS; i++) assert.throws(() => a.approvePairing(wrong), { code: 'unknown-code' });
  await assert.rejects(waiting, { code: 'locked' });
  assert.throws(() => a.approvePairing(code), { code: 'locked' });
  assert.throws(() => a.createPairing('y'), { code: 'locked' });
});

test('malformed codes count as failures and never match', () => {
  const a = createAuth(tmpConfig());
  const { code } = a.createPairing('x');
  for (const bad of [Number(code), ` ${code}`, `${code}0`, code.slice(1), null]) assert.throws(() => a.approvePairing(bad), { code: 'unknown-code' });
});

test('revoke removes the device, emits revoked and invalidates its token', async () => {
  const c = tmpConfig();
  const a = createAuth(c);
  const { code, waitToken } = a.createPairing('x');
  const device = a.approvePairing(code);
  const token = await a.awaitPairing(waitToken);
  const seen = [];
  a.on('revoked', (id) => seen.push(id));
  assert.strictEqual(a.revoke(device.id), true);
  assert.deepStrictEqual(seen, [device.id]);
  assert.strictEqual(a.verifyToken(token), null);
  assert.strictEqual(a.revoke(device.id), false);
  assert.strictEqual(createAuth(c).verifyToken(token), null);
});

test('device names are stripped of control characters and capped', () => {
  const a = createAuth(tmpConfig());
  const { code } = a.createPairing(`a\x1b[31mb\u2028${'z'.repeat(200)}`);
  const d = a.approvePairing(code);
  assert.ok(!/[\x00-\x1f\u2028]/.test(d.name));
  assert.strictEqual(d.name.length, 64);
  const { code: c2 } = a.createPairing(undefined);
  assert.strictEqual(a.approvePairing(c2).name, 'device');
});

test('logs carry ids and reason codes, never codes or tokens', async () => {
  const lines = [];
  const a = createAuth(tmpConfig(), { log: (l) => lines.push(l) });
  const { code, waitToken } = a.createPairing('canary-name');
  const device = a.approvePairing(code);
  const token = await a.awaitPairing(waitToken);
  a.revoke(device.id);
  const all = lines.join('\n');
  for (const secret of [code, waitToken, token, 'canary-name']) assert.ok(!all.includes(secret), secret);
});

function adminRequest(a, port, { method = 'GET', url, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

async function withAdminServer(fn) {
  const c = tmpConfig();
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  c.port = server.address().port;
  const logs = [];
  const a = createAuth(c, { admin: true, log: (l) => logs.push(l) });
  server.on('request', (q, s) => a.handleAdmin(q, s));
  try {
    await fn({ a, c, logs, port: c.port, token: () => fs.readFileSync(path.join(c.stateDir, 'admin.token'), 'utf8').trim() });
  } finally {
    a.close();
    await new Promise((r) => server.close(r));
  }
}

test('admin token file is 0600, rotates after each use and is removed on close', async () => {
  await withAdminServer(async ({ a, c, port, token }) => {
    const file = path.join(c.stateDir, 'admin.token');
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    const t1 = token();
    const host = `127.0.0.1:${port}`;
    const r1 = await adminRequest(a, port, { url: '/admin/status', headers: { host, authorization: `Bearer ${t1}` } });
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r1.headers['cache-control'], 'no-store');
    assert.notStrictEqual(token(), t1);
    const r2 = await adminRequest(a, port, { url: '/admin/status', headers: { host, authorization: `Bearer ${t1}` } });
    assert.deepStrictEqual([r2.status, r2.body], [403, { error: 'forbidden' }]);
  });
});

test('admin routes refuse forwarded, browser and foreign-host requests with a generic error and log the reason', async () => {
  await withAdminServer(async ({ a, port, token, logs }) => {
    const host = `127.0.0.1:${port}`;
    const cases = [
      [{ host, 'tailscale-user-login': LOGIN }, 'forwarded'],
      [{ host, origin: 'http://evil.example' }, 'has-origin'],
      [{ host: `${HOST}:39180` }, 'bad-host'],
      [{ host, authorization: `Bearer ${'A'.repeat(43)}` }, 'bad-admin-token'],
      [{ host, authorization: 'Basic x' }, 'bad-admin-token'],
    ];
    for (const [headers, reason] of cases) {
      const r = await adminRequest(a, port, { url: '/admin/devices', headers: { authorization: `Bearer ${token()}`, ...headers } });
      assert.deepStrictEqual([r.status, r.body], [403, { error: 'forbidden' }]);
      assert.ok(logs.pop().endsWith(`reason=${reason}`), reason);
    }
    assert.strictEqual(a.checkAdmin({ headers: { host }, socket: { remoteAddress: '100.64.0.1' } }).reason, 'not-loopback');
  });
});

test('admin approve, devices and revoke work end to end', async () => {
  await withAdminServer(async ({ a, port, token }) => {
    const host = `127.0.0.1:${port}`;
    const h = () => ({ host, authorization: `Bearer ${token()}`, 'content-type': 'application/json' });
    const { code, waitToken } = a.createPairing('Phone');
    const waiting = a.awaitPairing(waitToken);
    const r = await adminRequest(a, port, { method: 'POST', url: '/admin/approve', headers: h(), body: { code, name: 'Renamed' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.device.name, 'Renamed');
    assert.ok(a.verifyToken(await waiting));
    const list = await adminRequest(a, port, { url: '/admin/devices', headers: h() });
    assert.deepStrictEqual(list.body.items.map((d) => d.id), [r.body.device.id]);
    const bad = await adminRequest(a, port, { method: 'POST', url: '/admin/approve', headers: h(), body: { code: '12345' } });
    assert.deepStrictEqual([bad.status, bad.body.error], [404, 'unknown-code']);
    const rv = await adminRequest(a, port, { method: 'POST', url: '/admin/revoke', headers: h(), body: { deviceId: r.body.device.id } });
    assert.strictEqual(rv.status, 200);
    const rv2 = await adminRequest(a, port, { method: 'POST', url: '/admin/revoke', headers: h(), body: { deviceId: '../x' } });
    assert.strictEqual(rv2.status, 400);
    const form = await adminRequest(a, port, { method: 'POST', url: '/admin/approve', headers: { ...h(), 'content-type': 'text/plain' }, body: '{}' });
    assert.strictEqual(form.status, 415);
    const big = await adminRequest(a, port, { method: 'POST', url: '/admin/approve', headers: h(), body: 'x'.repeat(10000) }).catch(() => ({ status: 413 }));
    assert.strictEqual(big.status, 413);
  });
});

const cli = require('../cli');

function capture() {
  const lines = [];
  return { lines, out: (l) => lines.push(l), err: (l) => lines.push(l) };
}

test('cli pair, devices and revoke go through the admin channel of the running service', async () => {
  await withAdminServer(async ({ a, c }) => {
    const { code, waitToken } = a.createPairing('Phone');
    const waiting = a.awaitPairing(waitToken);
    const io = capture();
    assert.strictEqual(await cli.main(['pair', code, 'My', 'Phone'], { config: c, ...io }), 0);
    const token = await waiting;
    const [device] = a.listDevices();
    assert.strictEqual(device.name, 'My Phone');
    const list = capture();
    assert.strictEqual(await cli.main(['devices', '--json'], { config: c, ...list }), 0);
    assert.deepStrictEqual(JSON.parse(list.lines[0]).map((d) => d.id), [device.id]);
    const revoked = [];
    a.on('revoked', (id) => revoked.push(id));
    assert.strictEqual(await cli.main(['revoke', device.id], { config: c, ...capture() }), 0);
    assert.deepStrictEqual(revoked, [device.id]);
    assert.strictEqual(a.verifyToken(token), null);
    assert.strictEqual(await cli.main(['pair', '12345'], { config: c, ...capture() }), 2);
    assert.strictEqual(await cli.main(['pair', '000000'], { config: c, ...capture() }), 1);
    assert.strictEqual(await cli.main(['revoke', '../../x'], { config: c, ...capture() }), 2);
  });
});

test('cli devices and revoke fall back to the state file only when the port is closed', async () => {
  const c = tmpConfig();
  const a = createAuth(c);
  const { code } = a.createPairing('x');
  const device = a.approvePairing(code);
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  c.port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const list = capture();
  assert.strictEqual(await cli.main(['devices', '--json'], { config: c, ...list }), 0);
  assert.strictEqual(JSON.parse(list.lines[0])[0].id, device.id);
  assert.strictEqual(await cli.main(['revoke', device.id], { config: c, ...capture() }), 0);
  assert.deepStrictEqual(createAuth(c).listDevices(), []);
});

test('cli refuses the offline fallback while something listens on the port without an admin token', async () => {
  const c = tmpConfig();
  const a = createAuth(c);
  const { code } = a.createPairing('x');
  const device = a.approvePairing(code);
  const server = http.createServer((q, s) => s.end());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  c.port = server.address().port;
  try {
    await assert.rejects(cli.main(['revoke', device.id], { config: c, ...capture() }), { code: 'NO_ADMIN_TOKEN' });
    assert.strictEqual(createAuth(c).listDevices().length, 1);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('serveEntry reads the proxy target and funnel state of the configured port only', () => {
  const c = { publicHost: HOST, publicPort: 39180, port: 39181 };
  const serve = {
    TCP: { 39180: { HTTP: true }, 443: { HTTPS: true } },
    Web: { [`${HOST}:39180`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:39181' } } }, [`${HOST}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } },
  };
  assert.deepStrictEqual(cli.serveEntry(serve, c), { proxy: 'http://127.0.0.1:39181', http: true, funnel: false });
  assert.strictEqual(cli.serveEntry({ ...serve, AllowFunnel: { [`${HOST}:443`]: true } }, c).funnel, true);
  assert.deepStrictEqual(cli.serveEntry({}, c), { proxy: null, http: false, funnel: false });
});

test('a token idle longer than tokenIdleDays is rejected and its device removed with an audit line', async () => {
  let now = Date.UTC(2030, 0, 1);
  const c = tmpConfig({ tokenIdleDays: 2 });
  const a = createAuth(c, { now: () => now });
  const revoked = [];
  a.on('revoked', (id) => revoked.push(id));
  const { code, waitToken } = a.createPairing('x');
  const device = a.approvePairing(code);
  const token = await a.awaitPairing(waitToken);
  now += 1.5 * 86400000;
  assert.ok(a.verifyToken(token), 'use within the idle window keeps it alive');
  now += 1.9 * 86400000;
  assert.ok(a.verifyToken(token), 'idle time counts from the last use');
  now += 2 * 86400000 + 1;
  assert.strictEqual(a.verifyToken(token), null);
  assert.deepStrictEqual(a.listDevices(), []);
  assert.deepStrictEqual(revoked, [device.id]);
  assert.deepStrictEqual(createAuth(c, { now: () => now }).listDevices(), []);
  const audit = fs.readFileSync(path.join(c.stateDir, 'audit.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(audit.at(-1), { ts: new Date(now).toISOString(), action: 'expire', device: device.id, idleDays: 2 });
});

test('idle devices are dropped from listings and the default idle limit is 30 days', () => {
  let now = Date.UTC(2030, 0, 1);
  const a = createAuth(tmpConfig(), { now: () => now });
  a.approvePairing(a.createPairing('x').code);
  now += 29 * 86400000;
  assert.strictEqual(a.listDevices().length, 1);
  now += 1 * 86400000 + 1;
  assert.strictEqual(a.listDevices().length, 0);
});

test('limits for unauthenticated sockets are exposed for the server', () => {
  assert.deepStrictEqual(limits, { maxUnauthed: 8, helloTimeoutMs: 30000 });
  assert.strictEqual(createAuth(tmpConfig()).limits, limits);
});

test('cli devices shows age and idle time', async () => {
  await withAdminServer(async ({ a, c }) => {
    a.approvePairing(a.createPairing('Phone').code);
    const io = capture();
    assert.strictEqual(await cli.main(['devices'], { config: c, ...io }), 0);
    assert.match(io.lines[0], /^dev-[0-9a-f]{12}  Phone  age \d+[smhd]  idle \d+[smhd]  expires in \d+d$/);
  });
});

test('cli status turns blocked folder access into a warning that names the node path', () => {
  const body = { folderAccess: { desktop: 'blocked', documents: 'ok', checkedAt: 'x' }, nodePath: '/opt/sample/node' };
  const w = cli.folderWarning(body);
  assert.match(w, /Full Disk Access › add \/opt\/sample\/node/);
  assert.match(w, /Desktop/);
  assert.strictEqual(cli.folderWarning({ folderAccess: { desktop: 'ok', documents: 'ok' } }), null);
  assert.strictEqual(cli.folderWarning({}), null);
});
