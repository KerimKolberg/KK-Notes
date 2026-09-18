import type { Cover, PageDimensions, PageTemplate, TemplateConfig } from './types';

/** A4 at 96 DPI. */
export const A4_DIMENSIONS: PageDimensions = { width: 794, height: 1123 };

export const DEFAULT_ZOOM = 1;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 3;
export const ZOOM_STEP = 0.1;

/** Gap between pages in continuous mode, CSS px. */
export const PAGE_GAP = 24;
/** Padding around the page column, CSS px. */
export const VIEWER_PADDING = 24;

/** Pages within this distance of the viewport keep live canvases mounted. */
export const ACTIVE_OVERSCAN_PX = 800;
/** Pages within this distance render a raster snapshot; beyond it, nothing. */
export const RENDER_OVERSCAN_PX = 2400;

/** Snapshot undo depth per page. */
export const PAGE_HISTORY_DEPTH = 100;

export const THUMBNAIL_WIDTH = 168;
/** Longest side of a viewer snapshot, device px. */
export const SNAPSHOT_MAX_SIDE = 1024;
/** Raster cache entries kept alive (bitmaps are closed on eviction). */
export const RASTER_CACHE_SIZE = 48;

export const LIGHT_PAGE_BACKGROUND = '#ffffff';
export const DARK_PAGE_BACKGROUND = '#1c1c21';

export const DEFAULT_TEMPLATE_CONFIG: TemplateConfig = {
  spacing: 20,
  strokeColor: 'auto',
  strokeWidth: 1,
  marginOffset: 96,
};

/** Spacing that suits each template when the user switches to it. */
export const TEMPLATE_DEFAULT_SPACING: Readonly<Record<PageTemplate, number>> = {
  blank: 20,
  ruled: 32,
  grid: 20,
  engineering: 20,
  isometric: 28,
  pdf: 20,
};

export const PAGE_TEMPLATES: readonly { readonly id: PageTemplate; readonly label: string }[] = [
  { id: 'blank', label: 'Blank' },
  { id: 'ruled', label: 'Ruled' },
  { id: 'grid', label: 'Grid' },
  { id: 'engineering', label: 'Engineering' },
  { id: 'isometric', label: 'Isometric' },
  { id: 'pdf', label: 'PDF' },
];

export const PAGE_BACKGROUND_SWATCHES: readonly string[] = [
  '#ffffff',
  '#fdf6e3',
  '#f1f5f9',
  '#e8f5e9',
  '#1c1c21',
  '#0f172a',
];

/** Page pixels per millimetre at 96 DPI. */
export const MM_TO_PX = 96 / 25.4;

export function mmToPx(mm: number): number {
  return Math.round(mm * MM_TO_PX * 10) / 10;
}

export function pxToMm(px: number): number {
  return Math.round((px / MM_TO_PX) * 10) / 10;
}

/** Ruled line pitch / grid box presets offered in the arranger, in millimetres. */
export const SPACING_PRESETS_MM: readonly number[] = [5, 7, 10];

export const MIN_TEMPLATE_SPACING = 8;
export const MAX_TEMPLATE_SPACING = 80;

/** Templates whose look depends on `templateConfig.spacing`. */
export const SPACED_TEMPLATES: readonly PageTemplate[] = ['ruled', 'grid', 'engineering', 'isometric'];

export const COVER_COLOR_SWATCHES: readonly string[] = [
  '#1e3a5f',
  '#7f1d1d',
  '#14532d',
  '#4c1d95',
  '#78350f',
  '#111827',
  '#f4f4f5',
];

export function defaultCover(title: string): Cover {
  return { title: title || 'Untitled note', description: '', coverColor: '#1e3a5f', textColor: '#f8fafc' };
}

/** Placed images default to this fraction of the page width when larger. */
export const IMAGE_MAX_FRACTION = 0.6;
export const MIN_IMAGE_SIZE = 16;

// ---- Sticky notes and tables ----------------------------------------------

/** A sticky note starts about the size of a real one, in page px. */
export const NOTE_DEFAULT_SIZE = { width: 220, height: 200 } as const;
export const DEFAULT_NOTE_COLOR = '#fef08a';

/** Quick-pick card colours, chosen to keep dark text readable on them. */
export const NOTE_COLORS: readonly string[] = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fecaca', '#e9d5ff', '#fed7aa', '#f4f4f5'];

/**
 * Layout of a note's card, in page px. Shared by the three places a note is
 * painted — the DOM overlay, the page snapshot raster and the PDF exporter —
 * so that what is typed, what is scrolled past and what is printed agree.
 */
export const NOTE_GRIP_HEIGHT = 18;
export const NOTE_PADDING = 8;
export const NOTE_FONT_SIZE = 15;
export const NOTE_LINE_HEIGHT = 1.35;

/** …and of a table's, for the same reason. */
export const TABLE_GRIP_HEIGHT = 14;
export const TABLE_FONT_SIZE = 13;
export const TABLE_CELL_PADDING = 5;

/** Page px per table cell at the size a new table is created. */
export const TABLE_CELL_SIZE = { width: 120, height: 36 } as const;
export const DEFAULT_TABLE_ROWS = 3;
export const DEFAULT_TABLE_COLUMNS = 3;
export const MAX_TABLE_ROWS = 20;
export const MAX_TABLE_COLUMNS = 20;

/** Grid line weight and solidity, as the insert dialog's sliders set them. */
export const DEFAULT_TABLE_LINE_WIDTH = 1;
export const MIN_TABLE_LINE_WIDTH = 0.5;
export const MAX_TABLE_LINE_WIDTH = 4;
export const DEFAULT_TABLE_LINE_OPACITY = 1;
export const MIN_TABLE_LINE_OPACITY = 0.1;
export const MAX_TABLE_LINE_OPACITY = 1;

/** A track may not be dragged below this share of the table. */
export const MIN_TRACK_FRACTION = 0.04;
