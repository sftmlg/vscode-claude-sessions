'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');
const { tempHome, testCtx, killServer, capture, waitFor, FAKE_CLAUDE } = require('./fixtures/fs-helpers');

const home = tempHome('remote-server-');
process.env.HOME = home;
delete process.env.CLAUDE_CONFIG_DIR;
const WebSocket = require('ws');
const { start, csp, staticPath, rotateLogs, probeFolder, checkFolderAccess } = require('../server');
const { Registry } = require('../registry');
const { createAuth } = require('../auth');
const { parseFrame } = require('../mirror');
const { listSessions } = require('../tmux');

const HOST = 'hub.example.test';
const LOGIN = 'owner@example.test';
const work = path.join(home, 'work');
const SID = '0a0b0c0d-1111-4222-8333-444455556666';
const projectDir = path.join(home, '.claude', 'projects', '-work');
const sessionsDir = path.join(home, '.claude', 'sessions');
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(projectDir, { recursive: true });
fs.mkdirSync(sessionsDir, { recursive: true });
const transcriptFile = path.join(projectDir, `${SID}.jsonl`);
const line = (text) => `${JSON.stringify({ type: 'user', uuid: `u-${text}`, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: text } })}\n`;
fs.writeFileSync(transcriptFile, line('first synthetic prompt'));

const ident = { host: `${HOST}:39180`, 'tailscale-user-login': LOGIN };

function get(port, p, headers = ident) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      })
      .on('error', reject);
  });
}

function client(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { ...ident, origin: `http://${HOST}:39180`, 'x-forwarded-for': '100.64.0.9' } });
    const c = { ws, json: [], frames: [] };
    c.send = (m) => ws.send(JSON.stringify(m));
    c.find = (pred) => c.json.find(pred);
    c.wait = (pred, what) => waitFor(() => c.json.find(pred), { what, timeout: 6000 });
    c.text = (name) => c.frames.filter((f) => f.sessionId === name).map((f) => f.bytes.toString('utf8')).join('');
    ws.on('message', (data, binary) => (binary ? c.frames.push(parseFrame(Buffer.from(data))) : c.json.push(JSON.parse(String(data)))));
    ws.once('open', () => resolve(c));
    ws.once('error', reject);
  });
}

test('log rotation copies a large log aside, truncates it in place and keeps three', () => {
  const dir = tempHome('remote-logs-');
  const file = path.join(dir, 'server.out.log');
  for (let round = 1; round <= 4; round++) {
    fs.writeFileSync(file, `round ${round} `.repeat(200));
    rotateLogs(dir, ['server.out.log', 'missing.log'], { maxBytes: 1000, keep: 3 });
    assert.strictEqual(fs.statSync(file).size, 0);
  }
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['server.out.log', 'server.out.log.1', 'server.out.log.2', 'server.out.log.3']);
  assert.match(fs.readFileSync(`${file}.1`, 'utf8'), /^round 4/);
  assert.match(fs.readFileSync(`${file}.3`, 'utf8'), /^round 2/);
  assert.strictEqual(fs.statSync(`${file}.1`).mode & 0o077, 0);
  fs.writeFileSync(file, 'small');
  rotateLogs(dir, ['server.out.log'], { maxBytes: 1000, keep: 3 });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'small');
});

test('folder probe: a listing that hangs or is denied counts as blocked, a readable one as ok', async () => {
  const dir = tempHome('remote-probe-');
  assert.strictEqual(await probeFolder(dir), 'ok');
  assert.strictEqual(await probeFolder(dir, { cmd: '/bin/sleep', args: ['5'], timeoutMs: 200 }), 'blocked');
  assert.strictEqual(await probeFolder(dir, { cmd: '/bin/sh', args: ['-c', 'echo "ls: x: Operation not permitted" >&2; exit 1'] }), 'blocked');
  const access = await checkFolderAccess(async (d) => (d.endsWith('Desktop') ? 'blocked' : 'ok'), '/home/sample');
  assert.strictEqual(access.desktop, 'blocked');
  assert.strictEqual(access.documents, 'ok');
  assert.ok(Date.parse(access.checkedAt));
});

