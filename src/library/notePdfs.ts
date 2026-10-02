/**
 * The words of the PDFs embedded in a saved note, for searching the library.
 *
 * A note keeps each PDF it was made from once, as base64 under `pdfSources`, and its pages point into them. The
 * words are read with PDF.js — the reader the in-note search uses, so the two find the same things — and kept by
 * source in a {@link PdfTextStore}, so a PDF is read once however often the note is saved or searched.
 */
import { base64ToArrayBuffer } from '../document/serialization';
import { joinTextItems } from '../pdf/pdfText';
import type { PdfTextStore } from './pdfTextStore';

/**
 * The `pdfSources` object of a saved note, as JSON text, found without parsing the rest of the note — its ink,
 * pictures and every other page — which is most of it. `null` when it has none.
 *
 * Only a key can be `"pdfSources":` with bare quotes (inside a string a quote is escaped), so the first match is
 * the key; from its brace the scan walks to the matching one, jumping over strings whole.
 */
export function pdfSourcesJson(contents: string): string | null {
  const key = /"pdfSources"\s*:\s*\{/.exec(contents);
  if (!key) return null;
  const start = key.index + key[0].length - 1;
  let depth = 0;
  for (let i = start; i < contents.length; i++) {
    const c = contents.charCodeAt(i);
    if (c === 34 /* " */) {
      // To the closing quote: the next one not escaped by an odd run of backslashes.
      let j = i;
      for (;;) {
        j = contents.indexOf('"', j + 1);
        if (j < 0) return null;
        let slashes = 0;
        for (let k = j - 1; contents.charCodeAt(k) === 92; k--) slashes++;
        if (slashes % 2 === 0) break;
      }
      i = j;
    } else if (c === 123 /* { */) depth++;
    else if (c === 125 /* } */) {
      depth--;
      if (depth === 0) return contents.slice(start, i + 1);
    }
  }
  return null;
}

/** The bytes of the wanted sources of a saved note. */
export function pdfSourcesOf(contents: string, wanted: ReadonlySet<string>): Map<string, ArrayBuffer> {
  const out = new Map<string, ArrayBuffer>();
  if (wanted.size === 0) return out;
  let sources: unknown = null;
  const json = pdfSourcesJson(contents);
  try {
    if (json) sources = JSON.parse(json);
    else {
      // Something the scan did not expect: read the note the slow way.
      const parsed = JSON.parse(contents) as { document?: { pdfSources?: unknown }; pdfSources?: unknown };
      sources = parsed.document?.pdfSources ?? parsed.pdfSources ?? null;
    }
  } catch {
    return out;
  }
  if (!sources || typeof sources !== 'object') return out;
  for (const id of wanted) {
    const data = (sources as Record<string, { data?: unknown } | undefined>)[id]?.data;
    if (typeof data !== 'string') continue;
    try {
      out.set(id, base64ToArrayBuffer(data));
    } catch {
      // Not base64: no words from this one.
    }
  }
  return out;
}

/** Each page's words, read from a PDF's bytes. */
export async function readPdfWords(data: ArrayBuffer): Promise<string[]> {
  const { openPdfDocument, destroyPdfDocument } = await import('../pdf/pdfjs');
  const doc = await openPdfDocument(data);
  try {
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(joinTextItems(content.items as Parameters<typeof joinTextItems>[0]));
      page.cleanup();
    }
    return pages;
  } finally {
    await destroyPdfDocument(doc).catch(() => undefined);
  }
}

/** What the library index asks of the PDFs in its notes. */
export interface PdfWords {
  /** The words of each page of each of these sources of the note at `path`; a source with none is left out. */
  read(path: string, sourceIds: readonly string[]): Promise<Map<string, readonly string[]>>;
  /** Forget every source not in `live`: the notes that had them are gone, or no longer have them. */
  prune(live: ReadonlySet<string>): Promise<void>;
}

/**
 * Words from the store when it has them; otherwise the note is read for those sources' bytes, which are read for
 * their words, which are stored. A PDF that cannot be read is stored as having no words, so it is not tried at
 * every search.
 */
export function createPdfWords(
  store: PdfTextStore,
  readContents: (path: string) => Promise<string>,
  extract: (data: ArrayBuffer) => Promise<string[]> = readPdfWords,
): PdfWords {
  return {
    async read(path, sourceIds) {
      const out = new Map<string, readonly string[]>();
      const missing = new Set<string>();
      for (const id of new Set(sourceIds)) {
        const kept = await store.get(id);
        if (kept) out.set(id, kept);
        else missing.add(id);
      }
      if (missing.size === 0) return out;
      const sources = pdfSourcesOf(await readContents(path), missing);
      for (const [id, data] of sources) {
        let words: string[];
        try {
          words = await extract(data);
        } catch {
          words = [];
        }
        await store.put(id, words);
        out.set(id, words);
      }
      return out;
    },
    async prune(live) {
      for (const id of await store.keys()) if (!live.has(id)) await store.delete(id);
    },
  };
}
