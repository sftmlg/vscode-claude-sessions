'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseStatus, Tailnet } = require('../tailnet');

const status = {
  Self: { HostName: 'studio', DNSName: 'studio.tail0.example.test.', TailscaleIPs: ['100.64.0.1', 'fd7a::1'] },
  Peer: {
    a: { HostName: 'laptop', DNSName: 'laptop.tail0.example.test.', TailscaleIPs: ['100.64.0.2'] },
    b: { HostName: 'phone', DNSName: 'phone.tail0.example.test.', TailscaleIPs: ['100.64.0.3'] },
    c: { HostName: 'broken' },
  },
};

test('status parsing keeps names, DNS names without the trailing dot and IPs', () => {
  const map = parseStatus(status);
  assert.deepStrictEqual(map.self, { name: 'studio', dns: 'studio.tail0.example.test', ips: ['100.64.0.1', 'fd7a::1'] });
  assert.deepStrictEqual(map.peers.map((p) => p.dns), ['laptop.tail0.example.test', 'phone.tail0.example.test']);
  assert.deepStrictEqual(parseStatus(null), { self: null, peers: [] });
});

test('the viewer machine is found by its tailnet IP, the hub itself included', async () => {
  let calls = 0;
  const net = new Tailnet({ read: async () => (calls++, status), ttlMs: 60000 });
  assert.strictEqual(await net.viewerHost('100.64.0.2'), 'laptop.tail0.example.test');
  assert.strictEqual(await net.viewerHost('::ffff:100.64.0.1'), 'studio.tail0.example.test');
  assert.strictEqual(await net.viewerHost('100.64.0.2, 10.0.0.1'), 'laptop.tail0.example.test', 'first address of a forwarded list');
  assert.strictEqual(await net.viewerHost('8.8.8.8'), null);
  assert.strictEqual(await net.viewerHost(undefined), null);
  assert.strictEqual(await net.selfName(), 'studio');
  assert.strictEqual(calls, 1, 'status is cached');
  const failing = new Tailnet({ read: async () => { throw new Error('no tailscale'); } });
  assert.strictEqual(await failing.viewerHost('100.64.0.2'), null);
  assert.strictEqual(await failing.selfName(), null);
});
