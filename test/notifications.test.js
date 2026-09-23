'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const originalLoad = Module._load;
Module._load = (request, ...rest) => {
  if (request !== 'vscode') return originalLoad(request, ...rest);
  return {
    EventEmitter: class {
      constructor() {
        this.event = () => ({ dispose() {} });
      }
      fire() {
        this.fired = (this.fired || 0) + 1;
      }
    },
    workspace: { getConfiguration: () => ({ get: () => undefined }) },
  };
};
const { Notifications, Store, Tracker, sortSessions, pickerOrder, parseGroupSizes } = require('../extension');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-notifications-test-'));
  return new Notifications(new Store(dir));
}

test('busy -> idle creates one finished notification, busy again clears it', () => {
  const n = fresh();
  n.onStatus('s1', 'kreil', 'busy', 'idle', false);
  assert.deepStrictEqual(n.list().map((x) => [x.sessionId, x.kind]), [['s1', 'finished']]);
  n.onStatus('s1', 'kreil', 'idle', 'idle', false);
  assert.strictEqual(n.list().length, 1);
  n.onStatus('s1', 'kreil', 'idle', 'busy', false);
  assert.strictEqual(n.list().length, 0);
});

test('waiting creates a waiting notification; unknown previous state and visible tabs do not notify', () => {
  const n = fresh();
  n.onStatus('s2', 'schmid', 'busy', 'waiting', false);
  assert.strictEqual(n.list()[0].kind, 'waiting');
  n.onStatus('s3', 'sit', undefined, 'idle', false);
  n.onStatus('s4', 'osteria', 'busy', 'idle', true);
  assert.deepStrictEqual(n.list().map((x) => x.sessionId), ['s2']);
});

test('favorites toggle per session and are stored in the state file', () => {
  const n = fresh();
  assert.strictEqual(n.isFavorite('s1'), false);
  n.setFavorite('s1', true);
  assert.strictEqual(n.isFavorite('s1'), true);
  n.setFavorite('s1', false);
  assert.strictEqual(n.isFavorite('s1'), false);
});

test('favorites come first in alphabetical order, the rest newest message first', () => {
  const at = (h) => ({ lastActivity: new Date(Date.UTC(2026, 8, 23, h)).toISOString() });
  const rows = [
    { id: 'a', title: 'zulu', meta: at(9) },
    { id: 'b', title: 'kreil', meta: at(8) },
    { id: 'c', title: 'old', meta: at(1) },
    { id: 'd', title: 'new', meta: at(12) },
  ];
  const favorites = new Set(['a', 'b']);
  assert.deepStrictEqual(sortSessions(rows, (id) => favorites.has(id)).map((r) => r.title), ['kreil', 'zulu', 'new', 'old']);
});

test('archive flags live in the state file next to tabs and priorities', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-archive-test-'));
  const store = new Store(dir);
  store.write([{ name: 'kreil', sessionId: 'k1' }]);
  store.writeState({ archived: { old1: true } });
  assert.deepStrictEqual(store.readState().archived, { old1: true });
  assert.strictEqual(store.read()[0].name, 'kreil');
});

function fakeTracker() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-rename-test-'));
  const store = new Store(dir);
  return new Tracker(store, new Notifications(store));
}

test('a tab name is remembered per session id and never typed into the terminal', () => {
  const tracker = fakeTracker();
  tracker.rememberName('s-1', 'kreil');
  tracker.rememberName('s-1', 'kreil');
  assert.deepStrictEqual(tracker.store.readState().names, { 's-1': 'kreil' });
  const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.ok(!source.includes('/rename'), 'the extension must not send /rename');
});

test('terminal focus flag fires only on real changes', () => {
  const tracker = fakeTracker();
  assert.strictEqual(tracker.terminalFocused, true);
  tracker.setTerminalFocus(true);
  assert.strictEqual(tracker.onFocusChange.fired || 0, 0);
  tracker.setTerminalFocus(false);
  tracker.setTerminalFocus(false);
  assert.strictEqual(tracker.terminalFocused, false);
  assert.strictEqual(tracker.onFocusChange.fired, 1);
});

test('picker order: unopened favorites newest first, then the rest newest first, archived last', () => {
  const at = (h) => ({ lastActivity: new Date(Date.UTC(2026, 8, 23, h)).toISOString() });
  const rows = [
    { id: 'f-old', title: 'a', meta: at(1) },
    { id: 'f-new', title: 'z', meta: at(9) },
    { id: 'n-old', title: 'b', meta: at(2) },
    { id: 'n-new', title: 'c', meta: at(11) },
    { id: 'arch', title: 'd', meta: at(12) },
  ];
  const fav = new Set(['f-old', 'f-new']);
  const order = pickerOrder(rows, (id) => fav.has(id), (id) => id === 'arch').map((r) => r.id);
  assert.deepStrictEqual(order, ['f-new', 'f-old', 'n-new', 'n-old', 'arch']);
});

test('VS Code layout parsing yields group sizes in tab order', () => {
  const layout = '{"tabs":[{"terminals":[{"terminal":3},{"terminal":14},{"terminal":9}]},{"terminals":[{"terminal":7},{"terminal":8}]}]}';
  assert.deepStrictEqual(parseGroupSizes(layout), [3, 2]);
});
