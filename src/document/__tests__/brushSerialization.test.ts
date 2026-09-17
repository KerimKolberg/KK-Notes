/**
 * Strokes from the brush engine must survive a save / load unchanged: the
 * brush id, the baked perfect-freehand parameters and any stylus tilt are all
 * part of the wire format.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_TOOL_SETTINGS } from '../../inking/constants';
import { BRUSHES, brushById } from '../../inking/engine/brushes';
import { StrokeBuilder } from '../../inking/engine/strokeBuilder';
import { styleForTool } from '../../inking/engine/toolStyles';
import type { BrushId, FreehandStroke, InkPoint, Stroke } from '../../inking/types';
import { appendStroke, createDocument } from '../operations';
import { deserializeDocument, serializeDocument } from '../serialization';
import type { Document } from '../types';

const samples: readonly InkPoint[] = [
  { x: 10, y: 10, pressure: 0.2, tilt: 0 },
  { x: 40, y: 32, pressure: 0.6, tilt: 0.45 },
  { x: 90, y: 30, pressure: 0.95, tilt: 0.9 },
  { x: 140, y: 60, pressure: 0.4 },
];

function strokeWithBrush(brush: BrushId): Stroke {
  const style = styleForTool('pen', { ...DEFAULT_TOOL_SETTINGS, brush, color: '#123456', size: 5 }, 'pen');
  const builder = new StrokeBuilder('pen', style, 'pen');
  for (const point of samples) builder.add(point);
  return builder.build();
}

function documentWithEveryBrush(): Document {
  const doc = createDocument(1);
  const page = doc.pages[0]!;
  const withStrokes = BRUSHES.reduce((acc, brush) => appendStroke(acc, strokeWithBrush(brush.id)), page);
  return { ...doc, pages: [withStrokes] };
}

describe('brush stroke serialization', () => {
  it('round-trips every brush id and its baked parameters', () => {
    const doc = documentWithEveryBrush();
    const back = deserializeDocument(serializeDocument(doc));
    const before = doc.pages[0]!.strokes;
    const after = back.pages[0]!.strokes;

    expect(after).toHaveLength(BRUSHES.length);
    expect(after.map((s) => s.style.brush)).toEqual(BRUSHES.map((b) => b.id));
    for (let i = 0; i < before.length; i++) {
      expect(after[i]!.style).toEqual(before[i]!.style);
      expect(after[i]!.id).toBe(before[i]!.id);
      expect(after[i]!.bbox).toEqual(before[i]!.bbox);
    }
  });

  it('keeps the stylus tilt recorded on each sample', () => {
    const doc = documentWithEveryBrush();
    const back = deserializeDocument(serializeDocument(doc));
    const stroke = back.pages[0]!.strokes[0] as FreehandStroke;
    expect(stroke.points.map((p) => p.tilt)).toEqual([0, 0.45, 0.9, undefined]);
    expect(stroke.points.map((p) => p.pressure)).toEqual(samples.map((p) => p.pressure));
  });

  it('a marker keeps its multiply blend and a pencil its grain after reloading', () => {
    const doc = documentWithEveryBrush();
    const back = deserializeDocument(serializeDocument(doc));
    const byBrush = new Map(back.pages[0]!.strokes.map((s) => [s.style.brush, s]));
    expect(byBrush.get('marker')?.style.compositeOperation).toBe('multiply');
    expect(byBrush.get('marker')?.style.opacity).toBeLessThan(1);
    expect(brushById(byBrush.get('pencil')?.style.brush).texture).toBe('pencil');
    expect(brushById(byBrush.get('ballpoint')?.style.brush).smoothOutline).toBe(false);
  });

  it('reads a stroke saved before brushes existed, and paints it with the default', () => {
    const doc = createDocument(1);
    const legacy = strokeWithBrush('fountain') as FreehandStroke;
    const { brush: _dropped, ...styleWithoutBrush } = legacy.style;
    const page = appendStroke(doc.pages[0]!, { ...legacy, style: styleWithoutBrush });
    const back = deserializeDocument(serializeDocument({ ...doc, pages: [page] }));
    const stroke = back.pages[0]!.strokes[0]!;
    expect(stroke.style.brush).toBeUndefined();
    expect(brushById(stroke.style.brush).id).toBe('ballpoint');
    expect(stroke.style.thinning).toBeCloseTo(legacy.style.thinning);
  });
});
