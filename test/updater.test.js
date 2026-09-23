'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isNewer, latestRelease, downloadRelease } = require('../updater');

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
