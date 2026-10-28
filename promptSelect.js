const crypto = require('crypto');
const fs = require('fs');

const TAIL_BYTES = 200000;

const str = (v) => (typeof v === 'string' ? v : '');

function revisionOf(promptId, sessionId, questions) {
  const canonical = (Array.isArray(questions) ? questions : []).map((q) => [
    str(q && q.question),
    str(q && q.header),
    Boolean(q && q.multiSelect === true),
    (Array.isArray(q && q.options) ? q.options : []).map((o) => [str(o && o.label), str(o && o.description)]),
  ]);
  return crypto.createHash('sha256').update(JSON.stringify([promptId, sessionId, canonical])).digest('hex').slice(0, 16);
}

function optionKeystroke(index) {
  if (!Number.isInteger(index) || index < 0 || index > 8) throw new Error('option index outside 0..8');
  return String(index + 1);
}

function startsPrompt(row) {
  const c = row.message && row.message.content;
  return row.type === 'user' && (typeof c === 'string' || (Array.isArray(c) && c.some((p) => p && p.type === 'text')));
}

function lastOpenToolUse(lines) {
  const open = new Map();
  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== 'object') continue;
    if (startsPrompt(row)) open.clear();
    const c = row.message && row.message.content;
    if (!Array.isArray(c)) continue;
    for (const part of c) {
      if (part && part.type === 'tool_use' && part.id) open.set(part.id, part);
      else if (part && part.type === 'tool_result' && part.tool_use_id) open.delete(part.tool_use_id);
    }
  }
  return [...open.values()].pop() || null;
}

function tailLines(file, bytes = TAIL_BYTES) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const length = Math.min(size, bytes);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    return buf.toString('utf8').split('\n').slice(size > length ? 1 : 0).filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

function revalidate(cmd, lines) {
  const use = lastOpenToolUse(lines);
  if (!use) throw new Error('no pending question in the transcript');
  if (use.name !== 'AskUserQuestion') throw new Error('unsupported: no screen snapshot for this terminal');
  if (use.id !== cmd.promptId) throw new Error('stale: the pending prompt changed');
  const questions = Array.isArray(use.input && use.input.questions) ? use.input.questions : [];
  const q = questions[0];
  if (questions.length !== 1 || !q || q.multiSelect === true) throw new Error('not a single single-choice question');
  const labels = (Array.isArray(q.options) ? q.options : []).map((o) => (o && typeof o.label === 'string' ? o.label : ''));
  if (revisionOf(use.id, cmd.sessionId, questions) !== cmd.revision) {
    throw new Error('stale: the prompt revision changed');
  }
  if (labels[cmd.index] !== cmd.label) throw new Error('stale: the option at this index changed');
}

module.exports = { revisionOf, optionKeystroke, revalidate, tailLines };
