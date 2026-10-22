'use strict';

const COLUMNS = 3;
const ROWS = 2;

function cellsFromCounts(counts) {
  const cells = [];
  counts.slice(0, COLUMNS).forEach((n, col) => {
    for (let row = 0; row < n; row++) cells.push({ col, row });
  });
  return cells;
}

function chooseSlot(occupied, { columns = COLUMNS, rows = ROWS } = {}) {
  const taken = new Set(occupied.map((c) => `${c.col},${c.row}`));
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      if (!taken.has(`${col},${row}`)) return { col, row, stacked: false };
    }
  }
  const counts = Array.from({ length: columns }, () => 0);
  for (const c of occupied) if (c.col >= 0 && c.col < columns) counts[c.col]++;
  const col = counts.indexOf(Math.min(...counts));
  return { col, row: counts[col], stacked: true };
}

module.exports = { COLUMNS, ROWS, cellsFromCounts, chooseSlot };
