'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const EventEmitter = require('events');

const MAX_LINE = 2 * 1024 * 1024;
const MAX_READ = 512 * 1024;
const FIRST_WINDOW = 64 * 1024;
const TEXT_LIMIT = 20000;
const INPUT_LIMIT = 4000;
const DEFAULT_LIMIT = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_RE = /^agent-[0-9a-zA-Z_-]{1,64}$/;
const NL = 0x0a;

const META_TYPES = {
  'ai-title': (o) => ['aiTitle', o.aiTitle],
  'custom-title': (o) => ['customTitle', o.customTitle],
  'agent-name': (o) => ['agentName', o.agentName],
  'pr-link': (o) => ['prLink', { number: o.prNumber, url: o.prUrl, repository: o.prRepository }],
  'cost-state': (o) => ['cost', { totalCostUSD: o.totalCostUSD, totalDuration: o.totalDuration, linesAdded: o.totalLinesAdded, linesRemoved: o.totalLinesRemoved }],
  mode: (o) => ['mode', o.mode],
  'permission-mode': (o) => ['permissionMode', o.permissionMode],
  'continued-in': (o) => ['continuedIn', o.continuedInSessionId],
  summary: (o) => ['summary', o.summary],
};
const DROPPED_TYPES = new Set(['attachment', 'last-prompt', 'atis-latch', 'file-history-snapshot', 'file-history-delta', 'bridge-session', 'history-suppression']);

const clip = (text, limit = TEXT_LIMIT) => {
  const s = typeof text === 'string' ? text : text == null ? '' : typeof text === 'object' ? safeJson(text) : String(text);
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
};

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function sniff(line, key) {
  const m = new RegExp(`"${key}":"([^"]{0,80})"`).exec(line);
  return m ? m[1] : null;
}

function rawEvent(line, size, truncated) {
  const head = line.length > 4096 ? line.subarray(0, 4096) : line;
  const text = head.toString('utf8');
  return { kind: 'raw', uuid: sniff(text, 'uuid'), ts: sniff(text, 'timestamp'), type: sniff(text, 'type'), subtype: sniff(text, 'subtype'), size, truncated };
}

function contentText(content, images) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') {
      if (images) images.count++;
      parts.push('[image]');
    } else if (block.type === 'document') parts.push('[document]');
    else if (typeof block.content === 'string') parts.push(block.content);
  }
  return parts.join('\n');
}

function tag(text, name) {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return m ? m[1].trim() : '';
}

function base(o) {
  return { uuid: o.uuid || null, ts: o.timestamp || null };
}

