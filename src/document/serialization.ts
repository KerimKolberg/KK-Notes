/**
 * JSON wire format. Strokes are already plain data (points, styles, shapes),
 * so a page serialises as-is minus its undo/redo stacks.
 */
import { DEFAULT_TEMPLATE_CONFIG, DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM } from './constants';
import { clampIndex, renumber } from './operations';
import type { Document, Page, SerializedDocument, SerializedPage } from './types';

export function toSerializablePage(page: Page): SerializedPage {
  return {
    id: page.id,
    dimensions: page.dimensions,
    template: page.template,
    templateConfig: page.templateConfig,
    backgroundColor: page.backgroundColor,
    strokes: page.strokes,
  };
}

export function toSerializable(doc: Document): SerializedDocument {
  return {
    version: 1,
    id: doc.id,
    title: doc.title,
    viewMode: doc.viewMode,
    zoom: doc.zoom,
    activePageIndex: doc.activePageIndex,
    pages: doc.pages.map(toSerializablePage),
  };
}

export function fromSerializablePage(page: SerializedPage, index: number): Page {
  return {
    id: page.id,
    pageNumber: index + 1,
    dimensions: page.dimensions,
    template: page.template,
    templateConfig: { ...DEFAULT_TEMPLATE_CONFIG, ...page.templateConfig },
    backgroundColor: page.backgroundColor,
    strokes: page.strokes,
    undoStack: [],
    redoStack: [],
  };
}

export function fromSerializable(data: SerializedDocument): Document {
  if (data.version !== 1) throw new Error(`Unsupported document version ${String(data.version)}`);
  if (!Array.isArray(data.pages) || data.pages.length === 0) throw new Error('A document needs at least one page');
  const pages = renumber(data.pages.map(fromSerializablePage));
  const zoom = Number.isFinite(data.zoom) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, data.zoom)) : DEFAULT_ZOOM;
  return {
    id: data.id,
    title: data.title,
    pages,
    activePageIndex: clampIndex(data.activePageIndex, pages.length),
    viewMode: data.viewMode === 'single' ? 'single' : 'continuous',
    zoom,
  };
}

export function serializeDocument(doc: Document): string {
  return JSON.stringify(toSerializable(doc));
}

export function deserializeDocument(json: string): Document {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Invalid document JSON');
  return fromSerializable(parsed as SerializedDocument);
}
