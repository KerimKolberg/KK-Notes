/**
 * Which layers the lasso is allowed to pick up.
 *
 * Deliberately the opposite polarity to the eraser's filter next door
 * (`eraseFilter.ts`): there, all off means "take everything", because an
 * unfiltered eraser is the normal case and narrowing it is the exception.
 * Here every layer starts *checked*, and unchecking one takes it out of
 * reach — which is what a selection filter has to mean if "select the
 * writing but not the highlighting I drew over it" is to be expressible.
 *
 * With every box cleared nothing is selectable at all. That is literal
 * rather than helpful, but it is also the only reading that does not
 * silently re-include a layer the user just switched off, so the popover
 * says so instead of the code guessing.
 */
import type { Stroke } from '../types';

export interface LassoFilter {
  /** Pen strokes: whatever was written or drawn by hand. */
  readonly ink: boolean;
  readonly highlighter: boolean;
  readonly washiTape: boolean;
  /** Lines, curves, recognised shapes and coordinate planes. */
  readonly shapes: boolean;
}

/** Everything is selectable, which is where the lasso starts. */
export const LASSO_ALL_LAYERS: LassoFilter = { ink: true, highlighter: true, washiTape: true, shapes: true };

export const LASSO_LAYERS: readonly { readonly key: keyof LassoFilter; readonly label: string; readonly hint: string }[] = [
  { key: 'ink', label: 'Standard ink', hint: 'Pen strokes: anything written or drawn by hand' },
  { key: 'highlighter', label: 'Highlighter', hint: 'Highlighter strokes' },
  { key: 'washiTape', label: 'Washi tape', hint: 'Strips of tape' },
  { key: 'shapes', label: 'Shapes / lines', hint: 'Lines, curves, recognised shapes and coordinate planes' },
];

/** Which switch governs this stroke, or `null` for one the lasso never takes. */
export function lassoLayerOf(stroke: Stroke): keyof LassoFilter | null {
  if (stroke.kind === 'geometric') return 'shapes';
  switch (stroke.tool) {
    case 'pen':
      return 'ink';
    case 'highlighter':
      return 'highlighter';
    case 'washi-tape':
      return 'washiTape';
    // The pixel eraser leaves a stroke that only subtracts; selecting it would
    // hand the user a hole to drag around. The laser never commits at all.
    default:
      return null;
  }
}

/** True when every layer is selectable, i.e. the lasso is unfiltered. */
export function lassoFilterIsOpen(filter: LassoFilter): boolean {
  return filter.ink && filter.highlighter && filter.washiTape && filter.shapes;
}

/** True when no layer is selectable, so the lasso can never find anything. */
export function lassoFilterIsEmpty(filter: LassoFilter): boolean {
  return !filter.ink && !filter.highlighter && !filter.washiTape && !filter.shapes;
}

/** May the lasso pick this stroke up? */
export function inLassoFilter(stroke: Stroke, filter: LassoFilter = LASSO_ALL_LAYERS): boolean {
  const layer = lassoLayerOf(stroke);
  return layer !== null && filter[layer];
}
