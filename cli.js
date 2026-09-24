#!/usr/bin/env node
'use strict';
const path = require('path');
const fs = require('fs');
const { listRepoSessions, sessionSummary, oneLine, renameSession, metaForSession, SLUG_RE, archiveInState, pickByName, readRunningSessions, archiveDuplicates, searchSessions, readState } = require('./sessions');

const USAGE = [
  'Usage:',
  '  node cli.js list [repo-path] [--days N] [--json]',
  '  node cli.js search <query> [repo-path] [--days N]   (all words must occur; ranked by title hits, then frequency, then recency)',
  '  node cli.js rename <session-id> <name>',
  '  node cli.js archive-duplicates [repo-path] [--days N]   (keeps the newest session per name)',
  '  node cli.js rename-batch <mapping.json> [--keep-existing]   (JSON object: session id -> name)',
  '  node cli.js archive <repo-path> --name <name> [--days N] [--apply]   (preview unless --apply; running sessions are skipped)',
  '  node cli.js state [repo-path]   (favorites, names, saved tabs and whether their session files and processes exist)',
].join('\n');

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'state') {
    const repo = path.resolve(rest[0] || process.cwd());
    const state = readState(repo);
    const running = new Set([...(await readRunningSessions()).values()].map((r) => r.sessionId));
    const describe = async (id) => {
      const meta = await metaForSession(id);
      return `${id.slice(0, 8)} ${oneLine((state.names || {})[id] || (meta && (meta.customTitle || meta.aiTitle)) || '-', 30).padEnd(30)} ${meta ? 'file' : 'NO FILE'}${running.has(id) ? ' · running' : ''}`;
    };
    console.log('favorites:');
    for (const id of Object.keys(state.favorites || {})) console.log(`  ${await describe(id)}`);
    console.log('saved tabs:');
    for (const t of state.tabs || []) console.log(`  ${await describe(t.sessionId)} · tab "${t.name}" · group ${String(t.group).slice(0, 8)}`);
    console.log(`names ${Object.keys(state.names || {}).length} · archived ${Object.keys(state.archived || {}).length} · notifications ${(state.notifications || []).length}`);
    return 0;
  }
  if (command === 'rename' && rest.length === 2) {
    await renameSession(rest[0], rest[1]);
    console.log(`${rest[0]} -> ${rest[1]}`);
    return 0;
  }
  if (command === 'rename-batch' && rest.length >= 1) {
    const mapping = JSON.parse(fs.readFileSync(rest[0], 'utf8'));
    const keepExisting = rest.includes('--keep-existing');
    let failed = 0;
    for (const [id, name] of Object.entries(mapping)) {
      try {
        const meta = keepExisting ? await metaForSession(id) : null;
        if (meta && meta.customTitle && SLUG_RE.test(meta.customTitle)) throw new Error(`keeps its name "${meta.customTitle}"`);
        await renameSession(id, name);
        console.log(`renamed  ${id} -> ${name}`);
      } catch (err) {
        failed++;
        console.log(`skipped  ${id} -> ${name}: ${err.message}`);
      }
    }
    console.log(`${Object.keys(mapping).length - failed} renamed, ${failed} skipped`);
    return 0;
  }
  if (command === 'archive' && rest.length >= 3) {
    const nameIndex = rest.indexOf('--name');
    const daysIndex = rest.indexOf('--days');
    const name = nameIndex >= 0 ? rest[nameIndex + 1] : null;
    if (!name) {
      console.error(USAGE);
      return 1;
    }
    const days = daysIndex >= 0 ? Number(rest[daysIndex + 1]) : 30;
    const repo = path.resolve(rest[0]);
    const running = new Set([...(await readRunningSessions()).values()].map((r) => r.sessionId));
    const picked = pickByName(await listRepoSessions(repo, days), name, running);
    for (const s of picked) console.log(`${sessionSummary(s).padEnd(40)} | ${s.customTitle} | ${s.id}`);
    if (!rest.includes('--apply')) {
      console.log(`${picked.length} sessions would be archived (preview; add --apply)`);
      return 0;
    }
    const added = archiveInState(path.join(repo, '.vscode', 'claude-sessions.json'), picked.map((s) => s.id));
    console.log(`${added.length} archived, ${picked.length - added.length} were already archived`);
    return 0;
  }
  if (command === 'archive-duplicates') {
    const daysIndex = rest.indexOf('--days');
    const days = daysIndex >= 0 ? Number(rest[daysIndex + 1]) : 30;
    const repo = path.resolve(rest.find((a, i) => !a.startsWith('--') && rest[i - 1] !== '--days') || process.cwd());
    const moved = await archiveDuplicates(repo, days);
    const counts = moved.reduce((acc, m) => ({ ...acc, [m.name]: (acc[m.name] || 0) + 1 }), {});
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .forEach(([name, n]) => console.log(`${String(n).padStart(4)}  ${name}`));
    console.log(`${moved.length} older duplicates archived`);
    return 0;
  }
  if (command === 'search' && rest.length >= 1) {
    const daysIndex = rest.indexOf('--days');
    const days = daysIndex >= 0 ? Number(rest[daysIndex + 1]) : 30;
    const free = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--days');
    const repo = path.resolve(free[1] || process.cwd());
    const t0 = Date.now();
    const sessions = await listRepoSessions(repo, days);
    const t1 = Date.now();
    const hits = await searchSessions(sessions.map((m) => ({ id: m.id, title: m.customTitle || m.aiTitle || '', meta: m })), free[0]);
    const t2 = Date.now();
    for (const s of hits.slice(0, 15)) console.log(`${sessionSummary(s.meta).padEnd(28)} | ${oneLine(s.title || s.id, 50)}`);
    console.log(`${hits.length} of ${sessions.length} sessions match · list ${t1 - t0} ms · search ${t2 - t1} ms`);
    return 0;
  }
  if (command !== 'list') {
    console.error(USAGE);
    return 1;
  }
  const daysIndex = rest.indexOf('--days');
  const days = daysIndex >= 0 ? Number(rest[daysIndex + 1]) : 14;
  const json = rest.includes('--json');
  const repo = path.resolve(rest.find((a, i) => !a.startsWith('--') && rest[i - 1] !== '--days') || process.cwd());
  const sessions = await listRepoSessions(repo, days);
  if (json) {
    console.log(JSON.stringify(sessions.map(({ file, ...s }) => s), null, 2));
    return 0;
  }
  console.log(`${sessions.length} sessions in ${repo} (last ${days} days, newest message first)`);
  for (const s of sessions) {
    const title = s.customTitle || s.aiTitle || oneLine(s.firstPrompt || (s.lastUser && s.lastUser.text), 60) || s.id;
    console.log(`${sessionSummary(s).padEnd(40)} | ${oneLine(title, 60)} | ${s.id}`);
  }
  return 0;
}

main(process.argv.slice(2)).then((code) => process.exit(code));
