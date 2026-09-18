import { describe, expect, it } from 'vitest';
import {
  A4_DIMENSIONS,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  NOTE_GRIP_HEIGHT,
  NOTE_PADDING,
  TABLE_GRIP_HEIGHT,
} from '../constants';
import {
  addTableColumn,
  addTableRow,
  cellIndex,
  createStickyNote,
  createTable,
  isLocked,
  moveImage,
  noteTextBox,
  removeTableColumn,
  removeTableRow,
  resizeImage,
  resizeTable,
  setTableCell,
  tableCell,
  tableCellBox,
  wrapText,
} from '../media';

const page = A4_DIMENSIONS;
/** Every character one unit wide, so the wrapping maths is readable. */
const monospace = (s: string): number => s.length;

describe('sticky notes', () => {
  it('lands centred on the page, empty and unlocked', () => {
    const note = createStickyNote(page, 1);
    expect(note.kind).toBe('note');
    expect(note.text).toBe('');
    expect(isLocked(note)).toBe(false);
    expect(note.x + note.width / 2).toBeCloseTo(page.width / 2);
    expect(note.y + note.height / 2).toBeCloseTo(page.height / 2);
  });

  it('reserves its grip and padding out of the text area', () => {
    const note = { ...createStickyNote(page, 1), x: 100, y: 200, width: 220, height: 200 };
    const box = noteTextBox(note);
    expect(box.x).toBe(100 + NOTE_PADDING);
    expect(box.y).toBe(200 + NOTE_GRIP_HEIGHT + NOTE_PADDING);
    expect(box.width).toBe(220 - NOTE_PADDING * 2);
    expect(box.height).toBe(200 - NOTE_GRIP_HEIGHT - NOTE_PADDING * 2);
  });
});

describe('wrapping note text', () => {
  it('breaks on words and keeps every line inside the width', () => {
    const lines = wrapText('the quick brown fox jumps', 10, monospace);
    expect(lines).toEqual(['the quick', 'brown fox', 'jumps']);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(10);
  });

  it('keeps the newlines the writer typed, blank ones included', () => {
    expect(wrapText('one\n\ntwo', 20, monospace)).toEqual(['one', '', 'two']);
    expect(wrapText('a\r\nb', 20, monospace)).toEqual(['a', 'b']);
  });

  it('breaks a word too long for the line rather than letting it overflow', () => {
    // A pasted URL should look cramped, not run off the card.
    expect(wrapText('abcdefghij', 4, monospace)).toEqual(['abcd', 'efgh', 'ij']);
    for (const line of wrapText('short abcdefghij', 4, monospace)) expect(line.length).toBeLessThanOrEqual(4);
  });

  it('has nothing to lay out for empty text', () => {
    expect(wrapText('', 10, monospace)).toEqual(['']);
  });
});

describe('tables', () => {
  it('starts at its default shape with one empty cell per slot', () => {
    const table = createTable(page, 1);
    expect(table.cells).toHaveLength(table.rows * table.columns);
    expect(table.cells.every((c) => c === '')).toBe(true);
  });

  it('addresses cells row-major', () => {
    const table = createTable(page, 1, undefined, { rows: 2, columns: 3 });
    expect(cellIndex(table, 0, 0)).toBe(0);
    expect(cellIndex(table, 1, 0)).toBe(3);
    expect(cellIndex(table, 1, 2)).toBe(5);
    const filled = setTableCell(table, 1, 2, 'x');
    expect(filled.cells[5]).toBe('x');
    expect(tableCell(filled, 1, 2)).toBe('x');
    // Out of range is a no-op rather than a silent corruption.
    expect(setTableCell(table, 9, 9, 'x')).toBe(table);
  });

  it('keeps the text that still has a cell when rows and columns change', () => {
    let table = createTable(page, 1, undefined, { rows: 2, columns: 2 });
    table = setTableCell(table, 0, 0, 'a');
    table = setTableCell(table, 1, 1, 'd');

    const grown = addTableColumn(addTableRow(table));
    expect(grown.rows).toBe(3);
    expect(grown.columns).toBe(3);
    expect(tableCell(grown, 0, 0)).toBe('a');
    expect(tableCell(grown, 1, 1)).toBe('d');
    expect(tableCell(grown, 2, 2)).toBe('');

    // Shrinking back drops the text that no longer has anywhere to live.
    const shrunk = removeTableColumn(removeTableRow(grown));
    expect(shrunk.rows).toBe(2);
    expect(tableCell(shrunk, 0, 0)).toBe('a');
    expect(tableCell(shrunk, 1, 1)).toBe('d');
  });

  it('grows the box with the grid, so cells keep their size', () => {
    const table = createTable(page, 1, undefined, { rows: 2, columns: 2 });
    const cellWidth = table.width / table.columns;
    const wider = addTableColumn(table);
    expect(wider.width).toBeCloseTo(table.width + cellWidth);
    expect(wider.width / wider.columns).toBeCloseTo(cellWidth);
  });

  it('never collapses below one row or one column, nor past the cap', () => {
    const one = createTable(page, 1, undefined, { rows: 1, columns: 1 });
    expect(removeTableRow(one).rows).toBe(1);
    expect(removeTableColumn(one).columns).toBe(1);
    expect(resizeTable(one, 999, 999)).toMatchObject({ rows: MAX_TABLE_ROWS, columns: MAX_TABLE_COLUMNS });
  });

  it('divides its grid evenly into cell boxes, below the grip', () => {
    const table = { ...createTable(page, 1, undefined, { rows: 2, columns: 4 }), x: 0, y: 0, width: 400, height: 200 };
    const first = tableCellBox(table, 0, 0);
    expect(first.x).toBe(0);
    expect(first.y).toBe(TABLE_GRIP_HEIGHT);
    expect(first.width).toBe(100);
    const last = tableCellBox(table, 1, 3);
    expect(last.x).toBe(300);
    expect(last.y + last.height).toBeCloseTo(200);
  });
});

describe('locking media', () => {
  it('is off until it is set, and is the flag the layer checks', () => {
    const note = createStickyNote(page, 1);
    expect(isLocked(note)).toBe(false);
    expect(isLocked({ ...note, locked: true })).toBe(true);
  });

  it('does not change the geometry maths — the layer refuses the drag instead', () => {
    // Locking is enforced where the pointer is handled, so the pure helpers
    // stay simple and testable; this pins that they are indeed indifferent.
    const locked = { ...createStickyNote(page, 1), locked: true };
    expect(moveImage(locked, 10, 10).x).toBe(locked.x + 10);
    expect(resizeImage(locked, 'se', 20, 20, false).width).toBe(locked.width + 20);
  });
});
