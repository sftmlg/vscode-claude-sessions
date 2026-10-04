'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const { tempHome, testCtx, killServer, capture, waitFor, FAKE_CLAUDE } = require('./fixtures/fs-helpers');

const home = tempHome('remote-registry-');
process.env.HOME = home;
delete process.env.CLAUDE_CONFIG_DIR;
const { Registry, realUnder, UUID_RE } = require('../registry');
const { displayTitle } = require('../catalog');

const work = path.join(home, 'work');
const sessionsDir = path.join(home, '.claude-a', 'sessions');
fs.mkdirSync(path.join(work, 'proj'), { recursive: true });
fs.mkdirSync(sessionsDir, { recursive: true });
const ID1 = '11111111-2222-4333-8444-555555555555';
const ID2 = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const ID3 = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

function writePid(pid, fields) {
  fs.writeFileSync(path.join(sessionsDir, `${pid}.json`), JSON.stringify({ pid, procStart: 'start-1', cwd: work, status: 'idle', ...fields }));
}

function sleeper(args = ['300']) {
  const p = spawn('sleep', args, { stdio: 'ignore' });
  return p;
}

test('realUnder accepts only real directories inside a root', async () => {
  assert.strictEqual(await realUnder(path.join(work, 'proj'), [work]), path.join(work, 'proj'));
  assert.strictEqual(await realUnder(work, [work]), work);
  assert.strictEqual(await realUnder(path.join(work, '..', '..'), [work]), null);
  assert.strictEqual(await realUnder('/etc', [work]), null);
  assert.strictEqual(await realUnder(path.join(work, '$(touch x)'), [work]), null);
  fs.symlinkSync('/tmp', path.join(work, 'escape'));
  assert.strictEqual(await realUnder(path.join(work, 'escape'), [work]), null);
});

