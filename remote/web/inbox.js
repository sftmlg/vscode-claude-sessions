const time = (s) => Date.parse(s.lastActivity || 0) || 0;
const newestFirst = (a, b) => time(b) - time(a);

function rank(s) {
  if (s.status === 'waiting') return 0;
  if (s.unread && s.status !== 'busy') return 1;
  return -1;
}

const STALE_MS = 6 * 3600 * 1000;

export function staleFor(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t) || now - t < STALE_MS) return '';
  return relativeTime(iso, now).replace(/ ago$/, '');
}

export function projectOf(s) {
  if (s.project) return s.project;
  const parts = String(s.cwd || '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : 'Other';
}

export function inboxSections(items) {
  const needs = [];
  const byProject = new Map();
  for (const s of items) {
    if (rank(s) >= 0) needs.push(s);
    else {
      const p = projectOf(s);
      if (!byProject.has(p)) byProject.set(p, []);
      byProject.get(p).push(s);
    }
  }
  needs.sort((a, b) => rank(a) - rank(b) || newestFirst(a, b));
  const groups = [...byProject.entries()].map(([project, list]) => ({ project, items: list.sort(newestFirst) }));
  groups.sort((a, b) => time(b.items[0]) - time(a.items[0]));
  return { needs, groups };
}

export function relativeTime(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const min = Math.floor((now - t) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (t >= startOfToday.getTime()) return `${Math.floor(min / 60)} h ago`;
  const days = Math.ceil((startOfToday.getTime() - t) / 86400000);
  if (days <= 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return 'over a year ago';
}

export function absoluteTime(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? new Date(t).toLocaleString() : '';
}

export function initialTab(key, item, current) {
  if (item) return item.managed ? current : 'chat';
  return /^cc-/.test(key) ? 'terminal' : 'chat';
}

export function deviceOrigin(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (!node.name) return '';
  return node.os ? `${node.name} (${node.os})` : node.name;
}
