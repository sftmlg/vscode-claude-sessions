'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const REMOTE = path.join(__dirname, '..');
const SERVER = path.join(REMOTE, 'server.js');
const HOST = 'hub.example.test';
const LOGIN = 'owner@example.test';
const CANARY = `canary-${crypto.randomBytes(8).toString('hex')}`;
const XSS = ['<img src=x onerror=alert(1)>', '</script><script>alert(1)</script>', '\x1b]8;;javascript:alert(1)\x07click\x1b]8;;\x07', '\x1b]52;c;ZXZpbA==\x07'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpHome() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-sec-')));
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function tmuxBin() {
  return ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((p) => fs.existsSync(p)) || null;
}

function withHome(home, fn) {
  const prev = process.env.HOME;
  process.env.HOME = home;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.env.HOME = prev;
    });
}

test('tmux: names, keys and argv are validated before tmux sees them', { skip: !fs.existsSync(path.join(REMOTE, 'tmux.js')) && 'remote/tmux.js missing' }, async () => {
  const tmux = require('../tmux');
  const ctx = { socket: `sectest-${crypto.randomBytes(4).toString('hex')}`, bin: tmuxBin() || 'tmux' };
  for (const name of ['cc-a;kill-server', 'cc-a:0', '=cc-a', 'cc-A', 'cc-', 'x-a', `cc-${'a'.repeat(41)}`, 'cc-a\nkill-server', 'cc-a b']) {
    await assert.rejects(tmux.newSession(ctx, { name, dir: os.tmpdir(), argv: ['/usr/bin/true', 'x'] }), String(name));
    await assert.rejects(tmux.sendKey(ctx, name, 'Enter'), String(name));
    await assert.rejects(tmux.paste(ctx, name, 'b1', 'x'), String(name));
  }
  for (const key of ['kill-server', 'C-b', 'Enter;kill-server', '-X', 'M-x', '']) await assert.rejects(tmux.sendKey(ctx, 'cc-a', key), key);
  await assert.rejects(tmux.paste(ctx, 'cc-a', '../b', 'x'));
  await assert.rejects(tmux.newSession(ctx, { name: 'cc-a', dir: os.tmpdir(), argv: ['/bin/sh -c "touch x"'] }));
  assert.strictEqual(tmux.stripControls('a\x1b[201~\x03b\tc\nd\x9b'), 'a[201~b\tc\nd');
});

test('tmux: exact targets, no shell in argv, bracketed-paste breakout is inert', { skip: (!fs.existsSync(path.join(REMOTE, 'tmux.js')) && 'remote/tmux.js missing') || (!tmuxBin() && 'tmux not installed') }, async () => {
  const tmux = require('../tmux');
  const bin = tmuxBin();
  const ctx = { socket: `sectest-${crypto.randomBytes(4).toString('hex')}`, bin };
  const dir = tmpHome();
  const out = path.join(dir, 'pasted.txt');
  const pwn = path.join(dir, 'pwn');
  try {
    await tmux.newSession(ctx, { name: 'cc-ab', dir, argv: ['/bin/sh', '-c', 'cat > "$0"', out] });
    await tmux.newSession(ctx, { name: 'cc-shell', dir, argv: ['/usr/bin/touch', `$(touch ${pwn})`] });
    await sleep(300);
    assert.ok(!fs.existsSync(pwn), 'argv entries are not run through a shell');
    await assert.rejects(tmux.paste(ctx, 'cc-a', 'b1', 'wrong target'), 'prefix cc-a must not resolve to cc-ab');
    await assert.rejects(tmux.sendKey(ctx, 'cc-a', 'C-c'));
    await tmux.paste(ctx, 'cc-ab', 'b2', 'hello\x1b[201~\x03world');
    let text = '';
    for (let i = 0; i < 30 && !text.includes('world'); i++) {
      await sleep(100);
      text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
    }
    assert.strictEqual(text, 'hello[201~world\n');
    assert.ok(await tmux.hasSession(ctx, 'cc-ab'), 'C-c inside pasted text did not interrupt the session');
    assert.ok(!(await tmux.hasSession(ctx, 'cc-a')));
  } finally {
    try {
      execFileSync(bin, ['-L', ctx.socket, 'kill-server'], { stdio: 'ignore' });
    } catch {}
  }
});

