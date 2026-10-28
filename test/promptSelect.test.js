const test = require('node:test');
const assert = require('node:assert');
const { optionKeystroke, revalidate, revisionOf } = require('../promptSelect');

const row = (type, content) => JSON.stringify({ type, message: { content } });
const ask = (options = ['A', 'B'], extra = {}, desc = ['first', 'second']) =>
  row('assistant', [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: [{ question: 'Which?', header: '', multiSelect: false, options: options.map((label, i) => ({ label, description: desc[i] })), ...extra }] } }]);
const SID = 'sid-1';
const fixture = [{ question: 'Which?', header: '', multiSelect: false, options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }] }];
const cmd = (over = {}) => ({ sessionId: SID, promptId: 'q1', revision: revisionOf('q1', SID, fixture), index: 1, label: 'B', ...over });

test('optionKeystroke is one digit and refuses indexes outside 0..8', () => {
  assert.strictEqual(optionKeystroke(0), '1');
  assert.strictEqual(optionKeystroke(8), '9');
  for (const bad of [-1, 9, 1.5, '1', undefined]) assert.throws(() => optionKeystroke(bad), /outside/);
});

test('revalidate passes only for the exact pending question', () => {
  const lines = [row('user', 'go'), ask()];
  assert.doesNotThrow(() => revalidate(cmd(), lines));
  assert.throws(() => revalidate(cmd({ promptId: 'q2' }), lines), /stale/);
  assert.throws(() => revalidate(cmd({ label: 'A' }), lines), /option at this index/);
  assert.throws(() => revalidate(cmd(), [row('user', 'go'), ask(['B', 'A'])]), /revision/);
  assert.throws(() => revalidate(cmd(), [row('user', 'go'), ask(['A', 'B'], {}, ['first', 'changed'])]), /revision/);
  assert.throws(() => revalidate(cmd({ sessionId: 'other' }), lines), /revision/);
  assert.throws(() => revalidate(cmd(), [row('user', 'go'), ask(['A', 'B'], { multiSelect: true })]), /single/);
  const answered = [...lines, row('user', [{ type: 'tool_result', tool_use_id: 'q1', content: 'B' }])];
  assert.throws(() => revalidate(cmd(), answered), /no pending question/);
  assert.throws(() => revalidate(cmd(), [...lines, row('user', 'next')]), /no pending question/);
  const tool = row('assistant', [{ type: 'tool_use', id: 'b1', name: 'Bash', input: {} }]);
  assert.throws(() => revalidate(cmd(), [row('user', 'go'), tool]), /unsupported: no screen snapshot/);
});

test('revisionOf is a stable canonical hash shared with the hub', () => {
  assert.strictEqual(revisionOf('q1', SID, fixture), '1e93736859e58a6c');
});
