/**
 * Shared, framework-agnostic types for the inking engine.
 *
 * Coordinates are always **CSS pixels** relative to the canvas' top-left
 * corner. Device-pixel scaling is applied purely through the 2D context
 * transform, so stored strokes are independent of `devicePixelRatio`.
 */

/** Every tool the user can select in the UI. */
export type ToolType = 'pen' | 'highlighter' | 'eraser-stroke' | 'eraser-pixel';

/**
 * Tools that produce a persisted stroke record. The stroke eraser removes
 * existing strokes instead of creating one, so it is excluded.
 */
export type InkTool = Exclude<ToolType, 'eraser-stroke'>;

/** Pointer classes we distinguish between. Unknown types are treated as mouse. */
export type InkPointerType = 'pen' | 'touch' | 'mouse';

/** A single normalized input sample. */
export interface InkPoint {
  readonly x: number;
  readonly y: number;
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
  /** Base diameter in CSS pixels, before pressure thinning. */
  readonly size: number;
  /** Layer opacity applied to the whole stroke polygon (0..1). */
  readonly opacity: number;
  /** Canvas composite / blend operation used when filling the polygon. */
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
}

/** An immutable, committed stroke. */
export interface Stroke {
  readonly id: string;
  readonly tool: InkTool;
  readonly points: readonly InkPoint[];
  readonly style: StrokeStyle;
  /** Bounding box of `points`, padded by the maximum half-width. Used for hit-test culling. */
  readonly bbox: BBox;
  readonly pointerType: InkPointerType;
  /** `performance.now()`-style timestamp at stroke start. */
  readonly createdAt: number;
}

/** User-adjustable tool state surfaced by the toolbar. */
export interface ToolSettings {
  tool: ToolType;
  /** CSS colour used by pen and highlighter. */
  color: string;
  /** Base stroke width in CSS pixels. */
  size: number;
  /** When false, only pen (and optionally mouse) input draws. */
  touchDraw: boolean;
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
