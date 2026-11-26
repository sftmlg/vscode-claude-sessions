'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-classify-test-'));
process.env.HOME = home;
delete process.env.CLAUDE_CONFIG_DIR;
const { sessionKind, classifyFile, classifyRepo, listRepoSessions, cleanupAutomated, loadCache, peekMeta } = require('../sessions');

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-classify-repo-'));
const projectsRoot = path.join(home, '.claude', 'projects');
const projectDir = path.join(projectsRoot, repo.replace(/[^a-zA-Z0-9]/g, '-'));
const archiveDir = path.join(fs.realpathSync(home), '.claude', 'projects-archive', path.basename(projectDir));
fs.mkdirSync(projectDir, { recursive: true });
fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
fs.mkdirSync(path.join(home, '.claude-abo2'), { recursive: true });
fs.symlinkSync(projectsRoot, path.join(home, '.claude-abo2', 'projects'));

let counter = 0;
const newId = () => `${String(++counter).padStart(8, '0')}-cccc-4000-8000-000000000000`;
const line = (o) => `${JSON.stringify(o)}\n`;
const daysBack = (days) => new Date(Date.now() - days * 86400000);

function writeSession({ entrypoint, daysAgo = 0, prompt = 'hello', lead = '', extra = [], tail = '' }) {
  const id = newId();
  const at = daysBack(daysAgo).toISOString();
  const record = (type, content) => ({ type, cwd: repo, timestamp: at, sessionId: id, isSidechain: false, ...(entrypoint ? { entrypoint } : {}), message: { content } });
  const file = path.join(projectDir, `${id}.jsonl`);
  fs.writeFileSync(file, lead + line(record('user', prompt)) + line(record('assistant', [{ type: 'text', text: `reply ${prompt}` }])) + extra.map(line).join('') + tail);
  fs.utimesSync(file, daysBack(daysAgo), daysBack(daysAgo));
  return { id, file };
}

async function bytesReadFrom(target, fn) {
  const fsp = fs.promises;
  const open = fsp.open;
  let bytes = 0;
  fsp.open = async (file, ...rest) => {
    const handle = await open.call(fsp, file, ...rest);
    if (file !== target) return handle;
    const read = handle.read.bind(handle);
    handle.read = async (...args) => {
      const r = await read(...args);
      bytes += r.bytesRead;
      return r;
    };
    return handle;
  };
  try {
    await fn();
  } finally {
    fsp.open = open;
  }
  return bytes;
}

test('the rule: interactive entrypoints are ours, sdk-* and sidechains are automated, no entrypoint is unknown', () => {
  assert.strictEqual(sessionKind({ entrypoint: 'cli' }), 'ours');
  assert.strictEqual(sessionKind({ entrypoint: 'claude-vscode' }), 'ours');
  assert.strictEqual(sessionKind({ entrypoint: 'sdk-cli' }), 'automated');
  assert.strictEqual(sessionKind({ entrypoint: 'sdk-ts' }), 'automated');
  assert.strictEqual(sessionKind({ entrypoint: 'cli', isSidechain: true }), 'automated');
  assert.strictEqual(sessionKind({ entrypoint: 'sdk-cli', lastEntrypoint: 'cli' }), 'ours');
  assert.strictEqual(sessionKind({ entrypoint: null }), 'unknown');
  assert.strictEqual(sessionKind(undefined), 'unknown');
});

test('classifyFile finds the entrypoint behind a large first record and in a resumed tail', async () => {
  const late = writeSession({ entrypoint: 'cli', lead: line({ type: 'file-history-snapshot', blob: 'x'.repeat(300 * 1024) }) });
  assert.strictEqual((await classifyFile(late.file, fs.statSync(late.file))).kind, 'ours');
  const resumed = writeSession({ entrypoint: 'sdk-cli', extra: [{ type: 'assistant', blob: 'y'.repeat(200 * 1024) }, { type: 'user', entrypoint: 'cli', message: { content: 'a person took over' } }] });
  const c = await classifyFile(resumed.file, fs.statSync(resumed.file));
  assert.deepStrictEqual([c.kind, c.entrypoint, c.lastEntrypoint], ['ours', 'sdk-cli', 'cli']);
});

