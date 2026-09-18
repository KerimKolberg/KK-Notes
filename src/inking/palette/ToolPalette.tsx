import { memo, useCallback, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  Axis3d,
  Ellipsis,
  Eraser,
  GripHorizontal,
  Highlighter,
  Lasso,
  MousePointer2,
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
import { PALETTE_GROUP_STARTS, PALETTE_SLOT_LABELS, type PaletteSlot } from '../../preferences/types';
import { filterIsActive } from '../engine/eraseFilter';
import { lassoFilterIsOpen } from '../engine/lassoFilter';
import { IconButton } from '../../ui/IconButton';
import { Popover } from '../../ui/Popover';
import { Tooltip } from '../../ui/Tooltip';
import { useDraggablePanel } from '../../ui/useDraggablePanel';
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

const DIVIDER = <span className="mx-0.5 h-8 w-px shrink-0 bg-zinc-200 dark:bg-zinc-700" aria-hidden="true" />;

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
  const { position, dragging, handleProps, reset } = useDraggablePanel({
    panelRef,
    containerRef,
    enabled: draggable && !hidden,
    insets,
  });

  // Arranging the icons is a mode, not something a stray drag can trigger:
  // the palette sits over a canvas someone is drawing on, and a tool button
  // that moved because the pen slipped would be worse than one in the wrong
  // place. Entered from the settings popover.
  const [arranging, setArranging] = useState(false);
  const { paletteOrder, movePaletteSlot } = usePreferencesStore(
    useShallow((s) => ({ paletteOrder: s.paletteOrder, movePaletteSlot: s.movePaletteSlot })),
  );
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
              <Popover open={flyout === 'lasso'} onClose={close} label="Lasso selection" side="top" align="center">
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
                <Popover open={flyout === 'insert'} onClose={close} label="Add to the page" side="top" align="center">
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
              <Popover open={flyout === 'brush'} onClose={close} label="Pen brushes" side="top" align="center">
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
              <Popover open={flyout === 'highlighter'} onClose={close} label="Highlighter" side="top" align="center">
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
              <Popover open={flyout === 'washi'} onClose={close} label="Washi tape" side="top" align="center">
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
              <Popover open={flyout === 'line'} onClose={close} label="Line path and pattern" side="top" align="center">
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
              <Popover open={flyout === 'plane'} onClose={close} label="Coordinate plane options" side="top" align="center">
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
              <Popover open={flyout === 'stroke'} onClose={close} label="Line pattern and snapping" side="top" align="center">
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
              <Popover open={flyout === 'eraser'} onClose={close} label="Eraser" side="top" align="center">
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

  return (
    <div
      ref={panelRef}
      role="toolbar"
      aria-label="Drawing tools"
      aria-orientation="horizontal"
      aria-hidden={hidden}
      data-tool-palette
      data-dragging={dragging ? 'true' : undefined}
      className={`absolute z-30 flex max-w-[calc(100vw-1.5rem-var(--safe-left)-var(--safe-right))] flex-col gap-1 rounded-2xl border border-zinc-200/80 bg-white/90 p-1.5 shadow-2xl backdrop-blur-md transition-opacity duration-200 dark:border-zinc-700/80 dark:bg-zinc-900/90 ${
        hidden ? 'pointer-events-none opacity-0' : 'opacity-100'
      }`}
      style={{
        left: position?.x ?? 16,
        top: position?.y ?? 16,
        visibility: position === null ? 'hidden' : 'visible',
        touchAction: 'none',
      }}
    >
      {/* Row 1: the tools. Wraps onto further lines rather than growing past
          the panel — on a phone the full set is far wider than the screen. */}
      <div className="flex flex-wrap items-center gap-0.5">
        {draggable && (
          <Tooltip label="Move the palette" hint="double-click to reset" side="top">
            <button
              type="button"
              aria-label="Move the palette"
              data-palette-handle
              className="inline-flex h-11 w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-200/70 active:cursor-grabbing dark:text-zinc-500 dark:hover:bg-zinc-700/70"
              onDoubleClick={reset}
              {...handleProps}
            >
              <GripHorizontal size={16} aria-hidden="true" />
            </button>
          </Tooltip>
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
          <Popover open={flyout === 'settings'} onClose={close} label="Input and page settings" side="top" align="end">
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

      <ToolConfigRow settings={settings} onSettingsChange={onSettingsChange} />
    </div>
  );
});
