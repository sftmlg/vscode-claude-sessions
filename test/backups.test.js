'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { backupsFile, readBackups, takeBackup, splitsOf, MAX_BACKUPS } = require('../backups');

const tab = (n, group) => ({ name: `tab-${n}`, sessionId: `00000000-0000-0000-0000-00000000000${n}`, cwd: '/repo', group });

test('the backups file sits next to the state file', () => {
  assert.strictEqual(backupsFile('/repo/.vscode/claude-sessions.json'), '/repo/.vscode/claude-sessions-backups.json');
});

test('a backup is written only when the constellation changed', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-backups-')), 'b.json');
  const first = [tab(1, 'a'), tab(2, 'a'), tab(3, 'b')];
  assert.ok(takeBackup(file, first, { at: '2026-10-20T10:00:00.000Z' }));
  assert.strictEqual(takeBackup(file, first.map((t) => ({ ...t, group: `${t.group}-renamed` })), { at: '2026-10-20T10:30:00.000Z' }), null, 'other group ids, same splits');
  assert.strictEqual(takeBackup(file, [], { at: '2026-10-20T11:00:00.000Z' }), null, 'no open tabs is never a backup');
  assert.ok(takeBackup(file, [tab(1, 'a'), tab(2, 'b'), tab(3, 'b')], { at: '2026-10-20T11:30:00.000Z' }), 'a tab moved to another split');
  assert.ok(takeBackup(file, [tab(1, 'a'), { ...tab(2, 'b'), name: 'renamed' }, tab(3, 'b')], { at: '2026-10-20T12:00:00.000Z' }), 'a rename');
  assert.strictEqual(readBackups(file).length, 3);
});

test('an older backup seeded later does not hide a change against the newest one', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-backups-')), 'b.json');
  takeBackup(file, [tab(1, 'a')], { at: '2026-10-20T12:00:00.000Z' });
  takeBackup(file, [tab(1, 'a'), tab(2, 'a')], { at: '2026-10-20T09:00:00.000Z', label: 'seeded' });
  assert.deepStrictEqual(readBackups(file).map((b) => b.at), ['2026-10-20T09:00:00.000Z', '2026-10-20T12:00:00.000Z']);
  assert.strictEqual(takeBackup(file, [tab(1, 'a')]), null, 'compared with the newest, not the last written');
});

test('the oldest backups drop out beyond the limit', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-backups-')), 'b.json');
  for (let i = 0; i < MAX_BACKUPS + 3; i++) takeBackup(file, [{ ...tab(1, 'a'), name: `n${i}` }], { at: new Date(Date.UTC(2026, 9, 1) + i * 60000).toISOString() });
  const kept = readBackups(file);
  assert.strictEqual(kept.length, MAX_BACKUPS);
  assert.strictEqual(kept[kept.length - 1].tabs[0].name, `n${MAX_BACKUPS + 2}`);
});

test('splits keep their order and the order inside them', () => {
  assert.deepStrictEqual(splitsOf([tab(1, 'a'), tab(2, 'b'), tab(3, 'a')]).map((g) => g.map((t) => t.name)), [['tab-1', 'tab-3'], ['tab-2']]);
});
