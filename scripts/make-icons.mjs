/**
 * Generate placeholder app icons (a rounded pen-nib mark on a slate square)
 * as real PNG / ICO files, so the Tauri build has valid assets before a
 * designer replaces them (`npx tauri icon path/to/icon.png` regenerates all).
 */
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = new URL('../src-tauri/icons/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

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
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function paint(size, { transparent = false, inset = 0 } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const r = size * 0.22; // corner radius
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // Rounded square mask
      const dx = Math.max(r - x, 0, x - (size - 1 - r));
      const dy = Math.max(r - y, 0, y - (size - 1 - r));
      const inside = dx * dx + dy * dy <= r * r;
      if (!inside) continue;
      // Slate background
      let [R, G, B] = [0x27, 0x2b, 0x36];
      // Diagonal "ink stroke": a thick band from bottom-left to top-right
      const u = (x + (size - 1 - y)) / (2 * (size - 1)); // 0..1 along the diagonal
      const v = (x - (size - 1 - y)) / (size - 1); // signed distance across
      const bandHalf = 0.11 + 0.06 * Math.sin(u * Math.PI); // pressure-like swell
      if (Math.abs(v) < bandHalf && u > 0.18 && u < 0.86) [R, G, B] = [0x60, 0xa5, 0xfa];
      // Nib dot
      const nx = x - size * 0.8, ny = y - size * 0.2;
      if (nx * nx + ny * ny < (size * 0.07) ** 2) [R, G, B] = [0xf8, 0xfa, 0xfc];
      // Adaptive-icon foregrounds sit on a separate background layer and are
      // masked by the launcher, so they drop the slate and keep a safe margin.
      const safe = inset > 0 && (x < size * inset || y < size * inset || x > size * (1 - inset) || y > size * (1 - inset));
      if (transparent && (R === 0x27 || safe)) continue;
      px[i] = R; px[i + 1] = G; px[i + 2] = B; px[i + 3] = 255;
    }
  }
  return px;
}

function png(size, options) {
  const px = paint(size, options);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ICO container with PNG-compressed entries (supported since Windows Vista). */
function ico(sizes) {
  const images = sizes.map((s) => ({ size: s, data: png(s) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size; e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

/**
 * Android launcher icons. minSdk 26 means every device supports adaptive
 * icons, so the foreground layer is what the launcher masks and animates; the
 * square PNGs stay for anything that asks for the legacy icon.
 */
const ANDROID_OUT = new URL('../src-tauri/gen/android/app/src/main/res/', import.meta.url).pathname;
const DENSITIES = [
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192],
];

function writeAndroidIcons() {
  if (!existsSync(ANDROID_OUT)) return;
  for (const [density, size] of DENSITIES) {
    const dir = join(ANDROID_OUT, `mipmap-${density}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ic_launcher.png'), png(size));
    writeFileSync(join(dir, 'ic_launcher_round.png'), png(size));
    // The foreground layer is drawn at 108dp for a 72dp visible area.
    writeFileSync(join(dir, 'ic_launcher_foreground.png'), png(Math.round(size * 1.5), { transparent: true, inset: 0.18 }));
  }
  console.log('android launcher icons written to', ANDROID_OUT);
}

writeFileSync(join(OUT, '32x32.png'), png(32));
writeFileSync(join(OUT, '128x128.png'), png(128));
writeFileSync(join(OUT, '128x128@2x.png'), png(256));
writeFileSync(join(OUT, 'icon.png'), png(512));
writeFileSync(join(OUT, 'icon.ico'), ico([16, 32, 48, 256]));
writeAndroidIcons();
console.log('icons written to', OUT);
