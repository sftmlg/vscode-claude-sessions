import { createTerm } from './term.js';
import { Outbox, OutboxSender, setupInput, newId, highlightParts } from './input.js';
import { inboxSections } from './inbox.js';

const TOKEN_KEY = 'claude-remote.token';
const ACTIVE_HOST_KEY = 'claude-remote.host';
const PEERS_KEY = 'claude-remote.peers';
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
  reclaim: false,
  fitOptOut: false,
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

function socketOrigin(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return String(url);
  }
}

async function getToken(c) {
  try {
    if (host && typeof host.getToken === 'function') return (await host.getToken(c.origin)) || null;
    const own = safeStorage((s) => s.getItem(`${TOKEN_KEY}:${c.origin}`));
    return own || (c.id === 'self' ? safeStorage((s) => s.getItem(TOKEN_KEY)) : null);
  } catch {
    return null;
  }
}

async function setToken(c, token) {
  if (host && typeof host.setToken === 'function') return host.setToken(token, c.origin);
  return safeStorage((s) => {
    if (c.id === 'self') s.removeItem(TOKEN_KEY);
    return token ? s.setItem(`${TOKEN_KEY}:${c.origin}`, token) : s.removeItem(`${TOKEN_KEY}:${c.origin}`);
  });
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
  'still-running': 'The process did not exit. Nothing was started.',
  'force-not-allowed': 'Force is only possible after the process ignored the stop request.',
  'unknown-code': 'Unknown pairing code.',
  locked: 'Too many wrong codes. Pairing is locked for a while.',
  'too-many-pending': 'Too many pending pairings. Try again later.',
  unavailable: 'The chat view is not available on this server.',
};
const errorText = (code, fallback) => ERROR_TEXT[code] || fallback || `Error: ${code}`;

const hosts = [];
let conn = null;

