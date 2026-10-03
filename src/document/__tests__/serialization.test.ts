import { describe, expect, it } from 'vitest';
import type { Stroke } from '../../inking/types';
import { appendStroke, createDocument } from '../operations';
import {
  deserializeDocument,
  documentPieces,
  fromSerializable,
  piecesToBytes,
  piecesToText,
  serializeDocument,
  serializeDocumentJson,
  serializePageJson,
  toSerializable,
} from '../serialization';
import type { Document } from '../types';

const freehand: Stroke = {
  kind: 'freehand',
  id: 'f1',
  tool: 'highlighter',
  points: [
    { x: 1.5, y: 2.25, pressure: 0.5 },
    { x: 30, y: 40, pressure: 0.9 },
  ],
  style: {
    color: '#ca8a04',
    size: 16,
    opacity: 0.35,
    compositeOperation: 'multiply',
    thinning: 0,
    smoothing: 0.6,
    streamline: 0.6,
    simulatePressure: false,
    taperStart: 0,
    taperEnd: 0,
    pattern: 'dotted',
    arrowheads: 'both',
  },
  bbox: { minX: -10, minY: -10, maxX: 50, maxY: 60 },
  pointerType: 'touch',
  createdAt: 123,
};

const plane: Stroke = {
  kind: 'geometric',
  id: 'g1',
  tool: 'coordinate-plane',
  shape: {
    type: 'coordinate-plane',
    origin: { x: 200, y: 300 },
    extentX: 150,
    extentY: 100,
    config: { mode: 'four-quadrant', divisions: 5, showGrid: true, tickLabels: true, xLabel: 'σ', yLabel: 'jω' },
  },
  style: { ...freehand.style, compositeOperation: 'source-over', pattern: 'solid', arrowheads: 'none' },
  bbox: { minX: 0, minY: 150, maxX: 400, maxY: 450 },
  pointerType: 'pen',
  createdAt: 456,
};

