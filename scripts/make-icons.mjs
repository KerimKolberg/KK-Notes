#!/usr/bin/env node
/**
 * Draw the KK-Notes mark and write every icon the two platforms want.
 *
 *   node scripts/make-icons.mjs
 *
 * The mark is a navy folio with a light page on it and a teal **KK**
 * monogram, where the second K's stem is a stylus — a pen that runs past the
 * cap height, tapers to a nib below the baseline, and carries its cap as a
 * separate triangle above.
 *
 * **The geometry is declared once**, in a unit square, as a list of flat
 * shapes ([`markShapes`]). Everything else is a projection of it: the PNGs and
 * the `.ico` rasterise it, the favicon emits it as SVG. That is the point —
 * an icon set where the 48 px launcher tile and the browser tab were drawn
 * separately drifts, and nobody notices until they are side by side.
 *
 * Rendering is a supersampled point-in-shape test rather than a real
 * rasteriser: at 6×6 samples per pixel the diagonals of a K are clean, and a
 * scanline polygon filler would be a hundred lines to do the same job for
 * three shape kinds.
 */
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** True only when run as a script, so the tests can import the geometry. */
const RUNNING = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

// ---------------------------------------------------------------------------
// The mark
// ---------------------------------------------------------------------------

export const PALETTE = {
  /** The folio body, and the adaptive icon's background layer. */
  navy: '#23415E',
  /** The page. */
  screen: '#EEF2F5',
  /** The cover folded back behind the spine, a shade down so it reads as behind. */
  cover: '#DCE3E9',
  /** The hinge between them. */
  spine: '#8C99A7',
  /** The monogram and the stylus. */
  teal: '#2AB5AC',
};

/** Where the monogram sits, in the unit square. Shared by every renderer. */
export const MARK = {
  /**
   * The page, the hinge and the cover folded back behind it.
   *
   * The furniture on the right is kept narrow deliberately: at a 48 px
   * launcher tile every percent of width it takes is a percent the monogram
   * does not have, and two grey stripes are not what anyone is trying to
   * recognise at that size.
   */
  page: { x: 0.08, y: 0.1, w: 0.685, h: 0.8, r: 0.055 },
  spine: { x: 0.787, y: 0.1, w: 0.028, h: 0.8, r: 0.012 },
  coverPanel: { x: 0.833, y: 0.1, w: 0.087, h: 0.8, r: 0.035 },
  /** Cap height of the K's. */
  capTop: 0.285,
  capBottom: 0.715,
  /**
   * Left edge of the first K and of the second.
   *
   * Shifted left of where the nominal letter widths would put them, because
   * the arms are thick *segments*: their far corners reach past the tip by
   * half a stroke, so centring on the tips would sit the pair visibly right.
   */
  k1: 0.183,
  k2: 0.438,
  /** Stem width: the pen is drawn a little narrower than a drawn stroke. */
  stem: 0.058,
  penStem: 0.048,
  /** Half-width of the arms, and how far right they reach from their K's left edge. */
  arm: 0.029,
  reach: 0.2,
};

const hex = (value) => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));

/** A rectangle with rounded corners. */
const roundRect = (x, y, w, h, r, fill) => ({ kind: 'roundRect', x, y, w, h, r, fill });
/** A thick line segment with flat ends — the K's stems and arms. */
const bar = (ax, ay, bx, by, half, fill) => ({ kind: 'bar', ax, ay, bx, by, half, fill });
const poly = (points, fill) => ({ kind: 'poly', points, fill });

/**
 * One K, as a stem and two arms meeting on it.
 *
 * The arms start a hair inside the stem (`- 0.005`) so the junction is a solid
 * corner rather than three shapes meeting exactly on a line, which
 * supersampling renders as a seam.
 */
function letterK(left, stemWidth, fill) {
  const { capTop, capBottom, arm, reach } = MARK;
  const junctionX = left + stemWidth - 0.005;
  const junctionY = capTop + (capBottom - capTop) * 0.5;
  const tip = left + reach;
  return [
    bar(junctionX, junctionY, tip, capTop, arm, fill),
    bar(junctionX, junctionY, tip, capBottom, arm, fill),
  ];
}

/**
 * The second K's stem, drawn as a stylus.
 *
 * Three pieces, and all three are in the logo for a reason: the body runs past
 * the cap height so the letter reads as a pen rather than a K that happens to
 * be tall, the nib below the baseline is what makes it a *writing* pen, and
 * the cap above is the detail that keeps the pair from looking like a typo.
 */
