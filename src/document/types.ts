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
/** The outline a sticky note is cut to. */
export type NoteShape = 'rectangle' | 'ellipse' | 'bubble';

export interface StickyNote extends MediaBox {
  readonly kind: 'note';
  readonly text: string;
  /** CSS colour of the card. */
  readonly color: string;
  /** Missing on notes written before shapes existed, which are rectangles. */
  readonly shape?: NoteShape;
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

/**
 * The families a text box can be set in.
 *
 * Three, and only three, because every one of them has to exist in two places
 * at once: as a CSS stack the screen can render, and as a font the PDF export
 * can *embed*. These map onto PDF's base-14 — Helvetica, Times, Courier — in
 * all four weight/slant combinations, which means what is typed is what comes
 * out. A fourth family would mean shipping a font file in the bundle for the
 * sake of one that only looks right on screen.
 */
export type TextFontId = 'sans' | 'serif' | 'mono';

export type TextAlign = 'left' | 'center' | 'right';

/**
 * How a text box is set.
 *
 * Flat, and applied to the whole box rather than to a selection within it.
 * Rich text with per-character runs is a different feature with a different
 * data model, an editor to match and a much harder export; a box per style is
 * the thing that is actually wanted when annotating a page, and it round-trips
 * to PDF exactly.
 */
export interface TextStyle {
  readonly fontFamily: TextFontId;
  /** Page px, so it scales with zoom like everything else on the page. */
  readonly fontSize: number;
  readonly color: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strikethrough: boolean;
  readonly align: TextAlign;
}

/** Paragraph styles, as Word and Docs name them: normal text and three levels of heading. */
export type RichBlockKind = 'p' | 'h1' | 'h2' | 'h3';
export type RichList = 'bullet' | 'number' | 'check';
export type RichAlign = TextAlign | 'justify';
export type RichScript = 'sup' | 'sub';

/** How a stretch of typed text differs from its box's own style; what is absent is the box's. */
export interface RichMarks {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strike?: boolean;
  /** CSS colour of the letters. */
  readonly color?: string;
  /** CSS colour behind them, as a highlighter would. */
  readonly highlight?: string;
  /** Page px. */
  readonly size?: number;
  readonly font?: TextFontId;
  readonly script?: RichScript;
}

/** A stretch of text in one style. A `\n` in it is a line break within the paragraph (Shift+Enter). */
export interface RichRun extends RichMarks {
  readonly text: string;
}

/** A paragraph: its style, whether it is an item of a list, and its runs of text. */
export interface RichBlock {
  /** Absent is normal text. */
  readonly kind?: RichBlockKind;
  readonly list?: RichList;
  /** How far in it is: a list's nesting level, or a paragraph's indent, in steps (0 to `MAX_INDENT`). */
  readonly indent?: number;
  /** A checklist item that is ticked. */
  readonly checked?: boolean;
  /** Absent is the box's alignment. */
  readonly align?: RichAlign;
  /**
   * Page text only (`TextBox.flow`): the rest of the previous page's last paragraph, which did not fit there.
   * It has no list marker and no space above, and it joins that paragraph again when the text flows back.
   */
  readonly cont?: boolean;
  /** Page text only: the paragraph starts a new page, whatever room is left on the one before (Ctrl+Enter). */
  readonly pageBreak?: boolean;
  readonly runs: readonly RichRun[];
}

/** Typed text with its formatting: paragraphs, headings and lists of runs of styled text. */
export interface RichText {
  readonly blocks: readonly RichBlock[];
}

/** Typed text on the page: no card, no border, just the words. */
export interface TextBox extends MediaBox, TextStyle {
  readonly kind: 'text';
  /**
   * The words, as plain text: one line per paragraph. Always kept, even when `rich` holds the text — it is what
   * search reads (here and in the library, which reads files without this app's model) and what an older
   * version of the app shows.
   */
  readonly text: string;
  /**
   * The text with its formatting (`document/richText.ts`). Absent in boxes written before text could be
   * formatted in parts: those are one style throughout, the box's, and read as such.
   */
  readonly rich?: RichText;
  /**
   * The page's own text, filling the page inside its margins and flowing on to the next page when it is full,
   * as a word processor's does (`document/flow.ts`). At most one per page; it is not moved or resized.
   */
  readonly flow?: boolean;
}

export type MediaObject = ImageLayer | StickyNote | TableLayer | TextBox;

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
  /**
   * Present when the page is bookmarked; the text is what the bookmark is called ('' for none, which is
   * then shown as the page's number). Not part of how the page looks, so not in {@link PageVisual}.
   */
  readonly bookmark?: string;
  /**
   * The words of the handwriting on the page, as a handwriting recogniser read them, for searching. Saved with
   * the note so a device that cannot read handwriting still finds it. Not part of how the page looks.
   */
  readonly inkText?: InkText;
}

/** One handwritten word as it was read, and where it is on the page (page units). */
export interface InkWord {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** What a recogniser read in a page's handwriting. */
export interface InkText {
  /**
   * A fingerprint of the handwriting it was read from (see `handwriting/inkText.ts`). When the page's handwriting
   * no longer matches it, the words are out of date and the page is read again.
   */
  readonly key: string;
  /** The recogniser that read it (its name), so choosing another language reads the page again. */
  readonly by: string;
  /** In reading order: lines from the top, words from the left. */
  readonly words: readonly InkWord[];
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
  /** Audio recorded while writing in the note, oldest first. */
  readonly recordings?: readonly Recording[];
}

/** When a stroke was begun, in seconds from the start of a recording. */
export interface RecordingMark {
  readonly strokeId: string;
  readonly t: number;
}

/** Sound recorded while writing, and when each stroke written meanwhile was begun. */
export interface Recording {
  readonly id: string;
  /** When it began (ISO 8601), which is also what it is called. */
  readonly startedAt: string;
  /** Seconds. */
  readonly duration: number;
  /** The audio's media type (`audio/webm;codecs=opus` from a browser engine). */
  readonly mime: string;
  readonly data: ArrayBuffer;
  /** In the order the strokes were begun. */
  readonly marks: readonly RecordingMark[];
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
  readonly bookmark?: string;
  readonly inkText?: InkText;
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
  readonly recordings?: readonly SerializedRecording[];
}

/** A recording as saved: the audio as base64. */
export interface SerializedRecording {
  readonly id: string;
  readonly startedAt: string;
  readonly duration: number;
  readonly mime: string;
  readonly data: string;
  readonly marks: readonly RecordingMark[];
}

/** Where to insert relative to a reference page. */
export type InsertPosition = 'before' | 'after';

/** Target of a per-page setting change. */
export type PageTarget = number | 'all';
