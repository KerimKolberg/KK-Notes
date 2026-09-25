/**
 * Bundle guard: the entry chunk referenced by dist/index.html (and every
 * chunk it imports statically) must not contain pdfjs-dist, pdf-lib or the
 * GoodNotes importer, and each must exist in a separate, lazily-loaded chunk.
 *
 * The GoodNotes importer is in here because it is easy to pull onto the critical
 * path by accident: one static import of a constant from it drags a ZIP reader,
 * an LZ4 decoder and a protobuf walker along, and nothing else complains.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;
const assets = join(dist, 'assets');
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const entry = html.match(/<script[^>]+type="module"[^>]+src="\/?assets\/([^"]+)"/)?.[1];
if (!entry) {
  console.error('check-bundle: could not find the entry module in dist/index.html');
  process.exit(1);
}

const SIGNATURES = {
  'pdfjs-dist': [/GlobalWorkerOptions/, /pdf\.worker/, /PDFPageProxy|getDocument\(/],
  'pdf-lib': [/PDFDocument\b/, /PDFHexString|PDFContentStream|drawSvgPath/],
  // Error strings the importer's layers own, and which minification keeps.
  'goodnotes import': [
    /end-of-central-directory/,
    /compressed block/,
    /not a protobuf wire type/,
    /No strokes could be recovered/,
  ],
};

const files = readdirSync(assets).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
const content = new Map(files.map((f) => [f, readFileSync(join(assets, f), 'utf8')]));

/** Chunks reachable through *static* imports from the entry (the critical path). */
function staticClosure(start) {
  const seen = new Set();
  const queue = [start];
  while (queue.length) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const source = content.get(file) ?? '';
    for (const m of source.matchAll(/(?:^|[;\n])import\s*(?:[^'"]*?\s*from\s*)?["']\.\/([^"']+\.m?js)["']/g)) queue.push(m[1]);
  }
  return seen;
}

const critical = staticClosure(entry);
const hits = (source, sigs) => sigs.filter((re) => re.test(source)).length;
let failed = false;
for (const [lib, sigs] of Object.entries(SIGNATURES)) {
  const inCritical = [...critical].filter((f) => hits(content.get(f) ?? '', sigs) >= 2);
  const lazyChunks = files.filter((f) => !critical.has(f) && hits(content.get(f) ?? '', sigs) >= 2);
  if (inCritical.length > 0) {
    console.error(`FAIL  ${lib} is in the critical path: ${inCritical.join(', ')}`);
    failed = true;
  } else if (lazyChunks.length === 0) {
    console.error(`FAIL  ${lib} not found in any lazy chunk (was it dropped?)`);
    failed = true;
  } else {
    const sizes = lazyChunks.map((f) => `${f} (${(statSync(join(assets, f)).size / 1024).toFixed(0)} kB)`);
    console.log(`PASS  ${lib} isolated in lazy chunk(s): ${sizes.join(', ')}`);
  }
}
const criticalBytes = [...critical].reduce((sum, f) => sum + statSync(join(assets, f)).size, 0);
console.log(`INFO  critical path: ${[...critical].join(', ')} = ${(criticalBytes / 1024).toFixed(0)} kB`);
process.exit(failed ? 1 : 0);
