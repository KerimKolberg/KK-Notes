import { useShallow } from 'zustand/react/shallow';
import { memo, useCallback, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { GripHorizontal, RotateCw, X } from 'lucide-react';
import { snapRotation } from '../../inking/engine/lasso';
import { PROTRACTOR_MIN_RADIUS, protractorTicks } from '../../inking/engine/protractor';
import { PX_PER_CM, RULER_WIDTH, angleDegrees, rulerTicks } from '../../inking/engine/ruler';
import type { Point } from '../../inking/types';
import { useAidStore, type ProtractorAid, type RulerAid } from '../aids';
import { regionSize } from '../../inking/engine/zoomRegion';
import { useZoomWindowStore } from '../zoomWindow';
import type { Page } from '../types';

export interface AidsLayerProps {
  page: Page;
  zoom: number;
}

/** A control on an aid: a round button the size of a fingertip, however far the page is zoomed. */
const CONTROL =
  'pointer-events-auto absolute flex h-8 w-8 touch-none select-none items-center justify-center rounded-full ' +
  'bg-zinc-900/90 text-white shadow-md hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-blue-300';

/**
 * z-27 layer of drawing aids: the ruler and the protractor, when they are out on this
 * page. Everything but their controls lets pointer input through, so a pen can draw on
 * and along them — which is what the ruler is for.
 */
export const AidsLayer = memo(function AidsLayer({ page, zoom }: AidsLayerProps) {
  const ruler = useAidStore((s) => (s.ruler?.pageId === page.id ? s.ruler : null));
  const protractor = useAidStore((s) => (s.protractor?.pageId === page.id ? s.protractor : null));
  const zoomHere = useZoomWindowStore((s) => s.open && s.pageId === page.id);
  const frameRef = useRef<HTMLDivElement>(null);

  /** A viewport position as a page position. */
  const toPage = useCallback(
    (clientX: number, clientY: number): Point => {
      const rect = frameRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom };
    },
    [zoom],
  );

  if (!ruler && !protractor && !zoomHere) return null;
  return (
    <div className="pointer-events-none absolute inset-0" style={{ zIndex: 27 }} data-aids-layer>
      <div
        ref={frameRef}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: page.dimensions.width,
          height: page.dimensions.height,
          transform: `scale(${zoom})`,
          transformOrigin: '0 0',
          pointerEvents: 'none',
        }}
      >
        {zoomHere && <ZoomRegionView page={page} zoom={zoom} toPage={toPage} />}
        {protractor && <ProtractorView aid={protractor} page={page} zoom={zoom} toPage={toPage} />}
        {ruler && <RulerView aid={ruler} page={page} zoom={zoom} toPage={toPage} />}
      </div>
    </div>
  );
});

interface ViewProps<A> {
  aid: A;
  page: Page;
  zoom: number;
  toPage: (clientX: number, clientY: number) => Point;
}

/**
 * Follow a drag from `e` to the pointer coming up, on the window: a control that is
 * moved out from under the pen would otherwise lose it. `move` gets the pointer in page
 * units and the event, for its modifier keys.
 */
function followPointer(e: ReactPointerEvent<HTMLElement>, toPage: (x: number, y: number) => Point, move: (at: Point, ev: PointerEvent) => void): void {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const pointerId = e.pointerId;
  try {
    e.currentTarget.setPointerCapture(pointerId);
  } catch {
    /* a synthetic pointer */
  }
  const onMove = (ev: PointerEvent): void => {
    if (ev.pointerId === pointerId) move(toPage(ev.clientX, ev.clientY), ev);
  };
  const stop = (ev: PointerEvent): void => {
    if (ev.pointerId !== pointerId) return;
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', stop, true);
    window.removeEventListener('pointercancel', stop, true);
  };
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', stop, true);
  window.addEventListener('pointercancel', stop, true);
}