test('transcript: ids and paths cannot leave the projects directories', { skip: !fs.existsSync(path.join(REMOTE, 'transcript.js')) && 'remote/transcript.js missing' }, async () => {
  const transcript = require('../transcript');
  const home = tmpHome();
  const projects = path.join(home, '.claude', 'projects', '-work');
  fs.mkdirSync(projects, { recursive: true });
  const outside = path.join(home, 'secret.jsonl');
  fs.writeFileSync(outside, `${JSON.stringify({ type: 'user', message: { content: CANARY } })}\n`);
  const linkedId = crypto.randomUUID();
  fs.symlinkSync(outside, path.join(projects, `${linkedId}.jsonl`));
  const realId = crypto.randomUUID();
  fs.writeFileSync(path.join(projects, `${realId}.jsonl`), `${JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: 'hi' } })}\n`);
  await withHome(home, async () => {
    for (const id of ['../secret', '..%2fsecret', '%2e%2e/secret', `../${realId}`, `${realId}/../../secret`, `${realId}\x00`, '', null, linkedId]) {
      assert.strictEqual(await transcript.resolveTranscript(id), null, String(id));
    }
    assert.ok(await transcript.resolveTranscript(realId));
    assert.strictEqual(await transcript.safeTranscriptPath(outside), null);
    assert.strictEqual(await transcript.safeTranscriptPath(path.join(projects, `${linkedId}.jsonl`)), null);
    assert.strictEqual(await transcript.safeTranscriptPath(path.join(projects, '..', '..', '..', 'secret.jsonl')), null);
    assert.strictEqual(await transcript.safeTranscriptPath(`${projects}/x/../../../../secret.jsonl`), null);
    assert.strictEqual(await transcript.resolveSubagent(realId, '../../secret'), null);
    assert.strictEqual(await transcript.resolveSubagent(realId, 'agent-../../x'), null);
  });
});

test('transcript: offsets are clamped and reads stay bounded', { skip: !fs.existsSync(path.join(REMOTE, 'transcript.js')) && 'remote/transcript.js missing' }, async () => {
  const transcript = require('../transcript');
  const dir = tmpHome();
  const file = path.join(dir, 'big.jsonl');
  const line = (text) => `${JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: text } })}\n`;
  fs.writeFileSync(file, line('a') + line('x'.repeat(3 * 1024 * 1024)) + line('b'));
  const size = fs.statSync(file).size;
  for (const opts of [{ from: -1 }, { from: -1e18 }, { from: 1e18 }, { from: Number.NaN }, { from: size + 10 }, { before: -5 }, { before: 1e18 }, { limit: -1 }, { limit: 1e9 }, { from: 1 }]) {
    const r = await transcript.readEvents(file, opts);
    assert.ok(r.from >= 0 && r.to <= size && r.from <= r.to, JSON.stringify(opts));
    assert.ok(r.to - r.from <= transcript.MAX_READ, `read window bounded for ${JSON.stringify(opts)}`);
    assert.ok(Buffer.byteLength(JSON.stringify(r.events)) < 1024 * 1024, `result bounded for ${JSON.stringify(opts)}`);
  }
});

let WebSocket = null;
try {
  WebSocket = require('ws');
} catch {}
const serverSkip = !fs.existsSync(SERVER) ? 'remote/server.js missing: server black-box tests skipped' : !WebSocket ? 'ws not installed' : false;

const ACT_AS_PROXY = { proxyProcesses: [path.basename(process.execPath)], proxyUids: [process.getuid()] };

