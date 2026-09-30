import { useDocumentStore } from '../document/store';
import { useToolStore } from '../document/toolStore';

/** Where a piece of found text is, in the note that is open. */
export interface RevealTarget {
  readonly pageIndex: number;
  readonly pageId: string;
  readonly mediaId: string | null;
}

/**
 * Take the reader to something found: its page, and for an object on the page, the object itself
 * selected. Objects can only be picked with the select tool, so that becomes the tool.
 *
 * Read from the stores rather than passed in, so it works from the library's results as well as from
 * the panel inside a note.
 */
export function revealText(target: RevealTarget): void {
  if (target.pageIndex < 0) return;
  const doc = useDocumentStore.getState();
  doc.jumpToPage(target.pageIndex);
  if (target.mediaId) {
    useToolStore.getState().update({ tool: 'select' });
    doc.selectMedia({ pageId: target.pageId, mediaId: target.mediaId });
  }
}
