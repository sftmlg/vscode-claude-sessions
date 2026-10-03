'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPush, encrypt, vapidAuthorization } = require('../push');

const b64 = (s) => Buffer.from(s.replace(/\s+/g, ''), 'base64url');

const RFC8291 = {
  plaintext: 'When I grow up, I want to be a watermelon',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
         mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
         pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`,
};

function decrypt(body, uaPrivate, authSecret) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const uaPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(asPublic);
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const prkKey = hmac(authSecret, secret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = plain.length - 1;
  while (end > 0 && plain[end] === 0) end--;
  assert.strictEqual(plain[end], 2, 'last record delimiter');
  return plain.subarray(0, end);
}

function client() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    priv: ecdh.getPrivateKey(),
    auth,
    subscription: (endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomBytes(8).toString('hex')}`) => ({
      endpoint,
      keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
    }),
  };
}

function tmpConfig(extra = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-push-'));
  return { stateDir: path.join(base, 'state'), publicHost: 'hub.example.test', ...extra };
}

test('encrypt reproduces the RFC 8291 example byte for byte', () => {
  const out = encrypt(Buffer.from(RFC8291.plaintext), { p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret }, { salt: b64(RFC8291.salt), senderPrivateKey: b64(RFC8291.asPrivate) });
  assert.strictEqual(out.toString('base64url'), RFC8291.body.replace(/\s+/g, ''));
  assert.strictEqual(out.subarray(21, 86).toString('base64url'), RFC8291.asPublic);
  assert.strictEqual(decrypt(out, b64(RFC8291.uaPrivate), b64(RFC8291.authSecret)).toString(), RFC8291.plaintext);
});

test('encrypt uses a fresh salt and sender key per message', () => {
  const c = client();
  const sub = c.subscription();
  const a = encrypt(Buffer.from('x'), sub.keys);
  const b = encrypt(Buffer.from('x'), sub.keys);
  assert.notDeepStrictEqual(a.subarray(0, 16), b.subarray(0, 16));
  assert.notDeepStrictEqual(a.subarray(21, 86), b.subarray(21, 86));
  assert.strictEqual(decrypt(a, c.priv, c.auth).toString(), 'x');
  assert.strictEqual(a.readUInt32BE(16), 4096);
});

test('VAPID keys are generated once, stored 0600 and the JWT verifies with the public key', () => {
  const config = tmpConfig();
  const p = createPush(config, { now: () => 1_700_000_000_000 });
  const file = path.join(config.stateDir, 'push-vapid.json');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(config.stateDir).mode & 0o777, 0o700);
  assert.strictEqual(createPush(config).publicKey(), p.publicKey());
  const raw = b64(p.publicKey());
  assert.strictEqual(raw.length, 65);
  assert.strictEqual(raw[0], 4);
  const header = p.authorization('https://fcm.googleapis.com/fcm/send/abc');
  const m = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/.exec(header);
  assert.ok(m, header);
  assert.strictEqual(m[2], p.publicKey());
  const [h, c, s] = m[1].split('.');
  assert.deepStrictEqual(JSON.parse(b64(h)), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(b64(c));
  assert.strictEqual(claims.aud, 'https://fcm.googleapis.com');
  assert.strictEqual(claims.exp, 1_700_000_000 + 12 * 3600);
  assert.match(claims.sub, /^(mailto:|https:\/\/)/);
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, b64(s)));
  assert.strictEqual(typeof vapidAuthorization, 'function');
});

