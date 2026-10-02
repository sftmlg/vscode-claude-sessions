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
    try {
      if (this.store) {
        if (this.items.length) this.store.setItem(OUTBOX_KEY, JSON.stringify(this.items));
        else this.store.removeItem(OUTBOX_KEY);
      }
    } catch {}
    for (const fn of this.listeners) fn(this.items);
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  add(sessionId, text) {
    const item = { id: newId('m'), sessionId, text, at: Date.now() };
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

  pending() {
    return this.items.slice();
  }
}

export class OutboxSender {
  constructor({ outbox, send, isReady, retryMs = 1000, setTimer = (fn, ms) => setTimeout(fn, ms) }) {
    Object.assign(this, { outbox, send, isReady, retryMs, setTimer });
    this.inflight = null;
    this.waiting = false;
  }

  reset() {
    this.inflight = null;
    this.waiting = false;
  }

  pump() {
    if (this.inflight || this.waiting || !this.isReady()) return;
    const next = this.outbox.pending()[0];
    if (!next) return;
    if (this.send({ t: 'send', id: next.id, sessionId: next.sessionId, text: next.text })) this.inflight = next.id;
  }

  onAck(m) {
    const item = this.outbox.pending().find((i) => i.id === m.id);
    if (!item) return { handled: false };
    if (this.inflight === m.id) this.inflight = null;
    if (!m.ok && m.error === 'rate-limited') {
      this.waiting = true;
      this.setTimer(() => {
        this.waiting = false;
        this.pump();
      }, this.retryMs);
      return { handled: true };
    }
    this.outbox.remove(m.id);
    this.pump();
    return m.ok ? { handled: true } : { handled: true, item, error: m.error };
  }
}

export function setupInput({ form, textarea, badge, keybar, outbox, isTouch, onSubmit, onKey }) {
  const grow = () => {
    textarea.style.height = 'auto';
    const max = Math.max(80, Math.floor(window.innerHeight * 0.4));
    textarea.style.height = `${Math.min(textarea.scrollHeight, max)}px`;
  };
  textarea.addEventListener('input', grow);
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
    badge.textContent = items.length ? String(items.length) : '';
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
  };
}