async function startServer(extra = ACT_AS_PROXY) {
  const home = tmpHome();
  const port = await freePort();
  const stateDir = path.join(home, 'state');
  const configFile = path.join(home, 'config.json');
  const config = { port, publicPort: 39180, publicHost: HOST, allowedLogin: LOGIN, stateDir, tmuxSocket: `sectest-${crypto.randomBytes(4).toString('hex')}`, roots: [home], defaultDir: home, ...extra };
  fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  let output = '';
  const child = spawn(process.execPath, [SERVER], { env: { HOME: home, PATH: process.env.PATH, CLAUDE_REMOTE_CONFIG: configFile }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (c) => (output += c));
  child.stderr.on('data', (c) => (output += c));
  for (let i = 0; i < 50; i++) {
    const up = await new Promise((r) => {
      const s = net.connect(port, '127.0.0.1', () => s.end(() => r(true))).on('error', () => r(false));
    });
    if (up) break;
    await sleep(100);
  }
  const stop = async () => {
    child.kill('SIGTERM');
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    try {
      execFileSync(tmuxBin() || 'tmux', ['-L', config.tmuxSocket, 'kill-server'], { stdio: 'ignore' });
    } catch {}
  };
  return { home, port, config, stop, output: () => output };
}

function get(port, { path: p = '/', headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

const ident = { host: `${HOST}:39180`, 'tailscale-user-login': LOGIN };
const wsHeaders = { ...ident, origin: `http://${HOST}:39180` };

function connect(port, headers = wsHeaders) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers, maxPayload: 64 * 1024 * 1024 });
    const messages = [];
    ws.on('message', (data, isBinary) => {
      if (!isBinary) messages.push(JSON.parse(String(data)));
    });
    ws.once('open', () => resolve({ ws, messages, rejected: null }));
    ws.once('unexpected-response', (_req, res) => resolve({ ws: null, messages, rejected: res.statusCode }));
    ws.once('error', () => resolve({ ws: null, messages, rejected: 'error' }));
  });
}

async function until(fn, ms = 3000) {
  for (let t = 0; t < ms; t += 50) {
    const v = fn();
    if (v) return v;
    await sleep(50);
  }
  return fn();
}

function adminApprove(s, code) {
  const token = fs.readFileSync(path.join(s.config.stateDir, 'admin.token'), 'utf8').trim();
  const body = JSON.stringify({ code });
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: s.port, method: 'POST', path: '/admin/approve', headers: { host: `127.0.0.1:${s.port}`, authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    r.on('error', reject);
    r.end(body);
  });
}

async function pairDevice(s) {
  const c = await connect(s.port);
  c.ws.send(JSON.stringify({ t: 'pair', deviceName: 'test device' }));
  const codeMsg = await until(() => c.messages.find((m) => m.t === 'pairCode'));
  assert.ok(codeMsg, 'pairCode received');
  assert.strictEqual(await adminApprove(s, codeMsg.code), 200);
  const paired = await until(() => c.messages.find((m) => m.t === 'paired'));
  assert.ok(paired && paired.token, 'paired with token');
  c.ws.close();
  return paired;
}

test('server: HTTP needs the exact identity and host, HTML carries a strict CSP and reflects nothing', { skip: serverSkip }, async () => {
  const s = await startServer();
  try {
    assert.strictEqual((await get(s.port, { headers: { host: ident.host } })).status, 403);
    assert.strictEqual((await get(s.port, { headers: { ...ident, 'tailscale-user-login': 'other@example.test' } })).status, 403);
    assert.strictEqual((await get(s.port, { headers: { ...ident, host: 'evil.example' } })).status, 403);
    assert.strictEqual((await get(s.port, { headers: { ...ident, host: `127.0.0.1:${s.port}` } })).status, 403);
    assert.notStrictEqual((await get(s.port, { headers: ident, method: 'POST' })).status, 200);
    const home = await get(s.port, { headers: ident });
    assert.strictEqual(home.status, 200);
    assert.match(String(home.headers['content-type']), /text\/html/);
    const csp = String(home.headers['content-security-policy'] || '');
    assert.ok(csp, 'CSP header on HTML');
    assert.match(csp, /default-src[^;]*'self'|script-src[^;]*'self'/);
    assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp) && !/'unsafe-eval'/.test(csp), csp);
    for (const x of XSS) {
      const r = await get(s.port, { path: `/${encodeURIComponent(x)}?q=${encodeURIComponent(x)}`, headers: ident });
      assert.ok(!r.body.includes('<img src=x') && !r.body.includes('alert(1)'), 'request content never reflected');
    }
    const traversal = await get(s.port, { path: '/..%2f..%2fpackage.json', headers: ident });
    assert.ok(!traversal.body.includes('"dependencies"'), 'static files cannot leave web/');
  } finally {
    await s.stop();
  }
});

