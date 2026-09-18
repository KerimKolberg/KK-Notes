import { describe, expect, it } from 'vitest';
import { DEFAULT_TOOL_SETTINGS } from '../constants';
import { styleForTool } from '../engine/toolStyles';
import type { ToolSettings } from '../types';

const settings = (over: Partial<ToolSettings>): ToolSettings => ({ ...DEFAULT_TOOL_SETTINGS, ...over });

/**
 * The shape tool and the freehand tools kept one set of these between them,
 * so dashing a construction line also dashed the next pen stroke. They are
 * separate fields now, and these are the assertions that say so.
 */
describe('the shape tool reads its own settings', () => {
  const split = settings({
    pattern: 'solid',
    arrowheads: 'none',
    linePattern: 'dashed',
    lineArrowheads: 'both',
  });

  it('dashes and arrows a line from the line fields', () => {
    const line = styleForTool('line', split, 'pen');
    expect(line.pattern).toBe('dashed');
    expect(line.arrowheads).toBe('both');
  });

  it('leaves the pen and highlighter on the shared ones', () => {
    expect(styleForTool('pen', split, 'pen').pattern).toBe('solid');
    expect(styleForTool('pen', split, 'pen').arrowheads).toBe('none');
    expect(styleForTool('highlighter', split, 'pen').pattern).toBe('solid');
    expect(styleForTool('highlighter', split, 'pen').arrowheads).toBe('none');
  });

  it('works the other way round too', () => {
    const swapped = settings({
      pattern: 'dotted',
      arrowheads: 'end',
      linePattern: 'solid',
      lineArrowheads: 'none',
    });
    expect(styleForTool('pen', swapped, 'pen').pattern).toBe('dotted');
    expect(styleForTool('line', swapped, 'pen').pattern).toBe('solid');
    expect(styleForTool('line', swapped, 'pen').arrowheads).toBe('none');
  });

  it('keeps 15° snapping on two independent switches', () => {
    const s = settings({ angleSnap: true, lineAngleSnap: false });
    expect(s.angleSnap).toBe(true);
    expect(s.lineAngleSnap).toBe(false);
    // The defaults start them both off, and the curve settings are the line
    // tool's alone — nothing else reads them.
    expect(DEFAULT_TOOL_SETTINGS.angleSnap).toBe(false);
    expect(DEFAULT_TOOL_SETTINGS.lineAngleSnap).toBe(false);
  });

  it('never lets a line setting reach the tape or the eraser', () => {
    const loud = settings({ linePattern: 'dashed', lineArrowheads: 'both' });
    expect(styleForTool('washi-tape', loud, 'pen').pattern).toBe('solid');
    expect(styleForTool('washi-tape', loud, 'pen').arrowheads).toBe('none');
    expect(styleForTool('eraser-pixel', loud, 'pen').pattern).toBe('solid');
  });
});
