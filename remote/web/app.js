import { createTerm } from './term.js';
import { Outbox, setupInput, newId } from './input.js';

const TOKEN_KEY = 'claude-remote.token';
const BACKOFF = [500, 1000, 2000, 4000, 8000, 10000];
const PING_MS = 20000;
const RETRY_MS = 1000;
const PERMANENT_LOCAL = new Set(['busy-dialog', 'empty', 'too-long', 'bad-request', 'read-only', 'not-found', 'bad-key']);

const $ = (id) => document.getElementById(id);
const host = typeof window.claudeRemoteHost === 'object' && window.claudeRemoteHost ? window.claudeRemoteHost : null;
const isTouch = () => window.matchMedia('(pointer: coarse)').matches;

const state = {
  device: null,
  defaultDir: '',
  sessions: [],
  current: null,
  tab: 'terminal',
  claim: false,
  sizeOwner: null,
  lastSeq: null,
  awaitingBody: false,
  chatUnmount: null,
  eventWaiters: [],
  eventsListeners: new Set(),
  resetListeners: new Set(),
  pendingAcks: new Map(),
};

function safeStorage(fn, fallback = null) {
  try {
    return fn(window.localStorage);
  } catch {
    return fallback;
  }
}

async function getToken() {
  if (host && typeof host.getToken === 'function') return (await host.getToken()) || null;
  return safeStorage((s) => s.getItem(TOKEN_KEY));
}

async function setToken(token) {
  if (host && typeof host.setToken === 'function') return host.setToken(token);
  return safeStorage((s) => (token ? s.setItem(TOKEN_KEY, token) : s.removeItem(TOKEN_KEY)));
}

function wsUrl() {
  if (host && typeof host.wsUrl === 'string' && host.wsUrl) return host.wsUrl;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'text') node.textContent = v;
    else if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

const ERROR_TEXT = {
  'busy-dialog': 'Claude shows a dialog: send a single line or use the keys.',
  'rate-limited': 'Slow down: too many inputs per second.',
  'read-only': 'This session runs outside the service. Take it over to steer it.',
  'not-found': 'Session not found.',
  'session-ended': 'The session ended.',
  'dir-not-allowed': 'That directory is outside the allowed roots.',
  'name-taken': 'A session with this name exists.',
  'bad-name': 'Name must look like cc-my-task (lowercase letters, digits, dashes).',
  'bad-resume-id': 'Resume id must be a session UUID.',
  'session-running': 'A running process holds this session. Use Take over.',
  busy: 'The session is working right now. Try again when it is idle.',
  changed: 'The process changed since you confirmed. Nothing was stopped.',
  'token-expired': 'Confirmation expired. Start again.',
  'still-running': 'The process did not exit in time. Nothing was started.',
  'unknown-code': 'Unknown pairing code.',
  locked: 'Too many wrong codes. Pairing is locked for a while.',
  'too-many-pending': 'Too many pending pairings. Try again later.',
  unavailable: 'The chat view is not available on this server.',
};
const errorText = (code, fallback) => ERROR_TEXT[code] || fallback || `Error: ${code}`;

const conn = {
  ws: null,
  attempt: 0,
  timer: null,
  ping: null,
  open: false,
  authed: false,
  connect() {
    clearTimeout(this.timer);
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    setConn('connecting');
    let ws;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      return this.retry();
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.addEventListener('open', async () => {
      this.open = true;
      this.attempt = 0;
      this.send({ t: 'hello', token: (await getToken()) || undefined, clientId: clientId() });
      clearInterval(this.ping);
      this.ping = setInterval(() => this.send({ t: 'ping', ts: Date.now() }), PING_MS);
    });
    ws.addEventListener('message', (e) => (typeof e.data === 'string' ? onJson(e.data) : onBinary(e.data)));
    ws.addEventListener('close', (e) => {
      if (this.ws !== ws) return;
      this.open = false;
      this.authed = false;
      clearInterval(this.ping);
      if (e.code === 4001) {
        setToken(null);
        toast('This device was revoked.');
      }
      setConn('offline');
      this.retry();
    });
  },
  retry() {
    const base = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)];
    this.attempt++;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), base + Math.floor(Math.random() * base * 0.3));
  },
  send(msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  },
};

