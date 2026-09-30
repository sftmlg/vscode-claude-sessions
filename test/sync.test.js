'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFakeNextcloud } = require('./fake-nextcloud');
const { syncFavorites, startLogin, finishLogin, projectDir, readLock, LOCK_TTL_MS } = require('../sync');

const originalHome = process.env.HOME;
delete process.env.CLAUDE_CONFIG_DIR;

function machine(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `claude-sync-${label}-`));
  const home = path.join(root, 'home');
  const ws = path.join(root, 'code', label === 'a' ? 'deep' : 'other', 'my-repo');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(ws, '.vscode'), { recursive: true });
  return { home, ws, stateFile: path.join(ws, '.vscode', 'claude-sessions.json') };
}

function use(m) {
  process.env.HOME = m.home;
}

function writeSession(m, id, text, mtimeSec) {
  use(m);
  const dir = projectDir(m.ws);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', cwd: m.ws, message: { content: text } })}\n`);
  if (mtimeSec) fs.utimesSync(file, mtimeSec, mtimeSec);
  return file;
}

function appendLine(m, id, text, mtimeSec = Math.floor(Date.now() / 1000)) {
  use(m);
  const file = path.join(projectDir(m.ws), `${id}.jsonl`);
  fs.appendFileSync(file, `${JSON.stringify({ type: 'user', sessionId: id, message: { content: text } })}\n`);
  fs.utimesSync(file, mtimeSec, mtimeSec);
  return file;
}

function writeState(m, state) {
  fs.writeFileSync(m.stateFile, JSON.stringify(state));
}

const readState = (m) => JSON.parse(fs.readFileSync(m.stateFile, 'utf8'));
const F1 = '11111111-aaaa-0000-0000-000000000001';
const F2 = '22222222-aaaa-0000-0000-000000000002';
const N1 = '33333333-aaaa-0000-0000-000000000003';

test.after(() => {
  process.env.HOME = originalHome;
});

test('favorites move from one machine to another and back, stars and names included', async () => {
  const cloud = createFakeNextcloud();
  await cloud.start();
  try {
    const a = machine('a');
    const b = machine('b');
    const t0 = Math.floor(Date.now() / 1000) - 3600;
    const f1 = writeSession(a, F1, 'kreil tickets', t0);
    writeSession(a, F2, 'diwa', t0);
    writeSession(a, N1, 'not a favorite', t0);
    writeState(a, { favorites: { [F1]: true, [F2]: true }, names: { [F1]: 'kreil', [F2]: 'diwa', [N1]: 'misc' } });

    use(a);
    const pushed = await syncFavorites({ creds: cloud.creds(), wsPath: a.ws, stateFile: a.stateFile });
    assert.deepStrictEqual(pushed.uploaded.sort(), [F1, F2].sort());
    assert.ok(!cloud.files.has(`Claude Sessions/my-repo/${N1}.jsonl`), 'non-favorites stay local');
    assert.deepStrictEqual(cloud.files.get(`Claude Sessions/my-repo/${F1}.jsonl`).body, fs.readFileSync(f1), 'byte-identical upload');

    use(b);
    const pulled = await syncFavorites({ creds: cloud.creds(), wsPath: b.ws, stateFile: b.stateFile });
    assert.deepStrictEqual(pulled.downloaded.sort(), [F1, F2].sort());
    const onB = path.join(projectDir(b.ws), `${F1}.jsonl`);
    assert.deepStrictEqual(fs.readFileSync(onB), fs.readFileSync(f1), 'identical on the second machine');
    assert.strictEqual(Math.floor(fs.statSync(onB).mtimeMs / 1000), t0, 'modification time kept');
    assert.deepStrictEqual(readState(b).favorites, { [F1]: true, [F2]: true });
    assert.deepStrictEqual(readState(b).names, { [F1]: 'kreil', [F2]: 'diwa' });

    const again = await syncFavorites({ creds: cloud.creds(), wsPath: b.ws, stateFile: b.stateFile });
    assert.deepStrictEqual([again.downloaded, again.uploaded], [[], []], 'a second sync transfers nothing');

    const st = readState(b);
    delete st.favorites[F2];
    writeState(b, st);
    fs.appendFileSync(onB, `${JSON.stringify({ type: 'user', message: { content: 'continued on b' } })}\n`);
    const later = Math.floor(Date.now() / 1000);
    fs.utimesSync(onB, later, later);
    const fromB = await syncFavorites({ creds: cloud.creds(), wsPath: b.ws, stateFile: b.stateFile });
    assert.deepStrictEqual(fromB.uploaded, [F1]);
    assert.deepStrictEqual(fromB.removed, [F2]);
    assert.ok(!cloud.files.has(`Claude Sessions/my-repo/${F2}.jsonl`));

    use(a);
    const backOnA = await syncFavorites({ creds: cloud.creds(), wsPath: a.ws, stateFile: a.stateFile });
    assert.deepStrictEqual(backOnA.downloaded, [F1], 'the continued session comes back');
    assert.match(fs.readFileSync(f1, 'utf8'), /continued on b/);
    assert.deepStrictEqual(readState(a).favorites, { [F1]: true }, 'the removed star is removed here too');
    assert.strictEqual(readState(a).names[N1], 'misc', 'local names of other sessions stay');
  } finally {
    await cloud.stop();
  }
});

