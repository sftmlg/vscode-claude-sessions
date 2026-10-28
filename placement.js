'use strict';

const COLUMNS = 3;

function cellsFromCounts(counts) {
  const cells = [];
  counts.slice(0, COLUMNS).forEach((n, col) => {
    for (let row = 0; row < n; row++) cells.push({ col, row });
  });
  return cells;
}

function chooseSlot(occupied, { columns = COLUMNS } = {}) {
  const next = Array.from({ length: columns }, () => 0);
  for (const c of occupied) if (c.col >= 0 && c.col < columns) next[c.col] = Math.max(next[c.col], c.row + 1);
  const used = next.filter((n) => n > 0).length;
  if (used < columns) return { col: used, row: 0, stacked: false };
  const fewest = Math.min(...next);
  const col = next.lastIndexOf(fewest);
  return { col, row: next[col], stacked: true };
}

module.exports = { COLUMNS, cellsFromCounts, chooseSlot };
