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

const focusMoves = (fake) => fake.executed.filter(([id]) => /focus(Next|Previous)Pane|focusNext$|focusAtIndex/.test(id)).length;

test('a split made with VS Code itself joins its group with one pane check and focus returns to it', async () => {
  const { fake, api } = await setup();
  const a = fake.vscode.window.createTerminal({ name: 'left' });
  a.show();
  await api.activeView.ready;
  const b = await fake.run('workbench.action.terminal.split');
  await new Promise((r) => setTimeout(r, 2200));
  api.tracker.syncGroups();
  assert.deepStrictEqual(api.tracker.groups.map((g) => g.map((t) => t.name)), [['left', 'zsh']]);
  assert.strictEqual(fake.vscode.window.activeTerminal, b, 'focus is back on the new split');
  assert.ok(!fake.executed.some(([id]) => /focusAtIndex|focusNext$/.test(id)), 'no full capture');
  api.deactivate();
});

test('a plain new terminal and a closed one never move focus to another terminal', async () => {
  const { fake, api } = await setup();
  const a = fake.vscode.window.createTerminal({ name: 'left' });
  a.show();
  const b = await fake.run('workbench.action.terminal.split');
  await api.activeView.ready;
  const seen = [];
  fake.vscode.window.onDidChangeActiveTerminal((t) => seen.push(t && t.name));
  const plain = fake.vscode.window.createTerminal({ name: 'plain' });
  plain.show();
  await new Promise((r) => setTimeout(r, 2000));
  assert.deepStrictEqual(seen, ['plain'], 'only the new terminal itself became active');
  const before = focusMoves(fake);
  b.dispose();
  await new Promise((r) => setTimeout(r, 2000));
  assert.strictEqual(focusMoves(fake), before, 'closing moves no focus');
  api.tracker.syncGroups();
  assert.deepStrictEqual(api.tracker.groups.map((g) => g.map((t) => t.name)), [['left'], ['plain']]);
  api.deactivate();
});

test('several terminals opened in a burst are placed by one capture after the quiet period', async () => {
  const { fake, api } = await setup();
  fake.vscode.window.createTerminal({ name: 'first' }).show();
  await api.activeView.ready;
  const start = fake.executed.length;
  fake.vscode.window.createTerminal({ name: 'x' }).show();
  await fake.run('workbench.action.terminal.split');
  await new Promise((r) => setTimeout(r, 1000));
  assert.ok(!fake.executed.slice(start).some(([id]) => /focus/.test(id)), 'nothing moves while events still arrive');
  await new Promise((r) => setTimeout(r, 2500));
  const scans = fake.executed.slice(start).filter(([id]) => id === 'workbench.action.terminal.focusAtIndex1').length;
  assert.strictEqual(scans, 1, 'exactly one capture');
  api.tracker.syncGroups();
  assert.deepStrictEqual(api.tracker.groups.map((g) => g.map((t) => t.name)), [['first'], ['x', 'zsh']]);
  api.deactivate();
});

test('a capture keeps the known order inside a split even when the right pane is older', async () => {
  const { fake, api } = await setup();
  await api.activeView.ready;
  const c = fake.vscode.window.createTerminal({ name: 'c' });
  const older = fake.vscode.window.createTerminal({ name: 'automation' });
  const newer = fake.vscode.window.createTerminal({ name: 'diwa' });
  fake.panes.length = 0;
  fake.panes.push([c], [newer, older]);
  api.tracker.groups = [[c], [newer, older]];
  older.show();
  c.show();
  await fake.run('claudeSessions.captureLayout');
  assert.deepStrictEqual(api.tracker.groups.map((g) => g.map((t) => t.name)), [['c'], ['diwa', 'automation']]);
  api.deactivate();
});

test('a status change redraws without re-reading the session list; a close re-reads it once', async () => {
  const id = '99999999-0000-0000-0000-000000000009';
  writeSession(id, 'status flip');
  const claude = startClaude(id);
  const { fake, api } = await setup();
  const t = fake.vscode.window.createTerminal({ name: 'flip', pid: claude.pid });
  t.show();
  await api.activeView.ready;
  await api.tracker.poll();
  await new Promise((r) => setTimeout(r, 80));
  await api.inactiveView.getChildren();
  let reads = 0;
  const original = api.inactiveView.inactiveSessions.bind(api.inactiveView);
  api.inactiveView.inactiveSessions = () => {
    reads++;
    return original();
  };
  fs.writeFileSync(path.join(registryDir, `${claude.pid}.json`), JSON.stringify({ pid: claude.pid, sessionId: id, cwd: workspace, status: 'busy' }));
  await api.tracker.poll();
  await new Promise((r) => setTimeout(r, 80));
  await api.inactiveView.getChildren();
  assert.strictEqual(reads, 0, 'busy/idle only redraws');
  stopClaude(claude);
  t.dispose();
  await new Promise((r) => setTimeout(r, 300));
  await api.inactiveView.getChildren();
  assert.strictEqual(reads, 1, 'a close re-reads the list once');
  api.deactivate();
});

test('a session that ends a little after its tab closed still moves to Inactive', async () => {
  const id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  writeSession(id, 'late exit');
  const claude = startClaude(id);
  const { fake, api } = await setup();
  const t = fake.vscode.window.createTerminal({ name: 'late', pid: claude.pid });
  t.show();
  await api.activeView.ready;
  await api.tracker.poll();
  t.dispose();
  await api.tracker.poll();
  await new Promise((r) => setTimeout(r, 80));
  const during = await api.inactiveView.getChildren();
  assert.ok(!during.some((i) => i.data && i.data.tab && i.data.tab.sessionId === id), 'still running, not yet inactive');
  stopClaude(claude);
  await api.tracker.poll();
  await new Promise((r) => setTimeout(r, 80));
  const after = await api.inactiveView.getChildren();
  assert.ok(after.some((i) => i.data && i.data.tab && i.data.tab.sessionId === id), 'listed once it ended');
  api.deactivate();
});

