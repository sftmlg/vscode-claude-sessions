'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { archiveInState, pickByName } = require('../sessions');

test('archiveInState adds ids and keeps every other key of the state file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-archive-'));
  const file = path.join(dir, '.vscode', 'claude-sessions.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ tabs: [{ name: 'x' }], archived: { old: true }, priorities: { a: 2 } }));
  const added = archiveInState(file, ['s1', 'old', 's2']);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(added, ['s1', 's2']);
  assert.deepStrictEqual(state.archived, { old: true, s1: true, s2: true });
  assert.deepStrictEqual(state.tabs, [{ name: 'x' }]);
  assert.deepStrictEqual(state.priorities, { a: 2 });
});

test('pickByName matches the exact name and its numbered variants, never running sessions', () => {
  const sessions = [
    { id: 'a', customTitle: 'misc' },
    { id: 'b', customTitle: 'misc-2' },
    { id: 'c', customTitle: 'miscellaneous' },
    { id: 'd', customTitle: 'kreil' },
    { id: 'e', customTitle: 'misc' },
  ];
  assert.deepStrictEqual(pickByName(sessions, 'misc', new Set(['e'])).map((s) => s.id), ['a', 'b']);
});
