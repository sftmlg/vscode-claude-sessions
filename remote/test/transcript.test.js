'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-transcript-home-'));
process.env.HOME = home;
delete process.env.CLAUDE_CONFIG_DIR;

const { parseLines, readEvents, Tail, listSubagents, resolveTranscript, resolveSubagent, safeTranscriptPath, MAX_LINE, TEXT_LIMIT, INPUT_LIMIT } = require('../transcript');

const fixtures = path.join(__dirname, 'fixtures');
const fixture = fs.readFileSync(path.join(fixtures, 'transcript-synthetic.jsonl'));
const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const line = (o) => `${JSON.stringify(o)}\n`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kinds = (events) => events.map((e) => e.kind);

test('the synthetic fixture maps every line type without throwing', () => {
  const { events, rest, unknown, corrupt, truncated } = parseLines(fixture);
  assert.strictEqual(rest.length, 0);
  assert.strictEqual(unknown, 1, 'one unknown type');
  assert.strictEqual(corrupt, 1, 'one corrupt line');
  assert.strictEqual(truncated, 0);
  assert.strictEqual(events.length, 40);
  const raw = events.find((e) => e.kind === 'raw');
  assert.deepStrictEqual({ type: raw.type, truncated: raw.truncated }, { type: 'wormhole-state', truncated: false });
  assert.ok(!JSON.stringify(events).includes('Hidden caveat'), 'isMeta lines are dropped');
  assert.ok(!JSON.stringify(events).includes('short private reasoning'), 'thinking content is never exported');
  assert.ok(events.every((e) => typeof e.offset === 'number'), 'every event carries its byte offset');
});

test('assistant lines sharing a message id merge into one event with ordered blocks', () => {
  const { events } = parseLines(fixture);
  const first = events.find((e) => e.kind === 'assistant' && e.messageId === 'msg_01first');
  assert.deepStrictEqual(first.blocks.map((b) => b.type), ['thinking', 'text', 'toolUse', 'toolUse']);
  assert.deepStrictEqual(first.blocks.slice(2).map((b) => b.name), ['Bash', 'Read']);
  assert.strictEqual(first.stopReason, 'tool_use', 'stop reason comes from the last line');
  assert.strictEqual(events.filter((e) => e.kind === 'assistant' && e.messageId === 'msg_01first').length, 1);
  const eighth = events.find((e) => e.kind === 'assistant' && e.messageId === 'msg_08eighth');
  assert.deepStrictEqual(eighth.blocks.map((b) => b.type), ['fallback', 'text']);
  assert.strictEqual(eighth.blocks[0].to, 'sample-model-2');
});

test('tool results are attached by tool_use_id, never by adjacency', () => {
  const { events } = parseLines(fixture);
  const results = events.filter((e) => e.kind === 'toolResult');
  assert.deepStrictEqual(results.slice(0, 2).map((r) => r.toolUseId), ['toolu_01B', 'toolu_01A'], 'results arrive in completion order');
  assert.strictEqual(results.find((r) => r.toolUseId === 'toolu_01A').text, 'README.md\nsample.jsonl');
  const denied = results.find((r) => r.toolUseId === 'toolu_01E');
  assert.deepStrictEqual({ isError: denied.isError, denied: denied.denied, denialKind: denied.denialKind }, { isError: true, denied: true, denialKind: 'permission-rule' });
});

test('AskUserQuestion becomes a question event with its options and no tool block', () => {
  const { events } = parseLines(fixture);
  const q = events.find((e) => e.kind === 'question');
  assert.strictEqual(q.toolUseId, 'toolu_01C');
  assert.deepStrictEqual(q.questions[0].options.map((o) => o.label), ['Keep both', 'Remove the readme']);
  assert.ok(!events.some((e) => e.kind === 'assistant' && e.blocks.some((b) => b.name === 'AskUserQuestion')));
  assert.strictEqual(events.find((e) => e.kind === 'toolResult' && e.toolUseId === 'toolu_01C').text, 'User answered: Keep both');
});

