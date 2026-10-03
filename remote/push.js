'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { expandHome, writePrivateFile, ensurePrivateDir, DEVICE_ID_RE } = require('./auth');

const RECORD_SIZE = 4096;
const JWT_LIFETIME_S = 12 * 3600;
const TTL_S = 24 * 3600;
const TITLE_MAX = 120;
const TAG_MAX = 64;
const URL_MAX = 512;
const DEFAULT_PUSH_HOSTS = ['fcm.googleapis.com', '.push.apple.com', '.push.services.mozilla.com', '.notify.windows.com'];
const DEFAULT_SUBJECT = 'mailto:push@claude-remote.invalid';

class PushError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

function encrypt(plaintext, keys, opts = {}) {
  const uaPublic = Buffer.from(String(keys.p256dh), 'base64url');
  const authSecret = Buffer.from(String(keys.auth), 'base64url');
  const sender = crypto.createECDH('prime256v1');
  if (opts.senderPrivateKey) sender.setPrivateKey(opts.senderPrivateKey);
  else sender.generateKeys();
  const asPublic = sender.getPublicKey();
  const salt = opts.salt || crypto.randomBytes(16);
  const ecdhSecret = sender.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, ecdhSecret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, ct]);
}

function vapidAuthorization(endpoint, vapid, subject, nowMs) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + JWT_LIFETIME_S, sub: subject })}`;
  const key = crypto.createPrivateKey({ key: vapid.privateJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${sig.toString('base64url')}, k=${vapid.publicKey}`;
}

function hostAllowed(hostname, hosts) {
  return hosts.some((h) => (h.startsWith('.') ? hostname.endsWith(h) && hostname.length > h.length : hostname === h));
}

function checkSubscription(sub, hosts) {
  let url;
  try {
    url = new URL(String(sub && sub.endpoint));
  } catch {
    throw new PushError('bad-endpoint');
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !hostAllowed(url.hostname.toLowerCase(), hosts)) throw new PushError('bad-endpoint');
  const keys = sub.keys || {};
  const p256dh = Buffer.from(String(keys.p256dh || ''), 'base64url');
  const auth = Buffer.from(String(keys.auth || ''), 'base64url');
  if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) throw new PushError('bad-keys');
  try {
    crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: p256dh.subarray(1, 33).toString('base64url'), y: p256dh.subarray(33).toString('base64url') }, format: 'jwk' });
  } catch {
    throw new PushError('bad-keys');
  }
  return { endpoint: url.href, keys: { p256dh: p256dh.toString('base64url'), auth: auth.toString('base64url') } };
}

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').slice(0, max);
}

function cleanUrl(value) {
  const s = String(value || '');
  return s.startsWith('/') && !s.startsWith('//') && !s.includes('\\') && s.length <= URL_MAX ? s : '/';
}

function defaultSend(endpoint, headers, body) {
  return new Promise((resolve) => {
    const req = https.request(endpoint, { method: 'POST', headers: { ...headers, 'Content-Length': body.length }, timeout: 10000 }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(0));
    req.end(body);
  });
}

function createPush(config, opts = {}) {
  const stateDir = expandHome(config.stateDir);
  const keyFile = path.join(stateDir, 'push-vapid.json');
  const subFile = path.join(stateDir, 'push-subscriptions.json');
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const send = typeof opts.send === 'function' ? opts.send : defaultSend;
  const hosts = Array.isArray(config.pushHosts) && config.pushHosts.length ? config.pushHosts.map(String) : DEFAULT_PUSH_HOSTS;
  const subject = typeof config.pushSubject === 'string' && /^(mailto:|https:\/\/)/.test(config.pushSubject) ? config.pushSubject : DEFAULT_SUBJECT;
  ensurePrivateDir(stateDir);

  let vapid;
  if (fs.existsSync(keyFile)) {
    fs.chmodSync(keyFile, 0o600);
    vapid = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  } else {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const privateJwk = privateKey.export({ format: 'jwk' });
    const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(privateJwk.x, 'base64url'), Buffer.from(privateJwk.y, 'base64url')]).toString('base64url');
    vapid = { publicKey, privateJwk };
    writePrivateFile(keyFile, JSON.stringify(vapid) + '\n');
  }

  let subs = {};
  if (fs.existsSync(subFile)) {
    fs.chmodSync(subFile, 0o600);
    const data = JSON.parse(fs.readFileSync(subFile, 'utf8'));
    subs = data && data.devices && typeof data.devices === 'object' ? data.devices : {};
  }
  const persist = () => writePrivateFile(subFile, JSON.stringify({ version: 1, devices: subs }, null, 2) + '\n');

  return {
    publicKey: () => vapid.publicKey,
    authorization: (endpoint) => vapidAuthorization(endpoint, vapid, subject, now()),
    devices: () => Object.keys(subs),
    subscribe(deviceId, subscription) {
      if (!DEVICE_ID_RE.test(String(deviceId))) throw new PushError('bad-device');
      subs[deviceId] = checkSubscription(subscription, hosts);
      persist();
      log(`push subscribed device=${deviceId}`);
      return true;
    },
    unsubscribe(deviceId) {
      if (!Object.prototype.hasOwnProperty.call(subs, deviceId)) return false;
      delete subs[deviceId];
      persist();
      log(`push unsubscribed device=${deviceId}`);
      return true;
    },
    async notify({ deviceIds, title, tag, url } = {}) {
      const payload = Buffer.from(JSON.stringify({ title: cleanText(title, TITLE_MAX), tag: cleanText(tag, TAG_MAX), url: cleanUrl(url) }));
      const topic = crypto.createHash('sha256').update(cleanText(tag, TAG_MAX)).digest('base64url').slice(0, 32);
      const targets = Object.keys(subs).filter((id) => !Array.isArray(deviceIds) || deviceIds.includes(id));
      const result = { sent: 0, dropped: 0, failed: 0 };
      await Promise.all(
        targets.map(async (id) => {
          const sub = subs[id];
          const headers = { TTL: String(TTL_S), Urgency: 'high', Topic: topic, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: vapidAuthorization(sub.endpoint, vapid, subject, now()) };
          let status = 0;
          try {
            status = await send(sub.endpoint, headers, encrypt(payload, sub.keys));
          } catch {
            status = 0;
          }
          if (status >= 200 && status < 300) result.sent++;
          else if (status === 404 || status === 410) {
            if (subs[id] === sub) delete subs[id];
            result.dropped++;
            log(`push dropped device=${id} status=${status}`);
          } else {
            result.failed++;
            log(`push failed device=${id} status=${status}`);
          }
        }),
      );
      if (result.dropped) persist();
      log(`push notify targets=${targets.length} sent=${result.sent} dropped=${result.dropped} failed=${result.failed}`);
      return result;
    },
  };
}

module.exports = { createPush, encrypt, vapidAuthorization, PushError, DEFAULT_PUSH_HOSTS };
