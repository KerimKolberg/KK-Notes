import { describe, expect, it } from 'vitest';
import {
  GOODNOTES_EXTENSION,
  GoodNotesImportError,
  describeGoodNotesArchive,
  importGoodNotes,
  isGoodNotesName,
} from '../import';
import { METHOD_STORED } from '../zip';
import type { FreehandStroke, Stroke } from '../../inking/types';

/**
 * The importer end to end, on archives built here.
 *
 * There is no real `.goodnotes` file in this repository and there cannot be one
 * — it would be somebody's notebook — so these are archives assembled to the
 * container's own rules with protobuf payloads shaped the way stroke data is
 * shaped. That proves the four layers are wired together and that the failure
 * path says something useful; it cannot prove GoodNotes' real files parse, and
 * nothing in this repository can until someone opens one.
 */

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * A page's strokes as freehand strokes.
 *
 * `Page.strokes` is the whole union, and the importer only ever produces the
 * freehand half — so this asserts that as it narrows, rather than casting past
 * it. A geometric stroke coming out of an import would be a bug worth failing on.
 */
function inkOf(strokes: readonly Stroke[]): FreehandStroke[] {
  for (const stroke of strokes) expect(stroke.kind).toBe('freehand');
  return strokes.filter((stroke): stroke is FreehandStroke => stroke.kind === 'freehand');
}
const tag = (field: number, wire: number): number => (field << 3) | wire;