test('a session running on this machine is never overwritten by a download', async () => {
  const cloud = createFakeNextcloud();
  await cloud.start();
  try {
    const a = machine('a');
    const b = machine('b');
    writeSession(a, F1, 'fresh on a', Math.floor(Date.now() / 1000));
    writeState(a, { favorites: { [F1]: true } });
    use(a);
    await syncFavorites({ creds: cloud.creds(), wsPath: a.ws, stateFile: a.stateFile });
    const onB = writeSession(b, F1, 'running on b', Math.floor(Date.now() / 1000) - 7200);
    writeState(b, { favorites: { [F1]: true } });
    use(b);
    const r = await syncFavorites({ creds: cloud.creds(), wsPath: b.ws, stateFile: b.stateFile, running: new Set([F1]) });
    assert.deepStrictEqual(r.diverged.map((d) => d.id), [F1], 'two different histories: reported, not resolved while running');
    assert.match(fs.readFileSync(onB, 'utf8'), /running on b/);
  } finally {
    await cloud.stop();
  }
});

test('the login flow hands out an app password only after the browser login', async () => {
  const cloud = createFakeNextcloud();
  await cloud.start();
  try {
    const { login, poll } = await startLogin(cloud.creds().server);
    assert.match(login, /login\/v2\/flow/);
    await assert.rejects(finishLogin(poll, { timeoutMs: 300, intervalMs: 50 }), /not completed/);
    setTimeout(() => cloud.approve(), 100);
    const creds = await finishLogin(poll, { timeoutMs: 3000, intervalMs: 50 });
    assert.deepStrictEqual(creds, cloud.creds());
  } finally {
    await cloud.stop();
  }
});

async function seeded() {
  const cloud = createFakeNextcloud();
  await cloud.start();
  const a = machine('a');
  writeSession(a, F1, 'one', Math.floor(Date.now() / 1000) - 600);
  writeSession(a, F2, 'two', Math.floor(Date.now() / 1000) - 600);
  writeState(a, { favorites: { [F1]: true, [F2]: true } });
  use(a);
  await syncFavorites({ creds: cloud.creds(), wsPath: a.ws, stateFile: a.stateFile });
  return { cloud, a };
}

test('a listing with another XML prefix is read, not taken as an empty folder', async () => {
  const { cloud, a } = await seeded();
  try {
    cloud.options.ns = 'ns1';
    const r = await syncFavorites({ creds: cloud.creds(), wsPath: a.ws, stateFile: a.stateFile });
    assert.deepStrictEqual(readState(a).favorites, { [F1]: true, [F2]: true }, 'no star lost');
    assert.deepStrictEqual(r.removed, []);
  } finally {
    await cloud.stop();
  }
});

test('an unreadable listing stops the sync instead of dropping stars', async () => {
  const { cloud, a } = await seeded();
  try {
    cloud.options.garbage = true;
    await assert.rejects(syncFavorites({ creds: cloud.creds(), wsPath: a.ws, stateFile: a.stateFile }), /listing/);
    assert.deepStrictEqual(readState(a).favorites, { [F1]: true, [F2]: true });
  } finally {
    await cloud.stop();
  }
});