test('an automated session is classified from its head and last chunk only, and the verdict is cached', async () => {
  const big = writeSession({ entrypoint: 'sdk-cli', extra: [{ type: 'assistant', blob: 'z'.repeat(8 * 1024 * 1024) }, { type: 'assistant', entrypoint: 'sdk-cli', message: { content: 'done' } }] });
  const st = fs.statSync(big.file);
  const first = await bytesReadFrom(big.file, () => classifyFile(big.file, st));
  assert.ok(first <= 2 * 64 * 1024, `read ${first} bytes of a ${st.size} byte session`);
  assert.strictEqual(await bytesReadFrom(big.file, () => classifyFile(big.file, st)), 0);
});

test('the Inactive list loads only our sessions, newest first, skipping live ones, and reports progress', async () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-classify-list-'));
  const dir = path.join(projectsRoot, fresh.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir);
  const put = (id, entrypoint, minutesAgo) => {
    const at = new Date(Date.now() - minutesAgo * 60000);
    const f = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(f, line({ type: 'user', cwd: fresh, timestamp: at.toISOString(), ...(entrypoint ? { entrypoint } : {}), message: { content: `prompt ${id}` } }));
    fs.utimesSync(f, at, at);
  };
  put('ours-old', 'cli', 30);
  put('ours-new', 'cli', 1);
  put('legacy', null, 10);
  put('bot-1', 'sdk-cli', 2);
  put('bot-2', 'sdk-cli', 3);
  put('live', 'cli', 0);
  const progress = [];
  const metas = await listRepoSessions(fresh, 30, { skip: new Set(['live']), onProgress: (partial) => progress.push(partial.map((m) => m.id)) });
  assert.deepStrictEqual(metas.map((m) => m.id), ['ours-new', 'legacy', 'ours-old']);
  assert.deepStrictEqual(progress, [['ours-new'], ['ours-new', 'legacy'], ['ours-new', 'legacy', 'ours-old']]);
  assert.strictEqual((await listRepoSessions(fresh, 30, { all: true })).length, 6);
  const rows = await classifyRepo(fresh, 30);
  assert.deepStrictEqual(rows.map((r) => `${r.id}:${r.kind}`).sort(), ['bot-1:automated', 'bot-2:automated', 'legacy:unknown', 'live:ours', 'ours-new:ours', 'ours-old:ours']);
});

test('a restart drops cached metadata of sessions already classified as automated', () => {
  const gs = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-classify-gs-'));
  const entry = (id) => ({ mtimeMs: 1, meta: { id, lastActivity: new Date().toISOString() } });
  fs.writeFileSync(path.join(gs, 'kind-cache.json'), JSON.stringify({ '/x/bot.jsonl': { ino: 1, mtimeMs: 1, entrypoint: 'sdk-cli', scanned: 1 }, '/x/ours.jsonl': { ino: 2, mtimeMs: 1, entrypoint: 'cli', scanned: 1 } }));
  fs.writeFileSync(path.join(gs, 'meta-cache.json'), JSON.stringify({ '/x/bot.jsonl': entry('bot-id'), '/x/ours.jsonl': entry('ours-id') }));
  loadCache(gs);
  assert.strictEqual(peekMeta('bot-id'), null);
  assert.strictEqual(peekMeta('ours-id').id, 'ours-id');
});

