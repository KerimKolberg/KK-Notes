import { memo, useId } from 'react';
import {
  AXIS_LABEL_PRESETS,
  COLOR_PALETTE,
  MAX_STROKE_SIZE,
  MIN_STROKE_SIZE,
  STROKE_PATTERNS,
} from './constants';
import styles from './InkingCanvas.module.css';
import type { ArrowheadMode, CoordinatePlaneConfig, StrokePattern, ToolSettings, ToolType } from './types';

export interface InkingToolbarProps {
  settings: Readonly<ToolSettings>;
  onSettingsChange: (patch: Partial<ToolSettings>) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
}

interface ToolDescriptor {
  id: ToolType;
  label: string;
  hint: string;
}

const TOOLS: readonly ToolDescriptor[] = [
  { id: 'select', label: 'Select', hint: 'Select and move images, fill in forms' },
  { id: 'pen', label: 'Pen', hint: 'Pressure-sensitive pen. Hold still at the end to snap to a shape.' },
  { id: 'highlighter', label: 'Highlighter', hint: 'Translucent multiply highlighter' },
  { id: 'line', label: 'Line', hint: 'Drag a straight line or vector' },
  { id: 'coordinate-plane', label: 'Axes', hint: 'Drag from the origin to lay out a coordinate plane' },
  { id: 'eraser-stroke', label: 'Stroke eraser', hint: 'Remove whole strokes' },
  { id: 'eraser-pixel', label: 'Pixel eraser', hint: 'Erase pixels under the tip' },
];

const NEXT_ARROW: Record<ArrowheadMode, ArrowheadMode> = { none: 'end', end: 'both', both: 'none' };
const ARROW_LABEL: Record<ArrowheadMode, string> = { none: 'Arrow off', end: 'Arrow →', both: 'Arrow ↔' };

const hasColor = (tool: ToolType): boolean => tool !== 'eraser-stroke' && tool !== 'eraser-pixel' && tool !== 'select';
const hasPattern = (tool: ToolType): boolean => tool === 'pen' || tool === 'highlighter' || tool === 'line';
const hasAngleSnap = (tool: ToolType): boolean => hasPattern(tool);
const hasHoldToSnap = (tool: ToolType): boolean => tool === 'pen' || tool === 'highlighter';

function presetIndex(plane: CoordinatePlaneConfig): number {
  return AXIS_LABEL_PRESETS.findIndex((p) => p.x === plane.xLabel && p.y === plane.yLabel);
}

