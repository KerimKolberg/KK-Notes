import { memo, useCallback, useMemo, useState, type RefObject } from 'react';
import { selectStrokesInLasso } from '../../inking/engine/lasso';
import { useLatestRef } from '../../inking/hooks/useLatestRef';
import { InkSurface } from '../../inking/InkSurface';
import type { Point, Stroke, ToolSettings } from '../../inking/types';
import { FormOverlay } from '../../pdf/FormOverlay';
import { PdfBackground } from '../../pdf/PdfBackground';
import { TextSelectionLayer } from '../../textselect/TextSelectionLayer';
import { SearchFlash } from '../../search/SearchFlash';
import { useReplayStrokes } from '../../audio/replay';
import type { PageLayout } from '../layout';
import { ClipboardPaste } from 'lucide-react';
import { usePreferencesStore } from '../../preferences/store';
import { useClipboardStore } from '../clipboard';
import { useAidStore } from '../aids';
import { AidsLayer } from './AidsLayer';
import { eraserRadius } from '../../inking/engine/toolStyles';
import { useDocumentStore } from '../store';
import { pageSnapSpacing, templateSvgDataUrl } from '../templates';
import { cancelBarrelButton, consumeBarrelButton, noteBarrelButton } from '../stylusBarrel';
import { borrowSelectionTool } from '../toolBorrow';
import { beginTemporaryTool, useToolStore } from '../toolStore';
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
  const readOnly = useDocumentStore((s) => s.readOnly);
  const pasteSelection = useDocumentStore((s) => s.pasteSelection);
  // The ruler on this page, if it is out: a pen that starts at its edge draws along it.
  const ruler = useAidStore((s) => (s.ruler?.pageId === page.id ? s.ruler : null));
  const copiedCount = useClipboardStore((s) => s.strokes.length);
  // While a recording plays, ink written later than where it has got to is shown faded.
  const shownStrokes = useReplayStrokes(page.strokes);
  // Only used as a `key`: a canvas's attributes are fixed by its first
  // `getContext`, so the surface has to be rebuilt for the switch to take effect.
  const lowLatencyInk = usePreferencesStore((s) => s.lowLatencyInk);
  // The eraser's footprint on screen, for the pointer to show while hovering. Read
  // from the store here because the tool settings arrive as a ref, which cannot
  // re-render anything when the size slider moves.
  const eraserSize = useToolStore((s) => s.settings.eraserSize);
  const erasing = currentTool === 'eraser-stroke' || currentTool === 'eraser-pixel';
  const eraserDiameterPx = erasing
    ? 2 * eraserRadius({ eraserSize } as Readonly<ToolSettings>, currentTool) * zoom
    : null;
  const pageRef = useLatestRef(page);
  /** Strokes the selection layer is previewing; the ink layer leaves them out meanwhile. */
  const [hiddenStrokeIds, setHiddenStrokeIds] = useState<ReadonlySet<string> | null>(null);
  /**
   * A lasso selection being dragged. The frame normally clips to the sheet, so
   * a selection carried towards the next page would be cut off at the edge;
   * while a drag is in flight it stops clipping and rises above its neighbours
   * instead, and the preview travels across the gap intact.
   */
  const [draggingSelection, setDraggingSelection] = useState(false);

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
      // Read the live settings rather than a prop: the lasso's layers and mode
      // can be changed while the loop is still being drawn.
      const { lassoMode, lassoFilter } = settingsRef.current;
      const strokeIds = selectStrokesInLasso(pageRef.current.strokes, polygon, { mode: lassoMode, filter: lassoFilter });
      setLassoSelection(strokeIds.length > 0 ? { pageId: page.id, strokeIds } : null);
    },
    [pageRef, settingsRef, page.id, setLassoSelection],
  );
  // Locked: the ink and media layers go inert so pointer input reaches the
  // scroll container (and the form widgets above them) untouched. The laser
  // pointer is the exception — it writes nothing to the document, so it stays
  // usable for presenting, with pen and mouse only (one finger keeps panning).
  const laserOnly = readOnly && currentTool === 'laser-pointer';
  const showSelection = !readOnly && lassoIds !== null && (currentTool === 'lasso' || currentTool === 'select');
  // Something is on the clipboard and the lasso is in hand with nothing selected: offer
  // to put it down here, since a finger has no Ctrl+V.
  const showPaste = mode === 'active' && isCurrent && !readOnly && currentTool === 'lasso' && lassoIds === null && copiedCount > 0;

  return (
    <div
      className={`absolute isolate rounded-sm shadow-lg ring-1 ${draggingSelection ? 'overflow-visible' : 'overflow-hidden'} ${
        isCurrent ? 'ring-blue-500/60 dark:ring-blue-400/60' : 'ring-black/10 dark:ring-white/10'
      }`}
      style={{
        top: layout.top,
        left: layout.left,
        width: layout.width,
        height: layout.height,
        ...(draggingSelection ? { zIndex: 40 } : {}),
        backgroundColor: page.backgroundColor,
        backgroundImage,
        backgroundSize: '100% 100%',
        backgroundRepeat: 'no-repeat',
      }}
      data-page-index={index}
      data-page-id={page.id}
      data-page-mode={mode}
      data-page-pdf={page.pdf ? '' : undefined}
    >
      {mode === 'active' ? (
        <>
          {page.pdf && <PdfBackground page={page} cssWidth={layout.width} />}
          <MediaLayer page={page} zoom={zoom} active={currentTool === 'select' && !readOnly} />
          {/* The wrapper only provides the z-index; the surface itself decides whether it takes pointer input. */}
          <div className="pointer-events-none absolute inset-0 z-20">
            <InkSurface
              key={lowLatencyInk ? 'low-latency' : 'standard'}
              width={page.dimensions.width}
              height={page.dimensions.height}
              zoom={zoom}
              strokes={shownStrokes}
              settingsRef={settingsRef}
              onCommitStroke={onCommit}
              onEraseStrokes={onErase}
              onInteractionStart={onInteractionStart}
              onBarrelSelect={onBarrelSelect}
              onBorrowSelectionTool={borrowSelectionTool}
              onBarrelStroke={consumeBarrelButton}
              eraserDiameterPx={eraserDiameterPx}
              gridSpacing={pageSnapSpacing(page)}
              ruler={ruler}
              onBarrelButton={noteBarrelButton}
              onBarrelCancel={cancelBarrelButton}
              onLassoStart={onLassoStart}
              onLassoComplete={onLassoComplete}
              hiddenStrokeIds={hiddenStrokeIds}
              currentTool={currentTool}
              allowTouch={!readOnly}
              interactive={currentTool !== 'select' && (!readOnly || laserOnly)}
              ariaLabel={`Page ${page.pageNumber} drawing surface`}
            />
          </div>
          {showSelection && (
            <SelectionLayer
              page={page}
              zoom={zoom}
              strokeIds={lassoIds}
              onPreviewHidden={setHiddenStrokeIds}
              onDraggingChange={setDraggingSelection}
            />
          )}
          <AidsLayer page={page} zoom={zoom} />
          <FormOverlay page={page} zoom={zoom} tool={currentTool} readOnly={readOnly} />
        </>
      ) : (
        <PageSnapshot page={page} cssWidth={layout.width} cssHeight={layout.height} />
      )}
      {page.bookmark !== undefined && (
        // A marker in the corner, seen and never touched: it must not take a pen stroke that starts near it.
        <span
          aria-hidden="true"
          data-bookmark-ribbon
          title={page.bookmark || `Bookmarked`}
          className="pointer-events-none absolute right-4 top-0 z-[34] h-7 w-4 bg-blue-600/90 shadow-sm"
          style={{ clipPath: 'polygon(0 0, 100% 0, 100% 100%, 50% 72%, 0 100%)' }}
        />
      )}
      {showPaste && (
        <button
          type="button"
          data-paste-pill
          className="absolute left-3 top-3 z-[35] inline-flex h-8 items-center gap-1.5 rounded-full bg-zinc-900/95 px-3 text-xs font-medium text-white shadow-lg hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-blue-300"
          title="Paste what was copied onto this page (Ctrl+V)"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => {
            setActivePage(index);
            pasteSelection(page.id);
          }}
        >
          <ClipboardPaste size={14} aria-hidden="true" />
          Paste{copiedCount > 1 ? ` ${copiedCount} strokes` : ''}
        </button>
      )}
      <TextSelectionLayer surface="editor" pageId={page.id} />
      <SearchFlash pageId={page.id} width={page.dimensions.width} height={page.dimensions.height} />
      <span className="pointer-events-none absolute bottom-2 right-3 select-none rounded bg-black/40 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white/90">
        {page.pageNumber}
      </span>
    </div>
  );
});
