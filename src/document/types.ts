/**
 * Multi-page document schema. Pages hold immutable stroke arrays from the
 * inking engine plus snapshot-based undo/redo stacks; the document tracks
 * the active page, view mode and zoom.
 */
import type { Stroke } from '../inking/types';

export type PageTemplate = 'blank' | 'ruled' | 'grid' | 'engineering' | 'isometric' | 'pdf';

// ---------------------------------------------------------------------------
// PDF-backed pages
// ---------------------------------------------------------------------------

/** PDF user-space view box `[x0, y0, x1, y1]` in points. */
export type PdfViewBox = readonly [number, number, number, number];

/** Reference from a page to the PDF page it was imported from. */
export interface PdfPageRef {
  /** Identifies the source file; pages from one file share `data` by reference. */
  readonly sourceId: string;
  readonly sourceName: string;
  /** Raw PDF bytes (never detached: readers copy before handing it to a worker). */
  readonly data: ArrayBuffer;
  readonly pageCount: number;
  /** 0-based index in the source file. */
  readonly pageIndex: number;
  readonly viewBox: PdfViewBox;
  /** Display rotation in degrees: 0, 90, 180 or 270. */
  readonly rotation: number;
  /** Page-local px per PDF point (uniform). */
  readonly scale: number;
}

// ---------------------------------------------------------------------------
// AcroForm fields
// ---------------------------------------------------------------------------

export type FormFieldKind = 'text' | 'textarea' | 'checkbox' | 'radio' | 'select' | 'listbox';

export interface FormFieldOption {
  readonly label: string;
  readonly value: string;
}

export interface PageBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface FormField {
  /** Annotation id from PDF.js (unique per page). */
  readonly id: string;
  /** Fully qualified field name; the key into `formValues`. */
  readonly name: string;
  readonly kind: FormFieldKind;
  /** Page-local px. */
  readonly box: PageBox;
  readonly readOnly: boolean;
  readonly options?: readonly FormFieldOption[];
  /** Checkbox / radio: this widget's "on" export value. */
  readonly exportValue?: string;
  readonly maxLength?: number;
  /** Page px. */
  readonly fontSize?: number;
  readonly textAlign?: 'left' | 'center' | 'right';
  readonly multiSelect?: boolean;
}

export type FormValue = string | boolean;
export type FormValues = Readonly<Record<string, FormValue>>;

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

/**
 * What every media object has in common: a rotated box on the page and its
 * place in the stack. All the placement maths in `media.ts` works on this, so
 * an image, a sticky note and a table move and resize by exactly one
 * implementation.
 */
export interface MediaBox {
  readonly id: string;
  /** Top-left of the unrotated box, page px. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Degrees, clockwise about the box centre. */
  readonly rotation: number;
  readonly zIndex: number;
  /** Pinned in place: dragging and resizing do nothing until it is unlocked. */
  readonly locked?: boolean;
}

export interface ImageLayer extends MediaBox {
  readonly kind: 'image';
  /** Data URL. */
  readonly src: string;
  readonly mime: string;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
}

/** A coloured card with free text on it. */
export interface StickyNote extends MediaBox {
  readonly kind: 'note';
  readonly text: string;
  /** CSS colour of the card. */
  readonly color: string;
}

/**
 * A grid of text cells. `cells` is row-major and always `rows * columns`
 * long, so a cell is addressed arithmetically and adding a row or a column
 * is a pure reshape rather than a nested-array edit.
 */
export interface TableLayer extends MediaBox {
  readonly kind: 'table';
  readonly rows: number;
  readonly columns: number;
  readonly cells: readonly string[];
  /**
   * Relative widths of the columns and heights of the rows, each as many
   * entries as there are tracks and summing to 1. Absent means "all equal",
   * which is what a new table is and what an older file carries.
   */
  readonly columnFractions?: readonly number[];
  readonly rowFractions?: readonly number[];
  /** Grid line weight in page px, and how solid it is. */
  readonly lineWidth?: number;
  readonly lineOpacity?: number;
}

export type MediaObject = ImageLayer | StickyNote | TableLayer;
export type MediaKind = MediaObject['kind'];

export interface PageDimensions {
  readonly width: number;
  readonly height: number;
}

