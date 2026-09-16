/**
 * Procedural page backgrounds. A single line generator feeds two renderers:
 * an SVG data URL (memory-light, crisp at any zoom, used as the live page's
 * CSS background) and a canvas painter (used by the raster pipeline for
 * thumbnails and snapshots).
 */
import type { InkContext } from '../inking/engine/renderer';
import type { PageDimensions, PageTemplate, TemplateConfig } from './types';

export interface TemplateLine {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly width: number;
  readonly color: string;
}

export interface TemplatePalette {
  readonly line: string;
  readonly minor: string;
  readonly margin: string;
}

export interface TemplatePage {
  readonly dimensions: PageDimensions;
  readonly template: PageTemplate;
  readonly templateConfig: TemplateConfig;
  readonly backgroundColor: string;
}

/** Parse `#rgb` / `#rrggbb` / `rgb(a)()` into 0..255 channels; `null` if unrecognised. */
export function parseColor(color: string): [number, number, number] | null {
  const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex?.[1]) {
    const h = hex[1];
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
  }
  const rgb = color.trim().match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i);
  if (rgb?.[1] && rgb[2] && rgb[3]) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

/** WCAG relative luminance in [0, 1]; unknown colours count as light. */
export function relativeLuminance(color: string): number {
  const rgb = parseColor(color);
  if (!rgb) return 1;
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function isDarkBackground(color: string): boolean {
  return relativeLuminance(color) < 0.35;
}

/** Line colours that read well on the page background (theme-aware). */
export function templatePalette(backgroundColor: string, strokeColor: string): TemplatePalette {
  const dark = isDarkBackground(backgroundColor);
  if (strokeColor !== 'auto') {
    return { line: strokeColor, minor: strokeColor, margin: strokeColor };
  }
  return dark
    ? { line: 'rgba(226, 232, 240, 0.26)', minor: 'rgba(226, 232, 240, 0.11)', margin: 'rgba(251, 113, 133, 0.6)' }
    : { line: 'rgba(30, 41, 59, 0.22)', minor: 'rgba(30, 41, 59, 0.09)', margin: 'rgba(225, 29, 72, 0.55)' };
}

function horizontalLines(w: number, h: number, start: number, step: number, width: number, color: string): TemplateLine[] {
  const out: TemplateLine[] = [];
  if (step <= 0) return out;
  for (let y = start; y <= h; y += step) out.push({ x1: 0, y1: y, x2: w, y2: y, width, color });
  return out;
}

function verticalLines(w: number, h: number, start: number, step: number, width: number, color: string): TemplateLine[] {
  const out: TemplateLine[] = [];
  if (step <= 0) return out;
  for (let x = start; x <= w; x += step) out.push({ x1: x, y1: 0, x2: x, y2: h, width, color });
  return out;
}

/**
 * Family of parallel lines at `angleDeg` from the +x axis with perpendicular
 * spacing `spacing`, clipped to the page rectangle.
 */
export function lineFamily(angleDeg: number, spacing: number, w: number, h: number, width: number, color: string): TemplateLine[] {
  if (spacing <= 0) return [];
  const eps = 1e-6;
  /** Clamp into the page and normalise -0. */
  const clampX = (v: number): number => (v <= 0 ? 0 : v >= w ? w : v);
  const clampY = (v: number): number => (v <= 0 ? 0 : v >= h ? h : v);
  const a = (angleDeg * Math.PI) / 180;
  // Unit normal to the line direction, oriented so families iterate in
  // increasing x (or increasing y for horizontals) regardless of the angle's sign.
  let nx = -Math.sin(a);
  let ny = Math.cos(a);
  if (nx < -eps || (Math.abs(nx) <= eps && ny < 0)) {
    nx = -nx;
    ny = -ny;
  }
  const corners = [
    [0, 0],
    [w, 0],
    [0, h],
    [w, h],
  ] as const;
  let cMin = Number.POSITIVE_INFINITY;
  let cMax = Number.NEGATIVE_INFINITY;
  for (const [x, y] of corners) {
    const c = nx * x + ny * y;
    if (c < cMin) cMin = c;
    if (c > cMax) cMax = c;
  }
  const out: TemplateLine[] = [];
  for (let c = Math.ceil(cMin / spacing) * spacing; c <= cMax + eps; c += spacing) {
    // Intersect n·p = c with the four edges, keep points inside the rect.
    const pts: Array<[number, number]> = [];
    if (Math.abs(ny) > eps) {
      const y0 = c / ny; // x = 0
      const yw = (c - nx * w) / ny; // x = w
      if (y0 >= -eps && y0 <= h + eps) pts.push([0, y0]);
      if (yw >= -eps && yw <= h + eps) pts.push([w, yw]);
    }
    if (Math.abs(nx) > eps) {
      const x0 = c / nx; // y = 0
      const xh = (c - ny * h) / nx; // y = h
      if (x0 >= -eps && x0 <= w + eps) pts.push([x0, 0]);
      if (xh >= -eps && xh <= w + eps) pts.push([xh, h]);
    }
    if (pts.length < 2) continue;
    // Take the two most distant candidates (corners can appear twice).
    let best: [number, number, number, number] | null = null;
    let bestD = -1;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const p = pts[i];
        const q = pts[j];
        if (!p || !q) continue;
        const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (d > bestD) {
          bestD = d;
          best = [p[0], p[1], q[0], q[1]];
        }
      }
    }
    if (best && bestD > eps) {
      out.push({ x1: clampX(best[0]), y1: clampY(best[1]), x2: clampX(best[2]), y2: clampY(best[3]), width, color });
    }
  }
  return out;
}