test('prompts, commands, injected turns, interrupts and compaction are told apart', () => {
  const { events } = parseLines(fixture);
  const prompts = events.filter((e) => e.kind === 'prompt');
  assert.deepStrictEqual(prompts.map((p) => p.source), ['typed', 'typed', 'queued', 'typed']);
  assert.strictEqual(prompts[3].images, 1);
  assert.strictEqual(prompts[3].text, 'Here is a screenshot.\n[image]');
  const command = events.find((e) => e.kind === 'command');
  assert.deepStrictEqual({ name: command.name, args: command.args }, { name: '/compact', args: 'keep the file list' });
  assert.strictEqual(events.find((e) => e.kind === 'commandOutput').text, 'Compacted the conversation.');
  const compact = events.find((e) => e.kind === 'compact');
  assert.deepStrictEqual({ trigger: compact.trigger, pre: compact.preTokens, post: compact.postTokens }, { trigger: 'manual', pre: 52000, post: 8000 });
  assert.match(events.find((e) => e.kind === 'compactSummary').text, /^This session is being continued/);
  assert.strictEqual(events.find((e) => e.kind === 'injected').origin, 'task_notification');
  assert.strictEqual(events.filter((e) => e.kind === 'interrupted').length, 1);
  assert.deepStrictEqual(events.filter((e) => e.kind === 'queued').map((e) => e.op), ['enqueue', 'remove']);
  assert.deepStrictEqual(events.filter((e) => e.kind === 'turnEnd').map((e) => e.durationMs), [4200, 900]);
});

test('notices, api errors and hook summaries: only the ones with content survive', () => {
  const { events } = parseLines(fixture);
  const notices = events.filter((e) => e.kind === 'notice').map((e) => e.subtype);
  assert.deepStrictEqual(notices, ['api_error', 'api_error', 'informational', 'away_summary'], 'a clean stop_hook_summary is dropped');
  const hooks = parseLines(line({ type: 'system', subtype: 'stop_hook_summary', uuid: 'u', timestamp: 't', hookErrors: ['lint failed'], preventedContinuation: true, stopReason: 'blocked' })).events;
  assert.strictEqual(hooks[0].subtype, 'hooks');
  assert.match(hooks[0].text, /stopped: blocked\nlint failed/);
});

test('session metadata records become meta events, the last one wins by order', () => {
  const { events } = parseLines(fixture);
  const titles = events.filter((e) => e.kind === 'meta' && e.key === 'customTitle').map((e) => e.value);
  assert.deepStrictEqual(titles, ['fixtures-old', 'fixtures-final']);
  assert.strictEqual(events.find((e) => e.kind === 'meta' && e.key === 'continuedIn').value, 'ffffffff-1111-4222-8333-444444444444');
  assert.strictEqual(events.find((e) => e.kind === 'meta' && e.key === 'prLink').value.number, 7);
  assert.ok(!events.some((e) => e.kind === 'meta' && e.key === 'lastPrompt'), 'bookkeeping records are dropped silently');
});

test('an oversized line becomes a truncated raw event and the next line still parses', () => {
  const big = `{"type":"user","uuid":"big","message":{"role":"user","content":"${'x'.repeat(MAX_LINE + 10)}"}}\n`;
  const { events, truncated, corrupt } = parseLines(Buffer.from(`${big}${line({ type: 'user', uuid: 'after', timestamp: 't', message: { role: 'user', content: 'after the giant' } })}`));
  assert.strictEqual(truncated, 1);
  assert.strictEqual(corrupt, 0);
  assert.deepStrictEqual(kinds(events), ['raw', 'prompt']);
  assert.deepStrictEqual({ type: events[0].type, truncated: events[0].truncated, size: events[0].size > MAX_LINE }, { type: 'user', truncated: true, size: true });
  assert.strictEqual(events[1].offset, big.length);
});

test('corrupt and alien lines are counted and skipped, never thrown', () => {
  const junk = ['not json', '{"type":', 'null', '[]', '{"type":5}', '"string"', '\u0000\u0001\u0002', '{"no":"type"}'].join('\n');
  const { events, corrupt, unknown } = parseLines(Buffer.from(`${junk}\n${line({ type: 'mode', mode: 'normal' })}`));
  assert.strictEqual(corrupt, 8);
  assert.strictEqual(unknown, 0);
  assert.deepStrictEqual(kinds(events), ['meta']);
});