test('a star removed while a sync runs stays removed, here and on the server', async () => {
  const { cloud, a } = await seeded();
  try {
    let toggled = false;
    const fetchImpl = async (url, init) => {
      if (!toggled && init.method === 'PUT') {
        toggled = true;
        const st = readState(a);
        delete st.favorites[F2];
        writeState(a, st);
      }
      return fetch(url, init);
    };
    appendLine(a, F1, 'one continued');
    await syncFavorites({ creds: cloud.creds(), wsPath: a.ws, stateFile: a.stateFile, fetchImpl });
    assert.ok(toggled);
    assert.deepStrictEqual(readState(a).favorites, { [F1]: true });
    const remoteState = JSON.parse(cloud.files.get('Claude Sessions/my-repo/state.json').body.toString());
    assert.deepStrictEqual(remoteState.favorites, { [F1]: true });
  } finally {
    await cloud.stop();
  }
});

test('a second sync of the same repository at the same time is refused, not interleaved', async () => {
  const { cloud, a } = await seeded();
  try {
    const both = await Promise.allSettled([
      syncFavorites({ creds: cloud.creds(), wsPath: a.ws, stateFile: a.stateFile }),
      syncFavorites({ creds: cloud.creds(), wsPath: a.ws, stateFile: a.stateFile }),
    ]);
    assert.strictEqual(both.filter((r) => r.status === 'fulfilled').length, 1);
    assert.match(both.find((r) => r.status === 'rejected').reason.message, /already running/);
    await syncFavorites({ creds: cloud.creds(), wsPath: a.ws, stateFile: a.stateFile });
  } finally {
    await cloud.stop();
  }
});

test('only complete lines of a session that is still being written are uploaded', async () => {
  const { cloud, a } = await seeded();
  try {
    const file = writeSession(a, F1, 'complete', Math.floor(Date.now() / 1000));
    fs.appendFileSync(file, '{"type":"assistant","message":{"content":"half');
    await syncFavorites({ creds: cloud.creds(), wsPath: a.ws, stateFile: a.stateFile });
    const uploaded = cloud.files.get(`Claude Sessions/my-repo/${F1}.jsonl`).body.toString();
    assert.ok(uploaded.endsWith('\n'));
    assert.ok(!uploaded.includes('half'));
  } finally {
    await cloud.stop();
  }
});

test('a session larger than one request may carry arrives complete, uploaded in chunks', async () => {
  const cloud = createFakeNextcloud();
  await cloud.start();
  try {
    cloud.options.maxBody = 1500;
    const a = machine('a');
    const t0 = Math.floor(Date.now() / 1000) - 600;
    const file = writeSession(a, F1, 'x'.repeat(4800), t0);
    writeState(a, { favorites: { [F1]: true } });
    use(a);
    const r = await syncFavorites({ creds: cloud.creds(), wsPath: a.ws, stateFile: a.stateFile, chunkBytes: 1000 });
    assert.deepStrictEqual(r.uploaded, [F1]);
    assert.deepStrictEqual(r.failed, []);
    const stored = cloud.files.get(`Claude Sessions/my-repo/${F1}.jsonl`);
    assert.deepStrictEqual(stored.body, fs.readFileSync(file), 'byte-identical after reassembly');
    assert.strictEqual(stored.mtime, t0, 'modification time kept');
    assert.strictEqual(cloud.uploads.size, 0, 'no half-finished upload left behind');
  } finally {
    await cloud.stop();
  }
});

test('one session that cannot be uploaded does not stop the others', async () => {
  const cloud = createFakeNextcloud();
  await cloud.start();
  try {
    const a = machine('a');
    const t0 = Math.floor(Date.now() / 1000) - 600;
    writeSession(a, F1, 'blocked', t0);
    writeSession(a, F2, 'fine', t0);
    writeState(a, { favorites: { [F1]: true, [F2]: true } });
    cloud.options.failKey = `Claude Sessions/my-repo/${F1}.jsonl`;
    use(a);
    const r = await syncFavorites({ creds: cloud.creds(), wsPath: a.ws, stateFile: a.stateFile });
    assert.deepStrictEqual(r.uploaded, [F2]);
    assert.deepStrictEqual(r.failed.map((f) => f.id), [F1]);
    assert.match(r.failed[0].error, /507/);
    assert.ok(cloud.files.has(`Claude Sessions/my-repo/${F2}.jsonl`));
    cloud.options.failKey = null;
    const again = await syncFavorites({ creds: cloud.creds(), wsPath: a.ws, stateFile: a.stateFile });
    assert.deepStrictEqual(again.uploaded, [F1], 'the failed one goes up on the next run');
  } finally {
    await cloud.stop();
  }
});

