import { describe, expect, it } from 'vitest';
import { A4_DIMENSIONS } from '../../document/constants';
import { cardAspect, pageVisualFrom } from '../thumbnail';

const page = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'p1',
  dimensions: { width: 794, height: 1123 },
  template: 'ruled',
  templateConfig: { spacing: 32, strokeColor: 'auto', strokeWidth: 1 },
  backgroundColor: '#fffdf5',
  strokes: [],
  ...over,
});

const stroke = {
  kind: 'freehand',
  id: 's1',
  tool: 'pen',
  points: [
    { x: 10, y: 10, pressure: 0.5 },
    { x: 80, y: 60, pressure: 0.5 },
  ],
  style: {
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
    pattern: 'solid',
    arrowheads: 'none',
  },
  bbox: { minX: 8, minY: 8, maxX: 82, maxY: 62 },
  pointerType: 'pen',
  createdAt: 0,
};

describe('extracting a card from one page', () => {
  it('hydrates just the visual half of a serialized page', () => {
    const visual = pageVisualFrom(page({ strokes: [stroke] }));
    expect(visual).not.toBeNull();
    expect(visual?.dimensions).toEqual(A4_DIMENSIONS);
    expect(visual?.template).toBe('ruled');
    expect(visual?.backgroundColor).toBe('#fffdf5');
    expect(visual?.strokes).toHaveLength(1);
    // The page number is a property of a document, not of one page, so it is
    // not in what a card needs and is not invented here.
    expect(visual).not.toHaveProperty('pageNumber');
  });

  it('fills in template defaults a file may have been written without', () => {
    const visual = pageVisualFrom(page({ templateConfig: { spacing: 40 } }));
    expect(visual?.templateConfig.spacing).toBe(40);
    expect(visual?.templateConfig.strokeWidth).toBeGreaterThan(0);
  });

  it('drops a PDF reference rather than failing on the source it cannot see', () => {
    // The PDF sources are the largest thing in a `.notex`, and fetching one to
    // draw a 200 px card is exactly the cost the library exists to avoid. The
    // card shows the page's own background, template and ink instead.
    const visual = pageVisualFrom(
      page({ pdf: { sourceId: 'missing', pageIndex: 0, viewBox: [0, 0, 612, 792], rotation: 0, scale: 1 }, strokes: [stroke] }),
    );
    expect(visual).not.toBeNull();
    expect(visual).not.toHaveProperty('pdf');
    expect(visual?.strokes).toHaveLength(1);
  });

  it('migrates a page written before notes and tables existed', () => {
    const visual = pageVisualFrom(
      page({ images: [{ id: 'i1', src: 'data:image/png;base64,AA', mime: 'image/png', x: 0, y: 0, width: 10, height: 10, rotation: 0, zIndex: 1, naturalWidth: 10, naturalHeight: 10 }] }),
    );
    expect(visual?.media).toHaveLength(1);
    expect(visual?.media[0]?.kind).toBe('image');
  });

  it('returns null for anything that is not a page', () => {
    for (const input of [null, undefined, 42, 'a page', [], {}, { dimensions: {} }, { dimensions: { width: '794' } }]) {
      expect(pageVisualFrom(input)).toBeNull();
    }
  });

  it('rejects a malformed page at the boundary rather than deep in the renderer', () => {
    // One unreadable document must not empty the library. Checking the lists
    // here means a corrupt page becomes a blank card, instead of throwing
    // somewhere inside the rasteriser where the failure is harder to contain.
    expect(pageVisualFrom(page({ strokes: 'not an array' }))).toBeNull();
    expect(pageVisualFrom(page({ media: 'not an array' }))).toBeNull();
    expect(pageVisualFrom(page({ images: 42 }))).toBeNull();
  });

  it('is forgiving about what it can fill in for itself', () => {
    // A missing template config is not corruption — it is an older file, or a
    // field a future version dropped — and the defaults cover it.
    const visual = pageVisualFrom(page({ templateConfig: null }));
    expect(visual).not.toBeNull();
    expect(visual?.templateConfig.strokeWidth).toBeGreaterThan(0);
    // Likewise a page with no media key at all.
    expect(pageVisualFrom(page())?.media).toEqual([]);
  });

  it('reserves the page’s own shape before the image arrives', () => {
    expect(cardAspect(page())).toBe('794 / 1123');
    expect(cardAspect(page({ dimensions: { width: 1123, height: 794 } }))).toBe('1123 / 794');
    // An unreadable page still gets a sensible box, so the grid does not jump.
    expect(cardAspect(null)).toBe('794 / 1123');
  });
});
