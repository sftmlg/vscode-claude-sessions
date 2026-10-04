const OUTBOX_KEY = 'claude-remote.outbox';
export const OUTBOX_MAX_ITEMS = 50;
export const OUTBOX_MAX_BYTES = 256 * 1024;

export function newId(prefix = 'm') {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export class Outbox {
  constructor(store = storage()) {
    this.store = store;
    this.items = [];
    this.listeners = new Set();
    try {
      const raw = this.store && this.store.getItem(OUTBOX_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) this.items = parsed.filter((i) => i && typeof i.id === 'string' && typeof i.text === 'string' && typeof i.sessionId === 'string');
    } catch {}
  }

  bytes(items = this.items) {
    return new TextEncoder().encode(JSON.stringify(items)).length;
  }

  save() {
    if (this.store) {
      for (;;) {
        try {
          if (this.items.length) this.store.setItem(OUTBOX_KEY, JSON.stringify(this.items));
          else this.store.removeItem(OUTBOX_KEY);
          break;
        } catch {
          if (!evictOldestDraft(this.store)) break;
        }
      }
    }
    for (const fn of this.listeners) fn(this.items);
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  add(sessionId, text, host = 'self') {
    const item = { id: newId('m'), sessionId, text, host, at: Date.now() };
    const next = [...this.items, item];
    if (next.length > OUTBOX_MAX_ITEMS || this.bytes(next) > OUTBOX_MAX_BYTES) return null;
    this.items = next;
    this.save();
    return item;
  }

  remove(id) {
    const item = this.items.find((i) => i.id === id);
    if (!item) return null;
    this.items = this.items.filter((i) => i.id !== id);
    this.save();
    return item;
  }

  pending(host) {
    return host === undefined ? this.items.slice() : this.items.filter((i) => (i.host || 'self') === host);
  }
}

const FOLD = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };
const foldChar = (c) => {
  const lower = c.toLowerCase();
  return FOLD[lower] || lower.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
};

function foldWithMap(text) {
  let folded = '';
  const origin = [];
  for (let i = 0; i < text.length; i++) {
    const f = foldChar(text[i]);
    folded += f;
    for (let k = 0; k < f.length; k++) origin.push(i);
  }
  return { folded, origin };
}

export function highlightParts(text, query) {
  const src = String(text || '');
  if (!src) return [];
  const { folded, origin } = foldWithMap(src);
  const mask = new Array(src.length).fill(false);
  for (const term of String(query || '').split(/\s+/).filter(Boolean).map((t) => foldWithMap(t).folded)) {
    if (!term) continue;
    for (let at = folded.indexOf(term); at >= 0; at = folded.indexOf(term, at + term.length)) {
      for (let k = at; k < at + term.length; k++) mask[origin[k]] = true;
    }
  }
  const parts = [];
  for (let i = 0; i < src.length; i++) {
    const last = parts[parts.length - 1];
    if (last && last.hit === mask[i]) last.text += src[i];
    else parts.push({ text: src[i], hit: mask[i] });
  }
  return parts;
}

const LATER = { 'rate-limited': 1, working: 4 };

export class OutboxSender {
  constructor({ outbox, send, isReady, host = 'self', retryMs = 1000, setTimer = (fn, ms) => setTimeout(fn, ms) }) {
    Object.assign(this, { outbox, send, isReady, host, retryMs, setTimer });
    this.inflight = null;
    this.waiting = false;
  }

  reset() {
    this.inflight = null;
    this.waiting = false;
  }

  pump() {
    if (this.inflight || this.waiting || !this.isReady()) return;
    const next = this.outbox.pending(this.host)[0];
    if (!next) return;
    if (this.send({ t: 'send', id: next.id, sessionId: next.sessionId, text: next.text })) this.inflight = next.id;
  }

  onAck(m) {
    const item = this.outbox.pending(this.host).find((i) => i.id === m.id);
    if (!item) return { handled: false };
    if (this.inflight === m.id) this.inflight = null;
    const later = LATER[m.error];
    if (!m.ok && later) {
      this.waiting = true;
      this.setTimer(() => {
        this.waiting = false;
        this.pump();
      }, this.retryMs * later);
      return { handled: true, later: m.error, first: !item.deferred && (item.deferred = true) };
    }
    this.outbox.remove(m.id);
    this.pump();
    return m.ok ? { handled: true } : { handled: true, item, error: m.error };
  }
}

const DRAFT_PREFIX = 'claude-remote.draft:';
export const DRAFT_MAX_BYTES = 20 * 1024;

function capBytes(text, max) {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= max) return text;
  let out = text.slice(0, max);
  while (enc.encode(out).length > max) out = out.slice(0, -1);
  return out;
}