test('a trailing partial line is returned as rest and parses once completed', () => {
  const whole = line({ type: 'user', uuid: 'u', timestamp: 't', message: { role: 'user', content: 'complete' } });
  const cut = whole.slice(0, 20);
  const first = parseLines(Buffer.from(`${line({ type: 'mode', mode: 'normal' })}${cut}`));
  assert.strictEqual(first.rest.toString(), cut);
  assert.deepStrictEqual(kinds(first.events), ['meta']);
  const second = parseLines(Buffer.concat([first.rest, Buffer.from(whole.slice(20))]));
  assert.deepStrictEqual(kinds(second.events), ['prompt']);
  assert.strictEqual(second.events[0].text, 'complete');
});

test('text fields are clipped to 20 000 chars and tool inputs to 4 000', () => {
  const long = 'y'.repeat(TEXT_LIMIT + 500);
  const { events } = parseLines(Buffer.from(line({ type: 'user', uuid: 'u', timestamp: 't', message: { role: 'user', content: long } }) + line({ type: 'assistant', uuid: 'a', timestamp: 't', message: { id: 'm', role: 'assistant', content: [{ type: 'tool_use', id: 'tu', name: 'Write', input: { content: 'z'.repeat(INPUT_LIMIT + 1) } }] } })));
  assert.strictEqual(events[0].text.length, TEXT_LIMIT + 1);
  assert.ok(events[0].text.endsWith('…'));
  const input = events[1].blocks[0].input;
  assert.strictEqual(input.truncated, true);
  assert.strictEqual(input.text.length, INPUT_LIMIT);
});

