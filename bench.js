#!/usr/bin/env node
'use strict';
const path = require('path');
const os = require('os');
const sessions = require('./sessions');

const repo = path.resolve(process.argv[2] || process.cwd());
const query = process.argv[3] || 'invoice';
const storage = process.argv[4] || path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'sftmlg.vscode-claude-sessions');

async function step(label, fn) {
  const t0 = performance.now();
  const result = await fn();
  console.log(`${label.padEnd(34)} ${Math.round(performance.now() - t0)} ms`);
  return result;
}

async function main() {
  await step('load meta cache', () => sessions.loadCache(storage));
  await step('running sessions', () => sessions.readRunningSessions());
  const list = await step('list repo sessions (first)', () => sessions.listRepoSessions(repo, 30));
  await step('list repo sessions (second)', () => sessions.listRepoSessions(repo, 30));
  await step('load text cache', () => sessions.loadTextCache());
  await step(`conversation text x${list.length}`, async () => {
    for (const s of list) if (s.file) await sessions.conversationText(s.file).catch(() => '');
  });
  await step(`search "${query}"`, () => sessions.searchSessions(list.map((m) => ({ id: m.id, title: m.customTitle || '', meta: m })), query));

  const { createFakeVscode } = require('./test/fake-vscode');
  const fake = createFakeVscode({ workspacePath: repo, globalStoragePath: storage });
  const api = await step('activate extension', () => fake.activate());
  await step('render Inactive (first)', () => api.inactiveView.getChildren());
  api.inactiveView.refresh(true);
  await step('render Inactive (fast refresh)', () => api.inactiveView.getChildren());
  await step('render Active', () => api.activeView.getChildren());
  process.exit(0);
}

main();
