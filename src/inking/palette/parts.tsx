import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  Brush,
  Check,
  Pen,
  PenLine,
  PenTool,
  Pencil,
  Pipette,
  Plus,
  Rainbow,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { IconButton } from '../../ui/IconButton';
import { Tooltip } from '../../ui/Tooltip';
import { Row, Switch } from '../../ui/SettingsRow';
import {
  DEFAULT_WASHI_ACCENT,
  STROKE_PATTERNS,
  STROKE_SIZE_STEPS,
  STYLUS_TOOLS,
  sizeToStep,
  stepToSize,
} from '../constants';
import { MAX_SWATCHES, MIN_SWATCHES } from '../../preferences/types';
import { usePreferencesStore } from '../../preferences/store';
import { BRUSHES } from '../engine/brushes';
import type { ArrowheadMode, BrushId, StrokePattern, ToolSettings, ToolType } from '../types';

/**
 * Tools a pen button can reach.
 *
 * Not every tool: the ones worth a hardware button are the ones you switch to
 * for a moment and back. The list lives in `constants` so that what the settings
 * offer and what a saved mapping is checked against are the same list.
 */
export const BARREL_TOOLS = STYLUS_TOOLS;

/** How long a swatch must be held before it becomes editable, in ms. */
export const SWATCH_HOLD_MS = 550;

/** Print colours offered for tape; white and black cover most real rolls. */
export const WASHI_ACCENTS: readonly string[] = [DEFAULT_WASHI_ACCENT, '#1f1f24', '#fde68a', '#bfdbfe', '#fbcfe8'];

/** Icon for each pen preset; the palette shows the active one on the pen button. */
export const BRUSH_ICONS: Readonly<Record<BrushId, LucideIcon>> = {
  ballpoint: Pen,
  fountain: PenTool,
  pencil: Pencil,
  marker: PenLine,
  brush: Brush,
};

export function brushLabel(id: BrushId): string {
  return BRUSHES.find((b) => b.id === id)?.label ?? 'Pen';
}

export const CHIP =
  'inline-flex h-8 items-center justify-center rounded-lg px-2.5 text-xs font-medium transition-colors ' +
  'text-zinc-700 hover:bg-zinc-200 dark:text-zinc-200 dark:hover:bg-zinc-700 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500 disabled:opacity-40';
export const CHIP_ON = 'bg-blue-600 text-white hover:bg-blue-600 dark:bg-blue-500 dark:text-white';

export interface ChipProps {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
  label?: string;
}

