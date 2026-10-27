'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { chooseSlot, cellsFromCounts } = require('../placement');

const slot = (counts) => {
  const s = chooseSlot(cellsFromCounts(counts));
  return [s.col, s.row, s.stacked];
};

test('opens a new column at the right end until there are three', () => {
  assert.deepStrictEqual(slot([]), [0, 0, false]);
  assert.deepStrictEqual(slot([1]), [1, 0, false]);
  assert.deepStrictEqual(slot([3, 1]), [2, 0, false]);
});

test('with three columns appends at the bottom of the shortest, rightmost on a tie', () => {
  assert.deepStrictEqual(slot([1, 1, 1]), [2, 1, true]);
  assert.deepStrictEqual(slot([1, 1, 2]), [1, 1, true]);
  assert.deepStrictEqual(slot([2, 1, 2]), [1, 1, true]);
  assert.deepStrictEqual(slot([2, 2, 2]), [2, 2, true]);
  assert.deepStrictEqual(slot([3, 2, 2]), [2, 2, true]);
});

test('never fills a gap above existing tabs', () => {
  assert.deepStrictEqual(chooseSlot([{ col: 0, row: 0 }, { col: 1, row: 1 }, { col: 2, row: 0 }]), { col: 2, row: 1, stacked: true });
  assert.deepStrictEqual(chooseSlot([{ col: 0, row: 1 }, { col: 1, row: 0 }, { col: 2, row: 0 }]), { col: 2, row: 1, stacked: true });
});

test('never opens a fourth column', () => {
  const cells = cellsFromCounts([1, 1, 1, 1]);
  assert.ok(cells.every((c) => c.col < 3));
  assert.ok(chooseSlot(cells).col < 3);
});