function makeConn({ id, label, url }) {
  const c = {
    id,
    label,
    url,
    origin: socketOrigin(url),
    ws: null,
    attempt: 0,
    timer: null,
    ping: null,
    open: false,
    authed: false,
    connState: 'connecting',
    sessions: [],
    device: null,
    health: null,
    needsPair: false,
    connect() {
      clearTimeout(this.timer);
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
      this.setState('connecting');
      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch {
        return this.retry();
      }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.addEventListener('open', async () => {
        this.open = true;
        this.attempt = 0;
        const token = await getToken(this);
        this.sentToken = Boolean(token);
        this.send({ t: 'hello', token: token || undefined, clientId: clientId() });
        clearInterval(this.ping);
        this.ping = setInterval(() => this.send({ t: 'ping', ts: Date.now() }), PING_MS);
      });
      ws.addEventListener('message', (e) => {
        if (this !== conn) return onBackground(this, e.data);
        return typeof e.data === 'string' ? onJson(e.data) : onBinary(e.data);
      });
      ws.addEventListener('close', (e) => {
        if (this.ws !== ws) return;
        this.open = false;
        this.authed = false;
        clearInterval(this.ping);
        this.sender.reset();
        if (this === conn) {
          for (const w of state.eventWaiters.splice(0)) w.reject(new Error('offline'));
          unmountChat();
          state.subscribedKey = null;
        }
        if (e.code === 4001) {
          setToken(this, null);
          if (this === conn) toast('This device was revoked.');
        }
        this.setState('offline');
        if (this.closed) return;
        if (e.code === 4009 && document.visibilityState === 'hidden') {
          this.parked = true;
          return;
        }
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
    setState(kind) {
      this.connState = kind;
      if (this === conn) setConn(kind);
      renderHostTabs();
    },
    close() {
      this.closed = true;
      clearTimeout(this.timer);
      clearInterval(this.ping);
      if (this.ws) this.ws.close();
    },
  };
  c.sender = new OutboxSender({ outbox, host: id, send: (m) => c.send(m), isReady: () => c.authed, retryMs: RETRY_MS });
  return c;
}

function selfLabel() {
  if (!host) return 'This Mac';
  try {
    return new URL(wsUrl()).hostname.split('.')[0] || 'This Mac';
  } catch {
    return 'This Mac';
  }
}

function setPeers(peers) {
  const list = (Array.isArray(peers) ? peers : []).filter((p) => p && typeof p.url === 'string' && typeof p.name === 'string' && socketOrigin(p.url) !== hosts[0].origin);
  safeStorage((s) => s.setItem(PEERS_KEY, JSON.stringify(list)));
  for (const h of hosts.slice(1)) {
    if (!list.some((p) => p.url === h.url)) {
      h.close();
      hosts.splice(hosts.indexOf(h), 1);
      if (h === conn) switchHost(hosts[0]);
    }
  }
  for (const p of list) {
    const known = hosts.find((h) => h.url === p.url);
    if (known) known.label = p.name;
    else {
      const c = makeConn({ id: p.url, label: p.name, url: p.url });
      hosts.push(c);
      c.connect();
    }
  }
  renderHostTabs();
  const wanted = safeStorage((s) => s.getItem(ACTIVE_HOST_KEY));
  const target = hosts.find((h) => h.id === wanted);
  if (target && target !== conn && !state.current) switchHost(target);
}

function waitingCount(c) {
  return (c.sessions || []).filter((s) => s.status === 'waiting').length;
}

function renderHostTabs() {
  const nav = $('host-tabs');
  if (!nav) return;
  nav.hidden = hosts.length < 2;
  nav.replaceChildren(
    ...hosts.map((c) => {
      const waiting = waitingCount(c);
      const title = `${c.label}: ${c.connState === 'online' ? 'connected' : c.connState}${waiting ? `, ${waiting} waiting for you` : ''}`;
      return el('button', { type: 'button', role: 'tab', class: 'host-tab', 'aria-selected': String(c === conn), title, onclick: () => switchHost(c) }, [
        el('span', { class: `dot dot-${c.connState}` }),
        el('span', { text: c.label }),
        waiting ? el('span', { class: 'host-count', text: String(waiting), 'aria-label': `${waiting} waiting` }) : null,
      ]);
    }),
  );
}

function switchHost(c) {
  if (!c || c === conn) return;
  closeSession();
  clearSearch();
  conn = c;
  safeStorage((s) => s.setItem(ACTIVE_HOST_KEY, c.id));
  state.sessions = c.sessions || [];
  state.device = c.device;
  setConn(c.connState);
  renderHealth(c.health);
  c.connect();
  if (c.needsPair) showPair();
  else show('list');
  renderList();
  renderHostTabs();
}

function onBackground(c, data) {
  if (typeof data !== 'string') return;
  let m;
  try {
    m = JSON.parse(data);
  } catch {
    return;
  }
  if (m.t === 'helloOk') {
    c.authed = true;
    c.needsPair = false;
    c.device = m.device;
    c.health = m.health || null;
    c.setState('online');
    c.sender.reset();
    c.sender.pump();
  } else if (m.t === 'pairRequired') {
    c.authed = false;
    if (c.sentToken) setToken(c, null);
    c.needsPair = true;
    c.setState('online');
    if (m.autoPair && !c.autoPairTried) {
      c.autoPairTried = true;
      c.send({ t: 'pair', deviceName: defaultDeviceName() });
    }
  } else if (m.t === 'paired') {
    setToken(c, m.token);
  } else if (m.t === 'sessions') {
    c.sessions = Array.isArray(m.items) ? m.items : [];
  } else if (m.t === 'status') {
    for (const s of c.sessions) if (keyOf(s) === m.sessionId || s.sessionId === m.sessionId) Object.assign(s, { status: m.status, waitingFor: m.waitingFor });
  } else if (m.t === 'health') {
    c.health = m;
  } else if (m.t === 'ack') {
    c.sender.onAck(m);
  }
  renderHostTabs();
}

function clientId() {
  let id = safeStorage((s) => s.getItem('claude-remote.client'));
  if (!id) {
    id = newId('c');
    safeStorage((s) => s.setItem('claude-remote.client', id));
  }
  return id;
}

function folderBlockedText(health) {
  const access = health && health.folderAccess;
  if (!access || (access.desktop !== 'blocked' && access.documents !== 'blocked')) return '';
  return `The Mac running the service has not granted file access to node. On that Mac: System Settings › Privacy & Security › Full Disk Access › add ${health.nodePath || 'the node binary'} — sessions touching Desktop/Documents hang until then.`;
}

function renderHealth(health) {
  const banner = $('health-banner');
  const text = folderBlockedText(health);
  banner.textContent = text;
  banner.hidden = !text;
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
const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_LIMIT = 30;
const search = { query: '', id: null, timer: null };

function badge(kind) {
  if (kind === 'service') return el('span', { class: 'tag tag-managed', text: 'remote', title: 'Runs in the service. Steerable here.' });
  if (kind === 'terminal') return el('span', { class: 'tag tag-unmanaged', text: 'in a terminal · read-only', title: 'Runs in a terminal tab on the Mac. Take it over to steer it here.' });
  return el('span', { class: 'tag tag-past', text: 'not running', title: 'A past session. Resume it here to continue.' });
}

function onSearchInput() {
  const query = $('session-search').value.trim();
  clearTimeout(search.timer);
  search.query = query;
  if (!query) {
    search.id = null;
    $('search-results').hidden = true;
    $('session-list').hidden = false;
    renderList();
    return;
  }
  search.timer = setTimeout(() => runSearch(query), SEARCH_DEBOUNCE_MS);
}

function runSearch(query) {
  const id = newId('q');
  search.id = id;
  if (!conn.send({ t: 'search', id, query, limit: SEARCH_LIMIT })) toast('Offline: search needs the connection.');
}

function clearSearch() {
  $('session-search').value = '';
  onSearchInput();
}

function renderSearch(items) {
  const list = $('search-results');
  list.hidden = false;
  $('session-list').hidden = true;
  $('session-empty').hidden = true;
  list.replaceChildren();
  if (!items.length) list.append(el('li', { class: 'muted pane-pad', text: 'No session matches every word.' }));
  for (const hit of items) {
    const actions = [];
    if (hit.running === 'terminal' && hit.pid) actions.push(el('button', { type: 'button', class: 'secondary', text: 'Take over', onclick: (e) => (e.stopPropagation(), prepareTakeover(hit.pid)) }));
    const open = () => openHit(hit);
    const snippet = el('div', { class: 'row-snippet' }, highlightParts(hit.snippet, search.query).map((p) => (p.hit ? el('mark', { class: 'hit', text: p.text }) : document.createTextNode(p.text))));
    list.append(
      el('li', { class: 'session-row', tabindex: '0', onclick: open, onkeydown: (e) => e.key === 'Enter' && open() }, [
        el('div', { class: 'row-main' }, [
          el('div', { class: 'row-title' }, [el('span', { class: 'row-name', text: hit.title || hit.sessionId.slice(0, 8) }), badge(hit.running)]),
          el('div', { class: 'row-meta' }, [el('span', { text: hit.project || basename(hit.cwd) }), el('span', { text: timeAgo(hit.lastActivity) })]),
          hit.snippet ? snippet : null,
        ]),
        el('div', { class: 'row-actions' }, actions),
      ]),
    );
  }
}

function openHit(hit) {
  if (hit.running === 'service' && hit.name) return openSession(hit.name);
  if (hit.running === 'terminal') return openSession(hit.sessionId);
  return showResumeSheet(hit);
}

function showResumeSheet(hit) {
  const rows = [
    ['Session', hit.title || hit.sessionId],
    ['Project', hit.project || basename(hit.cwd) || '—'],
    ['Last activity', timeAgo(hit.lastActivity) || '—'],
  ];
  const dl = el('dl', { class: 'facts' }, rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
  const go = el('button', { type: 'button', class: 'primary', text: 'Resume here' });
  go.addEventListener('click', async () => {
    go.disabled = true;
    const ack = await request({ t: 'new', id: newId('n'), resumeId: hit.sessionId });
    if (!ack.ok) {
      go.disabled = false;
      return toast(errorText(ack.error));
    }
    closeSheet();
    clearSearch();
    conn.send({ t: 'list' });
    openSession(ack.name);
    return undefined;
  });
  openSheet('Resume this session?', el('div', { class: 'stack' }, [el('p', { class: 'muted', text: 'Starts it in the service with its full history, so it can be steered from here and from the Mac.' }), dl, go]));
}

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

const COLLAPSED_KEY = 'claude-remote.collapsed';

function collapsedProjects() {
  return new Set(safeStorage((st) => JSON.parse(st.getItem(COLLAPSED_KEY) || '[]'), []));
}

function sessionRow(s) {
  const open = () => openSession(keyOf(s));
  const actions = [];
  if (!s.managed && s.pid) actions.push(el('button', { type: 'button', class: 'secondary', text: 'Take over', onclick: (e) => (e.stopPropagation(), prepareTakeover(s.pid)) }));
  return el('li', { class: 'session-row', tabindex: '0', onclick: open, onkeydown: (e) => e.key === 'Enter' && open() }, [
    el('div', { class: 'row-main' }, [
      el('div', { class: 'row-title' }, [s.unread ? el('span', { class: 'unread-dot', title: 'New since you last looked', 'aria-label': 'unread' }) : null, el('span', { class: 'row-name', text: labelOf(s) }), pill(s.status)]),
      el('div', { class: 'row-meta' }, [el('span', { text: s.project || basename(s.cwd) }), badge(s.managed ? 'service' : 'terminal'), el('span', { text: timeAgo(s.lastActivity) })]),
      s.lastPrompt ? el('div', { class: 'row-prompt', text: s.lastPrompt }) : null,
    ]),
    el('div', { class: 'row-actions' }, actions),
  ]);
}

function renderList() {
  const list = $('session-list');
  list.replaceChildren();
  $('session-empty').hidden = state.sessions.length > 0;
  const { needs, groups } = inboxSections(state.sessions);
  if (needs.length) {
    list.append(el('li', { class: 'section-head', text: 'Needs you' }));
    for (const s of needs) list.append(sessionRow(s));
  }
  const collapsed = collapsedProjects();
  for (const g of groups) {
    const details = el('details', { class: 'project-group', open: !collapsed.has(g.project) }, [
      el('summary', {}, [el('span', { class: 'group-name', text: g.project }), el('span', { class: 'group-count', text: String(g.items.length) })]),
      el('ul', { class: 'session-list' }, g.items.map(sessionRow)),
    ]);
    details.addEventListener('toggle', () => {
      const set = collapsedProjects();
      if (details.open) set.delete(g.project);
      else set.add(g.project);
      safeStorage((st) => st.setItem(COLLAPSED_KEY, JSON.stringify([...set])));
    });
    list.append(el('li', { class: 'group' }, details));
  }
}

function markSeen(s) {
  if (!s || !s.sessionId) return;
  s.unread = false;
  conn.send({ t: 'markSeen', sessionId: s.sessionId });
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
  markSeen(currentItem());
}

function wantsAutoFit() {
  return isTouch() || window.innerWidth < 700;
}

function releaseClaim(reclaimLater) {
  const s = currentItem();
  if (state.claim && s && s.managed) conn.send({ t: 'releaseSize', sessionId: s.name });
  if (state.claim) state.reclaim = Boolean(reclaimLater);
  state.claim = false;
  renderSize();
}

function closeSession() {
  if (!state.current) return;
  const s = currentItem();
  markSeen(s);
  releaseClaim(false);
  state.reclaim = false;
  state.fitOptOut = false;
  conn.send({ t: 'unsub', sessionId: state.current });
  if (s && s.sessionId && s.sessionId !== state.current) conn.send({ t: 'unsub', sessionId: s.sessionId });
  unmountChat();
  state.current = null;
  state.subscribedKey = null;
  state.claim = false;
  state.sizeOwner = null;
  state.lastSeq = null;
  renderSize();
  $('title').textContent = 'Claude Remote';
}

function subscribe() {
  const s = currentItem();
  if (!s || !conn.authed) return;
  state.subscribedKey = state.current;
  if (s.managed && state.tab === 'terminal') {
    if (!term) term = createTerm($('term'));
    state.lastSeq = null;
    conn.send({ t: 'sub', sessionId: s.name, cols: 0, rows: 0 });
    if (!state.claim && document.visibilityState !== 'hidden' && (state.reclaim || (wantsAutoFit() && !state.fitOptOut))) state.claim = true;
    state.reclaim = false;
    if (state.claim) claimSize();
    renderSize();
  }
  if (state.tab === 'chat') mountChat();
}

function setTab(tab) {
  if (tab !== 'terminal' && state.tab === 'terminal') releaseClaim(true);
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
      conn.needsPair = true;
      if (conn.sentToken) setToken(conn, null);
      conn.setState('online');
      if (m.autoPair && !conn.autoPairTried) {
        conn.autoPairTried = true;
        show('pair');
        $('pair-form').hidden = true;
        $('pair-wait').hidden = false;
        $('pair-code').textContent = 'connecting this device…';
        conn.send({ t: 'pair', deviceName: defaultDeviceName() });
        return undefined;
      }
      return showPair();
    case 'pairCode':
      $('pair-form').hidden = true;
      $('pair-wait').hidden = false;
      $('pair-code').textContent = m.code;
      return undefined;
    case 'paired':
      setToken(conn, m.token);
      return undefined;
    case 'searchResults':
      if (m.id === search.id) renderSearch(Array.isArray(m.items) ? m.items : []);
      return undefined;
    case 'health':
      conn.health = m;
      return renderHealth(m);
    case 'helloOk':
      conn.authed = true;
      conn.needsPair = false;
      conn.health = m.health || null;
      conn.device = m.device;
      renderHealth(m.health);
      state.device = m.device;
      state.defaultDir = m.defaultDir || '';
      conn.setState('online');
      if (conn === hosts[0] && Array.isArray(m.peers)) setPeers(m.peers);
      if (state.current) {
        show('session');
        subscribe();
      } else show('list');
      flushOutbox();
      return undefined;
    case 'sessions':
      conn.sessions = Array.isArray(m.items) ? m.items : [];
      state.sessions = conn.sessions;
      renderHostTabs();
      renderList();
      if (state.current) renderStatus();
      if (state.current && state.subscribedKey !== state.current && currentItem()) {
        if (!currentItem().managed && state.tab !== 'chat') setTab('chat');
        subscribe();
      }
      return undefined;
    case 'status': {
      for (const s of state.sessions) if (keyOf(s) === m.sessionId || s.sessionId === m.sessionId) Object.assign(s, { status: m.status, waitingFor: m.waitingFor });
      if (m.status === 'idle' && currentItem() && (state.current === m.sessionId || currentItem().sessionId === m.sessionId) && document.visibilityState === 'visible') markSeen(currentItem());
      renderHostTabs();
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
      if (state.claim && m.claimedBy && m.claimedBy !== (state.device && state.device.name)) state.claim = false;
      return renderSize();
    case 'ack':
      return onAck(m);
    case 'events':
    case 'agentEvents': {
      const i = state.eventWaiters.findIndex((w) => w.type === m.t && w.sessionId === m.sessionId && (m.t === 'events' || w.toolUseId === m.toolUseId));
      if (i >= 0) state.eventWaiters.splice(i, 1)[0].resolve(m);
      return undefined;
    }
    case 'eventsLive':
      for (const fn of state.eventsListeners) fn(m);
      return undefined;
    case 'reset':
      for (const fn of state.resetListeners) fn(m);
      return undefined;
    case 'takeoverInfo':
      return showTakeoverSheet(m);
    case 'devices':
      return renderDevices(m.items || []);
    case 'error':
      if (m.ref === 'events' || m.ref === 'agentEvents') {
        const i = state.eventWaiters.findIndex((w) => w.type === m.ref);
        if (i >= 0) state.eventWaiters.splice(i, 1)[0].reject(new Error(errorText(m.code, m.msg)));
        return undefined;
      }
      if (m.ref === 'pair') {
        $('pair-form').hidden = false;
        $('pair-wait').hidden = true;
      }
      if (m.code === 'session-ended' && m.sessionId === state.current) {
        state.subscribedKey = null;
        state.lastSeq = null;
        state.awaitingBody = false;
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
  const r = conn.sender.onAck(m);
  if (!r.handled) {
    if (!m.ok) toast(errorText(m.error));
    return;
  }
  if (!r.item) return;
  if (r.error !== 'busy-dialog') toast(errorText(r.error));
  if (PERMANENT_LOCAL.has(r.error) && input) input.restore(r.item.text);
}

function flushOutbox() {
  conn.sender.reset();
  conn.sender.pump();
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
  const item = outbox.add(s.name, text, conn.id);
  if (!item) {
    toast('Outbox is full; wait for the connection.');
    return false;
  }
  if (conn.authed) conn.sender.pump();
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
  if (!s || !s.sessionId || state.chatUnmount || state.chatMounting) return;
  state.chatMounting = true;
  const pane = $('chat-pane');
  let mod = null;
  try {
    mod = await import('./chat.js');
  } catch {
    mod = null;
  } finally {
    state.chatMounting = false;
  }
  if (state.chatUnmount || state.tab !== 'chat' || currentItem() !== s) return;
  const mountChatFn = (mod && typeof mod.mountChat === 'function' && mod.mountChat) || (window.ClaudeChat && typeof window.ClaudeChat.mountChat === 'function' && window.ClaudeChat.mountChat);
  if (!mountChatFn) {
    pane.replaceChildren(el('p', { class: 'muted pane-pad', text: 'The chat view is not available in this build.' }));
    state.chatUnmount = () => pane.replaceChildren();
    return;
  }
  const sessionId = s.sessionId;
  let liveSubscribed = false;
  const api = {
    sessionId,
    requestEvents(id, { before, limit } = {}) {
      return new Promise((resolve, reject) => {
        const done = (m) => {
          if (before === undefined && id === sessionId && !liveSubscribed && state.chatUnmount === unmount) {
            liveSubscribed = true;
            conn.send({ t: 'subEvents', sessionId, from: m.to });
          }
          resolve(m);
        };
        state.eventWaiters.push({ type: 'events', sessionId: id, resolve: done, reject });
        if (!conn.send({ t: 'events', sessionId: id, before, limit })) reject(new Error('offline'));
      });
    },
    requestAgentEvents(id, toolUseId, { before, limit } = {}) {
      return new Promise((resolve, reject) => {
        state.eventWaiters.push({ type: 'agentEvents', sessionId: id, toolUseId, resolve, reject });
        if (!conn.send({ t: 'agentEvents', sessionId: id, toolUseId, before, limit })) reject(new Error('offline'));
      });
    },
    onEvents(cb) {
      state.eventsListeners.add(cb);
      return () => state.eventsListeners.delete(cb);
    },
    onReset(cb) {
      state.resetListeners.add(cb);
      return () => state.resetListeners.delete(cb);
    },
  };
  pane.replaceChildren();
  const r = mountChatFn(pane, api);
  const unmount = () => {
    if (typeof r === 'function') r();
    else if (r && typeof r.destroy === 'function') r.destroy();
    state.eventsListeners.clear();
    state.resetListeners.clear();
    conn.send({ t: 'unsub', sessionId });
    pane.replaceChildren();
  };
  state.chatUnmount = unmount;
  if (r && typeof r.open === 'function') r.open(sessionId);
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
  const name = el('input', { value: `cc-${rand}`, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', pattern: 'cc-[a-z0-9\\-]{1,40}', required: true });
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
  const note = el('p', { class: 'muted', text: 'The running process gets SIGTERM, then the session resumes under the service with the same id. Unsent input in its terminal is lost.' });
  let force = false;
  confirm.addEventListener('click', async () => {
    confirm.disabled = true;
    const ack = await request({ t: 'takeover', id: newId('t'), token: info.token, ...(force ? { force: true } : {}) });
    if (!ack.ok) {
      confirm.disabled = false;
      if (ack.error === 'still-running' && !force) {
        force = true;
        note.textContent = 'The process ignored the stop request. Force it with SIGKILL? Anything it has not saved is lost. The process is checked again before the kill.';
        confirm.textContent = 'Force stop (SIGKILL) and resume';
        return undefined;
      }
      return toast(errorText(ack.error));
    }
    closeSheet();
    conn.send({ t: 'list' });
    openSession(ack.name || info.name);
    return undefined;
  });
  const body = el('div', { class: 'stack' }, [note, dl, confirm]);
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
  if (!name.value) name.value = defaultDeviceName();
}

function defaultDeviceName() {
  const ua = navigator.userAgent;
  if (host) return 'VS Code';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Macintosh/.test(ua)) return 'Mac browser';
  return 'Browser';
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
  $('session-search').addEventListener('input', onSearchInput);
  $('session-search').addEventListener('keydown', (e) => e.key === 'Escape' && clearSearch());
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
    if (state.claim) {
      state.fitOptOut = true;
      releaseClaim(false);
    } else {
      state.fitOptOut = false;
      state.claim = true;
      claimSize();
      renderSize();
    }
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
  window.addEventListener('online', () => hosts.forEach((h) => h.connect()));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') return releaseClaim(true);
    hosts.forEach((h) => h.connect());
    if (state.reclaim && state.current && state.tab === 'terminal' && conn.authed) {
      state.reclaim = false;
      state.claim = true;
      claimSize();
      renderSize();
    }
    return undefined;
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => state.claim && claimSize(), 300);
  });
  const self = makeConn({ id: 'self', label: selfLabel(), url: wsUrl() });
  hosts.push(self);
  conn = self;
  show('list');
  self.connect();
  setPeers(safeStorage((s) => JSON.parse(s.getItem(PEERS_KEY) || '[]'), []));
}

init();
