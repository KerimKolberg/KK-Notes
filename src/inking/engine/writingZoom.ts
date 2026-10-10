/**
 * Keeping small writing at a high zoom in shape.
 *
 * Two distances decide what of a stroke is the hand's noise rather than its writing, and both were
 * fixed in page units, tuned for 100 %, where a page unit is a CSS pixel:
 *
 *  - `StrokeBuilder` drops a sample closer than `MIN_SAMPLE_SPACING` (0.4) to the last one kept;
 *  - perfect-freehand skips the last 3 units of every line as pen-lift noise
 *    (`END_NOISE_THRESHOLD`, a constant inside the library) and joins the end on straight.
 *
 * At 400 % both cover four times as much of a letter on screen. Writing small there, most samples
 * were dropped, and the 3-unit skip, about the height of a small letter, twisted wherever the pen
 * curled as it lifted: a thin neck ending in a dot after a "t", an "o" left open, a "g" with a
 * straight tail. A fine pen already gets both treated for its width (`outlineScale`, and samples
 * half its width apart), which does nothing for a 3 px pen and only half of what 400 % needs for a
 * 1 px one. So a stroke also records the zoom it was written at (`StrokeStyle.writingZoom`): the
 * thinning is divided by it, and the outline is computed with the stroke scaled up and scaled
 * back by the larger of the two (`strokeOutlineScale` in `strokeOutline.ts`). Everything else
 * perfect-freehand measures is relative to the size, so that changes the end skip alone, to
 * 3 units on screen, without touching the library. The native Windows app does exactly the same
 * (`windows-native/KKNotes.Core/Ink/Brushes.cs`).
 *
 * Writing zoomed out is left as it was: the scale is never taken below 1, and the field is only
 * stored above 100 %, so strokes written at 100 % or less save exactly as before.
 */
import type { StrokeStyle } from '../types';

/** The factor the thresholds are divided by: the writing zoom, at least 1. */
export function noiseScale(style: Pick<StrokeStyle, 'writingZoom'>): number {
  const zoom = style.writingZoom;
  return typeof zoom === 'number' && Number.isFinite(zoom) && zoom > 1 ? zoom : 1;
}

/**
 * `style` for a stroke written at `zoom` (CSS pixels per page unit). Recorded to three decimals,
 * and only above 100 %.
 */
export function withWritingZoom(style: StrokeStyle, zoom: number): StrokeStyle {
  const rounded = Math.round(zoom * 1000) / 1000;
  if (!Number.isFinite(rounded) || rounded <= 1) return style;
  return { ...style, writingZoom: rounded };
}
