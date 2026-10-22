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
    await hub.pollOnce();
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
    await hub.pollOnce();
    await hub.pollOnce();
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
  await hub.pollOnce();
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
    await api.hub.pollOnce();
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
    await api.hub.pollOnce();
    assert.strictEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).favorites[id], undefined);
  } finally {
    api.deactivate();
    mock.server.close();
  }
});
