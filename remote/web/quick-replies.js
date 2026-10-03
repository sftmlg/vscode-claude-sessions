const OPTION_RE = /^\s*(?:[❯›>]\s*)?([1-9])[.)]\s+(.+?)\s*$/;
const ESC_RE = /\(esc\)|\besc to (?:cancel|close|go back)\b/i;
const MAX_LABEL = 60;

export function parseOptions(lines) {
  const visible = (Array.isArray(lines) ? lines : []).map((l) => String(l || ''));
  let block = [];
  let best = [];
  for (const line of visible) {
    const m = OPTION_RE.exec(line);
    if (m) {
      const n = Number(m[1]);
      if (block.length && n !== block[block.length - 1].n + 1) block = [];
      if (!block.length && n !== 1) continue;
      block.push({ n, text: m[2] });
      if (block.length >= 2) best = block.slice();
    } else if (line.trim()) {
      block = [];
    }
  }
  const options = best.map(({ n, text }) => {
    const plain = text.replace(/\s*\(esc\)\s*$/i, '').trim();
    return { key: String(n), label: plain.length > MAX_LABEL ? `${plain.slice(0, MAX_LABEL - 1)}…` : plain };
  });
  if (options.length && visible.some((l) => ESC_RE.test(l))) options.push({ key: 'Escape', label: 'Cancel (Esc)' });
  return options;
}