export interface TemplateConfig {
  /** Base spacing in page px (ruled line pitch, grid cell, isometric triangle side). */
  readonly spacing: number;
  /** CSS colour, or `'auto'` to derive from the page background's luminance. */
  readonly strokeColor: string;
  readonly strokeWidth: number;
  /** Ruled only: x offset of the vertical margin line; `0` disables it. */
  readonly marginOffset?: number;
}

export interface Page {
  readonly id: string;
  /** 1-based, always equal to index + 1 after any structural operation. */
  readonly pageNumber: number;
  readonly dimensions: PageDimensions;
  readonly template: PageTemplate;
  readonly templateConfig: TemplateConfig;
  readonly backgroundColor: string;
  readonly strokes: readonly Stroke[];
  /** Previous `strokes` snapshots, oldest first. */
  readonly undoStack: ReadonlyArray<readonly Stroke[]>;
  readonly redoStack: ReadonlyArray<readonly Stroke[]>;
  /** Present when the page was imported from a PDF (`template: 'pdf'`). */
  readonly pdf?: PdfPageRef;
  /** AcroForm widgets extracted from the PDF page. */
  readonly formFields: readonly FormField[];
  readonly formValues: FormValues;
  /** User-placed images, notes and tables, drawn between the background and the ink. */
  readonly media: readonly MediaObject[];
}

/**
 * How the viewer arranges pages. The two continuous modes scroll along
 * different axes; `single-page` shows one page at a time.
 */
export type ViewMode = 'vertical-continuous' | 'horizontal-continuous' | 'single-page';

/** Optional notebook cover shown before the first page. */
export interface Cover {
  readonly title: string;
  readonly description: string;
  /** CSS colour of the cover board. */
  readonly coverColor: string;
  /** CSS colour of the text printed on it. */
  readonly textColor: string;
}

export interface Document {
  readonly id: string;
  readonly title: string;
  /** Notebook cover, rendered before page 1 in the continuous modes. */
  readonly cover?: Cover;
  readonly pages: readonly Page[];
  readonly activePageIndex: number;
  readonly viewMode: ViewMode;
  /** CSS pixels per page pixel. */
  readonly zoom: number;
}

/** Fields that affect how a page looks (used to key raster caches). */
export type PageVisual = Pick<
  Page,
  'dimensions' | 'template' | 'templateConfig' | 'backgroundColor' | 'strokes' | 'media' | 'pdf'
>;

/** Serialized PDF page reference; the bytes live once per source in `pdfSources`. */
export interface SerializedPdfPageRef {
  readonly sourceId: string;
  readonly pageIndex: number;
  readonly viewBox: PdfViewBox;
  readonly rotation: number;
  readonly scale: number;
}

export interface SerializedPdfSource {
  readonly name: string;
  readonly pageCount: number;
  /** Base64 of the PDF bytes. */
  readonly data: string;
}

/** Wire format: history is not persisted. */
export interface SerializedPage {
  readonly id: string;
  readonly dimensions: PageDimensions;
  readonly template: PageTemplate;
  readonly templateConfig: TemplateConfig;
  readonly backgroundColor: string;
  readonly strokes: readonly Stroke[];
  readonly pdf?: SerializedPdfPageRef;
  readonly formFields?: readonly FormField[];
  readonly formValues?: FormValues;
  readonly media?: readonly MediaObject[];
  /** Files written before notes and tables existed; migrated to `media` on load. */
  readonly images?: readonly Omit<ImageLayer, 'kind'>[];
}

export interface SerializedDocument {
  readonly version: 1;
  readonly id: string;
  readonly title: string;
  readonly cover?: Cover;
  /** Legacy files carry the old two-mode values; they are migrated on load. */
  readonly viewMode: ViewMode | 'continuous' | 'single';
  readonly zoom: number;
  readonly activePageIndex: number;
  readonly pages: readonly SerializedPage[];
  readonly pdfSources?: Readonly<Record<string, SerializedPdfSource>>;
}

/** Where to insert relative to a reference page. */
export type InsertPosition = 'before' | 'after';

/** Target of a per-page setting change. */
export type PageTarget = number | 'all';
