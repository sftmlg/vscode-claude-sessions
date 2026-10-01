'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../config');
const { tempHome } = require('./fixtures/fs-helpers');

test('generic defaults without a config file, state dir created with mode 0700', () => {
  const home = tempHome();
  const c = loadConfig({ home, env: {} });
  assert.strictEqual(c.port, 39181);
  assert.strictEqual(c.publicPort, 39180);
  assert.strictEqual(c.tmuxSocket, 'ccremote');
  assert.strictEqual(c.publicHost, null);
  assert.strictEqual(c.allowedLogin, null);
  assert.deepStrictEqual(c.roots, [home]);
  assert.strictEqual(c.defaultDir, home);
  assert.deepStrictEqual(c.claudeCommand, ['claude']);
  assert.deepStrictEqual(c.launcher, []);
  assert.strictEqual(c.stateDir, path.join(home, '.local/state/claude-remote'));
  assert.strictEqual(fs.statSync(c.stateDir).mode & 0o777, 0o700);
});

test('values from the config file override defaults and ~ is expanded', () => {
  const home = tempHome();
  const file = path.join(home, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ publicHost: 'host.example.test', allowedLogin: 'someone@example.test', roots: ['~/work'], defaultDir: '~/work', launcher: ['/opt/x/wrap', 'exec', '--'], stateDir: '~/state' }));
  const c = loadConfig({ file, home });
  assert.strictEqual(c.publicHost, 'host.example.test');
  assert.deepStrictEqual(c.roots, [path.join(home, 'work')]);
  assert.strictEqual(c.defaultDir, path.join(home, 'work'));
  assert.deepStrictEqual(c.launcher, ['/opt/x/wrap', 'exec', '--']);
  assert.strictEqual(c.stateDir, path.join(home, 'state'));
});

test('CLAUDE_REMOTE_CONFIG selects the file', () => {
  const home = tempHome();
  const file = path.join(home, 'other.json');
  fs.writeFileSync(file, JSON.stringify({ port: 40001 }));
  assert.strictEqual(loadConfig({ home, env: { CLAUDE_REMOTE_CONFIG: file } }).port, 40001);
});

test('invalid values are rejected with a readable error', () => {
  const home = tempHome();
  const file = path.join(home, 'bad.json');
  for (const bad of [{ port: 'x' }, { tmuxSocket: 'a;b' }, { roots: [] }, { claudeCommand: 'claude' }, { publicHost: 'a b' }, { launcher: [1] }]) {
    fs.writeFileSync(file, JSON.stringify(bad));
    assert.throws(() => loadConfig({ file, home }), /Invalid remote config/);
  }
  fs.writeFileSync(file, '{not json');
  assert.throws(() => loadConfig({ file, home }), /Cannot read remote config/);
  fs.writeFileSync(file, '[]');
  assert.throws(() => loadConfig({ file, home }), /must be a JSON object/);
});