describe('document serialization', () => {
  it('round-trips pages and strokes and drops history', () => {
    let doc = createDocument(2, 'Signals');
    const first = doc.pages[0];
    const second = doc.pages[1];
    if (!first || !second) throw new Error('pages');
    doc = {
      ...doc,
      zoom: 1.5,
      viewMode: 'single-page',
      activePageIndex: 1,
      pages: [appendStroke(appendStroke(first, freehand), plane), { ...second, template: 'isometric', backgroundColor: '#1c1c21' }],
    };

    const json = serializeDocument(doc);
    const back = deserializeDocument(json);

    expect(back.id).toBe(doc.id);
    expect(back.title).toBe('Signals');
    expect(back.zoom).toBe(1.5);
    expect(back.viewMode).toBe('single-page');
    expect(back.activePageIndex).toBe(1);
    expect(back.pages).toHaveLength(2);
    expect(back.pages[0]?.strokes).toEqual([freehand, plane]);
    expect(back.pages[0]?.undoStack).toEqual([]);
    expect(back.pages[0]?.redoStack).toEqual([]);
    expect(back.pages[1]).toMatchObject({ template: 'isometric', backgroundColor: '#1c1c21', pageNumber: 2 });
    expect(JSON.parse(json)).not.toHaveProperty('pages.0.undoStack');
  });

  it('round-trips the notebook cover, and omits it when there is none', () => {
    const doc = createDocument(1, 'Field notes');
    const cover = { title: 'Field notes', description: 'Summer 2026', coverColor: '#1e3a5f', textColor: '#f8fafc' };
    const back = deserializeDocument(serializeDocument({ ...doc, cover }));
    expect(back.cover).toEqual(cover);

    const plain = serializeDocument(doc);
    expect(JSON.parse(plain)).not.toHaveProperty('cover');
    expect(deserializeDocument(plain).cover).toBeUndefined();
  });

  it('round-trips the template spacing of each page', () => {
    const doc = createDocument(2);
    const [first, second] = doc.pages;
    const pages = [
      { ...first!, template: 'ruled' as const, templateConfig: { ...first!.templateConfig, spacing: 26.5 } },
      { ...second!, template: 'grid' as const, templateConfig: { ...second!.templateConfig, spacing: 18.9, strokeWidth: 0.75 } },
    ];
    const back = deserializeDocument(serializeDocument({ ...doc, pages }));
    expect(back.pages[0]?.templateConfig.spacing).toBe(26.5);
    expect(back.pages[1]?.templateConfig).toMatchObject({ spacing: 18.9, strokeWidth: 0.75 });
  });

  it('migrates the view mode of files written before horizontal scrolling', () => {
    const doc = createDocument(1);
    const legacy = (mode: string): string => {
      const parsed: Record<string, unknown> = JSON.parse(serializeDocument(doc));
      parsed.viewMode = mode;
      return JSON.stringify(parsed);
    };
    expect(deserializeDocument(legacy('continuous')).viewMode).toBe('vertical-continuous');
    expect(deserializeDocument(legacy('single')).viewMode).toBe('single-page');
    expect(deserializeDocument(legacy('horizontal-continuous')).viewMode).toBe('horizontal-continuous');
    expect(deserializeDocument(legacy('nonsense')).viewMode).toBe('vertical-continuous');
  });

  it('round-trips PDF-backed pages, storing the bytes once per source', () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // "%PDF-1.7"
    const data = bytes.buffer;
    const ref = { sourceId: 'src1', sourceName: 'form.pdf', data, pageCount: 2, pageIndex: 0, viewBox: [0, 0, 612, 792] as const, rotation: 0, scale: 96 / 72 };
    let doc = createDocument(1, 'Forms');
    const first = doc.pages[0];
    if (!first) throw new Error('page');
    const pdfPage1 = { ...first, template: 'pdf' as const, pdf: ref, formFields: [{ id: '1R', name: 'fullName', kind: 'text' as const, box: { x: 1, y: 2, width: 3, height: 4 }, readOnly: false }], formValues: { fullName: 'Ada', agree: true } };
    const pdfPage2 = { ...first, id: 'p2', template: 'pdf' as const, pdf: { ...ref, pageIndex: 1 }, images: [{ id: 'img1', src: 'data:image/png;base64,AAAA', mime: 'image/png', x: 10, y: 20, width: 30, height: 40, rotation: 15, zIndex: 1, naturalWidth: 60, naturalHeight: 80 }] };
    doc = { ...doc, pages: [pdfPage1, pdfPage2] };

    const serialized = toSerializable(doc);
    expect(Object.keys(serialized.pdfSources ?? {})).toEqual(['src1']);
    expect(serialized.pdfSources?.src1?.data).toBe(btoa('%PDF-1.7'));

    const back = deserializeDocument(serializeDocument(doc));
    const b1 = back.pages[0];
    const b2 = back.pages[1];
    if (!b1?.pdf || !b2?.pdf) throw new Error('pdf refs');
    expect(new Uint8Array(b1.pdf.data)).toEqual(bytes);
    expect(b1.pdf).toMatchObject({ sourceId: 'src1', sourceName: 'form.pdf', pageCount: 2, pageIndex: 0, rotation: 0 });
    expect(b2.pdf.pageIndex).toBe(1);
    expect(b2.pdf.data).toBe(b1.pdf.data); // shared buffer
    expect(b1.formFields).toEqual(pdfPage1.formFields);
    expect(b1.formValues).toEqual({ fullName: 'Ada', agree: true });
    expect(b2.media).toEqual(pdfPage2.media);
    expect(b1.media).toEqual([]);
  });

  it('serializes to a stable, history-free shape', () => {
    const doc = createDocument(1);
    const data = toSerializable(doc);
    expect(data.version).toBe(1);
    expect(Object.keys(data.pages[0] ?? {})).toEqual(['id', 'dimensions', 'template', 'templateConfig', 'backgroundColor', 'strokes']);
  });

  it('validates and clamps on load', () => {
    const doc = createDocument(2);
    const data = toSerializable(doc);
    expect(() => fromSerializable({ ...data, version: 2 as unknown as 1 })).toThrow(/version/);
    expect(() => fromSerializable({ ...data, pages: [] })).toThrow(/at least one page/);
    const clamped = fromSerializable({ ...data, zoom: 99, activePageIndex: 42 });
    expect(clamped.zoom).toBe(3);
    expect(clamped.activePageIndex).toBe(1);
    expect(() => deserializeDocument('null')).toThrow();
  });
});

/** Three pages, a stroke on each. */
const twoPages = () => {
  let doc = createDocument(3, 'Notes');
  doc = { ...doc, pages: doc.pages.map((page, i) => appendStroke(page, { ...freehand, id: `s${i}` })) };
  return doc;
};