test('on a second machine, Connect Nextcloud brings the favorites into Inactive with their stars and names', async () => {
  const { createFakeNextcloud } = require('./fake-nextcloud');
  const { syncFavorites, projectDir } = require('../sync');
  const cloud = createFakeNextcloud();
  await cloud.start();
  const favorite = 'bbbbbbbb-0000-0000-0000-00000000000b';
  const other = 'cccccccc-0000-0000-0000-00000000000c';
  const machineA = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-flows-a-'));
  const wsA = path.join(machineA, 'code', path.basename(workspace));
  fs.mkdirSync(path.join(wsA, '.vscode'), { recursive: true });
  const homeB = process.env.HOME;
  try {
    process.env.HOME = machineA;
    const dirA = projectDir(wsA);
    fs.mkdirSync(dirA, { recursive: true });
    const at = new Date(Date.now() - 60000).toISOString();
    for (const [id, text] of [[favorite, 'kreil erp on machine a'], [other, 'not starred']]) {
      fs.writeFileSync(path.join(dirA, `${id}.jsonl`), `${JSON.stringify({ type: 'user', cwd: wsA, timestamp: at, message: { content: text } })}\n`);
    }
    fs.writeFileSync(path.join(wsA, '.vscode', 'claude-sessions.json'), JSON.stringify({ favorites: { [favorite]: true }, names: { [favorite]: 'kreil-erp' } }));
    await syncFavorites({ creds: cloud.creds(), wsPath: wsA, stateFile: path.join(wsA, '.vscode', 'claude-sessions.json') });
  } finally {
    process.env.HOME = homeB;
  }
  try {
    const { fake, api } = await setup();
    await api.activeView.ready;
    fake.onOpenExternal(() => cloud.approve());
    fake.inputAnswers.push(cloud.creds().server);
    await fake.run('claudeSessions.connectNextcloud');
    assert.match(fake.opened[0], /login\/v2\/flow/, 'the browser opens the Nextcloud login');
    assert.ok(fake.secretStore.get('claudeSessions.nextcloud'), 'the app password is kept in secret storage');
    assert.strictEqual(fake.config['sync.server'], cloud.creds().server);
    const row = await inactiveItemFor(api, favorite);
    assert.ok(row, 'the favorite from machine A is listed');
    assert.match(row.label, /^★ kreil-erp/);
    assert.ok(!(await inactiveItemFor(api, other)), 'sessions without a star stay on machine A');
    assert.ok(fake.messages.some((m) => /\d+ favorites · 1 down/.test(m)), fake.messages.join(' | '));
    api.deactivate();
  } finally {
    await cloud.stop();
  }
});

test('with a credentials file the plugin syncs on its own after start, without a login click', async () => {
  const { createFakeNextcloud } = require('./fake-nextcloud');
  const cloud = createFakeNextcloud();
  await cloud.start();
  const id = 'dddddddd-0000-0000-0000-00000000000d';
  writeSession(id, 'starred here');
  const stateFile = path.join(workspace, '.vscode', 'claude-sessions.json');
  const before = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ ...before, favorites: { ...(before.favorites || {}), [id]: true } }));
  const credFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-flows-cred-')), 'nextcloud.json');
  fs.writeFileSync(credFile, JSON.stringify(cloud.creds()));
  const fake = createFakeVscode({ workspacePath: workspace, globalStoragePath: fs.mkdtempSync(path.join(os.tmpdir(), 'claude-flows-gs-')) });
  fake.config['sync.credentialsFile'] = credFile;
  const api = fake.activate();
  try {
    await api.activeView.ready;
    await new Promise((r) => setTimeout(r, 4000));
    assert.ok(cloud.files.has(`Claude Sessions/${path.basename(workspace)}/${id}.jsonl`), 'the favorite was uploaded without any click');
    assert.strictEqual(fake.context.get('claudeSessions.syncConnected'), true);
  } finally {
    api.deactivate();
    await cloud.stop();
  }
});

test('a repository cannot redirect the sync: server and credentials file are machine settings', () => {
  const props = require('../package.json').contributes.configuration.properties;
  assert.strictEqual(props['claudeSessions.sync.credentialsFile'].scope, 'machine');
  assert.strictEqual(props['claudeSessions.sync.server'].scope, 'machine');
});

test('Disconnect stops the sync even when a credentials file was configured', async () => {
  const { createFakeNextcloud } = require('./fake-nextcloud');
  const cloud = createFakeNextcloud();
  await cloud.start();
  const credFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-flows-cred-')), 'nextcloud.json');
  fs.writeFileSync(credFile, JSON.stringify(cloud.creds()));
  const fake = createFakeVscode({ workspacePath: workspace, globalStoragePath: fs.mkdtempSync(path.join(os.tmpdir(), 'claude-flows-gs-')) });
  fake.config['sync.credentialsFile'] = credFile;
  fake.config['sync.auto'] = false;
  const api = fake.activate();
  try {
    await api.activeView.ready;
    await fake.run('claudeSessions.disconnectNextcloud');
    assert.strictEqual(fake.config['sync.credentialsFile'], undefined);
    assert.strictEqual(fake.context.get('claudeSessions.syncConnected'), false);
    const before = cloud.files.size;
    await fake.run('claudeSessions.syncNow');
    assert.strictEqual(cloud.files.size, before, 'nothing uploaded after disconnect');
    assert.ok(fake.messages.some((m) => /Connect Nextcloud first/.test(m)));
  } finally {
    api.deactivate();
    await cloud.stop();
  }
});

