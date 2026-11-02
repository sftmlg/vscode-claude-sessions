'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isNewer, latestRelease, downloadRelease, activationDecision } = require('../updater');

test('version comparison', () => {
  assert.strictEqual(isNewer('0.13.0', '0.12.9'), true);
  assert.strictEqual(isNewer('v1.0.0', '0.99.0'), true);
  assert.strictEqual(isNewer('0.13.0', '0.13.0'), false);
  assert.strictEqual(isNewer('0.9.0', '0.10.0'), false);
});

test('latest release picks the vsix asset and downloads it', async () => {
  const fetch = async (url) =>
    url.includes('/releases/latest')
      ? Buffer.from(JSON.stringify({ tag_name: 'v0.20.0', assets: [{ name: 'notes.txt' }, { name: 'x.vsix', browser_download_url: 'https://example.test/x.vsix' }] }))
      : Buffer.from('VSIX');
  const release = await latestRelease(fetch);
  assert.deepStrictEqual(release, { version: '0.20.0', url: 'https://example.test/x.vsix' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-updater-'));
  const file = await downloadRelease(release, dir, fetch);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'VSIX');
});

test('activation decision: only a newer pending version, enabled, and nothing busy', () => {
  const base = { autoActivate: true, pendingVersion: '0.40.0', currentVersion: '0.39.0', busy: {} };
  assert.deepStrictEqual(activationDecision(base), { activate: true, reason: 'safe' });
  assert.strictEqual(activationDecision({ ...base, pendingVersion: null }).activate, false);
  assert.strictEqual(activationDecision({ ...base, pendingVersion: '0.39.0' }).activate, false);
  assert.strictEqual(activationDecision({ ...base, autoActivate: false }).reason, 'disabled');
  assert.deepStrictEqual(activationDecision({ ...base, busy: { command: false, sync: true } }), { activate: false, reason: 'busy: sync' });
});

test('installedOnDisk finds the versioned extension folder', () => {
  const { installedOnDisk } = require('../updater');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ext-'));
  fs.mkdirSync(path.join(dir, 'sftmlg.vscode-claude-sessions-0.41.0'));
  assert.strictEqual(installedOnDisk('sftmlg.vscode-claude-sessions', '0.41.0', [dir]), true);
  assert.strictEqual(installedOnDisk('sftmlg.vscode-claude-sessions', '0.4.0', [dir]), false);
  assert.strictEqual(installedOnDisk('sftmlg.vscode-claude-sessions', '0.41.0', [path.join(dir, 'missing')]), false);
});

test('release lookup and download time out', async () => {
  const hang = () => new Promise(() => {});
  await assert.rejects(latestRelease(hang, 30), /timed out/);
  await assert.rejects(downloadRelease({ version: '1.0.0', url: 'x' }, fs.mkdtempSync(path.join(os.tmpdir(), 'claude-updater-')), hang, 30), /timed out/);
});

test('a restart that came back on the old version is recognised, a stale or loaded one is not', () => {
  const { recordRestart, failedRestart } = require('../updater');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-restart-'));
  assert.strictEqual(failedRestart(dir, '0.42.0'), null);
  recordRestart(dir, '0.43.0');
  assert.strictEqual(failedRestart(dir, '0.42.0'), '0.43.0');
  assert.strictEqual(failedRestart(dir, '0.43.0'), null);
  assert.strictEqual(failedRestart(dir, '0.42.0', Date.now() + 10 * 60 * 1000), null);
});

test('activation decision refuses a version whose restart did not load it', () => {
  const base = { autoActivate: true, pendingVersion: '0.43.0', currentVersion: '0.42.0', busy: {} };
  assert.deepStrictEqual(activationDecision({ ...base, failedVersion: '0.43.0' }), { activate: false, reason: 'restart did not load it' });
  assert.strictEqual(activationDecision({ ...base, failedVersion: '0.41.0' }).activate, true);
});

test('only one window claims the install of a version', () => {
  const { claimInstall } = require('../updater');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-claim-'));
  assert.strictEqual(claimInstall(dir, '0.43.0'), true);
  assert.strictEqual(claimInstall(dir, '0.43.0'), false);
  assert.strictEqual(claimInstall(dir, '0.44.0'), true);
  assert.strictEqual(claimInstall(dir, '0.43.0', Date.now() + 10 * 60 * 1000), true, 'a stale claim is taken over');
});
