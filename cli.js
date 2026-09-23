#!/usr/bin/env node
'use strict';
const path = require('path');
const { listRepoSessions, sessionSummary, oneLine } = require('./sessions');

const USAGE = 'Usage: node cli.js list [repo-path] [--days N] [--json]';

async function main(argv) {
  const [command, ...rest] = argv;
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
