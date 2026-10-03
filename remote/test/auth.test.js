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
  assert.deepStrictEqual(Object.keys(device).sort(), ['createdAt', 'id', 'lastSeen', 'name', 'node']);
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
  assert.deepStrictEqual(cli.serveEntry(serve, c), { proxy: 'http://127.0.0.1:39181', http: true, https: false, funnel: false });
  assert.deepStrictEqual(cli.serveEntry({ ...serve, TCP: { 39180: { HTTPS: true } } }, c), { proxy: 'http://127.0.0.1:39181', http: false, https: true, funnel: false });
  assert.strictEqual(cli.serveEntry({ ...serve, AllowFunnel: { [`${HOST}:443`]: true } }, c).funnel, true);
  assert.deepStrictEqual(cli.serveEntry({}, c), { proxy: null, http: false, https: false, funnel: false });
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

test('https mode accepts the own https origin and every peer hub origin, nothing else', () => {
  const c = tmpConfig({
    publicScheme: 'https',
    peers: [
      { name: 'Laptop', url: 'wss://laptop.example.test:39180/ws' },
      { name: 'Default port', url: 'wss://other.example.test/ws' },
      { name: 'Bad scheme', url: 'https://web.example.test:39180/' },
      { name: 'Broken', url: 'not a url' },
    ],
  });
  const at = (origin) => checkRequest(req({ ...ws, origin }), c);
  for (const origin of [`https://${HOST}:39180`, 'https://laptop.example.test:39180', 'https://other.example.test', 'vscode-webview://1a2b3c']) {
    assert.strictEqual(at(origin).ok, true, origin);
  }
  for (const origin of [`http://${HOST}:39180`, `https://${HOST}`, 'http://laptop.example.test:39180', 'https://laptop.example.test', 'https://laptop.example.test:39181', 'https://web.example.test:39180', 'https://evil.example', 'null', undefined]) {
    assert.strictEqual(at(origin).reason, 'bad-origin', String(origin));
  }
  assert.strictEqual(checkRequest(req({ ...ws, host: HOST, origin: `https://${HOST}` }), { ...c, publicPort: 443 }).ok, true);
  assert.strictEqual(checkRequest(req({ ...ws, origin: `https://${HOST}:39180`, 'tailscale-user-login': 'other@example.test' }), c).reason, 'wrong-identity');
  assert.strictEqual(checkRequest(req({ ...ws, origin: `https://${HOST}:39180`, host: 'laptop.example.test:39180' }), c).reason, 'bad-host');
});

test('http mode keeps the http origin and ignores peers with another scheme', () => {
  const c = tmpConfig({ peers: [{ name: 'Laptop', url: 'ws://laptop.example.test:39180/ws' }] });
  assert.strictEqual(checkRequest(req(ws), c).ok, true);
  assert.strictEqual(checkRequest(req({ ...ws, origin: 'http://laptop.example.test:39180' }), c).ok, true);
  assert.strictEqual(checkRequest(req({ ...ws, origin: `https://${HOST}:39180` }), c).reason, 'bad-origin');
  assert.strictEqual(checkRequest(req(ws), { ...c, peers: 'nonsense' }).ok, true);
});

test('publicReachable fetches the app over the configured scheme and requires 200', async () => {
  const ok = http.createServer((q, s) => s.end('app'));
  const deny = http.createServer((q, s) => {
    s.statusCode = 403;
    s.end();
  });
  await Promise.all([ok, deny].map((srv) => new Promise((r) => srv.listen(0, '127.0.0.1', r))));
  try {
    const base = { publicScheme: 'http', publicHost: '127.0.0.1' };
    assert.deepStrictEqual(await cli.publicReachable({ ...base, publicPort: ok.address().port }), { ok: true, detail: 200 });
    assert.deepStrictEqual(await cli.publicReachable({ ...base, publicPort: deny.address().port }), { ok: false, detail: 403 });
    const tls = await cli.publicReachable({ ...base, publicScheme: 'https', publicPort: ok.address().port });
    assert.strictEqual(tls.ok, false, 'https against a plain listener fails');
  } finally {
    await Promise.all([ok, deny].map((srv) => new Promise((r) => srv.close(r))));
  }
});

const { parseNetstatPeer, createPeerCheck, DEFAULT_PROXY_PROCESSES } = require('../auth');
const NETSTAT = fs.readFileSync(path.join(__dirname, 'fixtures', 'sec-netstat.txt'), 'utf8');
const EXT = '/Library/SystemExtensions/0000/io.tailscale.ipn.macsys.network-extension.systemextension/Contents/MacOS/io.tailscale.ipn.macsys.network-extension';

test('parseNetstatPeer finds the pid owning the client end of a loopback connection', () => {
  assert.strictEqual(parseNetstatPeer(NETSTAT, 39181, 58525), 4242);
  assert.strictEqual(parseNetstatPeer(NETSTAT, 39181, 60001), 7777);
  assert.strictEqual(parseNetstatPeer(NETSTAT, 39181, 12345), null);
  assert.strictEqual(parseNetstatPeer('', 39181, 58525), null);
});

function fakeRun({ netstat = NETSTAT, ps = { 4242: `    0 ${EXT}`, 7777: '  501 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }, fail = false } = {}) {
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args].join(' '));
    if (fail) throw new Error('boom');
    if (file.endsWith('netstat')) return netstat;
    if (file.endsWith('ps')) return ps[args[args.length - 1]] || '';
    throw new Error(`unexpected ${file}`);
  };
  return { run, calls };
}
const sock = (remotePort, extra = {}) => ({ remoteAddress: '127.0.0.1', remotePort, localPort: 39181, ...extra });

