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
  '  node cli.js sync login <nextcloud-url> --credentials <file>   (browser login, writes an app password to <file>)',
  '  node cli.js sync [repo-path] --credentials <file> [--folder <name>] [--recent-days N]   (same sync as the plugin: favorites both ways, every session of the last N days up from this machine; default 0 = favorites only, uploaded copies of other sessions removed)',
  '  node cli.js sync check --credentials <file>   (exit 0 when the app password is accepted, 1 when rejected)',
  '  node cli.js sync status --credentials <file> [--folder <name>]   (every repository folder in Nextcloud: favorites, files, locks, and which are missing here)',
  '  node cli.js sync list [repo-path] --credentials <file> [--since YYYY-MM-DD] [--json]   (every session of a repository in Nextcloud: favorites and recent ones of every machine, with machine, last sync and size)',
  '  node cli.js sync get <session-id or prefix> [repo-path] --credentials <file> [--out <file>]   (the newest copy in Nextcloud; stdout without --out)',
  '  node cli.js sync machines [repo-path] --credentials <file> [--folder <name>]   (the machine register of a repository: names, last seen, last sync, sessions, open requests)',
].join('\n');

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'sync') {
    const { syncFavorites, startLogin, finishLogin } = require('./sync');
    const credIndex = rest.indexOf('--credentials');
    const credFile = credIndex >= 0 ? rest[credIndex + 1] : process.env.CLAUDE_SESSIONS_CREDENTIALS;
    if (!credFile) {
      console.error('Pass --credentials <file> or set CLAUDE_SESSIONS_CREDENTIALS.');
      return 1;
    }
    if (rest[0] === 'login') {
      const { login, poll } = await startLogin(rest[1]);
      console.log(`Open this address, sign in and grant access:\n${login}`);
      const creds = await finishLogin(poll);
      fs.writeFileSync(credFile, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
      fs.chmodSync(credFile, 0o600);
      console.log(`connected as ${creds.loginName}; credentials written to ${credFile}`);
      return 0;
    }
    if (rest[0] === 'status') {
      const { WebDav, readRemoteStatus } = require('./sync');
      const folderAt = rest.indexOf('--folder');
      const status = await readRemoteStatus(new WebDav(JSON.parse(fs.readFileSync(credFile, 'utf8'))), folderAt >= 0 ? rest[folderAt + 1] : 'Claude Sessions');
      for (const repo of status) {
        console.log(`${repo.name}: ${repo.favorites.length} favorites · ${repo.files} files · ${repo.locks.length} locks`);
        for (const f of repo.favorites) console.log(`  ${f.here ? 'here   ' : 'missing'} ${f.id} ${f.name || ''}${f.file ? '' : ' (no file in Nextcloud)'}${f.lock ? ` 🔒 ${f.lock}` : ''}`);
      }
      return 0;
    }
    if (rest[0] === 'list' || rest[0] === 'get') {
      const { listRemoteSessions, getRemoteSession } = require('./sync');
      const valued = ['--credentials', '--folder', '--out', '--since'];
      const free = rest.slice(1).filter((a, i, all) => !a.startsWith('--') && !valued.includes(all[i - 1]));
      const folderAt = rest.indexOf('--folder');
      const opts = { creds: JSON.parse(fs.readFileSync(credFile, 'utf8')), folder: folderAt >= 0 ? rest[folderAt + 1] : undefined };
      if (rest[0] === 'list') {
        const sinceAt = rest.indexOf('--since');
        const since = sinceAt >= 0 ? Date.parse(rest[sinceAt + 1]) : 0;
        const list = (await listRemoteSessions({ ...opts, wsPath: path.resolve(free[0] || process.cwd()) })).filter((x) => (Date.parse(x.lastSync || x.lastActivity) || 0) >= since);
        if (rest.includes('--json')) console.log(JSON.stringify(list, null, 2));
        else for (const x of list) console.log(`${x.favorite ? '★' : '☆'} ${x.path ? `synced ${x.lastSync.slice(0, 16).replace('T', ' ')}` : `listed, active ${String(x.lastActivity || '').slice(0, 16).replace('T', ' ')}`}  ${(x.machine || '?').padEnd(18)} ${x.path ? `${(Math.round(x.bytes / 1e5) / 10).toString().padStart(6)} MB` : '        '}  ${x.id}  ${x.name || ''}`);
        return 0;
      }
      if (!free[0]) {
        console.error(USAGE);
        return 1;
      }
      const { session, body } = await getRemoteSession({ ...opts, wsPath: path.resolve(free[1] || process.cwd()), id: free[0] });
      const outAt = rest.indexOf('--out');
      if (outAt >= 0) {
        fs.writeFileSync(rest[outAt + 1], body);
        console.error(`${session.id} from ${session.machine || 'Nextcloud'} (${session.path}) written to ${rest[outAt + 1]}`);
      } else process.stdout.write(body);
      return 0;
    }
    if (rest[0] === 'machines') {
      const { WebDav, repoKey } = require('./sync');
      const folderAt = rest.indexOf('--folder');
      const folder = folderAt >= 0 ? rest[folderAt + 1] : 'Claude Sessions';
      const repo = path.resolve(rest.find((a, i) => i > 0 && !a.startsWith('--') && rest[i - 1] !== '--credentials' && rest[i - 1] !== '--folder') || process.cwd());
      const dav = new WebDav(JSON.parse(fs.readFileSync(credFile, 'utf8')));
      const base = [folder, repoKey(repo)];
      const read = async (sub) => {
        const out = [];
        for (const name of (await dav.list([...base, sub])).keys()) if (name.endsWith('.json')) out.push(await dav.getJson([...base, sub, name]));
        return out.filter(Boolean);
      };
      const [machines, requests] = await Promise.all([read('machines'), read('requests')]);
      const nameOf = (id) => (machines.find((m) => m.id === id) || {}).name || id;
      for (const m of machines) {
        console.log(`${m.name} (${m.id}) · seen ${m.lastSeen} · synced ${m.lastSync || 'never'} · ${(m.sessions || []).length} sessions`);
        for (const x of (m.sessions || []).slice(0, 10)) console.log(`  ${x.favorite ? '★' : '☆'} ${x.running ? '●' : ' '} ${x.id} ${x.name}`);
      }
      for (const r of requests) console.log(`request: ${r.sessionId} ${r.name || ''} from ${nameOf(r.from)} by ${nameOf(r.by)} at ${r.at}`);
      return 0;
    }
    if (rest[0] === 'check') {
      const { WebDav } = require('./sync');
      const creds = JSON.parse(fs.readFileSync(credFile, 'utf8'));
      const res = await fetch(new WebDav(creds).url([]), { method: 'PROPFIND', headers: { Authorization: new WebDav(creds).auth, Depth: '0' } });
      console.log(`${creds.loginName} on ${creds.server}: ${res.status === 207 ? 'connected' : `rejected (HTTP ${res.status})`}`);
      return res.status === 207 ? 0 : 1;
    }
    const folderIndex = rest.indexOf('--folder');
    const recentIndex = rest.indexOf('--recent-days');
    const repo = path.resolve(rest.find((a, i) => !a.startsWith('--') && !['--credentials', '--folder', '--recent-days'].includes(rest[i - 1])) || process.cwd());
    const running = new Set([...(await readRunningSessions()).values()].map((r) => r.sessionId));
    const result = await syncFavorites({
      creds: JSON.parse(fs.readFileSync(credFile, 'utf8')),
      wsPath: repo,
      stateFile: path.join(repo, '.vscode', 'claude-sessions.json'),
      folder: folderIndex >= 0 ? rest[folderIndex + 1] : undefined,
      running,
      recentDays: recentIndex >= 0 ? Number(rest[recentIndex + 1]) : 0,
    });
    console.log(`${result.favorites} favorites · ${result.downloaded.length} downloaded · ${result.uploaded.length} uploaded · ${result.recent.uploaded.length} recent uploaded · ${result.recent.pruned.length} recent removed · ${result.removed.length} removed · ${result.skippedRunning.length} kept because running here · ${result.locked.length} locked here · ${result.conflicts.length} locked elsewhere`);
    for (const f of result.forked) console.log(`forked: ${f.id} grew apart on ${f.machine}; this machine's copy is now ${f.forkId} "${f.name}"`);
    for (const d of result.diverged) console.log(`diverged: ${d.id} (${d.kept})`);
    const failed = result.failed.concat(result.recent.failed);
    for (const f of failed) console.log(`failed: ${f.id}: ${f.error}`);
    return failed.length ? 1 : 0;
  }
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

main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
  console.error(err.message);
  process.exit(1);
});