test('an update is installed once, not again every hour until the reload', async () => {
  const updater = require('../updater');
  const original = { latestRelease: updater.latestRelease, downloadRelease: updater.downloadRelease };
  updater.latestRelease = async () => ({ version: '99.0.0' });
  updater.downloadRelease = async () => path.join(os.tmpdir(), 'fake.vsix');
  try {
    const { fake, api } = await setup();
    await fake.run('claudeSessions.checkForUpdates');
    await fake.run('claudeSessions.checkForUpdates');
    assert.strictEqual(fake.executed.filter(([id]) => id === 'workbench.extensions.installExtension').length, 1);
    api.deactivate();
  } finally {
    Object.assign(updater, original);
  }
});

test('startup captures the splits before Active renders once', async () => {
  const fake = createFakeVscode({ workspacePath: workspace, globalStoragePath: fs.mkdtempSync(path.join(os.tmpdir(), 'claude-flows-gs-')) });
  const api = fake.activate();
  fake.vscode.window.createTerminal({ name: 'a' }).show();
  fake.vscode.window.createTerminal({ name: 'b', location: { parentTerminal: fake.vscode.window.terminals[0] } }).show();
  fake.vscode.window.createTerminal({ name: 'c' }).show();
  let fired = 0;
  api.activeView.onDidChangeTreeData(() => fired++);
  const rows = await api.activeView.getChildren();
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok(api.tracker.ready, 'startup finished before the first rows were returned');
  assert.ok(rows.length > 0);
  assert.ok(fired <= 2, `Active redrew ${fired} times during startup`);
  assert.strictEqual(rows.filter((r) => r.contextValue === 'split').length, 1, 'the first render already shows the split');
  assert.deepStrictEqual(api.tracker.groups.map((g) => g.map((t) => t.name)), [['a', 'b'], ['c']]);
  assert.strictEqual(fake.vscode.window.activeTerminal.name, 'c', 'focus returns to where it was');
  api.deactivate();
});

test('seeding from the saved layout splits terminals in order and ignores a layout that does not fit', () => {
  const fake = createFakeVscode({ workspacePath: workspace, globalStoragePath: workspace });
  const api = fake.activate();
  for (const name of ['a', 'b', 'c']) fake.vscode.window.createTerminal({ name });
  assert.strictEqual(api.tracker.seedGroups([2, 2]), false);
  assert.strictEqual(api.tracker.seedGroups([2, 1]), true);
  assert.deepStrictEqual(api.tracker.groups.map((g) => g.map((t) => t.name)), [['a', 'b'], ['c']]);
  api.deactivate();
});

