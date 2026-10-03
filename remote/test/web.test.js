'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'web');
const read = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');
const APP_JS = ['app.js', 'term.js', 'input.js'];

test('vendored files match the pinned versions and SHA-256 hashes', () => {
  const lines = read('vendor/VERSIONS').trim().split('\n');
  const listed = new Set();
  for (const line of lines) {
    const m = /^(\S+) (@xterm\/(?:xterm@6\.0\.0|addon-fit@0\.11\.0)) sha256:([0-9a-f]{64})$/.exec(line);
    assert.ok(m, `manifest line: ${line}`);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(WEB, 'vendor', m[1]))).digest('hex');
    assert.strictEqual(actual, m[3], `${m[1]} hash`);
    listed.add(m[1]);
  }
  for (const f of fs.readdirSync(path.join(WEB, 'vendor'))) if (f !== 'VERSIONS') assert.ok(listed.has(f), `${f} listed in VERSIONS`);
  for (const f of ['xterm.mjs', 'xterm.css', 'addon-fit.mjs']) assert.ok(listed.has(f), f);
});

test('the shell has no inline script or style and loads nothing from other origins', () => {
  const html = read('index.html');
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    assert.match(m[1], /\bsrc="[^":]+"/, 'script tags load local files only');
    assert.strictEqual(m[2].trim(), '', 'no inline script');
  }
  assert.ok(!/<style\b/i.test(html), 'no style element');
  assert.ok(!/\sstyle=/i.test(html), 'no style attribute');
  assert.ok(!/\son[a-z]+=/i.test(html), 'no inline handlers');
  assert.ok(!/(src|href)="(https?:)?\/\//i.test(html), 'no remote resources');
  assert.match(html, /name="viewport" content="[^"]*interactive-widget=resizes-content/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /rel="manifest" href="manifest.webmanifest"/);
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.strictEqual(manifest.display, 'standalone');
});

test('app code renders text only; only notify.js touches the service worker, behind a secure-context check', () => {
  assert.ok(!/serviceWorker/.test(read('app.js')), 'app.js leaves the service worker to notify.js');
  const notify = read('notify.js');
  assert.match(notify, /w\.isSecureContext && w\.navigator && 'serviceWorker' in w\.navigator/);
  assert.match(notify, /if \(!pushSupported\(\)\) throw new Error\(PUSH_UNAVAILABLE\)/);
  assert.match(notify, /register\('sw\.js'\)/);
  for (const f of APP_JS) {
    const src = read(f);
    for (const bad of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function\(/, /https?:\/\/(?!.*\$\{)/]) assert.ok(!bad.test(src), `${f} must not match ${bad}`);
  }
  const term = read('term.js');
  assert.match(term, /registerOscHandler\(52, \(\) => true\)/, 'OSC 52 swallowed');
  assert.match(term, /url\.protocol !== 'http:' && url\.protocol !== 'https:'/, 'links limited to http(s)');
  assert.match(term, /noopener/);
});

test('phone fit, background release, subagent requests and forced takeover are wired', () => {
  const app = read('app.js');
  assert.match(app, /isTouch\(\) \|\| window\.innerWidth < 700/, 'auto-fit on touch or narrow screens');
  assert.match(app, /visibilityState === 'hidden'\) return releaseClaim\(true\)/, 'claim released in background');
  assert.match(app, /t: 'agentEvents', sessionId: id, toolUseId/, 'subagent events requested over the socket');
  assert.match(app, /ack\.error === 'still-running' && !force/, 'SIGKILL only offered after an ignored SIGTERM');
  assert.match(app, /\.\.\.\(force \? \{ force: true \} : \{\}\)/, 'force flag only on the second confirmation');
});

