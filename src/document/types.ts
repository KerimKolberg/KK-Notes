/**
 * Multi-page document schema. Pages hold immutable stroke arrays from the
 * inking engine plus snapshot-based undo/redo stacks; the document tracks
 * the active page, view mode and zoom.
 */
import type { Stroke } from '../inking/types';

export type PageTemplate = 'blank' | 'ruled' | 'grid' | 'engineering' | 'isometric' | 'pdf';

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
}

export type ViewMode = 'continuous' | 'single';

export interface Document {
  readonly id: string;
  readonly title: string;
  readonly pages: readonly Page[];
  readonly activePageIndex: number;
  readonly viewMode: ViewMode;
  /** CSS pixels per page pixel. */
  readonly zoom: number;
}

/** Fields that affect how a page looks (used to key raster caches). */
export type PageVisual = Pick<Page, 'dimensions' | 'template' | 'templateConfig' | 'backgroundColor' | 'strokes'>;

/** Wire format: history is not persisted. */
export interface SerializedPage {
  readonly id: string;
  readonly dimensions: PageDimensions;
  readonly template: PageTemplate;
  readonly templateConfig: TemplateConfig;
  readonly backgroundColor: string;
  readonly strokes: readonly Stroke[];
}

export interface SerializedDocument {
  readonly version: 1;
  readonly id: string;
  readonly title: string;
  readonly viewMode: ViewMode;
  readonly zoom: number;
  readonly activePageIndex: number;
  readonly pages: readonly SerializedPage[];
}

/** Where to insert relative to a reference page. */
export type InsertPosition = 'before' | 'after';

/** Target of a per-page setting change. */
export type PageTarget = number | 'all';