export const DRAFTS_MAX_TOTAL = 1024 * 1024;
const DRAFT_INDEX = 'claude-remote.drafts';

function readIndex(store) {
  try {
    const list = JSON.parse((store && store.getItem(DRAFT_INDEX)) || '[]');
    return Array.isArray(list) ? list.filter((e) => Array.isArray(e) && typeof e[0] === 'string') : [];
  } catch {
    return [];
  }
}

function writeIndex(store, list) {
  try {
    store.setItem(DRAFT_INDEX, JSON.stringify(list));
  } catch {}
}

export function evictOldestDraft(store) {
  const list = readIndex(store);
  const oldest = list.shift();
  if (!oldest) return false;
  try {
    store.removeItem(oldest[0]);
  } catch {}
  writeIndex(store, list);
  return true;
}

export class DraftStore {
  constructor(store = storage()) {
    this.store = store;
  }

  key(host, session) {
    return `${DRAFT_PREFIX}${host}:${session}`;
  }

  load(host, session) {
    try {
      return (this.store && this.store.getItem(this.key(host, session))) || '';
    } catch {
      return '';
    }
  }

  save(host, session, text) {
    if (!this.store) return;
    const key = this.key(host, session);
    const list = readIndex(this.store).filter((e) => e[0] !== key);
    if (!text) {
      try {
        this.store.removeItem(key);
      } catch {}
      writeIndex(this.store, list);
      return;
    }
    const value = capBytes(text, DRAFT_MAX_BYTES);
    list.push([key, new TextEncoder().encode(value).length]);
    let total = list.reduce((n, e) => n + e[1], 0);
    while (total > DRAFTS_MAX_TOTAL && list.length > 1) {
      const old = list.shift();
      total -= old[1];
      try {
        this.store.removeItem(old[0]);
      } catch {}
    }
    writeIndex(this.store, list);
    for (;;) {
      try {
        this.store.setItem(key, value);
        return;
      } catch {
        if (!evictOldestDraft(this.store)) return;
      }
    }
  }

  clear(host, session) {
    this.save(host, session, '');
  }
}

export function setupInput({ form, textarea, badge, keybar, outbox, isTouch, onSubmit, onKey, onChange = () => {} }) {
  const grow = () => {
    textarea.style.height = 'auto';
    const max = Math.max(80, Math.floor(window.innerHeight * 0.4));
    textarea.style.height = `${Math.min(textarea.scrollHeight, max)}px`;
  };
  textarea.addEventListener('input', () => {
    grow();
    onChange(textarea.value);
  });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  if (!isTouch()) textarea.placeholder = 'Message Claude… (⌘/Ctrl+Enter sends)';
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  function submit() {
    const text = textarea.value;
    if (!text.trim()) return;
    if (onSubmit(text) !== false) {
      textarea.value = '';
      grow();
    }
  }
  keybar.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-key]');
    if (btn) onKey(btn.dataset.key);
  });
  keybar.addEventListener('mousedown', (e) => e.preventDefault());
  const render = (items) => {
    badge.hidden = !items.length;
    badge.textContent = items.length ? `${items.length} queued` : '';
    badge.title = 'Queued messages go out once, in order, as soon as the connection is back';
  };
  outbox.onChange(render);
  render(outbox.pending());
  return {
    restore(text) {
      if (!textarea.value.trim()) {
        textarea.value = text;
        grow();
      }
    },
    focus: () => textarea.focus(),
    setText(text) {
      textarea.value = text || '';
      grow();
    },
    fill(text) {
      textarea.value = text;
      grow();
      onChange(textarea.value);
      textarea.focus();
    },
    isEmpty: () => !textarea.value.trim(),
  };
}