/** Keeps a control the same size on screen at any zoom, centred on the point it is placed at. */
function controlStyle(x: number, y: number, zoom: number): CSSProperties {
  return { left: x, top: y, transform: `translate(-50%, -50%) scale(${1 / zoom})`, transformOrigin: 'center' };
}

// ---------------------------------------------------------------------------
// Zoom window's region
// ---------------------------------------------------------------------------

/**
 * Where the zoom window is looking: a frame round the part of the page it shows, with a grip to
 * drag it to another part. The frame itself lets pointer input through.
 */
function ZoomRegionView({ page, zoom, toPage }: Omit<ViewProps<unknown>, 'aid'>) {
  const { origin, width, height, mag } = useZoomWindowStore(
    useShallow((s) => ({ origin: s.origin, width: s.width, height: s.height, mag: s.mag })),
  );
  const moveTo = useZoomWindowStore((s) => s.moveTo);
  const region = regionSize({ width, height }, mag);
  const beginMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const start = toPage(e.clientX, e.clientY);
    const from = { x: origin.x, y: origin.y };
    followPointer(e, toPage, (at) => moveTo({ x: from.x + at.x - start.x, y: from.y + at.y - start.y }, page.dimensions));
  };
  return (
    <div
      data-zoom-region
      style={{
        position: 'absolute',
        left: origin.x,
        top: origin.y,
        width: region.w,
        height: region.h,
        border: `${2 / zoom}px dashed rgba(37, 99, 235, 0.9)`,
        background: 'rgba(37, 99, 235, 0.06)',
        boxSizing: 'border-box',
        pointerEvents: 'none',
      }}
    >
      <button
        type="button"
        className={`${CONTROL} h-7 w-7 cursor-move`}
        style={{ ...controlStyle(0, 0, zoom), transformOrigin: 'center' }}
        aria-label="Move the zoom window's view"
        title="Drag to move where the zoom window is looking"
        data-zoom-region-move
        onPointerDown={beginMove}
      >
        <GripHorizontal size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ruler
// ---------------------------------------------------------------------------

const RULER_FILL = 'rgba(254, 240, 138, 0.62)';
const RULER_EDGE = 'rgba(161, 98, 7, 0.85)';
const RULER_INK = 'rgba(66, 32, 6, 0.9)';

function RulerView({ aid, page, zoom, toPage }: ViewProps<RulerAid>) {
  const setRuler = useAidStore((s) => s.setRuler);
  const closeRuler = useAidStore((s) => s.closeRuler);
  const { length } = aid;
  const ticks = rulerTicks(length);
  const line = 1 / zoom;

  const beginMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const start = toPage(e.clientX, e.clientY);
    const from = { x: aid.x, y: aid.y };
    followPointer(e, toPage, (at) => setRuler({ x: from.x + at.x - start.x, y: from.y + at.y - start.y }, page.dimensions));
  };
  const beginTurn = (e: ReactPointerEvent<HTMLElement>): void => {
    followPointer(e, toPage, (at, ev) => {
      const angle = Math.atan2(at.y - aid.y, at.x - aid.x);
      setRuler({ angle: snapRotation(angle, ev.shiftKey) }, page.dimensions);
    });
  };

  return (
    <div
      data-ruler
      data-ruler-angle={angleDegrees(aid)}
      style={{
        position: 'absolute',
        left: aid.x - length / 2,
        top: aid.y - RULER_WIDTH / 2,
        width: length,
        height: RULER_WIDTH,
        transform: `rotate(${aid.angle}rad)`,
        transformOrigin: 'center',
        pointerEvents: 'none',
      }}
    >
      <svg width={length} height={RULER_WIDTH} viewBox={`0 0 ${length} ${RULER_WIDTH}`} style={{ display: 'block', overflow: 'visible' }} aria-hidden="true">
        <rect x={0} y={0} width={length} height={RULER_WIDTH} rx={3} fill={RULER_FILL} stroke={RULER_EDGE} strokeWidth={1.5 * line} />
        {ticks.map((t) => {
          const size = t.kind === 'cm' ? 16 : t.kind === 'half' ? 11 : 6;
          return (
            <g key={t.at}>
              <line x1={t.at} y1={0} x2={t.at} y2={size} stroke={RULER_INK} strokeWidth={line} />
              <line x1={t.at} y1={RULER_WIDTH} x2={t.at} y2={RULER_WIDTH - size} stroke={RULER_INK} strokeWidth={line} />
              {t.label !== undefined && t.at > 2 && (
                <text x={t.at} y={29} textAnchor="middle" fontSize={10} fill={RULER_INK} style={{ userSelect: 'none', fontVariantNumeric: 'tabular-nums' }}>
                  {t.label}
                </text>
              )}
            </g>
          );
        })}
        <text x={length - 6} y={RULER_WIDTH - 20} textAnchor="end" fontSize={10} fill={RULER_INK} style={{ userSelect: 'none' }}>
          cm
        </text>
      </svg>

      {/* Move it, by the middle; turn it, by its right end; put it away, by its left. */}
      <button
        type="button"
        className={`${CONTROL} w-14 cursor-move rounded-xl`}
        style={controlStyle(length / 2, RULER_WIDTH / 2 + 6, zoom)}
        aria-label="Move the ruler"
        title="Drag to move the ruler"
        data-ruler-move
        onPointerDown={beginMove}
      >
        <GripHorizontal size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={`${CONTROL} cursor-grab`}
        style={controlStyle(length + 24 / zoom, RULER_WIDTH / 2, zoom)}
        aria-label="Turn the ruler"
        title="Drag to turn the ruler (Shift for steps of 15°)"
        data-ruler-turn
        onPointerDown={beginTurn}
      >
        <RotateCw size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={CONTROL}
        style={controlStyle(-24 / zoom, RULER_WIDTH / 2, zoom)}
        aria-label="Put the ruler away"
        title="Put the ruler away"
        data-ruler-close
        onPointerDown={(e) => e.stopPropagation()}
        onClick={closeRuler}
      >
        <X size={16} aria-hidden="true" />
      </button>
      <span
        className="pointer-events-none absolute select-none rounded bg-zinc-900/80 px-1 text-[10px] font-medium tabular-nums text-white"
        style={{ left: length / 2 + 44 / zoom, top: RULER_WIDTH / 2 + 6, transform: `translate(0, -50%) scale(${1 / zoom})`, transformOrigin: 'left center' }}
        data-ruler-reading
      >
        {angleDegrees(aid)}°
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Protractor
// ---------------------------------------------------------------------------

const PROTRACTOR_FILL = 'rgba(186, 230, 253, 0.55)';
const PROTRACTOR_EDGE = 'rgba(3, 105, 161, 0.85)';
const PROTRACTOR_INK = 'rgba(12, 74, 110, 0.95)';
/** The strip below the base, where the controls sit. */
const BASE_MARGIN = 30;

const TICKS = protractorTicks();

function ProtractorView({ aid, page, zoom, toPage }: ViewProps<ProtractorAid>) {
  const setProtractor = useAidStore((s) => s.setProtractor);
  const closeProtractor = useAidStore((s) => s.closeProtractor);
  const r = Math.max(PROTRACTOR_MIN_RADIUS, aid.radius);
  const line = 1 / zoom;
  const width = 2 * r;
  const height = r + BASE_MARGIN;
  const at = (degrees: number, distance: number): Point => {
    const a = (degrees * Math.PI) / 180;
    return { x: r + distance * Math.cos(a), y: r - distance * Math.sin(a) };
  };

  const beginMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const start = toPage(e.clientX, e.clientY);
    const from = { x: aid.x, y: aid.y };
    followPointer(e, toPage, (p) => setProtractor({ x: from.x + p.x - start.x, y: from.y + p.y - start.y }, page.dimensions));
  };
  const beginTurn = (e: ReactPointerEvent<HTMLElement>): void => {
    followPointer(e, toPage, (p, ev) => {
      // The handle stands at the top of the arc, straight up when it is level.
      const angle = Math.atan2(p.y - aid.y, p.x - aid.x) + Math.PI / 2;
      const wrapped = angle > Math.PI ? angle - 2 * Math.PI : angle;
      setProtractor({ angle: snapRotation(wrapped, ev.shiftKey) }, page.dimensions);
    });
  };

  const labels: ReactNode[] = [];
  for (let d = 10; d < 180; d += 10) {
    const outer = at(d, r - 27);
    const inner = at(d, r - 44);
    labels.push(
      <text key={`o${d}`} x={outer.x} y={outer.y} textAnchor="middle" dominantBaseline="middle" fontSize={9.5} fill={PROTRACTOR_INK} style={{ userSelect: 'none' }}>
        {d}
      </text>,
      <text key={`i${d}`} x={inner.x} y={inner.y} textAnchor="middle" dominantBaseline="middle" fontSize={8} fill={PROTRACTOR_INK} opacity={0.75} style={{ userSelect: 'none' }}>
        {180 - d}
      </text>,
    );
  }

  return (
    <div
      data-protractor
      style={{
        position: 'absolute',
        left: aid.x - r,
        top: aid.y - r,
        width,
        height,
        transform: `rotate(${aid.angle}rad)`,
        transformOrigin: `${r}px ${r}px`,
        pointerEvents: 'none',
      }}
    >
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', overflow: 'visible' }} aria-hidden="true">
        <path d={`M 0 ${r} A ${r} ${r} 0 0 1 ${width} ${r} L ${width} ${r + BASE_MARGIN} L 0 ${r + BASE_MARGIN} Z`} fill={PROTRACTOR_FILL} stroke={PROTRACTOR_EDGE} strokeWidth={1.5 * line} />
        <line x1={0} y1={r} x2={width} y2={r} stroke={PROTRACTOR_INK} strokeWidth={line} />
        {TICKS.map((t) => {
          const size = t.kind === 'ten' ? 16 : t.kind === 'five' ? 11 : 6;
          const a = at(t.degrees, r);
          const b = at(t.degrees, r - size);
          return <line key={t.degrees} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={PROTRACTOR_INK} strokeWidth={line} />;
        })}
        {labels}
        <line x1={r - 8} y1={r} x2={r + 8} y2={r} stroke={PROTRACTOR_INK} strokeWidth={1.5 * line} />
        <line x1={r} y1={r - 8} x2={r} y2={r + 8} stroke={PROTRACTOR_INK} strokeWidth={1.5 * line} />
        <circle cx={r} cy={r} r={2.5} fill={PROTRACTOR_INK} />
      </svg>
      <button
        type="button"
        className={`${CONTROL} w-14 cursor-move rounded-xl`}
        style={controlStyle(r, r + BASE_MARGIN / 2, zoom)}
        aria-label="Move the protractor"
        title="Drag to move the protractor"
        data-protractor-move
        onPointerDown={beginMove}
      >
        <GripHorizontal size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={`${CONTROL} cursor-grab`}
        style={controlStyle(r, -22 / zoom, zoom)}
        aria-label="Turn the protractor"
        title="Drag to turn the protractor (Shift for steps of 15°)"
        data-protractor-turn
        onPointerDown={beginTurn}
      >
        <RotateCw size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={CONTROL}
        style={controlStyle(22 / zoom, r + BASE_MARGIN / 2, zoom)}
        aria-label="Put the protractor away"
        title="Put the protractor away"
        data-protractor-close
        onPointerDown={(e) => e.stopPropagation()}
        onClick={closeProtractor}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

// Re-exported for the insert menu's label and for tests.
export const CM_IN_PAGE_UNITS = PX_PER_CM;
