'use strict';
const { execFile, spawn } = require('child_process');
const { EventEmitter } = require('events');

const NAME_RE = /^cc-[a-z0-9-]{1,40}$/;
const BUFFER_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const KEYS = new Set(['Enter', 'Escape', 'Tab', 'BTab', 'Up', 'Down', 'Left', 'Right', 'PageUp', 'PageDown', 'Home', 'End', 'BSpace', 'Space', 'C-c', 'C-d', 'C-o', 'C-r', 'C-l', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'y', 'n']);
const ENTER_DELAY_MS = 50;
const SNAPSHOT_FORMAT = '#{pane_id},#{cursor_x},#{cursor_y},#{cursor_flag},#{alternate_on},#{pane_width},#{pane_height}';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assertName(name) {
  if (!NAME_RE.test(String(name))) throw new Error(`Invalid session name "${name}"`);
  return name;
}

const paneTarget = (name) => `=${assertName(name)}:`;

function stripControls(text) {
  return String(text).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

function run(ctx, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(ctx.bin || 'tmux', ['-u', '-L', ctx.socket, ...args], { maxBuffer: 8 * 1024 * 1024, timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || '').trim();
        reject(err);
      } else resolve(stdout);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

const LIST_FORMAT = ['#{session_name}', '#{session_created}', '#{session_attached}', '#{pane_pid}', '#{pane_tty}', '#{pane_current_path}', '#{window_width}', '#{window_height}', '#{session_activity}'].join('\t');

async function listSessions(ctx) {
  let out;
  try {
    out = await run(ctx, ['list-sessions', '-F', LIST_FORMAT]);
  } catch (e) {
    if (/no server running|error connecting|No such file/i.test(e.stderr || '')) return [];
    throw e;
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, created, attached, panePid, paneTty, cwd, cols, rows, activity] = line.split('\t');
      return { name, created: Number(created) * 1000, attached: Number(attached), panePid: Number(panePid), paneTty, cwd, cols: Number(cols), rows: Number(rows), activity: Number(activity) * 1000 };
    })
    .filter((s) => NAME_RE.test(s.name));
}

async function newSession(ctx, { name, dir, argv, cols = 120, rows = 40 }) {
  assertName(name);
  if (!Array.isArray(argv) || argv.length < 2 || !argv.every((a) => typeof a === 'string')) throw new Error('argv needs at least two entries so tmux does not use a shell');
  const env = ctx.childPath ? ['-e', `PATH=${ctx.childPath}`] : [];
  await run(ctx, ['new-session', '-d', '-s', name, '-x', String(cols), '-y', String(rows), '-c', dir, ...env, '--', ...argv]);
}

async function hasSession(ctx, name) {
  try {
    await run(ctx, ['has-session', '-t', `=${assertName(name)}`]);
    return true;
  } catch {
    return false;
  }
}

async function paste(ctx, name, bufferId, text, { enter = true } = {}) {
  const target = paneTarget(name);
  if (!BUFFER_RE.test(String(bufferId))) throw new Error('Invalid buffer id');
  const clean = stripControls(text);
  await run(ctx, ['load-buffer', '-b', bufferId, '-'], { input: clean });
  await run(ctx, ['paste-buffer', '-p', '-d', '-b', bufferId, '-t', target]);
  if (enter) {
    await sleep(ENTER_DELAY_MS);
    await run(ctx, ['send-keys', '-t', target, 'Enter']);
  }
  return clean.length;
}

async function sendKey(ctx, name, key) {
  if (!KEYS.has(key)) throw new Error(`Key "${key}" is not allowed`);
  await run(ctx, ['send-keys', '-t', paneTarget(name), key]);
}

function decodeOutput(buf, start = 0) {
  const out = Buffer.allocUnsafe(buf.length - start);
  let n = 0;
  for (let i = start; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x5c && i + 3 < buf.length && isOctal(buf[i + 1]) && isOctal(buf[i + 2]) && isOctal(buf[i + 3])) {
      out[n++] = ((buf[i + 1] - 48) << 6) | ((buf[i + 2] - 48) << 3) | (buf[i + 3] - 48);
      i += 3;
    } else out[n++] = b;
  }
  return out.subarray(0, n);
}

const isOctal = (b) => b >= 0x30 && b <= 0x37;

class ControlClient extends EventEmitter {
  constructor(ctx, name) {
    super();
    this.ctx = ctx;
    this.name = assertName(name);
    this.pending = [];
    this.block = null;
    this.ready = false;
    this.closed = false;
    this.partial = Buffer.alloc(0);
  }

