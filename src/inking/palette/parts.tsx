import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Brush, Pen, PenLine, PenTool, Pencil, Pipette, type LucideIcon } from 'lucide-react';
import { IconButton } from '../../ui/IconButton';
import { Tooltip } from '../../ui/Tooltip';
import {
  AXIS_LABEL_PRESETS,
  COLOR_PALETTE,
  DEFAULT_AXIS_STEP,
  DEFAULT_STYLUS_SETTINGS,
  MAX_AXIS_STEP,
  MIN_AXIS_STEP,
  DEFAULT_WASHI_ACCENT,
  MAX_CURVE_AMPLITUDE,
  MAX_CURVE_CYCLES,
  MAX_HIGHLIGHTER_OPACITY,
  MAX_HIGHLIGHTER_WIDTH,
  MAX_STROKE_SIZE,
  MIN_CURVE_AMPLITUDE,
  MAX_ERASER_SIZE,
  MIN_CURVE_CYCLES,
  MIN_ERASER_SIZE,
  MIN_HIGHLIGHTER_OPACITY,
  MIN_HIGHLIGHTER_WIDTH,
  MAX_WASHI_OPACITY,
  MAX_WASHI_WIDTH,
  MIN_STROKE_SIZE,
  MIN_WASHI_OPACITY,
  MIN_WASHI_WIDTH,
  STROKE_PATTERNS,
  STYLUS_TOOLS,
} from '../constants';
import { ERASE_FILTERS, filterIsActive } from '../engine/eraseFilter';
import { LASSO_MODES, type LassoMode } from '../engine/lasso';
import { LASSO_LAYERS, lassoFilterIsEmpty } from '../engine/lassoFilter';
import { DEFAULT_PALETTE_ORDER, MAX_SWATCHES, MIN_SWATCHES, type PaletteDock } from '../../preferences/types';
import { DEFAULT_PREFERENCES, usePreferencesStore } from '../../preferences/store';
import { BARREL_CLICK_MS } from '../engine/barrelButton';
import { formatTickValue } from '../engine/shapes';
import { TAPE_PATTERNS } from '../engine/tape';
import { BRUSHES } from '../engine/brushes';
import type {
  ArrowheadMode,
  BrushId,
  CoordinatePlaneConfig,
  EraserEndAction,
  EraserMode,
  GradientMode,
  StrokePattern,
  ToolSettings,
  ToolType,
} from '../types';

/**
 * Tools a pen button can reach.
 *
 * Not every tool: the ones worth a hardware button are the ones you switch to
 * for a moment and back. The list lives in `constants` so that what the settings
 * offer and what a saved mapping is checked against are the same list.
 */
const BARREL_TOOLS = STYLUS_TOOLS;

/** How long a swatch must be held before it becomes editable, in ms. */
const SWATCH_HOLD_MS = 550;

/** Print colours offered for tape; white and black cover most real rolls. */
const WASHI_ACCENTS: readonly string[] = [DEFAULT_WASHI_ACCENT, '#1f1f24', '#fde68a', '#bfdbfe', '#fbcfe8'];

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

const CHIP =
  'inline-flex h-8 items-center justify-center rounded-lg px-2.5 text-xs font-medium transition-colors ' +
  'text-zinc-700 hover:bg-zinc-200 dark:text-zinc-200 dark:hover:bg-zinc-700 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500 disabled:opacity-40';
const CHIP_ON = 'bg-blue-600 text-white hover:bg-blue-600 dark:bg-blue-500 dark:text-white';

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

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-1 py-1">
      <span className="w-24 shrink-0 text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</span>
      <div className="flex flex-wrap items-center gap-1">{children}</div>
    </div>
  );
}

export function Switch({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800">
      <input
        type="checkbox"
        role="switch"
        className="h-4 w-4 accent-blue-600"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {children}
    </label>
  );
}

const SELECT =
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
 * every pixel of width is taken from the page: the same controls, stacked in a
 * column a little over five rems wide instead of laid out in a row that runs to
 * three hundred pixels.
 */