function varint(value: number): number[] {
  let n = value;
  const out: number[] = [];
  for (;;) {
    if (n < 0x80) {
      out.push(n);
      return out;
    }
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
}

function floats(values: number[]): number[] {
  const buffer = new ArrayBuffer(values.length * 4);
  const view = new DataView(buffer);
  values.forEach((value, i) => view.setFloat32(i * 4, value, true));
  return [...new Uint8Array(buffer)];
}

const floatField = (field: number, values: number[]): number[] => {
  const body = floats(values);
  return [...varint(tag(field, 2)), ...varint(body.length), ...body];
};

function fixed32Field(field: number, value: number): number[] {
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setFloat32(0, value, true);
  return [...varint(tag(field, 5)), ...new Uint8Array(buffer)];
}

const nest = (field: number, body: number[]): number[] => [
  ...varint(tag(field, 2)),
  ...varint(body.length),
  ...body,
];

/** A page holding `count` strokes, each with geometry, pressures, colour and width. */
function pageBytes(count: number, offset = 0): Uint8Array {
  const body: number[] = [];
  for (let s = 0; s < count; s++) {
    const points: number[] = [];
    const pressures: number[] = [];
    for (let i = 0; i < 6; i++) {
      points.push(80 + offset + s * 40 + i * 5, 120 + offset + i * 18);
      pressures.push(0.3 + i * 0.1);
    }
    body.push(
      ...nest(3, [
        ...floatField(4, points),
        ...floatField(5, pressures),
        ...floatField(6, [0.1, 0.1, 0.1, 1]),
        ...fixed32Field(7, 1.6),
      ]),
    );
  }
  return new Uint8Array(body);
}

/** A literals-only LZ4 block, which is a legal block and needs no compressor. */
function lz4Literals(payload: Uint8Array): Uint8Array {
  const header: number[] = [];
  if (payload.length < 15) {
    header.push(payload.length << 4);
  } else {
    header.push(0xf0);
    let remaining = payload.length - 15;
    while (remaining >= 255) {
      header.push(255);
      remaining -= 255;
    }
    header.push(remaining);
  }
  return new Uint8Array([...header, ...payload]);
}

/** Wrap a payload in Apple's `bv41` frame, the way GoodNotes wraps some entries. */
function appleFramed(payload: Uint8Array): Uint8Array {
  const block = lz4Literals(payload);
  const out = new Uint8Array(12 + block.length + 4);
  out.set(utf8('bv41'), 0);
  const view = new DataView(out.buffer);
  view.setUint32(4, payload.length, true);
  view.setUint32(8, block.length, true);
  out.set(block, 12);
  out.set(utf8('bv4$'), 12 + block.length);
  return out;
}

interface Entry {
  name: string;
  body: Uint8Array;
}

/** A stored-only ZIP, which is all these tests need. */
function buildZip(entries: Entry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = utf8(entry.name);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, METHOD_STORED, true);
    lv.setUint32(18, entry.body.length, true);
    lv.setUint32(22, entry.body.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local, entry.body);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, METHOD_STORED, true);
    cv.setUint32(20, entry.body.length, true);
    cv.setUint32(24, entry.body.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    directory.push(central);

    offset += local.length + entry.body.length;
  }

  const directoryBytes = directory.reduce((n, d) => n + d.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, directoryBytes, true);
  ev.setUint32(16, offset, true);

  const all = [...parts, ...directory, end];
  const out = new Uint8Array(all.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe('recognising a notebook by name', () => {
  it('matches the extension, through a query string and whatever the case', () => {
    expect(isGoodNotesName('Chemistry.goodnotes')).toBe(true);
    expect(isGoodNotesName('/sdcard/Download/Week 3.GOODNOTES')).toBe(true);
    expect(isGoodNotesName('content://downloads/7/Notes.goodnotes?take=1')).toBe(true);

    expect(isGoodNotesName('Chemistry.pdf')).toBe(false);
    expect(isGoodNotesName('goodnotes')).toBe(false);
    expect(isGoodNotesName('')).toBe(false);
    expect(GOODNOTES_EXTENSION).toBe('goodnotes');
  });
});

describe('importing a notebook', () => {
  it('turns each entry holding ink into a page, in natural order', async () => {
    const zip = buildZip([
      { name: 'Document/metadata.plist', body: utf8('<plist><dict/></plist>') },
      { name: 'notes/page10.data', body: pageBytes(1, 300) },
      { name: 'notes/page2.data', body: pageBytes(2, 100) },
    ]);
    const { document, report } = await importGoodNotes(zip, { fileName: 'Chemistry.goodnotes' });

    expect(document.title).toBe('Chemistry');
    expect(document.pages).toHaveLength(2);
    // page2 before page10: a plain string sort puts page10 first.
    expect(report.pageEntries).toEqual(['notes/page2.data', 'notes/page10.data']);
    expect(document.pages[0]!.strokes).toHaveLength(2);
    expect(document.pages[1]!.strokes).toHaveLength(1);
    expect(report.strokes).toBe(3);
    expect(document.pages.map((page) => page.pageNumber)).toEqual([1, 2]);
  });

  it('unwraps an entry wrapped in Apple’s LZ4 frame', async () => {
    // Which is the whole reason the LZ4 layer exists: the payload underneath is
    // the same protobuf either way.
    const plain = buildZip([{ name: 'notes/1.data', body: pageBytes(2) }]);
    const framed = buildZip([{ name: 'notes/1.data', body: appleFramed(pageBytes(2)) }]);
    const a = await importGoodNotes(plain, { fileName: 'a.goodnotes' });
    const b = await importGoodNotes(framed, { fileName: 'a.goodnotes' });
    expect(b.report.strokes).toBe(a.report.strokes);
    expect(inkOf(b.document.pages[0]!.strokes)[0]!.points).toEqual(inkOf(a.document.pages[0]!.strokes)[0]!.points);
  });

  it('does not look for ink in images or in the PDF a notebook was built on', async () => {
    // A JPEG's bytes are full of runs that read as floats; treating one as a
    // page would produce a page of noise.
    const zip = buildZip([
      { name: 'notes/1.data', body: pageBytes(1) },
      { name: 'thumbnails/1.png', body: new Uint8Array(4096).fill(0x42) },
      { name: 'Document/original.pdf', body: utf8('%PDF-1.7 ...') },
    ]);
    const { document, report } = await importGoodNotes(zip, { fileName: 'a.goodnotes' });
    expect(document.pages).toHaveLength(1);
    // And the PDF is mentioned, because opening it is the better route.
    expect(report.warnings.join(' ')).toMatch(/built on a PDF/);
  });

  it('says plainly that everything came in as a pen stroke', async () => {
    const zip = buildZip([{ name: 'notes/1.data', body: pageBytes(1) }]);
    const { document, report } = await importGoodNotes(zip, { fileName: 'a.goodnotes' });
    expect(report.warnings.join(' ')).toMatch(/came in as pen strokes/);
    expect(document.pages[0]!.strokes.every((stroke) => stroke.tool === 'pen')).toBe(true);
  });

  it('fits every page on one scale and keeps the ink on the page', async () => {
    const zip = buildZip([
      { name: 'notes/1.data', body: pageBytes(2, 0) },
      { name: 'notes/2.data', body: pageBytes(2, 400) },
    ]);
    const { document, report } = await importGoodNotes(zip, {
      fileName: 'a.goodnotes',
      dimensions: { width: 794, height: 1123 },
    });
    expect(report.fit.matched).toBe(true);
    for (const page of document.pages) {
      for (const stroke of inkOf(page.strokes)) {
        for (const point of stroke.points) {
          expect(point.x).toBeGreaterThanOrEqual(0);
          expect(point.x).toBeLessThanOrEqual(794);
          expect(point.y).toBeGreaterThanOrEqual(0);
          expect(point.y).toBeLessThanOrEqual(1123);
        }
      }
    }
  });

  it('lists what the archive held, whether or not the import worked', async () => {
    const zip = buildZip([
      { name: 'notes/1.data', body: pageBytes(1) },
      { name: 'Document/metadata.plist', body: utf8('<plist/>') },
    ]);
    const { report } = await importGoodNotes(zip, { fileName: 'a.goodnotes' });
    expect(report.entries.map((entry) => entry.name)).toEqual(['notes/1.data', 'Document/metadata.plist']);
    expect(report.entries[1]!.bytes).toBe(8);
  });

  it('counts what the confidence threshold set aside', async () => {
    // A bare coordinate run with nothing beside it to confirm it.
    const bare = new Uint8Array(nest(3, floatField(4, [10, 20, 30, 45, 50, 70])));
    const zip = buildZip([{ name: 'notes/1.data', body: bare }]);
    await expect(importGoodNotes(zip, { fileName: 'a.goodnotes' })).rejects.toThrow(GoodNotesImportError);
    // Told to accept everything, the same archive imports.
    const { report } = await importGoodNotes(zip, { fileName: 'a.goodnotes', minConfidence: 0 });
    expect(report.strokes).toBe(1);
    expect(report.setAside).toBe(0);
  });

  it('mentions what it set aside when it imported something anyway', async () => {
    const zip = buildZip([
      { name: 'notes/1.data', body: pageBytes(1) },
      { name: 'notes/2.data', body: new Uint8Array(nest(3, floatField(4, [10, 20, 30, 45, 50, 70]))) },
    ]);
    const { report } = await importGoodNotes(zip, { fileName: 'a.goodnotes' });
    expect(report.setAside).toBe(1);
    expect(report.warnings.join(' ')).toMatch(/left out/);
  });
});

describe('when it cannot be imported', () => {
  it('says a file is not an archive at all, rather than failing obscurely', async () => {
    await expect(importGoodNotes(utf8('%PDF-1.7 not a notebook'))).rejects.toThrow(/not a GoodNotes archive/);
  });

  it('reports a damaged archive in the words the ZIP reader used', async () => {
    const zip = buildZip([{ name: 'notes/1.data', body: pageBytes(1) }]);
    const directoryOffset = new DataView(zip.buffer).getUint32(zip.length - 6, true);
    zip[directoryOffset] = 0;
    await expect(importGoodNotes(zip)).rejects.toThrow(/damaged/);
  });

  it('names the archive’s contents and offers the PDF route when it finds no ink', async () => {
    // The honest fallback. Every clause here is load-bearing: it proves the file
    // was read, shows the user their pages are in there, and gives them
    // something to do about it.
    const zip = buildZip([
      { name: 'Document/metadata.plist', body: utf8('<plist><dict/></plist>') },
      { name: 'thumbnails/1.png', body: new Uint8Array(2048).fill(7) },
      { name: 'notes/index.json', body: utf8('{"pages":14}') },
    ]);
    const error = await importGoodNotes(zip, { fileName: 'a.goodnotes' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoodNotesImportError);
    const thrown = error as GoodNotesImportError;
    expect(thrown.message).toMatch(/No strokes could be recovered/);
    expect(thrown.message).toMatch(/3 files/);
    expect(thrown.message).toMatch(/thumbnails\/1\.png/);
    expect(thrown.message).toMatch(/Export the notebook as a PDF/);
    // The listing travels with the error, so a caller can show it.
    expect(thrown.entries).toHaveLength(3);
  });

  it('carries an empty listing rather than throwing again when there is nothing to list', async () => {
    const empty = buildZip([]);
    const error = await importGoodNotes(empty).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoodNotesImportError);
    expect((error as GoodNotesImportError).entries).toEqual([]);
    expect((error as GoodNotesImportError).message).toMatch(/nothing this importer could list/);
  });
});

describe('describing an archive without importing it', () => {
  it('lists the entries', () => {
    const zip = buildZip([
      { name: 'notes/1.data', body: pageBytes(1) },
      { name: 'Document/metadata.plist', body: utf8('<plist/>') },
    ]);
    expect(describeGoodNotesArchive(zip).map((entry) => entry.name)).toEqual([
      'notes/1.data',
      'Document/metadata.plist',
    ]);
  });

  it('answers with nothing for something that is not an archive', () => {
    // A diagnostic, so it reports rather than throws.
    expect(describeGoodNotesArchive(utf8('%PDF-1.7'))).toEqual([]);
    expect(describeGoodNotesArchive(new Uint8Array(0))).toEqual([]);
  });
});
