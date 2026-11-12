/**
 * Turning a page a quarter turn, as a sheet of paper is turned: the page becomes landscape (or portrait again), and
 * what is on it turns with it — ink, pictures, notes, form fields, and a PDF page underneath. Only the page's own
 * text stays upright and fills the turned page's margins, as a word processor's text does when the page is turned.
 */
import { transformStroke, type StrokeTransform } from '../inking/engine/lasso';
import type { Stroke } from '../inking/types';
import { pageTextFrame } from './media';
import type { MediaObject, Page, PageBox } from './types';

/** One quarter turn clockwise about the page's top-left, then moved back onto the page: (x, y) → (H − y, x). */
function quarterTurn(height: number): readonly StrokeTransform[] {
  return [
    { kind: 'rotate', origin: { x: 0, y: 0 }, angle: Math.PI / 2 },
    { kind: 'translate', dx: height, dy: 0 },
  ];
}

/** Rounding off what cos(π/2) leaves behind, so a page turned four times is the page it was. */
const tidy = (n: number): number => Math.round(n * 1e6) / 1e6;

function turnStroke(stroke: Stroke, height: number): Stroke {
  const turned = quarterTurn(height).reduce(transformStroke, stroke);
  if (turned.kind !== 'freehand') return turned;
  return { ...turned, points: turned.points.map((p) => ({ ...p, x: tidy(p.x), y: tidy(p.y) })) };
}

function turnBox(box: PageBox, height: number): PageBox {
  return { x: tidy(height - box.y - box.height), y: tidy(box.x), width: box.height, height: box.width };
}

function turnMedia(media: MediaObject, width: number, height: number): MediaObject {
  if (media.kind === 'text' && media.flow) return { ...media, ...pageTextFrame({ width: height, height: width }), rotation: 0 };
  // The box keeps its size and turns about its centre, which goes where the page takes it.
  const cx = media.x + media.width / 2;
  const cy = media.y + media.height / 2;
  return {
    ...media,
    x: tidy(height - cy - media.width / 2),
    y: tidy(cx - media.height / 2),
    rotation: (((media.rotation + 90) % 360) + 360) % 360,
  };
}

function turnOnce(page: Page): Page {
  const { width, height } = page.dimensions;
  const turnStrokes = (strokes: readonly Stroke[]) => strokes.map((s) => turnStroke(s, height));
  const turned: Page = {
    ...page,
    dimensions: { width: height, height: width },
    strokes: turnStrokes(page.strokes),
    // The page's own Undo steps are in the same place as its ink, or undoing after a turn would put ink back sideways.
    undoStack: page.undoStack.map(turnStrokes),
    redoStack: page.redoStack.map(turnStrokes),
    media: page.media.map((m) => turnMedia(m, width, height)),
    formFields: page.formFields.map((f) => ({ ...f, box: turnBox(f.box, height) })),
    ...(page.pdf ? { pdf: { ...page.pdf, rotation: (page.pdf.rotation + 90) % 360 } } : {}),
  };
  if (!page.inkText) return turned;
  return { ...turned, inkText: { ...page.inkText, words: page.inkText.words.map((w) => ({ ...w, ...turnBox(w, height) })) } };
}

/** The page turned by `quarterTurns` quarter turns: positive clockwise, negative the other way. */
export function rotatePage(page: Page, quarterTurns: number): Page {
  const turns = ((Math.round(quarterTurns) % 4) + 4) % 4;
  let out = page;
  for (let i = 0; i < turns; i++) out = turnOnce(out);
  return out;
}