export function ToolConfigRow({ settings, onSettingsChange, compact = false }: PanelProps & { compact?: boolean }) {
  const colorInputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const laser = settings.tool === 'laser-pointer';
  const activeColor = laser ? settings.laserColor : settings.color;
  const colorDisabled = !usesColor(settings.tool) || (laser && settings.laserRainbow);
  const setColor = (color: string): void => onSettingsChange(laser ? { laserColor: color } : { color });

  const { swatches, setSwatch, addSwatch, removeSwatch } = usePreferencesStore(
    useShallow((s) => ({
      swatches: s.swatches,
      setSwatch: s.setSwatch,
      addSwatch: s.addSwatch,
      removeSwatch: s.removeSwatch,
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
        compact ? 'flex w-[5.25rem] flex-col items-stretch gap-2 px-2 py-2' : 'flex flex-wrap items-center gap-2 px-2 py-1.5'
      }`}
      data-tool-config
      {...(compact ? { 'data-compact': 'true' } : {})}
    >
      <div
        className={compact ? 'grid grid-cols-2 justify-items-center gap-1.5' : 'flex flex-wrap items-center gap-1'}
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
                className={`h-6 w-6 rounded-full ring-1 ring-black/15 transition-transform disabled:opacity-30 dark:ring-white/25 ${
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
          // On its own line beneath the colours: the button is wider than a swatch.
          {...(compact ? { className: 'col-span-2' } : {})}
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
            className={`rounded-lg bg-amber-100 px-1.5 py-0.5 dark:bg-amber-950/60 ${
              compact ? 'col-span-2 flex w-full flex-col items-start gap-0.5' : 'inline-flex items-center gap-1'
            }`}
            data-swatch-editor
          >
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
          </span>
        )}
      </div>

      <span
        className={compact ? 'h-px w-full bg-zinc-300 dark:bg-zinc-600' : 'mx-0.5 h-6 w-px bg-zinc-300 dark:bg-zinc-600'}
        aria-hidden="true"
      />

      <label className={compact ? 'flex min-w-0 flex-col gap-1.5' : 'flex min-w-0 flex-1 items-center gap-2'} title="Stroke thickness">
        <span className="sr-only">Stroke thickness</span>
        {/* Beside the slider in a row; above it in a column, where the slider needs the whole width. */}
        <span className={compact ? 'flex items-center justify-between gap-1' : 'contents'}>
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
            <span className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400" data-thickness-value>
              {settings.size}px
            </span>
          )}
        </span>
        <input
          type="range"
          className={`h-1 accent-blue-600 ${compact ? 'w-full min-w-0' : 'min-w-16 flex-1'}`}
          min={MIN_STROKE_SIZE}
          max={MAX_STROKE_SIZE}
          step={0.5}
          value={settings.size}
          aria-label="Stroke thickness"
          onChange={(e) => onSettingsChange({ size: Number(e.target.value) })}
          data-thickness
        />
        {!compact && (
          <span className="w-9 shrink-0 text-right text-xs tabular-nums text-zinc-500 dark:text-zinc-400" data-thickness-value>
            {settings.size}px
          </span>
        )}
      </label>

      {laser && (
        <Chip active={settings.laserRainbow} onClick={() => onSettingsChange({ laserRainbow: !settings.laserRainbow })} label="Rainbow laser">
          <span data-laser-rainbow>Rainbow</span>
        </Chip>
      )}
    </div>
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

const NEXT_ARROW: Record<ArrowheadMode, ArrowheadMode> = { none: 'end', end: 'both', both: 'none' };
const ARROW_LABEL: Record<ArrowheadMode, string> = { none: 'No arrowheads', end: 'Arrow at the end', both: 'Arrows at both ends' };

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

const CURVES: readonly { readonly id: ToolSettings['lineCurve']; readonly label: string; readonly hint: string }[] = [
  { id: 'straight', label: 'Straight', hint: 'A plain segment between the two ends of the drag' },
  { id: 'parabola', label: 'Parabola', hint: 'A quadratic Bézier bowed out from the midpoint' },
  { id: 'wave', label: 'Wave', hint: 'A sine wave laid along the drag' },
  { id: 'zigzag', label: 'Zigzag', hint: 'Sharp alternating peaks along the drag' },
];

/**
 * Everything the line tool draws with: which path the drag lays down, how it
 * is dashed, and the aids that go with it. The pattern lives here rather than
 * only in the shared stroke options because choosing a dotted line is part of
 * choosing a line, not a separate errand.
 */
export function LineOptions({ settings, onSettingsChange }: PanelProps) {
  const curved = settings.lineCurve !== 'straight';
  const periodic = settings.lineCurve === 'wave' || settings.lineCurve === 'zigzag';
  return (
    <div className="flex w-[min(19rem,calc(100vw-2.5rem))] flex-col gap-1" data-line-options>
      <Row label="Path">
        {CURVES.map((curve) => (
          <Chip
            key={curve.id}
            active={settings.lineCurve === curve.id}
            label={curve.hint}
            onClick={() => onSettingsChange({ lineCurve: curve.id })}
          >
            <span data-line-curve={curve.id}>{curve.label}</span>
          </Chip>
        ))}
      </Row>
      <Row label="Line pattern">
        <select
          className={SELECT}
          aria-label="Line pattern"
          value={settings.linePattern}
          onChange={(e) => onSettingsChange({ linePattern: e.target.value as StrokePattern })}
          data-line-pattern-select
        >
          {STROKE_PATTERNS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <Chip
          active={settings.lineArrowheads !== 'none'}
          label={ARROW_LABEL[settings.lineArrowheads]}
          onClick={() => onSettingsChange({ lineArrowheads: NEXT_ARROW[settings.lineArrowheads] })}
        >
          {settings.lineArrowheads === 'none' ? 'No arrow' : settings.lineArrowheads === 'end' ? 'End →' : 'Both ↔'}
        </Chip>
      </Row>
      <Row label="Depth">
        <input
          type="range"
          className="h-1 w-28 accent-blue-600 disabled:opacity-40"
          min={MIN_CURVE_AMPLITUDE}
          max={MAX_CURVE_AMPLITUDE}
          step={0.01}
          disabled={!curved}
          value={settings.curveAmplitude}
          aria-label="Curve depth"
          onChange={(e) => onSettingsChange({ curveAmplitude: Number(e.target.value) })}
          data-curve-amplitude
        />
        <Chip active={settings.curveFlip} disabled={!curved} label="Mirror the curve" onClick={() => onSettingsChange({ curveFlip: !settings.curveFlip })}>
          Flip
        </Chip>
      </Row>
      <Row label="Cycles">
        <input
          type="number"
          className={`${SELECT} w-16 disabled:opacity-40`}
          min={MIN_CURVE_CYCLES}
          max={MAX_CURVE_CYCLES}
          step={1}
          disabled={!periodic}
          value={settings.curveCycles}
          aria-label="Curve cycles"
          onChange={(e) => {
            const value = Math.round(Number(e.target.value));
            if (Number.isFinite(value)) {
              onSettingsChange({ curveCycles: Math.min(MAX_CURVE_CYCLES, Math.max(MIN_CURVE_CYCLES, value)) });
            }
          }}
          data-curve-cycles
        />
        <Chip
          active={settings.lineAngleSnap}
          label="Snap to 15 degrees"
          onClick={() => onSettingsChange({ lineAngleSnap: !settings.lineAngleSnap })}
        >
          15°
        </Chip>
      </Row>
      <p className="px-1 text-xs text-zinc-500 dark:text-zinc-400" data-line-options-note>
        These belong to the shape tool alone; the pen and highlighter keep
        their own.
      </p>
    </div>
  );
}

const LASSO_MODE_HINT: Readonly<Record<LassoMode, string>> = {
  enclose: 'Only strokes that fall completely inside the loop',
  touch: 'Anything the loop crosses — draw a line through it to select it',
};

/**
 * What the lasso is hunting for: which layers it may pick up, and how much of
 * a stroke it has to catch.
 *
 * The layers are switches rather than a single choice because a page is
 * layered: "the writing but not the highlighting I drew over it" is a real
 * request and a one-of-four picker cannot say it. Clearing all four leaves
 * the lasso with nothing to find, which the panel says outright rather than
 * quietly re-including a layer that was just switched off.
 */
export function LassoOptions({ settings, onSettingsChange }: PanelProps) {
  const filter = settings.lassoFilter;
  const empty = lassoFilterIsEmpty(filter);
  return (
    <div className="flex w-[min(19rem,calc(100vw-2.5rem))] flex-col gap-1" data-lasso-options>
      <Row label="Select">
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Selectable layers">
          {LASSO_LAYERS.map((layer) => (
            <Chip
              key={layer.key}
              active={filter[layer.key]}
              label={layer.hint}
              onClick={() => onSettingsChange({ lassoFilter: { ...filter, [layer.key]: !filter[layer.key] } })}
            >
              <span data-lasso-layer={layer.key}>{layer.label}</span>
            </Chip>
          ))}
        </div>
      </Row>
      <Row label="Catches">
        <div className="flex flex-wrap items-center gap-1" role="radiogroup" aria-label="Selection mode">
          {LASSO_MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              role="radio"
              aria-checked={settings.lassoMode === mode.id}
              aria-label={LASSO_MODE_HINT[mode.id]}
              data-lasso-mode={mode.id}
              className={`${CHIP} ${settings.lassoMode === mode.id ? CHIP_ON : ''}`}
              onClick={() => onSettingsChange({ lassoMode: mode.id })}
            >
              {mode.label}
            </button>
          ))}
        </div>
      </Row>
      <p className="px-1 text-xs text-zinc-500 dark:text-zinc-400" data-lasso-note>
        {empty
          ? 'Nothing is selectable: switch at least one layer back on.'
          : settings.lassoMode === 'touch'
            ? 'A stroke counts the moment the loop crosses it, so a line dragged through something selects it.'
            : 'A stroke counts only when all of it is inside the loop.'}
      </p>
    </div>
  );
}

