'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tempHome } = require('./fixtures/fs-helpers');

const home = tempHome('remote-catalog-');
process.env.HOME = home;
delete process.env.CLAUDE_CONFIG_DIR;
const { Catalog, displayTitle, repoName } = require('../catalog');

const root = path.join(home, 'work');
const repo = path.join(root, 'shop-site');
const sub = path.join(repo, 'packages', 'api');
const outside = path.join(home, 'elsewhere');
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
fs.mkdirSync(sub, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
const enc = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const now = Date.now();
const iso = (min) => new Date(now - min * 60000).toISOString();

function session(id, cwd, entries, minutesAgo) {
  const dir = path.join(home, '.claude', 'projects', enc(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const lines = entries.map((e, i) => JSON.stringify({ cwd, timestamp: iso(minutesAgo + entries.length - i), ...e }));
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${lines.join('\n')}\n`);
}
const user = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const said = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';
const D = 'dddddddd-0000-4000-8000-000000000004';
const E = 'eeeeeeee-0000-4000-8000-000000000005';
session(A, repo, [user('Fix the checkout button'), said('Done with the checkout'), { type: 'custom-title', customTitle: 'Checkout fix' }], 30);
session(B, sub, [user('Add an invoice endpoint for Müller'), said('The endpoint for mueller customers is ready'), { type: 'ai-title', aiTitle: 'Invoice endpoint' }], 10);
session(C, repo, [user('Refactor the checkout tests and the checkout docs, checkout everywhere'), said('ok')], 5);
session(D, repo, [said('only an answer')], 60);
session(E, outside, [user('Checkout of a foreign project')], 1);

test('titles: custom title, then AI title, then the shortened first prompt, then the automatic name', () => {
  assert.strictEqual(displayTitle({ customTitle: 'Mine', aiTitle: 'AI', firstPrompt: 'p' }, 'auto-1'), 'Mine');
  assert.strictEqual(displayTitle({ aiTitle: 'AI', firstPrompt: 'p' }, 'auto-1'), 'AI');
  assert.strictEqual(displayTitle({ firstPrompt: `${'word '.repeat(40)}end` }, 'auto-1').length, 80);
  assert.strictEqual(displayTitle({}, 'project-2b'), 'project-2b');
  assert.strictEqual(displayTitle(null, null), null);
});

test('project is the repository folder that holds the working directory', () => {
  assert.strictEqual(repoName(sub, [root]), 'shop-site');
  assert.strictEqual(repoName(outside, [root]), 'elsewhere');
  assert.strictEqual(repoName(null, [root]), null);
});

test('search covers names and conversation text of every session under the roots, umlauts and case ignored', async () => {
  const catalog = new Catalog({ roots: [root] });
  const running = new Map([[A, { managed: true, name: 'cc-checkout-fix' }], [B, { managed: false, pid: 4242 }]]);
  const hits = await catalog.search('CHECKOUT', { running });
  assert.deepStrictEqual(hits.map((h) => h.sessionId), [A, C], 'name hit first, then frequency; nothing outside the roots');
  assert.deepStrictEqual(hits[0], { sessionId: A, title: 'Checkout fix', cwd: repo, project: 'shop-site', running: 'service', name: 'cc-checkout-fix', pid: null, lastActivity: hits[0].lastActivity, snippet: hits[0].snippet });
  assert.match(hits[0].snippet, /checkout/i);
  assert.strictEqual(hits[1].running, null);
  assert.strictEqual(hits[1].title, 'Refactor the checkout tests and the checkout docs, checkout everywhere');

  const muller = await catalog.search('müller ENDPOINT', { running });
  assert.deepStrictEqual(muller.map((h) => h.sessionId), [B]);
  assert.strictEqual(muller[0].running, 'terminal');
  assert.strictEqual(muller[0].pid, 4242);
  assert.strictEqual(muller[0].project, 'shop-site');
  assert.deepStrictEqual((await catalog.search('checkout nothing-like-this')).length, 0, 'every word must occur');

  const recent = await catalog.search('', { limit: 2 });
  assert.deepStrictEqual(recent.map((h) => h.sessionId), [C, B], 'an empty query lists the newest sessions');
});

test('warming fills the text cache for every listed session', async () => {
  const catalog = new Catalog({ roots: [root] });
  const n = await catalog.warm({ pauseMs: 0 });
  assert.strictEqual(n, 4);
});

test('a session written after an earlier search is found by the next one', async () => {
  const catalog = new Catalog({ roots: [root] });
  assert.strictEqual((await catalog.search('pelican')).length, 0);
  session('ffffffff-0000-4000-8000-000000000006', repo, [user('feed the pelican')], 0);
  assert.strictEqual((await catalog.search('pelican')).length, 1);
});
