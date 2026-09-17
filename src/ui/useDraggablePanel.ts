import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { clampPanelPosition, defaultPanelPosition, PANEL_MARGIN, type Position, type Size } from './dragBounds';
import { NO_INSETS, type Insets } from './safeArea';

export interface UseDraggablePanelOptions {
  /** The panel itself; measured so it can never leave its container. */
  panelRef: RefObject<HTMLElement | null>;
  /** The element the panel is positioned inside (its offset parent). */
  containerRef: RefObject<HTMLElement | null>;
  enabled?: boolean;
  /** Safe-area insets to stay clear of (Android status bar / gesture pill). */
  insets?: Insets;
}

export interface DraggablePanel {
  position: Position | null;
  dragging: boolean;
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
}

/**
 * Pointer-driven dragging for a floating panel, with viewport clamping.
 *
 * Positions are kept in the container's coordinate space and re-clamped
 * whenever the container or the panel changes size, so rotating a tablet or
 * opening the arranger can never strand the palette off-screen.
 */
export function useDraggablePanel({ panelRef, containerRef, enabled = true, insets = NO_INSETS }: UseDraggablePanelOptions): DraggablePanel {
  const [position, setPosition] = useState<Position | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<Drag | null>(null);
  const positionRef = useRef<Position | null>(null);
  positionRef.current = position;
  const insetsRef = useRef<Insets>(insets);
  insetsRef.current = insets;

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

  // Place it on mount, then keep it inside whenever anything resizes.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const container = resolveContainer();
    if (!container || !panel) return;
    const fit = (): void => {
      const sizes = measure();
      if (!sizes || sizes.container.width === 0) return;
      setPosition((current) =>
        current === null
          ? defaultPanelPosition(sizes.panel, sizes.container, PANEL_MARGIN, insetsRef.current)
          : clampPanelPosition(current, sizes.panel, sizes.container, PANEL_MARGIN, insetsRef.current),
      );
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    observer.observe(panel);
    return () => observer.disconnect();
    // Re-fit when the system bars change (rotation, keyboard, immersive mode).
  }, [panelRef, resolveContainer, measure, insets]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!enabled || e.button !== 0) return;
      const panel = panelRef.current;
      const container = resolveContainer();
      if (!panel || !container) return;
      e.preventDefault();
      const panelRect = panel.getBoundingClientRect();
      dragRef.current = { pointerId: e.pointerId, grabX: e.clientX - panelRect.left, grabY: e.clientY - panelRect.top };
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
      const container = resolveContainer();
      const sizes = measure();
      if (!container || !sizes) return;
      const rect = container.getBoundingClientRect();
      setPosition(
        clampPanelPosition(
          { x: e.clientX - rect.left - drag.grabX, y: e.clientY - rect.top - drag.grabY },
          sizes.panel,
          sizes.container,
          PANEL_MARGIN,
          insetsRef.current,
        ),
      );
    },
    [resolveContainer, measure],
  );

  const endDrag = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setDragging(false);
  }, []);

  const reset = useCallback(() => {
    const sizes = measure();
    if (sizes) setPosition(defaultPanelPosition(sizes.panel, sizes.container, PANEL_MARGIN, insetsRef.current));
  }, [measure]);

  useEffect(() => {
    if (!enabled) {
      dragRef.current = null;
      setDragging(false);
    }
  }, [enabled]);

  return {
    position,
    dragging,
    handleProps: { onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag },
    reset,
  };
}

export { PANEL_MARGIN };
