export const PUSH_UNAVAILABLE = 'needs HTTPS — enable certificates in the tailnet';

export function pushSupported(w = globalThis) {
  return Boolean(w && w.isSecureContext && w.navigator && 'serviceWorker' in w.navigator && 'PushManager' in w && 'Notification' in w);
}

export function keyBytes(key) {
  const b64 = String(key).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function subscribePush(key) {
  if (!pushSupported()) throw new Error(PUSH_UNAVAILABLE);
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications are blocked for this site in the browser settings.');
  await navigator.serviceWorker.register('sw.js');
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  if (existing) await existing.unsubscribe();
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  return sub.toJSON();
}

export async function unsubscribePush() {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && (await reg.pushManager.getSubscription());
  if (sub) await sub.unsubscribe();
}

export function onNotificationClick(cb) {
  if (!pushSupported()) return;
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.t === 'notificationClick') cb(String(e.data.url || ''));
  });
}

export function onSubscriptionChange(cb) {
  if (!pushSupported()) return;
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.t === 'pushSubscriptionChange') cb();
  });
}

export async function currentSubscription() {
  if (!pushSupported() || Notification.permission !== 'granted') return null;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && (await reg.pushManager.getSubscription());
  return sub ? sub.toJSON() : null;
}

export function sessionTarget(url) {
  const m = /#session=([^&]+)$/.exec(String(url || ''));
  if (!m) return null;
  try {
    const raw = m[1];
    const slash = raw.indexOf('/');
    if (slash < 0) return { host: null, key: decodeURIComponent(raw) };
    return { host: decodeURIComponent(raw.slice(0, slash)).toLowerCase(), key: decodeURIComponent(raw.slice(slash + 1)) };
  } catch {
    return null;
  }
}

export function sessionFromUrl(url) {
  const t = sessionTarget(url);
  return t ? t.key : null;
}

export function sessionHash(host, key) {
  return `#session=${encodeURIComponent(host)}/${encodeURIComponent(key)}`;
}