const GRADIENTS: readonly { readonly id: 'none' | GradientMode; readonly label: string; readonly hint: string }[] = [
  { id: 'none', label: 'Flat', hint: 'One colour along the whole stroke' },
  { id: 'rainbow', label: 'Rainbow', hint: 'A full hue sweep along the stroke' },
  { id: 'dual', label: 'Two colours', hint: 'Fades from the stroke colour into a second one' },
];

/**
 * The highlighter's own settings, opened by pressing its button a second time
 * — the same gesture as the pen's brushes and the tape's patterns.
 *
 * Width lives here rather than on the shared thickness slider because a
 * highlighter is tens of pixels wide where a pen is a few, and sharing one
 * range would leave both ends of it useless. The gradient is mapped across the
 * finished stroke's bounding box, so it reads as one sweep from end to end
 * however the stroke doubles back on itself.
 */
export function HighlighterOptions({ settings, onSettingsChange }: PanelProps) {
  const toRef = useRef<HTMLInputElement>(null);
  const dual = settings.highlighterGradient === 'dual';
  return (
    <div className="flex w-[min(19rem,calc(100vw-2.5rem))] flex-col gap-1" data-highlighter-options>
      <Row label="Width">
        <input
          type="range"
          className="h-1 w-32 accent-blue-600"
          min={MIN_HIGHLIGHTER_WIDTH}
          max={MAX_HIGHLIGHTER_WIDTH}
          step={1}
          value={settings.highlighterWidth}
          aria-label="Highlighter width"
          onChange={(e) => onSettingsChange({ highlighterWidth: Number(e.target.value) })}
          data-highlighter-width
        />
        <span className="w-10 text-right text-xs tabular-nums text-zinc-500 dark:text-zinc-400" data-highlighter-width-value>
          {Math.round(settings.highlighterWidth)}px
        </span>
      </Row>
      <Row label="Opacity">
        <input
          type="range"
          className="h-1 w-32 accent-blue-600"
          min={MIN_HIGHLIGHTER_OPACITY}
          max={MAX_HIGHLIGHTER_OPACITY}
          step={0.05}
          value={settings.highlighterOpacity}
          aria-label="Highlighter heaviness"
          onChange={(e) => onSettingsChange({ highlighterOpacity: Number(e.target.value) })}
          data-highlighter-opacity
        />
        <span className="w-10 text-right text-xs tabular-nums text-zinc-500 dark:text-zinc-400" data-highlighter-opacity-value>
          {Math.round(settings.highlighterOpacity * 100)}%
        </span>
      </Row>
      <Row label="Gradient">
        {GRADIENTS.map((gradient) => (
          <Chip
            key={gradient.id}
            active={settings.highlighterGradient === gradient.id}
            label={gradient.hint}
            onClick={() => onSettingsChange({ highlighterGradient: gradient.id })}
          >
            <span data-highlighter-gradient={gradient.id}>{gradient.label}</span>
          </Chip>
        ))}
      </Row>
      <Row label="Fades into">
        {COLOR_PALETTE.slice(0, 6).map((color) => (
          <button
            key={color}
            type="button"
            aria-label={`Fade into ${color}`}
            aria-pressed={settings.highlighterGradientTo.toLowerCase() === color.toLowerCase()}
            disabled={!dual}
            data-highlighter-gradient-to={color}
            className={`h-6 w-6 rounded-full ring-1 ring-black/15 disabled:opacity-30 dark:ring-white/25 ${
              settings.highlighterGradientTo.toLowerCase() === color.toLowerCase() ? 'outline-2 outline-offset-2 outline-blue-500' : ''
            }`}
            style={{ background: color }}
            onClick={() => onSettingsChange({ highlighterGradientTo: color })}
          />
        ))}
        <IconButton
          icon={Pipette}
          label="Custom second colour"
          size="sm"
          disabled={!dual}
          onClick={() => toRef.current?.click()}
        />
        <input
          ref={toRef}
          type="color"
          className="sr-only"
          aria-label="Custom second colour value"
          value={settings.highlighterGradientTo.length === 7 ? settings.highlighterGradientTo : '#22d3ee'}
          disabled={!dual}
          onChange={(e) => onSettingsChange({ highlighterGradientTo: e.target.value })}
        />
      </Row>
      <div
        className="mx-1 mb-1 h-3 rounded-full"
        aria-hidden="true"
        data-highlighter-preview
        style={{
          background:
            settings.highlighterGradient === 'rainbow'
              ? 'linear-gradient(90deg, hsl(0 90% 55%), hsl(60 90% 55%), hsl(120 90% 55%), hsl(180 90% 55%), hsl(240 90% 55%), hsl(300 90% 55%), hsl(360 90% 55%))'
              : settings.highlighterGradient === 'dual'
                ? `linear-gradient(90deg, ${settings.color}, ${settings.highlighterGradientTo})`
                : settings.color,
          opacity: settings.highlighterOpacity,
        }}
      />
    </div>
  );
}

