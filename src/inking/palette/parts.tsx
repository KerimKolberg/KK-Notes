import type { ReactNode } from 'react';
import { Brush, Pen, PenLine, PenTool, Pencil, type LucideIcon } from 'lucide-react';
import { AXIS_LABEL_PRESETS, STROKE_PATTERNS } from '../constants';
import { BRUSHES } from '../engine/brushes';
import type {
  ArrowheadMode,
  BarrelButtonAction,
  BrushId,
  CoordinatePlaneConfig,
  EraserEndAction,
  StrokePattern,
  ToolSettings,
} from '../types';

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

/** Dash pattern, arrowheads and the two snapping aids. */
export function StrokeOptions({ settings, onSettingsChange }: PanelProps) {
  const patterned = settings.tool === 'pen' || settings.tool === 'highlighter' || settings.tool === 'line';
  return (
    <div className="flex w-64 flex-col gap-1" data-stroke-options>
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
          disabled={settings.tool !== 'pen' && settings.tool !== 'highlighter'}
          label="Hold to snap to a shape"
          onClick={() => onSettingsChange({ holdToSnap: !settings.holdToSnap })}
        >
          Hold to snap
        </Chip>
      </Row>
    </div>
  );
}

function presetIndex(plane: CoordinatePlaneConfig): number {
  return AXIS_LABEL_PRESETS.findIndex((p) => p.x === plane.xLabel && p.y === plane.yLabel);
}

/** Quadrants, divisions, grid and axis labels for the coordinate plane tool. */
export function PlaneOptions({ settings, onSettingsChange }: PanelProps) {
  const plane = settings.coordinatePlane;
  const patch = (next: Partial<CoordinatePlaneConfig>): void =>
    onSettingsChange({ coordinatePlane: { ...plane, ...next } });
  return (
    <div className="flex w-72 flex-col gap-1" data-plane-options>
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

/** Input settings that are not a tool: touch drawing, stylus buttons, clear. */
export function PaletteSettings({
  settings,
  onSettingsChange,
  onClear,
}: PanelProps & { onClear: () => void }) {
  return (
    <div className="flex w-72 flex-col gap-1" data-palette-settings>
      <Row label="Finger input">
        <Switch checked={settings.touchDraw} onChange={(v) => onSettingsChange({ touchDraw: v })}>
          Touch Draw
        </Switch>
      </Row>
      <Row label="Barrel button">
        <select
          className={SELECT}
          aria-label="Barrel button"
          value={settings.stylus.barrelButton}
          onChange={(e) => onSettingsChange({ stylus: { ...settings.stylus, barrelButton: e.target.value as BarrelButtonAction } })}
        >
          <option value="eraser-stroke">Stroke eraser</option>
          <option value="eraser-pixel">Pixel eraser</option>
          <option value="select">Select / lasso</option>
        </select>
      </Row>
      <Row label="Eraser end">
        <select
          className={SELECT}
          aria-label="Eraser end"
          value={settings.stylus.eraserEnd}
          onChange={(e) => onSettingsChange({ stylus: { ...settings.stylus, eraserEnd: e.target.value as EraserEndAction } })}
        >
          <option value="eraser-stroke">Stroke eraser</option>
          <option value="eraser-pixel">Pixel eraser</option>
        </select>
      </Row>
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
      </div>
    </div>
  );
}
