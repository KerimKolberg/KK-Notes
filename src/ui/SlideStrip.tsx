import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react';
import { FloatingProvider } from './floating';

/** How far a pen or a mouse has to move along the strip before the press is a slide rather than a tap, CSS px. */
export const SLIDE_SLOP = 6;

/** How much has to be out of view at an end for the arrow there to show, CSS px. */
const SLACK = 6;

export interface SlideStripProps {
  /** Standing on end (a toolbar docked to a side): it slides up and down instead of left and right. */
  readonly vertical: boolean;
  /** Pen and mouse drags slide it (a finger always can); off while its items are being rearranged by dragging. */
  readonly dragToSlide?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}

/** Where a press that may become a slide began. */
interface Slide {
  readonly pointerId: number;
  readonly start: number;
  readonly from: number;
  sliding: boolean;
}

/** A click that ends a slide is not a press of the button it ended on. */
function swallowNextClick(): void {
  const stop = (e: MouseEvent): void => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener('click', stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', stop, true), 0);
}

/**
 * A row of controls that slides, as Samsung Notes' toolbar does: one line however many there are, moved along
 * instead of wrapping onto a second line that takes more of the page. Standing on end, one column that slides up and
 * down.
 *
 * A finger slides it as any list scrolls. A pen and a mouse slide it by dragging along it — a pen has no other way,
 * and on Windows a pen does not scroll — and a mouse wheel slides it too. A fade with an arrow at an end says there
 * is more that way, and a press on it slides on by most of a strip's length.
 *
 * Popovers and tooltips inside are placed on the screen (`floating.ts`): the strip clips what it holds to its own box.
 */
export function SlideStrip({ vertical, dragToSlide = true, className = '', children }: SlideStripProps) {
  const ref = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ before: false, after: false });
  const slideRef = useRef<Slide | null>(null);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const at = vertical ? el.scrollTop : el.scrollLeft;
    const room = vertical ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
    // More than the strip's own padding: a button brought into view at an end leaves a pixel or two, and an arrow
    // over it then would be over the button.
    const before = at > SLACK;
    const after = at < room - SLACK;
    setMore((current) => (current.before === before && current.after === after ? current : { before, after }));
  }, [vertical]);

  useLayoutEffect(() => {
    const el = ref.current;
    const inner = innerRef.current;
    if (!el || !inner) return;
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    // Its own size, and what it holds: a flyout's swatch editor or the text toolbar changes the second only.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    observer?.observe(inner);
    // A wheel turned over a strip that lies down slides it along: a mouse has no sideways wheel.
    const onWheel = (e: WheelEvent): void => {
      if (vertical || e.ctrlKey || el.scrollWidth <= el.clientWidth) return;
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1;
      el.scrollLeft += delta * unit;
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('scroll', measure);
      el.removeEventListener('wheel', onWheel);
      observer?.disconnect();
    };
  }, [measure, vertical]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragToSlide || e.pointerType === 'touch' || e.button !== 0) return;
    // A slider, a list, a field: a drag there is theirs.
    if ((e.target as Element).closest?.('input, select, textarea')) return;
    const el = ref.current;
    if (!el || (vertical ? el.scrollHeight <= el.clientHeight : el.scrollWidth <= el.clientWidth)) return;
    slideRef.current = {
      pointerId: e.pointerId,
      start: vertical ? e.clientY : e.clientX,
      from: vertical ? el.scrollTop : el.scrollLeft,
      sliding: false,
    };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const slide = slideRef.current;
    const el = ref.current;
    if (!slide || slide.pointerId !== e.pointerId || !el) return;
    const moved = (vertical ? e.clientY : e.clientX) - slide.start;
    if (!slide.sliding) {
      if (Math.abs(moved) < SLIDE_SLOP) return;
      slide.sliding = true;
      // The strip takes the pointer from the button it started on, which lets go of it (a held swatch, a
      // tooltip waiting for a long press) as if the pointer had left it.
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* a synthetic pointer */
      }
    }
    if (vertical) el.scrollTop = slide.from - moved;
    else el.scrollLeft = slide.from - moved;
  };
  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const slide = slideRef.current;
    if (!slide || slide.pointerId !== e.pointerId) return;
    slideRef.current = null;
    if (slide.sliding) swallowNextClick();
  };

  /** Slide on by most of what is in view, keeping a button's width of what was there. */
  const page = (direction: -1 | 1): void => {
    const el = ref.current;
    if (!el) return;
    const span = Math.max(40, (vertical ? el.clientHeight : el.clientWidth) - 48);
    el.scrollBy({ [vertical ? 'top' : 'left']: direction * span, behavior: 'smooth' });
  };

  return (
    <div className={`relative flex min-h-0 min-w-0 ${vertical ? 'flex-col' : 'flex-row'} ${className}`} data-slide-strip={vertical ? 'vertical' : 'horizontal'}>
      <div
        ref={ref}
        className={`min-h-0 min-w-0 overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${
          vertical ? 'overflow-y-auto overflow-x-hidden' : 'overflow-x-auto overflow-y-hidden'
        }`}
        // Its own pan, against the toolbar's `touch-action: none`: the nearest scroller decides, and this is it.
        style={{ touchAction: vertical ? 'pan-y' : 'pan-x' }}
        data-slide-scroller
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        {/* Room on the sides across the strip for an active tool's ring and a focus outline, which the scroller
            would otherwise clip. */}
        <div ref={innerRef} className={`flex items-center gap-0.5 ${vertical ? 'h-max min-w-11 flex-col px-0.5 py-0.5' : 'w-max flex-row px-0.5 py-1'}`}>
          <FloatingProvider value="fixed">{children}</FloatingProvider>
        </div>
      </div>
      {more.before && <SlideEnd vertical={vertical} where="before" onPress={() => page(-1)} />}
      {more.after && <SlideEnd vertical={vertical} where="after" onPress={() => page(1)} />}
    </div>
  );
}

/** One end of a strip with more beyond it: a fade over the last of what shows, and an arrow to slide on. */
function SlideEnd({ vertical, where, onPress }: { vertical: boolean; where: 'before' | 'after'; onPress: () => void }) {
  const Icon = vertical ? (where === 'before' ? ChevronUp : ChevronDown) : where === 'before' ? ChevronLeft : ChevronRight;
  const place = vertical
    ? where === 'before'
      ? 'inset-x-0 top-0 h-6 bg-gradient-to-b'
      : 'inset-x-0 bottom-0 h-6 bg-gradient-to-t'
    : where === 'before'
      ? 'inset-y-0 left-0 w-6 bg-gradient-to-r'
      : 'inset-y-0 right-0 w-6 bg-gradient-to-l';
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={vertical ? (where === 'before' ? 'Slide up' : 'Slide down') : where === 'before' ? 'Slide left' : 'Slide right'}
      data-slide-more={where}
      className={`absolute z-10 flex touch-manipulation items-center justify-center from-white via-white/90 to-transparent text-zinc-500 hover:text-zinc-900 dark:from-zinc-900 dark:via-zinc-900/90 dark:text-zinc-400 dark:hover:text-zinc-50 ${place}`}
      onClick={onPress}
    >
      <Icon size={14} aria-hidden="true" />
    </button>
  );
}
