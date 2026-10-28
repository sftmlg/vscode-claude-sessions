const test = require('node:test');
const assert = require('node:assert');
const { optionKeystroke, revalidate, revisionOf } = require('../promptSelect');

const row = (type, content) => JSON.stringify({ type, message: { content } });
const ask = (options = ['A', 'B'], extra = {}) =>
  row('assistant', [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: [{ question: 'Which?', multiSelect: false, options: options.map((label) => ({ label })), ...extra }] } }]);
const cmd = (over = {}) => ({ promptId: 'q1', revision: revisionOf('q1', 'Which?', ['A', 'B']), index: 1, label: 'B', ...over });

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
  assert.throws(() => revalidate(cmd(), [row('user', 'go'), ask(['A', 'B'], { multiSelect: true })]), /single/);
  const answered = [...lines, row('user', [{ type: 'tool_result', tool_use_id: 'q1', content: 'B' }])];
  assert.throws(() => revalidate(cmd(), answered), /no pending question/);
  assert.throws(() => revalidate(cmd(), [...lines, row('user', 'next')]), /no pending question/);
});