/** Washi tape: how wide the strip is, how see-through, and what is printed on it. */
export function WashiOptions({ settings, onSettingsChange }: PanelProps) {
  return (
    <div className="flex w-[min(19rem,calc(100vw-2.5rem))] flex-col gap-1" data-washi-options>
      <Row label="Pattern">
        {TAPE_PATTERNS.map((pattern) => (
          <Chip
            key={pattern.id}
            active={settings.washiPattern === pattern.id}
            label={`${pattern.label} tape`}
            onClick={() => onSettingsChange({ washiPattern: pattern.id })}
          >
            <span data-washi-pattern={pattern.id}>{pattern.label}</span>
          </Chip>
        ))}
      </Row>
      <Row label="Width">
        <input
          type="range"
          className="h-1 w-32 accent-blue-600"
          min={MIN_WASHI_WIDTH}
          max={MAX_WASHI_WIDTH}
          step={1}
          value={settings.washiWidth}
          aria-label="Tape width"
          onChange={(e) => onSettingsChange({ washiWidth: Number(e.target.value) })}
          data-washi-width
        />
        <span className="w-10 text-right text-xs tabular-nums text-zinc-500 dark:text-zinc-400">{Math.round(settings.washiWidth)}px</span>
      </Row>
      <Row label="Opacity">
        <input
          type="range"
          className="h-1 w-32 accent-blue-600"
          min={MIN_WASHI_OPACITY}
          max={MAX_WASHI_OPACITY}
          step={0.05}
          value={settings.washiOpacity}
          aria-label="Tape opacity"
          onChange={(e) => onSettingsChange({ washiOpacity: Number(e.target.value) })}
          data-washi-opacity
        />
        <span className="w-10 text-right text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
          {Math.round(settings.washiOpacity * 100)}%
        </span>
      </Row>
      <Row label="Print colour">
        {WASHI_ACCENTS.map((accent) => (
          <button
            key={accent}
            type="button"
            aria-label={`Tape print colour ${accent}`}
            aria-pressed={settings.washiAccent.toLowerCase() === accent.toLowerCase()}
            data-washi-accent={accent}
            className={`h-6 w-6 rounded-full ring-1 ring-black/15 dark:ring-white/25 ${
              settings.washiAccent.toLowerCase() === accent.toLowerCase() ? 'outline-2 outline-offset-2 outline-blue-500' : ''
            }`}
            style={{ background: accent }}
            onClick={() => onSettingsChange({ washiAccent: accent })}
          />
        ))}
      </Row>
      <Row label="Shape">
        <Chip
          active={settings.washiStraighten}
          label="Straighten the strip"
          onClick={() => onSettingsChange({ washiStraighten: !settings.washiStraighten })}
        >
          <span data-washi-straighten>Straighten lines</span>
        </Chip>
      </Row>
    </div>
  );
}

