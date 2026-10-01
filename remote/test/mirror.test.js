'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const tmux = require('../tmux');
const { Mirror, frame, parseFrame, adaptiveDelay } = require('../mirror');
const { testCtx, killServer, startPane, waitFor } = require('./fixtures/fs-helpers');

function viewer(id) {
  const v = { id, json: [], frames: [], buffered: 0 };
  v.sendJson = (m) => v.json.push(m);
  v.sendBinary = (b) => v.frames.push(parseFrame(b));
  v.bufferedAmount = () => v.buffered;
  v.text = () => v.frames.map((f) => f.bytes.toString('utf8')).join('');
  return v;
}

const windowSize = (ctx, name) => execFileSync(ctx.bin, ['-L', ctx.socket, 'display', '-p', '-t', `=${name}:`, '#{window_width}x#{window_height}'], { encoding: 'utf8' }).trim();

test('binary frame layout [1][u16 len][name][u32 seq][bytes] round-trips', () => {
  const buf = frame('cc-a', 0xfffffffe, Buffer.from('xy'));
  assert.strictEqual(buf[0], 1);
  assert.strictEqual(buf.readUInt16BE(1), 4);
  assert.deepStrictEqual({ ...parseFrame(buf), bytes: parseFrame(buf).bytes.toString() }, { sessionId: 'cc-a', seq: 0xfffffffe, bytes: 'xy' });
});

test('coalescing delay adapts between 40 and 250 ms', () => {
  assert.strictEqual(adaptiveDelay(10), 40);
  assert.strictEqual(adaptiveDelay(8192), 128);
  assert.strictEqual(adaptiveDelay(1e6), 250);
});

test('mirror integration on a throwaway socket', async (t) => {
  const ctx = testCtx();
  t.after(() => killServer(ctx));
  startPane(ctx, 'cc-m', undefined, { cols: 80, rows: 12 });
  const m = new Mirror(ctx, 'cc-m', { claimTimeoutMs: 400 }).start();
  t.after(() => m.close());

  const a = viewer('a');
  await t.test('snapshot message then one binary frame with the same seq', async () => {
    await m.addViewer(a);
    assert.strictEqual(a.json[0].t, 'snapshot');
    assert.strictEqual(a.json[0].cols, 80);
    assert.strictEqual(a.json[0].rows, 12);
    assert.strictEqual(a.frames.length, 1);
    assert.strictEqual(a.frames[0].seq, a.json[0].seq);
    assert.match(a.text(), /fake-claude args:/);
  });

  await t.test('live output arrives coalesced with consecutive seq numbers', async () => {
    for (let i = 0; i < 5; i++) await tmux.paste(ctx, 'cc-m', `b${i}`, `line ${i}`);
    await waitFor(() => a.text().includes('got:line 4'), { what: 'output' });
    const seqs = a.frames.map((f) => f.seq);
    seqs.forEach((s, i) => i && assert.strictEqual(s, seqs[i - 1] + 1));
    assert.ok(a.frames.length - 1 < 10, `expected coalescing, got ${a.frames.length - 1} frames`);
  });

  const b = viewer('b');
  await t.test('a second viewer gets its own snapshot at the current seq', async () => {
    await m.addViewer(b);
    const snap = b.json.find((x) => x.t === 'snapshot');
    assert.strictEqual(snap.seq, a.frames[a.frames.length - 1].seq);
    assert.match(b.text(), /got:line 4/);
  });

  await t.test('backpressure: a slow viewer stops receiving, then gets a fresh snapshot', async () => {
    b.buffered = 100 * 1024;
    const before = b.frames.length;
    await tmux.paste(ctx, 'cc-m', 'slow1', 'while slow');
    await waitFor(() => a.text().includes('got:while slow'), { what: 'output to fast viewer' });
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(b.frames.length, before);
    b.buffered = 0;
    await waitFor(() => b.json.filter((x) => x.t === 'snapshot').length === 2, { what: 'resnapshot' });
    assert.match(b.frames[b.frames.length - 1].bytes.toString(), /got:while slow/);
  });

  await t.test('size claim resizes via refresh-client and release restores', async () => {
    await m.claim('a', 'phone', 50, 10);
    await waitFor(() => windowSize(ctx, 'cc-m') === '50x10', { what: 'claimed size' });
    assert.ok(a.json.some((x) => x.t === 'size' && x.claimedBy === 'phone' && x.cols === 50));
    await waitFor(() => a.json.some((x) => x.t === 'snapshot' && x.cols === 50), { what: 'resnapshot after resize' });
    await m.release('a');
    await waitFor(() => windowSize(ctx, 'cc-m') === '80x12', { what: 'restored size' });
    assert.ok(a.json.some((x) => x.t === 'size' && x.claimedBy === null));
    const opt = execFileSync(ctx.bin, ['-L', ctx.socket, 'show-options', '-gw', 'window-size'], { encoding: 'utf8' }).trim();
    assert.strictEqual(opt, 'window-size latest');
    await assert.rejects(m.claim('a', 'x', 5, 5), /out of range/);
    await assert.rejects(m.claim('nobody', 'x', 50, 10), /not subscribed/);
  });

  await t.test('a claim without heartbeat expires', async () => {
    await m.claim('a', 'phone', 60, 10);
    await waitFor(() => windowSize(ctx, 'cc-m') === '60x10', { what: 'claimed size' });
    await waitFor(() => windowSize(ctx, 'cc-m') === '80x12', { what: 'expired claim', timeout: 3000 });
  });

  await t.test('session end notifies viewers and closes the mirror', async () => {
    const closed = new Promise((r) => m.once('closed', r));
    execFileSync(ctx.bin, ['-L', ctx.socket, 'kill-session', '-t', '=cc-m']);
    await closed;
    assert.ok(a.json.some((x) => x.t === 'error' && x.code === 'session-ended'));
  });
});
