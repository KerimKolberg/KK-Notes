/**
 * Sticky notes and tables are HTML on screen and have to be *drawn* into a
 * PDF. What matters is that they land in the right place: page px and PDF
 * points differ in scale and in which way y runs, so these check the mapping
 * against the finished file rather than against the code that produced it.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { A4_DIMENSIONS, NOTE_GRIP_HEIGHT, TABLE_GRIP_HEIGHT } from '../../document/constants';
import { createDocument } from '../../document/operations';
import type { MediaObject, StickyNote, TableLayer } from '../../document/types';
import { exportDocumentToPdf } from '../export';
import { PX_PER_POINT } from '../pdfCoords';

/** Points per page px, and the page height in points. */
const K = 1 / PX_PER_POINT;
const PAGE_HEIGHT_PT = A4_DIMENSIONS.height * K;

const note: StickyNote = {
  kind: 'note',
  id: 'n1',
  x: 100,
  y: 200,
  width: 220,
  height: 200,
  rotation: 0,
  zIndex: 1,
  text: 'Remember the milk',
  color: '#fef08a',
};

const table: TableLayer = {
  kind: 'table',
  id: 't1',
  x: 300,
  y: 600,
  width: 240,
  height: 120,
  rotation: 0,
  zIndex: 2,
  rows: 2,
  columns: 3,
  cells: ['a1', 'b1', 'c1', 'a2', 'b2', 'c2'],
};

async function exportWith(...media: MediaObject[]): Promise<string> {
  const base = createDocument(1);
  const document = { ...base, pages: [{ ...base.pages[0]!, media }] };
  const bytes = await exportDocumentToPdf(document, { includeTemplates: false });
  const loaded = await PDFDocument.load(bytes);
  const streams = loaded.getPage(0).node.normalizedEntries().Contents;
  if (!streams) return '';
  const parts: string[] = [];
  for (let i = 0; i < streams.size(); i++) {
    const stream = loaded.context.lookup(streams.get(i));
    if (stream instanceof PDFRawStream) parts.push(new TextDecoder('latin1').decode(decodePDFRawStream(stream).decode()));
  }
  return parts.join('\n');
}

/**
 * Filled boxes. pdf-lib draws a rectangle as a translate to its bottom-left
 * corner followed by a path from the origin, not as a single `re`, so the
 * position comes from the `cm` and the size from the path's far corner.
 */
