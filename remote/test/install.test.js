'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const INSTALL = path.join(__dirname, '..', 'install.sh');
const STATUS_FIXTURE = path.join(__dirname, 'fixtures', 'sec-tailscale-status.json');
const LABEL = 'com.claude-remote.hub';

function fakeBin(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
}

function sandbox() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-install-')));
  const home = path.join(base, 'home');
  const bin = path.join(base, 'bin');
  const log = path.join(base, 'calls.log');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(home, 'work'));
  fakeBin(bin, 'tailscale', `echo "tailscale $*" >> "${log}"\nif [ "$1" = status ]; then cat "${STATUS_FIXTURE}"; fi`);
  fakeBin(bin, 'launchctl', `echo "launchctl $*" >> "${log}"`);
  fakeBin(bin, 'npm', `echo "npm $* cwd=$(pwd -P)" >> "${log}"`);
  const env = { HOME: home, PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` };
  const install = (...args) => spawnSync('/bin/bash', [INSTALL, ...args], { env, encoding: 'utf8' });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  return { base, home, bin, log, env, install, calls };
}

function listTree(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    out.push(p);
    if (e.isDirectory()) out.push(...listTree(p));
  }
  return out.sort();
}

test('dry run prints every action, renders the plist and changes nothing', () => {
  const s = sandbox();
  const before = listTree(s.home);
  const r = s.install('--dry-run', '--root', path.join(s.home, 'work'), '--launcher', '/opt/x/wrapper', '--launcher-arg', 'exec', '--claude-arg', '--verbose');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(listTree(s.home), before);
  assert.deepStrictEqual(s.calls(), ['tailscale status --json']);
  assert.match(r.stdout, /\+ \S*launchctl bootstrap gui\/\d+ \S+com\.claude-remote\.hub\.plist/);
  assert.match(r.stdout, /\+ \S*tailscale serve --bg --http=39180 http:\/\/127\.0\.0\.1:39181/);
  assert.match(r.stdout, /\+ npm ci --omit=dev --ignore-scripts/);
  assert.match(r.stdout, /<string>com\.claude-remote\.hub<\/string>/);
  assert.ok(!/funnel/i.test(r.stdout));
  assert.ok(!r.stdout.includes('owner@example.test'), 'the login is not echoed');
});

test('install writes a private merged config and a valid LaunchAgent, and is re-runnable', () => {
  const s = sandbox();
  const cfgDir = path.join(s.home, '.config', 'claude-remote');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ port: 40001, publicPort: 40000, claudeArgs: ['--keep'], custom: 'x' }));
  const work = path.join(s.home, 'work');
  const args = ['--no-check', '--root', work, '--default-dir', work, '--launcher', '/opt/x/wrapper', '--launcher-arg', 'exec', '--launcher-arg', 'auto'];
  const r1 = s.install(...args);
  assert.strictEqual(r1.status, 0, r1.stderr + r1.stdout);
  const r2 = s.install(...args);
  assert.strictEqual(r2.status, 0, r2.stderr);

  const cfgFile = path.join(cfgDir, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  assert.deepStrictEqual(cfg, {
    port: 40001, publicPort: 40000, claudeArgs: ['--keep'], custom: 'x',
    publicHost: 'hub.example.test', allowedLogin: 'owner@example.test',
    roots: [work], defaultDir: work, launcher: ['/opt/x/wrapper', 'exec', 'auto'],
  });
  assert.strictEqual(fs.statSync(cfgFile).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(cfgDir).mode & 0o777, 0o700);
  const stateDir = path.join(s.home, '.local', 'state', 'claude-remote');
  assert.strictEqual(fs.statSync(stateDir).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(path.join(stateDir, 'server.err.log')).mode & 0o777, 0o600);

  const plist = path.join(s.home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  execFileSync('/usr/bin/plutil', ['-lint', '-s', plist]);
  const p = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }));
  assert.strictEqual(p.Label, LABEL);
  assert.ok(path.isAbsolute(p.ProgramArguments[0]));
  assert.match(p.ProgramArguments[1], /\/remote\/server\.js$/);
  assert.strictEqual(p.EnvironmentVariables.PATH, `${s.home}/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`);
  assert.strictEqual(p.EnvironmentVariables.CLAUDE_REMOTE_CONFIG, cfgFile);
  assert.strictEqual(p.LimitLoadToSessionType, 'Aqua');
  assert.strictEqual(p.RunAtLoad, true);
  assert.strictEqual(p.KeepAlive, true);
  assert.ok(p.ThrottleInterval >= 5);
  assert.strictEqual(p.Umask, 63);
  assert.strictEqual(p.StandardErrorPath, path.join(stateDir, 'server.err.log'));
  assert.ok(!fs.readFileSync(plist, 'utf8').includes('owner@example.test'), 'no installation identity in the plist');

  const calls = s.calls();
  const uid = String(process.getuid());
  assert.ok(calls.includes(`launchctl bootout gui/${uid}/${LABEL}`));
  assert.ok(calls.includes(`launchctl bootstrap gui/${uid} ${plist}`));
  assert.ok(calls.includes('tailscale serve --bg --http=40000 http://127.0.0.1:40001'));
  assert.ok(calls.some((c) => /^npm ci --omit=dev --ignore-scripts cwd=/.test(c)));
  assert.ok(!calls.some((c) => /funnel|reset/.test(c)));
});

test('uninstall removes the agent and only its own serve port, keeping config and state', () => {
  const s = sandbox();
  assert.strictEqual(s.install('--no-check').status, 0);
  const r = s.install('--uninstall');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(s.home, 'Library', 'LaunchAgents', `${LABEL}.plist`)));
  assert.ok(fs.existsSync(path.join(s.home, '.config', 'claude-remote', 'config.json')));
  const calls = s.calls();
  assert.strictEqual(calls[calls.length - 1], 'tailscale serve --http=39180 off');
  assert.ok(calls.includes(`launchctl bootout gui/${process.getuid()}/${LABEL}`));
});

test('bad arguments and a node without identity are refused before any change', () => {
  const s = sandbox();
  assert.strictEqual(s.install('--root').status, 2);
  assert.strictEqual(s.install('--launcher-arg', 'x').status, 2);
  assert.strictEqual(s.install('--bogus').status, 2);
  fakeBin(s.bin, 'tailscale', 'echo \'{"Self":{"DNSName":"","UserID":1},"User":{}}\'');
  const r = s.install('--no-check');
  assert.notStrictEqual(r.status, 0);
  assert.ok(!fs.existsSync(path.join(s.home, '.config')));
});
