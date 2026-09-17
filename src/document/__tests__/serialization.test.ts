import { describe, expect, it } from 'vitest';
import type { Stroke } from '../../inking/types';
import { appendStroke, createDocument } from '../operations';
import { deserializeDocument, fromSerializable, serializeDocument, toSerializable } from '../serialization';

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
      viewMode: 'single',
      activePageIndex: 1,
      pages: [appendStroke(appendStroke(first, freehand), plane), { ...second, template: 'isometric', backgroundColor: '#1c1c21' }],
    };

    const json = serializeDocument(doc);
    const back = deserializeDocument(json);

    expect(back.id).toBe(doc.id);
    expect(back.title).toBe('Signals');
    expect(back.zoom).toBe(1.5);
    expect(back.viewMode).toBe('single');
    expect(back.activePageIndex).toBe(1);
    expect(back.pages).toHaveLength(2);
    expect(back.pages[0]?.strokes).toEqual([freehand, plane]);
    expect(back.pages[0]?.undoStack).toEqual([]);
    expect(back.pages[0]?.redoStack).toEqual([]);
    expect(back.pages[1]).toMatchObject({ template: 'isometric', backgroundColor: '#1c1c21', pageNumber: 2 });
    expect(JSON.parse(json)).not.toHaveProperty('pages.0.undoStack');
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
    expect(b2.images).toEqual(pdfPage2.images);
    expect(b1.images).toEqual([]);
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
