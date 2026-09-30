/**
 * Bookmarks: pages marked to come back to, with an optional name.
 *
 * Kept on the page itself (`Page.bookmark`), so a bookmark travels with its page when pages are moved,
 * saves with the note, and needs no separate list to keep in step. Pure; the store wraps it in an edit.
 */
import type { Page } from './types';

export const MAX_BOOKMARK_LENGTH = 200;

export interface BookmarkEntry {
  readonly pageId: string;
  readonly pageIndex: number;
  /** What the person called it; empty when they did not. */
  readonly label: string;
}

/** The page with a bookmark set (a name, or '' for unnamed), or with it taken away (`null`). */
export function withBookmark(page: Page, label: string | null): Page {
  if (label === null) {
    if (page.bookmark === undefined) return page;
    const { bookmark, ...rest } = page;
    void bookmark;
    return rest;
  }
  const clean = label.slice(0, MAX_BOOKMARK_LENGTH);
  return page.bookmark === clean ? page : { ...page, bookmark: clean };
}

/** The bookmarked pages, in page order. */
export function bookmarksOf(pages: readonly Pick<Page, 'id' | 'bookmark'>[]): BookmarkEntry[] {
  const out: BookmarkEntry[] = [];
  pages.forEach((page, pageIndex) => {
    if (page.bookmark !== undefined) out.push({ pageId: page.id, pageIndex, label: page.bookmark });
  });
  return out;
}

/** What to show for a bookmark: its name, or the page it is on. */
export function bookmarkTitle(entry: Pick<BookmarkEntry, 'label' | 'pageIndex'>): string {
  return entry.label.trim() || `Page ${entry.pageIndex + 1}`;
}

/** The next bookmarked page after `index` (wrapping round), or `null` when there are none to go to. */
export function nextBookmark(entries: readonly BookmarkEntry[], index: number, direction: 1 | -1 = 1): BookmarkEntry | null {
  const others = entries.filter((e) => e.pageIndex !== index);
  if (others.length === 0) return null;
  if (direction === 1) return others.find((e) => e.pageIndex > index) ?? others[0] ?? null;
  const before = others.filter((e) => e.pageIndex < index);
  return before[before.length - 1] ?? others[others.length - 1] ?? null;
}
