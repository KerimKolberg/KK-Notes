import { describe, expect, it } from 'vitest';
import { DEFAULT_TOOL_SETTINGS } from '../constants';
import { BRUSHES, brushById, brushStyle } from '../engine/brushes';
import { BAKE_CHUNK, BAKE_LOOKAHEAD, BAKE_OVERLAP, canBakeLive, planBakes, tailStart } from '../engine/liveBake';
import { styleForTool } from '../engine/toolStyles';
import type { BrushId } from '../engine/brushes';
import type { StrokeStyle } from '../types';

const settings = DEFAULT_TOOL_SETTINGS;
const penStyle = (brush: BrushId, pointer: 'pen' | 'mouse' | 'touch' = 'pen'): StrokeStyle =>
  brushStyle(brush, { ...settings, size: 2 }, pointer);

describe('which strokes can be drawn a chunk at a time', () => {
  it('takes the ballpoint, from a pen and from a mouse', () => {
    expect(canBakeLive(penStyle('ballpoint', 'pen'))).toBe(true);
    // The ballpoint is even-width, so a mouse gets no simulated pressure either.
    expect(canBakeLive(penStyle('ballpoint', 'mouse'))).toBe(true);
  });

  it('leaves out every brush whose look depends on more than its outline', () => {
    expect(canBakeLive(penStyle('pencil'))).toBe(false);
    expect(canBakeLive(penStyle('fountain'))).toBe(false);
    // Whatever else qualifies must be plain: no texture, bleed, softness, taper or tilt.
    for (const { id } of BRUSHES) {
      if (!canBakeLive(penStyle(id))) continue;
      const brush = brushById(id);
      expect(brush.texture).toBe('none');
      expect(brush.bleed + brush.softness + brush.taperStart + brush.taperEnd + brush.velocityTaper + brush.tiltResponse).toBe(0);
    }
  });

  it('leaves out anything translucent, blended, patterned or arrow-tipped', () => {
    const base = penStyle('ballpoint');
    expect(canBakeLive({ ...base, opacity: 0.5 })).toBe(false);
    expect(canBakeLive({ ...base, compositeOperation: 'multiply' })).toBe(false);
    expect(canBakeLive({ ...base, compositeOperation: 'destination-out' })).toBe(false);
    expect(canBakeLive({ ...base, pattern: 'dashed' })).toBe(false);
    expect(canBakeLive({ ...base, arrowheads: 'end' })).toBe(false);
    expect(canBakeLive({ ...base, simulatePressure: true })).toBe(false);
    expect(canBakeLive({ ...base, taperEnd: 4 })).toBe(false);
  });

  it('leaves out the highlighter and the eraser', () => {
    expect(canBakeLive(styleForTool('highlighter', settings, 'pen'))).toBe(false);
    expect(canBakeLive(styleForTool('eraser-pixel', settings, 'pen'))).toBe(false);
  });
});

describe('planning the bakes', () => {
  it('bakes nothing for a short stroke', () => {
    expect(planBakes(10, 0)).toEqual({ ranges: [], baked: 0 });
    expect(planBakes(BAKE_CHUNK + BAKE_LOOKAHEAD - 1, 0)).toEqual({ ranges: [], baked: 0 });
  });

  it('bakes the first chunk once it has settled, looking a little past its end', () => {
    const plan = planBakes(BAKE_CHUNK + BAKE_LOOKAHEAD, 0);
    expect(plan.baked).toBe(BAKE_CHUNK);
    expect(plan.ranges).toEqual([{ from: 0, to: BAKE_CHUNK + BAKE_LOOKAHEAD }]);
  });

  it('reaches back into the piece before, so the join is covered', () => {
    const plan = planBakes(2 * BAKE_CHUNK + BAKE_LOOKAHEAD, BAKE_CHUNK);
    expect(plan.ranges).toEqual([{ from: BAKE_CHUNK - BAKE_OVERLAP, to: 2 * BAKE_CHUNK + BAKE_LOOKAHEAD }]);
    expect(plan.baked).toBe(2 * BAKE_CHUNK);
  });

  it('catches up in one go when a long stroke has to be baked from the start', () => {
    const plan = planBakes(5 * BAKE_CHUNK + 40, 0);
    expect(plan.baked).toBe(5 * BAKE_CHUNK);
    expect(plan.ranges).toHaveLength(5);
    // Each range picks up where the last one's bake ended, less the overlap.
    plan.ranges.forEach((r, i) => {
      expect(r.from).toBe(Math.max(0, i * BAKE_CHUNK - BAKE_OVERLAP));
      expect(r.to).toBe((i + 1) * BAKE_CHUNK + BAKE_LOOKAHEAD);
    });
  });

  it('never bakes a sample twice as the stroke grows a few samples at a time', () => {
    let baked = 0;
    const seen = new Set<number>();
    for (let count = 1; count <= 1000; count += 3) {
      const plan = planBakes(count, baked);
      for (const r of plan.ranges) for (let i = r.from + (r.from === 0 ? 0 : BAKE_OVERLAP); i < r.to - BAKE_LOOKAHEAD; i++) {
        expect(seen.has(i)).toBe(false);
        seen.add(i);
      }
      baked = plan.baked;
    }
    // Every sample up to the last bake was covered, in order, with none left out.
    for (let i = 0; i < baked; i++) expect(seen.has(i)).toBe(true);
  });

  it('keeps the tail short however long the stroke is', () => {
    for (const count of [100, 500, 5000, 50_000]) {
      const { baked } = planBakes(count, 0);
      const tail = count - tailStart(baked);
      expect(tail).toBeLessThanOrEqual(BAKE_CHUNK + BAKE_LOOKAHEAD + BAKE_OVERLAP);
    }
  });

  it('draws the whole of a stroke that has not been baked at all', () => {
    expect(tailStart(0)).toBe(0);
  });
});