test('subscribe accepts only https endpoints of known push services with valid keys', () => {
  const p = createPush(tmpConfig());
  const c = client();
  for (const endpoint of ['https://fcm.googleapis.com/fcm/send/x', 'https://web.push.apple.com/abc', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-par02p.notify.windows.com/w/?token=x']) {
    assert.strictEqual(p.subscribe('dev-aaaaaaaaaaaa', c.subscription(endpoint)), true, endpoint);
  }
  for (const endpoint of ['http://fcm.googleapis.com/x', 'https://127.0.0.1:39181/admin/approve', 'https://localhost/x', 'https://evil.example/x', 'https://fcm.googleapis.com.evil.example/x', 'https://user@fcm.googleapis.com/x', 'not a url']) {
    assert.throws(() => p.subscribe('dev-aaaaaaaaaaaa', c.subscription(endpoint)), { code: 'bad-endpoint' }, endpoint);
  }
  const good = c.subscription();
  assert.throws(() => p.subscribe('dev-aaaaaaaaaaaa', { ...good, keys: { ...good.keys, p256dh: 'AAAA' } }), { code: 'bad-keys' });
  assert.throws(() => p.subscribe('dev-aaaaaaaaaaaa', { ...good, keys: { ...good.keys, auth: 'AAAA' } }), { code: 'bad-keys' });
  const offCurve = Buffer.alloc(65, 1);
  offCurve[0] = 4;
  assert.throws(() => p.subscribe('dev-aaaaaaaaaaaa', { ...good, keys: { ...good.keys, p256dh: offCurve.toString('base64url') } }), { code: 'bad-keys' });
  assert.throws(() => p.subscribe('../x', good), { code: 'bad-device' });
  assert.throws(() => p.subscribe('dev-aaaaaaaaaaaa', null), { code: 'bad-endpoint' });
});

test('subscriptions persist 0600, one per device, and unsubscribe removes them', () => {
  const config = tmpConfig();
  const p = createPush(config);
  const c = client();
  p.subscribe('dev-aaaaaaaaaaaa', c.subscription());
  p.subscribe('dev-aaaaaaaaaaaa', c.subscription());
  p.subscribe('dev-bbbbbbbbbbbb', c.subscription());
  const file = path.join(config.stateDir, 'push-subscriptions.json');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepStrictEqual(createPush(config).devices().sort(), ['dev-aaaaaaaaaaaa', 'dev-bbbbbbbbbbbb']);
  assert.strictEqual(p.unsubscribe('dev-aaaaaaaaaaaa'), true);
  assert.strictEqual(p.unsubscribe('dev-aaaaaaaaaaaa'), false);
  assert.deepStrictEqual(createPush(config).devices(), ['dev-bbbbbbbbbbbb']);
});

test('notify sends only title, tag and url, groups by Topic and drops gone subscriptions', async () => {
  const config = tmpConfig();
  const sent = [];
  const statusFor = { gone: 410, missing: 404, broken: 500 };
  const logs = [];
  const p = createPush(config, {
    log: (l) => logs.push(l),
    send: async (endpoint, headers, body) => {
      sent.push({ endpoint, headers, body });
      const key = Object.keys(statusFor).find((k) => endpoint.endsWith(k));
      return key ? statusFor[key] : 201;
    },
  });
  const devices = { ok: client(), gone: client(), missing: client(), broken: client(), other: client() };
  p.subscribe('dev-000000000001', devices.ok.subscription('https://fcm.googleapis.com/fcm/send/ok'));
  p.subscribe('dev-000000000002', devices.gone.subscription('https://fcm.googleapis.com/fcm/send/gone'));
  p.subscribe('dev-000000000003', devices.missing.subscription('https://fcm.googleapis.com/fcm/send/missing'));
  p.subscribe('dev-000000000004', devices.broken.subscription('https://fcm.googleapis.com/fcm/send/broken'));
  p.subscribe('dev-000000000005', devices.other.subscription('https://fcm.googleapis.com/fcm/send/other'));
  const r = await p.notify({ deviceIds: ['dev-000000000001', 'dev-000000000002', 'dev-000000000003', 'dev-000000000004'], title: 'Session waits', tag: 'session:abc', url: '/#s=abc', text: 'SECRET MESSAGE TEXT', body: 'SECRET' });
  assert.deepStrictEqual(r, { sent: 1, dropped: 2, failed: 1 });
  assert.strictEqual(sent.length, 4);
  assert.ok(!sent.some((s) => s.endpoint.endsWith('/other')), 'deviceIds limits the targets');
  const okMsg = sent.find((s) => s.endpoint.endsWith('/ok'));
  assert.deepStrictEqual(JSON.parse(decrypt(okMsg.body, devices.ok.priv, devices.ok.auth)), { title: 'Session waits', tag: 'session:abc', url: '/#s=abc' });
  assert.strictEqual(okMsg.headers['Content-Encoding'], 'aes128gcm');
  assert.match(okMsg.headers.Authorization, /^vapid t=/);
  assert.match(okMsg.headers.Topic, /^[A-Za-z0-9_-]{1,32}$/);
  assert.ok(Number(okMsg.headers.TTL) > 0);
  assert.deepStrictEqual(p.devices().sort(), ['dev-000000000001', 'dev-000000000004', 'dev-000000000005']);
  assert.ok(!logs.join('\n').includes('SECRET') && !logs.join('\n').includes('fcm.googleapis.com/fcm/send/ok'), 'logs carry no text and no endpoint');
  const all = await p.notify({ title: 't', tag: 'x', url: '/' });
  assert.strictEqual(all.sent + all.failed, 3, 'without deviceIds every subscription is notified');
});

test('notify bounds title, tag and url and refuses absolute or protocol-relative urls', async () => {
  const sent = [];
  const p = createPush(tmpConfig(), { send: async (e, h, b) => (sent.push(b), 201) });
  const c = client();
  p.subscribe('dev-000000000001', c.subscription());
  await p.notify({ title: 'x'.repeat(500), tag: 'y'.repeat(500), url: 'javascript:alert(1)' });
  await p.notify({ title: 'a', tag: 'b', url: '//evil.example/x' });
  await p.notify({ title: 'a', tag: 'b', url: 'https://evil.example/x' });
  const msgs = sent.map((b) => JSON.parse(decrypt(b, c.priv, c.auth)));
  assert.strictEqual(msgs[0].title.length, 120);
  assert.strictEqual(msgs[0].tag.length, 64);
  for (const m of msgs) assert.strictEqual(m.url, '/');
});
