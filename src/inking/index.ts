export { InkingCanvas } from './InkingCanvas';
export { InkSurface, type InkSurfaceProps } from './InkSurface';
export { useLatestRef } from './hooks/useLatestRef';
export { useUndoRedoShortcuts } from './hooks/useUndoRedoShortcuts';
export { InkingToolbar, type InkingToolbarProps } from './InkingToolbar';
export * from './types';
export * from './constants';
export { historyReducer, createHistoryState, type HistoryState, type HistoryAction } from './engine/history';
export { getStrokeOutline, outlineToPath2D, toFreehandOptions } from './engine/strokeOutline';
export { styleForTool, strokeEraserRadius } from './engine/toolStyles';
export {
  isPointerAccepted,
  normalizePressure,
  normalizePointerType,
  resolveEffectiveTool,
} from './engine/pointerPolicy';
export { strokeHitBySegment, strokePolylines } from './engine/hitTest';
export { simplifyRdp, resamplePolyline, polylineLength, perpendicularDistance } from './engine/simplify';
export * from './engine/angles';
export {
  arrowheadLength,
  arrowheadTriangle,
  coordinatePlaneFromDrag,
  coordinatePlaneGeometry,
  createGeometricStroke,
  ellipsePoints,
  heartPoints,
  lineFromDrag,
  rectangleCorners,
  shapeBBox,
  shapeIsClosed,
  shapeToPolylines,
  type CoordinatePlaneGeometry,
  type GeometricStrokeInit,
  type Segment,
  type TextLabel,
} from './engine/shapes';
export {
  recognizeShape,
  detectCorners,
  fitEllipse,
  fitRectangle,
  isClosedPath,
  isHeart,
  isRectangle,
  normalizeToEllipse,
  radialVariance,
  RECOGNITION,
  type RecognitionOptions,
} from './engine/shapeRecognition';
export { buildLineHud, geometricSegments, type AngleArc } from './engine/angleHud';
export { dashArray, drawStroke, replayStrokes, type InkContext } from './engine/renderer';
