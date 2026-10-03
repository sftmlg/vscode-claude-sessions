import { createTerm } from './term.js';
import { Outbox, OutboxSender, DraftStore, setupInput, newId, highlightParts } from './input.js';
import { inboxSections, relativeTime, absoluteTime, staleFor } from './inbox.js';
import { parseOptions, suggestionFrom } from './quick-replies.js';
import { pushSupported, subscribePush, unsubscribePush, onNotificationClick, onSubscriptionChange, currentSubscription, sessionFromUrl, PUSH_UNAVAILABLE } from './notify.js';

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
  'session-starting': 'This session is starting already; it appears in the list in a moment.',
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

let viewerHost = null;

function urlHost(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function selfLabel() {
  return urlHost(wsUrl()).split('.')[0] || 'this hub';
}

const isViewerHost = (c) => Boolean(viewerHost) && urlHost(c.url) === viewerHost;

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
  if (target && target !== conn && !state.current && !pendingOpen) switchHost(target);
}

function waitingCount(c) {
  return inboxSections(c.sessions || []).needs.length;
}

function syncChildren(parent, nodes) {
  nodes.forEach((n, i) => {
    if (parent.children[i] !== n) parent.insertBefore(n, parent.children[i] || null);
  });
  while (parent.children.length > nodes.length) parent.lastElementChild.remove();
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function setAttr(node, name, value) {
  if (value === null || value === undefined) {
    if (node.hasAttribute(name)) node.removeAttribute(name);
  } else if (node.getAttribute(name) !== String(value)) node.setAttribute(name, String(value));
}

const tabNodes = new Map();

function renderHostTabs() {
  const nav = $('host-tabs');
  if (!nav) return;
  nav.hidden = hosts.length < 2;
  const ordered = [...hosts.filter(isViewerHost), ...hosts.filter((h) => !isViewerHost(h))];
  const nodes = ordered.map((c) => {
    let t = tabNodes.get(c.id);
    if (!t) {
      t = { dot: el('span'), label: el('span'), count: el('span', { class: 'host-count' }) };
      t.btn = el('button', { type: 'button', role: 'tab', class: 'host-tab', onclick: () => switchHost(c) }, [t.dot, t.label, t.count]);
      tabNodes.set(c.id, t);
    }
    const waiting = waitingCount(c);
    setAttr(t.btn, 'aria-selected', String(c === conn));
    setAttr(t.btn, 'title', `${c.label}: ${c.connState === 'online' ? 'connected' : c.connState}${waiting ? `, ${waiting} waiting for you` : ''}`);
    setAttr(t.dot, 'class', `dot dot-${c.connState}`);
    setText(t.label, isViewerHost(c) ? `${c.label} (this device)` : c.label);
    setText(t.count, waiting ? String(waiting) : '');
    t.count.hidden = !waiting;
    setAttr(t.count, 'aria-label', waiting ? `${waiting} waiting` : null);
    return t.btn;
  });
  for (const id of [...tabNodes.keys()]) if (!hosts.some((h) => h.id === id)) tabNodes.delete(id);
  syncChildren(nav, nodes);
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
    if (m.hostName) c.label = m.hostName;
    if (c === hosts[0]) resyncPush();
    if (c === hosts[0] && pendingOpen) setTimeout(() => {
      const key = pendingOpen;
      pendingOpen = null;
      switchHost(c);
      openSession(key);
    }, 0);
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
  } else if ((m.t === 'pushKey' || m.t === 'pushState') && c === hosts[0]) {
    onPushMessage(m);
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
const drafts = new DraftStore();
let draftTimer = null;

function saveDraft(text) {
  const s = currentItem();
  if (!s || !s.managed) return;
  const host = conn.id;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => drafts.save(host, s.name, text), 300);
  renderSuggestion();
}

function renderSuggestion() {
  const btn = $('suggestion');
  const s = currentItem();
  const row = s && s.managed && s.status === 'idle' && state.tab === 'terminal' && term && input && input.isEmpty() ? term.promptRow() : null;
  const suggestion = suggestionFrom(row);
  btn.hidden = !suggestion;
  $('suggestion-text').textContent = suggestion || '';
  btn.dataset.text = suggestion || '';
}
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
    const open = () => openHit(hit);
    const snippet = el('div', { class: 'row-snippet' }, highlightParts(hit.snippet, search.query).map((p) => (p.hit ? el('mark', { class: 'hit', text: p.text }) : document.createTextNode(p.text))));
    list.append(
      el('li', { class: 'session-row', tabindex: '0', onclick: open, onkeydown: (e) => e.key === 'Enter' && open() }, [
        el('div', { class: 'row-main' }, [
          el('div', { class: 'row-title' }, [hit.favorite ? el('span', { class: 'star', text: '★', title: 'Starred in the editor' }) : null, el('span', { class: 'row-name', text: hit.title || hit.sessionId.slice(0, 8) }), badge(hit.running)]),
          el('div', { class: 'row-meta' }, [el('span', { text: hit.project || basename(hit.cwd) }), when(hit.lastActivity)]),
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
    setBusy(go, true);
    const ack = await request({ t: 'new', id: newId('n'), resumeId: hit.sessionId });
    if (!ack.ok) {
      setBusy(go, false);
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
  return relativeTime(iso);
}

function when(iso) {
  return el('span', { class: 'when', text: relativeTime(iso), title: absoluteTime(iso) || undefined });
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

const STAR_KEY = 'claude-remote.star-only';
let starOnly = safeStorage((st) => st.getItem(STAR_KEY) === '1', false);
const rowNodes = new Map();
const groupNodes = new Map();
let needsHead = null;

function sessionRow(s) {
  const key = `${s.managed ? 'm' : 'u'}:${keyOf(s)}`;
  let r = rowNodes.get(key);
  if (!r) {
    r = {};
    const open = () => openSession(keyOf(r.item));
    r.dot = el('span', { class: 'unread-dot', title: 'New since you last looked', 'aria-label': 'unread' });
    r.star = el('span', { class: 'star', text: '★', title: 'Starred in the editor', 'aria-label': 'starred' });
    r.name = el('span', { class: 'row-name' });
    r.pill = el('span');
    r.project = el('span');
    r.badge = el('span');
    r.when = el('span', { class: 'when' });
    r.prompt = el('div', { class: 'row-prompt' });
    r.li = el('li', { class: 'session-row', tabindex: '0', onclick: open, onkeydown: (e) => e.key === 'Enter' && open() }, [
      el('div', { class: 'row-main' }, [el('div', { class: 'row-title' }, [r.dot, r.star, r.name, r.pill]), el('div', { class: 'row-meta' }, [r.project, r.badge, r.when]), r.prompt]),
    ]);
    rowNodes.set(key, r);
  }
  r.item = s;
  r.dot.hidden = !s.unread;
  r.star.hidden = !s.favorite;
  setText(r.name, labelOf(s));
  const p = pill(s.status);
  const stale = s.status === 'waiting' ? staleFor(s.lastActivity) : '';
  setAttr(r.pill, 'class', stale ? `${p.className} pill-stale` : p.className);
  setAttr(r.pill, 'title', stale ? `Waiting since ${absoluteTime(s.lastActivity)}` : null);
  setText(r.pill, stale ? `waiting · ${stale}` : p.textContent);
  setText(r.project, s.project || basename(s.cwd));
  const b = badge(s.managed ? 'service' : 'terminal');
  setAttr(r.badge, 'class', b.className);
  setAttr(r.badge, 'title', b.title);
  setText(r.badge, b.textContent);
  setText(r.when, relativeTime(s.lastActivity));
  setAttr(r.when, 'title', absoluteTime(s.lastActivity) || null);
  setText(r.prompt, s.lastPrompt || '');
  r.prompt.hidden = !s.lastPrompt;
  r.used = true;
  return r.li;
}

function groupNode(project) {
  let g = groupNodes.get(project);
  if (!g) {
    g = { name: el('span', { class: 'group-name', text: project }), count: el('span', { class: 'group-count' }), ul: el('ul', { class: 'session-list' }) };
    g.details = el('details', { class: 'project-group', open: !collapsedProjects().has(project) }, [el('summary', {}, [g.name, g.count]), g.ul]);
    g.details.addEventListener('toggle', () => {
      const set = collapsedProjects();
      if (g.details.open) set.delete(project);
      else set.add(project);
      safeStorage((st) => st.setItem(COLLAPSED_KEY, JSON.stringify([...set])));
    });
    g.li = el('li', { class: 'group' }, g.details);
    groupNodes.set(project, g);
  }
  return g;
}

function renderList() {
  const list = $('session-list');
  const visible = starOnly ? state.sessions.filter((s) => s.favorite) : state.sessions;
  $('session-empty').hidden = visible.length > 0;
  $('session-empty').textContent = starOnly ? 'No starred session is running. Star sessions in the editor.' : 'No running Claude sessions.';
  for (const r of rowNodes.values()) r.used = false;
  const { needs, groups } = inboxSections(visible);
  const top = [];
  if (needs.length) {
    if (!needsHead) needsHead = el('li', { class: 'section-head', text: 'Needs you' });
    top.push(needsHead, ...needs.map(sessionRow));
  }
  const groupLists = groups.map((grp) => {
    const g = groupNode(grp.project);
    setText(g.count, String(grp.items.length));
    top.push(g.li);
    return [g, grp.items.map(sessionRow)];
  });
  syncChildren(list, top);
  for (const [g, rows] of groupLists) syncChildren(g.ul, rows);
  for (const [k, r] of [...rowNodes]) if (!r.used) rowNodes.delete(k);
  for (const p of [...groupNodes.keys()]) if (!groups.some((g) => g.project === p)) groupNodes.delete(p);
}

let quickTimer = null;
function scheduleQuickReplies() {
  clearTimeout(quickTimer);
  quickTimer = setTimeout(renderQuickReplies, 150);
}

function renderQuickReplies() {
  renderSuggestion();
  const bar = $('quick-replies');
  const s = currentItem();
  const options = s && s.managed && s.status === 'waiting' && state.tab === 'terminal' && term ? parseOptions(term.visibleLines()) : [];
  if (!s || s.status !== 'waiting') bar.replaceChildren();
  bar.hidden = !options.length;
  if (!options.length) return;
  bar.replaceChildren(...options.map((o) => el('button', { type: 'button', class: 'quick-reply', title: `${o.detail ? `${o.label}: ${o.detail}. ` : ''}Sends the key ${o.key === 'Escape' ? 'Esc' : o.key}`, text: o.key === 'Escape' ? o.label : `${o.key}  ${o.label}`, onclick: () => sendKey(o.key) })));
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
  inert($('tab-terminal'), managed ? null : 'This session runs in a terminal on the Mac. Take it over to see and steer its screen here.');
  $('readonly-note').hidden = managed;
  $('input-bar').hidden = !managed;
  $('keybar').hidden = !managed;
  inert($('tab-chat'), s.sessionId ? null : 'The conversation appears once Claude has started in this session.');
}

function setBusy(button, on) {
  if (on) {
    button.dataset.label = button.textContent;
    button.textContent = 'Working…';
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
  }
  button.setAttribute('aria-busy', String(on));
  button['disabled'] = on;
}

function inert(node, reason) {
  if (reason) {
    node.setAttribute('aria-disabled', 'true');
    node.dataset.reason = reason;
  } else {
    node.removeAttribute('aria-disabled');
    delete node.dataset.reason;
  }
}

function explainIfInert(node) {
  if (node.getAttribute('aria-disabled') !== 'true') return false;
  toast(node.dataset.reason || 'Not available right now.');
  return true;
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
  const opened = currentItem();
  if (input) input.setText(opened && opened.managed ? drafts.load(conn.id, opened.name) : '');
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
    scheduleQuickReplies();
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
  scheduleQuickReplies();
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
    case 'pushKey':
    case 'pushState':
      return onPushMessage(m);
    case 'searchResults':
      if (m.id === search.id) renderSearch(Array.isArray(m.items) ? m.items : []);
      return undefined;
    case 'health':
      conn.health = m;
      return renderHealth(m);
    case 'helloOk':
      conn.authed = true;
      if (m.hostName) conn.label = m.hostName;
      if (conn === hosts[0] && m.viewerHost) viewerHost = String(m.viewerHost).toLowerCase();
      if (conn === hosts[0]) resyncPush();
      conn.needsPair = false;
      conn.health = m.health || null;
      conn.device = m.device;
      renderHealth(m.health);
      state.device = m.device;
      state.defaultDir = m.defaultDir || '';
      conn.setState('online');
      if (conn === hosts[0] && Array.isArray(m.peers)) setPeers(m.peers);
      if (pendingOpen && conn === hosts[0]) {
        const key = pendingOpen;
        pendingOpen = null;
        show('list');
        openSession(key);
      } else if (state.current) {
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
      scheduleQuickReplies();
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
  clearTimeout(draftTimer);
  drafts.clear(conn.id, s.name);
  if (conn.authed) conn.sender.pump();
  else toast('Offline: queued, sends when online.');
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
  const key = keyOf(s);
  const pane = $('chat-pane');
  pane.replaceChildren(el('p', { class: 'muted pane-pad', text: 'Loading conversation…' }));
  let mod = null;
  try {
    mod = await import('./chat.js');
  } catch {
    mod = null;
  } finally {
    state.chatMounting = false;
  }
  if (state.chatUnmount || state.tab !== 'chat' || keyOf(currentItem() || {}) !== key) return;
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
  if (r && typeof r.open === 'function') {
    Promise.resolve(r.open(sessionId)).catch(() => {
      if (state.chatUnmount !== unmount) return;
      pane.replaceChildren(el('p', { class: 'muted pane-pad', text: 'Could not load the conversation. Switch tabs or reconnect to try again.' }));
    });
  }
}

function unmountChat() {
  if (state.chatUnmount) state.chatUnmount();
  state.chatUnmount = null;
}

function openSheet(title, body) {
  const sheet = $('sheet');
  sheet.replaceChildren(el('div', { class: 'sheet-head' }, [el('h2', { id: 'sheet-title', text: title }), el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', text: '×', onclick: closeSheet })]), body);
  if (!sheet.open) sheet.showModal();
}

function closeSheet() {
  const sheet = $('sheet');
  if (sheet.open) sheet.close();
  sheet.replaceChildren();
}

function confirmSheet({ title, text, action, onConfirm, onCancel }) {
  const go = el('button', { type: 'button', class: 'danger', text: action });
  const cancel = el('button', { type: 'button', class: 'secondary', text: 'Cancel', onclick: () => (onCancel ? onCancel() : closeSheet()) });
  go.addEventListener('click', () => onConfirm());
  openSheet(title, el('div', { class: 'stack' }, [el('p', { text }), el('div', { class: 'row-form' }, [cancel, go])]));
}

function field(label, input) {
  return el('label', { class: 'field' }, [el('span', { text: label }), input]);
}

function showNewSession() {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, '0')).join('');
  const name = el('input', { value: `cc-${rand}`, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', pattern: 'cc-[a-z0-9\\-]{1,40}', required: true });
  const dir = el('input', { value: state.defaultDir, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const start = el('button', { type: 'submit', class: 'primary', text: 'Start' });
  const form = el('form', { class: 'stack' }, [field('Name', name), field('Directory', dir), el('p', { class: 'muted small', text: 'To continue an earlier session, search for it and choose Resume here.' }), start]);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (start.getAttribute('aria-busy') === 'true') return undefined;
    setBusy(start, true);
    const ack = await request({ t: 'new', id: newId('n'), name: name.value.trim(), dir: dir.value.trim() });
    setBusy(start, false);
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
  const item = state.sessions.find((x) => x.pid === info.pid) || {};
  const rows = [
    ['Session', info.title || item.title || 'Untitled session'],
    ['Project', item.project || basename(info.cwd) || '—'],
    ['State', info.status || item.status || '—'],
    ['Name here', info.name],
  ];
  const facts = (list) => el('dl', { class: 'facts' }, list.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
  const dl = el('div', { class: 'stack' }, [
    facts(rows),
    el('details', { class: 'facts-more' }, [el('summary', { text: 'Details' }), facts([['Process id', String(info.pid)], ['Terminal', info.tty || '—'], ['Directory', info.cwd || '—'], ['Account slot', info.slot || '—'], ['Session id', info.sessionId || '—']])]),
  ]);
  const confirm = el('button', { type: 'button', class: 'danger', text: 'Stop it and resume here' });
  const note = el('p', { class: 'muted', text: 'This stops Claude in that terminal on the Mac and continues the same conversation here. Anything typed there but not sent is lost.' });
  let force = false;
  confirm.addEventListener('click', async () => {
    setBusy(confirm, true);
    const ack = await request({ t: 'takeover', id: newId('t'), token: info.token, ...(force ? { force: true } : {}) });
    if (!ack.ok) {
      setBusy(confirm, false);
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

const push = { want: null, subscribed: false, busy: false };

function renderPushSwitch() {
  const sw = $('push-switch');
  if (!sw) return;
  sw.setAttribute('aria-checked', String(push.subscribed));
  sw.textContent = push.busy ? 'Working…' : push.subscribed ? 'On' : 'Off';
  inert(sw, !pushSupported() ? `Notifications ${PUSH_UNAVAILABLE}.` : push.busy ? 'Waiting for the hub to answer.' : null);
}

async function onPushMessage(m) {
  if (m.t === 'pushState') {
    push.subscribed = m.subscribed;
    clearTimeout(pushTimer);
    push.busy = false;
  } else if (m.t === 'pushKey') {
    push.subscribed = m.subscribed;
    if (push.want === true) {
      push.want = null;
      try {
        hosts[0].send({ t: 'pushSubscribe', subscription: await subscribePush(m.key) });
        return renderPushSwitch();
      } catch (e) {
        toast(e.message);
      }
    }
    push.busy = false;
  }
  return renderPushSwitch();
}

let pushTimer = null;

function pushSettled() {
  clearTimeout(pushTimer);
  push.busy = false;
  renderPushSwitch();
}

async function togglePush() {
  push.busy = true;
  renderPushSwitch();
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    if (!push.busy) return;
    push.want = null;
    pushSettled();
    toast(`${hosts[0].label} did not answer; try again when it is online.`);
  }, 10000);
  let sent;
  if (push.subscribed) {
    await unsubscribePush().catch(() => {});
    sent = hosts[0].send({ t: 'pushUnsubscribe' });
  } else {
    push.want = true;
    sent = hosts[0].send({ t: 'pushKey' });
  }
  if (!sent) {
    push.want = null;
    pushSettled();
    toast(`${hosts[0].label} is offline; notifications can be changed when it is back.`);
  }
}

async function resyncPush() {
  const sub = await currentSubscription().catch(() => null);
  if (sub) hosts[0].send({ t: 'pushSubscribe', subscription: sub });
}

function pushRow() {
  const supported = pushSupported();
  const sw = el('button', { type: 'button', id: 'push-switch', class: 'switch', role: 'switch', 'aria-checked': 'false', text: 'Off', onclick: (e) => !explainIfInert(e.currentTarget) && togglePush() });
  inert(sw, supported ? null : `Notifications ${PUSH_UNAVAILABLE}.`);
  if (supported) hosts[0].send({ t: 'pushKey' });
  return el('div', { class: 'stack' }, [
    el('h3', { text: 'Notifications' }),
    el('div', { class: 'row-form' }, [sw, el('span', { class: 'muted small', text: supported ? `Get a notification when a session on ${hosts[0].label} needs you or finishes.` : PUSH_UNAVAILABLE })]),
  ]);
}

function openFromLink(url) {
  const key = sessionFromUrl(url);
  if (!key) return;
  if (conn !== hosts[0]) switchHost(hosts[0]);
  if (conn.authed) openSession(key);
  else pendingOpen = key;
}

let pendingOpen = null;

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
    pushRow(),
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
      revoke.addEventListener('click', () =>
        confirmSheet({
          title: 'Revoke this device?',
          text: `${d.name} loses access at once and has to be paired again to come back.${self ? ' This is the device you are using now.' : ''}`,
          action: 'Revoke',
          onConfirm: () => {
            conn.send({ t: 'revoke', deviceId: d.id });
            showSettings();
          },
          onCancel: showSettings,
        }),
      );
      return el('li', { class: 'device-row' }, [el('div', {}, [el('div', { text: d.name }), el('div', { class: 'muted small', text: `last seen ${timeAgo(d.lastSeen)}`, title: absoluteTime(d.lastSeen) || undefined })]), revoke]);
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

function setImmersive(on) {
  document.body.classList.toggle('immersive', on);
  $('immersive-exit').hidden = !on;
  const root = document.documentElement;
  if (on && root.requestFullscreen && !document.fullscreenElement) root.requestFullscreen().catch(() => {});
  if (!on && document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
  if (term) requestAnimationFrame(() => term.rescale());
}

function setupImmersive() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  document.body.classList.toggle('standalone', standalone);
  $('immersive-toggle').addEventListener('click', () => setImmersive(!document.body.classList.contains('immersive')));
  $('immersive-exit').addEventListener('click', () => setImmersive(false));
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && document.body.classList.contains('immersive')) setImmersive(false);
  });
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
  setupImmersive();
  input = setupInput({ form: $('input-bar'), textarea: $('input'), badge: $('outbox-badge'), keybar: $('keybar'), outbox, isTouch, onSubmit: submitText, onKey: sendKey, onChange: saveDraft });
  $('suggestion').addEventListener('click', () => {
    const suggestion = $('suggestion').dataset.text;
    if (suggestion) input.fill(suggestion);
  });
  $('back').addEventListener('click', () => {
    closeSession();
    show('list');
  });
  $('open-settings').addEventListener('click', showSettings);
  $('new-session').addEventListener('click', showNewSession);
  $('session-search').addEventListener('input', onSearchInput);
  $('star-filter').setAttribute('aria-pressed', String(starOnly));
  $('star-filter').addEventListener('click', () => {
    starOnly = !starOnly;
    safeStorage((st) => st.setItem(STAR_KEY, starOnly ? '1' : '0'));
    $('star-filter').setAttribute('aria-pressed', String(starOnly));
    renderList();
  });
  $('session-search').addEventListener('keydown', (e) => e.key === 'Escape' && clearSearch());
  $('sheet').addEventListener('click', (e) => {
    if (e.target === $('sheet')) closeSheet();
  });
  $('takeover-here').addEventListener('click', () => {
    const s = currentItem();
    if (s && s.pid) prepareTakeover(s.pid);
  });
  $('tab-terminal').addEventListener('click', (e) => {
    if (explainIfInert(e.currentTarget)) return;
    unmountChat();
    setTab('terminal');
    subscribe();
  });
  $('tab-chat').addEventListener('click', (e) => {
    if (explainIfInert(e.currentTarget)) return;
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
  pendingOpen = sessionFromUrl(location.href);
  onNotificationClick(openFromLink);
  onSubscriptionChange(() => {
    push.want = true;
    hosts[0].send({ t: 'pushKey' });
  });
  setInterval(() => {
    renderList();
    renderHostTabs();
  }, 60000);
  setPeers(safeStorage((s) => JSON.parse(s.getItem(PEERS_KEY) || '[]'), []));
}

init();