export interface EraserOptionsProps extends PanelProps {
  onClearPage: () => void;
  onClearDocument: () => void;
}

const ERASER_MODES: readonly { readonly id: EraserMode; readonly label: string; readonly hint: string }[] = [
  { id: 'stroke', label: 'Stroke eraser', hint: 'Removes a whole stroke the moment the eraser crosses it' },
  { id: 'area', label: 'Area eraser', hint: 'Removes only the path you sweep over' },
];

/**
 * Everything the one eraser button does: which of the two erasers it is, how
 * wide the area one cuts, what either is allowed to take, and the two bulk
 * removals. The filters scope the clears as well, so "highlighter only" plus
 * "clear this page" strips the highlighting off a page and leaves the writing.
 */
export function EraserOptions({ settings, onSettingsChange, onClearPage, onClearDocument }: EraserOptionsProps) {
  const area = settings.eraserMode === 'area';
  const filtered = filterIsActive(settings.eraseFilter);
  return (
    <div className="flex w-[min(20rem,calc(100vw-2.5rem))] flex-col gap-1" data-eraser-options>
      <Row label="Eraser">
        <div className="flex flex-wrap items-center gap-1" role="radiogroup" aria-label="Eraser mode">
          {ERASER_MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              role="radio"
              aria-checked={settings.eraserMode === mode.id}
              aria-label={mode.hint}
              data-eraser-mode={mode.id}
              className={`${CHIP} ${settings.eraserMode === mode.id ? CHIP_ON : ''}`}
              // Switching mode switches the live tool too: the button in the
              // palette is already the eraser, so the choice has to take now.
              onClick={() => onSettingsChange({ eraserMode: mode.id, tool: mode.id === 'area' ? 'eraser-pixel' : 'eraser-stroke' })}
            >
              {mode.label}
            </button>
          ))}
        </div>
      </Row>
      <Row label="Area size">
        <input
          type="range"
          className="h-1 w-32 accent-blue-600 disabled:opacity-40"
          min={MIN_ERASER_SIZE}
          max={MAX_ERASER_SIZE}
          step={1}
          disabled={!area}
          value={settings.eraserSize}
          aria-label="Area eraser size"
          onChange={(e) => onSettingsChange({ eraserSize: Number(e.target.value) })}
          data-eraser-size
        />
        <span className={`w-10 text-right text-xs tabular-nums ${area ? 'text-zinc-500 dark:text-zinc-400' : 'text-zinc-400 dark:text-zinc-600'}`}>
          {Math.round(settings.eraserSize)}px
        </span>
      </Row>
      {!area && (
        <p className="px-1 text-xs text-zinc-500 dark:text-zinc-400" data-stroke-eraser-note>
          The stroke eraser has no size: it lifts whole strokes, so it is a
          fine point that takes the one line you touch and not its neighbours.
        </p>
      )}
      <Row label="Only erase">
        {ERASE_FILTERS.map((option) => (
          <Chip
            key={option.key}
            active={settings.eraseFilter[option.key]}
            label={option.hint}
            onClick={() =>
              onSettingsChange({ eraseFilter: { ...settings.eraseFilter, [option.key]: !settings.eraseFilter[option.key] } })
            }
          >
            <span data-erase-filter={option.key}>{option.label}</span>
          </Chip>
        ))}
      </Row>
      {filtered && (
        <p className="px-1 text-xs text-zinc-500 dark:text-zinc-400" data-erase-filter-note>
          Both erasers pass straight over everything else. Narrowed, the area
          eraser lifts whole matching strokes rather than cutting them.
        </p>
      )}
      <div className="mt-1 border-t border-zinc-200 pt-1 dark:border-zinc-700">
        <p className="px-1 pb-1 text-xs text-zinc-500 dark:text-zinc-400">
          Removes {filtered ? 'the ink selected above' : 'all ink'}. Images, notes and tables are left alone.
        </p>
        <button
          type="button"
          className="inline-flex h-8 w-full items-center justify-center rounded-lg px-2 text-xs font-medium text-rose-600 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-950/50"
          onClick={onClearPage}
          data-clear-page-ink
        >
          Clear this page
        </button>
        <button
          type="button"
          className="inline-flex h-8 w-full items-center justify-center rounded-lg px-2 text-xs font-medium text-rose-600 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-950/50"
          onClick={onClearDocument}
          data-clear-document-ink
        >
          Clear every page
        </button>
      </div>
    </div>
  );
}

function presetIndex(plane: CoordinatePlaneConfig): number {
  return AXIS_LABEL_PRESETS.findIndex((p) => p.x === plane.xLabel && p.y === plane.yLabel);
}