test('server: WebSocket upgrade checks identity, host and Origin', { skip: serverSkip }, async () => {
  const s = await startServer();
  try {
    assert.ok((await connect(s.port, wsHeaders)).ws);
    assert.ok((await connect(s.port, { ...wsHeaders, origin: 'vscode-webview://abc123' })).ws);
    for (const headers of [
      { host: ident.host, origin: wsHeaders.origin },
      { ...wsHeaders, 'tailscale-user-login': 'other@example.test' },
      { ...wsHeaders, origin: 'http://evil.example' },
      { ...wsHeaders, origin: 'null' },
      { ...wsHeaders, host: 'evil.example' },
    ]) {
      const c = await connect(s.port, headers);
      assert.ok(!c.ws, JSON.stringify(headers));
    }
  } finally {
    await s.stop();
  }
});

test('server: before helloOk only hello, pair and ping are answered', { skip: serverSkip }, async () => {
  const s = await startServer();
  try {
    const c = await connect(s.port);
    for (const m of [{ t: 'list' }, { t: 'devices' }, { t: 'sub', sessionId: 'x', cols: 80, rows: 24 }, { t: 'send', id: 'm1', sessionId: 'x', text: 'hi' }, { t: 'approvePair', code: '000000' }, { t: 'new', id: 'n1', name: 'cc-x', dir: '/' }, { t: 'events', sessionId: crypto.randomUUID(), limit: 10 }]) {
      if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(m));
    }
    c.ws.readyState === WebSocket.OPEN && c.ws.send(JSON.stringify({ t: 'hello', token: 'A'.repeat(43), clientId: 'c1' }));
    await sleep(500);
    const types = c.messages.map((m) => m.t);
    for (const forbidden of ['sessions', 'devices', 'snapshot', 'events', 'ack', 'helloOk', 'takeoverInfo']) assert.ok(!types.includes(forbidden), `${forbidden} before auth: ${types}`);
    const p = await connect(s.port);
    p.ws.send(JSON.stringify({ t: 'ping', t0: 1 }));
    assert.ok(await until(() => p.messages.find((m) => m.t === 'pong')));
  } finally {
    await s.stop();
  }
});

test('server: a paired token authenticates and a revoked one closes the socket within 5 s', { skip: serverSkip }, async () => {
  const s = await startServer();
  try {
    const { token, device } = await pairDevice(s);
    const c = await connect(s.port);
    c.ws.send(JSON.stringify({ t: 'hello', token, clientId: 'c1' }));
    assert.ok(await until(() => c.messages.find((m) => m.t === 'helloOk')));
    const closed = new Promise((r) => c.ws.once('close', r));
    execFileSync(process.execPath, [path.join(REMOTE, 'cli.js'), 'revoke', device.id], { env: { HOME: s.home, PATH: process.env.PATH, CLAUDE_REMOTE_CONFIG: path.join(s.home, 'config.json') } });
    const started = Date.now();
    await Promise.race([closed, sleep(5000)]);
    assert.strictEqual(c.ws.readyState, WebSocket.CLOSED, 'socket closed after revoke');
    assert.ok(Date.now() - started <= 5000);
    const again = await connect(s.port);
    again.ws.send(JSON.stringify({ t: 'hello', token, clientId: 'c2' }));
    await sleep(500);
    assert.ok(!again.messages.some((m) => m.t === 'helloOk'));
  } finally {
    await s.stop();
  }
});

