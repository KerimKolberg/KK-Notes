import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { PaletteDock } from '../preferences/types';
import { clampPanelPosition, defaultPanelPosition, PANEL_MARGIN, type Position, type Size } from './dragBounds';
import { dockedPosition, snapDock } from './dock';
import { NO_INSETS, type Insets } from './safeArea';

export interface UseDraggablePanelOptions {
  /** The panel itself; measured so it can never leave its container. */
  panelRef: RefObject<HTMLElement | null>;
  /** The element the panel is positioned inside (its offset parent). */
  containerRef: RefObject<HTMLElement | null>;
  enabled?: boolean;
  /** Safe-area insets to stay clear of (Android status bar / gesture pill). */
  insets?: Insets;
  /** Which edge the panel is docked to; `free` leaves it where it was dropped. */
  dock?: PaletteDock;
  /** Called when a drag ends on an edge (or away from all of them). */
  onDockChange?: (dock: PaletteDock) => void;
}

export interface DraggablePanel {
  position: Position | null;
  dragging: boolean;
  /** The edge the panel would dock to if released now, while dragging; otherwise `null`. */
  dockPreview: PaletteDock | null;
  /** Size of the container, for a docked panel that has to fit inside it. */
  container: Size | null;
  /** Spread onto the drag handle. */
  handleProps: {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
  };
  /** Put the panel back where it started. */
  reset: () => void;
}

interface Drag {
  pointerId: number;
  /** Pointer offset inside the panel, so it does not jump on grab. */
  grabX: number;
  grabY: number;
  /** Where the panel was when the drag began; the transform is relative to this. */
  origin: Position;
  /** Where the panel would be dropped, kept in a ref because it changes every move. */
  latest: Position;
  latestDock: PaletteDock;
}

/**
 * Pointer-driven dragging for a floating panel, with viewport clamping and
 * docking to the edges of its container — flush against the edge it is docked to.
 *
 * Positions are kept in the container's coordinate space and re-clamped
 * whenever the container or the panel changes size, so rotating a tablet or
 * opening the arranger can never strand the palette off-screen.
 *
 * **While dragging, React is not involved.** The panel is moved with a
 * `transform` written straight onto the element, and nothing is committed to
 * state until the pointer lifts. Committing on every move re-rendered the whole
 * toolbar — some thirty buttons and their tooltips — sixty or a hundred and
 * eighty times a second, and positioned it with `left`/`top`, which forces a
 * layout each time. Over a large canvas, on a big screen, that is what made it
 * lag. A transform is composited without layout, and one state change at the
 * start and one at the end is all React sees.
 */