/**
 * A typed step, kept usable. An empty or half-typed field ("0.", "-") reads
 * as NaN, which would wipe the plane's numbering while the user is still
 * typing, so it falls back to whole cells instead.
 */
function clampStep(raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_AXIS_STEP;
  return Math.min(MAX_AXIS_STEP, Math.max(MIN_AXIS_STEP, value));
}

/** The first few x ticks as they would actually print, for the hint line. */
function tickPreview(plane: CoordinatePlaneConfig): string {
  const step = plane.stepX ?? DEFAULT_AXIS_STEP;
  return [1, 2, 3].map((i) => formatTickValue(i, step)).join(', ');
}

/** Quadrants, divisions, grid and axis labels for the coordinate plane tool. */
export function PlaneOptions({ settings, onSettingsChange }: PanelProps) {
  const plane = settings.coordinatePlane;
  const patch = (next: Partial<CoordinatePlaneConfig>): void =>
    onSettingsChange({ coordinatePlane: { ...plane, ...next } });
  return (
    <div className="flex w-[min(18rem,calc(100vw-2.5rem))] flex-col gap-1" data-plane-options>
      <Row label="Quadrants">
        <Chip active={plane.mode === 'quadrant-1'} onClick={() => patch({ mode: 'quadrant-1' })}>
          Quadrant I
        </Chip>
        <Chip active={plane.mode === 'four-quadrant'} onClick={() => patch({ mode: 'four-quadrant' })}>
          All four
        </Chip>
      </Row>
      <Row label="Divisions">
        <input
          type="number"
          className={`${SELECT} w-16`}
          min={1}
          max={20}
          step={1}
          aria-label="Divisions per half axis"
          value={plane.divisions}
          onChange={(e) => {
            const value = Math.round(Number(e.target.value));
            if (Number.isFinite(value)) patch({ divisions: Math.min(20, Math.max(1, value)) });
          }}
        />
        <Switch checked={plane.showGrid} onChange={(v) => patch({ showGrid: v })}>
          Grid
        </Switch>
        <Switch checked={plane.tickLabels} onChange={(v) => patch({ tickLabels: v })}>
          Numbers
        </Switch>
      </Row>
      <Row label="Step per cell">
        <input
          type="number"
          className={`${SELECT} w-20`}
          min={MIN_AXIS_STEP}
          max={MAX_AXIS_STEP}
          step="any"
          aria-label="Horizontal step size"
          data-plane-step-x
          value={plane.stepX ?? DEFAULT_AXIS_STEP}
          onChange={(e) => patch({ stepX: clampStep(e.target.value) })}
        />
        <input
          type="number"
          className={`${SELECT} w-20`}
          min={MIN_AXIS_STEP}
          max={MAX_AXIS_STEP}
          step="any"
          aria-label="Vertical step size"
          data-plane-step-y
          value={plane.stepY ?? DEFAULT_AXIS_STEP}
          onChange={(e) => patch({ stepY: clampStep(e.target.value) })}
        />
      </Row>
      <p className="px-1 text-xs text-zinc-500 dark:text-zinc-400" data-plane-step-note>
        What one grid cell is worth, whole or fractional. The plane is drawn
        the same either way; only the numbers change — these ticks read{' '}
        <span className="tabular-nums" data-plane-step-preview>
          {tickPreview(plane)}…
        </span>
      </p>
      <Row label="Axis labels">
        <select
          className={SELECT}
          aria-label="Axis label preset"
          value={presetIndex(plane)}
          onChange={(e) => {
            const preset = AXIS_LABEL_PRESETS[Number(e.target.value)];
            if (preset) patch({ xLabel: preset.x, yLabel: preset.y });
          }}
        >
          <option value={-1} disabled>
            Custom
          </option>
          {AXIS_LABEL_PRESETS.map((preset, i) => (
            <option key={`${preset.x}/${preset.y}`} value={i}>
              {preset.x} / {preset.y}
            </option>
          ))}
        </select>
      </Row>
      <Row label="x / y">
        <input
          type="text"
          className={`${SELECT} w-20`}
          maxLength={12}
          aria-label="Horizontal axis label"
          value={plane.xLabel}
          onChange={(e) => patch({ xLabel: e.target.value })}
        />
        <input
          type="text"
          className={`${SELECT} w-20`}
          maxLength={12}
          aria-label="Vertical axis label"
          value={plane.yLabel}
          onChange={(e) => patch({ yLabel: e.target.value })}
        />
      </Row>
    </div>
  );
}

export interface PaletteSettingsProps extends PanelProps {
  onClear: () => void;
  /** True while the palette's icons can be dragged into a new order. */
  arranging?: boolean;
  onArrangingChange?: (value: boolean) => void;
}

const DOCK_CHOICES: readonly { readonly dock: PaletteDock; readonly label: string }[] = [
  { dock: 'bottom', label: 'Bottom' },
  { dock: 'top', label: 'Top' },
  { dock: 'left', label: 'Left' },
  { dock: 'right', label: 'Right' },
  { dock: 'free', label: 'Free' },
];

/** The names Windows gives the bits of `PointerEvent.buttons`, for a pen. */
function describePenButtons(buttons: number): string {
  if (buttons === 0) return 'no button';
  const names: string[] = [];
  if (buttons & 1) names.push('pen tip (1)');
  if (buttons & 2) names.push('barrel button (2)');
  if (buttons & 32) names.push('second button / eraser (32)');
  if (buttons & ~(1 | 2 | 32)) names.push(`other (${buttons & ~(1 | 2 | 32)})`);
  return names.join(' + ');
}