test('cleanup moves only old automated sessions that are not running, favorite or named, and dry run moves nothing', async () => {
  const oldBot = writeSession({ entrypoint: 'sdk-cli', daysAgo: 10 });
  fs.mkdirSync(path.join(projectDir, oldBot.id, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, oldBot.id, 'subagents', 'a.jsonl'), '{}\n');
  const recentBot = writeSession({ entrypoint: 'sdk-cli', daysAgo: 2 });
  const oldOurs = writeSession({ entrypoint: 'cli', daysAgo: 30 });
  const running = writeSession({ entrypoint: 'sdk-cli', daysAgo: 9 });
  const favorite = writeSession({ entrypoint: 'sdk-cli', daysAgo: 9 });
  const namedInState = writeSession({ entrypoint: 'sdk-cli', daysAgo: 9 });
  const titled = writeSession({ entrypoint: 'sdk-cli', daysAgo: 9, tail: line({ type: 'custom-title', customTitle: 'keep-me' }) });
  fs.mkdirSync(path.join(repo, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.vscode', 'claude-sessions.json'), JSON.stringify({ favorites: { [favorite.id]: true }, names: { [namedInState.id]: 'my-name' } }));
  const registry = path.join(home, '.claude', 'sessions', `${process.pid}.json`);
  fs.writeFileSync(registry, JSON.stringify({ pid: process.pid, sessionId: running.id }));
  const sub = path.join(repo, 'tools');
  const subFavorite = path.join(`${projectDir}-tools`, 'sub-favorite.jsonl');
  fs.mkdirSync(path.join(sub, '.vscode'), { recursive: true });
  fs.mkdirSync(path.dirname(subFavorite), { recursive: true });
  fs.writeFileSync(subFavorite, line({ type: 'user', cwd: sub, entrypoint: 'sdk-cli', message: { content: 'x' } }));
  fs.utimesSync(subFavorite, daysBack(9), daysBack(9));
  fs.writeFileSync(path.join(sub, '.vscode', 'claude-sessions.json'), JSON.stringify({ favorites: { 'sub-favorite': true } }));
  const sessionFiles = () => fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl')).length;
  const before = sessionFiles();

  try {
    const dry = await cleanupAutomated(repo, { olderThanDays: 7 });
    assert.deepStrictEqual(dry.candidates.map((c) => c.id), [oldBot.id]);
    assert.deepStrictEqual([dry.running, dry.favorite, dry.named, dry.moved.length], [1, 2, 2, 0]);
    assert.ok(dry.recent >= 1 && dry.ours >= 1);
    assert.strictEqual(sessionFiles(), before);

    const done = await cleanupAutomated(repo, { olderThanDays: 7, apply: true });
    assert.deepStrictEqual(done.failed, []);
    assert.deepStrictEqual(done.moved.map((m) => m.id), [oldBot.id]);
    assert.deepStrictEqual(done.archiveDirs, [archiveDir]);
    assert.ok(!fs.existsSync(oldBot.file));
    assert.ok(fs.existsSync(path.join(archiveDir, `${oldBot.id}.jsonl`)));
    assert.ok(fs.existsSync(path.join(archiveDir, oldBot.id, 'subagents', 'a.jsonl')));
    assert.ok(!fs.existsSync(path.join(projectDir, oldBot.id)));
    for (const kept of [recentBot, oldOurs, running, favorite, namedInState, titled]) assert.ok(fs.existsSync(kept.file), kept.id);
    assert.ok(fs.existsSync(subFavorite), 'a favorite of a subfolder workspace stays');
  } finally {
    fs.rmSync(registry);
  }
});

test('cli cleanup prints a dry run by default and moves with --apply', () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-classify-cli-'));
  const dir = path.join(projectsRoot, other.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir);
  const put = (id, entrypoint) => {
    const f = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(f, line({ type: 'user', cwd: other, timestamp: daysBack(20).toISOString(), entrypoint, message: { content: 'x' } }));
    fs.utimesSync(f, daysBack(20), daysBack(20));
    return f;
  };
  const bot = put('bot', 'sdk-cli');
  const ours = put('ours', 'cli');
  const target = path.join(fs.realpathSync(home), '.claude', 'projects-archive', path.basename(dir));
  const cli = path.join(__dirname, '..', 'cli.js');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  const dry = run('cleanup', other, '--older-than', '7');
  assert.strictEqual(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /1 interactive/);
  assert.match(dry.stdout, /would move 1 automated sessions/);
  assert.ok(fs.existsSync(bot));
  const classify = run('classify', other, '--days', '60');
  assert.match(classify.stdout, /1 .* automated entrypoint sdk-cli/);
  assert.match(classify.stdout, /1 .* ours\s+entrypoint cli/);
  const applied = run('cleanup', other, '--older-than', '7', '--apply');
  assert.strictEqual(applied.status, 0, applied.stderr);
  assert.ok(applied.stdout.includes(`moved 1 files of 1 automated sessions (0 MB) to ${target}`), applied.stdout);
  assert.ok(fs.existsSync(path.join(target, 'bot.jsonl')));
  assert.ok(!fs.existsSync(bot));
  assert.ok(fs.existsSync(ours));
});
