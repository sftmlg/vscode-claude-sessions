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
const { start, csp, staticPath } = require('../server');
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
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { ...ident, origin: `http://${HOST}:39180` } });
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

test('static paths stay inside web/ and only serve known types', () => {
  assert.ok(staticPath('/').endsWith(path.join('web', 'index.html')));
  assert.ok(staticPath('/vendor/xterm.mjs?x=1').endsWith(path.join('web', 'vendor', 'xterm.mjs')));
  for (const bad of ['/../server.js', '/..%2fserver.js', '/vendor/VERSIONS', '/vendor/xterm.LICENSE', '/%00.html', '/%E0%A4%A.html']) assert.strictEqual(staticPath(bad), null, bad);
  assert.strictEqual(csp({ publicHost: HOST, publicPort: 39180 }), `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://${HOST}:39180; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
});

test('hub end to end on a throwaway tmux socket', async (t) => {
  const ctx = testCtx();
  const stateDir = path.join(home, 'state');
  const config = { port: 0, publicPort: 39180, publicHost: HOST, allowedLogin: LOGIN, tmuxSocket: ctx.socket, tmuxPath: ctx.bin, childPath: ctx.childPath, stateDir, roots: [work], defaultDir: work, launcher: [], claudeCommand: ['/bin/sh', FAKE_CLAUDE], claudeArgs: [] };
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const auth = createAuth(config, { log: () => {} });
  const logs = [];
  const registry = new Registry(config, { ctx, pollMs: 150 });
  const hub = await start(config, { auth, registry, log: (m) => logs.push(m) });
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
    assert.ok(c.json.findIndex((m) => m.t === 'error' && m.code === 'unauthorized') < c.json.findIndex((m) => m.t === 'paired'));
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

  await t.test('status push and multi-line refusal while a dialog waits', async () => {
    await c.wait((m) => m.t === 'status' && m.sessionId === 'cc-int' && m.status === 'waiting', 'status waiting');
    c.send({ t: 'send', id: 'm-2', sessionId: 'cc-int', text: 'line one\nline two' });
    assert.strictEqual((await c.wait((m) => m.t === 'ack' && m.id === 'm-2')).error, 'busy-dialog');
    assert.ok(c.find((m) => m.t === 'error' && m.code === 'busy-dialog'));
    c.send({ t: 'send', id: 'm-3', sessionId: SID, text: 'single line ok' });
    assert.strictEqual((await c.wait((m) => m.t === 'ack' && m.id === 'm-3')).ok, true);
  });

  await t.test('chat: events by session id and live tail', async () => {
    await waitFor(() => registry.resolve(SID) && registry.resolve(SID).transcriptPath, { what: 'transcript path' });
    c.send({ t: 'events', sessionId: SID, limit: 10 });
    const ev = await c.wait((m) => m.t === 'events' && m.sessionId === SID, 'events');
    assert.ok(ev.items.some((e) => e.kind === 'prompt' && e.text === 'first synthetic prompt'));
    c.send({ t: 'subEvents', sessionId: SID });
    await new Promise((r) => setTimeout(r, 200));
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
