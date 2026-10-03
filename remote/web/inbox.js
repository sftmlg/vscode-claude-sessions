const time = (s) => Date.parse(s.lastActivity || 0) || 0;
const newestFirst = (a, b) => time(b) - time(a);

function rank(s) {
  if (s.status === 'waiting') return 0;
  if (s.status === 'busy') return 2;
  if (s.unread) return 1;
  return -1;
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
