'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const FAKE_CLAUDE = path.join(__dirname, 'fs-fake-claude.sh');

function tmuxBin() {
  for (const p of ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux']) if (fs.existsSync(p)) return p;
  return 'tmux';
}

function testCtx() {
  return { socket: `test-${crypto.randomBytes(4).toString('hex')}`, bin: tmuxBin(), childPath: '/usr/bin:/bin:/usr/sbin:/sbin' };
}

function killServer(ctx) {
  try {
    execFileSync(ctx.bin, ['-L', ctx.socket, 'kill-server'], { stdio: 'ignore' });
  } catch {}
}

function startPane(ctx, name, argv = ['/bin/sh', FAKE_CLAUDE], { cols = 80, rows = 12 } = {}) {
  execFileSync(ctx.bin, ['-L', ctx.socket, 'new-session', '-d', '-s', name, '-x', String(cols), '-y', String(rows), '-e', `PATH=${ctx.childPath}`, '--', ...argv]);
}

function capture(ctx, name) {
  return execFileSync(ctx.bin, ['-L', ctx.socket, 'capture-pane', '-p', '-t', `=${name}:`], { encoding: 'utf8' });
}

async function waitFor(fn, { timeout = 5000, interval = 25, what = 'condition' } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

function tempHome(prefix = 'remote-test-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function pushClient() {
  const crypto = require('crypto');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/test', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  const decrypt = (body) => {
    const salt = body.subarray(0, 16);
    const idlen = body[20];
    const asPublic = body.subarray(21, 21 + idlen);
    const ct = body.subarray(21 + idlen);
    const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
    const prk = hmac(salt, hmac(hmac(auth, ecdh.computeSecret(asPublic)), Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic, Buffer.from([1])])));
    const d = crypto.createDecipheriv('aes-128-gcm', hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16), hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12));
    d.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    let end = plain.length - 1;
    while (end > 0 && plain[end] === 0) end--;
    return JSON.parse(plain.subarray(0, end).toString('utf8'));
  };
  return { subscription, decrypt };
}

module.exports = { pushClient, FAKE_CLAUDE, tmuxBin, testCtx, killServer, startPane, capture, waitFor, tempHome };
