import { memo, useCallback, useRef, useState, type FocusEvent, type ReactNode, type RefObject } from 'react';
import {
  Axis3d,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Ellipsis,
  Eraser,
  GripHorizontal,
  Highlighter,
  Lasso,
  MousePointer2,
  Pin,
  PinOff,
  Plus,
  Redo2,
  Settings2,
  Spline,
  Ticket,
  Undo2,
  Zap,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { usePointerReorder, type ReorderItemProps } from '../../document/hooks/usePointerReorder';
import { usePreferencesStore } from '../../preferences/store';
import { PALETTE_GROUP_STARTS, PALETTE_SLOT_LABELS, type PaletteDock, type PaletteSlot } from '../../preferences/types';
import { filterIsActive } from '../engine/eraseFilter';
import { lassoFilterIsOpen } from '../engine/lassoFilter';
import { IconButton } from '../../ui/IconButton';
import { Popover, type PopoverSide } from '../../ui/Popover';
import { TooltipSideProvider, Tooltip, type TooltipSide } from '../../ui/Tooltip';
import { isVerticalDock, verticalCapacity } from '../../ui/dock';
import { useIdleHide } from '../../ui/idleHide';
import { NO_INSETS, type Insets } from '../../ui/safeArea';
import { PANEL_MARGIN, useDraggablePanel } from '../../ui/useDraggablePanel';
import { useSafeAreaInsets } from '../../ui/useSafeAreaInsets';
import type { ToolSettings, ToolType } from '../types';
import {
  BRUSH_ICONS,
  BrushFlyout,
  EraserOptions,
  HighlighterOptions,
  LassoOptions,
  LineOptions,
  PaletteSettings,
  PlaneOptions,
  StrokeOptions,
  ToolConfigRow,
  WashiOptions,
  brushLabel,
} from './parts';

export interface ToolPaletteProps {
  settings: Readonly<ToolSettings>;
  onSettingsChange: (patch: Partial<ToolSettings>) => void;
  onClear: () => void;
  /** The element the palette floats inside; it can never be dragged out of it. */
  containerRef: RefObject<HTMLElement | null>;
  /** Undo / redo live in the app's top bar, so only the standalone canvas passes these. */
  history?: { canUndo: boolean; canRedo: boolean; onUndo: () => void; onRedo: () => void };
  /**
   * Body of the Add popover: every object that can be dropped onto a page.
   * Passed in rather than built here so the palette stays an inking control
   * and knows nothing about pages, notes or tables. `onInsertDone` closes the
   * popover once the menu has placed something.
   */
  insertMenu?: (onInsertDone: () => void) => ReactNode;
  /** Bulk removals offered in the eraser's flyout; scoped by the erase filter. */
  onClearPageInk?: () => void;
  onClearDocumentInk?: () => void;
  draggable?: boolean;
  /** Read-only mode fades the whole palette out. */
  hidden?: boolean;
}

type Flyout =
  | 'insert'
  | 'lasso'
  | 'brush'
  | 'highlighter'
  | 'washi'
  | 'line'
  | 'stroke'
  | 'plane'
  | 'eraser'
  | 'settings'
  | null;

const ERASERS: readonly ToolType[] = ['eraser-stroke', 'eraser-pixel'];

const LINE_LABELS: Readonly<Record<ToolSettings['lineCurve'], string>> = {
  straight: 'Line and shapes',
  parabola: 'Parabola',
  wave: 'Wave',
  zigzag: 'Zigzag',
};

function lineLabel(curve: ToolSettings['lineCurve']): string {
  return LINE_LABELS[curve];
}

/**
 * A divider between groups. Drawn as a vertical bar in a row and a horizontal one
 * in a column, chosen by CSS off the panel's `data-vertical` so the one element
 * serves both — it is shared by every slot, and threading an orientation to each
 * of them for a line would be a lot of plumbing for a line.
 */
const DIVIDER = (
  <span
    className="mx-0.5 h-8 w-px shrink-0 bg-zinc-200 group-data-[vertical=true]/palette:mx-0 group-data-[vertical=true]/palette:my-0.5 group-data-[vertical=true]/palette:h-px group-data-[vertical=true]/palette:w-8 dark:bg-zinc-700"
    aria-hidden="true"
  />
);

interface PaletteSlotButtonProps {
  slot: PaletteSlot;
  index: number;
  arranging: boolean;
  itemProps: ReorderItemProps;
  dragging: boolean;
  dropTarget: boolean;
  divider: ReactNode;
  children: ReactNode;
}

/**
 * One position on the palette.
 *
 * Normally it is nothing at all — the tool's own button, rendered as it
 * always was. While the palette is being arranged it becomes a drag handle
 * *over* that button, swallowing the press so reordering cannot accidentally
 * pick a tool, and carrying the tool's name for assistive tech since the icon
 * underneath is inert.
 */
function PaletteSlotButton({ slot, index, arranging, itemProps, dragging, dropTarget, divider, children }: PaletteSlotButtonProps) {
  const { ref, ...handlers } = itemProps;
  if (!arranging) {
    return (
      <>
        {divider}
        {children}
      </>
    );
  }
  return (
    <>
      {divider}
      <span
        ref={ref as unknown as React.Ref<HTMLSpanElement>}
        role="button"
        tabIndex={0}
        aria-label={`Move ${PALETTE_SLOT_LABELS[slot]}`}
        data-palette-slot={slot}
        data-palette-slot-index={index}
        className={`relative inline-flex cursor-grab touch-none rounded-xl ring-2 transition-opacity ${
          dropTarget ? 'ring-blue-500' : 'ring-dashed ring-zinc-300 dark:ring-zinc-600'
        } ${dragging ? 'opacity-40' : ''}`}
        {...handlers}
      >
        {/* Inert underneath: the handle owns the pointer while arranging. */}
        <span className="pointer-events-none">{children}</span>
      </span>
    </>
  );
}

/**
 * Floating, draggable tool palette.
 *
 * Every control is an icon with a tooltip and a matching `aria-label`, and the
 * selected tool is filled in rather than merely outlined, because a tablet
 * has no hover to fall back on. Tools that carry settings (the pen's brushes,
 * the coordinate plane) open a flyout when their own button is pressed again.
 */
export const ToolPalette = memo(function ToolPalette({
  settings,
  onSettingsChange,
  onClear,
  containerRef,
  history,
  insertMenu,
  onClearPageInk,
  onClearDocumentInk,
  draggable = true,
  hidden = false,
}: ToolPaletteProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [flyout, setFlyout] = useState<Flyout>(null);
  // On a tablet the palette must stay clear of the status bar and the gesture pill.
  const insets = useSafeAreaInsets();
  const { paletteOrder, movePaletteSlot, paletteDock, setPaletteDock, palettePinned, setPalettePinned } = usePreferencesStore(
    useShallow((s) => ({
      paletteOrder: s.paletteOrder,
      movePaletteSlot: s.movePaletteSlot,
      paletteDock: s.paletteDock,
      setPaletteDock: s.setPaletteDock,
      palettePinned: s.palettePinned,
      setPalettePinned: s.setPalettePinned,
    })),
  );
  // A palette that cannot be dragged (an embedded canvas) has no dock either.
  const dock = draggable ? paletteDock : 'free';
  // Whether the pointer or keyboard focus is on the toolbar. Tracked so an
  // unpinned one is never taken away from someone who is using it.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  // Arranging the icons is a mode, not something a stray drag can trigger:
  // the palette sits over a canvas someone is drawing on, and a tool button
  // that moved because the pen slipped would be worse than one in the wrong
  // place. Entered from the settings popover.
  const [arranging, setArranging] = useState(false);
  const { position, dragging, dockPreview, container, handleProps, reset } = useDraggablePanel({
    panelRef,
    containerRef,
    enabled: draggable && !hidden,
    insets,
    dock,
    onDockChange: setPaletteDock,
  });
  // Unpinned, the toolbar slips away after a few idle seconds. Anything that is
  // using it — the pointer over it, keyboard focus in it, a flyout open, a drag,
  // the icons being arranged — holds it up.
  const { concealed, reveal } = useIdleHide(
    draggable && !palettePinned && !hidden,
    flyout !== null || arranging || dragging || hovered || focused,
  );
  const away = hidden || concealed;
  const vertical = isVerticalDock(dock);
  /** Flyouts open away from the edge the toolbar is against, not always upwards. */
  const popSide: PopoverSide = dock === 'top' ? 'bottom' : dock === 'left' ? 'right' : dock === 'right' ? 'left' : 'top';
  const tipSide: TooltipSide = popSide;
  // A standing toolbar cannot be taller than the room it stands in, so its column
  // of tools wraps into a second one instead of running off the screen.
  const capacity = vertical && container ? verticalCapacity(container, PANEL_MARGIN, insets) : undefined;

  const noSelect = useCallback(() => {}, []);
  const { drag, getItemProps } = usePointerReorder({
    count: paletteOrder.length,
    onMove: movePaletteSlot,
    onSelect: noSelect,
    disabled: !arranging,
  });

  const close = useCallback(() => setFlyout(null), []);
  const toggle = useCallback((next: Exclude<Flyout, null>) => setFlyout((current) => (current === next ? null : next)), []);

  const pick = useCallback(
    (tool: ToolType) => {
      onSettingsChange({ tool });
      setFlyout(null);
    },
    [onSettingsChange],
  );

  const laser = settings.tool === 'laser-pointer';

  const eraserActive = ERASERS.includes(settings.tool);
  const eraserIsArea = settings.eraserMode === 'area';

  const BrushIcon = BRUSH_ICONS[settings.brush];
  const lassoActive = settings.tool === 'lasso';
  const penActive = settings.tool === 'pen';
  const highlighterActive = settings.tool === 'highlighter';
  const lineActive = settings.tool === 'line';
  const washiActive = settings.tool === 'washi-tape';
  const planeActive = settings.tool === 'coordinate-plane';

  const slots: Readonly<Record<PaletteSlot, ReactNode>> = {
    select: (
      <IconButton icon={MousePointer2} label="Select" active={settings.tool === 'select'} onClick={() => pick('select')} data-palette-tool="select" />
    ),
    lasso: (
      <div className="relative">
              <IconButton
                icon={Lasso}
                label="Lasso select"
                hint={lassoActive ? 'press again for layers and mode' : undefined}
                active={lassoActive}
                hasPopover
                tooltipDisabled={flyout === 'lasso'}
                onClick={() => (lassoActive ? toggle('lasso') : pick('lasso'))}
                data-palette-tool="lasso"
                data-lasso-mode={settings.lassoMode}
                data-lasso-filtered={lassoFilterIsOpen(settings.lassoFilter) ? undefined : 'true'}
              />
              <Popover open={flyout === 'lasso'} onClose={close} label="Lasso selection" side={popSide} align="center">
                <LassoOptions settings={settings} onSettingsChange={onSettingsChange} />
              </Popover>
            </div>
    ),
    laser: (
      <IconButton icon={Zap} label="Laser pointer" active={laser} onClick={() => pick('laser-pointer')} data-palette-tool="laser-pointer" />
    ),
    insert: insertMenu && (
              <div className="relative">
                <IconButton
                  icon={Plus}
                  label="Add to the page"
                  hint="images, sticky notes and tables"
                  active={flyout === 'insert'}
                  aria-haspopup="dialog"
                  aria-expanded={flyout === 'insert'}
                  onClick={() => toggle('insert')}
                  data-insert-trigger
                />
                <Popover open={flyout === 'insert'} onClose={close} label="Add to the page" side={popSide} align="center">
                  {insertMenu(close)}
                </Popover>
              </div>
            ),
    pen: (
      <div className="relative">
              <IconButton
                icon={BrushIcon}
                label={brushLabel(settings.brush)}
                hint={penActive ? 'press again for brushes' : undefined}
                active={penActive}
                hasPopover
                tooltipDisabled={flyout === 'brush'}
                onClick={() => (penActive ? toggle('brush') : pick('pen'))}
                data-palette-tool="pen"
              />
              <Popover open={flyout === 'brush'} onClose={close} label="Pen brushes" side={popSide} align="center">
                <BrushFlyout settings={settings} onSettingsChange={onSettingsChange} onPick={close} />
              </Popover>
            </div>
    ),
    highlighter: (
      <div className="relative">
              <IconButton
                icon={Highlighter}
                label="Highlighter"
                hint={highlighterActive ? 'press again for width, ink and gradient' : undefined}
                active={highlighterActive}
                hasPopover
                tooltipDisabled={flyout === 'highlighter'}
                onClick={() => (highlighterActive ? toggle('highlighter') : pick('highlighter'))}
                data-palette-tool="highlighter"
                data-highlighter-gradient={settings.highlighterGradient}
              />
              <Popover open={flyout === 'highlighter'} onClose={close} label="Highlighter" side={popSide} align="center">
                <HighlighterOptions settings={settings} onSettingsChange={onSettingsChange} />
              </Popover>
            </div>
    ),
    washi: (
      <div className="relative">
              <IconButton
                icon={Ticket}
                className="[&>svg]:-rotate-45"
                label="Washi tape"
                hint={washiActive ? 'press again for patterns' : undefined}
                active={washiActive}
                hasPopover
                tooltipDisabled={flyout === 'washi'}
                onClick={() => (washiActive ? toggle('washi') : pick('washi-tape'))}
                data-palette-tool="washi-tape"
              />
              <Popover open={flyout === 'washi'} onClose={close} label="Washi tape" side={popSide} align="center">
                <WashiOptions settings={settings} onSettingsChange={onSettingsChange} />
              </Popover>
            </div>
    ),
    line: (
      <div className="relative">
              <IconButton
                icon={Spline}
                label={lineLabel(settings.lineCurve)}
                hint={lineActive ? 'press again for paths and patterns' : undefined}
                active={lineActive}
                hasPopover
                tooltipDisabled={flyout === 'line'}
                onClick={() => (lineActive ? toggle('line') : pick('line'))}
                data-palette-tool="line"
                data-line-curve={settings.lineCurve}
              />
              <Popover open={flyout === 'line'} onClose={close} label="Line path and pattern" side={popSide} align="center">
                <LineOptions settings={settings} onSettingsChange={onSettingsChange} />
              </Popover>
            </div>
    ),
    plane: (
      <div className="relative">
              <IconButton
                icon={Axis3d}
                label="Coordinate system"
                hint={planeActive ? 'press again for options' : undefined}
                active={planeActive}
                hasPopover
                tooltipDisabled={flyout === 'plane'}
                onClick={() => (planeActive ? toggle('plane') : pick('coordinate-plane'))}
                data-palette-tool="coordinate-plane"
              />
              <Popover open={flyout === 'plane'} onClose={close} label="Coordinate plane options" side={popSide} align="center">
                <PlaneOptions settings={settings} onSettingsChange={onSettingsChange} />
              </Popover>
            </div>
    ),
    stroke: (
      <div className="relative">
              <IconButton
                icon={Ellipsis}
                label="Line pattern and snapping"
                active={flyout === 'stroke'}
                aria-haspopup="dialog"
                aria-expanded={flyout === 'stroke'}
                onClick={() => toggle('stroke')}
                data-stroke-options-trigger
              />
              <Popover open={flyout === 'stroke'} onClose={close} label="Line pattern and snapping" side={popSide} align="center">
                <StrokeOptions settings={settings} onSettingsChange={onSettingsChange} />
              </Popover>
            </div>
    ),
    eraser: (
      <div className="relative">
              <IconButton
                icon={Eraser}
                label={eraserIsArea ? 'Area eraser' : 'Stroke eraser'}
                hint={eraserActive ? 'press again for eraser options' : undefined}
                active={eraserActive}
                badge={eraserIsArea ? 'px' : undefined}
                hasPopover
                tooltipDisabled={flyout === 'eraser'}
                onClick={() => (eraserActive ? toggle('eraser') : pick(eraserIsArea ? 'eraser-pixel' : 'eraser-stroke'))}
                data-palette-tool="eraser"
                data-eraser-mode={settings.eraserMode}
                data-erase-filtered={filterIsActive(settings.eraseFilter) ? 'true' : undefined}
              />
              <Popover open={flyout === 'eraser'} onClose={close} label="Eraser" side={popSide} align="center">
                <EraserOptions
                  settings={settings}
                  onSettingsChange={onSettingsChange}
                  onClearPage={() => {
                    onClearPageInk?.();
                    close();
                  }}
                  onClearDocument={() => {
                    onClearDocumentInk?.();
                    close();
                  }}
                />
              </Popover>
            </div>
    ),
  };

  // Tracked as focus that came from the keyboard: a button that was merely
  // clicked keeps focus too, and that would hold an unpinned toolbar open for ever.
  const onFocus = useCallback((e: FocusEvent<HTMLElement>) => {
    try {
      if (e.target.matches(':focus-visible')) setFocused(true);
    } catch {
      /* a browser without :focus-visible: the pointer alone decides */
    }
  }, []);
  const onBlur = useCallback((e: FocusEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
  }, []);
  // A keyboard user activating the tab lands on the toolbar, not on nothing.
  const onReveal = useCallback(
    (viaKeyboard: boolean) => {
      reveal();
      if (viaKeyboard) {
        requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus());
      }
    },
    [reveal],
  );

  return (
    <TooltipSideProvider value={tipSide}>
      {dockPreview && <DockTarget edge={dockPreview} />}
      {concealed && !hidden && <RevealTab edge={dock === 'free' ? 'bottom' : dock} insets={insets} onReveal={onReveal} />}
      <div
        ref={panelRef}
        role="toolbar"
        aria-label="Drawing tools"
        aria-orientation={vertical ? 'vertical' : 'horizontal'}
        aria-hidden={away}
        data-tool-palette
        data-dock={dock}
        data-vertical={vertical ? 'true' : 'false'}
        data-pinned={palettePinned ? 'true' : 'false'}
        data-concealed={concealed ? 'true' : undefined}
        data-dragging={dragging ? 'true' : undefined}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onFocus={onFocus}
        onBlur={onBlur}
        // No backdrop blur. It looked like little, and it made the browser
        // re-blur the page behind the toolbar on every frame it moved — the
        // costliest thing on the screen, over the largest canvas, on the
        // biggest display. A near-opaque panel reads the same.
        className={`group/palette absolute z-30 flex max-w-[calc(100vw-1.5rem-var(--safe-left)-var(--safe-right))] ${
          vertical ? 'flex-row items-start' : 'flex-col'
        } gap-1 rounded-2xl border border-zinc-200/80 bg-white/95 p-1.5 shadow-2xl data-[dragging=true]:will-change-transform dark:border-zinc-700/80 dark:bg-zinc-900/95 ${
          away ? 'pointer-events-none opacity-0' : 'opacity-100'
        }`}
        style={{
          left: position?.x ?? 16,
          top: position?.y ?? 16,
          // Concealed is `hidden` rather than merely see-through, so its buttons
          // cannot be tabbed to. Going away, `visibility` waits for the fade to
          // finish; coming back it flips at once, so the toolbar can be focused and
          // tapped the moment it is asked for rather than a frame or two later.
          visibility: position === null || concealed ? 'hidden' : 'visible',
          transition: concealed ? 'opacity 200ms, visibility 0s 200ms' : 'opacity 200ms, visibility 0s',
          touchAction: 'none',
          ...(capacity ? { maxHeight: capacity } : {}),
        }}
      >
      {/* The tools. Wraps onto further lines rather than growing past the panel
          — on a phone the full set is far wider than the screen, and standing on
          end it is taller than a tablet in landscape. */}
      <div
        className={`flex items-center gap-0.5 ${vertical ? 'flex-col flex-wrap content-start' : 'flex-wrap'}`}
        style={vertical && capacity ? { maxHeight: capacity - 12 } : undefined}
      >
        {draggable && (
          <Tooltip label="Move the palette" hint="double-click to reset">
            <button
              type="button"
              aria-label="Move the palette"
              data-palette-handle
              className="inline-flex h-11 w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-200/70 active:cursor-grabbing group-data-[vertical=true]/palette:h-6 group-data-[vertical=true]/palette:w-11 dark:text-zinc-500 dark:hover:bg-zinc-700/70"
              onDoubleClick={reset}
              {...handleProps}
            >
              <GripHorizontal size={16} aria-hidden="true" />
            </button>
          </Tooltip>
        )}

        {draggable && (
          <IconButton
            icon={palettePinned ? Pin : PinOff}
            label={palettePinned ? 'Unpin the toolbar' : 'Pin the toolbar'}
            hint={palettePinned ? 'it will slip away when idle' : 'keep it on screen'}
            size="sm"
            aria-pressed={palettePinned}
            className={palettePinned ? 'text-blue-600 dark:text-blue-400 [&>svg]:fill-current' : ''}
            onClick={() => setPalettePinned(!palettePinned)}
            data-palette-pin
          />
        )}

        {/* The tools, in whatever order the user arranged them. Dividers are
            drawn before the slot that starts each group, so the grouping
            survives a reorder rather than being pinned to fixed positions. */}
        {paletteOrder.map((slot, index) => {
          const content = slots[slot];
          if (!content) return null;
          return (
            <PaletteSlotButton
              key={slot}
              slot={slot}
              index={index}
              arranging={arranging}
              itemProps={getItemProps(index)}
              dragging={drag?.from === index}
              dropTarget={drag !== null && drag.over === index && drag.from !== index}
              divider={index > 0 && PALETTE_GROUP_STARTS.includes(slot) ? DIVIDER : null}
            >
              {content}
            </PaletteSlotButton>
          );
        })}

        {history && (
          <>
            {DIVIDER}
            <IconButton icon={Undo2} label="Undo" size="sm" disabled={!history.canUndo} onClick={history.onUndo} />
            <IconButton icon={Redo2} label="Redo" size="sm" disabled={!history.canRedo} onClick={history.onRedo} />
          </>
        )}

        {DIVIDER}

        <div className="relative">
          <IconButton
            icon={Settings2}
            label="Input and page settings"
            active={flyout === 'settings'}
            aria-haspopup="dialog"
            aria-expanded={flyout === 'settings'}
            onClick={() => toggle('settings')}
            data-palette-settings-trigger
          />
          <Popover open={flyout === 'settings'} onClose={close} label="Input and page settings" side={popSide} align="end">
            <PaletteSettings
              settings={settings}
              onSettingsChange={onSettingsChange}
              onClear={onClear}
              arranging={arranging}
              onArrangingChange={setArranging}
            />
          </Popover>
        </div>
      </div>

      {/* Colours and thickness: beneath the tools in a row, and in a column of
          their own beside them when the toolbar is standing on end. */}
      {vertical ? (
        <div className="shrink-0">
          <ToolConfigRow settings={settings} onSettingsChange={onSettingsChange} compact />
        </div>
      ) : (
        <ToolConfigRow settings={settings} onSettingsChange={onSettingsChange} />
      )}
      </div>
    </TooltipSideProvider>
  );
});

