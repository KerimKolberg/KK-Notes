/**
 * Opening a `.goodnotes` notebook.
 *
 * The four layers below this one each do one job — ZIP, Apple's LZ4, protobuf,
 * and finding ink by its shape — and this is what they add up to: bytes in, a
 * document out, plus a report saying what was actually recovered.
 *
 * The report is not a nicety. GoodNotes publishes no schema, so this import is
 * inference from beginning to end, and the difference between "your notebook is
 * here" and "eleven of your fourteen pages are here, as pen strokes, and the
 * highlighters came in as pen" is the whole difference between a useful feature
 * and a misleading one. Every caller shows the report.
 *
 * Which entries hold pages is inferred too, for the same reason the strokes are:
 * an archive is walked in full and every entry that could hold geometry is
 * tried, rather than looking for a path that a future version is free to change.
 * Pages come out in natural name order, which is the only ordering the container
 * offers.
 */
import { A4_DIMENSIONS } from '../document/constants';
import { createDocument, createPage, renumber } from '../document/operations';
import type { Document, Page, PageDimensions } from '../document/types';
import { titleFromFileName } from '../desktop/notex';
import { decodeAppleLz4 } from './lz4';
import { decodeMessage } from './protobuf';
import { findCandidates, fitToPage, toStrokes, type Candidate, type Fit } from './strokes';
import { ZipError, listZipEntries, looksLikeZip, readZipEntry, type ZipEntry } from './zip';

// Re-exported so a caller that already has the importer need not know the name
// helpers live apart from it; anything that only needs the name imports
// `./names` directly and stays off this module's dependencies.
export { GOODNOTES_EXTENSION, isGoodNotesName } from './names';


/**
 * How much shape agreement a candidate needs to be drawn.
 *
 * A genuine stroke message carries more than geometry — pressures, a width, a
 * colour — so anything that agreed on nothing but "this is a run of floats that
 * varies" is more likely a matrix, a page size or a gradient stop than ink. The
 * threshold sits just above that floor: it keeps every run with any corroborating
 * shape beside it, and drops the bare ones. Set it to 0 to see everything.
 */
export const DEFAULT_MIN_CONFIDENCE = 0.45;

/** Entries that cannot hold stroke geometry, so are never inflated looking for it. */
const SKIP_EXTENSIONS = [
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'heic',
  'heif',
  'gif',
  'tiff',
  'webp',
  'mp3',
  'm4a',
  'mov',
  'mp4',
  'txt',
  'json',
  // A binary plist is full of float runs — page sizes, insets, transforms — and
  // it is exactly the kind of thing the shape search would draw as a scribble.
  'plist',
  'html',
  'css',
  'xml',
  'strings',
];

/** A single entry is not inflated past this; a notebook page is kilobytes. */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

/** Beyond this the file is not a notebook, and drawing it would hang the app. */
const MAX_STROKES = 200_000;

export interface ArchiveEntrySummary {
  readonly name: string;
  readonly bytes: number;
}

export interface ImportReport {
  readonly title: string;
  /** Pages in the document that came out. */
  readonly pages: number;
  readonly strokes: number;
  /** How the source's coordinates were mapped onto our page. */
  readonly fit: Fit;
  /** Everything the archive held, for when the answer has to be explained. */
  readonly entries: readonly ArchiveEntrySummary[];
  /** Entries that held ink, in the order their pages came out. */
  readonly pageEntries: readonly string[];
  /** Candidates the confidence threshold set aside. */
  readonly setAside: number;
  /** Things the user should know, in the words they should read. */
  readonly warnings: readonly string[];
}

/**
 * A `.goodnotes` file that could not be turned into a document.
 *
 * Carries the archive listing, because "that did not work" is not an answer a
 * user can act on and "that archive holds fourteen pages this importer could
 * not read; export it as a PDF from GoodNotes and open that" is.
 */
export class GoodNotesImportError extends Error {
  readonly entries: readonly ArchiveEntrySummary[];

  constructor(message: string, entries: readonly ArchiveEntrySummary[] = []) {
    super(message);
    this.name = 'GoodNotesImportError';
    this.entries = entries;
  }
}

function extensionOf(name: string): string {
  const base = name.split('/').pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
}

/** Could this entry hold stroke geometry? Directories and known media cannot. */
function mightHoldInk(entry: ZipEntry): boolean {
  if (entry.name.endsWith('/')) return false;
  if (entry.uncompressedSize === 0) return false;
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) return false;
  return !SKIP_EXTENSIONS.includes(extensionOf(entry.name));
}

/** Numeric-aware, so `page10` sorts after `page9` rather than after `page1`. */
function byNaturalName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

function summarise(entries: readonly ZipEntry[]): ArchiveEntrySummary[] {
  return entries.filter((entry) => !entry.name.endsWith('/')).map((entry) => ({ name: entry.name, bytes: entry.uncompressedSize }));
}

export interface ImportOptions {
  /** Shown as the document's title; the file name, normally. */
  readonly fileName?: string;
  readonly dimensions?: PageDimensions;
  /** Blank margin left around the imported ink, in page px. */
  readonly margin?: number;
  readonly minConfidence?: number;
}

export interface ImportResult {
  readonly document: Document;
  readonly report: ImportReport;
}

