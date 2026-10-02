'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { parseLines } = require('../transcript');
const { mountChat, renderMarkdown, summarizeInput } = require('../web/chat');

const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'chat.js'), 'utf8');
const fixture = parseLines(fs.readFileSync(path.join(__dirname, 'fixtures', 'transcript-synthetic.jsonl'))).events;

class FakeNode {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = tag;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.listeners = {};
    this.scrollTop = 0;
    this.clientHeight = 300;
    this.text = tag === '#text' ? '' : null;
    this.classes = new Set();
    this.classList = {
      add: (c) => this.classes.add(c),
      remove: (c) => this.classes.delete(c),
      contains: (c) => this.classes.has(c),
      toggle: (c) => (this.classes.has(c) ? (this.classes.delete(c), false) : (this.classes.add(c), true)),
    };
  }

  get className() {
    return [...this.classes].join(' ');
  }

  set className(value) {
    this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] || null;
  }

  get scrollHeight() {
    return this.descendants().length * 20;
  }

  get textContent() {
    if (this.tagName === '#text') return this.text;
    return this.childNodes.map((c) => c.textContent).join('');
  }

  set textContent(value) {
    if (this.tagName === '#text') {
      this.text = String(value);
      return;
    }
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (value !== '') this.appendChild(this.ownerDocument.createTextNode(String(value)));
  }

  appendChild(node) {
    return this.insertBefore(node, null);
  }

  insertBefore(node, ref) {
    if (node.tagName === '#fragment') {
      for (const c of [...node.childNodes]) this.insertBefore(c, ref);
      return node;
    }
    if (node.parentNode) node.parentNode.removeChild(node);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(node);
    else this.childNodes.splice(i, 0, node);
    node.parentNode = this;
    return node;
  }

  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }

  setAttribute(k, v) {
    this.attributes[k] = String(v);
  }

  getAttribute(k) {
    return k in this.attributes ? this.attributes[k] : null;
  }

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  dispatch(type) {
    for (const fn of this.listeners[type] || []) fn({ type });
  }

  descendants() {
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  all(className) {
    return this.descendants().filter((n) => n.classes && n.classes.has(className));
  }

  one(className) {
    return this.all(className)[0] || null;
  }

  tags(tag) {
    return this.descendants().filter((n) => n.tagName === tag);
  }
}

const doc = {
  createElement: (tag) => new FakeNode(doc, tag.toLowerCase()),
  createTextNode: (text) => {
    const n = new FakeNode(doc, '#text');
    n.text = String(text);
    return n;
  },
  createDocumentFragment: () => new FakeNode(doc, '#fragment'),
};

function host() {
  return new FakeNode(doc, 'div');
}

function fakeApi(events, { pageEvents, live, reset, agentEvents } = {}) {
  const liveHandlers = [];
  const resetHandlers = [];
  const calls = [];
  const api = {
    calls,
    requestEvents: async (sessionId, opts) => {
      calls.push({ sessionId, ...opts });
      const items = pageEvents ? pageEvents(opts) : events;
      return items;
    },
    onEvents: (cb) => {
      liveHandlers.push(cb);
      return () => liveHandlers.splice(liveHandlers.indexOf(cb), 1);
    },
    onReset: (cb) => {
      resetHandlers.push(cb);
    },
    emitLive: (msg) => liveHandlers.forEach((cb) => cb(msg)),
    emitReset: (msg) => resetHandlers.forEach((cb) => cb(msg)),
  };
  if (agentEvents) api.requestAgentEvents = async (sessionId, toolUseId, opts) => agentEvents(sessionId, toolUseId, opts);
  return api;
}

const page = (items, from, to) => ({ items, from, to, size: to, unknown: items.filter((e) => e.kind === 'raw' && !e.truncated).length });
const tick = () => new Promise((r) => setImmediate(r));

test('the view never builds DOM from HTML strings', () => {
  for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'DOMParser', 'srcdoc']) assert.ok(!source.includes(banned), `${banned} must not appear`);
  assert.ok(!/\beval\(|new Function\(/.test(source));
});

