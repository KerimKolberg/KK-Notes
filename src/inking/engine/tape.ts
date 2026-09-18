/**
 * Washi tape: a wide, translucent, patterned band laid across the page.
 *
 * The band is an ordinary freehand outline — it is drawn with the pen like
 * anything else — but it is filled with a repeating pattern rather than a
 * flat colour, and it is meant to look *applied* rather than drawn. Two
 * things follow from that:
 *
 * - **Straightening.** Real tape is straight because it is a strip pulled off
 *   a roll. An aggressive RDP pass collapses the wobble of a hand-drawn
 *   stroke into a few long segments, which reads as a strip laid down in one
 *   motion instead of a thick scribble. It is done here rather than at commit
 *   so the preview, the committed stroke and the export are the same geometry.
 * - **Two renderers, one pattern.** On a canvas the tile goes through
 *   `createPattern` and is clipped to the band. A PDF has no such fill, so
 *   the same tile is emitted as explicit marks placed inside the band. Both
 *   read the tile from `tilePattern`, so they stay in step.
 */
import { simplifyRdp } from './simplify';
import type { InkPoint, Point, StrokeStyle } from '../types';

export type TapePattern = 'solid' | 'stripes' | 'checker' | 'dots';

export const TAPE_PATTERNS: readonly { readonly id: TapePattern; readonly label: string }[] = [
  { id: 'solid', label: 'Solid' },
  { id: 'stripes', label: 'Stripes' },
  { id: 'checker', label: 'Checks' },
  { id: 'dots', label: 'Dots' },
];

/** Pattern metadata frozen onto a stroke, so it re-renders and exports identically. */
export interface TapeStyle {
  readonly pattern: TapePattern;
  /** The pattern's second colour; the stroke colour is the band itself. */
  readonly accent: string;
  /** Collapse the drawn path into straight strips. */
  readonly straighten: boolean;
}

/** Side of the repeating tile, in drawing units. */
export const TAPE_TILE = 16;

/**
 * How far the straightening pass is allowed to move a point, relative to the
 * band's width. Generous on purpose: below roughly a third of the width the
 * wobble is still visible, and the point is to remove it.
 */
const STRAIGHTEN_TOLERANCE = 0.45;

/**
 * The path a tape stroke is actually built from. Straightening runs here, so
 * every consumer — preview, commit, snapshot, export — sees one geometry.
 */
export function tapePath<T extends Point>(points: readonly T[], style: StrokeStyle): readonly T[] {
  if (!style.tape?.straighten || points.length < 3) return points;
  const simplified = simplifyRdp(points, Math.max(2, style.size * STRAIGHTEN_TOLERANCE));
  return simplified.length >= 2 ? simplified : points;
}

/** Tape ignores pressure: a strip is the width of the strip. */
export function tapeSamples(points: readonly InkPoint[], style: StrokeStyle): InkPoint[] {
  return tapePath(points, style).map((p) => ({ ...p, pressure: 0.5 }));
}

/** One mark of a pattern tile, in tile-local units (0..TAPE_TILE). */
export interface TileMark {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Drawn as a circle inscribed in the box rather than the box itself. */
  readonly round?: boolean;
}

/**
 * The accent marks of one tile. A `solid` tape has none — its band colour is
 * the whole of it.
 */
export function tilePattern(pattern: TapePattern, tile = TAPE_TILE): TileMark[] {
  const half = tile / 2;
  switch (pattern) {
    case 'solid':
      return [];
    case 'stripes':
      // One bar per tile, spanning it: repeated, that is a stripe.
      return [{ x: 0, y: 0, width: tile, height: half }];
    case 'checker':
      // Two squares on the diagonal: repeated, that is a checkerboard.
      return [
        { x: 0, y: 0, width: half, height: half },
        { x: half, y: half, width: half, height: half },
      ];
    case 'dots':
      return [{ x: tile * 0.25, y: tile * 0.25, width: half, height: half, round: true }];
  }
}

/**
 * Tile marks laid out across `bounds`, in drawing units. Used by the PDF
 * exporter, which cannot fill with a pattern and so places the marks itself;
 * `inside` drops the ones that would hang over the edge of the band.
 */
export function tileMarksOver(
  pattern: TapePattern,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  inside: (p: Point) => boolean,
  tile = TAPE_TILE,
): Array<TileMark & { round?: boolean }> {
  const marks = tilePattern(pattern, tile);
  if (marks.length === 0) return [];
  const out: TileMark[] = [];
  const startX = Math.floor(bounds.minX / tile) * tile;
  const startY = Math.floor(bounds.minY / tile) * tile;
  // `<` rather than `<=`: a tile starting exactly at the far edge lies wholly
  // outside the bounds, so it could only ever contribute rejected marks.
  for (let originY = startY; originY < bounds.maxY; originY += tile) {
    for (let originX = startX; originX < bounds.maxX; originX += tile) {
      for (const mark of marks) {
        const x = originX + mark.x;
        const y = originY + mark.y;
        // Every corner must be in the band, or the mark would spill past its
        // edge — there is no clipping on the PDF side to catch it.
        const corners: Point[] = [
          { x, y },
          { x: x + mark.width, y },
          { x, y: y + mark.height },
          { x: x + mark.width, y: y + mark.height },
        ];
        if (corners.every(inside)) out.push({ ...mark, x, y });
      }
    }
  }
  return out;
}