function userEvents(o) {
  if (o.isMeta) return [];
  const content = o.message && o.message.content;
  const events = [];
  if (Array.isArray(content) && content.some((b) => b && b.type === 'tool_result')) {
    for (const b of content) {
      if (!b || b.type !== 'tool_result') continue;
      events.push({ kind: 'toolResult', ...base(o), toolUseId: b.tool_use_id || null, isError: !!b.is_error, denied: !!o.toolDenialKind, denialKind: o.toolDenialKind || null, text: clip(contentText(b.content)) });
    }
    return events;
  }
  const images = { count: 0 };
  const text = contentText(content, images);
  if (o.isCompactSummary) return [{ kind: 'compactSummary', ...base(o), text: clip(text) }];
  if (typeof content === 'string' && content.includes('<command-name>')) {
    return [{ kind: 'command', ...base(o), name: tag(content, 'command-name'), args: tag(content, 'command-args'), message: tag(content, 'command-message') }];
  }
  if (typeof content === 'string' && content.includes('<local-command-stdout>')) {
    return [{ kind: 'commandOutput', ...base(o), text: clip(tag(content, 'local-command-stdout')) }];
  }
  if (/^\s*\[Request interrupted/.test(text)) return [{ kind: 'interrupted', ...base(o), text: clip(text) }];
  const origin = o.turnOrigin && o.turnOrigin !== 'human' ? o.turnOrigin : o.promptSource === 'system' ? 'system' : null;
  if (origin || /^\s*<(task-notification|system-reminder)/.test(text)) {
    return [{ kind: 'injected', ...base(o), origin: origin || 'system', text: clip(text) }];
  }
  if (!text && !images.count) return [];
  return [{ kind: 'prompt', ...base(o), text: clip(text), images: images.count, source: o.promptSource || null }];
}

function toolInput(input) {
  const json = safeJson(input == null ? {} : input);
  if (json.length <= INPUT_LIMIT) return input == null ? {} : input;
  return { truncated: true, text: json.slice(0, INPUT_LIMIT) };
}

function assistantEvents(o, prev) {
  const msg = o.message || {};
  const events = [];
  if (o.isApiErrorMessage) {
    events.push({ kind: 'notice', ...base(o), subtype: 'api_error', level: 'error', text: clip(typeof o.error === 'string' ? o.error : contentText(msg.content) || safeJson(o.error)) });
    return { events, merged: false };
  }
  const blocks = [];
  const questions = [];
  for (const b of Array.isArray(msg.content) ? msg.content : []) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text') blocks.push({ type: 'text', text: clip(b.text) });
    else if (b.type === 'thinking' || b.type === 'redacted_thinking') blocks.push({ type: 'thinking' });
    else if (b.type === 'tool_use') {
      if (b.name === 'AskUserQuestion') questions.push({ kind: 'question', ...base(o), toolUseId: b.id || null, questions: Array.isArray(b.input && b.input.questions) ? b.input.questions.slice(0, 20) : [] });
      else blocks.push({ type: 'toolUse', id: b.id || null, name: String(b.name || '?'), input: toolInput(b.input) });
    } else if (b.type === 'fallback') blocks.push({ type: 'fallback', from: b.from && b.from.model, to: b.to && b.to.model });
    else blocks.push({ type: 'other', blockType: String(b.type || '?') });
  }
  const messageId = msg.id || null;
  let merged = false;
  if (prev && prev.kind === 'assistant' && messageId && prev.messageId === messageId) {
    prev.blocks.push(...blocks);
    if (msg.stop_reason) prev.stopReason = msg.stop_reason;
    merged = true;
  } else if (blocks.length || !questions.length) {
    events.push({ kind: 'assistant', ...base(o), messageId, model: msg.model || null, stopReason: msg.stop_reason || null, blocks });
  }
  events.push(...questions);
  return { events, merged };
}

function systemEvent(o) {
  const b = base(o);
  switch (o.subtype) {
    case 'turn_duration':
      return { kind: 'turnEnd', ...b, durationMs: Number(o.durationMs) || 0 };
    case 'compact_boundary': {
      const m = o.compactMetadata || {};
      return { kind: 'compact', ...b, trigger: m.trigger || null, preTokens: m.preTokens || null, postTokens: m.postTokens || null };
    }
    case 'stop_hook_summary': {
      const errors = Array.isArray(o.hookErrors) ? o.hookErrors : [];
      if (!errors.length && !o.preventedContinuation) return null;
      return { kind: 'notice', ...b, subtype: 'hooks', level: o.level || 'warning', text: clip([o.preventedContinuation ? `stopped: ${o.stopReason || ''}`.trim() : '', ...errors.map((e) => (typeof e === 'string' ? e : safeJson(e)))].filter(Boolean).join('\n')) };
    }
    default: {
      const text = typeof o.content === 'string' ? o.content : typeof o.error === 'string' ? o.error : typeof o.prompt === 'string' ? o.prompt : safeJson(o.content || o.error || '');
      return { kind: 'notice', ...b, subtype: String(o.subtype || '?'), level: o.level || 'info', text: clip(text) };
    }
  }
}

