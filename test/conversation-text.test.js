'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-conv-text-'));
process.env.HOME = home;
delete process.env.CLAUDE_CONFIG_DIR;
const { conversationText, deepSnippet } = require('../sessions');

const line = (o) => `${JSON.stringify(o)}\n`;
const user = (text) => line({ type: 'user', message: { content: text } });
const assistant = (text) => line({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

test('appended lines are indexed and an unfinished last line waits for its newline', async () => {
  const file = path.join(home, 'append.jsonl');
  fs.writeFileSync(file, user('first Grüße') + assistant('answer one'));
  assert.match(await conversationText(file), /first gruesse\nanswer one/);
  fs.appendFileSync(file, `${user('second prompt')}{"type":"assistant","message":{"content":"half`);
  const second = await conversationText(file);
  assert.match(second, /answer one\nsecond prompt$/);
  fs.appendFileSync(file, ' done"}}\n');
  assert.match(await conversationText(file), /second prompt\nhalf done$/);
});

test('a rewritten shorter file is indexed from the start again', async () => {
  const file = path.join(home, 'rewrite.jsonl');
  fs.writeFileSync(file, user('old content that is long enough to be cut') + assistant('old answer'));
  await conversationText(file);
  fs.writeFileSync(file, user('fresh'));
  assert.equal(await conversationText(file), 'fresh');
});

test('a giant tool line is skipped without losing the messages around it', async () => {
  const file = path.join(home, 'giant.jsonl');
  const giant = line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(3 * 1024 * 1024) }] } });
  fs.writeFileSync(file, user('before giant') + giant + assistant('after giant'));
  const text = await conversationText(file);
  assert.equal(text, 'before giant\nafter giant');
  assert.match(await deepSnippet(file, 'after'), /after giant/);
});

test('the indexed text stays capped and keeps the newest part', async () => {
  const file = path.join(home, 'cap.jsonl');
  let body = '';
  for (let i = 0; i < 40; i++) body += assistant(`block ${i} ${'y'.repeat(40000)}`);
  fs.writeFileSync(file, body + assistant('newest marker'));
  const text = await conversationText(file);
  assert.ok(text.length <= 1024 * 1024);
  assert.match(text, /newest marker$/);
  assert.doesNotMatch(text, /block 0 /);
});

test('a growing session is read from where the last scan stopped, not from the start', async () => {
  const file = path.join(home, 'growing.jsonl');
  fs.writeFileSync(file, assistant('z'.repeat(2000)).repeat(3000));
  await conversationText(file);
  fs.appendFileSync(file, user('one more prompt'));
  let bytes = 0;
  const { open, readFile } = fs.promises;
  fs.promises.readFile = async (...args) => {
    const data = await readFile(...args);
    bytes += data.length;
    return data;
  };
  fs.promises.open = async (...args) => {
    const handle = await open(...args);
    const read = handle.read.bind(handle);
    handle.read = async (...rest) => {
      const result = await read(...rest);
      bytes += result.bytesRead;
      return result;
    };
    return handle;
  };
  try {
    assert.match(await conversationText(file), /one more prompt$/);
  } finally {
    fs.promises.open = open;
    fs.promises.readFile = readFile;
  }
  assert.ok(bytes < 64 * 1024, `read ${bytes} bytes for a 30-byte append`);
});
