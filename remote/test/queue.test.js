'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Queue } = require('../queue');
const { tempHome } = require('./fixtures/fs-helpers');

test('an id runs once; repeats get the stored ack flagged as duplicate', async () => {
  const q = new Queue(null);
  let runs = 0;
  const ack = await q.run('m1', async () => (runs++, { ok: true }));
  assert.deepStrictEqual(ack, { ok: true });
  assert.deepStrictEqual(await q.run('m1', async () => (runs++, { ok: true })), { ok: true, error: undefined, duplicate: true });
  assert.strictEqual(runs, 1);
  assert.strictEqual(q.seen('m1'), true);
  assert.strictEqual(q.seen('m2'), false);
});

test('a repeat while the first delivery is in flight waits for it instead of running again', async () => {
  const q = new Queue(null);
  let runs = 0;
  let release;
  const first = q.run('m', () => new Promise((r) => ((release = r), runs++)));
  const second = q.run('m', async () => (runs++, { ok: true }));
  assert.strictEqual(q.seen('m'), true);
  release({ ok: true });
  assert.deepStrictEqual(await first, { ok: true });
  assert.strictEqual((await second).duplicate, true);
  assert.strictEqual(runs, 1);
});

test('failures are recorded with their code, retryable results are not', async () => {
  const q = new Queue(null);
  assert.deepStrictEqual(await q.run('a', async () => { throw Object.assign(new Error('x'), { code: 'busy-dialog' }); }), { ok: false, error: 'busy-dialog' });
  assert.strictEqual(q.get('a').error, 'busy-dialog');
  await q.run('b', async () => ({ ok: false, error: 'rate-limited', retry: true }));
  assert.strictEqual(q.seen('b'), false);
});

test('persisted LRU survives a restart, keeps only the newest ids, file mode 0600', async () => {
  const file = path.join(tempHome(), 'state', 'queue.json');
  const q = new Queue(file, { max: 3 });
  for (const id of ['a', 'b', 'c', 'd']) await q.run(id, async () => ({ ok: true }));
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  const again = new Queue(file, { max: 3 });
  assert.deepStrictEqual(['a', 'b', 'c', 'd'].map((id) => again.seen(id)), [false, true, true, true]);
  assert.strictEqual(Queue.validId('ok_id-1'), true);
  assert.strictEqual(Queue.validId('bad id'), false);
  assert.strictEqual(Queue.validId('x'.repeat(65)), false);
});

test('device-namespaced keys persist and stay separate per device', async () => {
  const file = path.join(tempHome(), 'queue.json');
  const q = new Queue(file);
  await q.run('dev-aaaaaaaaaaaa:m-1', async () => ({ ok: true }));
  const again = new Queue(file);
  assert.strictEqual(again.seen('dev-aaaaaaaaaaaa:m-1'), true);
  assert.strictEqual(again.seen('dev-bbbbbbbbbbbb:m-1'), false);
});
