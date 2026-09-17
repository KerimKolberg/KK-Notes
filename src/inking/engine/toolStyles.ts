import {
  ERASER_SIZE_MULTIPLIER,
  HIGHLIGHTER_OPACITY,
  HIGHLIGHTER_SIZE_MULTIPLIER,
} from '../constants';
import { brushStyle } from './brushes';
import type { LaserStyle } from './laser';
import type { InkPointerType, InkTool, StrokeStyle, ToolSettings } from '../types';

/**
 * Build the frozen render style for a new stroke.
 *
 * The pen delegates to the brush engine (`brushes.ts`), which decides width
 * scale, pressure response, smoothing, tapers and how the outline is painted.
 * Highlighter, eraser and geometric tools are constant-width presets defined
 * here.
 */
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
        size: settings.size * HIGHLIGHTER_SIZE_MULTIPLIER,
        opacity: HIGHLIGHTER_OPACITY,
        compositeOperation: 'multiply',
        thinning: 0,
        smoothing: 0.6,
        streamline: 0.6,
        simulatePressure: false,
        taperStart: 0,
        taperEnd: 0,
        pattern: settings.pattern,
        arrowheads: settings.arrowheads,
      };
    case 'line':
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
        pattern: settings.pattern,
        arrowheads: settings.arrowheads,
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
        size: settings.size * ERASER_SIZE_MULTIPLIER,
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

/** Radius of the stroke-eraser hit circle for the current settings. */
export function strokeEraserRadius(settings: Readonly<ToolSettings>): number {
  return (settings.size * ERASER_SIZE_MULTIPLIER) / 2;
}
