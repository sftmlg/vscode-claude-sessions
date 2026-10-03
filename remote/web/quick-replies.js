const OPTION_RE = /^(\s*)(?:([❯›>])\s*)?([1-9])[.)]\s+(.+?)\s*$/;
const ESC_RE = /\(esc\)|\besc to (?:cancel|close|go back)\b/i;
const MAX_LABEL = 60;

const unbox = (line) => String(line || '').replace(/^\s*[│|]/, ' ').replace(/[│|]\s*$/, '').replace(/\s+$/, '');
const indentOf = (line) => line.length - line.trimStart().length;

function shorten(text) {
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text;
}

export function parseOptions(lines) {
  const visible = (Array.isArray(lines) ? lines : []).map(unbox);
  const blocks = [];
  let block = null;
  const close = () => {
    if (block && block.options.length >= 2) blocks.push(block);
    block = null;
  };
  for (const line of visible) {
    const m = OPTION_RE.exec(line);
    if (m) {
      const n = Number(m[3]);
      const column = m[1].length + (m[2] ? line.slice(m[1].length).indexOf(m[3]) : 0);
      if (block && n === block.options[block.options.length - 1].n + 1) block.options.push({ n, text: m[4], detail: [], column });
      else {
        close();
        if (n === 1) block = { options: [{ n, text: m[4], detail: [], column }], cursor: false };
      }
      if (block && m[2]) block.cursor = true;
    } else if (!line.trim()) {
      continue;
    } else if (block && indentOf(line) > block.options[block.options.length - 1].column) {
      block.options[block.options.length - 1].detail.push(line.trim());
    } else {
      close();
    }
  }
  close();
  const chosen = blocks.filter((b) => b.cursor).pop();
  if (!chosen) return [];
  const options = chosen.options.map(({ n, text, detail }) => {
    const plain = text.replace(/\s*\(esc\)\s*$/i, '').trim();
    const option = { key: String(n), label: shorten(plain) };
    if (detail.length) option.detail = detail.join(' ');
    return option;
  });
  if (visible.some((l) => ESC_RE.test(l))) options.push({ key: 'Escape', label: 'Cancel (Esc)' });
  return options;
}

const PROMPT_RE = /^\s*[│|]?\s*[❯>]\s+(.+?)\s*[│|]?\s*$/;

export function suggestionFrom(row) {
  if (!row || !row.dim) return null;
  const m = PROMPT_RE.exec(String(row.text || ''));
  return m && m[1].trim().length >= 2 ? m[1].trim() : null;
}