describe('serialising for autosave', () => {

  it('writes the same document the plain stringify does', () => {
    const doc = twoPages();
    expect(JSON.parse(serializeDocumentJson(doc))).toEqual(JSON.parse(JSON.stringify(toSerializable(doc))));
  });

  it('writes the same document with PDF sources in it', () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer;
    const doc = twoPages();
    const first = doc.pages[0];
    if (!first) throw new Error('page');
    const withPdf = {
      ...doc,
      pages: [
        { ...first, template: 'pdf' as const, pdf: { sourceId: 's', sourceName: 'a.pdf', data: bytes, pageCount: 1, pageIndex: 0, viewBox: [0, 0, 612, 792] as const, rotation: 0, scale: 1 } },
        ...doc.pages.slice(1),
      ],
    };
    expect(JSON.parse(serializeDocumentJson(withPdf))).toEqual(JSON.parse(JSON.stringify(toSerializable(withPdf))));
  });

  it('gives a page the same text every time it is asked, and a new page its own', () => {
    const [page] = twoPages().pages;
    if (!page) throw new Error('page');
    const first = serializePageJson(page);
    expect(serializePageJson(page)).toBe(first);
    const edited = appendStroke(page, { ...freehand, id: 'another' });
    expect(serializePageJson(edited)).not.toBe(first);
    expect(JSON.parse(serializePageJson(edited)).strokes).toHaveLength(2);
    // The old page is untouched by the new one.
    expect(serializePageJson(page)).toBe(first);
  });

  it('shows an edit to one page and leaves the others as they were', () => {
    const doc = twoPages();
    const before = serializeDocumentJson(doc);
    const [a, b, c] = doc.pages;
    if (!a || !b || !c) throw new Error('pages');
    const edited = { ...doc, pages: [a, appendStroke(b, { ...freehand, id: 'later' }), c] };
    const after = JSON.parse(serializeDocumentJson(edited));
    expect(after.pages[0]).toEqual(JSON.parse(before).pages[0]);
    expect(after.pages[1].strokes.map((s: { id: string }) => s.id)).toEqual(['s1', 'later']);
    expect(after.pages[2]).toEqual(JSON.parse(before).pages[2]);
    // And what it writes is what a fresh serialiser would.
    expect(after).toEqual(JSON.parse(JSON.stringify(toSerializable(edited))));
  });

  it('round-trips through a load', () => {
    const doc = twoPages();
    const back = deserializeDocument(serializeDocumentJson(doc));
    expect(back.pages.map((p) => p.strokes.length)).toEqual([1, 1, 1]);
    expect(serializeDocumentJson(back)).toBe(serializeDocumentJson(back));
  });
});

describe('writing a note as pieces', () => {
  /** What the writer produced before it was assembled from pieces: the shell stringified, then the pages. */
  const asBefore = (doc: Document): string => {
    const { pages: _pages, ...shell } = toSerializable(doc);
    void _pages;
    return `${JSON.stringify(shell).slice(0, -1)},"pages":[${doc.pages.map((p) => JSON.stringify(toSerializable({ ...doc, pages: [p] }).pages[0])).join(',')}]}`;
  };
  const pdf = (sourceId: string, bytes: number[], pageIndex = 0) => ({
    sourceId,
    sourceName: `${sourceId} “notes”.pdf`,
    data: new Uint8Array(bytes).buffer,
    pageCount: 2,
    pageIndex,
    viewBox: [0, 0, 612, 792] as const,
    rotation: 0,
    scale: 1,
  });
  const full = (): Document => {
    const doc = createDocument(3, 'Lineare Algebra — Übung 3 ✓');
    const [a, b, c] = doc.pages;
    if (!a || !b || !c) throw new Error('pages');
    const one = pdf('s1', [0x25, 0x50, 0x44, 0x46, 0xff, 0x00]);
    return {
      ...doc,
      cover: { title: 'Linear Algebra', description: 'Übungen', coverColor: '#123456', textColor: '#ffffff' },
      pages: [
        { ...appendStroke(a, freehand), template: 'pdf' as const, pdf: one },
        { ...b, template: 'pdf' as const, pdf: { ...one, pageIndex: 1 } },
        { ...appendStroke(c, plane), template: 'pdf' as const, pdf: pdf('s2', [1, 2, 3, 4, 5]) },
      ],
      recordings: [
        { id: 'r1', startedAt: '2026-10-03T09:00:00.000Z', duration: 61.5, mime: 'audio/webm;codecs=opus', data: new Uint8Array([9, 8, 7]).buffer, marks: [{ strokeId: 'f1', t: 1.25 }] },
        { id: 'r2', startedAt: '2026-10-03T10:00:00.000Z', duration: 2, mime: 'audio/webm', data: new Uint8Array([]).buffer, marks: [] },
      ],
    };
  };

  it('writes exactly what the plain stringify did, PDFs, recordings and all', () => {
    for (const doc of [twoPages(), full()]) expect(serializeDocumentJson(doc)).toBe(asBefore(doc));
  });

  it('writes the same as bytes as it does as text, accents and all', () => {
    for (const doc of [twoPages(), full()]) {
      const pieces = documentPieces(doc);
      expect(new TextDecoder().decode(piecesToBytes(pieces))).toBe(piecesToText(pieces));
    }
  });

  it('reads back what it writes', () => {
    const doc = full();
    const back = deserializeDocument(new TextDecoder().decode(piecesToBytes(documentPieces(doc))));
    expect(back.title).toBe(doc.title);
    expect(back.pages.map((p) => p.pdf?.sourceId)).toEqual(['s1', 's1', 's2']);
    expect([...new Uint8Array(back.pages[0]!.pdf!.data)]).toEqual([0x25, 0x50, 0x44, 0x46, 0xff, 0x00]);
    expect(back.recordings!.map((r) => [...new Uint8Array(r.data)])).toEqual([[9, 8, 7], []]);
    expect(back.recordings![0]!.marks).toEqual([{ strokeId: 'f1', t: 1.25 }]);
  });

  it('puts each embedded file in once, however many pages it backs', () => {
    expect(documentPieces(full()).filter((p) => typeof p !== 'string' && 'base64' in p)).toHaveLength(4);
  });
});