export function useDraggablePanel({
  panelRef,
  containerRef,
  enabled = true,
  insets = NO_INSETS,
  dock = 'free',
  onDockChange,
}: UseDraggablePanelOptions): DraggablePanel {
  const [position, setPosition] = useState<Position | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dockPreview, setDockPreview] = useState<PaletteDock | null>(null);
  const [container, setContainer] = useState<Size | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const positionRef = useRef<Position | null>(null);
  positionRef.current = position;
  const insetsRef = useRef<Insets>(insets);
  insetsRef.current = insets;
  const dockRef = useRef<PaletteDock>(dock);
  dockRef.current = dock;
  const onDockChangeRef = useRef(onDockChange);
  onDockChangeRef.current = onDockChange;

  /**
   * The element the panel is positioned against. React attaches child refs
   * before the parent's, so on the first layout pass `containerRef` can still
   * be empty; the panel's own offset parent is the same element and is
   * already there.
   */
  const resolveContainer = useCallback((): HTMLElement | null => {
    const offsetParent = panelRef.current?.offsetParent;
    if (offsetParent instanceof HTMLElement) return offsetParent;
    return containerRef.current;
  }, [panelRef, containerRef]);

  const measure = useCallback((): { panel: Size; container: Size } | null => {
    const panel = panelRef.current;
    const container = resolveContainer();
    if (!panel || !container) return null;
    return {
      panel: { width: panel.offsetWidth, height: panel.offsetHeight },
      container: { width: container.clientWidth, height: container.clientHeight },
    };
  }, [panelRef, resolveContainer]);

  // Place it on mount, then keep it inside whenever anything resizes — and again
  // whenever the dock changes, because standing the toolbar on end changes its size.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const host = resolveContainer();
    if (!host || !panel) return;
    const fit = (): void => {
      const sizes = measure();
      if (!sizes || sizes.container.width === 0) return;
      setContainer((current) =>
        current && current.width === sizes.container.width && current.height === sizes.container.height
          ? current
          : sizes.container,
      );
      // Not while it is being dragged: the drag owns the position until it ends.
      if (dragRef.current) return;
      // Docked, it is flush against its edge — no margin, and the system bars are the panel's own padding to keep
      // clear of, not a gap in front of it.
      const docked = dockedPosition(dockRef.current, sizes.panel, sizes.container, 0, NO_INSETS);
      setPosition((current) => {
        if (docked) return current && current.x === docked.x && current.y === docked.y ? current : docked;
        return current === null
          ? defaultPanelPosition(sizes.panel, sizes.container, PANEL_MARGIN, insetsRef.current)
          : clampPanelPosition(current, sizes.panel, sizes.container, PANEL_MARGIN, insetsRef.current);
      });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(host);
    observer.observe(panel);
    return () => observer.disconnect();
    // Re-fit when the system bars change (rotation, keyboard, immersive mode).
  }, [panelRef, resolveContainer, measure, insets, dock]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!enabled || e.button !== 0) return;
      const panel = panelRef.current;
      const host = resolveContainer();
      const at = positionRef.current;
      if (!panel || !host || !at) return;
      e.preventDefault();
      const panelRect = panel.getBoundingClientRect();
      dragRef.current = {
        pointerId: e.pointerId,
        grabX: e.clientX - panelRect.left,
        grabY: e.clientY - panelRect.top,
        origin: at,
        latest: at,
        latestDock: dockRef.current,
      };
      setDragging(true);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic pointer */
      }
    },
    [enabled, panelRef, resolveContainer],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      const panel = panelRef.current;
      const host = resolveContainer();
      const sizes = measure();
      if (!panel || !host || !sizes) return;
      const rect = host.getBoundingClientRect();
      const next = clampPanelPosition(
        { x: e.clientX - rect.left - drag.grabX, y: e.clientY - rect.top - drag.grabY },
        sizes.panel,
        sizes.container,
        PANEL_MARGIN,
        insetsRef.current,
      );
      drag.latest = next;
      // The whole drag, as far as the page is concerned: one style write, no
      // React, no layout. `translate3d` keeps it on the compositor.
      panel.style.transform = `translate3d(${next.x - drag.origin.x}px, ${next.y - drag.origin.y}px, 0)`;

      // Which edge it would dock to if let go here, judged by the pointer.
      const target = snapDock({ x: e.clientX - rect.left, y: e.clientY - rect.top }, sizes.container);
      if (target !== drag.latestDock) {
        drag.latestDock = target;
        setDockPreview(target === 'free' ? null : target);
      }
    },
    [panelRef, resolveContainer, measure],
  );

  const endDrag = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      dragRef.current = null;
      const panel = panelRef.current;
      const cancelled = e.type === 'pointercancel';
      const target = drag.latestDock;
      const dropFree = !cancelled && target === 'free';
      if (panel) {
        panel.style.transform = '';
        // Only a drop in free space keeps where it landed. Written straight onto
        // the element together with clearing the transform, so it does not flash
        // back to where the drag began before React commits the same position.
        // Anything else returns to the place React already has: a cancelled drag
        // to where it started, a drop on an edge to that edge.
        if (dropFree) {
          panel.style.left = `${drag.latest.x}px`;
          panel.style.top = `${drag.latest.y}px`;
        }
      }
      setDragging(false);
      setDockPreview(null);
      if (cancelled) return;

      if (target !== dockRef.current) onDockChangeRef.current?.(target);
      // Docked, the layout effect places it (its size may be about to change);
      // free, it stays exactly where it was dropped.
      if (dropFree) setPosition(drag.latest);
    },
    [panelRef],
  );

  const reset = useCallback(() => {
    // Back where it started: docked to the bottom, or — for a panel with no dock
    // to return to — its default spot.
    if (onDockChangeRef.current) {
      onDockChangeRef.current('bottom');
      return;
    }
    const sizes = measure();
    if (sizes) setPosition(defaultPanelPosition(sizes.panel, sizes.container, PANEL_MARGIN, insetsRef.current));
  }, [measure]);

  useEffect(() => {
    if (!enabled) {
      dragRef.current = null;
      setDragging(false);
      setDockPreview(null);
    }
  }, [enabled]);

  return {
    position,
    dragging,
    dockPreview,
    container,
    handleProps: { onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag },
    reset,
  };
}

export { PANEL_MARGIN };
