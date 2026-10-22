'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { chooseSlot, cellsFromCounts } = require('../placement');

const slot = (counts) => {
  const s = chooseSlot(cellsFromCounts(counts));
  return [s.col, s.row, s.stacked];
};

test('scans top-left to bottom-right', () => {
  assert.deepStrictEqual(slot([]), [0, 0, false]);
  assert.deepStrictEqual(slot([1]), [1, 0, false]);
  assert.deepStrictEqual(slot([1, 1]), [2, 0, false]);
  assert.deepStrictEqual(slot([1, 1, 1]), [0, 1, false]);
  assert.deepStrictEqual(slot([2, 1, 1]), [1, 1, false]);
  assert.deepStrictEqual(slot([2, 2, 1]), [2, 1, false]);
});

test('full grid stacks into the column with fewest tabs, leftmost on a tie', () => {
  assert.deepStrictEqual(slot([2, 2, 2]), [0, 2, true]);
  assert.deepStrictEqual(slot([3, 2, 2]), [1, 2, true]);
  assert.deepStrictEqual(slot([3, 3, 2]), [2, 2, true]);
});

test('gaps in the middle are filled first', () => {
  assert.deepStrictEqual(chooseSlot([{ col: 0, row: 0 }, { col: 2, row: 0 }]), { col: 1, row: 0, stacked: false });
  assert.deepStrictEqual(chooseSlot([{ col: 0, row: 0 }, { col: 1, row: 0 }, { col: 2, row: 0 }, { col: 0, row: 1 }, { col: 2, row: 1 }]), { col: 1, row: 1, stacked: false });
  assert.deepStrictEqual(chooseSlot([{ col: 1, row: 0 }, { col: 2, row: 0 }]), { col: 0, row: 0, stacked: false });
});