test('server: a 2 MB frame is rejected and the canary never reaches logs', { skip: serverSkip }, async () => {
  const s = await startServer();
  try {
    const big = await connect(s.port);
    const closed = new Promise((r) => big.ws.once('close', (code) => r(code)));
    big.ws.send(JSON.stringify({ t: 'ping', pad: 'x'.repeat(2 * 1024 * 1024) }));
    const code = await Promise.race([closed, sleep(3000).then(() => 'open')]);
    assert.notStrictEqual(code, 'open', 'oversized frame closes the socket');

    const { token } = await pairDevice(s);
    const c = await connect(s.port);
    c.ws.send(JSON.stringify({ t: 'hello', token: `${CANARY}${'A'.repeat(43 - CANARY.length)}`, clientId: CANARY }));
    c.ws.send(JSON.stringify({ t: 'hello', token, clientId: 'c1' }));
    await until(() => c.messages.find((m) => m.t === 'helloOk'));
    c.ws.send(JSON.stringify({ t: 'send', id: 'm-canary', sessionId: crypto.randomUUID(), text: `${CANARY} ${XSS.join(' ')}` }));
    c.ws.send(JSON.stringify({ t: 'new', id: 'n-canary', name: 'cc-canary', dir: `/nonexistent/${CANARY}` }));
    await sleep(800);
    const logs = [s.output()];
    for (const f of fs.readdirSync(s.config.stateDir)) {
      if (/\.log$/.test(f)) logs.push(fs.readFileSync(path.join(s.config.stateDir, f), 'utf8'));
    }
    const all = logs.join('\n');
    assert.ok(!all.includes(CANARY), 'canary absent from logs');
    assert.ok(!all.includes(token), 'device token absent from logs');
    for (const m of c.messages) assert.ok(!JSON.stringify(m).includes('<img src=x'), 'server does not echo content as markup');
  } finally {
    await s.stop();
  }
});

