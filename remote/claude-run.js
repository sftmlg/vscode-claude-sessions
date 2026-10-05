#!/usr/bin/env node
'use strict';
const { spawnSync } = require('child_process');
const { loadConfig } = require('./config');
const { requestLaunch } = require('./launch');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resumeIdOf(args) {
  const i = args.indexOf('--resume');
  return i >= 0 && UUID_RE.test(args[i + 1] || '') ? args[i + 1] : null;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  return r.status === null ? 1 : r.status;
}

async function main(argv) {
  const attachOnly = argv[0] === '--attach-only';
  const fallback = attachOnly ? [] : argv;
  const resumeId = attachOnly ? argv[1] : resumeIdOf(argv);
  let config = null;
  try {
    config = loadConfig();
  } catch {}
  const r = config ? await requestLaunch(config, { dir: process.cwd(), resumeId, attachOnly }) : { status: 0, body: { error: 'no-service' } };
  if (r.status === 200 && r.body.name) return run(config.tmuxPath || 'tmux', ['-u', '-L', config.tmuxSocket, 'attach', '-t', `=${r.body.name}`]);
  if (attachOnly) return 1;
  if (r.body.error !== 'no-service') process.stderr.write(`claude-run: the service did not start it (${r.body.msg || r.body.error}); running it here\n`);
  return fallback.length ? run(fallback[0], fallback.slice(1)) : 1;
}

main(process.argv.slice(2)).then((code) => process.exit(code));