test('outbox sender: one message in flight, next only after its ack, a rate-limited retry stays first', async () => {
  const { Outbox, OutboxSender } = await import(path.join(WEB, 'input.js'));
  const data = new Map();
  const box = new Outbox({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) });
  const sent = [];
  const timers = [];
  let ready = true;
  const sender = new OutboxSender({ outbox: box, send: (m) => (sent.push(m.text), true), isReady: () => ready, retryMs: 1000, setTimer: (fn) => timers.push(fn) });
  const a = box.add('cc-a', 'one');
  const b = box.add('cc-a', 'two');
  sender.pump();
  sender.pump();
  assert.deepStrictEqual(sent, ['one']);
  assert.deepStrictEqual(sender.onAck({ id: a.id, ok: false, error: 'rate-limited' }), { handled: true });
  box.add('cc-a', 'three');
  sender.pump();
  assert.deepStrictEqual(sent, ['one'], 'nothing overtakes the rate-limited head');
  timers.shift()();
  assert.deepStrictEqual(sent, ['one', 'one']);
  sender.onAck({ id: a.id, ok: true });
  assert.deepStrictEqual(sent, ['one', 'one', 'two']);
  const r = sender.onAck({ id: b.id, ok: false, error: 'busy-dialog' });
  assert.strictEqual(r.item.text, 'two');
  assert.strictEqual(r.error, 'busy-dialog');
  assert.deepStrictEqual(sent, ['one', 'one', 'two', 'three']);
  ready = false;
  sender.reset();
  sender.pump();
  assert.strictEqual(sent.length, 4, 'offline: nothing sent');
  ready = true;
  sender.reset();
  sender.pump();
  assert.deepStrictEqual(sent.slice(4), ['three'], 'reconnect resends the unacked head once');
  assert.deepStrictEqual(sender.onAck({ id: 'unknown', ok: true }), { handled: false });
});

test('chat and mirror recover after reconnects and recreated sessions', () => {
  const app = read('app.js');
  assert.match(app, /state\.chatMounting\) return;\s*state\.chatMounting = true;/, 'mounting flag set synchronously');
  assert.match(app, /t: 'subEvents', sessionId, from: m\.to/, 'live tail starts where the first page ended');
  assert.ok(!/r\.open\(sessionId\);\s*conn\.send\(\{ t: 'subEvents', sessionId \}\)/.test(app), 'no subscription before the first page');
  assert.match(app, /addEventListener\('close'[\s\S]{0,400}unmountChat\(\)/, 'chat torn down on socket close so helloOk remounts it');
  assert.match(app, /m\.code === 'session-ended' && m\.sessionId === state\.current[\s\S]{0,120}state\.subscribedKey = null/, 'ended session resubscribes when recreated');
});

test('a slow or failing editor bridge never blocks the hello', () => {
  const app = read('app.js');
  assert.match(app, /async function getToken\(c\) \{\s*try \{[\s\S]{0,300}\} catch \{\s*return null;/, 'bridge failures fall back to hello without a token');
  assert.match(read('vscode-bridge.js'), /\}, 15000\);/, 'bridge waits 15 s for the editor');
  assert.match(app, /if \(conn\.sentToken\) setToken\(conn, null\)/, 'a hello without token never deletes the stored token');
});

test('a blocked folder access shows a persistent banner naming the node path', () => {
  const app = read('app.js');
  assert.match(read('index.html'), /id="health-banner"[^>]*role="alert"[^>]*hidden/);
  assert.match(app, /case 'health':\s*conn\.health = m;\s*return renderHealth\(m\);/);
  assert.match(app, /renderHealth\(m\.health\)/);
  assert.match(app, /Full Disk Access › add \$\{health\.nodePath/);
  assert.match(app, /banner\.textContent = text;/);
});

test('search highlight folds like the plugin search (case, umlauts as ae/oe/ue/ss, accents)', async () => {
  const { highlightParts } = await import(path.join(WEB, 'input.js'));
  assert.deepStrictEqual(highlightParts('Fix für MÜLLER checkout', 'mueller CHECKOUT'), highlightParts('Fix für MÜLLER checkout', 'müller checkout'));
  assert.deepStrictEqual(highlightParts('Fix für MÜLLER checkout', 'mueller CHECKOUT'), [
    { text: 'Fix für ', hit: false },
    { text: 'MÜLLER', hit: true },
    { text: ' ', hit: false },
    { text: 'checkout', hit: true },
  ]);
  assert.deepStrictEqual(highlightParts('nothing here', 'zebra'), [{ text: 'nothing here', hit: false }]);
  assert.deepStrictEqual(highlightParts('', 'x'), []);
});

test('session list: sticky search, readable names, clear labels, resume of past sessions', () => {
  const html = read('index.html');
  const app = read('app.js');
  assert.match(html, /<div class="list-toolbar">[\s\S]*<input id="session-search" type="search"/);
  assert.match(html, /<ul id="search-results" class="session-list" hidden><\/ul>/);
  assert.match(read('style.css'), /\.list-toolbar \{[^}]*position: sticky/);
  assert.match(app, /SEARCH_DEBOUNCE_MS = 250/);
  assert.match(app, /t: 'search', id, query, limit: SEARCH_LIMIT/);
  assert.match(app, /el\('mark', \{ class: 'hit', text: p\.text \}\)/, 'hits rendered as separate text-only elements');
  assert.ok(!/'outside'/.test(app), 'the old label is gone');
  assert.match(app, /text: 'in a terminal · read-only', title: 'Runs in a terminal tab on the Mac\. Take it over to steer it here\.'/);
  assert.match(app, /text: 'remote', title: 'Runs in the service\. Steerable here\.'/);
  assert.match(app, /s\.project \|\| basename\(s\.cwd\)/);
  assert.match(app, /setText\(r\.prompt, s\.lastPrompt \|\| ''\)/);
  assert.match(app, /t: 'new', id: newId\('n'\), resumeId: hit\.sessionId \}/, 'resume sends only the session id; the server names it');
  assert.match(app, /if \(hit\.running === 'terminal'\) return openSession\(hit\.sessionId\);/, 'a session in a terminal opens read-only, take over lives there');
});