test('registry on a throwaway socket', async (t) => {
  const ctx = testCtx();
  const audits = [];
  const config = { stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'reg-state-')), roots: [work], defaultDir: work, launcher: [], claudeCommand: ['/bin/sh', FAKE_CLAUDE], claudeArgs: ['--flag'] };
  const reg = new Registry(config, { ctx, audit: (action, f) => audits.push({ action, ...f }), exitWaitMs: 500 });
  const procs = [];
  t.after(() => {
    reg.stop();
    killServer(ctx);
    for (const p of procs) try { p.kill('SIGKILL'); } catch {}
  });

  const outside = sleeper();
  procs.push(outside);
  writePid(outside.pid, { sessionId: ID1, name: 'Demo task' });

  await t.test('lists running claude sessions outside tmux as unmanaged', async () => {
    await reg.start();
    const item = reg.listAll().find((i) => i.sessionId === ID1);
    assert.ok(item);
    assert.strictEqual(item.managed, false);
    assert.strictEqual(item.pid, outside.pid);
    assert.strictEqual(item.slot, '.claude-a');
    assert.strictEqual(item.title, 'Demo task');
    assert.strictEqual(item.status, 'idle');
    assert.ok(Math.abs(Date.parse(item.lastActivity) - Date.now()) < 60000, 'without a transcript the pid file dates the session');
    assert.strictEqual(reg.resolve(ID1), item);
  });

  await t.test('dead pids are not listed', async () => {
    writePid(999999, { sessionId: ID3 });
    await reg.refresh();
    assert.strictEqual(reg.listAll().some((i) => i.sessionId === ID3), false);
    fs.rmSync(path.join(sessionsDir, '999999.json'));
  });

  await t.test('new session validates name, dir, resume id and live owner', async () => {
    const bad = async (args, code) => assert.rejects(reg.newSession(args), (e) => e.code === code);
    await bad({ name: 'cc-x;kill-server', dir: work }, 'bad-name');
    await bad({ name: 'cc-x', dir: '/etc' }, 'dir-not-allowed');
    await bad({ name: 'cc-x', dir: path.join(work, '../..') }, 'dir-not-allowed');
    await bad({ name: 'cc-x', dir: `${work}/$(touch ${work}/pwn)` }, 'dir-not-allowed');
    await bad({ name: 'cc-x', dir: work, resumeId: '../../etc' }, 'bad-resume-id');
    await bad({ name: 'cc-x', dir: work, resumeId: ID1 }, 'session-running');
    assert.strictEqual(fs.existsSync(path.join(work, 'pwn')), false);
  });

  await t.test('new session runs launcher + command + args in the chosen dir', async () => {
    await reg.newSession({ name: 'cc-new', dir: path.join(work, 'proj') }, { device: { id: 'dev-1' } });
    await waitFor(() => capture(ctx, 'cc-new').includes('fake-claude args: [--flag]'), { what: 'args' });
    const item = reg.listAll().find((i) => i.name === 'cc-new');
    assert.strictEqual(item.managed, true);
    assert.strictEqual(item.status, 'none');
    assert.strictEqual(item.cwd, path.join(work, 'proj'));
    assert.ok(audits.some((a) => a.action === 'new' && a.name === 'cc-new' && a.device === 'dev-1'));
    await assert.rejects(reg.newSession({ name: 'cc-new', dir: work }), (e) => e.code === 'name-taken');
  });

  await t.test('a typed title names the tmux session and shows until the transcript has a better one', async () => {
    const r = await reg.newSession({ title: 'Invoice export: Q3 ü', dir: work });
    assert.strictEqual(r.name, 'cc-invoice-export-q3-ue');
    const item = reg.listAll().find((i) => i.name === r.name);
    assert.strictEqual(item.title, 'Invoice export: Q3 ü');
    const again = await reg.newSession({ title: 'Invoice export: Q3 ü', dir: work });
    assert.notStrictEqual(again.name, r.name);
    await assert.rejects(reg.newSession({ title: 'x'.repeat(200), dir: work }), (e) => e.code === 'bad-title');
    const blank = await reg.newSession({ title: '', dir: work });
    assert.match(blank.name, /^cc-[a-z0-9-]+$/);
    assert.strictEqual(displayTitle({ firstPrompt: 'first words' }, 'auto', 'Typed'), 'Typed');
    assert.strictEqual(displayTitle({ aiTitle: 'AI title', firstPrompt: 'first words' }, 'auto', 'Typed'), 'Typed');
    assert.strictEqual(displayTitle({ customTitle: 'Renamed', aiTitle: 'AI title' }, 'auto', 'Typed'), 'Renamed');
    const umlaut = await reg.newSession({ title: 'E2E Rückkehr Test: Straße', dir: work });
    assert.strictEqual(umlaut.name, 'cc-e2e-rueckkehr-test-strasse');
    const SID = 'abababab-0000-4000-8000-0000000000ab';
    const pdir = path.join(home, '.claude', 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, `${SID}.jsonl`), [{ type: 'user', cwd: work, timestamp: new Date().toISOString(), message: { content: 'hello' } }, { type: 'ai-title', aiTitle: 'Machine title' }].map((o) => JSON.stringify(o)).join('\n') + '\n');
    const { listSessions } = require('../tmux');
    const pane = (await listSessions(ctx)).find((x) => x.name === r.name);
    writePid(pane.panePid, { sessionId: SID });
    await reg.refresh();
    assert.strictEqual(reg.resolve(SID).title, 'Invoice export: Q3 ü', 'the given name beats the AI title');
    assert.strictEqual(reg.titleFor(SID), 'Invoice export: Q3 ü');
    for (const n of [r.name, again.name, blank.name, umlaut.name]) execFileSync(ctx.bin || 'tmux', ['-L', ctx.socket, 'kill-session', '-t', `=${n}`]);
    fs.rmSync(path.join(sessionsDir, `${pane.panePid}.json`));
    await reg.refresh();
    assert.strictEqual(new Registry(config, { ctx }).titleFor(SID), 'Invoice export: Q3 ü', 'kept by session id after the tmux session ended');
  });

  await t.test('a pid file under the pane links the managed session and status changes are pushed', async () => {
    const { listSessions } = require('../tmux');
    const pane = (await listSessions(ctx)).find((s) => s.name === 'cc-new');
    writePid(pane.panePid, { sessionId: ID2, status: 'busy' });
    const statuses = [];
    reg.on('status', (s) => statuses.push(s));
    await reg.refresh();
    const item = reg.resolve('cc-new');
    assert.strictEqual(item.sessionId, ID2);
    assert.strictEqual(reg.resolve(ID2), item);
    assert.deepStrictEqual(statuses.find((s) => s.sessionId === 'cc-new'), { sessionId: 'cc-new', status: 'busy', waitingFor: null });
    writePid(pane.panePid, { sessionId: ID2, status: 'waiting', waitingFor: 'permission' });
    await reg.refresh();
    assert.deepStrictEqual(statuses[statuses.length - 1], { sessionId: 'cc-new', status: 'waiting', waitingFor: 'permission' });
  });

  const markReady = async (name, sessionId) => {
    const { listSessions } = require('../tmux');
    let pane;
    await waitFor(async () => (pane = (await listSessions(ctx)).find((x) => x.name === name)), { what: `pane ${name}` });
    writePid(pane.panePid, { sessionId, status: 'idle' });
  };

  await t.test('continuing waits while Claude works', async () => {
    writePid(outside.pid, { sessionId: ID1, name: 'Demo task', status: 'busy' });
    await assert.rejects(reg.continueSession(ID1), (e) => e.code === 'working');
    assert.ok(!outside.killed && outside.exitCode === null);
    writePid(outside.pid, { sessionId: ID1, name: 'Demo task' });
    await assert.rejects(reg.continueSession('../etc'), (e) => e.code === 'not-found');
    assert.strictEqual(await reg.continueSession(ID2), reg.resolve('cc-new'), 'a session the hub runs is used as it is');
  });

  await t.test('continuing a session from a terminal resumes it under tmux and is ready once Claude is idle', async () => {
    const exited = new Promise((r) => outside.once('exit', r));
    const pending = Promise.all([reg.continueSession(ID1, { device: { id: 'dev-1' } }), reg.continueSession(ID1, { device: { id: 'dev-2' } })]);
    await exited;
    await markReady('cc-demo-task', ID1);
    await waitFor(() => capture(ctx, 'cc-demo-task').includes(`[--flag] [--resume] [${ID1}]`), { what: 'resumed session' });
    const [first, second] = await pending;
    assert.strictEqual(first.name, 'cc-demo-task');
    assert.strictEqual(second, first, 'two messages at once start it once');
    assert.strictEqual(first.managed, true);
    assert.deepStrictEqual(audits.filter((a) => a.sessionId === ID1).map((a) => [a.action, a.signal]), [['continue-stop', 'SIGTERM'], ['continue', undefined]]);
  });

  await t.test('a process that ignores the stop request is stopped harder, then resumed', async () => {
    const stubborn = spawn('/bin/sh', ['-c', 'trap "" TERM; while :; do sleep 1; done'], { stdio: 'ignore' });
    procs.push(stubborn);
    await new Promise((r) => setTimeout(r, 100));
    writePid(stubborn.pid, { sessionId: ID3, name: 'Stubborn' });
    const killed = new Promise((r) => stubborn.once('exit', (code, signal) => r(signal)));
    const pending = reg.continueSession(ID3);
    assert.strictEqual(await killed, 'SIGKILL');
    await markReady('cc-stubborn', ID3);
    assert.strictEqual((await pending).name, 'cc-stubborn');
    assert.deepStrictEqual(audits.filter((a) => a.action === 'continue-stop' && a.sessionId === ID3).map((a) => a.signal), ['SIGTERM', 'SIGKILL']);
  });

  await t.test('titles prefer the transcript over the automatic name; resume derives name and directory', async () => {
    const enc = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
    const ID4 = '44444444-0000-4000-8000-000000000004';
    const ID5 = '55555555-0000-4000-8000-000000000005';
    const proj = path.join(work, 'proj');
    const dir = path.join(home, '.claude', 'projects', enc(proj));
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString();
    fs.writeFileSync(path.join(dir, `${ID5}.jsonl`), [{ type: 'user', cwd: proj, timestamp: ts, message: { content: 'first prompt of five' } }, { type: 'ai-title', aiTitle: 'Readable title' }].map((o) => JSON.stringify(o)).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, `${ID4}.jsonl`), [{ type: 'user', cwd: proj, timestamp: ts, message: { content: 'please ship it' } }, { type: 'custom-title', customTitle: 'Ship the Q3 report!' }].map((o) => JSON.stringify(o)).join('\n') + '\n');
    const p5 = sleeper();
    procs.push(p5);
    writePid(p5.pid, { sessionId: ID5, name: 'proj-2b', cwd: proj });
    await reg.refresh();
    const item = reg.listAll().find((i) => i.sessionId === ID5);
    assert.strictEqual(item.title, 'Readable title');
    assert.strictEqual(item.project, 'proj');
    assert.strictEqual(item.lastPrompt, 'first prompt of five');
    fs.mkdirSync(path.join(proj, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.vscode', 'claude-sessions.json'), JSON.stringify({ favorites: { [ID5]: true }, tabs: [{ name: 'Editor tab name', sessionId: ID5 }] }));
    await reg.refresh();
    const starred = reg.listAll().find((i) => i.sessionId === ID5);
    assert.strictEqual(starred.favorite, true);
    assert.strictEqual(starred.title, 'Editor tab name');
    fs.rmSync(path.join(proj, '.vscode'), { recursive: true });
    const [r, second] = await Promise.allSettled([reg.newSession({ resumeId: ID4 }, { device: { id: 'dev-1' } }), reg.newSession({ resumeId: ID4 }, { device: { id: 'dev-2' } })]).then((all) => [all[0].value, all[1]]);
    assert.strictEqual(second.status, 'rejected');
    assert.strictEqual(second.reason.code, 'session-starting', 'a second resume of the same session waits for the first');
    await assert.rejects(reg.newSession({ resumeId: ID4, name: 'cc-again' }), (e) => e.code === 'session-starting', 'still starting until its process shows up');
    assert.strictEqual(r.name, 'cc-ship-the-q3-report');
    await waitFor(() => capture(ctx, r.name).includes(`[--resume] [${ID4}]`), { what: 'resumed by id' });
    assert.strictEqual(reg.listAll().find((i) => i.name === r.name).cwd, proj);
    await assert.rejects(reg.newSession({ resumeId: ID5 }), (e) => e.code === 'session-running');
  });

  await t.test('a session that never becomes ready is reported, not hidden', async () => {
    const slow = new Registry(config, { ctx, readyWaitMs: 300 });
    const ID6 = '66666666-0000-4000-8000-000000000006';
    const proj = path.join(work, 'proj');
    const dir = path.join(home, '.claude', 'projects', proj.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.writeFileSync(path.join(dir, `${ID6}.jsonl`), JSON.stringify({ type: 'user', cwd: proj, timestamp: new Date().toISOString(), message: { content: 'an earlier session' } }) + '\n');
    await assert.rejects(slow.continueSession(ID6), (e) => e.code === 'not-ready');
    slow.stop();
  });

  assert.ok(UUID_RE.test(ID1));
});