function lineEvents(o, prev) {
  switch (o.type) {
    case 'user':
      return { events: userEvents(o) };
    case 'assistant':
      return assistantEvents(o, prev);
    case 'system': {
      const e = systemEvent(o);
      return { events: e ? [e] : [] };
    }
    case 'queue-operation':
      return { events: [{ kind: 'queued', uuid: null, ts: o.timestamp || null, op: String(o.operation || '?'), text: clip(typeof o.content === 'string' ? o.content : ''), reason: o.reason || null }] };
    default:
      if (META_TYPES[o.type]) {
        const [key, value] = META_TYPES[o.type](o);
        return { events: [{ kind: 'meta', uuid: null, ts: o.timestamp || null, key, value: value === undefined ? null : value }] };
      }
      if (DROPPED_TYPES.has(o.type)) return { events: [] };
      return { events: null };
  }
}

function* splitBuffer(buf) {
  let start = 0;
  for (;;) {
    const nl = buf.indexOf(NL, start);
    if (nl < 0) return start;
    yield { line: buf.subarray(start, nl), offset: start };
    start = nl + 1;
  }
}

function parseLines(input, options = {}) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input || ''), 'utf8');
  const baseOffset = options.baseOffset || 0;
  const events = [];
  let unknown = 0;
  let corrupt = 0;
  let truncated = 0;
  let restStart = 0;
  const it = splitBuffer(buf);
  for (;;) {
    const step = it.next();
    if (step.done) {
      restStart = step.value;
      break;
    }
    const { line, offset } = step.value;
    const size = line.length;
    if (size === 0 || (size === 1 && line[0] === 0x0d)) continue;
    const absolute = baseOffset + offset;
    if (size > MAX_LINE) {
      truncated++;
      events.push({ ...rawEvent(line, size, true), offset: absolute });
      continue;
    }
    let o;
    try {
      o = JSON.parse(line.toString('utf8'));
    } catch {
      corrupt++;
      continue;
    }
    if (!o || typeof o !== 'object' || typeof o.type !== 'string') {
      corrupt++;
      continue;
    }
    const prev = events.length ? events[events.length - 1] : null;
    const result = lineEvents(o, prev);
    if (result.events === null) {
      unknown++;
      events.push({ ...rawEvent(line, size, false), offset: absolute });
      continue;
    }
    for (const e of result.events) {
      e.offset = absolute;
      events.push(e);
    }
  }
  return { events, rest: buf.subarray(restStart), unknown, corrupt, truncated };
}

async function readAt(handle, position, length) {
  const buf = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buf, done, length - done, position + done);
    if (!bytesRead) break;
    done += bytesRead;
  }
  return buf.subarray(0, done);
}

async function atLineStart(handle, start) {
  if (start === 0) return true;
  const probe = await readAt(handle, start - 1, 1);
  return probe.length === 1 && probe[0] === NL;
}

function splitWindow(buf, start, aligned) {
  const firstNl = aligned ? -1 : buf.indexOf(NL);
  const lead = aligned ? 0 : firstNl < 0 ? buf.length : firstNl + 1;
  const bodyEnd = Math.max(lead, buf.lastIndexOf(NL) + 1);
  return { start, end: start + buf.length, lead: buf.subarray(0, lead), from: start + lead, bodyEnd: start + bodyEnd, body: buf.subarray(lead, bodyEnd), tail: buf.subarray(bodyEnd) };
}

function fragment(piece, offset, head) {
  const raw = rawEvent(piece, piece.length, true);
  if (!head) Object.assign(raw, { type: null, subtype: null, uuid: null, ts: null });
  return { ...raw, offset };
}

function page(split, size, limit, { trailing, final }) {
  let parsed = parseLines(split.body, { baseOffset: split.from });
  let from = split.from;
  if (parsed.events.length > limit) {
    from = parsed.events[parsed.events.length - limit].offset;
    parsed = parseLines(split.body.subarray(from - split.from), { baseOffset: from });
  }
  const result = { events: parsed.events, from, to: split.bodyEnd, size, unknown: parsed.unknown, corrupt: parsed.corrupt, truncated: parsed.truncated };
  if (split.tail.length && trailing) {
    result.events.push(fragment(split.tail, split.bodyEnd, true));
    result.to = split.end;
    result.truncated++;
  }
  if (final && split.lead.length && split.lead.length === split.end - split.start) {
    result.events.unshift(fragment(split.lead, split.start, false));
    result.from = split.start;
    result.to = split.end;
    result.truncated++;
  }
  return result;
}