test('a burst of refreshes redraws a view once', async () => {
  const { api } = await setup();
  let fired = 0;
  api.inactiveView.onDidChangeTreeData(() => fired++);
  for (let i = 0; i < 20; i++) api.inactiveView.refresh(i % 2 === 0);
  await new Promise((r) => setTimeout(r, 120));
  assert.strictEqual(fired, 1);
  assert.strictEqual(api.inactiveView.needsFull, true, 'a full refresh in the burst is kept');
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
  assert.ok(!reopened.sent.some((s) => s.includes('claude-remote-run')), 'without the service the tab runs claude itself');

  const runner = path.join(process.env.HOME, '.local', 'bin', 'claude-remote-run');
  fs.mkdirSync(path.dirname(runner), { recursive: true });
  fs.writeFileSync(runner, '#!/bin/sh\n', { mode: 0o755 });
  await fake.run('claudeSessions.resumeNewTab', closed);
  const viaService = fake.vscode.window.terminals.filter((x) => x.sent.some((s) => s.includes(`'${runner}' claude --resume ${id}`)));
  assert.strictEqual(viaService.length, 1, 'with the service installed the tab starts the session there and attaches');
  fake.config['remote.runInService'] = false;
  await fake.run('claudeSessions.resumeNewTab', closed);
  assert.strictEqual(fake.vscode.window.terminals.filter((x) => x.sent.some((s) => s.includes('claude-remote-run'))).length, 1, 'the setting turns it off');
  delete fake.config['remote.runInService'];
  fs.rmSync(runner);
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

test('a session locked by another machine shows its lock and resumes only after an explicit override', async () => {
  const id = '77777777-0000-0000-0000-000000000007';
  writeSession(id, 'locked elsewhere');
  const { fake, api } = await setup();
  const { writeStatePatch } = require('../sessions');
  writeStatePatch(api.store.file(), { sync: { locks: { [id]: { machine: 'user@other-mac', since: Date.now(), heartbeat: Date.now() } } } });
  const item = await inactiveItemFor(api, id);
  assert.match(item.description, /🔒 user@other-mac/);

  const sentFor = () => fake.vscode.window.terminals.filter((x) => x.sent.some((s) => s.includes(`--resume ${id}`)));
  fake.warningAnswers.push(undefined);
  await fake.run('claudeSessions.resumeNewTab', item);
  assert.strictEqual(sentFor().length, 0, 'cancelling the warning resumes nothing');

  fake.warningAnswers.push('Resume here anyway');
  await fake.run('claudeSessions.resumeNewTab', item);
  assert.strictEqual(sentFor().length, 1, 'the explicit override resumes');
  api.deactivate();
});

test('Remote lists every machine, loads an uploaded session and requests one that is not uploaded yet', async () => {
  const { createFakeNextcloud } = require('./fake-nextcloud');
  const { heartbeat } = require('../sync');
  const cloud = createFakeNextcloud();
  await cloud.start();
  const base = `Claude Sessions/${path.basename(workspace)}`;
  const uploadedId = 'eeeeeeee-0000-0000-0000-00000000000e';
  const pendingId = 'ffffffff-0000-0000-0000-00000000000f';
  const at = new Date(Date.now() - 60000).toISOString();
  const body = `${JSON.stringify({ type: 'user', cwd: workspace, timestamp: at, message: { content: 'from the studio' } })}\n`;
  cloud.files.set(`${base}/${uploadedId}.jsonl`, { body: Buffer.from(body), mtime: Math.floor(Date.now() / 1000) - 60 });
  const studioWs = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-flows-studio-')), path.basename(workspace));
  fs.mkdirSync(path.join(studioWs, '.vscode'), { recursive: true });
  await heartbeat({
    creds: cloud.creds(),
    wsPath: studioWs,
    stateFile: path.join(studioWs, '.vscode', 'claude-sessions.json'),
    machine: 'studio#1',
    name: 'Mac Studio',
    sessions: [
      { id: uploadedId, name: 'uploaded-one', lastActivity: at, running: false, favorite: true },
      { id: pendingId, name: 'pending-one', lastActivity: new Date().toISOString(), running: true, favorite: false },
    ],
  });
  const credFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-flows-cred-')), 'nextcloud.json');
  fs.writeFileSync(credFile, JSON.stringify(cloud.creds()));
  process.env.CLAUDE_SESSIONS_MACHINE = 'book#2';
  const fake = createFakeVscode({ workspacePath: workspace, globalStoragePath: fs.mkdtempSync(path.join(os.tmpdir(), 'claude-flows-gs-')) });
  fake.config['sync.credentialsFile'] = credFile;
  fake.config['sync.auto'] = false;
  fake.config.machineName = 'MacBook';
  const api = fake.activate();
  try {
    await api.activeView.ready;
    await fake.run('claudeSessions.syncNow');
    const machines = await api.remoteView.getChildren();
    assert.deepStrictEqual(machines.map((m) => m.label), ['MacBook', 'Mac Studio'], 'this machine first, then the others');
    assert.match(machines[0].description, /^(synced .*|never synced) · this machine$/);
    assert.strictEqual(machines[1].collapsibleState, fake.vscode.TreeItemCollapsibleState.Expanded);
    assert.ok(cloud.files.has(`${base}/machines/book_2.json`), 'this machine registered itself');
    const rows = await api.remoteView.getChildren(machines[1]);
    const uploaded = rows.find((r) => r.data.remote.id === uploadedId);
    const pending = rows.find((r) => r.data.remote.id === pendingId);
    assert.match(uploaded.description, /^synced .* · active /, 'the row says when it was last synced, then its last activity');
    assert.match(uploaded.tooltip, /Last synced: /);
    assert.deepStrictEqual(rows.map((r) => r.data.remote.id), [uploadedId, pendingId], 'favorites first');
    assert.strictEqual(pending.description, 'not synced · active just now');
    assert.strictEqual(pending.contextValue, 'remoteSession');

    await fake.run('claudeSessions.loadRemote', uploaded);
    assert.ok(fs.existsSync(path.join(projectDir, `${uploadedId}.jsonl`)), 'the uploaded session is downloaded');
    assert.strictEqual(fs.readFileSync(path.join(projectDir, `${uploadedId}.jsonl`), 'utf8'), body, 'byte-identical');
    assert.ok(api.notifications.isFavorite(uploadedId), 'a loaded session is starred, so it keeps syncing');
    assert.ok(fake.messages.some((m) => /"uploaded-one" from Mac Studio is on this machine now/.test(m)), fake.messages.join(' | '));
    const syncingFlags = fake.executed.filter(([id, key]) => id === 'setContext' && key === 'claudeSessions.syncing').map(([, , v]) => v);
    assert.deepStrictEqual(syncingFlags.slice(0, 2), [true, false], 'the sync button spins while the sync runs');
    const after = await api.remoteView.getChildren((await api.remoteView.getChildren())[1]);
    assert.strictEqual(after.find((r) => r.data.remote.id === uploadedId).contextValue, 'remoteSession.here');

    await fake.run('claudeSessions.loadRemote', pending);
    const request = JSON.parse(cloud.files.get(`${base}/requests/${pendingId}.json`).body);
    assert.deepStrictEqual([request.from, request.by, request.name], ['studio#1', 'book#2', 'pending-one']);
    assert.ok(api.notifications.isFavorite(pendingId));
    assert.ok(fake.messages.some((m) => /Requested "pending-one" from Mac Studio/.test(m)));
    const requested = (await api.remoteView.getChildren((await api.remoteView.getChildren())[1])).find((r) => r.data.remote.id === pendingId);
    assert.match(requested.description, /^not synced · requested · active /);
  } finally {
    api.deactivate();
    delete process.env.CLAUDE_SESSIONS_MACHINE;
    await cloud.stop();
  }
});

test('the machine name is asked once after start and lands in the register', async () => {
  const { createFakeNextcloud } = require('./fake-nextcloud');
  const cloud = createFakeNextcloud();
  await cloud.start();
  const credFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-flows-cred-')), 'nextcloud.json');
  fs.writeFileSync(credFile, JSON.stringify(cloud.creds()));
  process.env.CLAUDE_SESSIONS_MACHINE = 'fresh#3';
  const fake = createFakeVscode({ workspacePath: workspace, globalStoragePath: fs.mkdtempSync(path.join(os.tmpdir(), 'claude-flows-gs-')) });
  fake.config['sync.credentialsFile'] = credFile;
  fake.inputAnswers.push('Mac Studio Office');
  const api = fake.activate();
  try {
    await api.activeView.ready;
    await new Promise((r) => setTimeout(r, 4500));
    assert.strictEqual(fake.config.machineName, 'Mac Studio Office');
    const entry = JSON.parse(cloud.files.get(`Claude Sessions/${path.basename(workspace)}/machines/fresh_3.json`).body);
    assert.strictEqual(entry.name, 'Mac Studio Office');
    assert.ok(Array.isArray(entry.sessions) && entry.sessions.length > 0, 'the register lists this machine\'s sessions');
  } finally {
    api.deactivate();
    delete process.env.CLAUDE_SESSIONS_MACHINE;
    await cloud.stop();
  }
});

test('a session another machine requests is uploaded by this machine\'s next check and the request is closed', async () => {
  const { createFakeNextcloud } = require('./fake-nextcloud');
  const { requestSession, syncFavorites } = require('../sync');
  const cloud = createFakeNextcloud();
  await cloud.start();
  const base = `Claude Sessions/${path.basename(workspace)}`;
  const wanted = '99999999-0000-0000-0000-000000000009';
  writeSession(wanted, 'wanted on the other machine');
  const credFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-flows-cred-')), 'nextcloud.json');
  fs.writeFileSync(credFile, JSON.stringify(cloud.creds()));
  process.env.CLAUDE_SESSIONS_MACHINE = 'owner#4';
  const fake = createFakeVscode({ workspacePath: workspace, globalStoragePath: fs.mkdtempSync(path.join(os.tmpdir(), 'claude-flows-gs-')) });
  fake.config['sync.credentialsFile'] = credFile;
  fake.config['sync.auto'] = false;
  fake.config.machineName = 'Owner';
  const api = fake.activate();
  try {
    await api.activeView.ready;
    await fake.run('claudeSessions.syncNow');
    const otherWs = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-flows-req-')), path.basename(workspace));
    fs.mkdirSync(path.join(otherWs, '.vscode'), { recursive: true });
    const other = { creds: cloud.creds(), wsPath: otherWs, stateFile: path.join(otherWs, '.vscode', 'claude-sessions.json'), machine: 'asker#5' };
    const askerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-flows-asker-'));
    const asAsker = async (fn) => {
      process.env.HOME = askerHome;
      try {
        return await fn();
      } finally {
        process.env.HOME = home;
      }
    };
    await asAsker(() => requestSession({ ...other, id: wanted, from: 'owner#4', name: 'wanted' }));
    await asAsker(() => syncFavorites(other));
    assert.ok(!cloud.files.has(`${base}/${wanted}.jsonl`), 'not uploaded before the owner checks');
    await fake.run('claudeSessions.syncNow');
    assert.ok(cloud.files.has(`${base}/${wanted}.jsonl`), 'the owner uploaded it');
    assert.ok(!cloud.files.has(`${base}/requests/${wanted}.json`), 'the request is closed');
    assert.ok(api.notifications.isFavorite(wanted), 'the star from the asking machine arrived here');
    const got = await asAsker(() => syncFavorites(other));
    assert.deepStrictEqual(got.downloaded, [wanted], 'the asking machine receives it on its next sync');
  } finally {
    api.deactivate();
    delete process.env.CLAUDE_SESSIONS_MACHINE;
    await cloud.stop();
  }
});

test('a request is closed only once its session is in Nextcloud; one this machine does not have is dropped', async () => {
  const { createFakeNextcloud } = require('./fake-nextcloud');
  const { requestSession, syncFavorites } = require('../sync');
  const cloud = createFakeNextcloud();
  await cloud.start();
  const base = `Claude Sessions/${path.basename(workspace)}`;
  const kept = '88888888-0000-0000-0000-000000000008';
  const unknown = '77777777-0000-0000-0000-000000000007';
  writeSession(kept, 'upload fails at first');
  const credFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-flows-cred-')), 'nextcloud.json');
  fs.writeFileSync(credFile, JSON.stringify(cloud.creds()));
  process.env.CLAUDE_SESSIONS_MACHINE = 'owner#6';
  const fake = createFakeVscode({ workspacePath: workspace, globalStoragePath: fs.mkdtempSync(path.join(os.tmpdir(), 'claude-flows-gs-')) });
  fake.config['sync.credentialsFile'] = credFile;
  fake.config['sync.auto'] = false;
  fake.config.machineName = 'Owner';
  const api = fake.activate();
  const askerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-flows-asker-'));
  const otherWs = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-flows-req-')), path.basename(workspace));
  fs.mkdirSync(path.join(otherWs, '.vscode'), { recursive: true });
  const other = { creds: cloud.creds(), wsPath: otherWs, stateFile: path.join(otherWs, '.vscode', 'claude-sessions.json'), machine: 'asker#7' };
  const asAsker = async (fn) => {
    process.env.HOME = askerHome;
    try {
      return await fn();
    } finally {
      process.env.HOME = home;
    }
  };
  try {
    await api.activeView.ready;
    await asAsker(() => requestSession({ ...other, id: kept, from: 'owner#6', name: 'kept' }));
    await asAsker(() => requestSession({ ...other, id: unknown, from: 'owner#6', name: 'unknown' }));
    await asAsker(() => syncFavorites(other));
    cloud.options.failKey = `${base}/${kept}.jsonl`;
    await fake.run('claudeSessions.syncNow');
    assert.ok(cloud.files.has(`${base}/requests/${kept}.json`), 'a request whose upload failed stays open');
    assert.ok(!cloud.files.has(`${base}/requests/${unknown}.json`), 'a request for a session this machine does not have is dropped');
    cloud.options.failKey = null;
    await fake.run('claudeSessions.syncNow');
    assert.ok(cloud.files.has(`${base}/${kept}.jsonl`), 'the next check uploads it');
    assert.ok(!cloud.files.has(`${base}/requests/${kept}.json`), 'and closes the request');
  } finally {
    api.deactivate();
    delete process.env.CLAUDE_SESSIONS_MACHINE;
    await cloud.stop();
  }
});

test('loading a remote session while a sync runs waits for it instead of doing nothing', async () => {
  const { createFakeNextcloud } = require('./fake-nextcloud');
  const { heartbeat } = require('../sync');
  const cloud = createFakeNextcloud();
  await cloud.start();
  const base = `Claude Sessions/${path.basename(workspace)}`;
  const id = '66666666-0000-0000-0000-000000000006';
  const body = `${JSON.stringify({ type: 'user', cwd: workspace, timestamp: new Date().toISOString(), message: { content: 'late' } })}\n`;
  const studioWs = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-flows-studio-')), path.basename(workspace));
  fs.mkdirSync(path.join(studioWs, '.vscode'), { recursive: true });
  await heartbeat({ creds: cloud.creds(), wsPath: studioWs, stateFile: path.join(studioWs, '.vscode', 'claude-sessions.json'), machine: 'studio#8', name: 'Studio', sessions: [{ id, name: 'late-one', lastActivity: new Date().toISOString() }] });
  cloud.files.set(`${base}/${id}.jsonl`, { body: Buffer.from(body), mtime: Math.floor(Date.now() / 1000) });
  const credFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-flows-cred-')), 'nextcloud.json');
  fs.writeFileSync(credFile, JSON.stringify(cloud.creds()));
  process.env.CLAUDE_SESSIONS_MACHINE = 'book#9';
  const fake = createFakeVscode({ workspacePath: workspace, globalStoragePath: fs.mkdtempSync(path.join(os.tmpdir(), 'claude-flows-gs-')) });
  fake.config['sync.credentialsFile'] = credFile;
  fake.config['sync.auto'] = false;
  fake.config.machineName = 'Book';
  const api = fake.activate();
  try {
    await api.activeView.ready;
    await fake.run('claudeSessions.syncNow');
    const studio = (await api.remoteView.getChildren()).find((m) => m.label === 'Studio');
    const row = (await api.remoteView.getChildren(studio)).find((r) => r.data.remote.id === id);
    const slow = '55555555-0000-0000-0000-000000000005';
    writeSession(slow, 'slow upload keeps the first sync busy');
    api.notifications.setFavorite(slow, true);
    cloud.options.slowPut = { suffix: `${slow}.jsonl`, ms: 1500 };
    const running = fake.run('claudeSessions.syncNow');
    await new Promise((r) => setTimeout(r, 500));
    await fake.run('claudeSessions.loadRemote', row);
    await running;
    cloud.options.slowPut = null;
    assert.ok(fs.existsSync(path.join(projectDir, `${id}.jsonl`)), 'downloaded after the running sync finished');
  } finally {
    api.deactivate();
    delete process.env.CLAUDE_SESSIONS_MACHINE;
    await cloud.stop();
  }
});

test('a session that already runs in a tab of this window is focused instead of resumed a second time', async () => {
  const id = '99999999-0000-0000-0000-000000000009';
  writeSession(id, 'already running here');
  const claude = startClaude(id);
  const { fake, api } = await setup();
  try {
    const running = fake.vscode.window.createTerminal({ name: 'running', pid: claude.pid });
    running.show();
    await api.tracker.poll();
    const other = fake.vscode.window.createTerminal({ name: 'other', pid: 999999 });
    other.show();
    const before = fake.vscode.window.terminals.length;
    const item = { data: { tab: { name: 'running', sessionId: id, cwd: workspace } } };
    await fake.run('claudeSessions.resume', item);
    assert.strictEqual(fake.vscode.window.activeTerminal, running, '▶ focuses the tab that holds the session');
    await fake.run('claudeSessions.resumeNewTab', item);
    assert.strictEqual(fake.vscode.window.terminals.length, before, 'no second tab is opened');
    const typed = fake.vscode.window.terminals.flatMap((t) => t.sent);
    assert.ok(!typed.some((s) => s.includes(id)), 'nothing resumes the running session again');
    assert.deepStrictEqual(fake.messages, []);
  } finally {
    stopClaude(claude);
    api.deactivate();
  }
});

test('a session running in another process without a tab here is reported, not resumed', async () => {
  const id = '99999999-0000-0000-0000-000000000010';
  writeSession(id, 'running elsewhere');
  const claude = startClaude(id);
  const { fake, api } = await setup();
  try {
    const shell = fake.vscode.window.createTerminal({ name: 'zsh', pid: 999999 });
    shell.show();
    await api.tracker.poll();
    await fake.run('claudeSessions.resume', { data: { tab: { name: 'elsewhere', sessionId: id, cwd: workspace } } });
    assert.strictEqual(shell.sent.length, 0, 'nothing is typed into the active terminal');
    assert.strictEqual(fake.vscode.window.terminals.length, 1);
    assert.strictEqual(fake.messages.length, 1);
    assert.match(fake.messages[0], /already runs in another process/);
  } finally {
    stopClaude(claude);
    api.deactivate();
  }
});

test('Open remote sessions explains the missing address, then loads the local web app under a strict CSP', async () => {
  const { fake, api } = await setup();
  try {
    await fake.run('claudeSessions.openRemote');
    assert.strictEqual(fake.webviewPanels.length, 1);
    const panel = fake.webviewPanels[0];
    assert.match(panel.webview.html, /claudeSessions\.remote\.url/);
    assert.match(panel.webview.html, /connect-src 'none'/);
    assert.ok(fake.messages.some((m) => /claudeSessions\.remote\.url/.test(m)));
    assert.ok(panel.options.enableScripts && panel.options.retainContextWhenHidden);
    assert.match(panel.options.localResourceRoots[0].fsPath, /remote[\\/]web$/);
    panel.dispose();

    fake.config['remote.url'] = 'ws://remote.example:39180/ws';
    await fake.run('claudeSessions.openRemote');
    assert.strictEqual(fake.webviewPanels.length, 2);
    const live = fake.webviewPanels[1];
    const html = live.webview.html;
    assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src https:\/\/fake\.webview\.invalid; style-src https:\/\/fake\.webview\.invalid 'unsafe-inline'; img-src https:\/\/fake\.webview\.invalid data:; font-src https:\/\/fake\.webview\.invalid; connect-src ws:\/\/remote\.example:39180">/);
    assert.match(html, /<html lang="en" data-ws-url="ws:\/\/remote\.example:39180\/ws">/);
    assert.ok(!/\b(src|href)="(?!https:\/\/fake\.webview\.invalid)[^"]*"/.test(html.replace(/http-equiv="[^"]*"/g, '')), 'every asset reference points into the webview origin');
    assert.match(html, /src="https:\/\/fake\.webview\.invalid[^"]*remote[\\/]web[\\/]vscode-bridge\.js"/);
    assert.strictEqual((html.match(/vscode-bridge\.js/g) || []).length, 1, 'the bridge is loaded once');
    assert.ok(!/manifest\.webmanifest/.test(html));
    assert.ok(!/script-src[^;]*'unsafe-inline'/.test(html));

    live.receive({ t: 'setToken', id: 1, token: 'device-token-1' });
    await settle();
    const key = 'claudeSessions.remote.token:ws://remote.example:39180';
    assert.strictEqual(fake.secretStore.get(key), 'device-token-1');
    assert.strictEqual(fake.secretStore.has('claudeSessions.remote.token'), false, 'tokens are kept per service origin');
    live.receive({ t: 'getToken', id: 2 });
    await settle();
    assert.deepStrictEqual(live.posted.slice(-1), [{ t: 'reply', id: 2, value: 'device-token-1' }]);
    fake.config['remote.url'] = 'ws://other.example:39180/ws';
    live.receive({ t: 'getToken', id: 21 });
    await settle();
    assert.deepStrictEqual(live.posted.slice(-1), [{ t: 'reply', id: 21, value: null }], 'another service never gets this token');
    fake.config['remote.url'] = 'ws://remote.example:39180/ws';
    live.receive({ t: 'setToken', id: 22, token: 'peer-token', origin: 'wss://studio.tail0.example.test' });
    await settle();
    assert.strictEqual(fake.secretStore.get('claudeSessions.remote.token:wss://studio.tail0.example.test'), 'peer-token', 'a peer hub keeps its own token');
    live.receive({ t: 'getToken', id: 23, origin: 'wss://studio.tail0.example.test' });
    await settle();
    assert.deepStrictEqual(live.posted.slice(-1), [{ t: 'reply', id: 23, value: 'peer-token' }]);
    live.receive({ t: 'getToken', id: 24, origin: 'javascript:alert(1)' });
    await settle();
    assert.deepStrictEqual(live.posted.slice(-1), [{ t: 'reply', id: 24, value: 'device-token-1' }], 'an invalid origin falls back to the configured service');
    live.receive({ t: 'setToken', id: 3, token: null });
    await settle();
    assert.strictEqual(fake.secretStore.has(key), false);
    live.receive({ t: 'nonsense', id: 4 });
    await settle();
    assert.match(live.posted.slice(-1)[0].error, /unknown request/);

    await fake.run('claudeSessions.openRemote');
    assert.strictEqual(fake.webviewPanels.length, 2, 'a second call reveals the open panel');
    assert.strictEqual(live.revealed, 1);
  } finally {
    api.deactivate();
  }
});