test('peer check accepts only a root-owned tailscale proxy process and fails closed otherwise', async () => {
  assert.deepStrictEqual(DEFAULT_PROXY_PROCESSES, ['io.tailscale.ipn.macsys.network-extension', 'tailscaled']);
  const f = fakeRun();
  const check = createPeerCheck({}, { run: f.run });
  const ok = await check.verify(sock(58525));
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.pid, 4242);
  assert.strictEqual((await check.verify(sock(60001))).reason, 'peer-not-proxy');
  assert.strictEqual((await check.verify(sock(12345))).reason, 'peer-unknown');
  assert.strictEqual((await check.verify(sock(58525, { remoteAddress: '100.64.0.9' }))).reason, 'not-loopback');
  assert.strictEqual((await createPeerCheck({}, { run: fakeRun({ fail: true }).run }).verify(sock(58525))).reason, 'peer-unknown');
  const sameName = fakeRun({ ps: { 4242: `  501 /tmp/x/io.tailscale.ipn.macsys.network-extension` } });
  assert.strictEqual((await createPeerCheck({}, { run: sameName.run }).verify(sock(58525))).reason, 'peer-not-proxy', 'a same-name binary of the user is not the proxy');
  const rootOther = fakeRun({ ps: { 4242: '    0 /usr/sbin/sshd' } });
  assert.strictEqual((await createPeerCheck({}, { run: rootOther.run }).verify(sock(58525))).reason, 'peer-not-proxy');
});

test('peer check runs netstat once per socket and ps once per pid', async () => {
  const f = fakeRun();
  const check = createPeerCheck({}, { run: f.run });
  const s1 = sock(58525);
  await check.verify(s1);
  await check.verify(s1);
  await check.verify(sock(58525));
  assert.strictEqual(f.calls.filter((c) => c.includes('netstat')).length, 2);
  assert.strictEqual(f.calls.filter((c) => c.includes(' ps') || c.startsWith('/bin/ps')).length, 1);
});

test('peer check honours configured proxy processes and uids', async () => {
  const f = fakeRun({ ps: { 4242: '  501 /opt/homebrew/bin/node' } });
  const check = createPeerCheck({ proxyProcesses: ['node'], proxyUids: [501] }, { run: f.run });
  assert.strictEqual((await check.verify(sock(58525))).ok, true);
});

test('peer check on a real loopback connection identifies this test process as no proxy', { skip: process.platform !== 'darwin' && 'macOS only' }, async () => {
  const server = http.createServer((q, s) => s.end());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const check = createPeerCheck({});
  try {
    const verdict = await new Promise((resolve, reject) => {
      server.once('request', (q, s) => {
        check.verify(q.socket).then(resolve, reject);
        s.end();
      });
      http.get(`http://127.0.0.1:${server.address().port}/`, (res) => res.resume()).on('error', reject);
    });
    assert.strictEqual(verdict.ok, false);
    assert.strictEqual(verdict.reason, 'peer-not-proxy');
    assert.strictEqual(verdict.pid, process.pid);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

const SERVE_SRC = { via: 'serve', ip: '100.64.0.2', node: { name: 'laptop', os: 'macOS' } };

test('pairing records its source in the device and in the audit log', () => {
  const c = tmpConfig();
  const a = createAuth(c);
  const { code } = a.createPairing('Phone', { source: { ...SERVE_SRC, node: { name: 'lap\x1btop', os: 'macOS', extra: 'x' } } });
  const device = a.approvePairing(code);
  assert.deepStrictEqual(device.node, { name: 'laptop', os: 'macOS' });
  assert.deepStrictEqual(createAuth(c).listDevices()[0].node, { name: 'laptop', os: 'macOS' });
  const audit = fs.readFileSync(path.join(c.stateDir, 'audit.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(audit[0].src, { via: 'serve', ip: '100.64.0.2', node: 'laptop', os: 'macOS' });
  assert.deepStrictEqual(audit[1].src, { via: 'serve', ip: '100.64.0.2', node: 'laptop', os: 'macOS' });
  const { code: c2 } = a.createPairing('x', { source: { via: 'evil', ip: 'not an ip; rm', node: null } });
  const d2 = a.approvePairing(c2);
  assert.strictEqual(d2.node, null);
  const last = fs.readFileSync(path.join(c.stateDir, 'audit.log'), 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  assert.deepStrictEqual(last.src, { via: 'unknown', ip: null, node: null, os: null });
});

test('autoApprove needs a serve source and stays under maxDevices, then falls back to manual approval', () => {
  const c = tmpConfig({ maxDevices: 2 });
  const a = createAuth(c);
  const added = [];
  a.on('added', (d) => added.push(d.id));
  assert.strictEqual(a.autoApprove(a.createPairing('a', { source: SERVE_SRC }).code).name, 'a');
  const loop = a.createPairing('b', { source: { via: 'loopback' } });
  assert.throws(() => a.autoApprove(loop.code), { code: 'needs-approval' });
  assert.strictEqual(a.approvePairing(loop.code).name, 'b');
  const third = a.createPairing('c', { source: SERVE_SRC });
  assert.throws(() => a.autoApprove(third.code), { code: 'needs-approval' });
  assert.strictEqual(a.approvePairing(third.code).name, 'c', 'a person can still approve beyond the cap');
  assert.strictEqual(added.length, 3);
  const audit = fs.readFileSync(path.join(c.stateDir, 'audit.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(audit.filter((l) => l.action === 'auto-refused').map((l) => l.reason), ['not-serve', 'max-devices']);
  assert.ok(audit.filter((l) => l.action === 'approve').some((l) => l.by === 'auto'));
  assert.strictEqual(createAuth(tmpConfig()).maxDevices, 12);
});
