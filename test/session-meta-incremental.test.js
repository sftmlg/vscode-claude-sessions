'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-meta-inc-'));
process.env.HOME = home;
delete process.env.CLAUDE_CONFIG_DIR;
const { sessionMeta } = require('../sessions');

const line = (o) => `${JSON.stringify(o)}\n`;
const filler = (n) => line({ type: 'system', note: 'x'.repeat(n) });

test('appended bytes yield the same meta as a fresh full read', async () => {
  const a = path.join(home, 'a.jsonl');
  const b = path.join(home, 'b.jsonl');
  let content = line({ type: 'user', cwd: '/w', timestamp: '2026-01-01T00:00:00Z', message: { content: 'first prompt' } });
  for (let i = 0; i < 20; i++) content += filler(60000);
  content += line({ type: 'assistant', timestamp: '2026-01-01T00:01:00Z', message: { content: 'answer one' } });
  fs.writeFileSync(a, content);
  const first = await sessionMeta(a);
  assert.equal(first.lastAssistant.text, 'answer one');
  assert.equal(first.aiTitle, null);

  const more = line({ type: 'user', timestamp: '2026-01-01T00:02:00Z', message: { content: 'second ü prompt' } }) + line({ type: 'ai-title', aiTitle: 'Late title' }) + '{"type":"assistant","partial';
  fs.appendFileSync(a, more);
  const second = await sessionMeta(a);
  assert.equal(second.lastUser.text, 'second ü prompt');
  assert.equal(second.lastAssistant.text, 'answer one');
  assert.equal(second.aiTitle, 'Late title');
  assert.equal(second.firstPrompt, 'first prompt');

  fs.appendFileSync(a, 'ial"}\n');
  fs.copyFileSync(a, b);
  const third = await sessionMeta(a);
  const fresh = await sessionMeta(b);
  for (const k of ['customTitle', 'aiTitle', 'cwd', 'startedAt', 'lastActivity', 'firstPrompt', 'lastUser', 'lastAssistant']) assert.deepEqual(third[k], fresh[k], k);
});

test('title far outside head and tail is found by the streaming scan', async () => {
  const f = path.join(home, 'c.jsonl');
  let content = line({ type: 'user', cwd: '/w', timestamp: '2026-01-01T00:00:00Z', message: { content: 'p' } });
  content += line({ type: 'custom-title', customTitle: 'Buried' });
  for (let i = 0; i < 40; i++) content += filler(60000);
  fs.writeFileSync(f, content);
  assert.equal((await sessionMeta(f)).customTitle, 'Buried');
});
