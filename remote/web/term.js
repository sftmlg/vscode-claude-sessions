import { Terminal } from './vendor/xterm.mjs';
import { FitAddon } from './vendor/addon-fit.mjs';

const THEME = {
  background: '#141413',
  foreground: '#e8e6dc',
  cursor: '#e8e6dc',
  cursorAccent: '#141413',
  selectionBackground: '#4a4842',
  black: '#1f1e1d',
  red: '#e06c75',
  green: '#98c379',
  yellow: '#e5c07b',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#d4d2c8',
  brightBlack: '#6b6a65',
  brightRed: '#ff7b84',
  brightGreen: '#b5e890',
  brightYellow: '#f0d28c',
  brightBlue: '#7cc0ff',
  brightMagenta: '#d896ef',
  brightCyan: '#6fd0dc',
  brightWhite: '#faf9f5',
};
const FONT = 'Menlo, "SF Mono", Monaco, "Cascadia Mono", "DejaVu Sans Mono", monospace';
const LINE_HEIGHT = 1.0;
const MIN_FONT = 5;
const MAX_FONT = 15;

let styleShimInstalled = false;

export function installStyleShim(root = document) {
  if (styleShimInstalled || !('adoptedStyleSheets' in Document.prototype) || typeof CSSStyleSheet !== 'function') return;
  styleShimInstalled = true;
  const sheets = new Map();
  const sync = () => {
    let changed = false;
    for (const el of root.querySelectorAll('style')) {
      const text = el.textContent || '';
      let entry = sheets.get(el);
      if (!entry) {
        entry = { sheet: new CSSStyleSheet(), text: null };
        sheets.set(el, entry);
        changed = true;
      }
      if (entry.text !== text) {
        try {
          entry.sheet.replaceSync(text);
        } catch {}
        entry.text = text;
      }
    }
    for (const el of [...sheets.keys()]) {
      if (!el.isConnected) {
        sheets.delete(el);
        changed = true;
      }
    }
    if (changed) {
      const own = [...sheets.values()].map((e) => e.sheet);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets.filter((s) => !s.__claudeRemoteShim), ...own.map((s) => Object.assign(s, { __claudeRemoteShim: true }))];
    }
  };
  new MutationObserver(sync).observe(root.documentElement || root, { childList: true, subtree: true, characterData: true });
  sync();
}

function charRatio() {
  const probe = document.createElement('span');
  probe.className = 'measure-probe';
  probe.textContent = 'M'.repeat(50);
  document.body.appendChild(probe);
  const w = probe.getBoundingClientRect().width / 50 / 100;
  probe.remove();
  return w > 0 ? w : 0.6;
}

export function openLink(uri) {
  let url;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const w = window.open(url.href, '_blank', 'noopener,noreferrer');
  if (w) w.opener = null;
  return true;
}

export function createTerm(el) {
  installStyleShim();
  const term = new Terminal({
    disableStdin: true,
    cursorBlink: false,
    scrollback: 1000,
    fontFamily: FONT,
    fontSize: 13,
    lineHeight: LINE_HEIGHT,
    theme: THEME,
    allowProposedApi: false,
    linkHandler: { activate: (_event, uri) => openLink(uri), allowNonHttpProtocols: false },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  term.parser.registerOscHandler(52, () => true);
  let ratio = null;
  let scrollLocked = false;
  let cols = 80;
  let rows = 24;

  function scale() {
    if (!ratio) ratio = charRatio();
    const width = el.clientWidth;
    if (!width) return;
    const size = Math.max(MIN_FONT, Math.min(MAX_FONT, Math.floor((width / (cols * ratio)) * 10) / 10));
    if (term.options.fontSize !== size) term.options.fontSize = size;
  }

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => scale()) : null;
  if (ro) ro.observe(el);

  return {
    term,
    reset(c, r, bytes) {
      cols = c;
      rows = r;
      term.reset();
      if (term.cols !== c || term.rows !== r) term.resize(c, r);
      scale();
      term.write(bytes);
    },
    write(bytes) {
      if (!scrollLocked) return term.write(bytes);
      const y = term.buffer.active.viewportY;
      term.write(bytes, () => term.scrollToLine(y));
      return undefined;
    },
    setScrollLock(on) {
      scrollLocked = Boolean(on);
      if (!scrollLocked) term.scrollToBottom();
    },
    proposeSize() {
      if (!ratio) ratio = charRatio();
      const fontSize = window.matchMedia('(max-width: 600px)').matches ? 12 : 13;
      const c = Math.floor(el.clientWidth / (fontSize * ratio));
      const r = Math.floor(el.clientHeight / (fontSize * 1.2 * LINE_HEIGHT));
      return { cols: Math.max(20, Math.min(400, c)), rows: Math.max(5, Math.min(200, r)) };
    },
    rescale: scale,
    visibleLines() {
      const buf = term.buffer.active;
      const lines = [];
      for (let y = buf.viewportY; y < buf.viewportY + term.rows; y++) {
        const line = buf.getLine(y);
        lines.push(line ? line.translateToString(true) : '');
      }
      return lines;
    },
    dispose() {
      if (ro) ro.disconnect();
      term.dispose();
    },
  };
}