function clientId() {
  let id = safeStorage((s) => s.getItem('claude-remote.client'));
  if (!id) {
    id = newId('c');
    safeStorage((s) => s.setItem('claude-remote.client', id));
  }
  return id;
}

function setConn(kind) {
  const c = $('conn');
  c.className = `conn conn-${kind}`;
  $('conn-text').textContent = kind === 'online' ? 'live' : kind;
}

const outbox = new Outbox();
let term = null;
let input = null;

function show(view) {
  for (const v of ['pair', 'list', 'session']) $(`view-${v}`).hidden = v !== view;
  $('back').hidden = view !== 'session';
  $('open-settings').hidden = view === 'pair';
  document.body.dataset.view = view;
}

function currentItem() {
  if (!state.current) return null;
  return state.sessions.find((s) => (s.managed ? s.name === state.current : s.sessionId === state.current)) || null;
}

const keyOf = (s) => (s.managed ? s.name : s.sessionId);
const labelOf = (s) => s.title || s.name || (s.sessionId ? s.sessionId.slice(0, 8) : 'session');

function timeAgo(iso) {
  if (!iso) return '';
  const min = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(min)) return '';
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ago`;
  return new Date(iso).toLocaleDateString();
}

function basename(p) {
  return p ? String(p).split('/').filter(Boolean).pop() || '/' : '';
}

function pill(status) {
  const text = { busy: 'busy', idle: 'idle', waiting: 'waiting', none: 'no claude', unknown: 'unknown' }[status] || status;
  return el('span', { class: `pill pill-${status}`, text });
}

function renderList() {
  const list = $('session-list');
  list.replaceChildren();
  const items = [...state.sessions].sort((a, b) => Number(b.managed) - Number(a.managed) || String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
  $('session-empty').hidden = items.length > 0;
  for (const s of items) {
    const open = () => openSession(keyOf(s));
    const actions = [];
    if (!s.managed && s.pid) actions.push(el('button', { type: 'button', class: 'secondary', text: 'Take over', onclick: (e) => (e.stopPropagation(), prepareTakeover(s.pid)) }));
    const row = el('li', { class: 'session-row', tabindex: '0', onclick: open, onkeydown: (e) => e.key === 'Enter' && open() }, [
      el('div', { class: 'row-main' }, [
        el('div', { class: 'row-title' }, [el('span', { class: 'row-name', text: labelOf(s) }), pill(s.status)]),
        el('div', { class: 'row-meta' }, [
          el('span', { text: basename(s.cwd) }),
          el('span', { class: s.managed ? 'tag tag-managed' : 'tag tag-unmanaged', text: s.managed ? 'service' : 'outside' }),
          el('span', { text: timeAgo(s.lastActivity) }),
        ]),
      ]),
      el('div', { class: 'row-actions' }, actions),
    ]);
    list.append(row);
  }
}

function renderStatus() {
  const s = currentItem();
  const ind = $('status-indicator');
  const text = $('status-text');
  if (!s) {
    ind.className = 'status-indicator';
    text.textContent = 'session not running';
    return;
  }
  $('title').textContent = labelOf(s);
  ind.className = `status-indicator status-${s.status}`;
  ind.replaceChildren(s.status === 'busy' ? el('span', { class: 'spinner' }) : '');
  text.textContent = s.status === 'busy' ? 'working…' : s.status === 'waiting' ? `waiting for you${s.waitingFor ? `: ${s.waitingFor}` : ''}` : s.status === 'idle' ? 'idle' : 'no Claude process detected';
  const managed = Boolean(s.managed);
  $('tab-terminal').disabled = !managed;
  $('readonly-note').hidden = managed;
  $('input-bar').hidden = !managed;
  $('keybar').hidden = !managed;
  $('tab-chat').disabled = !s.sessionId;
}

function renderSize() {
  const info = $('size-info');
  info.textContent = state.sizeOwner ? `sized by ${state.sizeOwner.claimedBy} (${state.sizeOwner.cols}×${state.sizeOwner.rows})` : '';
  $('fit-toggle').setAttribute('aria-pressed', String(state.claim));
}

function openSession(key) {
  if (state.current && state.current !== key) closeSession();
  state.current = key;
  const s = currentItem();
  show('session');
  state.tab = s && s.managed ? state.tab : 'chat';
  if (s && !s.managed) setTab('chat');
  else setTab(state.tab);
  renderStatus();
  subscribe();
}

function closeSession() {
  if (!state.current) return;
  const s = currentItem();
  conn.send({ t: 'unsub', sessionId: state.current });
  if (s && s.sessionId && s.sessionId !== state.current) conn.send({ t: 'unsub', sessionId: s.sessionId });
  unmountChat();
  state.current = null;
  state.claim = false;
  state.sizeOwner = null;
  state.lastSeq = null;
  renderSize();
  $('title').textContent = 'Claude Remote';
}

function subscribe() {
  const s = currentItem();
  if (!s || !conn.authed) return;
  if (s.managed && state.tab === 'terminal') {
    if (!term) term = createTerm($('term'));
    state.lastSeq = null;
    conn.send({ t: 'sub', sessionId: s.name, cols: 0, rows: 0 });
    if (state.claim) claimSize();
  }
  if (state.tab === 'chat') mountChat();
}

function setTab(tab) {
  state.tab = tab;
  $('tab-terminal').setAttribute('aria-selected', String(tab === 'terminal'));
  $('tab-chat').setAttribute('aria-selected', String(tab === 'chat'));
  $('term-pane').hidden = tab !== 'terminal';
  $('term-tools').hidden = tab !== 'terminal';
  $('chat-pane').hidden = tab !== 'chat';
  if (tab === 'terminal' && term) requestAnimationFrame(() => term.rescale());
}

function claimSize() {
  const s = currentItem();
  if (!s || !term) return;
  const { cols, rows } = term.proposeSize();
  conn.send({ t: 'claimSize', sessionId: s.name, cols, rows });
}

function onBinary(buf) {
  const view = new DataView(buf);
  if (view.getUint8(0) !== 1) return;
  const len = view.getUint16(1);
  const name = new TextDecoder().decode(new Uint8Array(buf, 3, len));
  const seq = view.getUint32(3 + len);
  const bytes = new Uint8Array(buf, 7 + len);
  if (name !== state.current || !term) return;
  if (state.awaitingBody) {
    const snap = state.awaitingBody;
    state.awaitingBody = false;
    state.lastSeq = seq;
    term.reset(snap.cols, snap.rows, bytes);
    return;
  }
  if (state.lastSeq === null) return;
  if (seq !== ((state.lastSeq + 1) >>> 0)) {
    state.lastSeq = null;
    conn.send({ t: 'sub', sessionId: name, cols: 0, rows: 0 });
    return;
  }
  state.lastSeq = seq;
  term.write(bytes);
}

function onJson(data) {
  let m;
  try {
    m = JSON.parse(data);
  } catch {
    return;
  }
  switch (m.t) {
    case 'pairRequired':
      conn.authed = false;
      setToken(null);
      setConn('online');
      return showPair();
    case 'pairCode':
      $('pair-form').hidden = true;
      $('pair-wait').hidden = false;
      $('pair-code').textContent = m.code;
      return undefined;
    case 'paired':
      setToken(m.token);
      return undefined;
    case 'helloOk':
      conn.authed = true;
      state.device = m.device;
      state.defaultDir = m.defaultDir || '';
      setConn('online');
      if (state.current) {
        show('session');
        subscribe();
      } else show('list');
      flushOutbox();
      return undefined;
    case 'sessions':
      state.sessions = Array.isArray(m.items) ? m.items : [];
      renderList();
      if (state.current) renderStatus();
      return undefined;
    case 'status': {
      for (const s of state.sessions) if (keyOf(s) === m.sessionId || s.sessionId === m.sessionId) Object.assign(s, { status: m.status, waitingFor: m.waitingFor });
      renderList();
      if (state.current) renderStatus();
      return undefined;
    }
    case 'snapshot':
      if (m.sessionId === state.current) state.awaitingBody = m;
      return undefined;
    case 'size':
      if (m.sessionId !== state.current) return undefined;
      state.sizeOwner = m.claimedBy ? m : null;
      if (state.claim && m.claimedBy !== (state.device && state.device.name)) state.claim = false;
      return renderSize();
    case 'ack':
      return onAck(m);
    case 'events': {
      const i = state.eventWaiters.findIndex((w) => w.sessionId === m.sessionId);
      if (i >= 0) state.eventWaiters.splice(i, 1)[0].resolve(m);
      return undefined;
    }
    case 'eventsLive':
      for (const fn of state.eventsListeners) fn(m.items, m);
      return undefined;
    case 'reset':
      for (const fn of state.resetListeners) fn(m);
      return undefined;
    case 'takeoverInfo':
      return showTakeoverSheet(m);
    case 'devices':
      return renderDevices(m.items || []);
    case 'error':
      if (m.ref === 'events' || m.ref === 'subEvents') {
        const i = state.eventWaiters.findIndex(() => true);
        if (i >= 0) state.eventWaiters.splice(i, 1)[0].reject(new Error(m.code));
      }
      if (m.ref === 'pair') {
        $('pair-form').hidden = false;
        $('pair-wait').hidden = true;
      }
      if (m.code === 'unauthorized') return undefined;
      return toast(errorText(m.code, m.msg));
    default:
      return undefined;
  }
}

function onAck(m) {
  const waiter = state.pendingAcks.get(m.id);
  if (waiter) {
    state.pendingAcks.delete(m.id);
    waiter(m);
    return;
  }
  const item = outbox.pending().find((i) => i.id === m.id);
  if (!item) {
    if (!m.ok) toast(errorText(m.error));
    return;
  }
  if (m.ok) {
    outbox.remove(m.id);
    return;
  }
  if (m.error === 'rate-limited') {
    setTimeout(() => conn.send({ t: 'send', id: item.id, sessionId: item.sessionId, text: item.text }), RETRY_MS);
    return;
  }
  outbox.remove(m.id);
  if (m.error !== 'busy-dialog') toast(errorText(m.error));
  if (PERMANENT_LOCAL.has(m.error) && input) input.restore(item.text);
}

function flushOutbox() {
  for (const item of outbox.pending()) conn.send({ t: 'send', id: item.id, sessionId: item.sessionId, text: item.text });
}

function request(msg) {
  return new Promise((resolve) => {
    state.pendingAcks.set(msg.id, resolve);
    if (!conn.send(msg)) {
      state.pendingAcks.delete(msg.id);
      resolve({ ok: false, error: 'offline' });
    }
  });
}

function submitText(text) {
  const s = currentItem();
  if (!s || !s.managed) return false;
  const item = outbox.add(s.name, text);
  if (!item) {
    toast('Outbox is full; wait for the connection.');
    return false;
  }
  if (conn.authed) conn.send({ t: 'send', id: item.id, sessionId: item.sessionId, text: item.text });
  else toast('Offline: the message is queued and sent on reconnect.');
  return true;
}

function sendKey(key) {
  const s = currentItem();
  if (!s || !s.managed) return;
  if (!conn.authed) return toast('Offline: keys are not queued.');
  return conn.send({ t: 'key', id: newId('k'), sessionId: s.name, key });
}

async function mountChat() {
  const s = currentItem();
  if (!s || !s.sessionId || state.chatUnmount) return;
  const pane = $('chat-pane');
  let mod = null;
  try {
    mod = await import('./chat.js');
  } catch {
    mod = null;
  }
  if (!mod || typeof mod.mountChat !== 'function') {
    pane.replaceChildren(el('p', { class: 'muted pane-pad', text: 'The chat view is not available in this build.' }));
    state.chatUnmount = () => pane.replaceChildren();
    return;
  }
  const sessionId = s.sessionId;
  const api = {
    sessionId,
    requestEvents(id, { before, limit } = {}) {
      return new Promise((resolve, reject) => {
        state.eventWaiters.push({ sessionId: id, resolve, reject });
        if (!conn.send({ t: 'events', sessionId: id, before, limit })) reject(new Error('offline'));
      });
    },
    onEvents(cb) {
      state.eventsListeners.add(cb);
    },
    onReset(cb) {
      state.resetListeners.add(cb);
    },
  };
  pane.replaceChildren();
  const r = mod.mountChat(pane, api);
  conn.send({ t: 'subEvents', sessionId });
  state.chatUnmount = () => {
    if (typeof r === 'function') r();
    else if (r && typeof r.destroy === 'function') r.destroy();
    state.eventsListeners.clear();
    state.resetListeners.clear();
    conn.send({ t: 'unsub', sessionId });
    pane.replaceChildren();
  };
}

function unmountChat() {
  if (state.chatUnmount) state.chatUnmount();
  state.chatUnmount = null;
}

function openSheet(title, body) {
  const sheet = $('sheet');
  sheet.replaceChildren(el('div', { class: 'sheet-head' }, [el('h2', { text: title }), el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', text: '×', onclick: closeSheet })]), body);
  sheet.hidden = false;
  $('sheet-backdrop').hidden = false;
}

function closeSheet() {
  $('sheet').hidden = true;
  $('sheet-backdrop').hidden = true;
  $('sheet').replaceChildren();
}

function field(label, input) {
  return el('label', { class: 'field' }, [el('span', { text: label }), input]);
}

function showNewSession() {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, '0')).join('');
  const name = el('input', { value: `cc-${rand}`, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', pattern: 'cc-[a-z0-9-]{1,40}', required: true });
  const dir = el('input', { value: state.defaultDir, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const resume = el('input', { placeholder: 'optional session UUID', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const form = el('form', { class: 'stack' }, [field('Name', name), field('Directory', dir), field('Resume session', resume), el('button', { type: 'submit', class: 'primary', text: 'Start' })]);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ack = await request({ t: 'new', id: newId('n'), name: name.value.trim(), dir: dir.value.trim(), resumeId: resume.value.trim() || undefined });
    if (!ack.ok) return toast(errorText(ack.error));
    closeSheet();
    conn.send({ t: 'list' });
    openSession(ack.name || name.value.trim());
    return undefined;
  });
  openSheet('New session', form);
}

function prepareTakeover(pid) {
  if (!conn.send({ t: 'takeoverPrepare', pid })) toast('Offline.');
}

function showTakeoverSheet(info) {
  const rows = [
    ['Session', info.title || info.sessionId],
    ['Process id', String(info.pid)],
    ['Terminal', info.tty || '—'],
    ['Directory', info.cwd || '—'],
    ['Account slot', info.slot || '—'],
    ['New name', info.name],
  ];
  const dl = el('dl', { class: 'facts' }, rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
  const confirm = el('button', { type: 'button', class: 'danger', text: 'Stop it and resume here' });
  confirm.addEventListener('click', async () => {
    confirm.disabled = true;
    const ack = await request({ t: 'takeover', id: newId('t'), token: info.token });
    if (!ack.ok) {
      confirm.disabled = false;
      return toast(errorText(ack.error));
    }
    closeSheet();
    conn.send({ t: 'list' });
    openSession(ack.name || info.name);
    return undefined;
  });
  const body = el('div', { class: 'stack' }, [el('p', { class: 'muted', text: 'The running process gets SIGTERM, then the session resumes under the service with the same id. Unsent input in its terminal is lost.' }), dl, confirm]);
  openSheet('Take over this session?', body);
}

function showSettings() {
  const list = el('ul', { id: 'device-list', class: 'device-list' });
  const code = el('input', { inputmode: 'numeric', pattern: '\\d{6}', maxlength: '6', placeholder: '6-digit code', autocomplete: 'one-time-code' });
  const approve = el('form', { class: 'row-form' }, [code, el('button', { type: 'submit', class: 'primary', text: 'Approve' })]);
  approve.addEventListener('submit', (e) => {
    e.preventDefault();
    if (/^\d{6}$/.test(code.value)) conn.send({ t: 'approvePair', code: code.value });
    code.value = '';
  });
  const body = el('div', { class: 'stack' }, [
    el('p', { class: 'muted', text: state.device ? `This device: ${state.device.name}` : '' }),
    el('h3', { text: 'Approve a new device' }),
    approve,
    el('h3', { text: 'Paired devices' }),
    list,
  ]);
  openSheet('Settings', body);
  conn.send({ t: 'devices' });
}

function renderDevices(items) {
  const list = $('device-list');
  if (!list) return;
  list.replaceChildren(
    ...items.map((d) => {
      const self = state.device && d.id === state.device.id;
      const revoke = el('button', { type: 'button', class: 'secondary', text: self ? 'Revoke (this device)' : 'Revoke' });
      revoke.addEventListener('click', () => {
        if (revoke.dataset.armed) return conn.send({ t: 'revoke', deviceId: d.id });
        revoke.dataset.armed = '1';
        revoke.textContent = 'Tap again to revoke';
        return undefined;
      });
      return el('li', { class: 'device-row' }, [el('div', {}, [el('div', { text: d.name }), el('div', { class: 'muted small', text: `last seen ${timeAgo(d.lastSeen)}` })]), revoke]);
    }),
  );
}

function showPair() {
  show('pair');
  $('pair-form').hidden = false;
  $('pair-wait').hidden = true;
  const name = $('device-name');
  if (!name.value) name.value = /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android phone' : host ? 'VS Code' : 'Browser';
}

function setupViewport() {
  const root = document.documentElement;
  const vv = window.visualViewport;
  if (!vv) return;
  const update = () => {
    root.style.setProperty('--vvh', `${vv.height}px`);
    root.style.setProperty('--vv-top', `${vv.offsetTop}px`);
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}

function init() {
  setupViewport();
  input = setupInput({ form: $('input-bar'), textarea: $('input'), badge: $('outbox-badge'), keybar: $('keybar'), outbox, isTouch, onSubmit: submitText, onKey: sendKey });
  $('back').addEventListener('click', () => {
    closeSession();
    show('list');
  });
  $('open-settings').addEventListener('click', showSettings);
  $('new-session').addEventListener('click', showNewSession);
  $('sheet-backdrop').addEventListener('click', closeSheet);
  $('tab-terminal').addEventListener('click', () => {
    unmountChat();
    setTab('terminal');
    subscribe();
  });
  $('tab-chat').addEventListener('click', () => {
    setTab('chat');
    mountChat();
  });
  $('fit-toggle').addEventListener('click', () => {
    const s = currentItem();
    if (!s || !s.managed) return;
    state.claim = !state.claim;
    if (state.claim) claimSize();
    else conn.send({ t: 'releaseSize', sessionId: s.name });
    renderSize();
  });
  $('scroll-lock').addEventListener('click', (e) => {
    const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
    e.currentTarget.setAttribute('aria-pressed', String(on));
    if (term) term.setScrollLock(on);
  });
  $('pair-form').addEventListener('submit', (e) => {
    e.preventDefault();
    conn.send({ t: 'pair', deviceName: $('device-name').value.trim() || 'device' });
  });
  window.addEventListener('online', () => conn.connect());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') conn.connect();
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => state.claim && claimSize(), 300);
  });
  show('list');
  conn.connect();
}

init();
