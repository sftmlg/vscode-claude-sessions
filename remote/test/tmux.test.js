'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const tmux = require('../tmux');
const { testCtx, killServer, startPane, capture, waitFor, tempHome } = require('./fixtures/fs-helpers');

test('session names: only cc-[a-z0-9-]{1,40}, exact pane targets', () => {
  for (const ok of ['cc-a', 'cc-0-9', `cc-${'a'.repeat(40)}`]) assert.strictEqual(tmux.paneTarget(ok), `=${ok}:`);
  for (const bad of ['cc-', 'cc-A', 'cc-a;kill-server', 'cc-a:1', 'xx-a', `cc-${'a'.repeat(41)}`, '=cc-a', 'cc-a b', '']) assert.throws(() => tmux.paneTarget(bad));
});

test('C0 and C1 controls except newline and tab are stripped, CRLF becomes LF', () => {
  assert.strictEqual(tmux.stripControls('a\x1b[201~b\x07c\r\nd\te\x9bf\x00'), 'a[201~bc\nd\tef');
});

test('control-mode output decoding turns \\ooo escapes into bytes and keeps raw UTF-8', () => {
  const line = Buffer.from('%output %0 a\\033[1mb\\015\\012\\134 ü', 'utf8');
  assert.strictEqual(tmux.decodeOutput(line, 11).toString('utf8'), 'a\x1b[1mb\r\n\\ ü');
});

test('replay bytes: alt screen, clear, lines, reset, cursor, visibility', () => {
  const bytes = tmux.replayBytes({ alt: true, rows: 2, lines: ['one', 'two', 'extra'], cursor: { x: 3, y: 1, visible: false } }).toString();
  assert.strictEqual(bytes, '\x1b[?1049h\x1b[H\x1b[2Jone\r\ntwo\x1b[0m\x1b[2;4H\x1b[?25l');
});

test('tmux integration on a throwaway socket', async (t) => {
  const ctx = testCtx();
  t.after(() => killServer(ctx));
  const dir = tempHome('remote-tmux-');

  await t.test('listSessions is empty without a server', async () => {
    assert.deepStrictEqual(await tmux.listSessions(ctx), []);
  });

  await t.test('newSession refuses fewer than two argv entries and bad names', async () => {
    await assert.rejects(tmux.newSession(ctx, { name: 'cc-x', dir, argv: ['/bin/sh'] }), /at least two/);
    await assert.rejects(tmux.newSession(ctx, { name: 'cc-x;kill-server', dir, argv: ['/bin/sh', 'x'] }), /Invalid session name/);
  });

  await t.test('newSession passes argv without a shell', async () => {
    const marker = path.join(dir, 'pwn');
    await tmux.newSession(ctx, { name: 'cc-args', dir, argv: ['/bin/sh', path.join(__dirname, 'fixtures', 'fs-fake-claude.sh'), `$(touch ${marker})`, ';echo hi'], cols: 100, rows: 20 });
    const screen = await waitFor(() => capture(ctx, 'cc-args').includes('fake-claude') && capture(ctx, 'cc-args'), { what: 'fake claude' });
    assert.match(screen, /\[\$\(touch [^\]]+\)\] \[;echo hi\]/);
    assert.strictEqual(fs.existsSync(marker), false);
    const list = await tmux.listSessions(ctx);
    const s = list.find((x) => x.name === 'cc-args');
    assert.ok(s);
    assert.strictEqual(s.cols, 100);
    assert.strictEqual(s.rows, 20);
    assert.ok(s.panePid > 0);
    assert.strictEqual(fs.realpathSync(s.cwd), dir);
  });

  await t.test('listSessions ignores sessions with foreign names', async () => {
    startPane(ctx, 'other');
    assert.deepStrictEqual((await tmux.listSessions(ctx)).map((s) => s.name), ['cc-args']);
  });

  await t.test('paste sends multi-line text as one paste plus Enter, controls stripped', async () => {
    await tmux.paste(ctx, 'cc-args', 'msg-1', 'hello\x1b[201~ world');
    await waitFor(() => capture(ctx, 'cc-args').includes('got:hello[201~ world'), { what: 'pasted line' });
    await assert.rejects(tmux.paste(ctx, 'cc-args', 'bad id', 'x'), /Invalid buffer id/);
  });

  await t.test('sendKey allows only the key list', async () => {
    await tmux.sendKey(ctx, 'cc-args', 'y');
    await tmux.sendKey(ctx, 'cc-args', 'Enter');
    await waitFor(() => capture(ctx, 'cc-args').includes('got:y'), { what: 'key y' });
    await assert.rejects(tmux.sendKey(ctx, 'cc-args', 'C-b'), /not allowed/);
    await assert.rejects(tmux.sendKey(ctx, 'cc-args', 'kill-server'), /not allowed/);
  });

  await t.test('prefix targets never match another session', async () => {
    await assert.rejects(tmux.sendKey(ctx, 'cc-ar', 'y'));
    assert.strictEqual(await tmux.hasSession(ctx, 'cc-ar'), false);
    assert.strictEqual(await tmux.hasSession(ctx, 'cc-args'), true);
  });

  await t.test('control client: snapshot matches capture, output stream decoded', async () => {
    const cc = new tmux.ControlClient(ctx, 'cc-args').start();
    t.after(() => cc.close());
    const outputs = [];
    cc.on('output', (pane, bytes) => outputs.push(bytes.toString('utf8')));
    const snap = await cc.snapshot();
    assert.match(snap.paneId, /^%\d+$/);
    assert.strictEqual(snap.cols, 100);
    assert.strictEqual(snap.rows, 20);
    assert.strictEqual(snap.lines.length, 20);
    assert.deepStrictEqual(snap.lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trimEnd()), capture(ctx, 'cc-args').split('\n').slice(0, 20).map((l) => l.trimEnd()));
    await tmux.paste(ctx, 'cc-args', 'msg-2', 'stream ü');
    await waitFor(() => outputs.join('').includes('got:stream ü'), { what: 'streamed output' });
    await assert.rejects(cc.command('no-such-command'), /unknown command/);
    await assert.rejects(cc.command('a\nb'), /one line/);
  });
});
