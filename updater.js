'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const REPO = 'sftmlg/vscode-claude-sessions';

function parseVersion(v) {
  return String(v || '')
    .replace(/^v/, '')
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
}

function isNewer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'vscode-claude-sessions', Accept: 'application/vnd.github+json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(get(res.headers.location, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`GET ${url} returned ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(20000, () => req.destroy(new Error(`GET ${url} timed out`)));
    req.on('error', reject);
  });
}

const LATEST_TIMEOUT_MS = 10000;
const DOWNLOAD_TIMEOUT_MS = 60000;
const INSTALL_TIMEOUT_MS = 60000;

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function installedOnDisk(extensionId, version, dirs) {
  const prefix = `${String(extensionId).toLowerCase()}-${version}`;
  return dirs.some((dir) => {
    try {
      return fs.readdirSync(dir).some((name) => {
        const lower = name.toLowerCase();
        return lower === prefix || lower.startsWith(`${prefix}-`);
      });
    } catch {
      return false;
    }
  });
}

async function latestRelease(fetch = get, timeoutMs = LATEST_TIMEOUT_MS) {
  const body = await withTimeout(Promise.resolve(fetch(`https://api.github.com/repos/${REPO}/releases/latest`)), timeoutMs, 'release lookup');
  const release = JSON.parse(body.toString('utf8'));
  const asset = (release.assets || []).find((a) => a.name.endsWith('.vsix'));
  return asset ? { version: release.tag_name.replace(/^v/, ''), url: asset.browser_download_url } : null;
}

async function downloadRelease(release, dir, fetch = get, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `vscode-claude-sessions-${release.version}.vsix`);
  fs.writeFileSync(file, await withTimeout(Promise.resolve(fetch(release.url)), timeoutMs, 'download'));
  return file;
}

function activationDecision({ autoActivate, pendingVersion, currentVersion, busy = {} }) {
  if (!pendingVersion || !isNewer(pendingVersion, currentVersion)) return { activate: false, reason: 'nothing pending' };
  if (autoActivate === false) return { activate: false, reason: 'disabled' };
  const blocker = Object.keys(busy).find((k) => busy[k]);
  if (blocker) return { activate: false, reason: `busy: ${blocker}` };
  return { activate: true, reason: 'safe' };
}

module.exports = { activationDecision, isNewer, latestRelease, downloadRelease, installedOnDisk, withTimeout, INSTALL_TIMEOUT_MS, REPO };