test('wrong credentials fail loudly instead of syncing nothing', async () => {
  const cloud = createFakeNextcloud();
  await cloud.start();
  try {
    const a = machine('a');
    writeState(a, { favorites: {} });
    use(a);
    await assert.rejects(syncFavorites({ creds: { ...cloud.creds(), appPassword: 'wrong' }, wsPath: a.ws, stateFile: a.stateFile }), /HTTP 401/);
  } finally {
    await cloud.stop();
  }
});

const lockOf = (cloud, id) => {
  const f = cloud.files.get(`Claude Sessions/my-repo/locks/${id}.json`);
  return f ? JSON.parse(f.body.toString()) : null;
};

test('the machine a session runs on locks it; the other machine reads it but never uploads over it', async () => {
  const { cloud, a } = await seeded();
  try {
    const b = machine('b');
    writeState(b, {});
    use(a);
    appendLine(a, F1, 'working on a');
    const onA = await syncFavorites({ creds: cloud.creds(), wsPath: a.ws, stateFile: a.stateFile, running: new Set([F1]), machine: 'mac-a' });
    assert.deepStrictEqual(onA.locked, [F1]);
    assert.strictEqual(lockOf(cloud, F1).machine, 'mac-a');
    assert.deepStrictEqual(onA.uploaded, [F1], 'the lock holder feeds its session upward');

    use(b);
    const pulled = await syncFavorites({ creds: cloud.creds(), wsPath: b.ws, stateFile: b.stateFile, machine: 'mac-b' });
    assert.ok(pulled.downloaded.includes(F1), 'a locked session is still downloaded as a read copy');
    assert.strictEqual(readState(b).sync.locks[F1].machine, 'mac-a', 'the lock is known locally for the view and the resume warning');

    const onB = path.join(projectDir(b.ws), `${F1}.jsonl`);
    fs.appendFileSync(onB, `${JSON.stringify({ type: 'user', message: { content: 'also on b' } })}\n`);
    const conflict = await syncFavorites({ creds: cloud.creds(), wsPath: b.ws, stateFile: b.stateFile, running: new Set([F1]), machine: 'mac-b' });
    assert.deepStrictEqual(conflict.conflicts, [{ id: F1, machine: 'mac-a' }]);
    assert.ok(!conflict.uploaded.includes(F1), 'the second machine never overwrites the locked session');
    assert.doesNotMatch(cloud.files.get(`Claude Sessions/my-repo/${F1}.jsonl`).body.toString(), /also on b/);
    assert.strictEqual(lockOf(cloud, F1).machine, 'mac-a', 'first lock keeps precedence');

    use(a);
    const released = await syncFavorites({ creds: cloud.creds(), wsPath: a.ws, stateFile: a.stateFile, machine: 'mac-a' });
    assert.deepStrictEqual(released.released, [F1]);
    assert.strictEqual(lockOf(cloud, F1), null, 'the lock goes once the session stops');
  } finally {
    await cloud.stop();
  }
});

test('a lock whose heartbeat is stale is taken over', async () => {
  const { cloud, a } = await seeded();
  try {
    const old = Date.now() - LOCK_TTL_MS - 60000;
    cloud.files.set(`Claude Sessions/my-repo/locks/${F1}.json`, { body: Buffer.from(JSON.stringify({ machine: 'crashed', since: old, heartbeat: old })), mtime: Math.floor(old / 1000) });
    use(a);
    appendLine(a, F1, 'after the crash');
    const r = await syncFavorites({ creds: cloud.creds(), wsPath: a.ws, stateFile: a.stateFile, running: new Set([F1]), machine: 'mac-a' });
    assert.deepStrictEqual(r.locked, [F1]);
    assert.deepStrictEqual(r.conflicts, []);
    assert.strictEqual(lockOf(cloud, F1).machine, 'mac-a');
    assert.ok(r.uploaded.includes(F1));
  } finally {
    await cloud.stop();
  }
});

