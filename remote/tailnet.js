'use strict';
const { execFile } = require('child_process');

const TAILSCALE_APP = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const TTL_MS = 60000;

function node(n) {
  if (!n || !n.DNSName) return null;
  return { name: String(n.HostName || n.DNSName.split('.')[0]), dns: String(n.DNSName).replace(/\.$/, ''), ips: Array.isArray(n.TailscaleIPs) ? n.TailscaleIPs.map(String) : [] };
}

function parseStatus(j) {
  if (!j || typeof j !== 'object') return { self: null, peers: [] };
  return { self: node(j.Self), peers: Object.values(j.Peer || {}).map(node).filter(Boolean) };
}

function runStatus(file) {
  return new Promise((resolve, reject) => {
    execFile(file, ['status', '--json'], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function readStatus() {
  try {
    return await runStatus('tailscale');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return runStatus(TAILSCALE_APP);
  }
}

class Tailnet {
  constructor({ read = readStatus, ttlMs = TTL_MS } = {}) {
    this.read = read;
    this.ttlMs = ttlMs;
    this.cached = null;
  }

  async map() {
    if (this.cached && Date.now() - this.cached.at < this.ttlMs) return this.cached.map;
    let map;
    try {
      map = parseStatus(await this.read());
    } catch {
      map = { self: null, peers: [] };
    }
    this.cached = { at: Date.now(), map };
    return map;
  }

  async viewerHost(forwarded) {
    const ip = String(forwarded || '').split(',')[0].trim().replace(/^::ffff:/, '');
    if (!ip) return null;
    const { self, peers } = await this.map();
    const hit = [self, ...peers].find((n) => n && n.ips.includes(ip));
    return hit ? hit.dns : null;
  }

  async selfName() {
    const { self } = await this.map();
    return self ? self.name : null;
  }
}

module.exports = { Tailnet, parseStatus };
