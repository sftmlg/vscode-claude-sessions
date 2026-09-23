'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-test-'));
process.env.HOME = home;
delete process.env.CLAUDE_CONFIG_DIR;
const { listRepoSessions, sessionSummary, renameSession, archiveDuplicates, readState } = require('../sessions');

const repo = '/work/demo-repo';
const projectDir = path.join(home, '.claude', 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(projectDir, { recursive: true });

function writeSession(id, entries) {
  fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
}

const now = Date.now();
const iso = (minutesAgo) => new Date(now - minutesAgo * 60000).toISOString();

writeSession('aaaa1111-0000-0000-0000-000000000000', [
  { type: 'user', cwd: repo, timestamp: iso(120), message: { content: '<command-name>/clear</command-name>' } },
  { type: 'user', cwd: repo, timestamp: iso(119), message: { content: 'first real prompt' } },
  { type: 'ai-title', aiTitle: 'Older session' },
  { type: 'assistant', timestamp: iso(118), message: { content: [{ type: 'text', text: 'first answer' }] } },
  { type: 'user', timestamp: iso(90), message: { content: [{ type: 'text', text: '<pasted_content id="x">pasted request</pasted_content>' }] } },
  { type: 'user', timestamp: iso(89), message: { content: 'Stop hook feedback: ignore me' } },
  { type: 'assistant', timestamp: iso(88), message: { content: [{ type: 'text', text: 'last answer' }] } },
]);

writeSession('bbbb2222-0000-0000-0000-000000000000', [
  { type: 'user', cwd: repo, timestamp: iso(30), message: { content: 'newer prompt' } },
  { type: 'assistant', timestamp: iso(5), message: { content: [{ type: 'text', text: 'newer answer' }] } },
]);

writeSession('cccc3333-0000-0000-0000-000000000000', [
  { type: 'user', cwd: repo, timestamp: iso(60 * 24 * 20), message: { content: 'too old' } },
]);
fs.utimesSync(path.join(projectDir, 'cccc3333-0000-0000-0000-000000000000.jsonl'), (now - 20 * 86400000) / 1000, (now - 20 * 86400000) / 1000);

test('lists sessions of the repo sorted by newest message, without old ones', async () => {
  const sessions = await listRepoSessions(repo, 14);
  assert.deepStrictEqual(sessions.filter((s) => !s.id.startsWith('dddd')).map((s) => s.id.slice(0, 4)), ['bbbb', 'aaaa']);
});

test('reads title, first prompt, last real user message and last answer', async () => {
  const older = (await listRepoSessions(repo, 14)).find((s) => s.id.startsWith('aaaa'));
  assert.strictEqual(older.aiTitle, 'Older session');
  assert.strictEqual(older.firstPrompt, 'first real prompt');
  assert.strictEqual(older.lastUser.text, 'pasted request');
  assert.strictEqual(older.lastAssistant.text, 'last answer');
  assert.strictEqual(older.lastActivity, iso(88));
});

test('finds the title in the middle of a mid-sized file', async () => {
  const filler = Array.from({ length: 900 }, (_, i) => ({ type: 'attachment', timestamp: iso(50), note: 'x'.repeat(1000) + i }));
  writeSession('dddd4444-0000-0000-0000-000000000000', [
    { type: 'user', cwd: repo, timestamp: iso(55), message: { content: 'mid prompt' } },
    ...filler,
    { type: 'ai-title', aiTitle: 'Title in the middle' },
    ...filler,
    { type: 'assistant', timestamp: iso(1), message: { content: [{ type: 'text', text: 'late answer' }] } },
  ]);
  const meta = (await listRepoSessions(repo, 14)).find((s) => s.id.startsWith('dddd'));
  assert.strictEqual(meta.aiTitle, 'Title in the middle');
  assert.strictEqual(meta.lastAssistant.text, 'late answer');
});

test('summary shows last activity before start', async () => {
  const newer = (await listRepoSessions(repo, 14)).find((s) => s.id.startsWith('bbbb'));
  assert.match(sessionSummary(newer), /^last \d{2}\.\d{2}\. \d{2}:\d{2} · started /);
});

test('rename appends a custom title; any non-empty name is accepted', async () => {
  await renameSession('bbbb2222-0000-0000-0000-000000000000', 'client-billing');
  let renamed = (await listRepoSessions(repo, 14)).find((s) => s.id.startsWith('bbbb'));
  assert.strictEqual(renamed.customTitle, 'client-billing');
  await renameSession('bbbb2222-0000-0000-0000-000000000000', 'My Own Name');
  renamed = (await listRepoSessions(repo, 14)).find((s) => s.id.startsWith('bbbb'));
  assert.strictEqual(renamed.customTitle, 'My Own Name');
  await assert.rejects(renameSession('bbbb2222-0000-0000-0000-000000000000', '  '), /must not be empty/);
});

test('a session without messages is dated by its own records, not by the file time', async () => {
  writeSession('eeee5555-0000-0000-0000-000000000000', [{ type: 'attachment', cwd: repo, timestamp: iso(600) }]);
  await renameSession('eeee5555-0000-0000-0000-000000000000', 'empty');
  const meta = (await listRepoSessions(repo, 14)).find((s) => s.id.startsWith('eeee'));
  assert.strictEqual(meta.lastActivity, iso(600));
});

test('archive-duplicates keeps the newest session per name and skips favorites', async () => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dupes-ws-'));
  const dupDir = path.join(home, '.claude', 'projects', wsDir.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dupDir, { recursive: true });
  const put = (id, minutesAgo, title) =>
    fs.writeFileSync(path.join(dupDir, `${id}.jsonl`), [
      JSON.stringify({ type: 'user', cwd: wsDir, timestamp: iso(minutesAgo), message: { content: 'go' } }),
      JSON.stringify({ type: 'custom-title', customTitle: title }),
    ].join('\n') + '\n');
  put('r-old', 300, 'radar-daily');
  put('r-mid', 200, 'radar-daily');
  put('r-new', 100, 'radar-daily');
  put('fav-old', 400, 'radar-daily');
  put('solo', 50, 'kreil');
  fs.mkdirSync(path.join(wsDir, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(wsDir, '.vscode', 'claude-sessions.json'), JSON.stringify({ favorites: { 'fav-old': true } }));
  const moved = await archiveDuplicates(wsDir, 14);
  assert.deepStrictEqual(moved.map((m) => m.id).sort(), ['r-mid', 'r-old']);
  assert.deepStrictEqual(Object.keys(readState(wsDir).archived).sort(), ['r-mid', 'r-old']);
});
