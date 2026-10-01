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

module.exports = { FAKE_CLAUDE, tmuxBin, testCtx, killServer, startPane, capture, waitFor, tempHome };