test('Attach to a service session opens a terminal tab attached to that tmux session, and reuses it', async () => {
  const { execFileSync } = require('child_process');
  const tmux = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((f) => fs.existsSync(f));
  if (!tmux) return;
  const socket = `test-attach-${process.pid}`;
  execFileSync(tmux, ['-L', socket, 'new-session', '-d', '-s', 'cc-alpha', '--', '/bin/sh', '-c', 'sleep 30']);
  execFileSync(tmux, ['-L', socket, 'new-session', '-d', '-s', 'cc-beta', '--', '/bin/sh', '-c', 'sleep 30']);
  const { fake, api } = await setup();
  try {
    fake.config['remote.tmuxSocket'] = socket;
    fake.quickPickAnswers.push((i) => i.label === 'cc-beta');
    await fake.run('claudeSessions.attachRemote');
    const t = fake.vscode.window.terminals.find((x) => x.name === 'cc-beta');
    assert.ok(t, 'terminal for cc-beta');
    assert.deepStrictEqual(t.creationOptions.shellArgs, ['-u', '-L', socket, 'attach', '-t', '=cc-beta']);
    const before = fake.vscode.window.terminals.length;
    fake.quickPickAnswers.push((i) => i.label === 'cc-beta');
    await fake.run('claudeSessions.attachRemote');
    assert.strictEqual(fake.vscode.window.terminals.length, before);

    fake.config['remote.tmuxSocket'] = `${socket}-none`;
    await fake.run('claudeSessions.attachRemote');
    assert.ok(fake.messages.some((m) => /No service sessions run on this machine/.test(m)));
  } finally {
    try { execFileSync(tmux, ['-L', socket, 'kill-server']); } catch {}
    api.deactivate();
  }
});