test('the synthetic session renders as a readable chat with tool results attached by id', async () => {
  const api = fakeApi(page(fixture, 0, 24927));
  const root = host();
  const chat = mountChat(root, api);
  await chat.open('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.strictEqual(root.all('chat-prompt').length, 4);
  const prompt = root.all('chat-prompt')[0].textContent;
  assert.match(prompt, /^Please list the files/);
  const tools = root.all('chat-tool');
  assert.deepStrictEqual(tools.map((t) => t.one('chat-tool-name').textContent), ['Bash', 'Read', 'Agent', 'Write']);
  assert.deepStrictEqual(tools.map((t) => t.dataset.status), ['ok', 'ok', 'ok', 'denied']);
  assert.strictEqual(tools[0].one('chat-tool-summary').textContent, 'ls fixtures');
  assert.strictEqual(tools[0].one('chat-tool-result').textContent, 'README.md\nsample.jsonl', 'the Bash call shows the Bash result although the Read result came first');
  assert.match(tools[1].one('chat-tool-result').textContent, /^# Fixtures/);
  assert.match(tools[3].one('chat-tool-result').textContent, /^deniedWrite blocked/);
  assert.strictEqual(root.all('chat-orphan-result').length, 0);
  const assistants = root.all('chat-assistant');
  assert.strictEqual(assistants[0].all('chat-thinking').length, 1, 'thinking shows as a label only');
  assert.strictEqual(assistants.find((a) => a.dataset.messageId === 'msg_01first').all('chat-tool').length, 2, 'parallel tool calls sit in one assistant message');
  const question = root.one('chat-question');
  assert.deepStrictEqual(question.all('chat-option-label').map((o) => o.textContent), ['Keep both', 'Remove the readme']);
  assert.strictEqual(question.dataset.status, 'ok');
  assert.match(question.one('chat-tool-result').textContent, /Keep both/);
  assert.strictEqual(root.one('chat-command').textContent, '/compact keep the file list');
  assert.strictEqual(root.one('chat-command-output').textContent, 'Compacted the conversation.');
  assert.match(root.one('chat-compact').textContent, /compacted \(manual\) · 52k → 8k tokens/);
  assert.strictEqual(root.all('chat-compact-summary').length, 1);
  assert.strictEqual(root.one('chat-injected').one('chat-tag').textContent, 'task_notification');
  assert.strictEqual(root.all('chat-interrupted').length, 1);
  assert.strictEqual(root.all('chat-queued').length, 0, 'a queued message that was delivered is removed again');
  assert.strictEqual(root.all('chat-raw').length, 1);
  assert.match(root.one('chat-raw').textContent, /unknown linewormhole-state/);
  assert.strictEqual(root.one('chat-footer').textContent, '1 unknown line');
  assert.match(root.all('chat-notice').map((n) => n.textContent).join('|'), /api_error.*rate/);
  assert.ok(root.all('chat-badge').some((b) => b.textContent === '1 image'));
  assert.strictEqual(chat.state.meta.customTitle, 'fixtures-final');
  assert.ok(!root.textContent.includes('Hidden caveat'));
  assert.strictEqual(root.one('chat-top-note').textContent, 'beginning of session');
});

test('markdown is tokenized into text nodes: code, lists, paragraphs, safe links only', () => {
  const out = renderMarkdown(doc, '# Title\n\nFirst `code` and **bold** <script>alert(1)</script>\nsecond line\n\n- one\n- two\n\n1. first\n2. second\n\n```js\nconst x = 1;\n```\n[ok](https://example.invalid/x) [bad](javascript:alert(1)) [rel](http://example.invalid/y)');
  const wrap = doc.createElement('div');
  wrap.appendChild(out);
  assert.strictEqual(wrap.tags('script').length, 0);
  assert.ok(wrap.textContent.includes('<script>alert(1)</script>'), 'angle brackets stay literal text');
  assert.strictEqual(wrap.one('chat-heading').textContent, 'Title');
  assert.strictEqual(wrap.tags('code').length, 2);
  assert.strictEqual(wrap.tags('strong')[0].textContent, 'bold');
  assert.strictEqual(wrap.tags('br').length, 1);
  assert.deepStrictEqual(wrap.tags('ul')[0].childNodes.map((li) => li.textContent), ['one', 'two']);
  assert.deepStrictEqual(wrap.tags('ol')[0].childNodes.map((li) => li.textContent), ['first', 'second']);
  assert.strictEqual(wrap.one('chat-code-block').textContent, 'const x = 1;');
  assert.ok(wrap.one('chat-code-block').classes.has('chat-lang-js'));
  const links = wrap.tags('a');
  assert.deepStrictEqual(links.map((a) => a.getAttribute('href')), ['https://example.invalid/x', 'http://example.invalid/y']);
  assert.ok(links.every((a) => a.getAttribute('rel') === 'noopener noreferrer'));
  assert.ok(wrap.textContent.includes('[bad](javascript:alert(1))'), 'a non-http link is left as text');
});

test('tool inputs are summarized per tool and truncated inputs stay readable', () => {
  assert.strictEqual(summarizeInput('Bash', { command: 'ls -la', description: 'x' }), 'ls -la');
  assert.strictEqual(summarizeInput('Read', { file_path: '/a/b.txt' }), '/a/b.txt');
  assert.strictEqual(summarizeInput('Agent', { description: 'Count lines', prompt: 'long' }), 'Count lines');
  assert.strictEqual(summarizeInput('mcp__x__y', { url: 'https://example.invalid' }), 'https://example.invalid');
  assert.strictEqual(summarizeInput('Bash', { truncated: true, text: `{"command":"${'a'.repeat(300)}` }).length, 100);
  assert.strictEqual(summarizeInput('Bash', { command: `line one\nline two ${'z'.repeat(200)}` }).length, 100);
});

test('scrolling up loads older pages in order and merges an assistant split across pages', async () => {
  const all = fixture;
  const split = all.findIndex((e) => e.kind === 'assistant' && e.messageId === 'msg_01first');
  const newer = all.slice(split + 1);
  const halfA = { ...all[split], blocks: all[split].blocks.slice(0, 2) };
  const halfB = { ...all[split], blocks: all[split].blocks.slice(2) };
  const api = fakeApi(null, {
    pageEvents: (opts) => {
      if (opts.before == null) return page([halfB, ...newer], 5000, 9000);
      if (opts.before === 5000) return page([...all.slice(0, split), halfA], 1000, 5000);
      return page([], 0, 1000);
    },
  });
  const root = host();
  const chat = mountChat(root, api, { pageSize: 10 });
  await chat.open('s1');
  assert.strictEqual(chat.state.from, 5000);
  const list = root.one('chat-list');
  assert.strictEqual(list.firstChild.dataset.messageId, 'msg_01first');
  assert.strictEqual(list.firstChild.all('chat-tool').length, 2);
  const scroll = root.one('chat-scroll');
  scroll.scrollTop = 10;
  scroll.dispatch('scroll');
  await tick();
  await tick();
  assert.strictEqual(chat.state.from, 1000);
  assert.strictEqual(root.all('chat-assistant').filter((a) => a.dataset.messageId === 'msg_01first').length, 1, 'both halves merged into one message');
  const merged = root.all('chat-assistant').find((a) => a.dataset.messageId === 'msg_01first');
  assert.deepStrictEqual(merged.childNodes.map((c) => [...c.classes][0]), ['chat-thinking', 'chat-text', 'chat-tool', 'chat-tool']);
  assert.strictEqual(list.firstChild.one('chat-prompt') || list.firstChild, list.firstChild);
  assert.match(root.all('chat-prompt')[0].textContent, /^Please list/);
  scroll.scrollTop = 0;
  scroll.dispatch('scroll');
  await tick();
  await tick();
  assert.strictEqual(chat.state.from, 0);
  assert.strictEqual(chat.state.atStart, true);
  assert.ok(root.one('chat-load-older').classes.has('chat-hidden'));
  assert.deepStrictEqual(api.calls.map((c) => c.before), [undefined, 5000, 1000]);
  scroll.dispatch('scroll');
  await tick();
  assert.strictEqual(api.calls.length, 3, 'no further requests at the beginning');
});

test('live events append, merge into the open assistant message and attach late results; a reset reloads', async () => {
  const prompt = fixture.find((e) => e.kind === 'prompt');
  const api = fakeApi(page([prompt], 0, 100));
  const root = host();
  const chat = mountChat(root, api);
  await chat.open('s1');
  const list = root.one('chat-list');
  api.emitLive({ sessionId: 'other', items: [prompt] });
  assert.strictEqual(list.childNodes.length, 1, 'events of another session are ignored');
  api.emitLive({ sessionId: 's1', items: [{ kind: 'assistant', messageId: 'live1', blocks: [{ type: 'text', text: 'Working on it' }] }], to: 200 });
  api.emitLive({ sessionId: 's1', items: [{ kind: 'assistant', messageId: 'live1', blocks: [{ type: 'toolUse', id: 'tl1', name: 'Bash', input: { command: 'pwd' } }] }], to: 300 });
  assert.strictEqual(root.all('chat-assistant').length, 1);
  assert.strictEqual(root.one('chat-tool').dataset.status, 'pending');
  api.emitLive({ sessionId: 's1', items: [{ kind: 'toolResult', toolUseId: 'tl1', isError: false, denied: false, text: '/home/sample' }, { kind: 'raw', type: 'brand-new', size: 10 }], to: 400 });
  assert.strictEqual(root.one('chat-tool').dataset.status, 'ok');
  assert.strictEqual(root.one('chat-tool-result').textContent, '/home/sample');
  assert.strictEqual(chat.state.to, 400);
  assert.strictEqual(root.one('chat-footer').textContent, '1 unknown line');
  api.emitLive({ sessionId: 's1', items: [{ kind: 'toolResult', toolUseId: 'unknown-call', isError: true, denied: false, text: 'late' }] });
  assert.strictEqual(root.all('chat-orphan-result').length, 1);
  api.emitReset({ sessionId: 's1' });
  await tick();
  await tick();
  assert.strictEqual(list.childNodes.length, 1, 'after a reset only the reloaded history remains');
  assert.strictEqual(chat.state.unknown, 0);
  chat.destroy();
  assert.strictEqual(root.childNodes.length, 0);
});

test('an Agent call offers to expand its subagent events when the api supports it', async () => {
  const events = fixture.filter((e) => (e.kind === 'assistant' && e.messageId === 'msg_04fourth') || (e.kind === 'toolResult' && e.toolUseId === 'toolu_01D'));
  const agentEvents = parseLines(fs.readFileSync(path.join(__dirname, 'fixtures', 'tr-agent-one.jsonl'))).events;
  const asked = [];
  const api = fakeApi(page(events, 0, 100), {
    agentEvents: async (sessionId, toolUseId) => {
      asked.push([sessionId, toolUseId]);
      return page(agentEvents, 0, 50);
    },
  });
  const root = host();
  const chat = mountChat(root, api);
  await chat.open('s1');
  const button = root.one('chat-subagent-toggle');
  assert.ok(button, 'the Agent tool has a subagent button');
  button.dispatch('click');
  await tick();
  await tick();
  assert.deepStrictEqual(asked, [['s1', 'toolu_01D']]);
  const sub = root.one('chat-subagent');
  assert.strictEqual(sub.all('chat-prompt').length, 1);
  assert.strictEqual(sub.one('chat-tool').dataset.status, 'ok');
  assert.strictEqual(button.textContent, 'hide subagent');
  button.dispatch('click');
  assert.ok(sub.classes.has('chat-hidden'));
  const plain = fakeApi(page(events, 0, 100));
  const root2 = host();
  await mountChat(root2, plain).open('s1');
  assert.strictEqual(root2.one('chat-subagent-toggle'), null, 'no button without api support');
});

test('live events during the first load are kept, events already in the page are not repeated', async () => {
  const prompt = fixture.find((e) => e.kind === 'prompt');
  let release;
  const api = fakeApi([]);
  api.requestEvents = () => new Promise((r) => (release = r));
  const root = host();
  const chat = mountChat(root, api);
  const opened = chat.open('s1');
  await tick();
  api.emitLive({ sessionId: 's1', items: [{ ...prompt, uuid: 'early', text: 'arrived while loading', offset: 150 }], from: 120, to: 200 });
  api.emitLive({ sessionId: 's1', items: [{ ...prompt, uuid: 'dup', text: 'already in the page', offset: 40 }], from: 40, to: 100 });
  release(page([{ ...prompt, offset: 0 }, { ...prompt, uuid: 'p2', text: 'already in the page', offset: 40 }], 0, 120));
  await opened;
  const texts = root.all('chat-prompt').map((n) => n.textContent);
  assert.strictEqual(texts.filter((t) => t.includes('already in the page')).length, 1);
  assert.ok(texts.some((t) => t.includes('arrived while loading')));
  assert.strictEqual(chat.state.to, 200);
  api.emitLive({ sessionId: 's1', items: [{ ...prompt, uuid: 'old', text: 'replayed old line', offset: 150 }], from: 150, to: 200 });
  assert.ok(!root.all('chat-prompt').some((n) => n.textContent.includes('replayed old line')));
  chat.destroy();
});
