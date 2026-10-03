/**
 * Finding words in a note.
 *
 * What can be searched is the text that is *text*: a note's title, its text boxes, its sticky
 * notes, the cells of its tables, (asynchronously, see `pdfText.ts`) the words of a PDF it was
 * made from, and its handwriting as far as a recogniser has read it (`handwriting/`).
 *
 * Pure: a document's pages in, matches out. The matching ignores case and accents, so "cafe"
 * finds "Café" and "STRASSE" finds "straße"'s cousin "Strasse"; a query of several words finds
 * the places where every one of them occurs.
 */

import type { InkWord } from '../document/types';
import { inkPageText, type InkSpan } from '../handwriting/inkText';

export type TextKind = 'title' | 'text' | 'note' | 'table' | 'ink' | 'pdf';

/** One piece of searchable text, and where in the note it is. */
export interface TextSource {
  /** `-1` for the title, which belongs to no page. */
  readonly pageIndex: number;
  readonly pageId: string;
  /** The object it is on, when it is on one. */
  readonly mediaId: string | null;
  readonly kind: TextKind;
  readonly text: string;
  /** For handwriting: where each word is in `text` and on the page, to point at the one a match is in. */
  readonly spans?: readonly InkSpan[];
}

interface SearchablePage {
  readonly id: string;
  readonly media?: readonly SearchableMedia[];
  readonly inkText?: { readonly words: readonly InkWord[] };
}

type SearchableMedia =
  | { readonly kind: 'text'; readonly id: string; readonly text: string }
  | { readonly kind: 'note'; readonly id: string; readonly text: string }
  | { readonly kind: 'table'; readonly id: string; readonly cells: readonly string[] }
  | { readonly kind: 'image'; readonly id: string };

/** Text folded for comparison, with where each folded character came from in the original. */
interface Folded {
  readonly text: string;
  /** `origin[i]` is the index in the original of folded character `i`; one more entry marks the end. */
  readonly origin: readonly number[];
}

/**
 * Lower-cased, accents removed, and a map back to the original. Folding can change a string's length
 * (a precomposed letter may become two code points, one of them a mark that is dropped), so a match's
 * position in the folded text is not its position in the text that was typed.
 */
export function fold(text: string): Folded {
  let out = '';
  const origin: number[] = [];
  let i = 0;
  for (const ch of text) {
    const folded = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (let k = 0; k < folded.length; k++) origin.push(i);
    out += folded;
    i += ch.length;
  }
  origin.push(text.length);
  return { text: out, origin };
}

/** The words of a query, folded; empty when there is nothing to look for. */
export function queryWords(query: string): string[] {
  return fold(query)
    .text.split(/\s+/)
    .filter((w) => w.length > 0);
}

/** Every piece of searchable text in a note: its title, then each page's typed text and tables, then its handwriting. */
export function documentSources(doc: { readonly title: string; readonly pages: readonly SearchablePage[] }): TextSource[] {
  const out: TextSource[] = [];
  if (doc.title.trim()) out.push({ pageIndex: -1, pageId: '', mediaId: null, kind: 'title', text: doc.title });
  doc.pages.forEach((page, pageIndex) => {
    for (const item of page.media ?? []) {
      if (item.kind === 'text' || item.kind === 'note') {
        if (item.text.trim()) out.push({ pageIndex, pageId: page.id, mediaId: item.id, kind: item.kind, text: item.text });
      } else if (item.kind === 'table') {
        for (const cell of item.cells) {
          if (cell.trim()) out.push({ pageIndex, pageId: page.id, mediaId: item.id, kind: 'table', text: cell });
        }
      }
    }
    // The page's handwriting as one text, so a phrase written along a line is found as one.
    if (page.inkText && page.inkText.words.length > 0) {
      const { text, spans } = inkPageText(page.inkText.words);
      if (text.trim()) out.push({ pageIndex, pageId: page.id, mediaId: null, kind: 'ink', text, spans });
    }
  });
  return out;
}

export interface SearchHit {
  readonly source: TextSource;
  /** Where the first match starts and ends in the source's own text. */
  readonly start: number;
  readonly end: number;
  /** The match with some of what is either side, for showing. */
  readonly before: string;
  readonly match: string;
  readonly after: string;
}

const CONTEXT_BEFORE = 36;
const CONTEXT_AFTER = 72;

/** Collapse runs of whitespace (a text box's line breaks, most of all) into one space, for one-line display. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/**
 * The sources in which every word of `query` occurs, each as a hit on its first word to match, in
 * document order. `limit` bounds the list: a one-letter query in a long note would otherwise be
 * every source in it.
 */
export function searchSources(sources: readonly TextSource[], query: string, limit = 200): SearchHit[] {
  const words = queryWords(query);
  if (words.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const source of sources) {
    const folded = fold(source.text);
    let first = -1;
    let firstLength = 0;
    let all = true;
    for (const word of words) {
      const at = folded.text.indexOf(word);
      if (at < 0) {
        all = false;
        break;
      }
      if (first < 0 || at < first) {
        first = at;
        firstLength = word.length;
      }
    }
    if (!all || first < 0) continue;
    const start = folded.origin[first] ?? 0;
    const end = folded.origin[Math.min(first + firstLength, folded.origin.length - 1)] ?? source.text.length;
    hits.push({
      source,
      start,
      end,
      before: (start > CONTEXT_BEFORE ? '…' : '') + oneLine(source.text.slice(Math.max(0, start - CONTEXT_BEFORE), start)),
      match: oneLine(source.text.slice(start, end)),
      after: oneLine(source.text.slice(end, end + CONTEXT_AFTER)) + (end + CONTEXT_AFTER < source.text.length ? '…' : ''),
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** The kinds in the order they are worth listing: the title first, then what is typed, then the PDF's own words. */
export const KIND_LABELS: Readonly<Record<TextKind, string>> = {
  title: 'Title',
  text: 'Text box',
  note: 'Sticky note',
  table: 'Table',
  ink: 'Handwriting',
  pdf: 'PDF',
};
