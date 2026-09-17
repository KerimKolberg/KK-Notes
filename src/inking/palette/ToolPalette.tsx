import { memo, useCallback, useRef, useState, type RefObject } from 'react';
import {
  Axis3d,
  Ellipsis,
  Eraser,
  GripHorizontal,
  Highlighter,
  ImagePlus,
  Lasso,
  MousePointer2,
  Pipette,
  Redo2,
  Settings2,
  Spline,
  Undo2,
  Zap,
} from 'lucide-react';
import { COLOR_PALETTE, MAX_STROKE_SIZE, MIN_STROKE_SIZE } from '../constants';
import { IconButton } from '../../ui/IconButton';
import { Popover } from '../../ui/Popover';
import { Tooltip } from '../../ui/Tooltip';
import { useDraggablePanel } from '../../ui/useDraggablePanel';
import { useSafeAreaInsets } from '../../ui/useSafeAreaInsets';
import type { ToolSettings, ToolType } from '../types';
import { BRUSH_ICONS, BrushFlyout, Chip, PaletteSettings, PlaneOptions, StrokeOptions, brushLabel } from './parts';

export interface ToolPaletteProps {
  settings: Readonly<ToolSettings>;
  onSettingsChange: (patch: Partial<ToolSettings>) => void;
  onClear: () => void;
  /** The element the palette floats inside; it can never be dragged out of it. */
  containerRef: RefObject<HTMLElement | null>;
  /** Undo / redo live in the app's top bar, so only the standalone canvas passes these. */
  history?: { canUndo: boolean; canRedo: boolean; onUndo: () => void; onRedo: () => void };
  /** Opens a picker and places the chosen image on the page. */
  onInsertImage?: () => void;
  draggable?: boolean;
  /** Read-only mode fades the whole palette out. */
  hidden?: boolean;
}

type Flyout = 'brush' | 'stroke' | 'plane' | 'settings' | null;

const ERASERS: readonly ToolType[] = ['eraser-stroke', 'eraser-pixel'];

/** Tools that paint with the shared colour. */
function usesColor(tool: ToolType): boolean {
  return tool !== 'eraser-stroke' && tool !== 'eraser-pixel' && tool !== 'select' && tool !== 'lasso';
}

