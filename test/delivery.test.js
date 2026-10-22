const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { submitText, startDeliveryWatch } = require('../delivery');

test('submitText writes the paste, waits, then a lone CR as a separate write', async () => {
  const events = [];
  const term = { sendText: (t, nl) => events.push(['send', t, nl]) };
  await submitText(term, 'a\nb', { submitDelayMs: 150, wait: async (ms) => events.push(['wait', ms]) });
  assert.deepStrictEqual(events, [['send', '\x1b[200~a\nb\x1b[201~', false], ['wait', 150], ['send', '\r', false]]);
});

function tmpFile(content = '') {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-')), 's.jsonl');
  fs.writeFileSync(f, content);
  return f;
}

test('delivery watch sees a user entry, a queue-operation and a queued_command appended after the start', async () => {
  const text = 'please "quote" this and keep going for a while longer';
  for (const entry of [
    { type: 'user', message: { role: 'user', content: text } },
    { type: 'queue-operation', operation: 'enqueue', content: text },
    { type: 'attachment', attachment: { type: 'queued_command', prompt: text } },
  ]) {
    const f = tmpFile(JSON.stringify({ type: 'user', message: { content: text } }) + '\n');
    const watch = startDeliveryWatch([f], text, { timeoutMs: 2000, intervalMs: 20 });
    setTimeout(() => fs.appendFileSync(f, JSON.stringify(entry) + '\n'), 60);
    assert.strictEqual(await watch, true, entry.type);
  }
});

test('delivery watch ignores old lines, other entry types and unrelated text, and times out false', async () => {
  const text = 'hello world';
  const f = tmpFile(JSON.stringify({ type: 'user', message: { content: text } }) + '\n');
  const watch = startDeliveryWatch([f], text, { timeoutMs: 300, intervalMs: 20 });
  fs.appendFileSync(f, JSON.stringify({ type: 'assistant', message: { content: text } }) + '\n' + JSON.stringify({ type: 'user', message: { content: 'other' } }) + '\n');
  assert.strictEqual(await watch, false);
});

test('delivery watch waits for a complete line', async () => {
  const f = tmpFile();
  const line = JSON.stringify({ type: 'user', message: { content: 'partial line text' } });
  const watch = startDeliveryWatch([f], 'partial line text', { timeoutMs: 2000, intervalMs: 20 });
  fs.appendFileSync(f, line.slice(0, 15));
  setTimeout(() => fs.appendFileSync(f, line.slice(15) + '\n'), 100);
  assert.strictEqual(await watch, true);
});
