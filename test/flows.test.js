'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-flows-home-'));
process.env.HOME = home;
delete process.env.CLAUDE_CONFIG_DIR;
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-flows-ws-'));
const projectDir = path.join(home, '.claude', 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'));
const registryDir = path.join(home, '.claude', 'sessions');
fs.mkdirSync(projectDir, { recursive: true });
fs.mkdirSync(registryDir, { recursive: true });

const { createFakeVscode } = require('./fake-vscode');
const children = [];

function writeSession(id, text, minutesAgo = 5) {
  const at = new Date(Date.now() - minutesAgo * 60000).toISOString();
  const lines = [
    { type: 'user', cwd: workspace, timestamp: at, message: { content: text } },
    { type: 'assistant', timestamp: at, message: { content: [{ type: 'text', text: `reply to ${text}` }] } },
  ];
  fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

function startClaude(sessionId) {
  const child = spawn('sleep', ['60']);
  children.push(child);
  fs.writeFileSync(path.join(registryDir, `${child.pid}.json`), JSON.stringify({ pid: child.pid, sessionId, cwd: workspace, status: 'idle' }));
  return child;
}

function stopClaude(child) {
  fs.rmSync(path.join(registryDir, `${child.pid}.json`), { force: true });
  child.kill();
}

const settle = () => new Promise((r) => setTimeout(r, 50));

async function setup() {
  const fake = createFakeVscode({ workspacePath: workspace, globalStoragePath: fs.mkdtempSync(path.join(os.tmpdir(), 'claude-flows-gs-')) });
  const api = fake.activate();
  return { fake, api };
}

async function activeItemFor(api, terminal) {
  const items = await api.activeView.getChildren();
  const flat = [];
  for (const item of items) {
    if (item.data && item.data.terminals) flat.push(...(await api.activeView.getChildren(item)));
    else flat.push(item);
  }
  return flat.find((i) => i.data && i.data.terminal === terminal);
}

async function inactiveItemFor(api, sessionId) {
  api.inactiveView.needsFull = true;
  const items = await api.inactiveView.getChildren();
  return items.find((i) => i.data && i.data.tab && i.data.tab.sessionId === sessionId);
}

test.after(() => {
  for (const c of children) c.kill();
});

test('a favorite closed with ✕ stays a favorite in Inactive', async () => {
  const id = '11111111-0000-0000-0000-000000000001';
  writeSession(id, 'kreil tickets');
  const claude = startClaude(id);
  const { fake, api } = await setup();
  const t = fake.vscode.window.createTerminal({ name: 'kreil', pid: claude.pid });
  t.show();
  await api.tracker.poll();

  const tab = await activeItemFor(api, t);
  assert.ok(tab, 'the tab is listed in Active');
  await fake.run('claudeSessions.favorite', tab);
  assert.strictEqual(api.notifications.isFavorite(id), true);

  const starred = await activeItemFor(api, t);
  await fake.run('claudeSessions.closeTab', starred);
  stopClaude(claude);
  await settle();
  await api.tracker.poll();

  assert.strictEqual(api.notifications.isFavorite(id), true, 'favorite flag survives closing the tab');
  const closed = await inactiveItemFor(api, id);
  assert.ok(closed, 'the closed session is listed in Inactive');
  assert.match(closed.label, /^★ /);
  assert.match(closed.contextValue, /\.fav$/);
  api.deactivate();
});

test('a close followed by a fast refresh still lists the closed session', async () => {
  const id = '66666666-0000-0000-0000-000000000006';
  writeSession(id, 'race');
  const claude = startClaude(id);
  const { fake, api } = await setup();
  await api.inactiveView.getChildren();
  const t = fake.vscode.window.createTerminal({ name: 'race', pid: claude.pid });
  t.show();
  await api.tracker.poll();
  await api.inactiveView.getChildren();
  stopClaude(claude);
  t.dispose();
  api.inactiveView.refresh();
  api.inactiveView.refresh(true);
  const items = await api.inactiveView.getChildren();
  assert.ok(items.some((i) => i.data && i.data.tab && i.data.tab.sessionId === id));
  api.deactivate();
});

test('rows keep their ids across refreshes so a click on a refreshed row still resolves', async () => {
  const id = '77777777-0000-0000-0000-000000000007';
  writeSession(id, 'stable');
  const { fake, api } = await setup();
  fake.vscode.window.createTerminal({ name: 'plain' }).show();
  const before = (await api.activeView.getChildren()).map((i) => i.id);
  api.inactiveView.needsFull = true;
  const inactiveBefore = (await api.inactiveView.getChildren()).map((i) => i.id);
  api.activeView.refresh();
  api.inactiveView.refresh();
  assert.deepStrictEqual((await api.activeView.getChildren()).map((i) => i.id), before);
  assert.deepStrictEqual((await api.inactiveView.getChildren()).map((i) => i.id), inactiveBefore);
  assert.ok(before.every(Boolean) && inactiveBefore.every(Boolean));
  assert.strictEqual(new Set(inactiveBefore).size, inactiveBefore.length);
  api.deactivate();
});

test('🔍 without a row falls back to the active terminal instead of throwing', async () => {
  const { fake, api } = await setup();
  const t = fake.vscode.window.createTerminal({ name: 'zsh', pid: startClaude(null).pid });
  t.show();
  await fake.run('claudeSessions.switchSession', undefined);
  await fake.run('claudeSessions.splitTab', undefined);
  api.deactivate();
});

test('a split made with VS Code itself joins the parent group without a capture', async () => {
  const { fake, api } = await setup();
  const a = fake.vscode.window.createTerminal({ name: 'left' });
  a.show();
  await new Promise((r) => setTimeout(r, 700));
  const b = await fake.run('workbench.action.terminal.split');
  await new Promise((r) => setTimeout(r, 1000));
  api.tracker.syncGroups();
  assert.deepStrictEqual(api.tracker.groups.map((g) => g.map((t) => t.name)), [['left', 'zsh']]);
  assert.strictEqual(fake.vscode.window.activeTerminal, b, 'focus is back on the new split');
  const other = fake.vscode.window.createTerminal({ name: 'alone' });
  other.show();
  await new Promise((r) => setTimeout(r, 1000));
  api.tracker.syncGroups();
  assert.deepStrictEqual(api.tracker.groups.map((g) => g.length), [2, 1]);
  api.deactivate();
});

test('a provisional registry id without a session file never replaces the resumed session', async () => {
  const real = '44444444-0000-0000-0000-000000000004';
  const provisional = '44444444-0000-0000-0000-00000000000f';
  writeSession(real, 'diwa ticket db');
  const { fake, api } = await setup();
  const closedItem = await inactiveItemFor(api, real);
  await fake.run('claudeSessions.favorite', closedItem);
  await fake.run('claudeSessions.resumeNewTab', await inactiveItemFor(api, real));
  const t = fake.vscode.window.terminals.find((x) => x.sent.some((s) => s.includes(`--resume ${real}`)));
  fs.writeFileSync(path.join(registryDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: provisional, cwd: workspace, status: 'idle' }));
  const meta = api.tracker.meta.get(t);
  meta.expectedUntil = 0;
  await api.tracker.poll();
  assert.strictEqual(api.tracker.meta.get(t).sessionId, real, 'the tab keeps the id it resumed');
  const tab = await activeItemFor(api, t);
  assert.match(tab.label, /^★ /, 'the tab shows the star of the resumed session');

  await fake.run('claudeSessions.closeTab', tab);
  fs.rmSync(path.join(registryDir, `${process.pid}.json`), { force: true });
  await settle();
  const after = await inactiveItemFor(api, real);
  assert.match(after.label, /^★ /);
  assert.strictEqual(api.notifications.isFavorite(provisional), false);
  api.deactivate();
});

test('a favorite tab keeps its star across a window reload while the registry still reports a provisional id', async () => {
  const real = '88888888-0000-0000-0000-000000000008';
  const provisional = '88888888-0000-0000-0000-00000000000f';
  writeSession(real, 'schmid reload');
  const claude = startClaude(real);
  const first = await setup();
  const before = first.fake.vscode.window.createTerminal({ name: 'zsh', pid: claude.pid });
  before.show();
  await first.api.tracker.poll();
  first.fake.inputAnswers.push('schmid-reload');
  await first.fake.run('claudeSessions.renameTab', await activeItemFor(first.api, before));
  await first.fake.run('claudeSessions.favorite', await activeItemFor(first.api, before));
  assert.strictEqual(first.api.notifications.isFavorite(real), true);
  first.api.deactivate();

  fs.writeFileSync(path.join(registryDir, `${claude.pid}.json`), JSON.stringify({ pid: claude.pid, sessionId: provisional, cwd: workspace, status: 'idle' }));
  const second = await setup();
  const after = second.fake.vscode.window.createTerminal({ name: 'schmid-reload', pid: claude.pid });
  after.show();
  await second.api.tracker.poll();

  assert.strictEqual(second.api.tracker.meta.get(after).sessionId, real, 'the reloaded tab keeps its saved session id');
  assert.match((await activeItemFor(second.api, after)).label, /^★ /);
  const saved = second.api.store.read().filter((t) => t.name === 'schmid-reload').map((t) => t.sessionId);
  assert.deepStrictEqual(saved, [real], 'no tab is saved under the provisional id');
  assert.strictEqual((second.api.store.readState().names || {})[provisional], undefined);
  stopClaude(claude);
  second.api.deactivate();
});

test('restoring saved tabs gives the registry the same grace period as ▶', async () => {
  const id = '55555555-0000-0000-0000-000000000005';
  writeSession(id, 'restore me');
  const { fake, api } = await setup();
  api.store.write([{ name: 'restore-me', sessionId: id, cwd: workspace, group: id }]);
  await api.tracker.restore();
  const t = fake.vscode.window.terminals.find((x) => x.name === 'restore-me');
  assert.strictEqual(api.tracker.meta.get(t).expectedSessionId, id);
  api.deactivate();
});

test('a renamed tab keeps its name after closing and reopening by id', async () => {
  const id = '22222222-0000-0000-0000-000000000002';
  writeSession(id, 'schmid email');
  const claude = startClaude(id);
  const { fake, api } = await setup();
  const t = fake.vscode.window.createTerminal({ name: 'zsh', pid: claude.pid });
  t.show();
  await api.tracker.poll();
  fake.inputAnswers.push('schmid-mail');
  await fake.run('claudeSessions.renameTab', await activeItemFor(api, t));
  assert.strictEqual(t.name, 'schmid-mail');
  assert.strictEqual(api.store.readState().names[id], 'schmid-mail');

  await fake.run('claudeSessions.closeTab', await activeItemFor(api, t));
  stopClaude(claude);
  await settle();
  const closed = await inactiveItemFor(api, id);
  assert.match(closed.label, /schmid-mail/);

  await fake.run('claudeSessions.resumeNewTab', closed);
  const reopened = fake.vscode.window.terminals.find((x) => x.sent.some((s) => s.includes(`--resume ${id}`)));
  assert.ok(reopened, 'a new tab resumes the session by id');
  assert.strictEqual(reopened.name, 'schmid-mail');
  api.deactivate();
});

test('the picker opens before any terminal and Escape creates nothing', async () => {
  const { fake, api } = await setup();
  const before = fake.vscode.window.terminals.length;
  fake.quickPickAnswers.push(() => false);
  await fake.run('claudeSessions.openNew');
  assert.strictEqual(fake.vscode.window.terminals.length, before);
  api.deactivate();
});

test('nothing is ever typed as /rename', async () => {
  const id = '33333333-0000-0000-0000-000000000003';
  writeSession(id, 'osteria');
  const claude = startClaude(id);
  const { fake, api } = await setup();
  const t = fake.vscode.window.createTerminal({ name: 'osteria', pid: claude.pid });
  t.show();
  for (let i = 0; i < 3; i++) await api.tracker.poll();
  t.name = '✳ Osteria controlling';
  for (let i = 0; i < 3; i++) await api.tracker.poll();
  assert.ok(!t.sent.some((s) => s.startsWith('/rename')));
  stopClaude(claude);
  api.deactivate();
});