const DIVIDER = <span className="mx-0.5 h-8 w-px shrink-0 bg-zinc-200 dark:bg-zinc-700" aria-hidden="true" />;

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
  onInsertImage,
  draggable = true,
  hidden = false,
}: ToolPaletteProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const colorInputRef = useRef<HTMLInputElement>(null);
  const [flyout, setFlyout] = useState<Flyout>(null);
  const [lastEraser, setLastEraser] = useState<ToolType>('eraser-stroke');
  // On a tablet the palette must stay clear of the status bar and the gesture pill.
  const insets = useSafeAreaInsets();
  const { position, dragging, handleProps, reset } = useDraggablePanel({
    panelRef,
    containerRef,
    enabled: draggable && !hidden,
    insets,
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
  const activeColor = laser ? settings.laserColor : settings.color;
  const colorDisabled = !usesColor(settings.tool) || (laser && settings.laserRainbow);
  const setColor = (color: string): void => onSettingsChange(laser ? { laserColor: color } : { color });

  const eraserActive = ERASERS.includes(settings.tool);
  const eraserMode = eraserActive ? settings.tool : lastEraser;
  const eraserIsPixel = eraserMode === 'eraser-pixel';

  const BrushIcon = BRUSH_ICONS[settings.brush];
  const penActive = settings.tool === 'pen';
  const planeActive = settings.tool === 'coordinate-plane';

  return (
    <div
      ref={panelRef}
      role="toolbar"
      aria-label="Drawing tools"
      aria-orientation="horizontal"
      aria-hidden={hidden}
      data-tool-palette
      data-dragging={dragging ? 'true' : undefined}
      className={`absolute z-30 flex max-w-[calc(100vw-1.5rem)] flex-col gap-1 rounded-2xl border border-zinc-200/80 bg-white/90 p-1.5 shadow-2xl backdrop-blur-md transition-opacity duration-200 dark:border-zinc-700/80 dark:bg-zinc-900/90 ${
        hidden ? 'pointer-events-none opacity-0' : 'opacity-100'
      }`}
      style={{
        left: position?.x ?? 16,
        top: position?.y ?? 16,
        visibility: position === null ? 'hidden' : 'visible',
        touchAction: 'none',
      }}
    >
      {/* Row 1: the tools. */}
      <div className="flex items-center gap-0.5">
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

        {/* Actions */}
        <IconButton icon={MousePointer2} label="Select" active={settings.tool === 'select'} onClick={() => pick('select')} data-palette-tool="select" />
        <IconButton icon={Lasso} label="Lasso select" active={settings.tool === 'lasso'} onClick={() => pick('lasso')} data-palette-tool="lasso" />
        <IconButton icon={Zap} label="Laser pointer" active={laser} onClick={() => pick('laser-pointer')} data-palette-tool="laser-pointer" />
        {onInsertImage && <IconButton icon={ImagePlus} label="Insert image" onClick={onInsertImage} data-insert-image />}

        {DIVIDER}

        {/* Pens */}
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
        <IconButton
          icon={Highlighter}
          label="Highlighter"
          active={settings.tool === 'highlighter'}
          onClick={() => pick('highlighter')}
          data-palette-tool="highlighter"
        />

        {DIVIDER}

        {/* STEM & geometry */}
        <IconButton icon={Spline} label="Line and shapes" active={settings.tool === 'line'} onClick={() => pick('line')} data-palette-tool="line" />
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

        {DIVIDER}

        {/* Erasers: one button, two modes. */}
        <IconButton
          icon={Eraser}
          label={eraserIsPixel ? 'Pixel eraser' : 'Stroke eraser'}
          hint={eraserActive ? 'press again to switch' : undefined}
          active={eraserActive}
          badge={eraserIsPixel ? 'px' : undefined}
          onClick={() => {
            const next = eraserActive ? (eraserIsPixel ? 'eraser-stroke' : 'eraser-pixel') : eraserMode;
            setLastEraser(next);
            pick(next);
          }}
          data-palette-tool="eraser"
          data-eraser-mode={eraserIsPixel ? 'pixel' : 'stroke'}
        />

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
            <PaletteSettings settings={settings} onSettingsChange={onSettingsChange} onClear={onClear} />
          </Popover>
        </div>
      </div>

      {/* Row 2: colour and thickness. */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-zinc-100/70 px-2 py-1.5 dark:bg-zinc-800/60">
        <div className="flex items-center gap-1" role="group" aria-label="Stroke colour">
          {COLOR_PALETTE.map((color) => {
            const selected = activeColor.toLowerCase() === color.toLowerCase();
            return (
              <Tooltip key={color} label={`Colour ${color}`} side="top">
                <button
                  type="button"
                  aria-label={`Colour ${color}`}
                  aria-pressed={selected}
                  disabled={colorDisabled}
                  data-swatch={color}
                  className={`h-6 w-6 rounded-full ring-1 ring-black/15 transition-transform disabled:opacity-30 dark:ring-white/25 ${
                    selected ? 'scale-110 outline-2 outline-offset-2 outline-blue-500' : 'hover:scale-105'
                  }`}
                  style={{ background: color }}
                  onClick={() => setColor(color)}
                />
              </Tooltip>
            );
          })}
          <IconButton
            icon={Pipette}
            label="Custom colour"
            size="sm"
            disabled={colorDisabled}
            onClick={() => colorInputRef.current?.click()}
            data-custom-color
          />
          <input
            ref={colorInputRef}
            type="color"
            className="sr-only"
            aria-label="Custom colour value"
            value={activeColor.length === 7 ? activeColor : '#000000'}
            disabled={colorDisabled}
            onChange={(e) => setColor(e.target.value)}
          />
        </div>

        <span className="mx-0.5 h-6 w-px bg-zinc-300 dark:bg-zinc-600" aria-hidden="true" />

        <label className="flex min-w-0 flex-1 items-center gap-2" title="Stroke thickness">
          <span className="sr-only">Stroke thickness</span>
          <span
            className="shrink-0 rounded-full bg-current"
            aria-hidden="true"
            style={{
              width: Math.max(3, Math.min(14, settings.size)),
              height: Math.max(3, Math.min(14, settings.size)),
              color: colorDisabled ? '#a1a1aa' : activeColor,
            }}
          />
          <input
            type="range"
            className="h-1 min-w-16 flex-1 accent-blue-600"
            min={MIN_STROKE_SIZE}
            max={MAX_STROKE_SIZE}
            step={0.5}
            value={settings.size}
            aria-label="Stroke thickness"
            onChange={(e) => onSettingsChange({ size: Number(e.target.value) })}
            data-thickness
          />
          <span className="w-9 shrink-0 text-right text-xs tabular-nums text-zinc-500 dark:text-zinc-400" data-thickness-value>
            {settings.size}px
          </span>
        </label>

        {laser && (
          <Chip active={settings.laserRainbow} onClick={() => onSettingsChange({ laserRainbow: !settings.laserRainbow })} label="Rainbow laser">
            <span data-laser-rainbow>Rainbow</span>
          </Chip>
        )}
      </div>
    </div>
  );
});