test('server: state files are private', { skip: serverSkip }, async () => {
  const s = await startServer();
  try {
    await pairDevice(s);
    assert.strictEqual(fs.statSync(s.config.stateDir).mode & 0o777, 0o700);
    for (const f of fs.readdirSync(s.config.stateDir)) {
      const st = fs.statSync(path.join(s.config.stateDir, f));
      if (st.isFile()) assert.strictEqual(st.mode & 0o077, 0, `${f} is not readable by others`);
    }
    const lsof = execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${s.port}`, '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' });
    const addrs = lsof.split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1));
    assert.deepStrictEqual(addrs, [`127.0.0.1:${s.port}`]);
  } finally {
    await s.stop();
  }
});

test('server: a loopback client that is not the tailscale proxy is refused even with forged identity headers', { skip: serverSkip }, async () => {
  const s = await startServer({});
  try {
    const r = await get(s.port, { headers: ident });
    assert.strictEqual(r.status, 403);
    const c = await connect(s.port);
    assert.ok(!c.ws, 'WebSocket upgrade refused');
    await until(() => /peer-not-proxy/.test(s.output()));
    assert.match(s.output(), /denied reason=peer-not-proxy/);
    const token = fs.readFileSync(path.join(s.config.stateDir, 'admin.token'), 'utf8').trim();
    const admin = await get(s.port, { path: '/admin/status', headers: { host: `127.0.0.1:${s.port}`, authorization: `Bearer ${token}` } });
    assert.strictEqual(admin.status, 200, 'the local admin channel stays available to the CLI');
  } finally {
    await s.stop();
  }
});

async function autoPair(s, name = 'auto device') {
  const c = await connect(s.port);
  c.ws.send(JSON.stringify({ t: 'pair', deviceName: name }));
  await until(() => c.messages.find((m) => m.t === 'pairCode'));
  const paired = await until(() => c.messages.find((m) => m.t === 'paired'), 1500);
  return { c, paired };
}

test('server: auto-approved pairing is announced to the other devices and stops at maxDevices', { skip: serverSkip }, async () => {
  const s = await startServer({ ...ACT_AS_PROXY, autoApprovePairing: true, maxDevices: 2 });
  try {
    const first = await autoPair(s, 'first');
    assert.ok(first.paired, 'first device pairs without a click');
    const watcher = await connect(s.port);
    watcher.ws.send(JSON.stringify({ t: 'hello', token: first.paired.token, clientId: 'w' }));
    assert.ok(await until(() => watcher.messages.find((m) => m.t === 'helloOk')));
    const second = await autoPair(s, 'second');
    assert.ok(second.paired, 'second device pairs without a click');
    const added = await until(() => watcher.messages.find((m) => m.t === 'deviceAdded'));
    assert.ok(added, 'paired devices learn about the new one');
    assert.strictEqual(added.device.id, second.paired.device.id);
    assert.ok('node' in added);
    assert.ok(!second.c.messages.some((m) => m.t === 'deviceAdded'), 'the new device itself is not told');
    const third = await autoPair(s, 'third');
    assert.ok(!third.paired, 'beyond maxDevices a pairing needs an approval');
    const audit = fs.readFileSync(path.join(s.config.stateDir, 'audit.log'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(audit.some((l) => l.action === 'auto-refused' && l.reason === 'max-devices'));
    assert.ok(audit.filter((l) => l.action === 'pair').every((l) => l.src && l.src.via === 'serve'), 'pairings record that they came through serve');
  } finally {
    await s.stop();
  }
});

test('server: revoking a device drops its push subscription and its unread markers', { skip: serverSkip }, async () => {
  const s = await startServer();
  try {
    const { token, device } = await pairDevice(s);
    const c = await connect(s.port);
    c.ws.send(JSON.stringify({ t: 'hello', token, clientId: 'c1' }));
    await until(() => c.messages.find((m) => m.t === 'helloOk'));
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/sectest', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
    c.ws.send(JSON.stringify({ t: 'pushSubscribe', subscription }));
    const subsFile = path.join(s.config.stateDir, 'push-subscriptions.json');
    assert.ok(await until(() => fs.existsSync(subsFile) && fs.readFileSync(subsFile, 'utf8').includes(device.id)));
    const seenDir = path.join(s.config.stateDir, 'seen');
    fs.mkdirSync(seenDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(seenDir, `${device.id}.json`), '{}', { mode: 0o600 });
    execFileSync(process.execPath, [path.join(REMOTE, 'cli.js'), 'revoke', device.id], { env: { HOME: s.home, PATH: process.env.PATH, CLAUDE_REMOTE_CONFIG: path.join(s.home, 'config.json') } });
    assert.ok(await until(() => !fs.readFileSync(subsFile, 'utf8').includes(device.id)), 'push subscription removed');
    await sleep(2500);
    assert.ok(!fs.existsSync(path.join(seenDir, `${device.id}.json`)), 'unread markers removed and not written back');
  } finally {
    await s.stop();
  }
});

test('server: search is rate limited per device', { skip: serverSkip }, async () => {
  const s = await startServer();
  try {
    const { token } = await pairDevice(s);
    const c = await connect(s.port);
    c.ws.send(JSON.stringify({ t: 'hello', token, clientId: 'c1' }));
    await until(() => c.messages.find((m) => m.t === 'helloOk'));
    for (let i = 0; i < 12; i++) c.ws.send(JSON.stringify({ t: 'search', id: `s${i}`, query: 'x' }));
    await until(() => c.messages.filter((m) => m.t === 'searchResults' || (m.t === 'error' && m.ref === 'search')).length >= 12, 5000);
    const limited = c.messages.filter((m) => m.t === 'error' && m.ref === 'search' && m.code === 'rate-limited');
    const answered = c.messages.filter((m) => m.t === 'searchResults');
    assert.ok(limited.length >= 6, `limited ${limited.length}`);
    assert.ok(answered.length >= 1 && answered.length <= 6, `answered ${answered.length}`);
  } finally {
    await s.stop();
  }
});

test('catalog: sessions whose real working directory is outside the roots are not listed', { skip: !fs.existsSync(path.join(REMOTE, 'catalog.js')) && 'remote/catalog.js missing' }, async () => {
  const base = tmpHome();
  const root = path.join(base, 'work');
  const sibling = path.join(base, 'work-shop');
  fs.mkdirSync(root);
  fs.mkdirSync(sibling);
  const projects = path.join(base, '.claude', 'projects');
  const write = (cwd) => {
    const dir = path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const id = crypto.randomUUID();
    const ts = new Date().toISOString();
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${JSON.stringify({ type: 'user', sessionId: id, cwd, timestamp: ts, uuid: crypto.randomUUID(), message: { role: 'user', content: 'hello there' } })}\n`);
    return id;
  };
  const inside = write(root);
  const outside = write(sibling);
  await withHome(base, async () => {
    const { Catalog } = require('../catalog');
    const ids = (await new Catalog({ roots: [root] }).list()).map((m) => m.id);
    assert.ok(ids.includes(inside), 'session in the root is listed');
    assert.ok(!ids.includes(outside), 'a sibling folder sharing the encoded prefix is not');
  });
});
