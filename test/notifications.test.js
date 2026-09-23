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
    workspace: { getConfiguration: () => ({ get: (key) => (key === 'syncSessionName' ? true : undefined) }) },
  };
};
const { Notifications, Store, Tracker, sortSessions } = require('../extension');

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

test('alternating tab names never produce a /rename storm', async () => {
  const tracker = fakeTracker();
  const sent = [];
  const terminal = { sendText: (text) => sent.push(text) };
  const running = { sessionId: 'no-such-session', status: 'idle' };
  for (let i = 0; i < 40; i++) {
    const name = i % 2 ? 'schmid' : 'Schmid email configuration';
    await tracker.syncSessionName(terminal, { name, nameSource: 'user' }, running);
  }
  assert.strictEqual(sent.length, 0);
});

test('a stable new name is sent once, overlapping polls do not repeat it', async () => {
  const tracker = fakeTracker();
  const sent = [];
  const terminal = { sendText: (text) => sent.push(text) };
  const running = { sessionId: 'no-such-session', status: 'idle' };
  const m = { name: 'schmid', nameSource: 'user' };
  await tracker.syncSessionName(terminal, m, running);
  await Promise.all([1, 2, 3, 4, 5].map(() => tracker.syncSessionName(terminal, m, running)));
  assert.deepStrictEqual(sent, ['/rename schmid']);
});

test('an explicit rename is sent immediately even inside the rate limit', async () => {
  const tracker = fakeTracker();
  const sent = [];
  const terminal = { sendText: (text) => sent.push(text) };
  const running = { sessionId: 'no-such-session', status: 'idle' };
  await tracker.syncSessionName(terminal, { name: 'kreil', nameSource: 'user' }, running, true);
  assert.deepStrictEqual(sent, ['/rename kreil']);
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
