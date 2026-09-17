/**
 * End-to-end check that a procedural curve survives the whole export: not just
 * that `pdfOps` describes it, but that pdf-lib writes real vector path
 * operators for it into the page's content stream.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { DEFAULT_TOOL_SETTINGS } from '../../inking/constants';
import { createGeometricStroke, curvePoints } from '../../inking/engine/shapes';
import { styleForTool } from '../../inking/engine/toolStyles';
import type { CurveKind, CurveShape, Stroke, StrokeStyle } from '../../inking/types';
import { createDocument } from '../../document/operations';
import { exportDocumentToPdf } from '../export';

const shapeOf = (kind: CurveKind): CurveShape => ({
  type: 'curve',
  kind,
  from: { x: 100, y: 400 },
  to: { x: 300, y: 400 },
  amplitude: 30,
  cycles: 3,
});

function strokeOf(kind: CurveKind, style: Partial<StrokeStyle> = {}): Stroke {
  return createGeometricStroke({
    tool: 'line',
    shape: shapeOf(kind),
    style: { ...styleForTool('line', DEFAULT_TOOL_SETTINGS, 'pen'), ...style },
    pointerType: 'pen',
    createdAt: 0,
  });
}

/**
 * The page's content stream, read back out of the finished file and decoded.
 * pdf-lib Flate-compresses it on the way out, so nothing is readable until it
 * is loaded again — which also proves the output parses as a real PDF.
 */
async function pageContent(bytes: Uint8Array): Promise<string> {
  const loaded = await PDFDocument.load(bytes);
  const page = loaded.getPage(0);
  const streams = page.node.normalizedEntries().Contents;
  if (!streams) return '';
  const parts: string[] = [];
  for (let i = 0; i < streams.size(); i++) {
    const stream = loaded.context.lookup(streams.get(i));
    if (stream instanceof PDFRawStream) parts.push(new TextDecoder('latin1').decode(decodePDFRawStream(stream).decode()));
  }
  return parts.join('\n');
}

/** Operands of every `x y l` lineto in a content stream. */
function linetos(content: string): Array<[number, number]> {
  return [...content.matchAll(/(-?[\d.]+) (-?[\d.]+) l\b/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

/** …and of every `x y m` moveto, which is where each subpath begins. */
function movetos(content: string): Array<[number, number]> {
  return [...content.matchAll(/(-?[\d.]+) (-?[\d.]+) m\b/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

async function exportWith(...strokes: Stroke[]): Promise<string> {
  const base = createDocument(1);
  const document = { ...base, pages: [{ ...base.pages[0]!, strokes }] };
  const bytes = await exportDocumentToPdf(document, { includeTemplates: false });
  expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
  return pageContent(bytes);
}

describe('exporting procedural curves to PDF', () => {
  it('writes a wave as a run of vector linetos spanning its amplitude', async () => {
    const content = await exportWith(strokeOf('wave'));
    const points = linetos(content);
    // One vertex per sample of the wave, minus the opening moveto.
    expect(points.length).toBe(curvePoints(shapeOf('wave')).length - 1);
    expect(content).toMatch(/\bm\b/);
    // A stroked path, not a filled one.
    expect(content).toMatch(/\bS\b/);

    // The wave is really in the geometry rather than flattened to its chord.
    // pdf-lib positions the path with its own `cm`, so the invariant to check
    // is the extent: 2 × 30 px of amplitude and 200 px of chord, at 0.75 pt/px.
    const k = 0.75;
    const span = (values: number[]): number => Math.max(...values) - Math.min(...values);
    const vertices = [...movetos(content), ...points];
    expect(span(vertices.map(([, y]) => y))).toBeCloseTo(60 * k, 1);
    expect(span(vertices.map(([x]) => x))).toBeCloseTo(200 * k, 1);
  });

  it('writes a zigzag as exactly its corners', async () => {
    const content = await exportWith(strokeOf('zigzag'));
    const corners = curvePoints(shapeOf('zigzag'));
    expect(corners).toHaveLength(8);
    expect(linetos(content)).toHaveLength(corners.length - 1);
  });

  it('carries the dash pattern into the content stream', async () => {
    const content = await exportWith(strokeOf('wave', { pattern: 'dashed' }));
    // `[a b] 0 d` is the PDF dash operator; solid strokes never emit one.
    expect(content).toMatch(/\[[\d. ]+\] \d+ d\b/);
    const solid = await exportWith(strokeOf('wave'));
    expect(solid).not.toMatch(/\[[\d.]+ [\d.]+\] \d+ d\b/);
  });

  it('keeps every curve kind on the page together', async () => {
    const content = await exportWith(strokeOf('wave'), strokeOf('zigzag'), strokeOf('parabola'));
    const expected =
      curvePoints(shapeOf('wave')).length + curvePoints(shapeOf('zigzag')).length + curvePoints(shapeOf('parabola')).length - 3;
    expect(linetos(content)).toHaveLength(expected);
  });
});
