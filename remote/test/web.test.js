'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'web');
const read = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');
const APP_JS = ['app.js', 'term.js', 'input.js'];

test('vendored files match the pinned versions and SHA-256 hashes', () => {
  const lines = read('vendor/VERSIONS').trim().split('\n');
  const listed = new Set();
  for (const line of lines) {
    const m = /^(\S+) (@xterm\/(?:xterm@6\.0\.0|addon-fit@0\.11\.0)) sha256:([0-9a-f]{64})$/.exec(line);
    assert.ok(m, `manifest line: ${line}`);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(WEB, 'vendor', m[1]))).digest('hex');
    assert.strictEqual(actual, m[3], `${m[1]} hash`);
    listed.add(m[1]);
  }
  for (const f of fs.readdirSync(path.join(WEB, 'vendor'))) if (f !== 'VERSIONS') assert.ok(listed.has(f), `${f} listed in VERSIONS`);
  for (const f of ['xterm.mjs', 'xterm.css', 'addon-fit.mjs']) assert.ok(listed.has(f), f);
});

test('the shell has no inline script or style and loads nothing from other origins', () => {
  const html = read('index.html');
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    assert.match(m[1], /\bsrc="[^":]+"/, 'script tags load local files only');
    assert.strictEqual(m[2].trim(), '', 'no inline script');
  }
  assert.ok(!/<style\b/i.test(html), 'no style element');
  assert.ok(!/\sstyle=/i.test(html), 'no style attribute');
  assert.ok(!/\son[a-z]+=/i.test(html), 'no inline handlers');
  assert.ok(!/(src|href)="(https?:)?\/\//i.test(html), 'no remote resources');
  assert.match(html, /name="viewport" content="[^"]*interactive-widget=resizes-content/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /rel="manifest" href="manifest.webmanifest"/);
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.strictEqual(manifest.display, 'standalone');
});

test('app code renders text only and never registers a service worker', () => {
  for (const f of APP_JS) {
    const src = read(f);
    for (const bad of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function\(/, /serviceWorker/, /https?:\/\/(?!.*\$\{)/]) assert.ok(!bad.test(src), `${f} must not match ${bad}`);
  }
  const term = read('term.js');
  assert.match(term, /registerOscHandler\(52, \(\) => true\)/, 'OSC 52 swallowed');
  assert.match(term, /url\.protocol !== 'http:' && url\.protocol !== 'https:'/, 'links limited to http(s)');
  assert.match(term, /noopener/);
});

test('phone fit, background release, subagent requests and forced takeover are wired', () => {
  const app = read('app.js');
  assert.match(app, /isTouch\(\) \|\| window\.innerWidth < 700/, 'auto-fit on touch or narrow screens');
  assert.match(app, /visibilityState === 'hidden'\) return releaseClaim\(true\)/, 'claim released in background');
  assert.match(app, /t: 'agentEvents', sessionId: id, toolUseId/, 'subagent events requested over the socket');
  assert.match(app, /ack\.error === 'still-running' && !force/, 'SIGKILL only offered after an ignored SIGTERM');
  assert.match(app, /\.\.\.\(force \? \{ force: true \} : \{\}\)/, 'force flag only on the second confirmation');
});

test('outbox sender: one message in flight, next only after its ack, a rate-limited retry stays first', async () => {
  const { Outbox, OutboxSender } = await import(path.join(WEB, 'input.js'));
  const data = new Map();
  const box = new Outbox({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) });
  const sent = [];
  const timers = [];
  let ready = true;
  const sender = new OutboxSender({ outbox: box, send: (m) => (sent.push(m.text), true), isReady: () => ready, retryMs: 1000, setTimer: (fn) => timers.push(fn) });
  const a = box.add('cc-a', 'one');
  const b = box.add('cc-a', 'two');
  sender.pump();
  sender.pump();
  assert.deepStrictEqual(sent, ['one']);
  assert.deepStrictEqual(sender.onAck({ id: a.id, ok: false, error: 'rate-limited' }), { handled: true });
  box.add('cc-a', 'three');
  sender.pump();
  assert.deepStrictEqual(sent, ['one'], 'nothing overtakes the rate-limited head');
  timers.shift()();
  assert.deepStrictEqual(sent, ['one', 'one']);
  sender.onAck({ id: a.id, ok: true });
  assert.deepStrictEqual(sent, ['one', 'one', 'two']);
  const r = sender.onAck({ id: b.id, ok: false, error: 'busy-dialog' });
  assert.strictEqual(r.item.text, 'two');
  assert.strictEqual(r.error, 'busy-dialog');
  assert.deepStrictEqual(sent, ['one', 'one', 'two', 'three']);
  ready = false;
  sender.reset();
  sender.pump();
  assert.strictEqual(sent.length, 4, 'offline: nothing sent');
  ready = true;
  sender.reset();
  sender.pump();
  assert.deepStrictEqual(sent.slice(4), ['three'], 'reconnect resends the unacked head once');
  assert.deepStrictEqual(sender.onAck({ id: 'unknown', ok: true }), { handled: false });
});

test('every key in the key bar is on the server allowlist', () => {
  const { KEYS } = require('../tmux');
  const keys = [...read('index.html').matchAll(/data-key="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(keys, ['Escape', 'Up', 'Down', 'Left', 'Right', 'Tab', 'BTab', 'Enter', 'C-c', '1', '2', '3', 'y', 'n']);
  for (const k of keys) assert.ok(KEYS.has(k), k);
});

test('outbox: capped by items and bytes, persisted, cleared on ack', async () => {
  const { Outbox, OUTBOX_MAX_ITEMS, OUTBOX_MAX_BYTES } = await import(path.join(WEB, 'input.js'));
  const data = new Map();
  const store = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) };
  const box = new Outbox(store);
  const first = box.add('cc-a', 'hello');
  assert.match(first.id, /^m-[0-9a-f]{24}$/);
  assert.strictEqual(new Outbox(store).pending()[0].text, 'hello');
  for (let i = 1; i < OUTBOX_MAX_ITEMS; i++) assert.ok(box.add('cc-a', `m${i}`));
  assert.strictEqual(box.add('cc-a', 'one too many'), null);
  for (const item of box.pending()) box.remove(item.id);
  assert.strictEqual(data.size, 0, 'storage emptied after all acks');
  assert.strictEqual(box.add('cc-a', 'x'.repeat(OUTBOX_MAX_BYTES)), null);
  assert.strictEqual(new Outbox({ getItem: () => '{broken', setItem() {}, removeItem() {} }).pending().length, 0);
});
