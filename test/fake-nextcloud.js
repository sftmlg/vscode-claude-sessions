'use strict';
const http = require('http');

function createFakeNextcloud({ loginName = 'david', appPassword = 'app-secret' } = {}) {
  const files = new Map();
  const folders = new Set(['']);
  let approved = false;
  const prefix = `/remote.php/dav/files/${loginName}`;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      const base = `http://127.0.0.1:${server.address().port}`;
      if (url.pathname === '/index.php/login/v2' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ poll: { token: 'poll-token', endpoint: `${base}/login/v2/poll` }, login: `${base}/login/v2/flow/abc` }));
      }
      if (url.pathname === '/login/v2/poll' && req.method === 'POST') {
        if (!approved || !body.toString().includes('token=poll-token')) return res.writeHead(404).end();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ server: base, loginName, appPassword }));
      }
      if (!url.pathname.startsWith(prefix)) return res.writeHead(404).end();
      if (req.headers.authorization !== `Basic ${Buffer.from(`${loginName}:${appPassword}`).toString('base64')}`) return res.writeHead(401).end();
      const key = decodeURIComponent(url.pathname.slice(prefix.length)).replace(/^\/|\/$/g, '');
      const parent = key.split('/').slice(0, -1).join('/');
      if (req.method === 'MKCOL') {
        if (folders.has(key)) return res.writeHead(405).end();
        if (!folders.has(parent)) return res.writeHead(409).end();
        folders.add(key);
        return res.writeHead(201).end();
      }
      if (req.method === 'PUT') {
        if (!folders.has(parent)) return res.writeHead(409).end();
        const mtime = Number(req.headers['x-oc-mtime']) || Math.floor(Date.now() / 1000);
        const existed = files.has(key);
        files.set(key, { body, mtime });
        return res.writeHead(existed ? 204 : 201).end();
      }
      if (req.method === 'GET') {
        if (!files.has(key)) return res.writeHead(404).end();
        res.writeHead(200);
        return res.end(files.get(key).body);
      }
      if (req.method === 'DELETE') {
        if (!files.delete(key)) return res.writeHead(404).end();
        return res.writeHead(204).end();
      }
      if (req.method === 'PROPFIND') {
        if (!folders.has(key)) return res.writeHead(404).end();
        const entry = (name, mtime) =>
          `<d:response><d:href>${prefix}/${encodeURI(name)}</d:href><d:propstat><d:prop><d:getlastmodified>${new Date(mtime * 1000).toUTCString()}</d:getlastmodified></d:prop></d:propstat></d:response>`;
        const children = [...files.entries()].filter(([k]) => k.split('/').slice(0, -1).join('/') === key).map(([k, v]) => entry(k, v.mtime));
        res.writeHead(207, { 'Content-Type': 'application/xml' });
        return res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${children.join('')}</d:multistatus>`);
      }
      res.writeHead(405).end();
    });
  });

  return {
    files,
    approve: () => {
      approved = true;
    },
    creds: () => ({ server: `http://127.0.0.1:${server.address().port}`, loginName, appPassword }),
    start: () => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)),
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { createFakeNextcloud };
