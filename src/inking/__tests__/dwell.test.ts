import { describe, expect, it } from 'vitest';
import { SNAP_JITTER_PX, SNAP_RELEASE_PX } from '../constants';
import { beginDwell, dwellTolerance, lockDwell, noteDwellMovement } from '../engine/dwell';
import type { Shape } from '../types';

const RECOGNISED: Shape = {
  type: 'rectangle',
  center: { x: 50, y: 50 },
  width: 80,
  height: 60,
  rotation: 0,
};

const at = (x: number, y: number) => ({ x, y });

describe('dwell before anything is recognised', () => {
  it('ignores drift inside the jitter radius and keeps waiting', () => {
    const dwell = beginDwell(at(100, 100), 0);
    expect(noteDwellMovement(dwell, at(100 + SNAP_JITTER_PX, 100), 50)).toBe(false);
    expect(dwell.anchor).toEqual(at(100, 100));
    expect(dwell.since).toBe(0);
  });

  it('restarts on the slightest real movement', () => {
    const dwell = beginDwell(at(100, 100), 0);
    expect(noteDwellMovement(dwell, at(100 + SNAP_JITTER_PX + 1, 100), 50)).toBe(true);
    expect(dwell.anchor).toEqual(at(100 + SNAP_JITTER_PX + 1, 100));
    expect(dwell.since).toBe(50);
  });
});

describe('a recognised shape is locked against the pen lifting', () => {
  /** A dwell that has completed: the shape is previewed and awaiting pointerup. */
  const locked = (): ReturnType<typeof beginDwell> => {
    const dwell = beginDwell(at(100, 100), 0);
    lockDwell(dwell, RECOGNISED, []);
    return dwell;
  };

  it('widens the tolerance the moment a shape is locked', () => {
    const dwell = beginDwell(at(100, 100), 0);
    expect(dwellTolerance(dwell)).toBe(SNAP_JITTER_PX);
    lockDwell(dwell, RECOGNISED, []);
    expect(dwellTolerance(dwell)).toBe(SNAP_RELEASE_PX);
    expect(SNAP_RELEASE_PX).toBeGreaterThan(SNAP_JITTER_PX);
  });

  it('survives the drift of a stylus coming off the glass', () => {
    // The exact regression: movement that would have restarted an unlocked
    // dwell must not throw away a shape the user has already been shown.
    const dwell = locked();
    const drifts: ReadonlyArray<readonly [number, number]> = [
      [SNAP_JITTER_PX + 1, 0],
      [6, 6],
      [0, -11],
      [SNAP_RELEASE_PX - 1, 0],
    ];
    for (const [dx, dy] of drifts) {
      expect(noteDwellMovement(dwell, at(100 + dx, 100 + dy), 100)).toBe(false);
      expect(dwell.shape).toBe(RECOGNISED);
    }
    // …and the anchor never moved, so the next sample is judged from where the
    // pen actually settled rather than from wherever the drift had reached.
    expect(dwell.anchor).toEqual(at(100, 100));
  });

  it('accumulated drift never adds up to a release', () => {
    const dwell = locked();
    for (let i = 1; i <= 8; i++) {
      // A slow slide, each step small, ending well inside the release radius.
      expect(noteDwellMovement(dwell, at(100 + i * 3, 100), 10 * i)).toBe(false);
    }
    expect(dwell.shape).toBe(RECOGNISED);
  });

  it('still gives the shape up when the user deliberately draws on', () => {
    const dwell = locked();
    expect(noteDwellMovement(dwell, at(100 + SNAP_RELEASE_PX + 1, 100), 200)).toBe(true);
    expect(dwell.shape).toBeNull();
    expect(dwell.hud).toEqual([]);
    expect(dwell.anchor).toEqual(at(100 + SNAP_RELEASE_PX + 1, 100));
    expect(dwell.since).toBe(200);
    // Back to strict: the re-armed dwell is not still carrying the wide radius.
    expect(dwellTolerance(dwell)).toBe(SNAP_JITTER_PX);
  });
});