test('two machines claiming at the same moment: the first lock written wins', async () => {
  const { cloud, a } = await seeded();
  try {
    use(a);
    writeSession(a, F1, 'racing', Math.floor(Date.now() / 1000));
    const fetchImpl = async (url, init) => {
      if (init.method === 'PUT' && url.includes('/locks/') && !lockOf(cloud, F1)) {
        const now = Date.now();
        cloud.files.set(`Claude Sessions/my-repo/locks/${F1}.json`, { body: Buffer.from(JSON.stringify({ machine: 'mac-b', since: now, heartbeat: now })), mtime: Math.floor(now / 1000) });
      }
      return fetch(url, init);
    };
    const r = await syncFavorites({ creds: cloud.creds(), wsPath: a.ws, stateFile: a.stateFile, running: new Set([F1]), machine: 'mac-a', fetchImpl });
    assert.deepStrictEqual(r.conflicts, [{ id: F1, machine: 'mac-b' }]);
    assert.ok(!r.uploaded.includes(F1));
    assert.strictEqual(lockOf(cloud, F1).machine, 'mac-b');
  } finally {
    await cloud.stop();
  }
});

test('readLock reports a live lock of another machine and ignores own or stale ones', async () => {
  const { cloud, a } = await seeded();
  try {
    use(a);
    await syncFavorites({ creds: cloud.creds(), wsPath: a.ws, stateFile: a.stateFile, running: new Set([F1]), machine: 'mac-a' });
    const opts = { creds: cloud.creds(), wsPath: a.ws };
    assert.strictEqual((await readLock({ ...opts, id: F1, machine: 'mac-b' })).machine, 'mac-a');
    assert.strictEqual(await readLock({ ...opts, id: F1, machine: 'mac-a' }), null);
    assert.strictEqual(await readLock({ ...opts, id: F2, machine: 'mac-b' }), null);
    assert.strictEqual(await readLock({ ...opts, id: F1, machine: 'mac-b', now: Date.now() + LOCK_TTL_MS + 1000 }), null);
  } finally {
    await cloud.stop();
  }
});

test('a machine that kept working offline catches up: the longer copy wins, whichever file is older', async () => {
  const { cloud, a } = await seeded();
  try {
    const b = machine('b');
    writeState(b, {});
    use(b);
    await syncFavorites({ creds: cloud.creds(), wsPath: b.ws, stateFile: b.stateFile, machine: 'mac-b' });
    const past = Math.floor(Date.now() / 1000) - 3000;
    appendLine(b, F1, 'offline work on b', past);
    use(b);
    const up = await syncFavorites({ creds: cloud.creds(), wsPath: b.ws, stateFile: b.stateFile, machine: 'mac-b' });
    assert.deepStrictEqual(up.uploaded, [F1], 'an extension of the known copy is uploaded even with an old file date');
    use(a);
    const down = await syncFavorites({ creds: cloud.creds(), wsPath: a.ws, stateFile: a.stateFile, machine: 'mac-a' });
    assert.deepStrictEqual(down.downloaded, [F1]);
    assert.match(fs.readFileSync(path.join(projectDir(a.ws), `${F1}.jsonl`), 'utf8'), /offline work on b/);
    assert.deepStrictEqual(down.forked, []);
  } finally {
    await cloud.stop();
  }
});