  start() {
    this.proc = spawn(this.ctx.bin || 'tmux', ['-u', '-L', this.ctx.socket, '-C', 'attach', '-t', `=${this.name}`], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (chunk) => this.onData(chunk));
    this.proc.stderr.on('data', () => {});
    this.proc.stdin.on('error', () => {});
    this.proc.on('error', (e) => this.finish(e));
    this.proc.on('exit', () => this.finish());
    return this;
  }

  onData(chunk) {
    let buf = this.partial.length ? Buffer.concat([this.partial, chunk]) : chunk;
    let at;
    while ((at = buf.indexOf(0x0a)) >= 0) {
      this.onLine(buf.subarray(0, at));
      buf = buf.subarray(at + 1);
    }
    this.partial = Buffer.from(buf);
  }

  onLine(line) {
    if (this.block && !startsWith(line, '%end ') && !startsWith(line, '%error ')) {
      this.block.lines.push(line.toString('utf8'));
      return;
    }
    if (startsWith(line, '%output ')) {
      const sp = line.indexOf(0x20, 8);
      if (sp < 0) return;
      this.emit('output', line.subarray(8, sp).toString(), decodeOutput(line, sp + 1));
      return;
    }
    if (startsWith(line, '%begin ')) {
      const flags = Number(line.toString().split(' ')[3]);
      const owner = flags & 1 ? this.pending[0] : null;
      this.block = { lines: [], owner };
      if (owner && owner.onBegin && owner.done === 0) owner.onBegin();
      return;
    }
    if (startsWith(line, '%end ') || startsWith(line, '%error ')) {
      const block = this.block;
      this.block = null;
      if (!block) return;
      if (!block.owner) {
        if (!this.ready) {
          this.ready = true;
          this.emit('ready');
        }
        return;
      }
      const cmd = block.owner;
      const failed = startsWith(line, '%error ');
      cmd.results.push(block.lines);
      if (failed) cmd.error = cmd.error || new Error(block.lines.join('\n') || 'tmux command failed');
      if (++cmd.done === cmd.blocks) {
        this.pending.shift();
        if (cmd.error) cmd.reject(cmd.error);
        else cmd.resolve(cmd.results);
      }
      return;
    }
    if (startsWith(line, '%exit')) {
      this.finish();
      return;
    }
    const text = line.toString();
    const sp = text.indexOf(' ');
    this.emit('notification', sp < 0 ? text : text.slice(0, sp), sp < 0 ? '' : text.slice(sp + 1));
  }

  command(line, { blocks = 1, onBegin } = {}) {
    if (this.closed) return Promise.reject(new Error('control client closed'));
    if (/[\r\n]/.test(line)) return Promise.reject(new Error('command must be one line'));
    return new Promise((resolve, reject) => {
      this.pending.push({ blocks, onBegin, resolve, reject, results: [], done: 0, error: null });
      this.proc.stdin.write(`${line}\n`);
    });
  }

  async snapshot({ onBegin } = {}) {
    const target = paneTarget(this.name);
    const [info, capture] = await this.command(`display -p -t ${target} '${SNAPSHOT_FORMAT}' ; capture-pane -p -e -t ${target}`, { blocks: 2, onBegin });
    const [paneId, x, y, visible, alt, cols, rows] = (info[0] || '').split(',');
    return { paneId, cols: Number(cols), rows: Number(rows), cursor: { x: Number(x), y: Number(y), visible: visible === '1' }, alt: alt === '1', lines: capture };
  }

  setSize(cols, rows) {
    return this.command(`refresh-client -C ${Math.floor(cols)}x${Math.floor(rows)}`);
  }

  close() {
    if (this.closed) return;
    try {
      this.proc.stdin.end();
    } catch {}
    const proc = this.proc;
    const timer = setTimeout(() => proc && proc.kill(), 1000);
    timer.unref();
    this.finish();
  }

  finish(err) {
    if (this.closed) return;
    this.closed = true;
    for (const cmd of this.pending.splice(0)) cmd.reject(err || new Error('control client closed'));
    this.emit('exit', err);
  }
}

function startsWith(buf, prefix) {
  if (buf.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (buf[i] !== prefix.charCodeAt(i)) return false;
  return true;
}

function snapshot(client, opts) {
  return client.snapshot(opts);
}

function replayBytes(snap) {
  const parts = [snap.alt ? '\x1b[?1049h' : '\x1b[?1049l', '\x1b[H\x1b[2J', snap.lines.slice(0, snap.rows).join('\r\n'), '\x1b[0m', `\x1b[${snap.cursor.y + 1};${snap.cursor.x + 1}H`, snap.cursor.visible ? '\x1b[?25h' : '\x1b[?25l'];
  return Buffer.from(parts.join(''), 'utf8');
}

module.exports = { NAME_RE, KEYS, ENTER_DELAY_MS, ControlClient, listSessions, newSession, hasSession, paste, sendKey, snapshot, replayBytes, stripControls, decodeOutput, paneTarget, run };
