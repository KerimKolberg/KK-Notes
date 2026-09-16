import type { PageDimensions, PageTemplate, TemplateConfig } from './types';

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
