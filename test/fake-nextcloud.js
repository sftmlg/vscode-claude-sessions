'use strict';
const http = require('http');

function createFakeNextcloud({ loginName = 'david', appPassword = 'app-secret' } = {}) {
  const options = { ns: 'd', garbage: false, maxBody: Infinity, failKey: null, slowPut: null };
  const files = new Map();
  const folders = new Set(['']);
  const uploads = new Map();
  let approved = false;
  const prefix = `/remote.php/dav/files/${loginName}`;
  const uploadPrefix = `/remote.php/dav/uploads/${loginName}/`;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      if (options.slowPut && req.method === 'PUT' && req.url.endsWith(options.slowPut.suffix)) await new Promise((r) => setTimeout(r, options.slowPut.ms));
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
      if (body.length > options.maxBody) return res.writeHead(413).end();
      if (req.headers.authorization !== `Basic ${Buffer.from(`${loginName}:${appPassword}`).toString('base64')}`) return res.writeHead(401).end();
      const keyOf = (href) => decodeURIComponent(new URL(href, base).pathname.slice(prefix.length)).replace(/^\/|\/$/g, '');
      if (url.pathname.startsWith(uploadPrefix)) {
        const [id, chunk] = url.pathname.slice(uploadPrefix.length).split('/');
        if (req.method === 'MKCOL' && !chunk) {
          uploads.set(id, new Map());
          return res.writeHead(201).end();
        }
        if (!uploads.has(id)) return res.writeHead(404).end();
        if (req.method === 'PUT' && chunk) {
          uploads.get(id).set(Number(chunk), body);
          return res.writeHead(201).end();
        }
        if (req.method === 'MOVE' && chunk === '.file') {
          const parts = [...uploads.get(id).entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
          const whole = Buffer.concat(parts);
          if (Number(req.headers['oc-total-length']) !== whole.length) return res.writeHead(400).end();
          const target = keyOf(req.headers.destination);
          const existed = files.has(target);
          files.set(target, { body: whole, mtime: Number(req.headers['x-oc-mtime']) || Math.floor(Date.now() / 1000) });
          uploads.delete(id);
          return res.writeHead(existed ? 204 : 201).end();
        }
        if (req.method === 'DELETE' && !chunk) {
          uploads.delete(id);
          return res.writeHead(204).end();
        }
        return res.writeHead(405).end();
      }
      if (!url.pathname.startsWith(prefix)) return res.writeHead(404).end();
      const key = decodeURIComponent(url.pathname.slice(prefix.length)).replace(/^\/|\/$/g, '');
      const parent = key.split('/').slice(0, -1).join('/');
      if (options.failKey && key === options.failKey && req.method === 'PUT') return res.writeHead(507).end();
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
        if (req.headers['if-none-match'] === '*' && existed) return res.writeHead(412).end();
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
        const p = options.ns;
        const entry = (name, mtime) =>
          `<${p}:response><${p}:href>${prefix}/${encodeURI(name)}</${p}:href><${p}:propstat><${p}:prop><${p}:getlastmodified>${new Date(mtime * 1000).toUTCString()}</${p}:getlastmodified></${p}:prop></${p}:propstat></${p}:response>`;
        const children = [...files.entries()].filter(([k]) => k.split('/').slice(0, -1).join('/') === key).map(([k, v]) => entry(k, v.mtime));
        res.writeHead(207, { 'Content-Type': 'application/xml' });
        if (options.garbage) return res.end('<html>maintenance</html>');
        return res.end(`<?xml version="1.0"?><${p}:multistatus xmlns:${p}="DAV:">${entry(`${key}/`, Math.floor(Date.now() / 1000))}${children.join('')}</${p}:multistatus>`);
      }
      res.writeHead(405).end();
    });
  });

  return {
    files,
    options,
    uploads,
    approve: () => {
      approved = true;
    },
    creds: () => ({ server: `http://127.0.0.1:${server.address().port}`, loginName, appPassword }),
    start: () => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)),
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { createFakeNextcloud };