/** All background lines for a page, in page units. */
export function templateLines(page: TemplatePage): TemplateLine[] {
  const { width: w, height: h } = page.dimensions;
  const { spacing, strokeWidth, marginOffset = 96 } = page.templateConfig;
  const palette = templatePalette(page.backgroundColor, page.templateConfig.strokeColor);
  const minorWidth = Math.max(0.5, strokeWidth * 0.6);
  switch (page.template) {
    case 'blank':
    case 'pdf':
      return [];
    case 'ruled': {
      const lines = horizontalLines(w, h, spacing * 3, spacing, strokeWidth, palette.line);
      if (marginOffset > 0 && marginOffset < w) {
        lines.push({ x1: marginOffset, y1: 0, x2: marginOffset, y2: h, width: strokeWidth, color: palette.margin });
      }
      return lines;
    }
    case 'grid':
      return [
        ...verticalLines(w, h, spacing, spacing, strokeWidth, palette.line),
        ...horizontalLines(w, h, spacing, spacing, strokeWidth, palette.line),
      ];
    case 'engineering': {
      const major = spacing * 5;
      return [
        ...verticalLines(w, h, spacing, spacing, minorWidth, palette.minor),
        ...horizontalLines(w, h, spacing, spacing, minorWidth, palette.minor),
        ...verticalLines(w, h, major, major, strokeWidth * 1.4, palette.line),
        ...horizontalLines(w, h, major, major, strokeWidth * 1.4, palette.line),
      ];
    }
    case 'isometric': {
      // Equilateral triangles with side `spacing`: perpendicular pitch = side · √3 / 2.
      const pitch = (spacing * Math.sqrt(3)) / 2;
      return [
        ...lineFamily(90, pitch, w, h, strokeWidth, palette.line),
        ...lineFamily(30, pitch, w, h, strokeWidth, palette.line),
        ...lineFamily(-30, pitch, w, h, strokeWidth, palette.line),
      ];
    }
  }
}

/** Paint background colour + template lines in page units (caller sets the transform). */
export function drawTemplate(ctx: InkContext, page: TemplatePage): void {
  const { width, height } = page.dimensions;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.fillStyle = page.backgroundColor;
  ctx.fillRect(0, 0, width, height);
  ctx.lineCap = 'butt';
  let currentColor = '';
  let currentWidth = -1;
  const lines = templateLines(page);
  for (const line of lines) {
    if (line.color !== currentColor || line.width !== currentWidth) {
      if (currentWidth !== -1) ctx.stroke();
      ctx.beginPath();
      ctx.strokeStyle = line.color;
      ctx.lineWidth = line.width;
      currentColor = line.color;
      currentWidth = line.width;
    }
    ctx.moveTo(line.x1, line.y1);
    ctx.lineTo(line.x2, line.y2);
  }
  if (currentWidth !== -1) ctx.stroke();
  ctx.restore();
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** Full-page SVG (transparent background) for use as a CSS background image. */
export function templateSvg(page: TemplatePage): string {
  const { width, height } = page.dimensions;
  const lines = templateLines(page)
    .map(
      (l) =>
        `<line x1="${fmt(l.x1)}" y1="${fmt(l.y1)}" x2="${fmt(l.x2)}" y2="${fmt(l.y2)}" stroke="${l.color}" stroke-width="${fmt(l.width)}"/>`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" shape-rendering="crispEdges">${lines}</svg>`;
}

export function templateSvgDataUrl(page: TemplatePage): string {
  return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(templateSvg(page))}")`;
}
