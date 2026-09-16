import { memo, useCallback, useMemo, type RefObject } from 'react';
import { InkSurface } from '../../inking/InkSurface';
import type { Stroke, ToolSettings } from '../../inking/types';
import type { PageLayout } from '../layout';
import { useDocumentStore } from '../store';
import { templateSvgDataUrl } from '../templates';
import type { Page } from '../types';
import { PageSnapshot } from './PageSnapshot';

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
 * One page in the viewer: background colour + SVG template as CSS, then either
 * live ink canvases (near the viewport) or a raster snapshot (farther away).
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

  const backgroundImage = useMemo(
    () => templateSvgDataUrl(page),
    // Only the visual inputs matter, not stroke changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [page.dimensions, page.template, page.templateConfig, page.backgroundColor],
  );

  const onCommit = useCallback((stroke: Stroke) => commitStroke(page.id, stroke), [commitStroke, page.id]);
  const onErase = useCallback((ids: ReadonlySet<string>) => eraseStrokes(page.id, ids), [eraseStrokes, page.id]);
  const onInteractionStart = useCallback(() => setActivePage(index), [setActivePage, index]);

  return (
    <div
      className={`absolute overflow-hidden rounded-sm shadow-lg ring-1 ${
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
        <InkSurface
          width={page.dimensions.width}
          height={page.dimensions.height}
          zoom={zoom}
          strokes={page.strokes}
          settingsRef={settingsRef}
          onCommitStroke={onCommit}
          onEraseStrokes={onErase}
          onInteractionStart={onInteractionStart}
          currentTool={currentTool}
          ariaLabel={`Page ${page.pageNumber} drawing surface`}
        />
      ) : (
        <PageSnapshot page={page} cssWidth={layout.width} cssHeight={layout.height} />
      )}
      <span className="pointer-events-none absolute bottom-2 right-3 select-none rounded bg-black/40 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white/90">
        {page.pageNumber}
      </span>
    </div>
  );
});
