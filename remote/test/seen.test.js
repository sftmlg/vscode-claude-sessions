'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { SeenStore } = require('../seen');
const { tempHome } = require('./fixtures/fs-helpers');

const S1 = '11111111-0000-4000-8000-000000000001';
const S2 = '22222222-0000-4000-8000-000000000002';

test('a session first seen is read; growth after that is unread until marked', () => {
  const dir = tempHome('remote-seen-');
  const seen = new SeenStore(dir, { flushMs: 0 });
  assert.strictEqual(seen.unread('dev-aaaaaaaaaaaa', { sessionId: S1, transcriptSize: 100 }), false, 'baseline, not unread');
  assert.strictEqual(seen.unread('dev-aaaaaaaaaaaa', { sessionId: S1, transcriptSize: 180 }), true);
  assert.strictEqual(seen.unread('dev-bbbbbbbbbbbb', { sessionId: S1, transcriptSize: 180 }), false, 'other devices keep their own state');
  seen.mark('dev-aaaaaaaaaaaa', { sessionId: S1, transcriptSize: 180 });
  assert.strictEqual(seen.unread('dev-aaaaaaaaaaaa', { sessionId: S1, transcriptSize: 180 }), false);
  assert.strictEqual(seen.unread('dev-aaaaaaaaaaaa', { sessionId: null, transcriptSize: 50 }), false, 'no session id, no unread');
  assert.strictEqual(seen.unread('dev-aaaaaaaaaaaa', { sessionId: S2, transcriptSize: null }), false, 'no transcript yet, no unread');
});

test('state persists per device in a private file with offsets only', () => {
  const dir = tempHome('remote-seen-');
  const seen = new SeenStore(dir, { flushMs: 0 });
  seen.unread('dev-aaaaaaaaaaaa', { sessionId: S1, transcriptSize: 10 });
  seen.mark('dev-aaaaaaaaaaaa', { sessionId: S1, transcriptSize: 20 });
  seen.flush();
  const file = path.join(dir, 'seen', 'dev-aaaaaaaaaaaa.json');
  assert.strictEqual(fs.statSync(file).mode & 0o077, 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { [S1]: 20 });
  const again = new SeenStore(dir, { flushMs: 0 });
  assert.strictEqual(again.unread('dev-aaaaaaaaaaaa', { sessionId: S1, transcriptSize: 25 }), true);
  assert.throws(() => again.mark('../etc', { sessionId: S1, transcriptSize: 1 }), /device/);
});
