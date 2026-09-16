import {
  ERASER_SIZE_MULTIPLIER,
  HIGHLIGHTER_OPACITY,
  HIGHLIGHTER_SIZE_MULTIPLIER,
} from '../constants';
import type { InkPointerType, InkTool, StrokeStyle, ToolSettings } from '../types';

/**
 * Build the frozen render style for a new stroke.
 *
 * Pen strokes thin with pressure; when the pointer cannot report pressure
 * (mouse / most touch) we let perfect-freehand simulate it from velocity so
 * the line still has some life. Highlighter, eraser and geometric tools are
 * constant-width.
 */
export function styleForTool(
  tool: InkTool,
  settings: Readonly<ToolSettings>,
  pointerType: InkPointerType,
): StrokeStyle {
  switch (tool) {
    case 'pen':
      return {
        color: settings.color,
        size: settings.size,
        opacity: 1,
        compositeOperation: 'source-over',
        thinning: 0.6,
        smoothing: 0.5,
        streamline: 0.5,
        simulatePressure: pointerType !== 'pen',
        taperStart: 0,
        taperEnd: 0,
        pattern: settings.pattern,
        arrowheads: settings.arrowheads,
      };
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

/** Radius of the stroke-eraser hit circle for the current settings. */
export function strokeEraserRadius(settings: Readonly<ToolSettings>): number {
  return (settings.size * ERASER_SIZE_MULTIPLIER) / 2;
}