/**
 * What an unpinned toolbar leaves behind: a small tab on the edge it is docked to.
 *
 * A mouse brings the toolbar back by pointing at it. A pen and a finger do it with
 * a tap, and the keyboard with a click: a finger has no hover, and its touch-down
 * would otherwise swallow its own tap; a pen hovers over the page all the time it
 * is writing, and a toolbar that popped up over the words whenever it drifted past
 * the middle of the bottom edge would be worse than one that stayed hidden. The tab
 * sits in the middle of its edge, where the toolbar comes back, and inside the safe
 * area so a gesture bar cannot cover it.
 */
function RevealTab({
  edge,
  insets = NO_INSETS,
  onReveal,
}: {
  edge: PaletteDock;
  insets?: Insets;
  onReveal: (viaKeyboard: boolean) => void;
}): React.JSX.Element {
  const shape: Record<PaletteDock, { className: string; style: React.CSSProperties; Icon: typeof ChevronUp }> = {
    bottom: { className: 'left-1/2 h-6 w-20 -translate-x-1/2 rounded-t-2xl border-b-0', style: { bottom: insets.bottom }, Icon: ChevronUp },
    top: { className: 'left-1/2 h-6 w-20 -translate-x-1/2 rounded-b-2xl border-t-0', style: { top: insets.top }, Icon: ChevronDown },
    left: { className: 'top-1/2 h-20 w-6 -translate-y-1/2 rounded-r-2xl border-l-0', style: { left: insets.left }, Icon: ChevronRight },
    right: { className: 'top-1/2 h-20 w-6 -translate-y-1/2 rounded-l-2xl border-r-0', style: { right: insets.right }, Icon: ChevronLeft },
    free: { className: 'hidden', style: {}, Icon: ChevronUp },
  };
  const { className, style, Icon } = shape[edge];
  return (
    <button
      type="button"
      aria-label="Show the toolbar"
      title="Show the toolbar"
      data-palette-reveal={edge}
      className={`absolute z-30 flex touch-manipulation items-center justify-center border border-zinc-200/80 bg-white/95 text-zinc-500 shadow-lg hover:text-zinc-900 focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-zinc-700/80 dark:bg-zinc-900/95 dark:text-zinc-400 dark:hover:text-zinc-50 ${className}`}
      style={style}
      // Hover reveals for a mouse only. Touch reports "enter" the instant it lands
      // and would make the tab vanish beneath the finger before the tap was over,
      // and a pen is usually hovering over a page it is about to write on.
      onPointerEnter={(e) => {
        if (e.pointerType === 'mouse') onReveal(false);
      }}
      onClick={(e) => onReveal(e.detail === 0)}
    >
      <Icon size={16} aria-hidden="true" />
    </button>
  );
}

/**
 * Where the toolbar will land if let go: a bar along the edge it is being pushed
 * against, shown only while it is dragged. Without it, docking is a guess — the
 * toolbar is still under the finger, nowhere near the edge it is about to jump to.
 */
function DockTarget({ edge }: { edge: PaletteDock }): React.JSX.Element {
  const place: Record<PaletteDock, string> = {
    bottom: 'inset-x-6 bottom-1 h-1.5',
    top: 'inset-x-6 top-1 h-1.5',
    left: 'inset-y-6 left-1 w-1.5',
    right: 'inset-y-6 right-1 w-1.5',
    free: 'hidden',
  };
  return (
    <div
      className={`pointer-events-none absolute z-20 rounded-full bg-blue-500/70 ${place[edge]}`}
      data-dock-target={edge}
      aria-hidden="true"
    />
  );
}
