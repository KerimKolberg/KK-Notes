/**
 * A table drawn as lines: the other kind of table (`InsertMenu`, "Drawn lines").
 *
 * A typed table is cells to type in, an object on the page. Asked for was also "just completely ordinary line
 * drawings": lines in the pen's colour, that the area eraser takes a bit of, the lasso moves and the pen writes
 * between. So this is no object at all: an outer frame and the lines between the rows and the columns, each a line
 * stroke as the line tool makes, and once on the page they are ink like any other.
 */
import { createGeometricStroke } from '../inking/engine/shapes';
import type { Point, Stroke, StrokeStyle } from '../inking/types';
import { TABLE_CELL_SIZE } from './constants';
import { fitOnPage } from './media';
import type { PageDimensions } from './types';

export interface DrawnTableInit {
  readonly rows: number;
  readonly columns: number;
  /** The lines' look: the pen's colour and width (a line tool style). */
  readonly style: StrokeStyle;
  /** Where its middle goes; the page's middle if not said. */
  readonly at?: Point;
}

/** The lines of a `rows` × `columns` table, cells the typed table's size, kept on the page. */
export function drawnTableStrokes(page: PageDimensions, init: DrawnTableInit): Stroke[] {
  const rows = Math.max(1, Math.round(init.rows));
  const columns = Math.max(1, Math.round(init.columns));
  const centre = init.at ?? { x: page.width / 2, y: page.height / 2 };
  const wanted = { width: columns * TABLE_CELL_SIZE.width, height: rows * TABLE_CELL_SIZE.height };
  const box = fitOnPage({ x: centre.x - wanted.width / 2, y: centre.y - wanted.height / 2, ...wanted }, page);
  const line = (from: Point, to: Point): Stroke =>
    createGeometricStroke({ tool: 'line', shape: { type: 'line', from, to }, style: init.style, pointerType: 'pen' });
  const strokes: Stroke[] = [];
  for (let r = 0; r <= rows; r++) {
    const y = box.y + (box.height * r) / rows;
    strokes.push(line({ x: box.x, y }, { x: box.x + box.width, y }));
  }
  for (let c = 0; c <= columns; c++) {
    const x = box.x + (box.width * c) / columns;
    strokes.push(line({ x, y: box.y }, { x, y: box.y + box.height }));
  }
  return strokes;
}