test('every key in the key bar is on the server allowlist', () => {
  const { KEYS } = require('../tmux');
  const keys = [...read('index.html').matchAll(/data-key="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(keys, ['Escape', 'Up', 'Down', 'Left', 'Right', 'Tab', 'BTab', 'Enter', 'C-c', '1', '2', '3', 'y', 'n']);
  for (const k of keys) assert.ok(KEYS.has(k), k);
});

test('outbox: capped by items and bytes, persisted, cleared on ack', async () => {
  const { Outbox, OUTBOX_MAX_ITEMS, OUTBOX_MAX_BYTES } = await import(path.join(WEB, 'input.js'));
  const data = new Map();
  const store = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) };
  const box = new Outbox(store);
  const first = box.add('cc-a', 'hello');
  assert.match(first.id, /^m-[0-9a-f]{24}$/);
  assert.strictEqual(new Outbox(store).pending()[0].text, 'hello');
  for (let i = 1; i < OUTBOX_MAX_ITEMS; i++) assert.ok(box.add('cc-a', `m${i}`));
  assert.strictEqual(box.add('cc-a', 'one too many'), null);
  for (const item of box.pending()) box.remove(item.id);
  assert.strictEqual(data.size, 0, 'storage emptied after all acks');
  assert.strictEqual(box.add('cc-a', 'x'.repeat(OUTBOX_MAX_BYTES)), null);
  assert.strictEqual(new Outbox({ getItem: () => '{broken', setItem() {}, removeItem() {} }).pending().length, 0);
});

test('outbox items belong to one host and each host sends only its own, in order', async () => {
  const { Outbox, OutboxSender } = await import(path.join(WEB, 'input.js'));
  const data = new Map();
  const box = new Outbox({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) });
  const a1 = box.add('cc-a', 'to studio 1', 'studio');
  box.add('cc-b', 'to laptop', 'self');
  box.add('cc-a', 'to studio 2', 'studio');
  assert.strictEqual(a1.host, 'studio');
  assert.strictEqual(box.add('cc-x', 'legacy').host, 'self', 'items without a host belong to this Mac');
  const sentStudio = [];
  const sentSelf = [];
  const studio = new OutboxSender({ outbox: box, host: 'studio', send: (m) => (sentStudio.push(m.text), true), isReady: () => true });
  const self = new OutboxSender({ outbox: box, host: 'self', send: (m) => (sentSelf.push(m.text), true), isReady: () => true });
  studio.pump();
  self.pump();
  assert.deepStrictEqual([sentStudio, sentSelf], [['to studio 1'], ['to laptop']]);
  studio.onAck({ id: a1.id, ok: true });
  assert.deepStrictEqual(sentStudio, ['to studio 1', 'to studio 2']);
  assert.deepStrictEqual(self.onAck({ id: a1.id, ok: true }), { handled: false }, 'acks of another host are not this sender\'s');
});

