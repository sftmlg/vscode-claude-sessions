'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseOpenUri, handleOpen } = require('../uri');

const ID = '123e4567-e89b-12d3-a456-426614174000';

test('parseOpenUri accepts only /open with a uuid', () => {
  assert.equal(parseOpenUri({ path: '/open', query: `sessionId=${ID}` }), ID);
  assert.equal(parseOpenUri({ path: '/open', query: 'sessionId=nope' }), null);
  assert.equal(parseOpenUri({ path: '/other', query: `sessionId=${ID}` }), null);
});

function run(over) {
  const calls = [];
  const deps = {
    sessionId: ID,
    findTab: () => null,
    focus: async () => calls.push('focus'),
    forward: async () => ({ queued: false }),
    resumeHere: async () => calls.push('resume'),
    info: (m) => calls.push(`info:${m}`),
    ...over,
  };
  return handleOpen(deps).then((r) => ({ r, calls }));
}

test('own tab is focused without contacting the hub', async () => {
  const { r, calls } = await run({ findTab: () => ({}), forward: async () => assert.fail('no forward') });
  assert.deepEqual([r, calls], ['focused', ['focus']]);
});

test('foreign session is forwarded and reported', async () => {
  const { r, calls } = await run({ forward: async () => ({ queued: true, window: 'repo-b' }) });
  assert.equal(r, 'forwarded');
  assert.deepEqual(calls, ['info:Session opens in another window: repo-b.']);
});

test('no owner or unreachable hub resumes here', async () => {
  assert.equal((await run({})).r, 'resumed');
  const { r, calls } = await run({ forward: async () => { throw new Error('down'); } });
  assert.deepEqual([r, calls], ['resumed', ['resume']]);
});
