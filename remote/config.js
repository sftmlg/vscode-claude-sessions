'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMUX_CANDIDATES = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'];

function defaults(home) {
  return {
    port: 39181,
    publicPort: 39180,
    publicHost: null,
    allowedLogin: null,
    tmuxSocket: 'ccremote',
    tmuxPath: TMUX_CANDIDATES.find((p) => fs.existsSync(p)) || 'tmux',
    stateDir: '~/.local/state/claude-remote',
    roots: [home],
    defaultDir: home,
    launcher: [],
    claudeCommand: ['claude'],
    claudeArgs: [],
    childPath: `${home}/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
}

function expandHome(p, home) {
  if (typeof p !== 'string') return p;
  if (p === '~') return home;
  return p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0);
const isPort = (v) => Number.isInteger(v) && v > 0 && v < 65536;

function validate(c) {
  const errors = [];
  if (!isPort(c.port)) errors.push('port must be an integer 1..65535');
  if (!isPort(c.publicPort)) errors.push('publicPort must be an integer 1..65535');
  if (c.publicHost !== null && !/^[a-zA-Z0-9.-]+$/.test(String(c.publicHost))) errors.push('publicHost must be a host name');
  if (c.allowedLogin !== null && typeof c.allowedLogin !== 'string') errors.push('allowedLogin must be a string');
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(String(c.tmuxSocket))) errors.push('tmuxSocket must match [a-zA-Z0-9_-]{1,40}');
  for (const key of ['tmuxPath', 'stateDir', 'defaultDir', 'childPath']) {
    if (typeof c[key] !== 'string' || !c[key]) errors.push(`${key} must be a non-empty string`);
  }
  if (!isStringArray(c.roots) || !c.roots.length) errors.push('roots must be a non-empty array of paths');
  for (const key of ['launcher', 'claudeCommand', 'claudeArgs']) {
    if (!Array.isArray(c[key]) || !c[key].every((x) => typeof x === 'string')) errors.push(`${key} must be an array of strings`);
  }
  if (!isStringArray(c.claudeCommand) || !c.claudeCommand.length) errors.push('claudeCommand must not be empty');
  if (errors.length) throw new Error(`Invalid remote config: ${errors.join('; ')}`);
}

function configFile(env = process.env, home = os.homedir()) {
  return env.CLAUDE_REMOTE_CONFIG || path.join(home, '.config', 'claude-remote', 'config.json');
}

function loadConfig({ file, env = process.env, home = os.homedir(), overrides = {} } = {}) {
  const source = file || configFile(env, home);
  let fromFile = {};
  try {
    fromFile = JSON.parse(fs.readFileSync(source, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`Cannot read remote config ${source}: ${e.message}`);
  }
  if (!fromFile || typeof fromFile !== 'object' || Array.isArray(fromFile)) throw new Error(`Remote config ${source} must be a JSON object`);
  const c = { ...defaults(home), ...fromFile, ...overrides };
  c.stateDir = expandHome(c.stateDir, home);
  c.defaultDir = expandHome(c.defaultDir, home);
  if (Array.isArray(c.roots)) c.roots = c.roots.map((r) => expandHome(r, home));
  validate(c);
  c.stateDir = path.resolve(c.stateDir);
  fs.mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(c.stateDir, 0o700);
  c.configFile = source;
  return c;
}

module.exports = { loadConfig, configFile, expandHome };
