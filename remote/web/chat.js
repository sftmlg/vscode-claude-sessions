(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ClaudeChat = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PAGE = 100;
  const TOP_THRESHOLD = 200;
  const BOTTOM_THRESHOLD = 80;
  const SUMMARY_MAX = 100;

  function oneLine(text, max) {
    const flat = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  }

  function firstString(input) {
    if (!input || typeof input !== 'object') return '';
    for (const value of Object.values(input)) if (typeof value === 'string' && value) return value;
    return '';
  }

  function summarizeInput(name, input) {
    if (!input || typeof input !== 'object') return '';
    if (input.truncated && typeof input.text === 'string') return oneLine(input.text, SUMMARY_MAX);
    const pick = {
      Bash: 'command',
      Read: 'file_path',
      Write: 'file_path',
      Edit: 'file_path',
      NotebookEdit: 'notebook_path',
      Agent: 'description',
      Grep: 'pattern',
      Glob: 'pattern',
      WebFetch: 'url',
      WebSearch: 'query',
      Skill: 'skill',
      SendMessage: 'to',
      Monitor: 'description',
    }[name];
    const value = pick && typeof input[pick] === 'string' ? input[pick] : firstString(input);
    return oneLine(value, SUMMARY_MAX);
  }

  function inputText(input) {
    if (!input || typeof input !== 'object') return '';
    if (input.truncated && typeof input.text === 'string') return input.text;
    const keys = Object.keys(input);
    if (keys.length === 1 && typeof input[keys[0]] === 'string') return input[keys[0]];
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return '';
    }
  }

  function formatTokens(n) {
    if (typeof n !== 'number') return '?';
    return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
  }

  function formatSize(bytes) {
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
  }

  function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function safeHref(url) {
    return /^https?:\/\/[^\s<>"']+$/i.test(url) ? url : null;
  }

  function renderInline(doc, parent, text) {
    const re = /(`+)([\s\S]*?)\1|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(doc.createTextNode(text.slice(last, m.index)));
      if (m[2] !== undefined) parent.appendChild(el(doc, 'code', 'chat-code', m[2]));
      else if (m[3] !== undefined) parent.appendChild(el(doc, 'strong', null, m[3]));
      else {
        const href = safeHref(m[5]);
        if (href) {
          const a = el(doc, 'a', 'chat-link', m[4]);
          a.setAttribute('href', href);
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
          parent.appendChild(a);
        } else parent.appendChild(doc.createTextNode(m[0]));
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) parent.appendChild(doc.createTextNode(text.slice(last)));
  }

  function renderMarkdown(doc, text) {
    const output = doc.createDocumentFragment();
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    let paragraph = [];
    let list = null;
    let code = null;
    const flushParagraph = () => {
      if (!paragraph.length) return;
      const p = el(doc, 'p', 'chat-p');
      paragraph.forEach((line, i) => {
        if (i) p.appendChild(doc.createElement('br'));
        renderInline(doc, p, line);
      });
      output.appendChild(p);
      paragraph = [];
    };
    const flushList = () => {
      list = null;
    };
    for (const line of lines) {
      if (code) {
        if (/^\s*```/.test(line)) {
          code.pre.appendChild(el(doc, 'code', code.lang ? `chat-code-block chat-lang-${code.lang}` : 'chat-code-block', code.lines.join('\n')));
          output.appendChild(code.pre);
          code = null;
        } else code.lines.push(line);
        continue;
      }
      const fence = /^\s*```\s*([\w+-]*)/.exec(line);
      if (fence) {
        flushParagraph();
        flushList();
        code = { pre: el(doc, 'pre', 'chat-pre'), lang: fence[1].toLowerCase(), lines: [] };
        continue;
      }
      const item = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
      if (item) {
        flushParagraph();
        const ordered = /^\s*\d/.test(line);
        if (!list || list.ordered !== ordered) {
          list = { node: el(doc, ordered ? 'ol' : 'ul', 'chat-list-md'), ordered };
          output.appendChild(list.node);
        }
        const li = el(doc, 'li', 'chat-li');
        renderInline(doc, li, item[1]);
        list.node.appendChild(li);
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        flushList();
        continue;
      }
      const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
      if (heading) {
        flushParagraph();
        flushList();
        const h = el(doc, 'p', 'chat-p chat-heading');
        renderInline(doc, h, heading[1]);
        output.appendChild(h);
        continue;
      }
      flushList();
      paragraph.push(line);
    }
    if (code) {
      code.pre.appendChild(el(doc, 'code', 'chat-code-block', code.lines.join('\n')));
      output.appendChild(code.pre);
    }
    flushParagraph();
    return output;
  }

  function details(doc, className, summaryNodes, open) {
    const d = el(doc, 'details', className);
    if (open) d.setAttribute('open', '');
    const s = el(doc, 'summary', 'chat-summary');
    for (const n of summaryNodes) s.appendChild(typeof n === 'string' ? doc.createTextNode(n) : n);
    d.appendChild(s);
    return d;
  }

  function createRenderer(doc, api, options) {
    const slots = new Map();
    const queued = new Map();
    const render = {
      prompt(e) {
        const m = el(doc, 'div', 'chat-msg chat-prompt');
        const bubble = el(doc, 'div', 'chat-bubble');
        bubble.appendChild(renderMarkdown(doc, e.text));
        if (e.images) bubble.appendChild(el(doc, 'span', 'chat-badge', `${e.images} image${e.images === 1 ? '' : 's'}`));
        if (e.source === 'queued') bubble.appendChild(el(doc, 'span', 'chat-badge', 'queued'));
        m.appendChild(bubble);
        return m;
      },
      injected(e) {
        const d = details(doc, 'chat-msg chat-injected', [el(doc, 'span', 'chat-tag', e.origin || 'system'), ' ', oneLine(e.text, 80)]);
        d.appendChild(el(doc, 'pre', 'chat-pre chat-pre-plain', e.text));
        return d;
      },
      command(e) {
        const m = el(doc, 'div', 'chat-msg chat-command');
        m.appendChild(el(doc, 'code', 'chat-code', [e.name, e.args].filter(Boolean).join(' ')));
        return m;
      },
      commandOutput(e) {
        const m = el(doc, 'div', 'chat-msg chat-command-output');
        m.appendChild(el(doc, 'pre', 'chat-pre chat-pre-plain', e.text));
        return m;
      },
      assistant(e) {
        const m = el(doc, 'div', 'chat-msg chat-assistant');
        if (e.messageId) m.dataset.messageId = e.messageId;
        for (const b of e.blocks || []) m.appendChild(render.block(b));
        return m;
      },
      block(b) {
        if (b.type === 'text') {
          const t = el(doc, 'div', 'chat-text');
          t.appendChild(renderMarkdown(doc, b.text));
          return t;
        }
        if (b.type === 'thinking') return el(doc, 'div', 'chat-thinking', 'thinking');
        if (b.type === 'toolUse') return render.tool(b);
        if (b.type === 'fallback') return el(doc, 'div', 'chat-note', `model fallback: ${b.from || '?'} → ${b.to || '?'}`);
        return el(doc, 'div', 'chat-note', `block: ${b.blockType || b.type}`);
      },
      tool(b) {
        const status = el(doc, 'span', 'chat-tool-status', '…');
        const d = details(doc, 'chat-tool', [status, ' ', el(doc, 'span', 'chat-tool-name', b.name), ' ', el(doc, 'span', 'chat-tool-summary', summarizeInput(b.name, b.input))]);
        d.dataset.status = 'pending';
        const body = el(doc, 'div', 'chat-tool-body');
        const input = inputText(b.input);
        if (input) body.appendChild(el(doc, 'pre', 'chat-pre chat-tool-input', input));
        const result = el(doc, 'div', 'chat-tool-result chat-pending', 'running…');
        body.appendChild(result);
        if (b.name === 'Agent' && api && typeof api.requestAgentEvents === 'function') {
          const button = el(doc, 'button', 'chat-button chat-subagent-toggle', 'show subagent');
          button.setAttribute('type', 'button');
          const host = el(doc, 'div', 'chat-subagent');
          button.addEventListener('click', () => options.expandAgent(b.id, host, button));
          body.appendChild(button);
          body.appendChild(host);
        }
        d.appendChild(body);
        if (b.id) slots.set(b.id, { element: d, status, result });
        return d;
      },
      toolResult(e) {
        const slot = e.toolUseId && slots.get(e.toolUseId);
        const state = e.denied ? 'denied' : e.isError ? 'error' : 'ok';
        if (!slot) {
          const m = el(doc, 'div', `chat-msg chat-orphan-result chat-result-${state}`);
          m.appendChild(el(doc, 'span', 'chat-tag', 'result of an earlier call'));
          m.appendChild(el(doc, 'pre', 'chat-pre chat-pre-plain', e.text));
          return m;
        }
        slot.element.dataset.status = state;
        slot.status.textContent = state === 'ok' ? '✓' : state === 'denied' ? '⊘' : '✕';
        slot.result.className = `chat-tool-result chat-result-${state}`;
        slot.result.textContent = '';
        if (state !== 'ok') slot.result.appendChild(el(doc, 'span', 'chat-tag', state));
        slot.result.appendChild(el(doc, 'pre', 'chat-pre chat-pre-plain', e.text || (state === 'ok' ? '(no output)' : '')));
        return null;
      },
      question(e) {
        const m = el(doc, 'div', 'chat-msg chat-question');
        m.dataset.status = 'pending';
        const status = el(doc, 'span', 'chat-tool-status', '?');
        m.appendChild(status);
        for (const q of e.questions || []) {
          const card = el(doc, 'div', 'chat-question-card');
          if (q.header) card.appendChild(el(doc, 'div', 'chat-question-header', q.header));
          card.appendChild(el(doc, 'div', 'chat-question-text', q.question || ''));
          const list = el(doc, 'ul', 'chat-options');
          for (const o of Array.isArray(q.options) ? q.options : []) {
            const li = el(doc, 'li', 'chat-option');
            li.appendChild(el(doc, 'span', 'chat-option-label', o.label || ''));
            if (o.description) li.appendChild(el(doc, 'span', 'chat-option-desc', o.description));
            list.appendChild(li);
          }
          card.appendChild(list);
          m.appendChild(card);
        }
        const result = el(doc, 'div', 'chat-tool-result chat-pending', 'waiting for an answer…');
        m.appendChild(result);
        if (e.toolUseId) slots.set(e.toolUseId, { element: m, status, result });
        return m;
      },
      interrupted() {
        return el(doc, 'div', 'chat-sep chat-interrupted', 'interrupted');
      },
      turnEnd(e) {
        return el(doc, 'div', 'chat-turn-end', `turn · ${(e.durationMs / 1000).toFixed(1)} s`);
      },
      compact(e) {
        return el(doc, 'div', 'chat-sep chat-compact', `compacted${e.trigger ? ` (${e.trigger})` : ''} · ${formatTokens(e.preTokens)} → ${formatTokens(e.postTokens)} tokens`);
      },
      compactSummary(e) {
        const d = details(doc, 'chat-msg chat-compact-summary', ['summary of the earlier conversation']);
        d.appendChild(el(doc, 'pre', 'chat-pre chat-pre-plain', e.text));
        return d;
      },
      notice(e) {
        const m = el(doc, 'div', `chat-msg chat-notice chat-level-${e.level || 'info'}`);
        m.appendChild(el(doc, 'span', 'chat-tag', e.subtype));
        m.appendChild(el(doc, 'span', 'chat-notice-text', e.text));
        return m;
      },
      queued(e) {
        if (e.op === 'enqueue') {
          const m = el(doc, 'div', 'chat-msg chat-queued');
          m.appendChild(el(doc, 'span', 'chat-tag', 'queued'));
          m.appendChild(el(doc, 'span', 'chat-queued-text', e.text));
          const list = queued.get(e.text) || [];
          list.push(m);
          queued.set(e.text, list);
          return m;
        }
        const list = queued.get(e.text);
        const node = list && list.shift();
        if (node && node.parentNode) node.parentNode.removeChild(node);
        return null;
      },
      meta(e) {
        options.onMeta(e.key, e.value);
        return null;
      },
      raw(e) {
        const m = el(doc, 'div', 'chat-msg chat-raw');
        m.appendChild(el(doc, 'span', 'chat-tag', e.truncated ? 'unreadable line' : 'unknown line'));
        m.appendChild(el(doc, 'span', 'chat-raw-text', `${e.type || 'fragment'}${e.subtype ? `/${e.subtype}` : ''} · ${formatSize(e.size || 0)}`));
        return m;
      },
    };
    return {
      render(e) {
        const fn = render[e.kind];
        if (!fn) return render.raw({ type: e.kind, size: 0 });
        return fn(e);
      },
      renderBlock: render.block,
    };
  }

  function mountChat(target, api, options = {}) {
    const doc = target.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const pageSize = options.pageSize || PAGE;
    const rootEl = el(doc, 'div', 'chat-root');
    const scroll = el(doc, 'div', 'chat-scroll');
    const top = el(doc, 'div', 'chat-top');
    const olderButton = el(doc, 'button', 'chat-button chat-load-older', 'load older');
    olderButton.setAttribute('type', 'button');
    const topNote = el(doc, 'span', 'chat-top-note', '');
    top.appendChild(olderButton);
    top.appendChild(topNote);
    const list = el(doc, 'div', 'chat-list');
    const footer = el(doc, 'div', 'chat-footer', '');
    scroll.appendChild(top);
    scroll.appendChild(list);
    rootEl.appendChild(scroll);
    rootEl.appendChild(footer);
    target.appendChild(rootEl);

    const state = { sessionId: null, from: null, to: null, size: null, unknown: 0, loading: false, atStart: false, meta: {}, generation: 0 };
    let firstAssistant = null;
    let lastAssistant = null;

    const meta = (key, value) => {
      state.meta[key] = value;
      if (typeof options.onMeta === 'function') options.onMeta(key, value, state.meta);
    };

    const subagentRenderer = () => createRenderer(doc, null, { onMeta() {}, expandAgent() {} });

    const expandAgent = async (toolUseId, host, button) => {
      if (host.dataset.loaded) {
        const hidden = host.classList.toggle('chat-hidden');
        button.textContent = hidden ? 'show subagent' : 'hide subagent';
        return;
      }
      button.textContent = 'loading…';
      try {
        const res = await api.requestAgentEvents(state.sessionId, toolUseId, { limit: pageSize });
        const items = (res && (res.items || res.events)) || [];
        host.textContent = '';
        const r = subagentRenderer();
        for (const e of items) {
          const node = r.render(e);
          if (node) host.appendChild(node);
        }
        if (!items.length) host.appendChild(el(doc, 'div', 'chat-note', 'no subagent events'));
        host.dataset.loaded = '1';
        button.textContent = 'hide subagent';
      } catch (err) {
        button.textContent = 'show subagent';
        host.textContent = '';
        host.appendChild(el(doc, 'div', 'chat-note chat-error', `subagent not available: ${err && err.message ? err.message : err}`));
      }
    };

    let renderer = createRenderer(doc, api, { onMeta: meta, expandAgent });

    const updateFooter = () => {
      const parts = [];
      if (state.unknown) parts.push(`${state.unknown} unknown line${state.unknown === 1 ? '' : 's'}`);
      footer.textContent = parts.join(' · ');
      footer.className = parts.length ? 'chat-footer' : 'chat-footer chat-hidden';
    };

    const updateTop = () => {
      olderButton.className = state.atStart || state.loading ? 'chat-button chat-load-older chat-hidden' : 'chat-button chat-load-older';
      topNote.textContent = state.loading ? 'loading…' : state.atStart ? 'beginning of session' : '';
    };

    const nearBottom = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < BOTTOM_THRESHOLD;
    const scrollToBottom = () => {
      scroll.scrollTop = scroll.scrollHeight;
    };

    const mergeAssistant = (into, e, prepend) => {
      const nodes = (e.blocks || []).map((b) => renderer.renderBlock(b));
      if (prepend) {
        const first = into.element.firstChild;
        for (const n of nodes) into.element.insertBefore(n, first);
        into.event = { ...e, blocks: [...(e.blocks || []), ...(into.event.blocks || [])] };
      } else {
        for (const n of nodes) into.element.appendChild(n);
        into.event = { ...into.event, blocks: [...(into.event.blocks || []), ...(e.blocks || [])], stopReason: e.stopReason || into.event.stopReason };
      }
    };

    const append = (events) => {
      const stick = nearBottom();
      for (const e of events) {
        if (e.kind === 'assistant' && lastAssistant && e.messageId && lastAssistant.event.messageId === e.messageId && lastAssistant.element === list.lastChild) {
          mergeAssistant(lastAssistant, e, false);
          continue;
        }
        const node = renderer.render(e);
        if (!node) continue;
        list.appendChild(node);
        if (e.kind === 'assistant') {
          lastAssistant = { element: node, event: e };
          if (!firstAssistant) firstAssistant = lastAssistant;
        }
      }
      if (stick) scrollToBottom();
    };

    const prepend = (events) => {
      const before = scroll.scrollHeight;
      const anchor = list.firstChild;
      let newFirst = null;
      for (const e of events) {
        if (e.kind === 'assistant' && firstAssistant && !newFirst && e.messageId && firstAssistant.event.messageId === e.messageId && firstAssistant.element === anchor && e === events[events.length - 1]) {
          mergeAssistant(firstAssistant, e, true);
          continue;
        }
        const node = renderer.render(e);
        if (!node) continue;
        list.insertBefore(node, anchor);
        if (e.kind === 'assistant' && !newFirst) newFirst = { element: node, event: e };
        if (e.kind === 'assistant') lastAssistant = lastAssistant || { element: node, event: e };
      }
      if (newFirst) firstAssistant = newFirst;
      scroll.scrollTop += scroll.scrollHeight - before;
    };

    const load = async (before) => {
      if (state.loading || !state.sessionId) return null;
      const generation = state.generation;
      state.loading = true;
      updateTop();
      try {
        const res = await api.requestEvents(state.sessionId, before == null ? { limit: pageSize } : { before, limit: pageSize });
        if (generation !== state.generation) return null;
        const items = (res && (res.items || res.events)) || [];
        state.unknown += res && res.unknown ? res.unknown : 0;
        state.size = res ? res.size : null;
        if (before == null) {
          state.from = res.from;
          state.to = res.to;
          append(items);
          scrollToBottom();
        } else {
          state.from = res.from;
          prepend(items);
        }
        state.atStart = state.from === 0;
        return res;
      } catch (err) {
        topNote.textContent = `could not load: ${err && err.message ? err.message : err}`;
        return null;
      } finally {
        if (generation === state.generation) {
          state.loading = false;
          updateTop();
          updateFooter();
        }
      }
    };

    const loadOlder = () => (state.from > 0 ? load(state.from) : null);
    olderButton.addEventListener('click', loadOlder);
    scroll.addEventListener('scroll', () => {
      if (scroll.scrollTop < TOP_THRESHOLD && state.from > 0) loadOlder();
    });

    const clear = () => {
      state.generation++;
      state.loading = false;
      list.textContent = '';
      firstAssistant = null;
      lastAssistant = null;
      state.from = null;
      state.to = null;
      state.unknown = 0;
      state.atStart = false;
      state.meta = {};
      renderer = createRenderer(doc, api, { onMeta: meta, expandAgent });
      updateTop();
      updateFooter();
    };

    const open = (sessionId) => {
      clear();
      state.sessionId = sessionId;
      return load(null);
    };

    const close = () => {
      clear();
      state.sessionId = null;
    };

    const onLive = (msg) => {
      if (!msg || msg.sessionId !== state.sessionId) return;
      const items = msg.items || msg.events || [];
      if (!items.length) return;
      if (state.from === null && state.loading) return;
      append(items);
      if (typeof msg.to === 'number') state.to = msg.to;
      state.unknown += items.filter((e) => e.kind === 'raw' && !e.truncated).length;
      updateFooter();
    };

    const onReset = (msg) => {
      if (!msg || msg.sessionId !== state.sessionId) return;
      open(state.sessionId);
    };

    const unsubscribe = [];
    if (api && typeof api.onEvents === 'function') unsubscribe.push(api.onEvents(onLive));
    if (api && typeof api.onReset === 'function') unsubscribe.push(api.onReset(onReset));

    return {
      open,
      close,
      loadOlder,
      state,
      element: rootEl,
      destroy() {
        close();
        for (const u of unsubscribe) if (typeof u === 'function') u();
        if (rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
      },
    };
  }

  return { mountChat, renderMarkdown, summarizeInput };
});
