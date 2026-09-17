import { memo, useCallback, useMemo, useState, type RefObject } from 'react';
import { selectStrokesInLasso } from '../../inking/engine/lasso';
import { useLatestRef } from '../../inking/hooks/useLatestRef';
import { InkSurface } from '../../inking/InkSurface';
import type { Point, Stroke, ToolSettings } from '../../inking/types';
import { FormOverlay } from '../../pdf/FormOverlay';
import { PdfBackground } from '../../pdf/PdfBackground';
import type { PageLayout } from '../layout';
import { useDocumentStore } from '../store';
import { templateSvgDataUrl } from '../templates';
import { beginTemporaryTool } from '../toolStore';
import type { Page } from '../types';
import { MediaLayer } from './MediaLayer';
import { PageSnapshot } from './PageSnapshot';
import { SelectionLayer } from './SelectionLayer';

export type PageFrameMode = 'active' | 'snapshot';

export interface PageFrameProps {
  page: Page;
  /** Index in the document (not in the rendered subset). */
  index: number;
  layout: PageLayout;
  mode: PageFrameMode;
  zoom: number;
  isCurrent: boolean;
  settingsRef: RefObject<ToolSettings>;
  currentTool: ToolSettings['tool'];
}

/**
 * One page in the viewer. Layer stack, all in page-local coordinates:
 *   z-0  background — template SVG (CSS) or the PDF.js raster
 *   z-10 media      — user-placed images with transform boxes
 *   z-20 ink        — live + committed canvases (or a snapshot when far away)
 *   z-25 selection  — lasso selection box, handles and quick actions
 *   z-30 forms      — HTML widgets for AcroForm annotations
 */
export const PageFrame = memo(function PageFrame({
  page,
  index,
  layout,
  mode,
  zoom,
  isCurrent,
  settingsRef,
  currentTool,
}: PageFrameProps) {
  const commitStroke = useDocumentStore((s) => s.commitStroke);
  const eraseStrokes = useDocumentStore((s) => s.eraseStrokes);
  const setActivePage = useDocumentStore((s) => s.setActivePage);
  const setLassoSelection = useDocumentStore((s) => s.setLassoSelection);
  const clearLassoSelection = useDocumentStore((s) => s.clearLassoSelection);
  const lassoIds = useDocumentStore((s) => (s.lassoSelection?.pageId === page.id ? s.lassoSelection.strokeIds : null));
  const pageRef = useLatestRef(page);
  /** Strokes the selection layer is previewing; the ink layer leaves them out meanwhile. */
  const [hiddenStrokeIds, setHiddenStrokeIds] = useState<ReadonlySet<string> | null>(null);

  const backgroundImage = useMemo(
    () => templateSvgDataUrl(page),
    // Only the visual inputs matter, not stroke changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [page.dimensions, page.template, page.templateConfig, page.backgroundColor],
  );

  const onCommit = useCallback((stroke: Stroke) => commitStroke(page.id, stroke), [commitStroke, page.id]);
  const onErase = useCallback((ids: ReadonlySet<string>) => eraseStrokes(page.id, ids), [eraseStrokes, page.id]);
  const onInteractionStart = useCallback(() => setActivePage(index), [setActivePage, index]);
  const onBarrelSelect = useCallback(() => beginTemporaryTool('select'), []);
  const onLassoStart = useCallback(() => clearLassoSelection(), [clearLassoSelection]);
  const onLassoComplete = useCallback(
    (polygon: readonly Point[]) => {
      const strokeIds = selectStrokesInLasso(pageRef.current.strokes, polygon);
      setLassoSelection(strokeIds.length > 0 ? { pageId: page.id, strokeIds } : null);
    },
    [pageRef, page.id, setLassoSelection],
  );
  const showSelection = lassoIds !== null && (currentTool === 'lasso' || currentTool === 'select');

  return (
    <div
      className={`absolute isolate overflow-hidden rounded-sm shadow-lg ring-1 ${
        isCurrent ? 'ring-blue-500/60 dark:ring-blue-400/60' : 'ring-black/10 dark:ring-white/10'
      }`}
      style={{
        top: layout.top,
        left: layout.left,
        width: layout.width,
        height: layout.height,
        backgroundColor: page.backgroundColor,
        backgroundImage,
        backgroundSize: '100% 100%',
        backgroundRepeat: 'no-repeat',
      }}
      data-page-index={index}
      data-page-id={page.id}
      data-page-mode={mode}
    >
      {mode === 'active' ? (
        <>
          {page.pdf && <PdfBackground page={page} cssWidth={layout.width} />}
          <MediaLayer page={page} zoom={zoom} active={currentTool === 'select'} />
          {/* The wrapper only provides the z-index; the surface itself decides whether it takes pointer input. */}
          <div className="pointer-events-none absolute inset-0 z-20">
            <InkSurface
              width={page.dimensions.width}
              height={page.dimensions.height}
              zoom={zoom}
              strokes={page.strokes}
              settingsRef={settingsRef}
              onCommitStroke={onCommit}
              onEraseStrokes={onErase}
              onInteractionStart={onInteractionStart}
              onBarrelSelect={onBarrelSelect}
              onLassoStart={onLassoStart}
              onLassoComplete={onLassoComplete}
              hiddenStrokeIds={hiddenStrokeIds}
              currentTool={currentTool}
              interactive={currentTool !== 'select'}
              ariaLabel={`Page ${page.pageNumber} drawing surface`}
            />
          </div>
          {showSelection && <SelectionLayer page={page} zoom={zoom} strokeIds={lassoIds} onPreviewHidden={setHiddenStrokeIds} />}
          <FormOverlay page={page} zoom={zoom} tool={currentTool} />
        </>
      ) : (
        <PageSnapshot page={page} cssWidth={layout.width} cssHeight={layout.height} />
      )}
      <span className="pointer-events-none absolute bottom-2 right-3 select-none rounded bg-black/40 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white/90">
        {page.pageNumber}
      </span>
    </div>
  );
});