function stylusStem(fill) {
  const { capTop, capBottom, k2, penStem } = MARK;
  const centre = k2 + penStem / 2;
  const half = penStem / 2;
  const shoulder = capBottom + 0.015;
  return [
    bar(centre, capTop - 0.055, centre, shoulder, half, fill),
    // The nib.
    poly(
      [
        [centre - half, shoulder],
        [centre + half, shoulder],
        [centre, shoulder + 0.1],
      ],
      fill,
    ),
    // The cap, floating above the stroke.
    poly(
      [
        [centre - 0.028, capTop - 0.085],
        [centre + 0.028, capTop - 0.085],
        [centre, capTop - 0.155],
      ],
      fill,
    ),
  ];
}

/**
 * The mark, as flat shapes in a unit square, painted in order.
 *
 * `body` draws the folio itself — off for an Android adaptive foreground,
 * where the launcher supplies the background and masks whatever it likes off
 * the edges. `page` draws the folio's furniture; off for a monogram-only mark.
 */
export function markShapes({ body = true, page = true } = {}) {
  const shapes = [];
  if (body) shapes.push(roundRect(0, 0, 1, 1, 0.22, PALETTE.navy));
  if (page) {
    const p = MARK.page;
    shapes.push(roundRect(p.x, p.y, p.w, p.h, p.r, PALETTE.screen));
    const s = MARK.spine;
    shapes.push(roundRect(s.x, s.y, s.w, s.h, s.r, PALETTE.spine));
    const c = MARK.coverPanel;
    shapes.push(roundRect(c.x, c.y, c.w, c.h, c.r, PALETTE.cover));
  }
  shapes.push(
    bar(MARK.k1 + MARK.stem / 2, MARK.capTop, MARK.k1 + MARK.stem / 2, MARK.capBottom, MARK.stem / 2, PALETTE.teal),
    ...letterK(MARK.k1, MARK.stem, PALETTE.teal),
    ...stylusStem(PALETTE.teal),
    ...letterK(MARK.k2, MARK.penStem, PALETTE.teal),
  );
  return shapes;
}

/** The bounding box of a set of shapes, in unit coordinates. */
export function markBounds(shapes) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const note = (x, y) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const s of shapes) {
    if (s.kind === 'roundRect') {
      note(s.x, s.y);
      note(s.x + s.w, s.y + s.h);
    } else if (s.kind === 'bar') {
      for (const [x, y] of barCorners(s)) note(x, y);
    } else {
      for (const [x, y] of s.points) note(x, y);
    }
  }
  return { minX, minY, maxX, maxY };
}

// ---------------------------------------------------------------------------
// Rasterising
// ---------------------------------------------------------------------------

function inRoundRect(px, py, s) {
  const x1 = s.x + s.w;
  const y1 = s.y + s.h;
  if (px < s.x || py < s.y || px > x1 || py > y1) return false;
  const dx = Math.max(s.x + s.r - px, 0, px - (x1 - s.r));
  const dy = Math.max(s.y + s.r - py, 0, py - (y1 - s.r));
  return dx * dx + dy * dy <= s.r * s.r;
}

/** Inside a flat-ended thick segment: perpendicular distance and position along it. */
function inBar(px, py, s) {
  const vx = s.bx - s.ax;
  const vy = s.by - s.ay;
  const lengthSquared = vx * vx + vy * vy;
  if (lengthSquared === 0) return false;
  const t = ((px - s.ax) * vx + (py - s.ay) * vy) / lengthSquared;
  if (t < 0 || t > 1) return false;
  const cx = s.ax + vx * t;
  const cy = s.ay + vy * t;
  return (px - cx) ** 2 + (py - cy) ** 2 <= s.half * s.half;
}

/** Crossing-number point-in-polygon. */
function inPoly(px, py, s) {
  let inside = false;
  const points = s.points;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function hits(px, py, shape) {
  if (shape.kind === 'roundRect') return inRoundRect(px, py, shape);
  if (shape.kind === 'bar') return inBar(px, py, shape);
  return inPoly(px, py, shape);
}

/**
 * Samples per pixel per axis.
 *
 * Small icons need the most help — a 48 px tile is nearly all edge — and
 * capping the supersampled grid keeps a 512 px render from taking seconds for
 * a difference nobody can see.
 */
function sampling(size) {
  return size >= 256 ? 4 : 6;
}

/**
 * Paint the shapes and box-filter down to `size`.
 *
 * `scale`/`offset` place the mark inside the tile: an Android adaptive
 * foreground draws at 108 dp for a 72 dp visible area, so its mark is shrunk
 * into the middle and the launcher's mask only ever crops empty space.
 */
export function rasterize(size, shapes, { scale = 1, offset = 0 } = {}) {
  const ss = sampling(size);
  const colours = shapes.map((s) => hex(s.fill));
  const out = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const ux = ((x + (sx + 0.5) / ss) / size - offset) / scale;
          const uy = ((y + (sy + 0.5) / ss) / size - offset) / scale;
          // Painter's algorithm over opaque fills: the last shape hit wins.
          let hit = -1;
          for (let i = shapes.length - 1; i >= 0; i--) {
            if (hits(ux, uy, shapes[i])) {
              hit = i;
              break;
            }
          }
          if (hit < 0) continue;
          r += colours[hit][0];
          g += colours[hit][1];
          b += colours[hit][2];
          a += 255;
        }
      }
      const total = ss * ss;
      const i = (y * size + x) * 4;
      if (a === 0) continue;
      // Un-premultiply, so a half-covered edge keeps its colour instead of
      // fading towards black.
      const covered = a / 255;
      out[i] = Math.round(r / covered);
      out[i + 1] = Math.round(g / covered);
      out[i + 2] = Math.round(b / covered);
      out[i + 3] = Math.round(a / total);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