function tempFile(name, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-transcript-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

test('readEvents pages backwards by byte offset without gaps or overlaps', async () => {
  const file = tempFile(`${SESSION}.jsonl`, fixture);
  const all = parseLines(fixture).events;
  const tail = await readEvents(file, { limit: 5 });
  assert.strictEqual(tail.events.length, 5);
  assert.strictEqual(tail.to, fixture.length);
  assert.strictEqual(tail.size, fixture.length);
  assert.deepStrictEqual(kinds(tail.events), kinds(all.slice(-5)));
  assert.strictEqual(tail.from, all[all.length - 5].offset);
  const pages = [tail];
  let guard = 0;
  while (pages[pages.length - 1].from > 0 && guard++ < 50) {
    const prev = pages[pages.length - 1];
    const page = await readEvents(file, { before: prev.from, limit: 7 });
    assert.strictEqual(page.to, prev.from, 'pages meet exactly at the boundary');
    assert.ok(page.from < page.to);
    pages.push(page);
  }
  const joined = pages.reverse().flatMap((p) => p.events);
  assert.deepStrictEqual(kinds(joined), kinds(all));
  assert.strictEqual(pages.reduce((n, p) => n + p.unknown, 0), 1);
});

test('readEvents reads forward from an offset and skips a leading partial line', async () => {
  const file = tempFile(`${SESSION}.jsonl`, fixture);
  const tail = await readEvents(file, { limit: 3 });
  fs.appendFileSync(file, line({ type: 'user', uuid: 'n', timestamp: 't', message: { role: 'user', content: 'appended later' } }));
  const next = await readEvents(file, { from: tail.to });
  assert.deepStrictEqual(kinds(next.events), ['prompt']);
  assert.strictEqual(next.from, tail.to);
  assert.strictEqual(next.to, fs.statSync(file).size);
  const misaligned = await readEvents(file, { from: tail.to + 3 });
  assert.deepStrictEqual(misaligned.events, [], 'a mid-line start yields only the lines after the next newline');
  const half = line({ type: 'mode', mode: 'x' });
  fs.appendFileSync(file, half.slice(0, 10));
  const partial = await readEvents(file, { from: next.to });
  assert.deepStrictEqual(partial.events, [], 'an unfinished last line is left for the next read');
  assert.strictEqual(partial.to, next.to);
});

test('readEvents grows its window for long lines and never reads more than 512 KB per call', async () => {
  const small = line({ type: 'user', uuid: 's', timestamp: 't', message: { role: 'user', content: 'small' } });
  const long = `{"type":"user","uuid":"l","timestamp":"t","message":{"role":"user","content":"${'q'.repeat(300 * 1024)}"}}\n`;
  const body = `${small}${long}${small}`;
  const file = tempFile(`${SESSION}.jsonl`, body);
  const page = await readEvents(file, { limit: 50 });
  assert.deepStrictEqual(kinds(page.events), ['prompt', 'prompt', 'prompt'], 'the 64 KB window grew until the long line fitted');
  assert.strictEqual(page.from, 0);
  const giant = `{"type":"user","uuid":"g","timestamp":"t","message":{"role":"user","content":"${'q'.repeat(700 * 1024)}"}}\n`;
  const file2 = tempFile(`${SESSION}.jsonl`, `${small}${giant}${small}`);
  const last = await readEvents(file2, { limit: 50 });
  assert.deepStrictEqual(kinds(last.events), ['prompt'], 'a line longer than the window cap is left for the next page');
  assert.strictEqual(last.from, small.length + giant.length);
  const older = await readEvents(file2, { before: last.from, limit: 50 });
  assert.strictEqual(older.to, last.from, 'pages still meet exactly');
  assert.strictEqual(older.to - older.from, 512 * 1024, 'one read never exceeds 512 KB');
  assert.deepStrictEqual(older.events.map((e) => [e.kind, e.truncated, e.type]), [['raw', true, null]], 'a mid-line fragment carries no sniffed type');
  assert.strictEqual(older.truncated, 1);
  const first = await readEvents(file2, { before: older.from, limit: 50 });
  assert.deepStrictEqual({ from: first.from, to: first.to }, { from: 0, to: older.from });
  assert.deepStrictEqual(first.events.map((e) => [e.kind, e.type]), [['prompt', undefined], ['raw', 'user']], 'the head fragment of the long line keeps its type');
  assert.strictEqual(first.events[1].size + older.events[0].size, giant.length, 'the fragments add up to the whole line');
  assert.strictEqual(first.events[1].offset, small.length);
  const forward = await readEvents(file2, { from: small.length });
  assert.deepStrictEqual(forward.events.map((e) => e.kind), ['raw'], 'a forward read stuck inside a long line still makes progress');
  assert.strictEqual(forward.to, small.length + 512 * 1024);
});

test('Tail emits complete lines as they are appended, survives a split write and resets on truncation', async () => {
  const file = tempFile(`${SESSION}.jsonl`, fixture);
  const tail = new Tail(file, { pollMs: 200 });
  const batches = [];
  const resets = [];
  tail.on('events', (b) => batches.push(b));
  tail.on('reset', (r) => resets.push(r));
  await tail.start();
  try {
    assert.strictEqual(tail.offset, fixture.length, 'starts at the end');
    const one = line({ type: 'user', uuid: 'x1', timestamp: 't', message: { role: 'user', content: 'first live' } });
    fs.appendFileSync(file, one);
    await tail.check();
    assert.strictEqual(batches.length, 1);
    assert.deepStrictEqual(kinds(batches[0].events), ['prompt']);
    assert.deepStrictEqual({ from: batches[0].from, to: batches[0].to }, { from: fixture.length, to: fixture.length + one.length });
    const two = line({ type: 'assistant', uuid: 'x2', timestamp: 't', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'split across writes' }] } });
    fs.appendFileSync(file, two.slice(0, 25));
    await tail.check();
    assert.strictEqual(batches.length, 1, 'a partial line is held back');
    fs.appendFileSync(file, two.slice(25));
    await tail.check();
    assert.strictEqual(batches.length, 2);
    assert.strictEqual(batches[1].events[0].blocks[0].text, 'split across writes');
    assert.strictEqual(batches[1].from, fixture.length + one.length);
    assert.strictEqual(tail.offset, fs.statSync(file).size);
    fs.writeFileSync(file, fixture.subarray(0, 1000));
    await tail.check();
    assert.strictEqual(resets.length, 1);
    assert.strictEqual(tail.offset, 1000);
    fs.appendFileSync(file, `\n${line({ type: 'mode', mode: 'normal' })}`);
    await sleep(600);
    assert.ok(batches.length >= 3, 'the size poll picks up growth without a watcher event');
  } finally {
    tail.close();
  }
});

