'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFakeNextcloud } = require('./fake-nextcloud');
const { syncFavorites, startLogin, finishLogin, projectDir } = require('../sync');

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
    assert.deepStrictEqual(r.skippedRunning, [F1]);
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
    writeSession(a, F1, 'one changed', Math.floor(Date.now() / 1000));
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