/** The four corners of a flat-ended thick segment. */
export function barCorners(s) {
  const vx = s.bx - s.ax;
  const vy = s.by - s.ay;
  const length = Math.hypot(vx, vy);
  const nx = (-vy / length) * s.half;
  const ny = (vx / length) * s.half;
  return [
    [s.ax + nx, s.ay + ny],
    [s.bx + nx, s.by + ny],
    [s.bx - nx, s.by - ny],
    [s.ax - nx, s.ay - ny],
  ];
}

const round = (n) => Number(n.toFixed(4));

/** The same geometry as the PNGs, as an SVG document. */
export function markSvg(shapes, { size = 512 } = {}) {
  const body = shapes
    .map((s) => {
      if (s.kind === 'roundRect') {
        return `  <rect x="${round(s.x)}" y="${round(s.y)}" width="${round(s.w)}" height="${round(s.h)}" rx="${round(s.r)}" fill="${s.fill}"/>`;
      }
      const points = (s.kind === 'bar' ? barCorners(s) : s.points).map(([x, y]) => `${round(x)},${round(y)}`).join(' ');
      return `  <polygon points="${points}" fill="${s.fill}"/>`;
    })
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" width="${size}" height="${size}" role="img" aria-label="KK-Notes">
${body}
</svg>
`;
}

// ---------------------------------------------------------------------------
// PNG / ICO containers
// ---------------------------------------------------------------------------

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

export function png(size, shapes, options) {
  const px = rasterize(size, shapes, options);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ICO container with PNG-compressed entries (supported since Windows Vista). */
export function ico(sizes, shapes) {
  const images = sizes.map((s) => ({ size: s, data: png(s, shapes) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    // 256 is written as 0; the field is one byte.
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0;
    e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

// ---------------------------------------------------------------------------
// Writing them out
// ---------------------------------------------------------------------------

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'src-tauri/icons');
const PUBLIC = join(ROOT, 'public');
const ANDROID_OUT = join(ROOT, 'src-tauri/gen/android/app/src/main/res');

const DENSITIES = [
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192],
];

/**
 * The visible fraction of an Android adaptive icon: the foreground is drawn at
 * 108 dp and the launcher shows the middle 72 dp, masked to whatever shape it
 * prefers. Drawing the mark at that scale means a circular mask crops navy,
 * never the monogram.
 */
export const ADAPTIVE_SCALE = 72 / 108;
export const ADAPTIVE_OFFSET = (1 - ADAPTIVE_SCALE) / 2;

function writeAndroidIcons(full, foreground) {
  if (!existsSync(ANDROID_OUT)) return false;
  for (const [density, size] of DENSITIES) {
    const dir = join(ANDROID_OUT, `mipmap-${density}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ic_launcher.png'), png(size, full));
    writeFileSync(join(dir, 'ic_launcher_round.png'), png(size, full));
    writeFileSync(
      join(dir, 'ic_launcher_foreground.png'),
      png(Math.round(size * 1.5), foreground, { scale: ADAPTIVE_SCALE, offset: ADAPTIVE_OFFSET }),
    );
  }
  return true;
}

if (RUNNING) {
  const full = markShapes();
  // The adaptive foreground leaves the folio body out: the launcher paints the
  // background layer (navy, from colors.xml) and masks the edges itself.
  const foreground = markShapes({ body: false });

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, '32x32.png'), png(32, full));
  writeFileSync(join(OUT, '128x128.png'), png(128, full));
  writeFileSync(join(OUT, '128x128@2x.png'), png(256, full));
  writeFileSync(join(OUT, 'icon.png'), png(512, full));
  writeFileSync(join(OUT, 'icon.ico'), ico([16, 32, 48, 256], full));

  mkdirSync(PUBLIC, { recursive: true });
  writeFileSync(join(PUBLIC, 'icon.svg'), markSvg(full));
  // A raster fallback for anything that will not take an SVG favicon.
  writeFileSync(join(PUBLIC, 'icon-180.png'), png(180, full));

  const android = writeAndroidIcons(full, foreground);
  console.log(`icons written to ${OUT}, ${PUBLIC}${android ? `, ${ANDROID_OUT}` : ' (no Android project yet)'}`);
}