test('two histories that grew apart are both kept: the shared copy stays, the local one becomes a starred fork', async () => {
  const { cloud, a } = await seeded();
  try {
    const b = machine('b');
    writeState(b, { names: { [F1]: 'alpha' } });
    use(b);
    await syncFavorites({ creds: cloud.creds(), wsPath: b.ws, stateFile: b.stateFile, machine: 'mac-b' });
    appendLine(a, F1, 'continued on a');
    use(a);
    await syncFavorites({ creds: cloud.creds(), wsPath: a.ws, stateFile: a.stateFile, machine: 'user@mac-a.local' });
    appendLine(b, F1, 'continued on b offline');
    use(b);
    const r = await syncFavorites({ creds: cloud.creds(), wsPath: b.ws, stateFile: b.stateFile, machine: 'user@mac-b.local' });
    assert.strictEqual(r.forked.length, 1);
    const { forkId, name } = r.forked[0];
    assert.strictEqual(name, 'alpha-mac-b');
    const original = fs.readFileSync(path.join(projectDir(b.ws), `${F1}.jsonl`), 'utf8');
    const fork = fs.readFileSync(path.join(projectDir(b.ws), `${forkId}.jsonl`), 'utf8');
    assert.match(original, /continued on a/, 'the shared copy is now the session under its id');
    assert.doesNotMatch(original, /offline/);
    assert.match(fork, /continued on b offline/, 'nothing written offline is lost');
    assert.ok(fork.includes(`"sessionId":"${forkId}"`) && !fork.includes(`"sessionId":"${F1}"`), 'the fork is its own session');
    const st = readState(b);
    assert.strictEqual(st.favorites[forkId], true);
    assert.strictEqual(st.names[forkId], 'alpha-mac-b');
    assert.ok(cloud.files.has(`Claude Sessions/my-repo/${forkId}.jsonl`), 'the fork reaches the other machine as a favorite');

    use(a);
    const onA = await syncFavorites({ creds: cloud.creds(), wsPath: a.ws, stateFile: a.stateFile, machine: 'user@mac-a.local' });
    assert.deepStrictEqual(onA.downloaded, [forkId]);
    assert.deepStrictEqual(onA.forked, [], 'the other machine gets the fork once, no second fork');
    assert.strictEqual(readState(a).names[forkId], 'alpha-mac-b');
  } finally {
    await cloud.stop();
  }
});

test('an unstarred session releases the lock this machine held on it', async () => {
  const { cloud, a } = await seeded();
  try {
    use(a);
    await syncFavorites({ creds: cloud.creds(), wsPath: a.ws, stateFile: a.stateFile, running: new Set([F1]), machine: 'mac-a' });
    assert.ok(lockOf(cloud, F1));
    const st = readState(a);
    delete st.favorites[F1];
    writeState(a, st);
    await syncFavorites({ creds: cloud.creds(), wsPath: a.ws, stateFile: a.stateFile, running: new Set([F1]), machine: 'mac-a' });
    assert.strictEqual(lockOf(cloud, F1), null);
  } finally {
    await cloud.stop();
  }
});

test('the machine id is stable, readable and stored once per machine', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-machine-'));
  const before = process.env.HOME;
  process.env.HOME = home;
  try {
    delete require.cache[require.resolve('../sync')];
    const first = require('../sync').machineId();
    assert.match(first, /^[^#\s]+#[0-9a-f]{8}$/);
    assert.doesNotMatch(first, /invalid|unknown/i);
    delete require.cache[require.resolve('../sync')];
    assert.strictEqual(require('../sync').machineId(), first, 'the same after a restart');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, '.claude-sessions-machine.json'), 'utf8')).id, first);
  } finally {
    process.env.HOME = before;
    delete require.cache[require.resolve('../sync')];
  }
});

test('a lock written under the old host-based name is recognised as this machine and renewed under the new id', async () => {
  const { cloud, a } = await seeded();
  try {
    const now = Date.now();
    cloud.files.set(`Claude Sessions/my-repo/locks/${F1}.json`, { body: Buffer.from(JSON.stringify({ machine: 'user@old-host', since: now - 60000, heartbeat: now - 60000 })), mtime: Math.floor(now / 1000) });
    use(a);
    appendLine(a, F1, 'still here');
    const r = await syncFavorites({ creds: cloud.creds(), wsPath: a.ws, stateFile: a.stateFile, running: new Set([F1]), machine: 'Mac#abcd1234', legacy: 'user@old-host' });
    assert.deepStrictEqual(r.conflicts, []);
    assert.deepStrictEqual(r.locked, [F1]);
    assert.strictEqual(lockOf(cloud, F1).machine, 'Mac#abcd1234');
    assert.ok(r.uploaded.includes(F1));
  } finally {
    await cloud.stop();
  }
});