test('Tail turns a never-ending line into a truncated raw event instead of buffering it', async () => {
  const file = tempFile(`${SESSION}.jsonl`, '');
  const tail = new Tail(file, { pollMs: 10000 });
  const batches = [];
  tail.on('events', (b) => batches.push(b));
  await tail.start();
  try {
    fs.appendFileSync(file, `{"type":"user","content":"${'z'.repeat(MAX_LINE + 100)}`);
    await tail.check();
    assert.strictEqual(batches.length, 1);
    assert.deepStrictEqual({ kind: batches[0].events[0].kind, truncated: batches[0].events[0].truncated }, { kind: 'raw', truncated: true });
    assert.strictEqual(tail.pending.length, 0);
  } finally {
    tail.close();
  }
});

function fakeProjects(dirName) {
  const projects = path.join(home, dirName, 'projects');
  const project = path.join(projects, '-home-sample-project');
  fs.mkdirSync(project, { recursive: true });
  return { projects, project };
}

test('listSubagents reads the meta files next to the session file', async () => {
  const { project } = fakeProjects('.claude');
  const main = path.join(project, `${SESSION}.jsonl`);
  fs.writeFileSync(main, fixture);
  const agents = path.join(project, SESSION, 'subagents');
  fs.mkdirSync(agents, { recursive: true });
  fs.copyFileSync(path.join(fixtures, 'tr-agent-one.jsonl'), path.join(agents, 'agent-00000001.jsonl'));
  fs.copyFileSync(path.join(fixtures, 'tr-agent-one.meta.json'), path.join(agents, 'agent-00000001.meta.json'));
  fs.writeFileSync(path.join(agents, 'agent-nometa.jsonl'), '');
  fs.writeFileSync(path.join(agents, 'strange name.meta.json'), '{}');
  const list = await listSubagents(main);
  assert.strictEqual(list.length, 1);
  assert.deepStrictEqual({ agentId: list[0].agentId, toolUseId: list[0].toolUseId, type: list[0].agentType }, { agentId: 'agent-00000001', toolUseId: 'toolu_01D', type: 'scout' });
  assert.strictEqual(list[0].file, path.join(agents, 'agent-00000001.jsonl'));
  assert.deepStrictEqual(await listSubagents(path.join(project, 'ffffffff-1111-4222-8333-444444444444.jsonl')), []);
  const agentEvents = parseLines(fs.readFileSync(list[0].file)).events;
  assert.deepStrictEqual(kinds(agentEvents), ['prompt', 'assistant', 'toolResult', 'assistant']);
});

test('resolveTranscript accepts only UUIDs and realpaths under a projects root, deduped across slots', async () => {
  const { projects, project } = fakeProjects('.claude');
  const main = path.join(project, `${SESSION}.jsonl`);
  if (!fs.existsSync(main)) fs.writeFileSync(main, fixture);
  const slot = path.join(home, '.claude-two');
  fs.mkdirSync(slot, { recursive: true });
  fs.symlinkSync(projects, path.join(slot, 'projects'));
  assert.strictEqual(await resolveTranscript(SESSION), fs.realpathSync(main));
  assert.strictEqual(await resolveTranscript(`${SESSION}/../x`), null);
  assert.strictEqual(await resolveTranscript('not-a-uuid'), null);
  assert.strictEqual(await resolveTranscript('ffffffff-1111-4222-8333-444444444444'), null);
  const outside = path.join(home, 'elsewhere.jsonl');
  fs.writeFileSync(outside, fixture);
  fs.symlinkSync(outside, path.join(project, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl'));
  assert.strictEqual(await resolveTranscript('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), null, 'a symlink leaving the projects root is refused');
  assert.strictEqual(await safeTranscriptPath(outside), null);
  assert.strictEqual(await safeTranscriptPath(`${project}/../../../elsewhere.jsonl`), null);
  assert.strictEqual(await safeTranscriptPath('relative.jsonl'), null);
  assert.strictEqual(await safeTranscriptPath(path.join(project, SESSION)), null, 'directories are not transcripts');
  assert.strictEqual(await safeTranscriptPath(path.join(slot, 'projects', '-home-sample-project', `${SESSION}.jsonl`)), fs.realpathSync(main));
  assert.strictEqual(await resolveSubagent(SESSION, 'agent-00000001'), path.join(fs.realpathSync(project), SESSION, 'subagents', 'agent-00000001.jsonl'));
  assert.strictEqual(await resolveSubagent(SESSION, '../agent-00000001'), null);
  assert.strictEqual(await resolveSubagent(SESSION, 'agent-missing'), null);
});
