/**
 * Shared, framework-agnostic types for the inking engine.
 *
 * Coordinates are always **CSS pixels** relative to the canvas' top-left
 * corner. Device-pixel scaling is applied purely through the 2D context
 * transform, so stored strokes are independent of `devicePixelRatio`.
 */

/** Every tool the user can select in the UI. */
export type ToolType =
  | 'pen'
  | 'highlighter'
  | 'line'
  | 'coordinate-plane'
  | 'eraser-stroke'
  | 'eraser-pixel';

/**
 * Tools that produce a persisted stroke record. The stroke eraser removes
 * existing strokes instead of creating one, so it is excluded.
 */
export type InkTool = Exclude<ToolType, 'eraser-stroke'>;

/** Tools whose raw samples become a perfect-freehand polygon. */
export type FreehandTool = 'pen' | 'highlighter' | 'eraser-pixel';

/** Tools that create a geometric primitive by click-and-drag. */
export type ShapeTool = 'line' | 'coordinate-plane';

/** Tools that may own a geometric stroke (drag tools plus snapped freehand). */
export type GeometricTool = Exclude<InkTool, 'eraser-pixel'>;

/** Pointer classes we distinguish between. Unknown types are treated as mouse. */
export type InkPointerType = 'pen' | 'touch' | 'mouse';

/** Line dash pattern, scaled by the stroke width at render time. */
export type StrokePattern = 'solid' | 'dashed' | 'dotted' | 'dash-dot' | 'long-dash';

/** Which ends of an open stroke receive an arrowhead. */
export type ArrowheadMode = 'none' | 'end' | 'both';

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A single normalized input sample. */
export interface InkPoint extends Point {
  /** Normalized pressure in (0, 1]. A raw `0` from the device is mapped to `DEFAULT_PRESSURE`. */
  readonly pressure: number;
}

/** Axis-aligned bounding box in CSS pixels. */
export interface BBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/**
 * Rendering parameters frozen at the moment a stroke starts. Changing the
 * toolbar mid-stroke never affects the stroke in progress.
 */
export interface StrokeStyle {
  /** Any CSS colour. Ignored for `destination-out` (pixel eraser). */
  readonly color: string;
  /** Base diameter / line width in CSS pixels, before pressure thinning. */
  readonly size: number;
  /** Layer opacity applied to the whole stroke (0..1). */
  readonly opacity: number;
  /** Canvas composite / blend operation. */
  readonly compositeOperation: GlobalCompositeOperation;
  /** perfect-freehand `thinning` (-1..1): how strongly pressure modulates width. */
  readonly thinning: number;
  /** perfect-freehand `smoothing` (0..1): edge softening. */
  readonly smoothing: number;
  /** perfect-freehand `streamline` (0..1): input-jitter suppression. */
  readonly streamline: number;
  /** Derive pressure from velocity instead of the reported value (mouse/touch). */
  readonly simulatePressure: boolean;
  /** Taper length (px) at the start of the stroke. */
  readonly taperStart: number;
  /** Taper length (px) at the end of the stroke. */
  readonly taperEnd: number;
  /** Dash pattern. Anything but `solid` renders the centreline with `ctx.stroke()`. */
  readonly pattern: StrokePattern;
  /** Terminal decorators for open strokes. */
  readonly arrowheads: ArrowheadMode;
}

// ---------------------------------------------------------------------------
// Geometric primitives
// ---------------------------------------------------------------------------

export type CoordinatePlaneMode = 'quadrant-1' | 'four-quadrant';

export interface CoordinatePlaneConfig {
  readonly mode: CoordinatePlaneMode;
  /** Grid cells per positive half-axis. */
  readonly divisions: number;
  readonly showGrid: boolean;
  /** Number the tick marks. */
  readonly tickLabels: boolean;
  readonly xLabel: string;
  readonly yLabel: string;
}

export interface LineShape {
  readonly type: 'line';
  readonly from: Point;
  readonly to: Point;
}

/** Open chain of straight segments. */
export interface PolylineShape {
  readonly type: 'polyline';
  readonly points: readonly Point[];
}

/** Closed chain of straight segments (triangle, quadrilateral, pentagon…). */
export interface PolygonShape {
  readonly type: 'polygon';
  readonly points: readonly Point[];
}

export interface RectangleShape {
  readonly type: 'rectangle';
  readonly center: Point;
  readonly width: number;
  readonly height: number;
  /** Radians, canvas orientation (clockwise positive). */
  readonly rotation: number;
}