/**
 * Read a notebook, or explain why not.
 *
 * Two passes, and they are separate on purpose: every page's candidates are
 * gathered first, then one transform is derived from all of them at once and
 * applied. Scaling each page as it is read would give every page its own scale
 * and a notebook whose handwriting changes size from page to page.
 */
export async function importGoodNotes(bytes: Uint8Array, options: ImportOptions = {}): Promise<ImportResult> {
  const fileName = options.fileName ?? 'Notebook';
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const dimensions = options.dimensions ?? A4_DIMENSIONS;

  if (!looksLikeZip(bytes)) {
    throw new GoodNotesImportError(
      'That file is not a GoodNotes archive — it does not begin like one. A `.goodnotes` file is a ZIP container.',
    );
  }

  let entries: ZipEntry[];
  try {
    entries = listZipEntries(bytes);
  } catch (error) {
    throw new GoodNotesImportError(
      error instanceof ZipError ? error.message : `That archive could not be read: ${String(error)}`,
    );
  }

  const listing = summarise(entries);
  const warnings: string[] = [];
  const found: Array<{ name: string; candidates: Candidate[] }> = [];
  let setAside = 0;
  let unreadable = 0;

  for (const entry of [...entries].sort(byNaturalName)) {
    if (!mightHoldInk(entry)) continue;
    let candidates: Candidate[];
    try {
      const raw = await readZipEntry(bytes, entry);
      const fields = decodeMessage(decodeAppleLz4(raw));
      candidates = findCandidates(fields);
    } catch {
      // An entry that is not protobuf at all is the normal case, not a failure:
      // an archive is full of plists, thumbnails and indexes. Only worth
      // counting, in case *everything* failed.
      unreadable += 1;
      continue;
    }
    const kept = candidates.filter((candidate) => candidate.confidence >= minConfidence);
    setAside += candidates.length - kept.length;
    if (kept.length > 0) found.push({ name: entry.name, candidates: kept });
  }

  const total = found.reduce((n, page) => n + page.candidates.length, 0);
  if (total === 0) {
    throw new GoodNotesImportError(
      unreadableAdvice(listing, setAside),
      listing,
    );
  }
  if (total > MAX_STROKES) {
    throw new GoodNotesImportError(
      `That notebook holds ${total.toLocaleString()} recovered strokes, which is more than this importer will draw. Export it as a PDF from GoodNotes instead.`,
      listing,
    );
  }

  const fit = fitToPage(
    found.map((page) => page.candidates),
    dimensions,
    options.margin ?? 0,
  );
  const pages: Page[] = found.map((page, index) =>
    createPage({ strokes: toStrokes(page.candidates, fit), dimensions }, index + 1),
  );

  if (!fit.matched) {
    warnings.push(
      'The notebook’s page size could not be worked out, so the ink was scaled to fit. Pages are in proportion to each other but may not match the original page.',
    );
  }
  warnings.push(
    'Everything came in as pen strokes. GoodNotes marks highlighters, shapes, text boxes and images in ways this importer cannot read, so they are either pen or missing.',
  );
  if (listing.some((entry) => extensionOf(entry.name) === 'pdf')) {
    warnings.push(
      'This notebook was built on a PDF, which was not imported. Open the PDF itself to annotate the original pages.',
    );
  }
  if (setAside > 0) {
    warnings.push(
      `${setAside} run${setAside === 1 ? '' : 's'} of numbers looked like ink but carried nothing to confirm it, and ${setAside === 1 ? 'was' : 'were'} left out.`,
    );
  }

  const strokes = pages.reduce((n, page) => n + page.strokes.length, 0);
  const title = titleFromFileName(fileName) || 'Imported notebook';

  return {
    document: { ...createDocument(1, title), title, pages: renumber(pages) },
    report: {
      title,
      pages: pages.length,
      strokes,
      fit,
      entries: listing,
      pageEntries: found.map((page) => page.name),
      setAside,
      warnings,
    },
  };
}

/**
 * What to say when nothing was recovered.
 *
 * Naming the archive's contents is the point: it proves the file was read, shows
 * the user their pages are in there, and makes the PDF suggestion sound like
 * the next step rather than a brush-off.
 */
function unreadableAdvice(entries: readonly ArchiveEntrySummary[], setAside: number): string {
  const biggest = [...entries].sort((a, b) => b.bytes - a.bytes).slice(0, 4);
  const listed = biggest.map((entry) => entry.name).join(', ');
  const held = entries.length === 0 ? 'nothing this importer could list' : `${entries.length} files (${listed}…)`;
  const near = setAside > 0 ? ` ${setAside} run${setAside === 1 ? '' : 's'} of numbers came close but could not be confirmed as ink.` : '';
  return (
    `No strokes could be recovered from that notebook. The archive holds ${held}, but none of it decoded into stroke geometry this importer recognises —` +
    ` GoodNotes changes its format between versions and publishes no description of it.${near}` +
    ' Export the notebook as a PDF from GoodNotes and open that instead: the pages come in exactly as they look, and you can write on them.'
  );
}

/**
 * The archive's contents, without importing anything.
 *
 * For a caller that wants to say what is in a file it cannot open — and for
 * anyone diagnosing why an import found nothing.
 */
export function describeGoodNotesArchive(bytes: Uint8Array): ArchiveEntrySummary[] {
  if (!looksLikeZip(bytes)) return [];
  try {
    return summarise(listZipEntries(bytes));
  } catch {
    return [];
  }
}