test('a notification payload, after encryption, still links to the session', async () => {
  const { createPush } = require('../push');
  const { notificationFor } = require('../server');
  const { pushClient } = require('./fixtures/fs-helpers');
  const sent = [];
  const push = createPush({ stateDir: path.join(tempHome('remote-push-'), 'state') }, { send: async (endpoint, headers, body) => (sent.push(body), 201) });
  const device = pushClient();
  push.subscribe('dev-aaaaaaaaaaaa', device.subscription);
  await push.notify(notificationFor({ sessionId: 'cc-a b', status: 'waiting' }, { project: 'shop' }));
  const payload = device.decrypt(sent[0]);
  assert.strictEqual(payload.url, '/#session=cc-a%20b');
  assert.strictEqual(payload.title, 'A session in shop needs you');
  assert.strictEqual(payload.tag, 'cc-a b');
});

test('static paths stay inside web/ and only serve known types', () => {
  assert.ok(staticPath('/').endsWith(path.join('web', 'index.html')));
  assert.ok(staticPath('/vendor/xterm.mjs?x=1').endsWith(path.join('web', 'vendor', 'xterm.mjs')));
  for (const bad of ['/../server.js', '/..%2fserver.js', '/vendor/VERSIONS', '/vendor/xterm.LICENSE', '/%00.html', '/%E0%A4%A.html']) assert.strictEqual(staticPath(bad), null, bad);
  assert.strictEqual(csp({ publicHost: HOST, publicPort: 39180 }), `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://${HOST}:39180; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
  assert.match(csp({ publicHost: HOST, publicPort: 443, publicScheme: 'https', peers: [{ name: 'Studio', url: 'wss://studio.example.test/ws' }, { name: 'Old', url: 'ws://old.example.test:39180/ws' }] }), /connect-src 'self' wss:\/\/hub\.example\.test wss:\/\/studio\.example\.test ws:\/\/old\.example\.test:39180;/);
});

test('hub end to end on a throwaway tmux socket', async (t) => {
  const ctx = testCtx();
  const stateDir = path.join(home, 'state');
  const config = { peers: [{ name: 'Studio', url: 'ws://studio.example.test:39180/ws' }], port: 0, publicPort: 39180, publicHost: HOST, allowedLogin: LOGIN, tmuxSocket: ctx.socket, tmuxPath: ctx.bin, childPath: ctx.childPath, stateDir, roots: [work], defaultDir: work, launcher: [], claudeCommand: ['/bin/sh', FAKE_CLAUDE], claudeArgs: [] };
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const auth = createAuth(config, { log: () => {} });
  const logs = [];
  const registry = new Registry(config, { ctx, pollMs: 150 });
  let folderState = 'blocked';
  const pushed = [];
  const subscribed = new Map();
  const push = {
    publicKey: () => 'BPUBLICKEY',
    devices: () => [...subscribed.keys()],
    subscribe: (id, sub) => (subscribed.set(id, sub), true),
    unsubscribe: (id) => subscribed.delete(id),
    notify: async (n) => (pushed.push(n), { sent: 1 }),
  };
  const hub = await start(config, { peerCheck: { verify: async () => ({ ok: true, reason: null }) }, auth, registry, log: (m) => logs.push(m), helloTimeoutMs: 400, push, probeFolder: async () => folderState, tailnet: { viewerHost: async (ip) => (ip === '100.64.0.9' ? 'laptop.example.test' : null), selfName: async () => 'studio' } });
  t.after(async () => {
    await hub.close();
    killServer(ctx);
  });
  const port = hub.port;

  await t.test('HTTP serves the app with strict headers', async () => {
    const r = await get(port, '/');
    assert.strictEqual(r.status, 200);
    assert.match(r.headers['content-type'], /text\/html/);
    assert.strictEqual(r.headers['content-security-policy'], csp(config));
    assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
    assert.ok(!/<script>|style=/.test(r.body), 'no inline script or style in the shell');
    const js = await get(port, '/vendor/xterm.mjs');
    assert.match(js.headers['content-type'], /text\/javascript/);
    const denied = await get(port, '/', { host: ident.host });
    assert.strictEqual(denied.status, 403);
    assert.strictEqual(denied.headers['cache-control'], 'no-store');
    assert.strictEqual((await get(port, '/ws')).status, 404);
  });

  const c = await client(port);
  t.after(() => c.ws.close());
  let token;

  await t.test('pairing: pairRequired, code, approval, token, helloOk', async () => {
    c.send({ t: 'hello', clientId: 'c1' });
    await c.wait((m) => m.t === 'pairRequired', 'pairRequired');
    c.send({ t: 'list' });
    c.send({ t: 'pair', deviceName: 'test phone' });
    const code = await c.wait((m) => m.t === 'pairCode', 'pairCode');
    auth.approvePairing(code.code);
    const paired = await c.wait((m) => m.t === 'paired', 'paired');
    token = paired.token;
    assert.strictEqual(paired.device.name, 'test phone');
    const ok = await c.wait((m) => m.t === 'helloOk', 'helloOk');
    assert.strictEqual(ok.defaultDir, work);
    assert.deepStrictEqual(ok.peers, [{ name: 'Studio', url: 'ws://studio.example.test:39180/ws' }]);
    assert.strictEqual(ok.hostName, 'studio', 'the hub names itself by its tailnet host name');
    assert.strictEqual(ok.viewerHost, 'laptop.example.test', 'the viewer machine comes from the forwarded tailnet address');
    assert.strictEqual(ok.publicHost, HOST);
    assert.strictEqual(ok.health.folderAccess.desktop, 'blocked');
    assert.strictEqual(ok.health.nodePath, fs.realpathSync(process.execPath));
    folderState = 'ok';
    await hub.checkHealth();
    const pushed = await c.wait((m) => m.t === 'health' && m.folderAccess.desktop === 'ok', 'health push');
    assert.strictEqual(pushed.folderAccess.documents, 'ok');
    assert.ok(c.json.findIndex((m) => m.t === 'error' && m.code === 'unauthorized') < c.json.findIndex((m) => m.t === 'paired'));
  });

  await t.test('auto-approved pairing: a device of the allowed identity is paired without a manual step', async () => {
    config.autoApprovePairing = true;
    const c2 = await client(port);
    try {
      c2.send({ t: 'hello', clientId: 'c2' });
      const required = await c2.wait((m) => m.t === 'pairRequired', 'pairRequired');
      assert.strictEqual(required.autoPair, true);
      c2.send({ t: 'pair', deviceName: 'auto phone' });
      const paired = await c2.wait((m) => m.t === 'paired', 'paired');
      assert.strictEqual(paired.device.name, 'auto phone');
      await c2.wait((m) => m.t === 'helloOk', 'helloOk');
      assert.ok(fs.readFileSync(path.join(stateDir, 'audit.log'), 'utf8').includes('"by":"auto"'));
    } finally {
      config.autoApprovePairing = false;
      c2.ws.close();
    }
  });

  await t.test('new session is acked, listed and pushed', async () => {
    c.send({ t: 'new', id: 'n-1', name: 'cc-int', dir: work });
    const ack = await c.wait((m) => m.t === 'ack' && m.id === 'n-1', 'new ack');
    assert.deepStrictEqual(ack, { t: 'ack', id: 'n-1', ok: true, name: 'cc-int' });
    const list = await c.wait((m) => m.t === 'sessions' && m.items.some((i) => i.name === 'cc-int'), 'sessions push');
    const item = list.items.find((i) => i.name === 'cc-int');
    assert.strictEqual(item.managed, true);
    assert.strictEqual('transcriptPath' in item, false);
    c.send({ t: 'new', id: 'n-2', name: 'cc-out', dir: '/etc' });
    assert.strictEqual((await c.wait((m) => m.t === 'ack' && m.id === 'n-2')).error, 'dir-not-allowed');
  });

  await t.test('sub gets snapshot + binary frame, send arrives once even when repeated', async () => {
    await waitFor(() => capture(ctx, 'cc-int').includes('fake-claude'), { what: 'pane ready' });
    c.send({ t: 'sub', sessionId: 'cc-int', cols: 40, rows: 20 });
    const snap = await c.wait((m) => m.t === 'snapshot' && m.sessionId === 'cc-int', 'snapshot');
    assert.strictEqual(snap.cols, 120);
    assert.strictEqual(snap.rows, 40);
    await waitFor(() => c.frames.some((f) => f.seq === snap.seq), { what: 'snapshot body' });
    c.send({ t: 'send', id: 'm-1', sessionId: 'cc-int', text: 'hello\nsecond line' });
    c.send({ t: 'send', id: 'm-1', sessionId: 'cc-int', text: 'hello\nsecond line' });
    await waitFor(() => c.json.filter((m) => m.t === 'ack' && m.id === 'm-1').length === 2, { what: 'two acks' });
    assert.ok(c.json.filter((m) => m.t === 'ack' && m.id === 'm-1').every((m) => m.ok));
    await waitFor(() => c.text('cc-int').includes('got:second line'), { what: 'output frame' });
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(capture(ctx, 'cc-int').split('got:hello').length - 1, 1);
    const seqs = c.frames.filter((f) => f.sessionId === 'cc-int').map((f) => f.seq);
    seqs.forEach((s, i) => i && assert.strictEqual(s, seqs[i - 1] + 1));
  });

  await t.test('a burst of sends and keys reaches the pane in order, one line each', async () => {
    await new Promise((r) => setTimeout(r, 1100));
    for (let i = 0; i < 4; i++) c.send({ t: 'send', id: `b-${i}`, sessionId: 'cc-int', text: `burst-${i}` });
    c.send({ t: 'key', id: 'b-k', sessionId: 'cc-int', key: 'y' });
    c.send({ t: 'key', id: 'b-e', sessionId: 'cc-int', key: 'Enter' });
    c.send({ t: 'send', id: 'b-4', sessionId: 'cc-int', text: 'burst-4' });
    await waitFor(() => ['b-0', 'b-1', 'b-2', 'b-3', 'b-k', 'b-e', 'b-4'].every((id) => c.json.some((m) => m.t === 'ack' && m.id === id && m.ok)), { what: 'burst acks', timeout: 8000 });
    await waitFor(() => capture(ctx, 'cc-int').includes('got:burst-4'), { what: 'last burst line' });
    const got = capture(ctx, 'cc-int').split('\n').filter((l) => /^got:(burst|y$)/.test(l));
    assert.deepStrictEqual(got, ['got:burst-0', 'got:burst-1', 'got:burst-2', 'got:burst-3', 'got:y', 'got:burst-4']);
  });

  await t.test('a second device: same message id is its own message, bursts from two sockets never interleave', async () => {
    const d = await client(port);
    t.after(() => d.ws.close());
    d.send({ t: 'pair', deviceName: 'second device' });
    const code = await d.wait((m) => m.t === 'pairCode', 'pairCode 2');
    auth.approvePairing(code.code);
    await d.wait((m) => m.t === 'helloOk', 'helloOk 2');
    await new Promise((r) => setTimeout(r, 1100));
    for (let i = 0; i < 4; i++) {
      c.send({ t: 'send', id: `x-${i}`, sessionId: 'cc-int', text: `from-a-${i}` });
      d.send({ t: 'send', id: `x-${i}`, sessionId: 'cc-int', text: `from-b-${i}` });
    }
    d.send({ t: 'send', id: 'm-1', sessionId: 'cc-int', text: 'reused id from b' });
    await waitFor(() => c.json.filter((m) => m.t === 'ack' && /^x-/.test(m.id) && m.ok).length === 4 && d.json.filter((m) => m.t === 'ack' && (/^x-/.test(m.id) || m.id === 'm-1') && m.ok).length === 5, { what: 'acks from both devices', timeout: 8000 });
    await waitFor(() => capture(ctx, 'cc-int').includes('got:reused id from b'), { what: 'reused id delivered' });
    const lines = capture(ctx, 'cc-int').split('\n').filter((l) => /^got:from-/.test(l));
    assert.strictEqual(lines.length, 8);
    for (const l of lines) assert.match(l, /^got:from-[ab]-[0-3]$/);
    for (const who of ['a', 'b']) assert.deepStrictEqual(lines.filter((l) => l.includes(`from-${who}-`)), [0, 1, 2, 3].map((i) => `got:from-${who}-${i}`));
  });

  await t.test('unauthenticated sockets: closed after the hello timeout, at most 8 at once, the oldest gives way', async () => {
    const idle = await client(port);
    const code = await new Promise((r) => idle.ws.once('close', (c) => r(c)));
    assert.strictEqual(code, 4008);
    const open = [];
    for (let i = 0; i < 8; i++) {
      const x = await client(port);
      x.send({ t: 'ping', ts: i });
      open.push(x);
    }
    const oldestClosed = new Promise((r) => open[0].ws.once('close', (c) => r(c)));
    const newest = await client(port);
    assert.strictEqual(await oldestClosed, 4009, 'the oldest unauthenticated socket gives way to the newest');
    open.push(newest);
    for (const x of open) x.ws.terminate();
    await new Promise((r) => setTimeout(r, 100));
  });

  await t.test('keys: allowlist enforced', async () => {
    c.send({ t: 'key', id: 'k-1', sessionId: 'cc-int', key: 'y' });
    c.send({ t: 'key', id: 'k-2', sessionId: 'cc-int', key: 'Enter' });
    c.send({ t: 'key', id: 'k-3', sessionId: 'cc-int', key: 'C-b' });
    assert.strictEqual((await c.wait((m) => m.t === 'ack' && m.id === 'k-3')).error, 'bad-key');
    await waitFor(() => capture(ctx, 'cc-int').includes('got:y'), { what: 'key y' });
  });

  await t.test('size claim and release reach every viewer', async () => {
    c.send({ t: 'claimSize', sessionId: 'cc-int', cols: 60, rows: 20 });
    await c.wait((m) => m.t === 'size' && m.claimedBy === 'test phone' && m.cols === 60, 'size claim');
    c.send({ t: 'releaseSize', sessionId: 'cc-int' });
    await c.wait((m) => m.t === 'size' && m.claimedBy === null, 'size release');
  });

  const pane = (await listSessions(ctx)).find((s) => s.name === 'cc-int');
  fs.writeFileSync(path.join(sessionsDir, `${pane.panePid}.json`), JSON.stringify({ pid: pane.panePid, sessionId: SID, status: 'waiting', waitingFor: 'permission', cwd: work, procStart: 'p1' }));

  await t.test('push: key, subscribe, unsubscribe per device; busy to waiting notifies without message text', async () => {
    c.send({ t: 'pushKey' });
    assert.deepStrictEqual(await c.wait((m) => m.t === 'pushKey'), { t: 'pushKey', key: 'BPUBLICKEY', subscribed: false });
    c.send({ t: 'pushSubscribe', subscription: { endpoint: 'https://push.example.test/x', keys: { p256dh: 'a', auth: 'b' } } });
    await c.wait((m) => m.t === 'pushState' && m.subscribed === true, 'subscribed');
    assert.strictEqual(subscribed.size, 1);
    c.send({ t: 'pushUnsubscribe' });
    await c.wait((m) => m.t === 'pushState' && m.subscribed === false, 'unsubscribed');
    assert.strictEqual(subscribed.size, 0);
    c.send({ t: 'pushSubscribe', subscription: { endpoint: 'https://push.example.test/x', keys: { p256dh: 'a', auth: 'b' } } });
    await c.wait((m) => m.t === 'pushState' && m.subscribed === true && c.json.filter((x) => x.t === 'pushState').length === 3, 'subscribed again');
    const pidFile = path.join(sessionsDir, `${pane.panePid}.json`);
    const write = (status) => fs.writeFileSync(pidFile, JSON.stringify({ pid: pane.panePid, sessionId: SID, status, waitingFor: status === 'waiting' ? 'permission' : undefined, cwd: work, procStart: 'p1' }));
    write('busy');
    await c.wait((m) => m.t === 'status' && m.sessionId === 'cc-int' && m.status === 'busy', 'busy');
    assert.strictEqual(pushed.length, 0, 'no notification for starting work');
    write('waiting');
    await waitFor(() => pushed.length === 1, { what: 'notification' });
    assert.strictEqual(pushed[0].tag, 'cc-int');
    assert.match(pushed[0].title, /needs you$/);
    assert.match(pushed[0].url, /#session=cc-int$/);
    assert.ok(!JSON.stringify(pushed[0]).includes('synthetic prompt'), 'no transcript text in the payload');
  });

  await t.test('status push and multi-line refusal while a dialog waits', async () => {
    await c.wait((m) => m.t === 'status' && m.sessionId === 'cc-int' && m.status === 'waiting', 'status waiting');
    c.send({ t: 'send', id: 'm-2', sessionId: 'cc-int', text: 'line one\nline two' });
    assert.strictEqual((await c.wait((m) => m.t === 'ack' && m.id === 'm-2')).error, 'busy-dialog');
    assert.ok(c.find((m) => m.t === 'error' && m.code === 'busy-dialog'));
    c.send({ t: 'send', id: 'm-3', sessionId: SID, text: 'single line ok' });
    assert.strictEqual((await c.wait((m) => m.t === 'ack' && m.id === 'm-3')).ok, true);
  });

  await t.test('search over names and contents of past sessions; resume one by id alone', async () => {
    const PAST = 'f0f0f0f0-0000-4000-8000-0000000000f0';
    const dir = path.join(home, '.claude', 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString();
    fs.writeFileSync(path.join(dir, `${PAST}.jsonl`), [{ type: 'user', cwd: work, timestamp: ts, message: { content: 'count the quantum zebras' } }, { type: 'assistant', timestamp: ts, message: { content: [{ type: 'text', text: 'Zebras counted.' }] } }, { type: 'custom-title', customTitle: 'Zebra notes' }].map((o) => JSON.stringify(o)).join('\n') + '\n');
    c.send({ t: 'search', id: 'q-1', query: 'QUANTUM zebras', limit: 5 });
    const res = await c.wait((m) => m.t === 'searchResults' && m.id === 'q-1', 'searchResults');
    assert.strictEqual(res.items.length, 1);
    assert.strictEqual(res.items[0].sessionId, PAST);
    assert.strictEqual(res.items[0].title, 'Zebra notes');
    assert.strictEqual(res.items[0].running, null);
    assert.match(res.items[0].snippet, /quantum zebras/);
    c.send({ t: 'search', id: 'q-2', query: 'x'.repeat(300) });
    await c.wait((m) => m.t === 'error' && m.ref === 'search' && m.code === 'bad-request', 'long query refused');
    c.send({ t: 'new', id: 'n-past', resumeId: PAST });
    const ack = await c.wait((m) => m.t === 'ack' && m.id === 'n-past', 'resume ack');
    assert.strictEqual(ack.ok, true);
    assert.strictEqual(ack.name, 'cc-zebra-notes');
  });

  await t.test('chat: events by session id and live tail', async () => {
    await waitFor(() => registry.resolve(SID) && registry.resolve(SID).transcriptPath, { what: 'transcript path' });
    c.send({ t: 'events', sessionId: SID, limit: 10 });
    const ev = await c.wait((m) => m.t === 'events' && m.sessionId === SID, 'events');
    assert.ok(ev.items.some((e) => e.kind === 'prompt' && e.text === 'first synthetic prompt'));
    fs.appendFileSync(transcriptFile, line('written between page and subscription'));
    c.send({ t: 'subEvents', sessionId: SID, from: ev.to });
    await c.wait((m) => m.t === 'eventsLive' && m.items.some((e) => e.text === 'written between page and subscription'), 'gap event delivered live');
    fs.appendFileSync(transcriptFile, line('appended synthetic prompt'));
    const live = await c.wait((m) => m.t === 'eventsLive' && m.items.some((e) => e.text === 'appended synthetic prompt'), 'eventsLive');
    assert.strictEqual(live.sessionId, SID);
    const agents = path.join(projectDir, SID, 'subagents');
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, 'agent-fs0001.meta.json'), JSON.stringify({ agentType: 'scout', description: 'synthetic', toolUseId: 'toolu_fs0001' }));
    fs.writeFileSync(path.join(agents, 'agent-fs0001.jsonl'), line('synthetic subagent prompt'));
    c.send({ t: 'agentEvents', sessionId: SID, toolUseId: 'toolu_fs0001', limit: 10 });
    const ag = await c.wait((m) => m.t === 'agentEvents', 'agentEvents');
    assert.strictEqual(ag.toolUseId, 'toolu_fs0001');
    assert.ok(ag.items.some((e) => e.kind === 'prompt' && e.text === 'synthetic subagent prompt'));
    c.send({ t: 'agentEvents', sessionId: SID, toolUseId: 'toolu_missing', limit: 10 });
    await c.wait((m) => m.t === 'error' && m.ref === 'agentEvents' && m.code === 'not-found', 'unknown tool use');
    c.send({ t: 'agentEvents', sessionId: SID, toolUseId: '../../x', limit: 10 });
    await c.wait((m) => m.t === 'error' && m.ref === 'agentEvents' && m.code === 'bad-request', 'bad tool use id');
    c.send({ t: 'events', sessionId: '../../etc/passwd', limit: 10 });
    await c.wait((m) => m.t === 'error' && m.code === 'not-found' && m.ref === 'events', 'traversal refused');
  });

  await t.test('unread per device: transcript growth marks a session unread until the device has seen it', async () => {
    const item = () => c.json.filter((m) => m.t === 'sessions').map((m) => m.items.find((i) => i.sessionId === SID)).filter(Boolean).pop();
    await waitFor(() => item(), { what: 'session in list' });
    assert.strictEqual('transcriptSize' in item(), false, 'byte counts stay on the server');
    c.send({ t: 'markSeen', sessionId: SID });
    await waitFor(() => item() && item().unread === false, { what: 'read after markSeen' });
    fs.appendFileSync(transcriptFile, line('new reply while away'));
    await waitFor(() => item() && item().unread === true, { what: 'unread after growth' });
    const pushes = c.json.filter((m) => m.t === 'sessions').length;
    fs.appendFileSync(transcriptFile, line('another reply, nothing visible changes'));
    await new Promise((res) => setTimeout(res, 1200));
    assert.strictEqual(c.json.filter((m) => m.t === 'sessions').length, pushes, 'no push when nothing visible changed');
    c.send({ t: 'markSeen', sessionId: SID });
    await waitFor(() => item() && item().unread === false, { what: 'read again' });
    c.send({ t: 'markSeen', sessionId: '../../etc' });
    await c.wait((m) => m.t === 'error' && m.ref === 'markSeen', 'bad id refused');
  });

  await t.test('chat subscriptions never leak tails: duplicate subscribe and close during setup', async () => {
    assert.strictEqual(hub.stats().tails, 1);
    const d = await client(port);
    d.send({ t: 'hello', token, clientId: 'c-tail' });
    await d.wait((m) => m.t === 'helloOk');
    d.send({ t: 'subEvents', sessionId: SID });
    d.send({ t: 'subEvents', sessionId: SID });
    await waitFor(() => hub.stats().tails === 2, { what: 'one tail for the duplicate subscribe' });
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(hub.stats().tails, 2);
    d.ws.close();
    await waitFor(() => hub.stats().tails === 1, { what: 'tail closed with its socket' });
    const e = await client(port);
    e.send({ t: 'hello', token, clientId: 'c-tail2' });
    await e.wait((m) => m.t === 'helloOk');
    e.send({ t: 'subEvents', sessionId: SID });
    e.ws.terminate();
    await new Promise((r) => setTimeout(r, 400));
    assert.strictEqual(hub.stats().tails, 1, 'socket gone before the tail started');
  });

  await t.test('rate limit: more than 10 inputs per second are deferred, not dropped', async () => {
    for (let i = 0; i < 15; i++) c.send({ t: 'key', id: `r-${i}`, sessionId: 'cc-int', key: 'Escape' });
    await waitFor(() => c.json.filter((m) => m.t === 'ack' && m.id.startsWith('r-')).length === 15, { what: 'rate acks' });
    const limited = c.json.filter((m) => m.t === 'ack' && m.id.startsWith('r-') && m.error === 'rate-limited');
    assert.ok(limited.length >= 3, `limited ${limited.length}`);
    await new Promise((r) => setTimeout(r, 1100));
    c.send({ t: 'key', id: limited[0].id, sessionId: 'cc-int', key: 'Escape' });
    await waitFor(() => c.json.some((m) => m.t === 'ack' && m.id === limited[0].id && m.ok), { what: 'retry accepted' });
  });

  await t.test('a second client resumes with its token; unmanaged sessions are read-only', async () => {
    const other = (await import('child_process')).spawn('sleep', ['30'], { stdio: 'ignore' });
    t.after(() => other.kill('SIGKILL'));
    const OUT = '9a9b9c9d-1111-4222-8333-444455556666';
    fs.writeFileSync(path.join(sessionsDir, `${other.pid}.json`), JSON.stringify({ pid: other.pid, sessionId: OUT, status: 'idle', cwd: work, procStart: 'p2', name: 'Outside task' }));
    const d = await client(port);
    t.after(() => d.ws.close());
    d.send({ t: 'hello', token, clientId: 'c2' });
    await d.wait((m) => m.t === 'helloOk');
    await d.wait((m) => m.t === 'sessions' && m.items.some((i) => i.sessionId === OUT && !i.managed), 'unmanaged listed');
    d.send({ t: 'sub', sessionId: OUT, cols: 80, rows: 24 });
    await d.wait((m) => m.t === 'error' && m.code === 'read-only', 'read-only');
    d.send({ t: 'send', id: 'm-ro', sessionId: OUT, text: 'x' });
    assert.strictEqual((await d.wait((m) => m.t === 'ack' && m.id === 'm-ro')).error, 'read-only');
    d.send({ t: 'takeoverPrepare', pid: other.pid });
    const info = await d.wait((m) => m.t === 'takeoverInfo', 'takeoverInfo');
    assert.strictEqual(info.sessionId, OUT);
    assert.strictEqual(info.name, 'cc-outside-task');
  });

  await t.test('audit lines carry no message text and logs no token', async () => {
    const audit = fs.readFileSync(path.join(stateDir, 'audit.log'), 'utf8');
    assert.match(audit, /"action":"send"/);
    assert.ok(!audit.includes('second line') && !audit.includes('single line ok'));
    assert.ok(!logs.join('\n').includes(token));
    assert.strictEqual(fs.statSync(path.join(stateDir, 'audit.log')).mode & 0o077, 0);
  });

  await t.test('session end is reported to viewers', async () => {
    execFileSync(ctx.bin, ['-L', ctx.socket, 'kill-session', '-t', '=cc-int']);
    await c.wait((m) => m.t === 'error' && m.code === 'session-ended', 'session-ended');
  });
});