test('the remote panel may connect to peer hubs under the same tailnet domain', async () => {
  const { fake, api } = await setup();
  try {
    fake.config['remote.url'] = 'wss://laptop.tail0.example.test/ws';
    await fake.run('claudeSessions.openRemote');
    const html = fake.webviewPanels[0].webview.html;
    assert.match(html, /connect-src wss:\/\/laptop\.tail0\.example\.test wss:\/\/\*\.tail0\.example\.test:\*"/);
  } finally {
    api.deactivate();
  }
});

test('a recent session of another machine loads with one click, without a request, and is starred here', async () => {
  const { createFakeNextcloud } = require('./fake-nextcloud');
  const { heartbeat } = require('../sync');
  const cloud = createFakeNextcloud();
  await cloud.start();
  const base = `Claude Sessions/${path.basename(workspace)}`;
  const id = '33333333-0000-0000-0000-00000000000c';
  const own = '33333333-0000-0000-0000-00000000000d';
  writeSession(own, 'only on this machine', 1);
  const body = `${JSON.stringify({ type: 'user', cwd: workspace, timestamp: new Date().toISOString(), message: { content: 'recent on the studio' } })}\n`;
  const studioWs = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-flows-studio-')), path.basename(workspace));
  fs.mkdirSync(path.join(studioWs, '.vscode'), { recursive: true });
  await heartbeat({ creds: cloud.creds(), wsPath: studioWs, stateFile: path.join(studioWs, '.vscode', 'claude-sessions.json'), machine: 'studio#c', name: 'Studio C', sessions: [{ id, name: 'recent-one', lastActivity: new Date().toISOString() }] });
  const { WebDav } = require('../sync');
  const dav = new WebDav(cloud.creds());
  const recentParts = ['Claude Sessions', path.basename(workspace), 'recent', 'studio_c'];
  await dav.ensureFolder(recentParts);
  await dav.put([...recentParts, `${id}.jsonl`], Buffer.from(body), Math.floor(Date.now() / 1000));
  const credFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-flows-cred-')), 'nextcloud.json');
  fs.writeFileSync(credFile, JSON.stringify(cloud.creds()));
  process.env.CLAUDE_SESSIONS_MACHINE = 'book#d';
  const fake = createFakeVscode({ workspacePath: workspace, globalStoragePath: fs.mkdtempSync(path.join(os.tmpdir(), 'claude-flows-gs-')) });
  fake.config['sync.credentialsFile'] = credFile;
  fake.config['sync.auto'] = false;
  fake.config.machineName = 'Book D';
  const api = fake.activate();
  try {
    await api.activeView.ready;
    await fake.run('claudeSessions.syncNow');
    const studio = (await api.remoteView.getChildren()).find((m) => m.label === 'Studio C');
    const row = (await api.remoteView.getChildren(studio)).find((r) => r.data.remote.id === id);
    assert.match(row.description, /^synced /);
    await fake.run('claudeSessions.loadRemote', row);
    assert.strictEqual(fs.readFileSync(path.join(projectDir, `${id}.jsonl`), 'utf8'), body, 'byte-identical');
    assert.ok(api.notifications.isFavorite(id));
    assert.ok(!cloud.files.has(`${base}/requests/${id}.json`), 'no request needed');
    assert.ok(cloud.files.has(`${base}/${id}.jsonl`), 'as a favorite it is shared both ways from now on');
    assert.ok(fake.messages.some((m) => /"recent-one" from Studio C is on this machine now/.test(m)), fake.messages.join(' | '));
    assert.ok(cloud.files.has(`${base}/recent/book_d/${own}.jsonl`), 'this machine uploads its own recent sessions');
  } finally {
    api.deactivate();
    delete process.env.CLAUDE_SESSIONS_MACHINE;
    await cloud.stop();
  }
});

test('the refresh button in Active checks the split layout again and returns focus', async () => {
  const { fake, api } = await setup();
  await api.activeView.ready;
  const a = fake.vscode.window.createTerminal({ name: 'a' });
  const b = fake.vscode.window.createTerminal({ name: 'b' });
  const c = fake.vscode.window.createTerminal({ name: 'c' });
  fake.panes.length = 0;
  fake.panes.push([a, b], [c]);
  api.tracker.groups = [[a], [b], [c]];
  c.show();
  await fake.run('claudeSessions.refreshActive');
  assert.deepStrictEqual(api.tracker.groups.map((g) => g.map((t) => t.name)), [['a', 'b'], ['c']]);
  assert.strictEqual(fake.vscode.window.activeTerminal, c, 'focus returns to where it was');
  const menu = require('../package.json').contributes.menus['view/title'];
  assert.ok(menu.some((m) => m.command === 'claudeSessions.refreshActive' && /view == claudeSessions\.active/.test(m.when)), 'Active shows this refresh');
  assert.ok(!menu.some((m) => m.command === 'claudeSessions.refresh' && /claudeSessions\.active/.test(m.when)), 'not the plain one');
  api.deactivate();
});