export const InkingToolbar = memo(function InkingToolbar({
  settings,
  onSettingsChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onClear,
}: InkingToolbarProps) {
  const ids = {
    size: useId(),
    color: useId(),
    touch: useId(),
    pattern: useId(),
    divisions: useId(),
    preset: useId(),
    xLabel: useId(),
    yLabel: useId(),
  };
  const plane = settings.coordinatePlane;
  const patchPlane = (patch: Partial<CoordinatePlaneConfig>): void =>
    onSettingsChange({ coordinatePlane: { ...plane, ...patch } });

  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Inking tools">
      <div className={styles.row}>
        <div className={styles.group} role="group" aria-label="Tool">
          {TOOLS.map((tool) => (
            <button
              key={tool.id}
              type="button"
              className={styles.button}
              aria-pressed={settings.tool === tool.id}
              title={tool.hint}
              onClick={() => onSettingsChange({ tool: tool.id })}
            >
              {tool.label}
            </button>
          ))}
        </div>

        <span className={styles.divider} aria-hidden="true" />

        <div className={styles.group} aria-label="Colour">
          <div className={styles.swatches}>
            {COLOR_PALETTE.map((color) => (
              <button
                key={color}
                type="button"
                className={styles.swatch}
                style={{ background: color }}
                aria-label={`Colour ${color}`}
                aria-pressed={settings.color.toLowerCase() === color.toLowerCase()}
                disabled={!hasColor(settings.tool)}
                onClick={() => onSettingsChange({ color })}
              />
            ))}
          </div>
          <label htmlFor={ids.color} className={styles.srOnly}>
            Custom colour
          </label>
          <input
            id={ids.color}
            type="color"
            className={styles.colorInput}
            value={settings.color}
            disabled={!hasColor(settings.tool)}
            onChange={(e) => onSettingsChange({ color: e.target.value })}
          />
        </div>

        <span className={styles.divider} aria-hidden="true" />

        <label htmlFor={ids.size} className={styles.sizeLabel}>
          Width
          <input
            id={ids.size}
            type="range"
            className={styles.sizeInput}
            min={MIN_STROKE_SIZE}
            max={MAX_STROKE_SIZE}
            step={0.5}
            value={settings.size}
            onChange={(e) => onSettingsChange({ size: Number(e.target.value) })}
          />
          <span className={styles.sizeValue}>{settings.size}px</span>
        </label>

        <span className={styles.divider} aria-hidden="true" />

        <div className={styles.group} aria-label="Stroke style">
          <label htmlFor={ids.pattern} className={styles.srOnly}>
            Line pattern
          </label>
          <select
            id={ids.pattern}
            className={styles.select}
            value={settings.pattern}
            disabled={!hasPattern(settings.tool)}
            onChange={(e) => onSettingsChange({ pattern: e.target.value as StrokePattern })}
          >
            {STROKE_PATTERNS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={styles.button}
            aria-pressed={settings.arrowheads !== 'none'}
            disabled={!hasPattern(settings.tool)}
            title="Cycle arrowheads: off → end → both ends"
            onClick={() => onSettingsChange({ arrowheads: NEXT_ARROW[settings.arrowheads] })}
          >
            {ARROW_LABEL[settings.arrowheads]}
          </button>
          <button
            type="button"
            className={styles.button}
            aria-pressed={settings.angleSnap}
            disabled={!hasAngleSnap(settings.tool)}
            title="Snap straight lines to 15° increments"
            onClick={() => onSettingsChange({ angleSnap: !settings.angleSnap })}
          >
            15° snap
          </button>
          <button
            type="button"
            className={styles.button}
            aria-pressed={settings.holdToSnap}
            disabled={!hasHoldToSnap(settings.tool)}
            title="Hold the pen still for a second at the end of a stroke to convert it into a shape"
            onClick={() => onSettingsChange({ holdToSnap: !settings.holdToSnap })}
          >
            Hold to snap
          </button>
        </div>

        <span className={styles.divider} aria-hidden="true" />

        <label htmlFor={ids.touch} className={styles.toggle} title="Allow finger input to draw">
          <input
            id={ids.touch}
            type="checkbox"
            role="switch"
            className={styles.toggleInput}
            checked={settings.touchDraw}
            onChange={(e) => onSettingsChange({ touchDraw: e.target.checked })}
          />
          Touch Draw
        </label>

        <span className={styles.divider} aria-hidden="true" />

        <div className={styles.group}>
          <button type="button" className={styles.button} onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl/⌘+Z)">
            Undo
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={onRedo}
            disabled={!canRedo}
            title="Redo (Ctrl/⌘+Shift+Z)"
          >
            Redo
          </button>
          <button type="button" className={styles.button} onClick={onClear} title="Clear canvas">
            Clear
          </button>
        </div>
      </div>

      {settings.tool === 'coordinate-plane' && (
        <div className={styles.row} role="group" aria-label="Coordinate plane">
          <div className={styles.group} role="group" aria-label="Quadrants">
            <button
              type="button"
              className={styles.button}
              aria-pressed={plane.mode === 'quadrant-1'}
              title="Positive axes only (economics, standard metrics)"
              onClick={() => patchPlane({ mode: 'quadrant-1' })}
            >
              Quadrant I
            </button>
            <button
              type="button"
              className={styles.button}
              aria-pressed={plane.mode === 'four-quadrant'}
              title="Full plane (signals, control theory, complex plane)"
              onClick={() => patchPlane({ mode: 'four-quadrant' })}
            >
              4 quadrants
            </button>
          </div>

          <span className={styles.divider} aria-hidden="true" />

          <label htmlFor={ids.divisions} className={styles.sizeLabel}>
            Divisions
            <input
              id={ids.divisions}
              type="number"
              className={styles.numberInput}
              min={1}
              max={20}
              step={1}
              value={plane.divisions}
              onChange={(e) => {
                const value = Math.round(Number(e.target.value));
                if (Number.isFinite(value)) patchPlane({ divisions: Math.min(20, Math.max(1, value)) });
              }}
            />
          </label>

          <label className={styles.toggle}>
            <input
              type="checkbox"
              className={styles.toggleInput}
              checked={plane.showGrid}
              onChange={(e) => patchPlane({ showGrid: e.target.checked })}
            />
            Grid
          </label>
          <label className={styles.toggle}>
            <input
              type="checkbox"
              className={styles.toggleInput}
              checked={plane.tickLabels}
              onChange={(e) => patchPlane({ tickLabels: e.target.checked })}
            />
            Numbers
          </label>

          <span className={styles.divider} aria-hidden="true" />

          <label htmlFor={ids.preset} className={styles.srOnly}>
            Axis label preset
          </label>
          <select
            id={ids.preset}
            className={styles.select}
            value={presetIndex(plane)}
            onChange={(e) => {
              const preset = AXIS_LABEL_PRESETS[Number(e.target.value)];
              if (preset) patchPlane({ xLabel: preset.x, yLabel: preset.y });
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
          <label htmlFor={ids.xLabel} className={styles.sizeLabel}>
            x
            <input
              id={ids.xLabel}
              type="text"
              className={styles.textInput}
              value={plane.xLabel}
              maxLength={12}
              aria-label="Horizontal axis label"
              onChange={(e) => patchPlane({ xLabel: e.target.value })}
            />
          </label>
          <label htmlFor={ids.yLabel} className={styles.sizeLabel}>
            y
            <input
              id={ids.yLabel}
              type="text"
              className={styles.textInput}
              value={plane.yLabel}
              maxLength={12}
              aria-label="Vertical axis label"
              onChange={(e) => patchPlane({ yLabel: e.target.value })}
            />
          </label>
        </div>
      )}
    </div>
  );
});
