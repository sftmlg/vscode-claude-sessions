'use strict';
const fs = require('fs');
const path = require('path');

const MAX_BACKUPS = 336;

function backupsFile(stateFile) {
  const ext = path.extname(stateFile);
  return path.join(path.dirname(stateFile), `${path.basename(stateFile, ext)}-backups${ext || '.json'}`);
}

function readBackups(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data.backups) ? data.backups : [];
  } catch {
    return [];
  }
}

function constellation(tabs) {
  const groupIndex = new Map();
  return JSON.stringify(
    tabs.map((t) => {
      const key = t.group || t.sessionId;
      if (!groupIndex.has(key)) groupIndex.set(key, groupIndex.size);
      return [t.sessionId, t.name, groupIndex.get(key)];
    })
  );
}

function takeBackup(file, tabs, { at = new Date().toISOString(), label } = {}) {
  const clean = (tabs || []).filter((t) => t && t.sessionId).map((t) => ({ name: t.name, sessionId: t.sessionId, cwd: t.cwd, group: t.group || t.sessionId }));
  if (!clean.length) return null;
  const backups = readBackups(file);
  const latest = backups.reduce((a, b) => (!a || b.at > a.at ? b : a), null);
  if (latest && constellation(latest.tabs) === constellation(clean)) return null;
  const entry = { at, tabs: clean, ...(label ? { label } : {}) };
  const next = backups.concat(entry).sort((a, b) => (a.at < b.at ? -1 : 1)).slice(-MAX_BACKUPS);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, backups: next }, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return entry;
}

function splitsOf(tabs) {
  const groups = new Map();
  for (const t of tabs) {
    const key = t.group || t.sessionId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  return [...groups.values()];
}

module.exports = { backupsFile, readBackups, takeBackup, constellation, splitsOf, MAX_BACKUPS };
