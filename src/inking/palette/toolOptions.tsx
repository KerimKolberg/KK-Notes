import { useRef } from 'react';
import { Pipette } from 'lucide-react';
import { IconButton } from '../../ui/IconButton';
import { Row, Switch } from '../../ui/SettingsRow';
import {
  AXIS_LABEL_PRESETS,
  COLOR_PALETTE,
  DEFAULT_AXIS_STEP,
  MAX_AXIS_STEP,
  MIN_AXIS_STEP,
  MAX_CURVE_AMPLITUDE,
  MAX_CURVE_CYCLES,
  MAX_HIGHLIGHTER_OPACITY,
  MAX_HIGHLIGHTER_WIDTH,
  MIN_CURVE_AMPLITUDE,
  MAX_ERASER_SIZE,
  MIN_CURVE_CYCLES,
  MIN_ERASER_SIZE,
  MIN_HIGHLIGHTER_OPACITY,
  MIN_HIGHLIGHTER_WIDTH,
  MAX_WASHI_OPACITY,
  MAX_WASHI_WIDTH,
  MIN_WASHI_OPACITY,
  MIN_WASHI_WIDTH,
  STROKE_PATTERNS,
} from '../constants';
import { ERASE_FILTERS, filterIsActive } from '../engine/eraseFilter';
import { LASSO_MODES, type LassoMode } from '../engine/lasso';
import { LASSO_LAYERS, lassoFilterIsEmpty } from '../engine/lassoFilter';
import { formatTickValue } from '../engine/shapes';
import { TAPE_PATTERNS } from '../engine/tape';
import type { CoordinatePlaneConfig, EraserMode, GradientMode, StrokePattern, ToolSettings } from '../types';
import { CHIP, CHIP_ON, Chip, SELECT, WASHI_ACCENTS, type PanelProps, ARROW_LABEL, NEXT_ARROW } from './parts';

/**
 * The settings each tool opens from its palette button: line, lasso, highlighter, tape, eraser and coordinate plane.
 * What they share (chips, rows, the colour and width row) is in `parts.tsx`.
 */

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
        <Chip
          active={settings.lineGridSnap}
          label="Snap the ends to the page's grid"
          onClick={() => onSettingsChange({ lineGridSnap: !settings.lineGridSnap })}
        >
          <span data-line-grid-snap>Grid</span>
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
