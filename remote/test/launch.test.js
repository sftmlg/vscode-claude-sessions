'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RUN = path.join(__dirname, '..', 'claude-run.js');

test('without a running service the editor tab runs the original command unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-run-'));
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ stateDir: path.join(dir, 'state'), port: 1 }));
  const r = spawnSync(process.execPath, [RUN, '/bin/echo', 'ran', '--resume', 'x'], { env: { ...process.env, CLAUDE_REMOTE_CONFIG: config }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, 'ran --resume x\n');
  assert.strictEqual(r.stderr, '', 'no service is the normal case on a machine without it, not an error');
  const only = spawnSync(process.execPath, [RUN, '--attach-only', 'abcdabcd-0000-4000-8000-000000000000'], { env: { ...process.env, CLAUDE_REMOTE_CONFIG: config }, encoding: 'utf8' });
  assert.strictEqual(only.status, 1, 'reattaching never starts anything');
});
