import { memo, useId } from 'react';
import { COLOR_PALETTE, MAX_STROKE_SIZE, MIN_STROKE_SIZE } from './constants';
import styles from './InkingCanvas.module.css';
import type { ToolSettings, ToolType } from './types';

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
  { id: 'pen', label: 'Pen', hint: 'Pressure-sensitive pen' },
  { id: 'highlighter', label: 'Highlighter', hint: 'Translucent multiply highlighter' },
  { id: 'eraser-stroke', label: 'Stroke eraser', hint: 'Remove whole strokes' },
  { id: 'eraser-pixel', label: 'Pixel eraser', hint: 'Erase pixels under the tip' },
];

const hasColor = (tool: ToolType): boolean => tool === 'pen' || tool === 'highlighter';

export const InkingToolbar = memo(function InkingToolbar({
  settings,
  onSettingsChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onClear,
}: InkingToolbarProps) {
  const sizeId = useId();
  const colorId = useId();
  const touchId = useId();

  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Inking tools">
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
        <label htmlFor={colorId} className={styles.srOnly}>
          Custom colour
        </label>
        <input
          id={colorId}
          type="color"
          className={styles.colorInput}
          value={settings.color}
          disabled={!hasColor(settings.tool)}
          onChange={(e) => onSettingsChange({ color: e.target.value })}
        />
      </div>

      <span className={styles.divider} aria-hidden="true" />

      <label htmlFor={sizeId} className={styles.sizeLabel}>
        Width
        <input
          id={sizeId}
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

      <label htmlFor={touchId} className={styles.toggle} title="Allow finger input to draw">
        <input
          id={touchId}
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
        <button
          type="button"
          className={styles.button}
          onClick={onUndo}
          disabled={!canUndo}
          title="Undo (Ctrl/⌘+Z)"
        >
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
  );
});
