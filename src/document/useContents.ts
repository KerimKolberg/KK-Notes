import { useEffect, useMemo, useRef, useState } from 'react';
import { pdfOutline, type OutlineItem } from '../pdf/outline';
import { contentsRows, pdfSourcesOf, type ContentsRow } from './contents';
import type { Page } from './types';

/** One PDF's part of the contents list. */
export interface ContentsSection {
  readonly sourceId: string;
  readonly name: string;
  /** `null` while its outline is being read. */
  readonly rows: readonly ContentsRow[] | null;
}

/**
 * The contents of the PDFs a set of pages came from, each outline read once and pointed at these pages. Only the
 * pages' PDF references are watched, so writing on a page does not work it all out again.
 */
export function useContents(pages: readonly Page[]): readonly ContentsSection[] {
  const key = pages.map((p) => (p.pdf ? `${p.pdf.sourceId}#${p.pdf.pageIndex}` : '')).join('|');
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sources = useMemo(() => pdfSourcesOf(pagesRef.current), [key]);
  const [outlines, setOutlines] = useState<Readonly<Record<string, readonly OutlineItem[]>>>({});

  useEffect(() => {
    let live = true;
    for (const source of sources) {
      pdfOutline(source.ref).then(
        (outline) => {
          if (live) setOutlines((was) => (was[source.sourceId] === outline ? was : { ...was, [source.sourceId]: outline }));
        },
        () => {
          if (live) setOutlines((was) => ({ ...was, [source.sourceId]: [] }));
        },
      );
    }
    return () => {
      live = false;
    };
  }, [sources]);

  return useMemo(
    () =>
      sources.map((source) => {
        const outline = outlines[source.sourceId];
        return { sourceId: source.sourceId, name: source.name, rows: outline ? contentsRows(outline, pagesRef.current, source.sourceId) : null };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sources, outlines, key],
  );
}
