#!/usr/bin/env node
'use strict';
const path = require('path');
const fs = require('fs');
const { listRepoSessions, sessionSummary, oneLine, renameSession, metaForSession, SLUG_RE } = require('./sessions');

const USAGE = [
  'Usage:',
  '  node cli.js list [repo-path] [--days N] [--json]',
  '  node cli.js rename <session-id> <name>',
  '  node cli.js rename-batch <mapping.json> [--keep-existing]   (JSON object: session id -> name)',
].join('\n');

async function main(argv) {
  const [command, ...rest] = argv;
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
