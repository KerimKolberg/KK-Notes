/**
 * The pointer over a page while an eraser is active.
 *
 * The eraser used to hide the pointer (`cursor: none`) and draw its own ring on the
 * ink layer — but only while erasing, with the pen down. Hovering, there was nothing:
 * the pointer vanished the moment it crossed onto a page and came back in the gap
 * between two. And a ring drawn by the page is at least a frame behind a pointer the
 * system draws, which is the one that never seems to lag.
 *
 * So the ring is now a cursor image the system draws, sized to what the eraser will
 * take — a ring of the eraser's diameter, with a dot at the centre, dark with a light
 * edge so it reads on ink, on a dark page and on a PDF. It is rebuilt when the size or
 * zoom changes. The ring on the ink layer stays, for the stroke in progress.
 */

/** Browsers refuse cursor images past 128 px, so a bigger eraser keeps the drawn ring alone. */
export const MAX_CURSOR_PX = 120;
/** Smaller than this and the ring is a smudge; the image is drawn no smaller. */
export const MIN_CURSOR_PX = 10;

/**
 * A CSS `cursor` value for a ring `diameter` CSS pixels across, or `null` when it is
 * too big for a cursor image (or not a size at all).
 */
export function eraserCursor(diameter: number): string | null {
  if (!Number.isFinite(diameter) || diameter <= 0 || diameter > MAX_CURSOR_PX) return null;
  const d = Math.max(MIN_CURSOR_PX, diameter);
  // Even, with room for the light edge, so the centre is on a whole pixel.
  const size = Math.ceil(d / 2) * 2 + 6;
  const c = size / 2;
  const r = d / 2;
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' viewBox='0 0 ${size} ${size}'>` +
    `<circle cx='${c}' cy='${c}' r='${r}' fill='none' stroke='white' stroke-width='3.5'/>` +
    `<circle cx='${c}' cy='${c}' r='${r}' fill='none' stroke='black' stroke-width='1.25'/>` +
    `<circle cx='${c}' cy='${c}' r='2' fill='white'/><circle cx='${c}' cy='${c}' r='1' fill='black'/>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${c} ${c}, crosshair`;
}
