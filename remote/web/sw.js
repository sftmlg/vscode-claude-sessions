'use strict';

const DEFAULT_TITLE = 'Claude session';

function inScope(url) {
  const scope = self.registration.scope;
  try {
    const resolved = new URL(String(url || ''), scope).href;
    return resolved.startsWith(scope) ? resolved : scope;
  } catch {
    return scope;
  }
}

function readPayload(data) {
  if (!data) return {};
  try {
    const value = data.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

async function appWindows() {
  const scope = self.registration.scope;
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return all.filter((c) => String(c.url).startsWith(scope));
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('push', (event) => {
  const payload = readPayload(event.data);
  const title = typeof payload.title === 'string' && payload.title ? payload.title.slice(0, 120) : DEFAULT_TITLE;
  const tag = typeof payload.tag === 'string' && payload.tag ? payload.tag.slice(0, 64) : 'claude-remote';
  event.waitUntil(self.registration.showNotification(title, { tag, renotify: true, icon: 'icon.svg', data: { url: inScope(payload.url) } }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = inScope(event.notification.data && event.notification.data.url);
  event.waitUntil(
    appWindows().then(async (windows) => {
      const win = windows[0];
      if (!win) return self.clients.openWindow(url);
      await win.focus();
      win.postMessage({ t: 'notificationClick', url });
      return undefined;
    }),
  );
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(appWindows().then((windows) => windows.forEach((w) => w.postMessage({ t: 'pushSubscriptionChange' }))));
});
