import { afterEach, describe, expect, it, vi } from 'vitest';
import { inkContextAttributes, lowLatencyCanvas, setLowLatencyCanvas } from '../engine/canvasMode';
import { get2dContext } from '../engine/renderer';

/**
 * The switch for `desynchronized` canvases.
 *
 * What is worth pinning is the asymmetry: off must mean the attribute is not
 * merely `false` but *absent*, because the whole reason for the switch is that
 * asking for the hint at all is what some Windows GPUs cannot cope with.
 */
afterEach(() => setLowLatencyCanvas(false));

describe('ink canvas attributes', () => {
  it('does not ask for a desynchronized canvas by default', () => {
    expect(lowLatencyCanvas()).toBe(false);
    const attributes = inkContextAttributes();
    expect(attributes.alpha).toBe(true);
    expect('desynchronized' in attributes).toBe(false);
  });

  it('asks for one when it is switched on', () => {
    setLowLatencyCanvas(true);
    expect(inkContextAttributes()).toEqual({ alpha: true, desynchronized: true });
  });

  it('follows the switch back off', () => {
    setLowLatencyCanvas(true);
    setLowLatencyCanvas(false);
    expect('desynchronized' in inkContextAttributes()).toBe(false);
  });
});

describe('creating a context', () => {
  /** A canvas that records what it was asked for. */
  const recordingCanvas = () => {
    const getContext = vi.fn().mockReturnValue({});
    return { canvas: { getContext } as unknown as HTMLCanvasElement, getContext };
  };

  it('passes the current attributes through', () => {
    const off = recordingCanvas();
    get2dContext(off.canvas);
    expect(off.getContext).toHaveBeenCalledWith('2d', { alpha: true });

    setLowLatencyCanvas(true);
    const on = recordingCanvas();
    get2dContext(on.canvas);
    expect(on.getContext).toHaveBeenCalledWith('2d', { alpha: true, desynchronized: true });
  });

  it('reads the mode each time rather than once at load', () => {
    // A canvas made before the switch keeps what it was made with; one made
    // after gets the new mode. Capturing the attributes in a constant, as this
    // used to, would make the switch do nothing.
    const before = recordingCanvas();
    get2dContext(before.canvas);
    setLowLatencyCanvas(true);
    const after = recordingCanvas();
    get2dContext(after.canvas);
    expect(before.getContext.mock.calls[0]![1]).not.toEqual(after.getContext.mock.calls[0]![1]);
  });

  it('copes with a missing canvas', () => {
    expect(get2dContext(null)).toBeNull();
  });
});