async function readEvents(file, options = {}) {
  const limit = Math.max(1, Math.min(2000, Number(options.limit) || DEFAULT_LIMIT));
  const handle = await fsp.open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    if (Number.isFinite(options.from) && options.from >= 0) {
      const start = Math.min(Math.floor(options.from), size);
      const buf = await readAt(handle, start, Math.min(MAX_READ, size - start));
      const split = splitWindow(buf, start, await atLineStart(handle, start));
      const final = buf.length >= MAX_READ;
      return page(split, size, 2000, { trailing: final, final });
    }
    const end = Number.isFinite(options.before) ? Math.max(0, Math.min(Math.floor(options.before), size)) : size;
    let window = FIRST_WINDOW;
    for (;;) {
      const start = Math.max(0, end - window);
      const buf = await readAt(handle, start, end - start);
      const split = splitWindow(buf, start, await atLineStart(handle, start));
      const final = start === 0 || window >= MAX_READ;
      const result = page(split, size, limit, { trailing: end < size, final });
      if (result.events.length >= limit || final) return result;
      window = Math.min(MAX_READ, window * 4);
    }
  } finally {
    await handle.close();
  }
}

class Tail extends EventEmitter {
  constructor(file, options = {}) {
    super();
    this.file = file;
    this.pollMs = Math.max(200, Number(options.pollMs) || 1000);
    this.offset = Number.isFinite(options.from) ? Math.max(0, Math.floor(options.from)) : null;
    this.ino = null;
    this.pending = Buffer.alloc(0);
    this.unknown = 0;
    this.corrupt = 0;
    this.truncated = 0;
    this.reading = null;
    this.again = false;
    this.closed = false;
    this.timer = null;
    this.watcher = null;
  }