/** Small text button used inside the popovers. */
export function Chip({ active = false, disabled = false, onClick, children, label }: ChipProps) {
  return (
    <button
      type="button"
      className={`${CHIP} ${active ? CHIP_ON : ''}`}
      aria-pressed={active}
      {...(label ? { 'aria-label': label } : {})}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// A labelled row and an on/off switch: shared with panels outside the palette, so they live in `ui/`.
export { Row, Switch };

export const SELECT =
  'h-8 rounded-lg border border-zinc-300 bg-white px-2 text-xs text-zinc-900 ' +
  'dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100';

// ---------------------------------------------------------------------------
// Popover bodies
// ---------------------------------------------------------------------------

export interface PanelProps {
  settings: Readonly<ToolSettings>;
  onSettingsChange: (patch: Partial<ToolSettings>) => void;
}

/** Tools that paint with the shared colour. */
export function usesColor(tool: ToolType): boolean {
  return tool !== 'eraser-stroke' && tool !== 'eraser-pixel' && tool !== 'select' && tool !== 'lasso';
}

/**
 * Colour, thickness and the settings that belong to the current tool alone.
 *
 * Lives outside the palette because a locked document still shows it: the
 * laser pointer marks nothing, so presenting with it stays available — and
 * useless without its colour and width.
 *
 * `compact` is for the toolbar standing on end at a side of the screen, where
 * every pixel of width is taken from the page: the same controls in a single
 * column one button wide, filling the height the tools beside it already take,
 * instead of laid out in a row that runs to three hundred pixels. Anything that is
 * a word elsewhere (Add, Remove, Done, Rainbow) is an icon here, for the width.
 */
export function ToolConfigRow({
  settings,
  onSettingsChange,
  compact = false,
  strip = false,
}: PanelProps & {
  compact?: boolean;
  /** In a toolbar that slides (`ui/SlideStrip.tsx`): one line that never wraps, its slider a fixed length. */
  strip?: boolean;
}) {
  const colorInputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const laser = settings.tool === 'laser-pointer';
  const activeColor = laser ? settings.laserColor : settings.color;
  const colorDisabled = !usesColor(settings.tool) || (laser && settings.laserRainbow);
  const setColor = (color: string): void => onSettingsChange(laser ? { laserColor: color } : { color });

  const { swatches, setSwatch, addSwatch, removeSwatch, widthPresets, setWidthPreset } = usePreferencesStore(
    useShallow((s) => ({
      swatches: s.swatches,
      setSwatch: s.setSwatch,
      addSwatch: s.addSwatch,
      removeSwatch: s.removeSwatch,
      widthPresets: s.widthPresets,
      setWidthPreset: s.setWidthPreset,
    })),
  );
  // Which swatch a press is currently editing. Entered by a long press, so
  // the row stays a row of colours for the pen and only becomes an editor
  // when someone deliberately holds one down.
  const [editing, setEditing] = useState<number | null>(null);
  const holdRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heldRef = useRef(false);

  const beginHold = (index: number): void => {
    heldRef.current = false;
    holdRef.current = setTimeout(() => {
      heldRef.current = true;
      setEditing(index);
      // Opening the picker from inside the timer keeps it inside the gesture,
      // which is what browsers require for a colour input to open at all.
      requestAnimationFrame(() => editInputRef.current?.click());
    }, SWATCH_HOLD_MS);
  };
  const endHold = (): void => {
    if (holdRef.current !== null) clearTimeout(holdRef.current);
    holdRef.current = null;
  };

  return (
    <div
      className={`rounded-xl bg-zinc-100/70 dark:bg-zinc-800/60 ${
        compact
          ? 'flex w-11 shrink-0 flex-col items-center gap-2 px-1 py-2'
          : strip
            ? 'flex shrink-0 flex-nowrap items-center gap-2 px-2'
            : 'flex flex-wrap items-center gap-2 px-2 py-1.5'
      }`}
      data-tool-config
      {...(compact ? { 'data-compact': 'true' } : {})}
      {...(strip ? { 'data-strip': 'true' } : {})}
    >
      <div
        className={compact ? 'flex flex-col items-center gap-1.5' : strip ? 'flex flex-nowrap items-center gap-1' : 'flex flex-wrap items-center gap-1'}
        role="group"
        aria-label="Stroke colour"
      >
        {swatches.map((color, index) => {
          const selected = activeColor.toLowerCase() === color.toLowerCase();
          return (
            <Tooltip key={`${color}-${index}`} label={`Colour ${color}`} hint="hold to change">
              <button
                type="button"
                aria-label={`Colour ${color}`}
                aria-pressed={selected}
                disabled={colorDisabled}
                data-swatch={color}
                data-swatch-index={index}
                className={`h-[22px] w-[22px] rounded-full ring-1 ring-black/15 transition-transform disabled:opacity-30 dark:ring-white/25 ${
                  selected ? 'scale-110 outline-2 outline-offset-2 outline-blue-500' : 'hover:scale-105'
                } ${editing === index ? 'outline-2 outline-offset-2 outline-amber-500' : ''}`}
                style={{ background: color }}
                onPointerDown={() => beginHold(index)}
                onPointerUp={endHold}
                onPointerLeave={endHold}
                onPointerCancel={endHold}
                onContextMenu={(e) => {
                  // Right-click is the mouse's long press.
                  e.preventDefault();
                  setEditing(index);
                  editInputRef.current?.click();
                }}
                onClick={() => {
                  // A press that became a hold chose a colour to edit, not a
                  // colour to draw with.
                  if (heldRef.current) {
                    heldRef.current = false;
                    return;
                  }
                  setColor(color);
                }}
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
        {/* The swatch editor's own picker, and the controls that go with it. */}
        <input
          ref={editInputRef}
          type="color"
          className="sr-only"
          aria-label="Edit this swatch"
          data-swatch-edit
          value={editing !== null ? (swatches[editing] ?? '#000000') : '#000000'}
          onChange={(e) => {
            if (editing !== null) setSwatch(editing, e.target.value);
          }}
        />
        {editing !== null && (
          <span
            className={`rounded-lg bg-amber-100 dark:bg-amber-950/60 ${
              compact ? 'flex flex-col items-center gap-0.5 p-0.5' : 'inline-flex items-center gap-1 px-1.5 py-0.5'
            }`}
            data-swatch-editor
          >
            {compact ? (
              <>
                <IconButton
                  icon={Plus}
                  label="Add this colour"
                  size="sm"
                  disabled={swatches.length >= MAX_SWATCHES}
                  onClick={() => addSwatch(swatches[editing] ?? '#000000')}
                  data-swatch-add
                />
                <IconButton
                  icon={Trash2}
                  label="Remove this colour"
                  size="sm"
                  tone="danger"
                  disabled={swatches.length <= MIN_SWATCHES}
                  onClick={() => {
                    removeSwatch(editing);
                    setEditing(null);
                  }}
                  data-swatch-remove
                />
                <IconButton icon={Check} label="Done editing" size="sm" onClick={() => setEditing(null)} data-swatch-done />
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="text-xs font-medium text-amber-900 hover:underline dark:text-amber-200"
                  onClick={() => addSwatch(swatches[editing] ?? '#000000')}
                  disabled={swatches.length >= MAX_SWATCHES}
                  data-swatch-add
                >
                  Add
                </button>
                <button
                  type="button"
                  className="text-xs font-medium text-rose-700 hover:underline disabled:opacity-40 dark:text-rose-300"
                  onClick={() => {
                    removeSwatch(editing);
                    setEditing(null);
                  }}
                  disabled={swatches.length <= MIN_SWATCHES}
                  data-swatch-remove
                >
                  Remove
                </button>
                <button
                  type="button"
                  className="text-xs font-medium text-zinc-600 hover:underline dark:text-zinc-300"
                  onClick={() => setEditing(null)}
                  data-swatch-done
                >
                  Done
                </button>
              </>
            )}
          </span>
        )}
      </div>

      <span
        className={compact ? 'h-px w-full bg-zinc-300 dark:bg-zinc-600' : 'mx-0.5 h-6 w-px bg-zinc-300 dark:bg-zinc-600'}
        aria-hidden="true"
      />

      {/* Two widths one tap away: a fine one to write with and a broader one to rule
          lines with. Holding one sets it to whatever the slider is at. */}
      <div
        className={compact ? 'flex flex-col items-center gap-1' : 'flex items-center gap-1'}
        role="group"
        aria-label="Quick widths"
        data-width-presets
      >
        {widthPresets.map((size, index) => (
          <WidthPresetButton
            key={index}
            index={index}
            size={size}
            current={settings.size}
            onPick={() => onSettingsChange({ size })}
            onSave={() => setWidthPreset(index, settings.size)}
          />
        ))}
      </div>

      <label
        className={compact ? 'flex min-w-0 flex-col items-center gap-1.5' : strip ? 'flex shrink-0 items-center gap-2' : 'flex min-w-0 flex-1 items-center gap-2'}
        title="Stroke thickness"
      >
        <span className="sr-only">Stroke thickness</span>
        {/* Beside the slider in a row; above it in a column, where the slider stands up
            beside the tools and runs down the height they leave free. */}
        <span className={compact ? 'flex flex-col items-center gap-0.5' : 'contents'}>
          <span
            className="shrink-0 rounded-full bg-current"
            aria-hidden="true"
            style={{
              width: Math.max(3, Math.min(14, settings.size)),
              height: Math.max(3, Math.min(14, settings.size)),
              color: colorDisabled ? '#a1a1aa' : activeColor,
            }}
          />
          {compact && (
            <span className="text-[10px] tabular-nums text-zinc-500 dark:text-zinc-400" data-thickness-value>
              {settings.size}px
            </span>
          )}
        </span>
        <input
          type="range"
          // `touch-none`: in a toolbar that slides, a finger on the slider moves the slider, not the toolbar.
          className={`touch-none accent-blue-600 ${compact ? 'h-28 w-5' : strip ? 'h-1 w-24' : 'h-1 min-w-16 flex-1'}`}
          // Standing on end, biggest at the top like a fader. Only the compact layout:
          // the row keeps its ordinary slider.
          {...(compact ? { style: { writingMode: 'vertical-lr', direction: 'rtl' } as const } : {})}
          // By notch rather than by pixel, so the fine widths below 1 px are as easy to reach as the rest.
          min={0}
          max={STROKE_SIZE_STEPS.length - 1}
          step={1}
          value={sizeToStep(settings.size)}
          aria-label="Stroke thickness"
          aria-valuetext={`${settings.size}px`}
          onChange={(e) => onSettingsChange({ size: stepToSize(Number(e.target.value)) })}
          data-thickness
        />
        {!compact && (
          <span className="w-9 shrink-0 text-right text-xs tabular-nums text-zinc-500 dark:text-zinc-400" data-thickness-value>
            {settings.size}px
          </span>
        )}
      </label>

      {laser &&
        (compact ? (
          <IconButton
            icon={Rainbow}
            label="Rainbow laser"
            size="sm"
            active={settings.laserRainbow}
            onClick={() => onSettingsChange({ laserRainbow: !settings.laserRainbow })}
            data-laser-rainbow
          />
        ) : (
          <Chip active={settings.laserRainbow} onClick={() => onSettingsChange({ laserRainbow: !settings.laserRainbow })} label="Rainbow laser">
            <span data-laser-rainbow>Rainbow</span>
          </Chip>
        ))}
    </div>
  );
}

/** One of the quick widths: a tap uses it, a hold saves the slider's width into it. */
function WidthPresetButton({
  index,
  size,
  current,
  onPick,
  onSave,
}: {
  index: number;
  size: number;
  current: number;
  onPick: () => void;
  onSave: () => void;
}) {
  const holdRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heldRef = useRef(false);
  const selected = current === size;
  const stop = (): void => {
    if (holdRef.current !== null) clearTimeout(holdRef.current);
    holdRef.current = null;
  };
  useEffect(() => stop, []);
  return (
    <Tooltip label={`${size} px`} hint="hold to save the slider's width here">
      <button
        type="button"
        aria-label={`Width ${size} pixels`}
        aria-pressed={selected}
        data-width-preset={index}
        data-width-value={size}
        className={`inline-flex h-6 min-w-6 items-center justify-center rounded-md px-1 text-[11px] font-semibold tabular-nums transition-colors ${
          selected
            ? 'bg-blue-600 text-white'
            : 'bg-white text-zinc-700 ring-1 ring-black/10 hover:bg-zinc-50 dark:bg-zinc-700 dark:text-zinc-100 dark:ring-white/15'
        }`}
        onPointerDown={() => {
          heldRef.current = false;
          stop();
          holdRef.current = setTimeout(() => {
            heldRef.current = true;
            onSave();
          }, SWATCH_HOLD_MS);
        }}
        onPointerUp={stop}
        onPointerLeave={stop}
        onPointerCancel={stop}
        onClick={() => {
          if (heldRef.current) {
            heldRef.current = false;
            return;
          }
          onPick();
        }}
      >
        {size}
      </button>
    </Tooltip>
  );
}

/** The five pen presets, shown as a flyout from the pen button. */
export function BrushFlyout({ settings, onSettingsChange, onPick }: PanelProps & { onPick: () => void }) {
  return (
    <div className="flex flex-col gap-0.5" data-brush-flyout>
      {BRUSHES.map((brush) => {
        const Icon = BRUSH_ICONS[brush.id];
        const active = settings.brush === brush.id && settings.tool === 'pen';
        return (
          <button
            key={brush.id}
            type="button"
            aria-label={brush.label}
            aria-pressed={active}
            title={brush.hint}
            data-brush={brush.id}
            className={`inline-flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm transition-colors ${
              active
                ? 'bg-blue-600 text-white'
                : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800'
            }`}
            onClick={() => {
              onSettingsChange({ tool: 'pen', brush: brush.id });
              onPick();
            }}
          >
            <Icon size={18} strokeWidth={active ? 2.3 : 1.9} aria-hidden="true" />
            <span className="font-medium">{brush.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export const NEXT_ARROW: Record<ArrowheadMode, ArrowheadMode> = { none: 'end', end: 'both', both: 'none' };
export const ARROW_LABEL: Record<ArrowheadMode, string> = { none: 'No arrowheads', end: 'Arrow at the end', both: 'Arrows at both ends' };

/**
 * Dash pattern, arrowheads and snapping — for the *freehand* tools.
 *
 * The shape tool used to share these fields, which meant dashing a
 * construction line also dashed the next pen stroke. It keeps its own copies
 * now, in its own popover, and this panel says so rather than sitting there
 * greyed out with no explanation.
 */
export function StrokeOptions({ settings, onSettingsChange }: PanelProps) {
  const patterned = settings.tool === 'pen' || settings.tool === 'highlighter';
  return (
    <div className="flex w-[min(16rem,calc(100vw-2.5rem))] flex-col gap-1" data-stroke-options>
      <Row label="Line pattern">
        <select
          className={SELECT}
          aria-label="Line pattern"
          value={settings.pattern}
          disabled={!patterned}
          onChange={(e) => onSettingsChange({ pattern: e.target.value as StrokePattern })}
          data-pattern-select
        >
          {STROKE_PATTERNS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Arrowheads">
        <Chip
          active={settings.arrowheads !== 'none'}
          disabled={!patterned}
          label={ARROW_LABEL[settings.arrowheads]}
          onClick={() => onSettingsChange({ arrowheads: NEXT_ARROW[settings.arrowheads] })}
        >
          {settings.arrowheads === 'none' ? 'Off' : settings.arrowheads === 'end' ? 'End →' : 'Both ↔'}
        </Chip>
      </Row>
      <Row label="Snapping">
        <Chip active={settings.angleSnap} disabled={!patterned} label="Snap to 15 degrees" onClick={() => onSettingsChange({ angleSnap: !settings.angleSnap })}>
          15°
        </Chip>
        <Chip
          active={settings.holdToSnap}
          disabled={!patterned}
          label="Hold to snap to a shape"
          onClick={() => onSettingsChange({ holdToSnap: !settings.holdToSnap })}
        >
          Hold to snap
        </Chip>
      </Row>
      <p className="px-1 text-xs text-zinc-500 dark:text-zinc-400" data-stroke-options-note>
        Applies to the pen and highlighter. The shape tool keeps its own dash,
        arrowheads and snapping in its own settings.
      </p>
    </div>
  );
}
