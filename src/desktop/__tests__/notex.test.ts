import { describe, expect, it } from 'vitest';
import { A4_DIMENSIONS } from '../../document/constants';
import { appendStroke, createDocument, createPage } from '../../document/operations';
import type { Document, Page } from '../../document/types';
import type { Stroke } from '../../inking/types';
import { APP_INFO, NOTEX_VERSION, buildNotex, decodeNotex, encodeNotex, fileBaseName, parseNotex, titleFromFileName } from '../notex';

const style: Stroke['style'] = {
  color: '#1f1f24',
  size: 4,
  opacity: 1,
  compositeOperation: 'source-over',
  thinning: 0.6,
  smoothing: 0.5,
  streamline: 0.5,
  simulatePressure: false,
  taperStart: 0,
  taperEnd: 0,
  pattern: 'dashed',
  arrowheads: 'end',
};

const freehand: Stroke = {
  kind: 'freehand',
  id: 'f1',
  tool: 'pen',
  points: [
    { x: 10.25, y: 20.5, pressure: 0.31 },
    { x: 30, y: 40, pressure: 0.9 },
  ],
  style,
  bbox: { minX: 0, minY: 0, maxX: 50, maxY: 60 },
  pointerType: 'pen',
  createdAt: 1234.5,
};

const plane: Stroke = {
  kind: 'geometric',
  id: 'g1',
  tool: 'coordinate-plane',
  shape: {
    type: 'coordinate-plane',
    origin: { x: 300, y: 400 },
    extentX: 150,
    extentY: 100,
    config: { mode: 'quadrant-1', divisions: 4, showGrid: true, tickLabels: true, xLabel: 'Q', yLabel: 'P' },
  },
  style: { ...style, pattern: 'solid', arrowheads: 'none' },
  bbox: { minX: 100, minY: 250, maxX: 500, maxY: 550 },
  pointerType: 'mouse',
  createdAt: 99,
};

/** A document exercising every persisted feature. */
function richDocument(): Document {
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3]);
  const pdf = {
    sourceId: 'src_a',
    sourceName: 'lecture.pdf',
    data: pdfBytes.buffer,
    pageCount: 3,
    pageIndex: 2,
    viewBox: [0, 0, 612, 792] as const,
    rotation: 90,
    scale: 96 / 72,
  };
  const base = createDocument(1, 'Signals & Systems');
  const pageA: Page = appendStroke(
    appendStroke(createPage({ template: 'engineering', templateConfig: { spacing: 25, strokeColor: '#ff0000', strokeWidth: 1.5, marginOffset: 0 }, backgroundColor: '#1c1c21' }), freehand),
    plane,
  );
  const pageB: Page = {
    ...createPage({
      template: 'pdf',
      dimensions: { width: 1056, height: 816 },
      pdf,
      formFields: [
        { id: '10R', name: 'fullName', kind: 'text', box: { x: 1, y: 2, width: 300, height: 24 }, readOnly: false, maxLength: 40, textAlign: 'center', fontSize: 12 },
        { id: '11R', name: 'agree', kind: 'checkbox', box: { x: 5, y: 6, width: 18, height: 18 }, readOnly: false, exportValue: 'Yes' },
        { id: '12R', name: 'colour', kind: 'select', box: { x: 0, y: 0, width: 100, height: 20 }, readOnly: true, options: [{ label: 'Red', value: 'red' }] },
      ],
      formValues: { fullName: 'Ada', agree: true, colour: 'red' },
      media: [
        { kind: 'image' as const, id: 'img1', src: 'data:image/png;base64,iVBORw0KGgo=', mime: 'image/png', x: 10, y: 20, width: 200, height: 100, rotation: 33.3, zIndex: 2, naturalWidth: 400, naturalHeight: 200 },
        { kind: 'image' as const, id: 'img2', src: 'data:image/jpeg;base64,/9j/4AAQ', mime: 'image/jpeg', x: 50, y: 60, width: 80, height: 80, rotation: 0, zIndex: 1, naturalWidth: 80, naturalHeight: 80 },
      ],
    }),
  };
  const pageC: Page = createPage({ template: 'isometric', dimensions: A4_DIMENSIONS });
  return { ...base, pages: [pageA, pageB, pageC].map((p, i) => ({ ...p, pageNumber: i + 1 })), zoom: 1.25, viewMode: 'single-page', activePageIndex: 1 };
}

/** What a faithful round trip must reproduce: everything except undo history. */
function persisted(doc: Document) {
  return {
    ...doc,
    pages: doc.pages.map((p) => ({
      ...p,
      undoStack: [],
      redoStack: [],
      ...(p.pdf ? { pdf: { ...p.pdf, data: [...new Uint8Array(p.pdf.data)] } } : {}),
    })),
  };
}

describe('.notex round trip', () => {
  it('reproduces the document state exactly (minus undo history)', () => {
    const original = richDocument();
    const text = encodeNotex(original, new Date('2026-09-17T06:00:00Z'));
    const restored = decodeNotex(text);
    expect(persisted(restored)).toEqual(persisted(original));
    // Stroke arrays are deep-equal, including the geometric shape config and float coordinates.
    expect(restored.pages[0]?.strokes).toEqual(original.pages[0]?.strokes);
    // PDF bytes come back byte-for-byte in a fresh buffer.
    const bytes = restored.pages[1]?.pdf?.data;
    expect(bytes).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(bytes ?? new ArrayBuffer(0))]).toEqual([...new Uint8Array(original.pages[1]?.pdf?.data ?? new ArrayBuffer(0))]);
  });

  it('writes a versioned envelope with metadata', () => {
    const file = buildNotex(richDocument(), new Date('2026-09-17T06:00:00Z'));
    expect(file.format).toBe('notex');
    expect(file.version).toBe(NOTEX_VERSION);
    expect(file.savedAt).toBe('2026-09-17T06:00:00.000Z');
    expect(file.app).toEqual(APP_INFO);
    expect(file.document.pages).toHaveLength(3);
    expect(Object.keys(file.document.pdfSources ?? {})).toEqual(['src_a']);
    const parsed = parseNotex(JSON.stringify(file));
    expect(parsed.savedAt).toBe('2026-09-17T06:00:00.000Z');
  });

  it('is stable across two encode passes', () => {
    const doc = richDocument();
    const when = new Date('2026-01-01T00:00:00Z');
    const once = encodeNotex(doc, when);
    expect(encodeNotex(decodeNotex(once), when)).toBe(once);
  });

  it('accepts a bare serialized document (.json) and rejects other files', () => {
    const doc = richDocument();
    const bare = JSON.stringify(buildNotex(doc).document);
    expect(parseNotex(bare).savedAt).toBeNull();
    expect(decodeNotex(bare).title).toBe('Signals & Systems');
    expect(() => parseNotex('{"hello":"world"}')).toThrow(/Not a KK-Notes document/);
    expect(() => parseNotex('[]')).toThrow(/Not a KK-Notes document/);
    expect(() => parseNotex(JSON.stringify({ format: 'notex', version: 2, document: {} }))).toThrow(/version/);
    expect(() => parseNotex('not json')).toThrow();
  });

  it('derives titles and base names from paths on either platform', () => {
    expect(fileBaseName('C:\\Users\\me\\Documents\\Lecture 3.notex')).toBe('Lecture 3.notex');
    expect(fileBaseName('/home/me/notes/lab.json')).toBe('lab.json');
    expect(titleFromFileName('C:\\Users\\me\\Lecture 3.notex')).toBe('Lecture 3');
    expect(titleFromFileName('/tmp/.notex')).toBe('Untitled note');
  });
});
