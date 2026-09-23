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
      fire() {}
    },
    workspace: { getConfiguration: () => ({ get: (key) => (key === 'syncSessionName' ? true : undefined) }) },
  };
};
const { Notifications, Store, Tracker, byPriorityThenName, CIRCLED } = require('../extension');

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

test('priority defaults to 1 and stays within 1..5', () => {
  const n = fresh();
  assert.strictEqual(n.priorityOf('s1'), 1);
  n.shiftPriority('s1', -1);
  assert.strictEqual(n.priorityOf('s1'), 1);
  [1, 1, 1, 1, 1, 1].forEach(() => n.shiftPriority('s1', 1));
  assert.strictEqual(n.priorityOf('s1'), 5);
});

test('lists sort by priority first, then by name', () => {
  const prio = { a: 2, b: 1, c: 1 };
  const rows = [
    { id: 'a', title: 'alpha' },
    { id: 'b', title: 'zulu' },
    { id: 'c', title: 'kreil' },
  ];
  rows.sort(byPriorityThenName((id) => prio[id]));
  assert.deepStrictEqual(rows.map((r) => r.title), ['kreil', 'zulu', 'alpha']);
  assert.strictEqual(CIRCLED[3], '③');
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