  async start() {
    const st = await fsp.stat(this.file);
    if (this.closed) return this;
    this.ino = st.ino;
    if (this.offset === null || this.offset > st.size) this.offset = st.size;
    try {
      this.watcher = fs.watch(this.file, () => this.check());
      this.watcher.on('error', () => this.dropWatcher());
    } catch {
      this.watcher = null;
    }
    this.timer = setInterval(() => this.check(), this.pollMs);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  dropWatcher() {
    if (!this.watcher) return;
    try {
      this.watcher.close();
    } catch {}
    this.watcher = null;
  }

  check() {
    if (this.closed) return Promise.resolve();
    if (this.reading) {
      this.again = true;
      return this.reading;
    }
    this.reading = (async () => {
      do {
        this.again = false;
        try {
          await this.readNew();
        } catch (err) {
          if (err && err.code === 'ENOENT') this.reset(0);
          else this.emit('error', err);
        }
      } while (this.again && !this.closed);
    })().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  reset(size) {
    this.offset = size;
    this.pending = Buffer.alloc(0);
    this.emit('reset', { size });
  }

  async readNew() {
    const st = await fsp.stat(this.file);
    if ((this.ino !== null && st.ino !== this.ino) || st.size < this.offset) {
      this.ino = st.ino;
      this.reset(st.size);
      return;
    }
    this.ino = st.ino;
    if (st.size === this.offset) return;
    const handle = await fsp.open(this.file, 'r');
    try {
      while (this.offset < st.size && !this.closed) {
        const chunk = await readAt(handle, this.offset, Math.min(MAX_READ, st.size - this.offset));
        if (!chunk.length) break;
        const start = this.offset - this.pending.length;
        const buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
        const parsed = parseLines(buf, { baseOffset: start });
        this.offset += chunk.length;
        this.pending = parsed.rest;
        this.unknown += parsed.unknown;
        this.corrupt += parsed.corrupt;
        this.truncated += parsed.truncated;
        if (this.pending.length > MAX_LINE) {
          this.truncated++;
          parsed.events.push({ ...rawEvent(this.pending, this.pending.length, true), offset: this.offset - this.pending.length });
          this.pending = Buffer.alloc(0);
        }
        if (parsed.events.length) this.emit('events', { events: parsed.events, from: start, to: this.offset - this.pending.length, size: st.size, unknown: parsed.unknown });
      }
    } finally {
      await handle.close();
    }
  }

  close() {
    this.closed = true;
    this.dropWatcher();
    clearInterval(this.timer);
    this.removeAllListeners();
  }
}

function sessionDir(sessionJsonlPath) {
  return path.join(path.dirname(sessionJsonlPath), path.basename(sessionJsonlPath, '.jsonl'));
}

async function listSubagents(sessionJsonlPath) {
  const dir = path.join(sessionDir(sessionJsonlPath), 'subagents');
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const agents = [];
  for (const name of names) {
    if (!name.endsWith('.meta.json')) continue;
    const agentId = name.slice(0, -'.meta.json'.length);
    if (!AGENT_RE.test(agentId)) continue;
    let meta = {};
    try {
      meta = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8')) || {};
    } catch {
      continue;
    }
    const file = path.join(dir, `${agentId}.jsonl`);
    let st = null;
    try {
      st = await fsp.stat(file);
    } catch {}
    agents.push({ agentId, file: st ? file : null, size: st ? st.size : 0, mtimeMs: st ? st.mtimeMs : 0, agentType: meta.agentType || null, description: meta.description || null, toolUseId: meta.toolUseId || null, parentAgentId: meta.parentAgentId || null, spawnDepth: meta.spawnDepth || 0, model: meta.model || null });
  }
  return agents.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

function claudeDirs() {
  const home = os.homedir();
  const dirs = [];
  let entries = [];
  try {
    entries = fs.readdirSync(home);
  } catch {}
  for (const e of entries) {
    if (e !== '.claude' && !e.startsWith('.claude-')) continue;
    const d = path.join(home, e, 'projects');
    if (fs.existsSync(d)) dirs.push(d);
  }
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env && fs.existsSync(path.join(env, 'projects'))) dirs.push(path.join(env, 'projects'));
  return dirs;
}

async function projectsRoots() {
  const roots = new Set();
  for (const d of claudeDirs()) {
    try {
      roots.add(await fsp.realpath(d));
    } catch {}
  }
  return [...roots];
}

async function safeTranscriptPath(candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || !candidate.endsWith('.jsonl')) return null;
  let real;
  try {
    real = await fsp.realpath(candidate);
  } catch {
    return null;
  }
  if (!real.endsWith('.jsonl')) return null;
  for (const root of await projectsRoots()) {
    if (real.startsWith(`${root}${path.sep}`)) return real;
  }
  return null;
}

async function resolveTranscript(sessionId) {
  if (!UUID_RE.test(String(sessionId || ''))) return null;
  let best = null;
  const seen = new Set();
  for (const projects of claudeDirs()) {
    let dirs = [];
    try {
      dirs = await fsp.readdir(projects);
    } catch {
      continue;
    }
    for (const p of dirs) {
      const file = await safeTranscriptPath(path.join(projects, p, `${sessionId}.jsonl`));
      if (!file || seen.has(file)) continue;
      seen.add(file);
      let st;
      try {
        st = await fsp.stat(file);
      } catch {
        continue;
      }
      if (!best || st.mtimeMs > best.mtimeMs) best = { file, mtimeMs: st.mtimeMs, size: st.size };
    }
  }
  return best ? best.file : null;
}

async function resolveSubagent(sessionId, agentId) {
  if (!AGENT_RE.test(String(agentId || ''))) return null;
  const main = await resolveTranscript(sessionId);
  if (!main) return null;
  return safeTranscriptPath(path.join(sessionDir(main), 'subagents', `${agentId}.jsonl`));
}

module.exports = { parseLines, readEvents, Tail, listSubagents, resolveTranscript, resolveSubagent, safeTranscriptPath, projectsRoots, MAX_LINE, MAX_READ, TEXT_LIMIT, INPUT_LIMIT, UUID_RE, AGENT_RE };
