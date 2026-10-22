'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hub-home-'));
process.env.HOME = home;
delete process.env.CLAUDE_CONFIG_DIR;
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hub-ws-'));
fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });

const { createFakeVscode } = require('./fake-vscode');
const { createHub } = require('../hub');

function mockHub() {
  const hub = { states: [], queue: [], results: [], takes: [], status: 200 };
  hub.server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (hub.status !== 200) {
        res.statusCode = hub.status;
        return res.end('{}');
      }
      res.setHeader('content-type', 'application/json');
      if (req.method === 'PUT' && req.url === '/api/plugin/state') {
        hub.states.push(JSON.parse(body));
        return res.end('{}');
      }
      if (req.method === 'POST' && req.url.startsWith('/api/plugin/commands/take?')) {
        hub.takes.push(new URL(req.url, 'http://x').searchParams.get('repo'));
        return res.end(JSON.stringify(hub.queue.splice(0)));
      }
      const m = req.method === 'POST' && req.url.match(/^\/api\/plugin\/commands\/([^/]+)\/result$/);
      if (m) {
        hub.results.push({ id: decodeURIComponent(m[1]), ...JSON.parse(body) });
        return res.end('{}');
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise((resolve) =>
    hub.server.listen(0, '127.0.0.1', () => {
      hub.url = `http://127.0.0.1:${hub.server.address().port}`;
      resolve(hub);
    })
  );
}

test('commands are executed, answered with their result, and the state is pushed again', async () => {
  const mock = await mockHub();
  const executed = [];
  const hub = createHub({
    url: () => mock.url,
    enabled: () => true,
    repo: '/some repo',
    buildState: () => ({ n: mock.states.length }),
    execute: async (cmd) => {
      executed.push(cmd.type);
      if (cmd.type === 'bad') throw new Error('nope');
    },
  });
  hub.start();
  try {
    mock.queue.push({ id: 'a/1', type: 'favorite' }, { id: 'b', type: 'bad' });
    await hub.drain();
    assert.deepStrictEqual(executed, ['favorite', 'bad']);
    assert.deepStrictEqual(mock.results, [{ id: 'a/1', ok: true }, { id: 'b', ok: false, error: 'nope' }]);
    assert.strictEqual(mock.takes[0], '/some repo');
    assert.ok(mock.states.length >= 3, 'initial push plus one after each command');
  } finally {
    hub.stop();
    mock.server.close();
  }
});

test('an unreachable or failing hub is silent and backs off', async () => {
  const mock = await mockHub();
  mock.status = 404;
  const logs = [];
  const hub = createHub({ url: () => mock.url, enabled: () => true, repo: '/r', buildState: () => ({}), execute: async () => {}, log: (l) => logs.push(l) });
  hub.start();
  try {
    await hub.drain();
    await hub.drain();
    await hub.pushNow();
    assert.strictEqual(mock.takes.length, 0);
    assert.strictEqual(logs.length, 1, 'logged once, then skipped while backing off');
  } finally {
    hub.stop();
    mock.server.close();
  }
});

test('disabled hub makes no request', async () => {
  const mock = await mockHub();
  const hub = createHub({ url: () => mock.url, enabled: () => false, repo: '/r', buildState: () => ({}), execute: async () => {} });
  hub.start();
  await hub.pushNow();
  await hub.drain();
  hub.stop();
  mock.server.close();
  assert.strictEqual(mock.states.length + mock.takes.length, 0);
});

test('in the extension a queued favorite command toggles the favorite in the state file and the push carries it', async () => {
  const mock = await mockHub();
  const fake = createFakeVscode({ workspacePath: workspace, globalStoragePath: fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hub-gs-')) });
  fake.config['remote.tmuxSocket'] = `test-no-service-${process.pid}`;
  fake.config['hub.enabled'] = true;
  fake.config['hub.url'] = mock.url;
  const api = fake.activate();
  const id = '11111111-1111-1111-1111-111111111111';
  try {
    await api.activeView.ready;
    const stateFile = api.store.file();
    mock.queue.push({ id: 'c1', type: 'favorite', sessionId: id, on: true }, { id: 'c2', type: 'rename', sessionId: id, name: 'from hub' }, { id: 'c3', type: 'wat' });
    await api.hub.drain();
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.strictEqual(saved.favorites[id], true);
    assert.strictEqual(saved.names[id], 'from hub');
    assert.deepStrictEqual(mock.results.map((r) => r.ok), [true, true, false]);
    const last = mock.states[mock.states.length - 1];
    assert.deepStrictEqual(last.favorites, [id]);
    assert.strictEqual(last.names[id], 'from hub');
    assert.strictEqual(last.repo, workspace);
    assert.strictEqual(last.remote, null);
    assert.ok(last.machine.id && last.machine.name && last.version);
    mock.queue.push({ id: 'c4', type: 'favorite', sessionId: id, on: false });
    await api.hub.drain();
    assert.strictEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).favorites[id], undefined);
  } finally {
    api.deactivate();
    mock.server.close();
  }
});

test('archive, saved tabs, inactive rows and sync state travel through the bridge; commands queued before start run on the first poll', async () => {
  const mock = await mockHub();
  const id = '22222222-2222-2222-2222-222222222222';
  const projectDir = path.join(home, '.claude', 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(projectDir, { recursive: true });
  const at = new Date(Date.now() - 60000).toISOString();
  fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), `${JSON.stringify({ type: 'user', cwd: workspace, timestamp: at, message: { content: 'hello hub' } })}\n`);
  mock.queue.push({ id: 'q1', type: 'favorite', sessionId: id, on: true });
  const fake = createFakeVscode({ workspacePath: workspace, globalStoragePath: fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hub-gs-')) });
  fake.config['remote.tmuxSocket'] = `test-no-service-${process.pid}`;
  fake.config['hub.enabled'] = true;
  fake.config['hub.url'] = mock.url;
  const api = fake.activate();
  try {
    await api.activeView.ready;
    for (let i = 0; i < 100 && !mock.results.length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(mock.results, [{ id: 'q1', ok: true }], 'taken by the first poll after activation');
    mock.queue.push({ id: 'q2', type: 'archive', sessionId: id });
    await api.hub.drain();
    let last = mock.states[mock.states.length - 1];
    const row = last.inactive.find((r) => r.sessionId === id);
    assert.ok(row && row.archived && row.favorite && row.runningElsewhere === null && row.synced === null);
    assert.ok(row.name && row.lastActivity);
    assert.strictEqual(last.sync.connected, false);
    assert.strictEqual(last.sync.folder, null);
    assert.deepStrictEqual(last.savedTabs, []);
    assert.deepStrictEqual(last.openTabs, []);
    mock.queue.push({ id: 'q3', type: 'unarchive', sessionId: id }, { id: 'q4', type: 'syncNow' });
    await api.hub.drain();
    last = mock.states[mock.states.length - 1];
    assert.strictEqual(last.inactive.find((r) => r.sessionId === id).archived, false);
    assert.deepStrictEqual(mock.results.slice(-2).map((r) => r.ok), [true, false], 'syncNow without Nextcloud reports an error');
  } finally {
    api.deactivate();
    mock.server.close();
  }
});

test('sendText types into the tab of the session: one line, multi-line as one paste, busy noted, no tab is an error', async () => {
  const mock = await mockHub();
  const id = '33333333-3333-3333-3333-333333333333';
  const fake = createFakeVscode({ workspacePath: workspace, globalStoragePath: fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hub-gs-')) });
  fake.config['remote.tmuxSocket'] = `test-no-service-${process.pid}`;
  fake.config['hub.enabled'] = true;
  fake.config['hub.url'] = mock.url;
  const api = fake.activate();
  try {
    await api.activeView.ready;
    const term = fake.vscode.window.createTerminal({ name: 'target' });
    api.tracker.meta.set(term, { name: 'target', nameSource: 'user', sessionId: id, status: 'idle' });
    mock.queue.push({ id: 's1', type: 'sendText', sessionId: id, text: 'hello' }, { id: 's2', type: 'sendText', sessionId: id, text: 'a\r\nb\n\nc\u001b' });
    await api.hub.drain();
    api.tracker.meta.get(term).status = 'busy';
    mock.queue.push({ id: 's3', type: 'sendText', sessionId: id, text: 'later' }, { id: 's4', type: 'sendText', sessionId: 'nobody', text: 'x' });
    await api.hub.drain();
    assert.deepStrictEqual(term.sent, ['hello', '\u001b[200~a\nb\n\nc\u001b[201~', '', 'later']);
    const byId = Object.fromEntries(mock.results.map((r) => [r.id, r]));
    assert.deepStrictEqual(byId.s1, { id: 's1', ok: true });
    assert.deepStrictEqual(byId.s3, { id: 's3', ok: true, note: 'queued while busy' });
    assert.deepStrictEqual(byId.s4, { id: 's4', ok: false, error: 'no tab' });
  } finally {
    api.deactivate();
    mock.server.close();
  }
});

test('newSession opens a tab in the next grid slot and reports the id; openSession focuses an open tab; progress states reach the pushed state', async () => {
  const mock = await mockHub();
  const fake = createFakeVscode({ workspacePath: workspace, globalStoragePath: fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hub-gs-')) });
  fake.config['remote.tmuxSocket'] = `test-no-service-${process.pid}`;
  fake.config['hub.enabled'] = true;
  fake.config['hub.url'] = mock.url;
  const api = fake.activate();
  const newId = '44444444-4444-4444-4444-444444444444';
  try {
    await api.activeView.ready;
    const before = new Set(fake.vscode.window.terminals);
    const feeder = setInterval(() => {
      const t = fake.vscode.window.terminals.find((x) => !before.has(x) && (x.sent || []).some((s) => /claude/.test(s)));
      if (t) api.tracker.meta.set(t, { ...api.tracker.meta.get(t), sessionId: newId, status: 'idle' });
    }, 50);
    mock.queue.push({ id: 'n1', type: 'newSession', name: 'from-hub', prompt: "it's a test" });
    await api.hub.drain();
    clearInterval(feeder);
    const res = mock.results.find((r) => r.id === 'n1');
    assert.deepStrictEqual(res, { id: 'n1', ok: true, sessionId: newId });
    const created = fake.vscode.window.terminals.find((x) => !before.has(x));
    assert.ok(created.sent.some((s) => s.includes(`'it'\\''s a test'`)), 'prompt is shell-quoted');
    assert.strictEqual(api.tracker.groups.length, 1, 'first tab fills column 1');
    mock.queue.push({ id: 'o1', type: 'openSession', sessionId: newId }, { id: 'o2', type: 'openSession' });
    await api.hub.drain();
    assert.deepStrictEqual(mock.results.filter((r) => r.id === 'o1'), [{ id: 'o1', ok: true, sessionId: newId }]);
    assert.strictEqual(mock.results.find((r) => r.id === 'o2').ok, false);
    const states = mock.states.flatMap((s) => (s.commands || []).filter((c) => c.id === 'n1').map((c) => c.state));
    assert.ok(states.includes('opening'), 'opening is pushed while the command runs');
    const last = mock.states[mock.states.length - 1];
    assert.strictEqual(last.commands.find((c) => c.id === 'n1').state, 'ready');
    const live = last.liveTabs.find((t) => t.sessionId === newId);
    assert.ok(live && live.column === 0 && live.row === 0 && live.status === 'idle');
  } finally {
    api.deactivate();
    mock.server.close();
  }
});