test('one tab per host: own socket, own token per origin, peers from the first hub', () => {
  const app = read('app.js');
  assert.match(read('index.html'), /<nav id="host-tabs" class="host-tabs" role="tablist" aria-label="Macs" hidden><\/nav>/);
  assert.match(app, /`\$\{TOKEN_KEY\}:\$\{c\.origin\}`/, 'tokens stored per hub origin');
  assert.match(app, /host\.getToken\(c\.origin\)/, 'the editor bridge is asked per origin');
  assert.match(app, /if \(conn === hosts\[0\] && Array\.isArray\(m\.peers\)\) setPeers\(m\.peers\)/);
  assert.match(app, /if \(this !== conn\) return onBackground\(this, e\.data\)/, 'inactive hosts only update their list and badges');
  assert.match(app, /outbox\.add\(s\.name, text, conn\.id\)/, 'queued messages go to the host they were typed for');
  assert.match(read('vscode-bridge.js'), /getToken: \(origin\) => request\('getToken', \{ origin/);
});

test('attention inbox: waiting, then finished and unread; everything else, working included, grouped by project', async () => {
  const { inboxSections } = await import(path.join(WEB, 'inbox.js'));
  const t = (min) => new Date(Date.UTC(2026, 0, 1, 12, min)).toISOString();
  const items = [
    { name: 'a', status: 'idle', unread: false, project: 'shop', lastActivity: t(1) },
    { name: 'b', status: 'busy', unread: true, project: 'shop', lastActivity: t(9) },
    { name: 'c', status: 'idle', unread: true, project: 'api', lastActivity: t(2) },
    { name: 'd', status: 'waiting', unread: false, project: 'api', lastActivity: t(0) },
    { name: 'e', status: 'idle', unread: false, project: 'api', lastActivity: t(5) },
    { name: 'f', status: 'none', unread: false, cwd: '/x/docs', lastActivity: t(3) },
    { name: 'g', status: 'idle', unread: true, project: 'shop', lastActivity: t(4) },
  ];
  const { needs, groups } = inboxSections(items);
  assert.deepStrictEqual(needs.map((i) => i.name), ['d', 'g', 'c'], 'working sessions do not need you');
  assert.deepStrictEqual(groups.map((g) => [g.project, g.items.map((i) => i.name)]), [['shop', ['b', 'a']], ['api', ['e']], ['docs', ['f']]]);
  assert.deepStrictEqual(inboxSections([]), { needs: [], groups: [] });
});

test('list renders the inbox with collapsible project groups and unread dots; opening and leaving mark read', () => {
  const app = read('app.js');
  assert.match(app, /inboxSections\(visible\)/);
  assert.match(app, /el\('details', \{ class: 'project-group'/);
  assert.match(app, /text: 'Needs you'/);
  assert.match(app, /class: 'unread-dot', title: 'New since you last looked'/);
  assert.match(app, /function markSeen\(s\)[\s\S]{0,200}t: 'markSeen', sessionId: s\.sessionId/);
  assert.match(app, /function openSession\(key[^)]*\) \{[\s\S]{0,1200}markSeen\(currentItem\(\)\)/);
  assert.match(app, /function closeSession\(\) \{[\s\S]{0,200}markSeen\(s\)/);
});

test('quick replies: numbered option lines become labelled keys, nothing else', async () => {
  const { parseOptions } = await import(path.join(WEB, 'quick-replies.js'));
  const lines = ['', ' Pick a colour for the chart', ' ❯ 1. Blue', '   2. Green', '   3. Something else (esc)', '', ' Esc to cancel'];
  assert.deepStrictEqual(parseOptions(lines), [
    { key: '1', label: 'Blue' },
    { key: '2', label: 'Green' },
    { key: '3', label: 'Something else' },
    { key: 'Escape', label: 'Cancel (Esc)' },
  ]);
  assert.deepStrictEqual(parseOptions(['1. only one line']), [], 'a single numbered line is not a dialog');
  assert.deepStrictEqual(parseOptions(['2. starts at two', '3. then three']), [], 'a list must start at 1');
  assert.deepStrictEqual(parseOptions(['some prose', 'nothing numbered']), []);
  assert.deepStrictEqual(parseOptions(null), []);
  assert.strictEqual(parseOptions([...lines, ...new Array(45).fill('')]).length, 4, 'a prompt near the top of a tall screen is still found');
  for (const o of parseOptions(lines)) assert.match(o.key, /^([1-9]|Escape)$/);
});

test('quick replies render only while waiting and send a key only on tap', () => {
  const app = read('app.js');
  assert.match(read('index.html'), /<div id="quick-replies" class="quick-replies" aria-label="Answers" hidden><\/div>/);
  assert.match(app, /s\.status !== 'waiting'/);
  assert.match(app, /onclick: \(\) => sendKey\(o\.key\)/, 'a tap sends exactly the option key');
  const { KEYS } = require('../tmux');
  for (const k of ['1', '9', 'Escape']) assert.ok(KEYS.has(k));
});

test('dates are relative in the text and absolute only in the tooltip', async () => {
  const { relativeTime } = await import(path.join(WEB, 'inbox.js'));
  const now = new Date(2026, 9, 3, 15, 0).getTime();
  const at = (y, mo, d, h, mi, sec = 0) => new Date(y, mo, d, h, mi, sec).toISOString();
  assert.strictEqual(relativeTime(at(2026, 9, 3, 14, 59, 40), now), 'just now');
  assert.strictEqual(relativeTime(at(2026, 9, 3, 14, 57), now), '3 min ago');
  assert.strictEqual(relativeTime(at(2026, 9, 3, 12, 0), now), '3 h ago');
  assert.strictEqual(relativeTime(at(2026, 9, 2, 23, 0), now), 'yesterday');
  assert.strictEqual(relativeTime(at(2026, 9, 1, 9, 0), now), '2 days ago');
  assert.strictEqual(relativeTime(at(2026, 8, 25, 9, 0), now), 'last week');
  assert.strictEqual(relativeTime(at(2026, 8, 15, 9, 0), now), '2 weeks ago');
  assert.strictEqual(relativeTime(at(2026, 6, 1, 9, 0), now), '3 months ago');
  assert.strictEqual(relativeTime(at(2025, 1, 1, 9, 0), now), 'over a year ago');
  assert.strictEqual(relativeTime(null, now), '');
  assert.ok(!/toLocaleDateString\(\)/.test(read('app.js').replace(/title: [^,]+toLocale\w+\(\)/g, '')), 'no absolute dates in visible text');
});

test('tabs carry machine names; the machine the viewer sits at is marked and first', () => {
  const app = read('app.js');
  assert.ok(!/This Mac/.test(app), 'no guessed "This Mac" label');
  assert.match(app, /`\$\{c\.label\} \(this device\)`/);
  assert.match(app, /\[\.\.\.hosts\.filter\(isViewerHost\), \.\.\.hosts\.filter\(\(h\) => !isViewerHost\(h\)\)\]/);
  assert.match(app, /if \(m\.hostName\) conn\.label = m\.hostName;/);
});

test('drafts: one per host and session, capped at 20 KB, cleared on send', async () => {
  const { DraftStore, DRAFT_MAX_BYTES } = await import(path.join(WEB, 'input.js'));
  const data = new Map();
  const store = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) };
  const drafts = new DraftStore(store);
  drafts.save('self', 'cc-a', 'half typed');
  drafts.save('studio', 'cc-a', 'other mac');
  assert.strictEqual(new DraftStore(store).load('self', 'cc-a'), 'half typed', 'survives reload');
  assert.strictEqual(drafts.load('studio', 'cc-a'), 'other mac');
  drafts.save('self', 'cc-a', '');
  assert.strictEqual(drafts.load('self', 'cc-a'), '');
  assert.strictEqual([...data.keys()].some((k) => k.includes('self') && k.includes('cc-a')), false, 'empty draft removed');
  drafts.save('self', 'cc-b', 'x'.repeat(DRAFT_MAX_BYTES + 10));
  assert.ok(new TextEncoder().encode(drafts.load('self', 'cc-b')).length <= DRAFT_MAX_BYTES);
  drafts.clear('studio', 'cc-a');
  assert.strictEqual(drafts.load('studio', 'cc-a'), '');
});

test('suggestion chip: only a dimmed prompt line counts as a suggestion', async () => {
  const { suggestionFrom } = await import(path.join(WEB, 'quick-replies.js'));
  assert.strictEqual(suggestionFrom({ text: '│ ❯ run the tests again   │', dim: true }), 'run the tests again');
  assert.strictEqual(suggestionFrom({ text: '> run the tests again', dim: true }), 'run the tests again');
  assert.strictEqual(suggestionFrom({ text: '❯ typed by the user', dim: false }), null, 'real input is not a suggestion');
  assert.strictEqual(suggestionFrom({ text: '❯ ', dim: true }), null);
  assert.strictEqual(suggestionFrom(null), null);
  const app = read('app.js');
  assert.match(read('index.html'), /<span class="suggestion-label">Use suggestion<\/span>/);
  assert.match(app, /input\.fill\(suggestion\)/, 'a tap fills the input, it never sends');
});

test('stars from the editor show on rows and results; a star filter narrows the list', () => {
  const app = read('app.js');
  assert.match(read('index.html'), /<button type="button" id="star-filter" class="chip" aria-pressed="false" title="Show only sessions starred in the editor">★ Starred<\/button>/);
  assert.match(app, /r\.star\.hidden = !s\.favorite;/);
  assert.match(app, /const visible = starOnly \? state\.sessions\.filter\(\(s\) => s\.favorite\) : state\.sessions;/);
  assert.match(app, /hit\.favorite \? el\('span', \{ class: 'star'/);
});

test('notifications: one switch per device, disabled with a reason over plain http; links open the session', async () => {
  const { pushSupported, keyBytes, sessionFromUrl, PUSH_UNAVAILABLE } = await import(path.join(WEB, 'notify.js'));
  assert.strictEqual(PUSH_UNAVAILABLE, 'needs HTTPS — enable certificates in the tailnet');
  assert.strictEqual(pushSupported({ isSecureContext: false, navigator: { serviceWorker: {} }, PushManager: 1, Notification: 1 }), false);
  assert.strictEqual(pushSupported({ isSecureContext: true, navigator: { serviceWorker: {} }, PushManager: 1, Notification: 1 }), true);
  assert.deepStrictEqual([...keyBytes('AQID')], [1, 2, 3]);
  assert.strictEqual(sessionFromUrl('https://hub.example.test/#session=cc-a%20b'), 'cc-a b');
  assert.strictEqual(sessionFromUrl('https://hub.example.test/'), null);
  const app = read('app.js');
  assert.match(app, /role: 'switch'/);
  assert.match(app, /inert\(sw, supported \? null : `Notifications \$\{PUSH_UNAVAILABLE\}\.`\)/);
  assert.match(app, /text: supported \? `Get a notification when a session on [^`]*` : PUSH_UNAVAILABLE/);
});

test('home-screen app and fullscreen: PNG icons, standalone manifest, an immersive toggle with a way back', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.strictEqual(manifest.display, 'standalone');
  assert.strictEqual(manifest.id, './');
  for (const size of ['192x192', '512x512']) {
    const icon = manifest.icons.find((i) => i.sizes === size && i.type === 'image/png');
    assert.ok(icon && fs.existsSync(path.join(WEB, icon.src)), size);
  }
  const html = read('index.html');
  assert.match(html, /<link rel="apple-touch-icon" href="icon-180\.png">/);
  assert.ok(fs.existsSync(path.join(WEB, 'icon-180.png')));
  assert.match(html, /id="immersive-toggle"[^>]*aria-label="Fullscreen"/);
  assert.match(html, /id="immersive-exit"[^>]*aria-label="Leave fullscreen"[^>]*hidden/);
  assert.match(read('style.css'), /body\.immersive \.topbar,[\s\S]*?display: none !important;/);
  const app = read('app.js');
  assert.match(app, /requestFullscreen/);
  assert.match(app, /addEventListener\('fullscreenchange'/, 'leaving browser fullscreen leaves immersive mode too');
  assert.match(app, /display-mode: standalone/);
});

test('quick replies: only the block with the cursor counts; wrapped and description lines stay with their option', async () => {
  const { parseOptions } = await import(path.join(WEB, 'quick-replies.js'));
  const planAndDialog = [
    'Plan:',
    '1. Update the parser',
    '2. Add tests',
    '3. Ship it',
    '',
    ' Do you want to make this edit to quick-replies.js?',
    ' ❯ 1. Yes',
    '   2. Yes, allow all edits during this session (shift+tab)',
    '      and keep going',
    '   3. No, and tell Claude what to do differently (esc)',
  ];
  const options = parseOptions(planAndDialog);
  assert.deepStrictEqual(options.map((o) => o.key), ['1', '2', '3', 'Escape']);
  assert.strictEqual(options[0].label, 'Yes');
  assert.strictEqual(options[1].label, 'Yes, allow all edits during this session (shift+tab)');
  assert.strictEqual(options[1].detail, 'and keep going');
  const question = [
    '│ Which colour should the chart use?            │',
    '│ ❯ 1. Blue                                      │',
    '│      Calm and readable                         │',
    '│   2. Green                                     │',
    '│      Matches the brand                         │',
    '│   3. Type something.                           │',
  ];
  assert.deepStrictEqual(parseOptions(question).map((o) => [o.key, o.label, o.detail || '']), [['1', 'Blue', 'Calm and readable'], ['2', 'Green', 'Matches the brand'], ['3', 'Type something.', '']]);
  assert.deepStrictEqual(parseOptions(planAndDialog.slice(0, 4)), [], 'a numbered list without the cursor is not a dialog');
});

test('old drafts give way: the newest are kept within about 1 MB, and the outbox can always save', async () => {
  const { DraftStore, Outbox, DRAFTS_MAX_TOTAL } = await import(path.join(WEB, 'input.js'));
  const data = new Map();
  let quota = Infinity;
  const used = () => [...data.values()].reduce((n, v) => n + v.length, 0);
  const store = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      const before = data.get(k);
      data.set(k, v);
      if (used() > quota) {
        if (before === undefined) data.delete(k);
        else data.set(k, before);
        throw new Error('QuotaExceededError');
      }
    },
    removeItem: (k) => data.delete(k),
    key: (i) => [...data.keys()][i] ?? null,
    get length() { return data.size; },
  };
  const drafts = new DraftStore(store);
  for (let i = 0; i < 80; i++) drafts.save('self', `cc-${i}`, 'x'.repeat(19 * 1024));
  const kept = [...data.keys()].filter((k) => k.startsWith('claude-remote.draft:'));
  assert.ok(kept.length * 19 * 1024 <= DRAFTS_MAX_TOTAL, `kept ${kept.length}`);
  assert.strictEqual(drafts.load('self', 'cc-79').length, 19 * 1024, 'the newest draft stays');
  assert.strictEqual(drafts.load('self', 'cc-0'), '', 'the oldest went first');
  quota = used() + 100;
  const box = new Outbox(store);
  assert.ok(box.add('cc-x', 'y'.repeat(4000)), 'drafts make room for a queued message');
  assert.strictEqual(JSON.parse(data.get('claude-remote.outbox')).length, 1);
});

test('a notification opens its session on a cold start; push never sticks; times stay fresh', () => {
  const app = read('app.js');
  assert.match(app, /!state\.current && !pendingOpen\) switchHost\(target\)/, 'a remembered tab never overrides the link');
  assert.match(app, /if \(pendingOpen && hostFor\(pendingOpen\) === c\)/, 'the link is honoured even when its hub answers in the background');
  assert.match(app, /if \(!sent\) \{[\s\S]{0,80}pushSettled\(\)/, 'offline hub: the switch returns at once');
  assert.match(app, /pushTimer = setTimeout\(/, 'no answer: the switch returns after a timeout');
  assert.match(app, /onSubscriptionChange\(/, 'a renewed browser subscription is sent to the hub');
  assert.match(app, /setInterval\(\(\) => \{\s*renderList\(\);\s*renderHostTabs\(\);\s*\}, 60000\)/);
});

test('a long wait reads as stale, and chat never opens blank', async () => {
  const { staleFor } = await import(path.join(WEB, 'inbox.js'));
  const now = new Date(2026, 9, 3, 15, 0).getTime();
  assert.strictEqual(staleFor(new Date(2026, 9, 3, 12, 0).toISOString(), now), '');
  assert.strictEqual(staleFor(new Date(2026, 8, 30, 12, 0).toISOString(), now), '3 days');
  assert.strictEqual(staleFor(new Date(2026, 9, 2, 8, 0).toISOString(), now), 'yesterday');
  const app = read('app.js');
  assert.match(app, /pill-stale/);
  assert.match(app, /return inboxSections\(c\.sessions \|\| \[\]\)\.needs\.length/, 'tab badge counts what the Needs you section shows');
  assert.match(app, /text: 'Loading conversation…'/);
  assert.match(app, /keyOf\(currentItem\(\) \|\| \{\}\) !== key/, 'compared by key, not by object');
  assert.match(app, /Could not load the conversation/);
});

test('take over lives on the read-only session screen; unavailable controls say why when tapped', () => {
  const app = read('app.js');
  assert.ok(!/text: 'Take over'/.test(app), 'no take-over buttons in lists');
  assert.match(read('index.html'), /<button type="button" id="takeover-here" class="primary">Take over…<\/button>/);
  assert.ok(!/\.disabled = /.test(app), 'controls are never silently disabled');
  assert.match(app, /setAttribute\('aria-disabled', 'true'\)/);
  assert.match(app, /if \(explainIfInert\(e\.currentTarget\)\) return;/);
});

test('sheets are modal dialogs; take over shows names first and internals on request; revoke states its consequence', () => {
  const app = read('app.js');
  assert.match(read('index.html'), /<dialog id="sheet" class="sheet" aria-labelledby="sheet-title"><\/dialog>/);
  assert.ok(!/sheet-backdrop/.test(read('index.html') + app), 'the dialog backdrop replaces the old overlay');
  assert.match(app, /sheet\.showModal\(\)/);
  assert.match(app, /el\('details', \{ class: 'facts-more' \}, \[el\('summary', \{ text: 'Details' \}\)/);
  assert.ok(!/SIGTERM/.test(app.slice(app.indexOf('function showTakeoverSheet'), app.indexOf('function showSettings'))), 'no process jargon in the sheet text');
  assert.match(app, /loses access at once and has to be paired again/);
  assert.ok(!/Tap again to revoke/.test(app));
});

test('the open session lives in the URL: host and key, back returns to the list', async () => {
  const { sessionTarget, sessionHash } = await import(path.join(WEB, 'notify.js'));
  assert.deepStrictEqual(sessionTarget('https://hub.example.test/#session=studio.example.test/cc-a%20b'), { host: 'studio.example.test', key: 'cc-a b' });
  assert.deepStrictEqual(sessionTarget('https://hub.example.test/#session=cc-int'), { host: null, key: 'cc-int' }, 'notification links name only the session');
  assert.strictEqual(sessionTarget('https://hub.example.test/'), null);
  assert.strictEqual(sessionHash('studio.example.test', 'cc-a b'), '#session=studio.example.test/cc-a%20b');
  const app = read('app.js');
  assert.match(app, /history\[replace \? 'replaceState' : 'pushState'\]\(/);
  assert.match(app, /addEventListener\('popstate'/);
  assert.match(app, /if \(history\.state && history\.state\.session\) history\.back\(\);/);
});

test('device names carry date and origin, new devices are announced, small screens and keyboards are served', () => {
  const app = read('app.js');
  const html = read('index.html');
  assert.match(app, /\$\{base\} · \$\{stamp\}/, 'auto device names get a date');
  assert.match(app, /case 'deviceAdded':/);
  assert.match(app, /`New device paired: \$\{name\}\$\{node \? ` \(\$\{node\}\)` : ''\}`/);
  assert.match(html, /<div id="device-banner" class="device-banner" role="status" hidden><\/div>/);
  assert.match(app, /'Search'/, 'short search placeholder on phones');
  assert.match(app, /`offline · list from \$\{/);
  assert.match(app, /e\.key === 'j'/);
  assert.match(app, /e\.key === '\?'/);
  assert.match(html, /<details class="keys-more"><summary>More<\/summary>/);
});

test('a deep link opens a steerable session in the terminal before the list arrives', async () => {
  const { initialTab } = await import(path.join(WEB, 'inbox.js'));
  assert.strictEqual(initialTab('cc-shop', null, 'chat'), 'terminal');
  assert.strictEqual(initialTab('abcdabcd-1111-4222-8333-444455556666', null, 'terminal'), 'chat');
  assert.strictEqual(initialTab('cc-shop', { managed: true }, 'chat'), 'chat');
  assert.strictEqual(initialTab('cc-shop', { managed: true }, 'terminal'), 'terminal');
  assert.strictEqual(initialTab('x', { managed: false }, 'terminal'), 'chat');
});

test('every device row offers Rename, which sends renameDevice with the trimmed name', () => {
  const app = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
  assert.match(app, /text: 'Rename', onclick: \(\) => showRenameDevice\(d\)/);
  assert.match(app, /conn\.send\(\{ t: 'renameDevice', deviceId: d\.id, name: next \}\)/);
});

test('host tabs shrink with an ellipsis and keep the full name for assistive tech', () => {
  const app = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(WEB, 'style.css'), 'utf8');
  assert.match(app, /label: el\('span', \{ class: 'host-label' \}\)/);
  assert.match(app, /setAttr\(t\.btn, 'aria-label', /);
  assert.match(css, /\.host-label \{[^}]*text-overflow: ellipsis/);
  assert.match(css, /\.host-tab \{[^}]*flex: 0 1 auto;[^}]*min-width: /);
});