/**
 * Which button the pen is reporting, live.
 *
 * Two-button pens disagree about which physical button is which — Windows sends
 * one as the barrel and the other as the eraser — and a mapping cannot be set up
 * by guessing. This shows what the pen actually says when a button is pressed, so
 * the two dropdowns above can be matched to the two buttons under the thumb.
 *
 * Listens only while the settings are open, and only re-renders when the reported
 * buttons change, not on every hover move.
 */
function PenButtonTest(): React.JSX.Element {
  const [buttons, setButtons] = useState<number | null>(null);
  useEffect(() => {
    const onPen = (e: PointerEvent): void => {
      if (e.pointerType !== 'pen') return;
      setButtons((current) => (current === e.buttons ? current : e.buttons));
    };
    // Capture, so it sees the event even if the page underneath handles it.
    window.addEventListener('pointermove', onPen, true);
    window.addEventListener('pointerdown', onPen, true);
    window.addEventListener('pointerup', onPen, true);
    return () => {
      window.removeEventListener('pointermove', onPen, true);
      window.removeEventListener('pointerdown', onPen, true);
      window.removeEventListener('pointerup', onPen, true);
    };
  }, []);
  return (
    <div className="rounded-lg bg-zinc-100 px-2 py-1.5 text-xs dark:bg-zinc-800" data-pen-button-test>
      <div className="font-medium text-zinc-700 dark:text-zinc-200">Pen button test</div>
      <div className="text-zinc-500 dark:text-zinc-400" data-pen-buttons>
        {buttons === null
          ? 'Hold the pen just above the screen and press a button.'
          : `The pen reports: ${describePenButtons(buttons)}`}
      </div>
    </div>
  );
}

