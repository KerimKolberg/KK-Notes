/**
 * Counting a note's words, as a word processor's Word Count does: the typed text — text boxes and page text,
 * sticky notes, tables — and, apart, the handwriting a recogniser has read.
 */
import { addStats, NO_STATS, textStats, type TextStats } from '../document/richText';
import type { Document } from '../document/types';

export interface NoteCount {
  /** Everything typed in the note. */
  readonly typed: TextStats;
  /** Pages with something typed on them. */
  readonly pagesWithText: number;
  readonly pages: number;
  /** Words of handwriting, where it has been read (`handwriting/`); `null` if none has. */
  readonly handwriting: number | null;
}

export function countNote(doc: Document): NoteCount {
  let typed = NO_STATS;
  let pagesWithText = 0;
  let handwriting: number | null = null;
  for (const page of doc.pages) {
    const texts: string[] = [];
    for (const item of page.media) {
      if (item.kind === 'text' || item.kind === 'note') texts.push(item.text ?? '');
      else if (item.kind === 'table') texts.push(...item.cells);
    }
    const stats = textStats(texts);
    if (stats.words > 0) pagesWithText += 1;
    typed = addStats(typed, stats);
    if (page.inkText) handwriting = (handwriting ?? 0) + page.inkText.words.filter((w) => w.text.trim() !== '').length;
  }
  return { typed, pagesWithText, pages: doc.pages.length, handwriting };
}
