const fs = require('fs');

const PREFIX_LEN = 40;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Text goes in as one bracketed paste; Enter follows as its own write so the TUI sees a keypress, not paste content.
async function submitText(term, text, { submitDelayMs = 150, wait = sleep } = {}) {
  term.sendText(`\x1b[200~${text}\x1b[201~`, false);
  await wait(submitDelayMs);
  term.sendText('\r', false);
}

function sizesOf(files) {
  const sizes = new Map();
  for (const f of files) {
    try {
      sizes.set(f, fs.statSync(f).size);
    } catch {
      sizes.set(f, 0);
    }
  }
  return sizes;
}

function entryText(line) {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return '';
  }
  if (!e || typeof e !== 'object') return '';
  const queued = e.type === 'attachment' && e.attachment && e.attachment.type === 'queued_command';
  if (e.type !== 'user' && e.type !== 'queue-operation' && !queued) return '';
  return JSON.stringify(e);
}

async function watchDelivery(files, text, { timeoutMs = 10000, intervalMs = 200, sizes = sizesOf(files) } = {}) {
  const needle = JSON.stringify(text.trim().slice(0, PREFIX_LEN)).slice(1, -1);
  const end = Date.now() + timeoutMs;
  for (;;) {
    for (const f of files) {
      let size;
      try {
        size = fs.statSync(f).size;
      } catch {
        continue;
      }
      const from = sizes.get(f) || 0;
      if (size <= from) continue;
      const fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(size - from);
      try {
        fs.readSync(fd, buf, 0, buf.length, from);
      } finally {
        fs.closeSync(fd);
      }
      const whole = buf.toString('utf8');
      const complete = whole.slice(0, whole.lastIndexOf('\n') + 1);
      sizes.set(f, from + Buffer.byteLength(complete));
      for (const line of complete.split('\n')) if (line && entryText(line).includes(needle)) return true;
    }
    if (Date.now() >= end) return false;
    await sleep(intervalMs);
  }
}

function startDeliveryWatch(files, text, opts = {}) {
  return watchDelivery(files, text, { ...opts, sizes: sizesOf(files) });
}

module.exports = { submitText, startDeliveryWatch };