/** Input settings that are not a tool: touch drawing, stylus buttons, layout, clear. */
export function PaletteSettings({
  settings,
  onSettingsChange,
  onClear,
  arranging = false,
  onArrangingChange,
}: PaletteSettingsProps) {
  const {
    paletteOrder,
    swatches,
    pageDefaults,
    resetPreferences,
    paletteDock,
    setPaletteDock,
    palettePinned,
    lowLatencyInk,
    setLowLatencyInk,
  } = usePreferencesStore(
    useShallow((s) => ({
      paletteOrder: s.paletteOrder,
      swatches: s.swatches,
      pageDefaults: s.pageDefaults,
      resetPreferences: s.resetPreferences,
      paletteDock: s.paletteDock,
      setPaletteDock: s.setPaletteDock,
      palettePinned: s.palettePinned,
      lowLatencyInk: s.lowLatencyInk,
      setLowLatencyInk: s.setLowLatencyInk,
    })),
  );
  // Subscribed rather than read once, so the button enables itself the moment
  // something is customised rather than on the next unrelated re-render.
  const customised =
    pageDefaults !== null ||
    paletteOrder.join() !== DEFAULT_PALETTE_ORDER.join() ||
    swatches.join() !== DEFAULT_PREFERENCES.swatches.join() ||
    paletteDock !== DEFAULT_PREFERENCES.paletteDock ||
    palettePinned !== DEFAULT_PREFERENCES.palettePinned ||
    lowLatencyInk !== DEFAULT_PREFERENCES.lowLatencyInk ||
    JSON.stringify(settings.stylus) !== JSON.stringify(DEFAULT_STYLUS_SETTINGS);
  return (
    // Scrolls instead of growing: this panel has more in it than a tablet in
    // landscape has height, and a panel taller than the screen cuts off its own
    // first rows with no way to reach them. The cap leaves room for the top bar
    // above and the toolbar it opened from.
    <div
      className="flex max-h-[calc(100dvh-12rem)] w-[min(18rem,calc(100vw-2.5rem))] flex-col gap-1 overflow-y-auto overscroll-contain pr-1"
      data-palette-settings
    >
      <Row label="Finger input">
        <Switch checked={settings.touchDraw} onChange={(v) => onSettingsChange({ touchDraw: v })}>
          Touch Draw
        </Switch>
      </Row>
      {/* One button, two gestures: a click swaps tools and leaves them
          swapped, a hold borrows one for as long as it is held. They are
          configured separately because they answer different needs. */}
      <Row label="Barrel click">
        <select
          className={SELECT}
          aria-label="Barrel click, first tool"
          data-barrel-click-a
          value={settings.stylus.clickToggle[0]}
          onChange={(e) =>
            onSettingsChange({
              stylus: { ...settings.stylus, clickToggle: [e.target.value as ToolType, settings.stylus.clickToggle[1]] },
            })
          }
        >
          {BARREL_TOOLS.map((tool) => (
            <option key={tool.id} value={tool.id}>
              {tool.label}
            </option>
          ))}
        </select>
        <span className="text-xs text-zinc-400 dark:text-zinc-500" aria-hidden="true">
          ⇄
        </span>
        <select
          className={SELECT}
          aria-label="Barrel click, second tool"
          data-barrel-click-b
          value={settings.stylus.clickToggle[1]}
          onChange={(e) =>
            onSettingsChange({
              stylus: { ...settings.stylus, clickToggle: [settings.stylus.clickToggle[0], e.target.value as ToolType] },
            })
          }
        >
          {BARREL_TOOLS.map((tool) => (
            <option key={tool.id} value={tool.id}>
              {tool.label}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Barrel hold">
        <select
          className={SELECT}
          aria-label="Barrel hold"
          data-barrel-hold
          value={settings.stylus.holdTool}
          onChange={(e) => onSettingsChange({ stylus: { ...settings.stylus, holdTool: e.target.value as ToolType } })}
        >
          {BARREL_TOOLS.map((tool) => (
            <option key={tool.id} value={tool.id}>
              {tool.label}
            </option>
          ))}
        </select>
      </Row>
      <p className="px-1 text-xs text-zinc-500 dark:text-zinc-400" data-barrel-note>
        A quick press swaps between the first pair and stays there. Holding the
        button past {BARREL_CLICK_MS} ms borrows the second tool until you let
        go.
      </p>
      <Row label="Second button">
        <select
          className={SELECT}
          aria-label="Second button, held"
          data-second-button
          value={settings.stylus.eraserEnd}
          onChange={(e) => onSettingsChange({ stylus: { ...settings.stylus, eraserEnd: e.target.value as EraserEndAction } })}
        >
          {BARREL_TOOLS.map((tool) => (
            <option key={tool.id} value={tool.id}>
              {tool.label}
            </option>
          ))}
        </select>
      </Row>
      <p className="px-1 text-xs text-zinc-500 dark:text-zinc-400" data-second-button-note>
        The pen&rsquo;s other button (or eraser end), held while you draw. If
        the two buttons come out the wrong way round, swap them here.
      </p>
      <PenButtonTest />
      <Row label="Toolbar">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Toolbar position">
          {DOCK_CHOICES.map((choice) => (
            <button
              key={choice.dock}
              type="button"
              aria-pressed={paletteDock === choice.dock}
              data-palette-dock-choice={choice.dock}
              className={`h-7 rounded-md px-2 text-xs font-medium ${
                paletteDock === choice.dock
                  ? 'bg-blue-600 text-white dark:bg-blue-500'
                  : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700'
              }`}
              onClick={() => setPaletteDock(choice.dock)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      </Row>
      <p className="px-1 text-xs text-zinc-500 dark:text-zinc-400" data-dock-note>
        Or drag it by its handle and push it against an edge. The pin beside the
        handle keeps it on screen; unpinned, it hides when idle and comes back
        from the tab on its edge.
      </p>
      <Row label="Low-latency ink">
        <Switch checked={lowLatencyInk} onChange={setLowLatencyInk}>
          <span data-low-latency-ink>Experimental</span>
        </Switch>
      </Row>
      <p className="px-1 text-xs text-zinc-500 dark:text-zinc-400" data-low-latency-note>
        Can save up to a frame of pen lag, but on some Windows GPUs (a ROG Flow
        Z13 was one) it turns every page dark and makes the cursor blink in
        fullscreen. Off by default; if pages go dark, switch it back off.
      </p>
      <Row label="Diagnostics">
        <Switch checked={settings.debugMode} onChange={(v) => onSettingsChange({ debugMode: v })}>
          <span data-debug-mode>Debug mode</span>
        </Switch>
      </Row>
      {settings.debugMode && (
        <p className="px-1 text-xs text-zinc-500 dark:text-zinc-400" data-debug-mode-note>
          Shows frame rate, ink latency and React commit times in the corner.
          Nothing is measured while this is off; switching it back on clears
          the counters.
        </p>
      )}
      {onArrangingChange && (
        <>
          <Row label="Palette layout">
            <Switch checked={arranging} onChange={onArrangingChange}>
              <span data-palette-arrange>Arrange icons</span>
            </Switch>
          </Row>
          {arranging && (
            <p className="px-1 text-xs text-zinc-500 dark:text-zinc-400" data-palette-arrange-note>
              Drag the tool icons into the order you want. They stay where you
              put them next time. Pressing one picks it up rather than
              selecting it, so switch this back off when you are done.
            </p>
          )}
        </>
      )}

      <div className="mt-1 border-t border-zinc-200 pt-1 dark:border-zinc-700">
        <button
          type="button"
          aria-label="Clear page"
          className="inline-flex h-8 w-full items-center justify-center rounded-lg px-2 text-xs font-medium text-rose-600 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-950/50"
          onClick={onClear}
          data-clear-page
        >
          Clear page
        </button>
        <button
          type="button"
          aria-label="Reset customisations to defaults"
          disabled={!customised}
          className="inline-flex h-8 w-full items-center justify-center rounded-lg px-2 text-xs font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
          onClick={() => {
            if (window.confirm('Reset the toolbar, pen buttons, quick colours and page defaults?')) {
              resetPreferences();
              // The live tool settings hold their own copy of the pen mapping.
              onSettingsChange({ stylus: DEFAULT_STYLUS_SETTINGS });
              onArrangingChange?.(false);
            }
          }}
          data-reset-preferences
        >
          Reset to defaults
        </button>
        <p className="px-1 pt-0.5 text-center text-[11px] text-zinc-400 dark:text-zinc-500">
          {customised ? 'Clears the toolbar position, pen buttons, colours, tool order and page defaults.' : 'Nothing has been customised yet.'}
        </p>
      </div>
    </div>
  );
}
