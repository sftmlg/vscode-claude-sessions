'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-stability-home-'));
process.env.HOME = home;
delete process.env.CLAUDE_CONFIG_DIR;
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-stability-ws-'));
const projectDir = path.join(home, '.claude', 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'));
const registryDir = path.join(home, '.claude', 'sessions');
fs.mkdirSync(projectDir, { recursive: true });
fs.mkdirSync(registryDir, { recursive: true });

const { createFakeVscode } = require('./fake-vscode');
const { scoredSearch } = require('../sessions');

const SESSIONS = 300;
const RUNNING = 32;
const LARGE = 2;
const MAX_STALL_MS = 100;

const id = (i) => `${String(i).padStart(8, '0')}-5555-4000-8000-000000000000`;
const line = (o) => `${JSON.stringify(o)}\n`;

function writeSession(i, largeMb = 0) {
  const at = new Date(Date.now() - i * 60000).toISOString();
  const fd = fs.openSync(path.join(projectDir, `${id(i)}.jsonl`), 'w');
  fs.writeSync(fd, line({ type: 'user', cwd: workspace, timestamp: at, message: { content: `prompt ${i} about invoices` } }));
  const tool = line({ type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', content: 'x'.repeat(2 * 1024 * 1024) }] } });
  const chatter = line({ type: 'assistant', timestamp: at, message: { content: [{ type: 'text', text: `step ${'y'.repeat(2000)}` }] } }).repeat(4000);
  for (let mb = 0; mb < largeMb; mb += 10.2) fs.writeSync(fd, tool + chatter);
  fs.writeSync(fd, line({ type: 'assistant', timestamp: at, message: { content: [{ type: 'text', text: `reply ${i}` }] } }));
  fs.closeSync(fd);
}

test('a heavy workspace never blocks the extension host for long', { timeout: 180000 }, async () => {
  for (let i = 0; i < SESSIONS; i++) writeSession(i, i >= RUNNING && i < RUNNING + LARGE ? 150 : 0);
  const children = [];
  for (let i = 0; i < RUNNING; i++) {
    const child = spawn('sleep', ['120']);
    children.push(child);
    fs.writeFileSync(path.join(registryDir, `${child.pid}.json`), JSON.stringify({ pid: child.pid, sessionId: id(i), cwd: workspace, status: 'busy' }));
  }
  let worst = 0;
  let last = Date.now();
  const probe = setInterval(() => {
    const now = Date.now();
    worst = Math.max(worst, now - last - 20);
    last = now;
  }, 20);
  const fake = createFakeVscode({ workspacePath: workspace, globalStoragePath: fs.mkdtempSync(path.join(os.tmpdir(), 'claude-stability-gs-')) });
  fake.config['remote.tmuxSocket'] = `test-no-service-${process.pid}`;
  const api = fake.activate();
  try {
    await api.activeView.ready;
    const terminals = children.map((c, i) => fake.vscode.window.createTerminal({ name: `claude ${i}`, pid: c.pid }));
    const until = Date.now() + 12000;
    for (let i = 0; Date.now() < until; i++) {
      terminals[i % terminals.length].show();
      if (i % 10 === 0) {
        await api.activeView.getChildren();
        api.inactiveView.needsFull = true;
        await api.inactiveView.getChildren();
      }
      if (i % 25 === 0) await scoredSearch(await api.inactiveView.inactiveSessions(), 'invoices step');
      await new Promise((r) => setTimeout(r, 50));
    }
    const listed = await api.inactiveView.inactiveSessions();
    assert.ok(listed.length >= SESSIONS - RUNNING, `Inactive lists ${listed.length} sessions`);
    assert.ok(worst < MAX_STALL_MS, `extension host blocked for ${worst} ms`);
  } finally {
    clearInterval(probe);
    api.deactivate();
    for (const c of children) c.kill();
  }
});
