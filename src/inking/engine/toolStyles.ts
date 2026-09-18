import {
  HIGHLIGHTER_OPACITY,
  MAX_HIGHLIGHTER_OPACITY,
  MIN_HIGHLIGHTER_OPACITY,
  STROKE_ERASER_RADIUS,
} from '../constants';
import { brushStyle } from './brushes';
import type { LaserStyle } from './laser';
import type { InkPointerType, InkTool, StrokeStyle, ToolSettings, ToolType } from '../types';

/**
 * Build the frozen render style for a new stroke.
 *
 * The pen delegates to the brush engine (`brushes.ts`), which decides width
 * scale, pressure response, smoothing, tapers and how the outline is painted.
 * Highlighter, eraser and geometric tools are constant-width presets defined
 * here.
 */
/**
 * The highlighter's `globalAlpha`, kept inside the slider's range. Documents
 * saved before the slider existed carry no value at all, so an unusable 0 (or
 * a NaN from a hand-edited file) falls back to the middle of the range.
 */
export function clampHighlighterOpacity(opacity: number): number {
  if (!Number.isFinite(opacity)) return HIGHLIGHTER_OPACITY;
  return Math.min(MAX_HIGHLIGHTER_OPACITY, Math.max(MIN_HIGHLIGHTER_OPACITY, opacity));
}

export function styleForTool(
  tool: InkTool,
  settings: Readonly<ToolSettings>,
  pointerType: InkPointerType,
): StrokeStyle {
  switch (tool) {
    case 'pen':
      // The pen is whichever brush the toolbar has selected.
      return brushStyle(settings.brush, settings, pointerType);
    case 'highlighter':
      return {
        color: settings.color,
        size: settings.highlighterWidth,
        opacity: clampHighlighterOpacity(settings.highlighterOpacity),
        compositeOperation: 'multiply',
        thinning: 0,
        smoothing: 0.6,
        streamline: 0.6,
        simulatePressure: false,
        taperStart: 0,
        taperEnd: 0,
        pattern: settings.pattern,
        arrowheads: settings.arrowheads,
        ...(settings.highlighterGradient === 'none'
          ? {}
          : { gradient: { mode: settings.highlighterGradient, to: settings.highlighterGradientTo } }),
      };
    case 'washi-tape':
      // A strip, not a stroke: constant width, no pressure response, and the
      // pattern travelling with it so it survives a save and an export.
      return {
        color: settings.color,
        size: settings.washiWidth,
        opacity: settings.washiOpacity,
        compositeOperation: 'source-over',
        thinning: 0,
        smoothing: 0.4,
        streamline: 0.5,
        simulatePressure: false,
        taperStart: 0,
        taperEnd: 0,
        pattern: 'solid',
        arrowheads: 'none',
        tape: {
          pattern: settings.washiPattern,
          accent: settings.washiAccent,
          straighten: settings.washiStraighten,
        },
      };
    case 'line':
      // The shape tool's dash and arrowheads are its own, not the pen's.
      return {
        color: settings.color,
        size: settings.size,
        opacity: 1,
        compositeOperation: 'source-over',
        thinning: 0,
        smoothing: 0.5,
        streamline: 0.5,
        simulatePressure: false,
        taperStart: 0,
        taperEnd: 0,
        pattern: settings.linePattern,
        arrowheads: settings.lineArrowheads,
      };
    case 'coordinate-plane':
      return {
        color: settings.color,
        size: Math.max(1, Math.min(settings.size, 3)),
        opacity: 1,
        compositeOperation: 'source-over',
        thinning: 0,
        smoothing: 0.5,
        streamline: 0.5,
        simulatePressure: false,
        taperStart: 0,
        taperEnd: 0,
        pattern: 'solid',
        arrowheads: 'none',
      };
    case 'laser-pointer':
      // The laser never becomes a stroke; this style only feeds generic code
      // paths (bounds, previews). Its real appearance comes from `LaserStyle`.
      return {
        color: settings.laserColor,
        size: settings.size,
        opacity: 1,
        compositeOperation: 'source-over',
        thinning: 0.4,
        smoothing: 0.6,
        streamline: 0.5,
        simulatePressure: pointerType !== 'pen',
        taperStart: 0,
        taperEnd: 0,
        pattern: 'solid',
        arrowheads: 'none',
      };
    case 'eraser-pixel':
      return {
        color: '#000000',
        size: settings.eraserSize,
        opacity: 1,
        compositeOperation: 'destination-out',
        thinning: 0,
        smoothing: 0.5,
        streamline: 0.4,
        simulatePressure: false,
        taperStart: 0,
        taperEnd: 0,
        pattern: 'solid',
        arrowheads: 'none',
      };
  }
}

/** Live appearance of the laser pointer for the current settings. */
export function laserStyleFor(settings: Readonly<ToolSettings>): LaserStyle {
  return { color: settings.laserColor, size: settings.size, rainbow: settings.laserRainbow };
}

/**
 * Radius of the eraser's hit circle, for whichever eraser is asking.
 *
 * The area eraser's is the slider: it is the width of the band it cuts. The
 * stroke eraser's is a fixed point, because it removes whole strokes and its
 * size is a precision rather than a width — see `STROKE_ERASER_RADIUS`.
 */
export function eraserRadius(settings: Readonly<ToolSettings>, tool: ToolType): number {
  return tool === 'eraser-stroke' ? STROKE_ERASER_RADIUS : settings.eraserSize / 2;
}
