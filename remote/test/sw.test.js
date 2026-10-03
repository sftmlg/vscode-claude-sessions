'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'web', 'sw.js'), 'utf8');
const SCOPE = 'https://hub.example.test:39180/';

function load({ windows = [], cacheNames = ['old-shell'] } = {}) {
  const listeners = {};
  const shown = [];
  const opened = [];
  const deleted = [];
  const self = {
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    skipWaiting: async () => {},
    registration: {
      scope: SCOPE,
      showNotification: async (title, options) => shown.push({ title, options }),
    },
    clients: {
      claim: async () => {},
      matchAll: async () => windows,
      openWindow: async (url) => opened.push(url),
    },
  };
  const caches = { keys: async () => cacheNames, delete: async (n) => (deleted.push(n), true) };
  vm.runInNewContext(SOURCE, { self, caches, URL, JSON, Promise, console });
  const fire = async (type, extra = {}) => {
    const waits = [];
    const event = { waitUntil: (p) => waits.push(p), ...extra };
    listeners[type](event);
    await Promise.all(waits);
    return event;
  };
  return { listeners, shown, opened, deleted, fire };
}

const pushEvent = (data) => ({ data: data === undefined ? null : { json: () => JSON.parse(data), text: () => data } });

test('the worker registers no fetch handler, so every request goes to the network', () => {
  const w = load();
  assert.ok(!('fetch' in w.listeners));
  assert.ok(!/caches\.open|cache\.put|cache\.add/.test(SOURCE), 'nothing is ever written to Cache Storage');
});

test('activate removes every cache left by earlier versions', async () => {
  const w = load({ cacheNames: ['a', 'b'] });
  await w.fire('activate');
  assert.deepStrictEqual(w.deleted, ['a', 'b']);
});

test('push shows one notification per tag with only title and url', async () => {
  const w = load();
  await w.fire('push', pushEvent(JSON.stringify({ title: 'Session waits', tag: 'session:abc', url: '/#s=abc', body: 'leak' })));
  assert.strictEqual(w.shown.length, 1);
  const { title, options } = w.shown[0];
  assert.strictEqual(title, 'Session waits');
  assert.strictEqual(options.tag, 'session:abc');
  assert.strictEqual(options.renotify, true);
  assert.strictEqual(options.data.url, `${SCOPE}#s=abc`);
  assert.ok(!('body' in options) || !String(options.body).includes('leak'), 'no message text is shown');
});

test('a push without a readable payload still shows a generic notification', async () => {
  for (const data of [undefined, 'not json', '[]']) {
    const w = load();
    await w.fire('push', pushEvent(data));
    assert.strictEqual(w.shown.length, 1, String(data));
    assert.ok(w.shown[0].title);
    assert.strictEqual(w.shown[0].options.data.url, SCOPE);
  }
});

test('notification urls outside the worker scope fall back to the scope', async () => {
  for (const url of ['https://evil.example/x', '//evil.example/x', 'javascript:alert(1)', 'http://hub.example.test:39180/']) {
    const w = load();
    await w.fire('push', pushEvent(JSON.stringify({ title: 't', tag: 'x', url })));
    assert.strictEqual(w.shown[0].options.data.url, SCOPE, url);
  }
});

test('a click focuses an open app window and tells it which session to open', async () => {
  const messages = [];
  let focused = 0;
  const win = { url: `${SCOPE}`, focus: async () => (focused++, win), postMessage: (m) => messages.push(m) };
  const w = load({ windows: [{ url: 'https://other.example/', focus: async () => assert.fail('foreign window') }, win] });
  let closed = false;
  await w.fire('notificationclick', { notification: { data: { url: `${SCOPE}#s=abc` }, close: () => (closed = true) } });
  assert.ok(closed);
  assert.strictEqual(focused, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(messages)), [{ t: 'notificationClick', url: `${SCOPE}#s=abc` }]);
  assert.deepStrictEqual(w.opened, []);
});

test('a click opens the app when no window is open', async () => {
  const w = load({ windows: [] });
  await w.fire('notificationclick', { notification: { data: { url: `${SCOPE}#s=abc` }, close: () => {} } });
  assert.deepStrictEqual(w.opened, [`${SCOPE}#s=abc`]);
  const w2 = load({ windows: [] });
  await w2.fire('notificationclick', { notification: { data: { url: 'https://evil.example/' }, close: () => {} } });
  assert.deepStrictEqual(w2.opened, [SCOPE]);
});

test('a changed push subscription is reported to open windows so the app subscribes again', async () => {
  const messages = [];
  const w = load({ windows: [{ url: SCOPE, postMessage: (m) => messages.push(m) }] });
  await w.fire('pushsubscriptionchange');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(messages)), [{ t: 'pushSubscriptionChange' }]);
});