function boxes(content: string): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = [];
  for (const block of content.split(/\bq\b/)) {
    const origin = /1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm/.exec(block);
    if (!origin) continue;
    const corners = [...block.matchAll(/(-?[\d.]+) (-?[\d.]+) l\b/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
    if (corners.length === 0) continue;
    out.push([
      Number(origin[1]),
      Number(origin[2]),
      Math.max(...corners.map(([x]) => x)),
      Math.max(...corners.map(([, y]) => y)),
    ]);
  }
  return out;
}

/** Text drawn with `Tj`; pdf-lib writes the glyphs as a hex string. */
function texts(content: string): string[] {
  return [...content.matchAll(/<([0-9A-Fa-f]+)> Tj/g)].map((m) =>
    (m[1]?.match(/../g) ?? []).map((byte) => String.fromCharCode(Number.parseInt(byte, 16))).join(''),
  );
}

/** Where each run of text was placed, from its text matrix. */
function textOrigins(content: string): Array<readonly [number, number]> {
  return [...content.matchAll(/1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
}

describe('exporting a sticky note', () => {
  it('converts page px to points at the rate the rest of the exporter uses', () => {
    expect(K).toBeCloseTo(0.75);
    expect(PAGE_HEIGHT_PT).toBeCloseTo(A4_DIMENSIONS.height * 0.75);
  });

  it('draws the card at the right size and the right way up', async () => {
    const content = await exportWith(note);
    // Page px → points for the size, and y flipped for the origin: the card's
    // *bottom* edge in PDF space is its top edge plus its height on the page.
    const expected = [note.x * K, PAGE_HEIGHT_PT - (note.y + note.height) * K, note.width * K, note.height * K];
    const match = boxes(content).find((box) => box.every((v, i) => Math.abs(v - expected[i]!) < 0.01));
    expect(match, `no box near ${expected.join(', ')} among ${JSON.stringify(boxes(content))}`).toBeDefined();
  });

  it('writes the note text inside the card, below its grip', async () => {
    const content = await exportWith(note);
    expect(texts(content).join(' ')).toContain('Remember the milk');
    // Every glyph run sits inside the card's horizontal span…
    const origins = textOrigins(content);
    expect(origins.length).toBeGreaterThan(0);
    for (const [x, y] of origins) {
      expect(x).toBeGreaterThanOrEqual(note.x * K);
      expect(x).toBeLessThanOrEqual((note.x + note.width) * K);
      // …and below the grip, which is the top strip of the card.
      expect(y).toBeLessThanOrEqual(PAGE_HEIGHT_PT - (note.y + NOTE_GRIP_HEIGHT) * K);
      expect(y).toBeGreaterThanOrEqual(PAGE_HEIGHT_PT - (note.y + note.height) * K);
    }
  });

  it('keeps long text inside the card rather than running off it', async () => {
    const long = { ...note, text: 'word '.repeat(200).trim() };
    const content = await exportWith(long);
    const floor = PAGE_HEIGHT_PT - (long.y + long.height) * K;
    for (const [, y] of textOrigins(content)) expect(y).toBeGreaterThanOrEqual(floor);
  });
});

describe('exporting a table', () => {
  it('draws the frame at the table, in PDF points', async () => {
    const content = await exportWith(table);
    const expected = [table.x * K, PAGE_HEIGHT_PT - (table.y + table.height) * K, table.width * K, table.height * K];
    const match = boxes(content).find((box) => box.every((v, i) => Math.abs(v - expected[i]!) < 0.01));
    expect(match, `no box near ${expected.join(', ')} among ${JSON.stringify(boxes(content))}`).toBeDefined();
  });

  it('rules every interior grid line plus the one under the grip', async () => {
    const content = await exportWith(table);
    // 2 interior verticals (3 columns), 2 horizontals (2 rows, incl. the
    // bottom), and the line closing the grip off = 5.
    const strokes = (content.match(/\bS\b/g) ?? []).length;
    expect(strokes).toBeGreaterThanOrEqual(5);

    const moves = [...content.matchAll(/(-?[\d.]+) (-?[\d.]+) m\b/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
    const gridTop = PAGE_HEIGHT_PT - (table.y + TABLE_GRIP_HEIGHT) * K;
    const columnWidth = (table.width * K) / table.columns;
    // The first interior vertical starts one column in, at the grip line.
    expect(moves.some(([x, y]) => Math.abs(x - (table.x * K + columnWidth)) < 0.01 && Math.abs(y - gridTop) < 0.01)).toBe(true);
  });

  it('writes every non-empty cell', async () => {
    const content = await exportWith(table);
    const drawn = texts(content).join(' ');
    for (const cell of table.cells) expect(drawn).toContain(cell);
  });

  it('leaves empty cells out of the content stream entirely', async () => {
    const blank = { ...table, cells: ['only', '', '', '', '', ''] };
    const content = await exportWith(blank);
    expect(texts(content).filter((t) => t !== '')).toEqual(['only']);
  });
});

describe('exporting media together', () => {
  it('keeps both kinds on the page, drawn in z order', async () => {
    // Passed table-first, but the note is z-index 1 and the table 2, so the
    // note is the one painted first — z order decides, not argument order.
    const drawn = texts(await exportWith(table, note));
    expect(drawn).toContain('Remember the milk');
    expect(drawn).toContain('a1');
    expect(drawn.indexOf('Remember the milk')).toBeLessThan(drawn.indexOf('a1'));
  });
});
