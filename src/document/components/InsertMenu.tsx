import { useCallback, useState } from 'react';
import { Image as ImageIcon, StickyNote, Table } from 'lucide-react';
import { Chip, Row } from '../../inking/palette/parts';
import {
  DEFAULT_TABLE_COLUMNS,
  DEFAULT_TABLE_LINE_OPACITY,
  DEFAULT_TABLE_LINE_WIDTH,
  DEFAULT_TABLE_ROWS,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_LINE_OPACITY,
  MAX_TABLE_LINE_WIDTH,
  MAX_TABLE_ROWS,
  MIN_TABLE_LINE_OPACITY,
  MIN_TABLE_LINE_WIDTH,
} from '../constants';
import type { TableInit } from '../media';

export interface InsertMenuProps {
  /** Opens the file picker and places the chosen image. */
  onInsertImage: () => void;
  onInsertNote: () => void;
  onInsertTable: (init: TableInit) => void;
  /** Closes the popover the menu is rendered in. */
  onDone: () => void;
}

const ENTRY =
  'inline-flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm font-medium ' +
  'text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800';

const ROWS = Array.from({ length: MAX_TABLE_ROWS }, (_, i) => i + 1);
const COLUMNS = Array.from({ length: MAX_TABLE_COLUMNS }, (_, i) => i + 1);

/**
 * Everything that can be dropped onto a page, behind one button.
 *
 * Images and notes go straight down — there is nothing to decide first. A
 * table is configured before it exists: picking the grid afterwards would mean
 * adding and removing rows one at a time, and the line weight is part of what
 * the table is for (a faint grid to write over, or a hard-ruled one).
 */
export function InsertMenu({ onInsertImage, onInsertNote, onInsertTable, onDone }: InsertMenuProps) {
  const [rows, setRows] = useState(DEFAULT_TABLE_ROWS);
  const [columns, setColumns] = useState(DEFAULT_TABLE_COLUMNS);
  // What the pointer is currently over, so the grid previews a size before it
  // is chosen; `null` falls back to the committed rows/columns.
  const [hover, setHover] = useState<{ rows: number; columns: number } | null>(null);
  const [lineWidth, setLineWidth] = useState(DEFAULT_TABLE_LINE_WIDTH);
  const [lineOpacity, setLineOpacity] = useState(DEFAULT_TABLE_LINE_OPACITY);

  const shown = hover ?? { rows, columns };

  const insertTable = useCallback(() => {
    onInsertTable({ rows, columns, lineWidth, lineOpacity });
    onDone();
  }, [rows, columns, lineWidth, lineOpacity, onInsertTable, onDone]);

  return (
    <div className="flex w-[min(20rem,calc(100vw-2.5rem))] flex-col gap-1" data-insert-menu>
      <button
        type="button"
        className={ENTRY}
        data-insert-image
        onClick={() => {
          onInsertImage();
          onDone();
        }}
      >
        <ImageIcon size={18} aria-hidden="true" />
        Image
      </button>
      <button
        type="button"
        className={ENTRY}
        data-insert-note
        onClick={() => {
          onInsertNote();
          onDone();
        }}
      >
        <StickyNote size={18} aria-hidden="true" />
        Sticky note
      </button>

      <div className="mt-1 border-t border-zinc-200 pt-1 dark:border-zinc-700">
        <div className="flex items-center gap-2 px-1 pb-1">
          <Table size={18} aria-hidden="true" className="text-zinc-500 dark:text-zinc-400" />
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-200">Table</span>
          <span className="ml-auto text-xs tabular-nums text-zinc-500 dark:text-zinc-400" data-table-size>
            {shown.rows} × {shown.columns}
          </span>
        </div>

        {/* Grid picker. A press anywhere in it sets both counts at once; the
            number fields below are for the sizes a 20 × 20 grid cannot reach
            comfortably with a fingertip. */}
        <div
          role="grid"
          aria-label="Table size"
          data-table-grid
          className="grid w-fit gap-px px-1"
          style={{ gridTemplateColumns: `repeat(${MAX_TABLE_COLUMNS}, 0.75rem)` }}
          onPointerLeave={() => setHover(null)}
        >
          {ROWS.map((r) =>
            COLUMNS.map((c) => {
              const on = r <= shown.rows && c <= shown.columns;
              return (
                <button
                  key={`${r}x${c}`}
                  type="button"
                  role="gridcell"
                  aria-label={`${r} by ${c}`}
                  aria-selected={r === shown.rows && c === shown.columns}
                  className={`h-3 w-3 rounded-[2px] border ${
                    on
                      ? 'border-blue-600 bg-blue-500/70 dark:border-blue-400'
                      : 'border-zinc-300 bg-zinc-100 dark:border-zinc-600 dark:bg-zinc-800'
                  }`}
                  onPointerEnter={() => setHover({ rows: r, columns: c })}
                  onClick={() => {
                    setRows(r);
                    setColumns(c);
                    setHover(null);
                  }}
                />
              );
            }),
          )}
        </div>

        <Row label="Rows / columns">
          <input
            type="number"
            className="h-8 w-16 rounded-lg border border-zinc-300 bg-white px-2 text-xs text-zinc-900 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
            min={1}
            max={MAX_TABLE_ROWS}
            step={1}
            value={rows}
            aria-label="Rows"
            data-table-rows
            onChange={(e) => setRows(clamp(Number(e.target.value), MAX_TABLE_ROWS))}
          />
          <input
            type="number"
            className="h-8 w-16 rounded-lg border border-zinc-300 bg-white px-2 text-xs text-zinc-900 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
            min={1}
            max={MAX_TABLE_COLUMNS}
            step={1}
            value={columns}
            aria-label="Columns"
            data-table-columns
            onChange={(e) => setColumns(clamp(Number(e.target.value), MAX_TABLE_COLUMNS))}
          />
        </Row>
        <Row label="Grid line width">
          <input
            type="range"
            className="h-1 w-28 accent-blue-600"
            min={MIN_TABLE_LINE_WIDTH}
            max={MAX_TABLE_LINE_WIDTH}
            step={0.25}
            value={lineWidth}
            aria-label="Grid line width"
            data-table-line-width
            onChange={(e) => setLineWidth(Number(e.target.value))}
          />
          <span className="w-10 text-right text-xs tabular-nums text-zinc-500 dark:text-zinc-400">{lineWidth}px</span>
        </Row>
        <Row label="Grid line opacity">
          <input
            type="range"
            className="h-1 w-28 accent-blue-600"
            min={MIN_TABLE_LINE_OPACITY}
            max={MAX_TABLE_LINE_OPACITY}
            step={0.05}
            value={lineOpacity}
            aria-label="Grid line opacity"
            data-table-line-opacity
            onChange={(e) => setLineOpacity(Number(e.target.value))}
          />
          <span className="w-10 text-right text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
            {Math.round(lineOpacity * 100)}%
          </span>
        </Row>
        <div className="px-1 pt-1">
          <Chip onClick={insertTable} label={`Insert a ${rows} by ${columns} table`}>
            <span data-insert-table>Insert table</span>
          </Chip>
        </div>
      </div>
    </div>
  );
}

function clamp(value: number, max: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(max, Math.max(1, Math.round(value)));
}
