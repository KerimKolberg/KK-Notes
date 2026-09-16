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