/** A circle is an ellipse with equal radii. */
export interface EllipseShape {
  readonly type: 'ellipse';
  readonly center: Point;
  readonly radiusX: number;
  readonly radiusY: number;
  readonly rotation: number;
}

export interface HeartShape {
  readonly type: 'heart';
  readonly center: Point;
  readonly width: number;
  readonly height: number;
}

export interface CoordinatePlaneShape {
  readonly type: 'coordinate-plane';
  readonly origin: Point;
  /** Length of the positive x half-axis in px (mirrored for four quadrants). */
  readonly extentX: number;
  /** Length of the positive y half-axis in px. */
  readonly extentY: number;
  readonly config: CoordinatePlaneConfig;
}

export type Shape =
  | LineShape
  | PolylineShape
  | PolygonShape
  | RectangleShape
  | EllipseShape
  | HeartShape
  | CoordinatePlaneShape;

export type ShapeType = Shape['type'];

// ---------------------------------------------------------------------------
// Strokes
// ---------------------------------------------------------------------------

interface StrokeBase {
  readonly id: string;
  readonly style: StrokeStyle;
  /** Bounding box padded by the maximum half-width (and arrowheads). Used for culling. */
  readonly bbox: BBox;
  readonly pointerType: InkPointerType;
  /** `performance.now()`-style timestamp at stroke start. */
  readonly createdAt: number;
}

/** Raw pointer samples rendered through perfect-freehand (or a dashed centreline). */
export interface FreehandStroke extends StrokeBase {
  readonly kind: 'freehand';
  readonly tool: FreehandTool;
  readonly points: readonly InkPoint[];
}

/** An idealised primitive rendered with stroked paths. */
export interface GeometricStroke extends StrokeBase {
  readonly kind: 'geometric';
  readonly tool: GeometricTool;
  readonly shape: Shape;
}

/** An immutable, committed stroke. */
export type Stroke = FreehandStroke | GeometricStroke;

// ---------------------------------------------------------------------------
// Settings / history / component API
// ---------------------------------------------------------------------------

/** User-adjustable tool state surfaced by the toolbar. */
export interface ToolSettings {
  tool: ToolType;
  /** CSS colour used by everything except the pixel eraser. */
  color: string;
  /** Base stroke width in CSS pixels. */
  size: number;
  /** When false, only pen (and optionally mouse) input draws. */
  touchDraw: boolean;
  pattern: StrokePattern;
  arrowheads: ArrowheadMode;
  /** Snap straight lines / vectors to 15° increments. */
  angleSnap: boolean;
  /** Hold the pointer still at the end of a stroke to convert it to a shape. */
  holdToSnap: boolean;
  coordinatePlane: CoordinatePlaneConfig;
}

/** A stroke together with the index it occupied before removal. */
export interface IndexedStroke {
  readonly index: number;
  readonly stroke: Stroke;
}

/** One reversible edit on the stroke list. */
export type HistoryEntry =
  | { readonly kind: 'add'; readonly stroke: Stroke }
  | { readonly kind: 'remove'; readonly removed: readonly IndexedStroke[] }
  | { readonly kind: 'clear'; readonly removed: readonly Stroke[] };

/** Logical + physical size of the canvas surfaces. */
export interface CanvasSize {
  readonly cssWidth: number;
  readonly cssHeight: number;
  /** Effective device pixels per CSS pixel actually applied to the backing store. */
  readonly dpr: number;
}

/** Imperative API exposed through `ref`. */
export interface InkingCanvasHandle {
  undo(): void;
  redo(): void;
  /** Remove every stroke (undoable). */
  clear(): void;
  getStrokes(): readonly Stroke[];
  /** Flatten background + committed ink into a data URL at device resolution. */
  toDataURL(type?: string, quality?: number): string;
}

export interface InkingCanvasProps {
  /** Strokes to seed the canvas with (uncontrolled). */
  initialStrokes?: readonly Stroke[];
  /** Fired after every committed change to the stroke list. */
  onStrokesChange?: (strokes: readonly Stroke[]) => void;
  /** Overrides for the initial toolbar state. */
  initialSettings?: Partial<ToolSettings>;
  /** Render the built-in toolbar. Default `true`. */
  showToolbar?: boolean;
  /**
   * Accept mouse input as a drawing pointer. Default `true` so the component is
   * usable on desktops; palm rejection only concerns `touch` pointers.
   */
  allowMouse?: boolean;
  /** Background colour painted behind the ink (CSS colour). Default white. */
  background?: string;
  /** Maximum undo depth. Default `MAX_HISTORY_DEPTH`. */
  maxHistory?: number;
  /** Extra class on the root element. */
  className?: string;
}
