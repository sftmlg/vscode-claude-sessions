#!/usr/bin/env node
// Usage: nextcloud-e2e.mjs --credentials <file> [--repo <path>] [--folder <name>] — exit 0 all checks passed, 1 a check failed, 2 usage.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const credFile = flag('--credentials') || process.env.CLAUDE_SESSIONS_CREDENTIALS;
const repo = path.resolve(flag('--repo') || process.cwd());
const folder = flag('--folder') || 'Claude Sessions';
if (!credFile) {
  console.error('usage: nextcloud-e2e.mjs --credentials <file> [--repo <path>] [--folder <name>]');
  process.exit(2);
}

const creds = JSON.parse(fs.readFileSync(credFile, 'utf8'));
const { WebDav, syncFavorites, repoKey } = require('../sync');
const sessions = require('../sessions');
const dav = new WebDav(creds);
const parts = [folder, repoKey(repo)];
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(52)} ${detail}`);
};

const state = JSON.parse(fs.readFileSync(path.join(repo, '.vscode', 'claude-sessions.json'), 'utf8'));
const favorites = Object.keys(state.favorites || {});

console.log('== 1 refused without credentials ==');
const anon = await fetch(dav.url(parts), { method: 'PROPFIND', headers: { Depth: '1' } });
check('folder listing without login', anon.status === 401, String(anon.status));

console.log('== 2 every favorite is on the server ==');
const remote = await dav.list(parts);
const missing = favorites.filter((id) => !remote.has(`${id}.jsonl`));
check(`${favorites.length} favorites present`, missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : `${remote.size} entries`);
check('state.json present', remote.has('state.json'));

console.log('== 3 byte-identical to the local file at upload time ==');
let identical = 0;
let newerLocally = 0;
for (const id of favorites) {
  if (!remote.has(`${id}.jsonl`)) continue;
  const files = await sessions.filesForSession(id);
  const local = files.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
  const localSec = Math.floor(local.mtimeMs / 1000);
  if (localSec > remote.get(`${id}.jsonl`).mtimeSec) {
    newerLocally++;
    continue;
  }
  if (sha(await dav.get([...parts, `${id}.jsonl`])) === sha(fs.readFileSync(local.file))) identical++;
}
check('unchanged sessions identical on the server', identical + newerLocally === favorites.length, `${identical} identical, ${newerLocally} changed locally since (a running session keeps writing; next sync uploads it)`);

console.log('== 4 private: owned by this user, shared with nobody ==');
const ownerRes = await fetch(dav.url(parts), {
  method: 'PROPFIND',
  headers: { Authorization: dav.auth, Depth: '0', 'Content-Type': 'application/xml' },
  body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:owner-id/><oc:share-types/></d:prop></d:propfind>',
});
const ownerXml = await ownerRes.text();
const owner = (ownerXml.match(/<oc:owner-id>([^<]+)<\/oc:owner-id>/) || [])[1];
check('folder owner is the signed-in user', owner === creds.loginName, owner === creds.loginName ? 'yes' : `owner ${owner}`);
check('no share type on the folder', !/<oc:share-type>/.test(ownerXml));
const ocs = await fetch(`${creds.server}/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json&path=${encodeURIComponent(`/${folder}`)}&reshares=true&subfiles=true`, {
  headers: { Authorization: dav.auth, 'OCS-APIRequest': 'true' },
});
const shares = ocs.status === 200 ? (await ocs.json()).ocs.data : null;
check('no shares on the folder or anything in it', Array.isArray(shares) && shares.length === 0, shares ? `${shares.length} shares` : `OCS ${ocs.status}`);
const all = await fetch(`${creds.server}/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json&reshares=true`, { headers: { Authorization: dav.auth, 'OCS-APIRequest': 'true' } });
const allShares = all.status === 200 ? (await all.json()).ocs.data : [];
check('no share anywhere points into the folder', !allShares.some((s) => String(s.path || '').startsWith(`/${folder}`)), `${allShares.length} shares in the account`);

console.log('== 5 a second machine receives everything ==');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-e2e-'));
const secondWs = path.join(root, 'elsewhere', path.basename(repo));
fs.mkdirSync(path.join(secondWs, '.vscode'), { recursive: true });
const realHome = process.env.HOME;
process.env.HOME = path.join(root, 'home');
fs.mkdirSync(process.env.HOME);
try {
  const stateFile = path.join(secondWs, '.vscode', 'claude-sessions.json');
  const result = await syncFavorites({ creds, wsPath: secondWs, stateFile, folder });
  check('all favorites downloaded to the fresh machine', result.downloaded.length === favorites.length, `${result.downloaded.length}/${favorites.length}`);
  check('nothing uploaded from the fresh machine', result.uploaded.length === 0, String(result.uploaded.length));
  const secondState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  check('stars arrive', favorites.every((id) => secondState.favorites[id]), `${Object.keys(secondState.favorites).length} stars`);
  const named = favorites.filter((id) => (state.names || {})[id]);
  check('names arrive', named.every((id) => secondState.names[id] === state.names[id]), `${named.length} names`);
  const listed = await sessions.listRepoSessions(secondWs, 3650);
  check('the plugin lists them on the fresh machine', favorites.every((id) => listed.some((m) => m.id === id)), `${listed.length} sessions listed`);
} finally {
  process.env.HOME = realHome;
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failed ? `\nnextcloud e2e: ${failed} check(s) failed` : '\nnextcloud e2e: all checks passed');
process.exit(failed ? 1 : 0);
