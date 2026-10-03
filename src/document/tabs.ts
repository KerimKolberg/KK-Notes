/**
 * Several documents open at once, without several documents in memory at once.
 *
 * The document store holds exactly one document and always has: one set of
 * canvases, one pointer pipeline, one raster cache. That is not an accident to
 * be undone for tabs — it is why drawing is fast, and mounting five document
 * trees to get five tabs would multiply the expensive part by five to show four
 * copies of it that nobody is looking at.
 *
 * So a tab is not a mounted view. It is a **session**: the handful of fields
 * that make the store's idea of "the open document". Switching tabs captures
 * those out of the store and puts the next tab's in. One live document, N
 * remembered ones.
 *
 * ## Parking
 *
 * Remembered is still memory — strokes, media data URLs, and above all the
 * source bytes of every imported PDF, which are megabytes each. Past a few open
 * tabs that adds up on a tablet.
 *
 * A tab is therefore **parked** when it is not among the few most recently used:
 * its session is dropped entirely and only its title and path are kept, and it
 * is read back from disk when it is next activated. The rule for what may be
 * parked is the whole design:
 *
 * > A tab can be parked when re-opening it would lose nothing — it is saved on
 * > disk and has no unsaved changes. A tab with unsaved work is never parked,
 * > however old, because there is nowhere to read it back from.
 *
 * That makes the invariant `dirty → session !== null` hold at all times, and it
 * is what stops "optimising memory" from meaning "throwing away your work".
 */
import type { RedoEntry, StructureEntry } from './structureHistory';
import type { Cover, Document, Page, Recording } from './types';

/**
 * The store fields that belong to one open document.
 *
 * Deliberately only these: `selectedMedia`, `lassoSelection` and the like are
 * transient interaction state, and restoring a stale selection into a document
 * the user has come back to would be worse than starting clean.
 */
export interface TabSession {
  readonly document: Document;
  readonly filePath: string | null;
  readonly savedPages: readonly Page[] | null;
  readonly savedTitle: string | null;
  readonly savedCover: Cover | null | undefined;
  /** Absent in sessions from before recordings existed, which had none. */
  readonly savedRecordings?: readonly Recording[] | undefined;
  readonly readOnly: boolean;
  /** What Undo and Redo can take back of the note's pages; absent for a document that has been opened fresh. */
  readonly history?: { readonly undo: readonly StructureEntry[]; readonly redo: readonly RedoEntry[] };
}

export interface Tab {
  readonly id: string;
  /**
   * Title and path live on the tab rather than only in the session, because a
   * parked tab has no session and still has to be labelled and re-opened.
   */
  readonly title: string;
  readonly path: string | null;
  /** `null` when parked: the document was dropped and is re-read on activation. */
  readonly session: TabSession | null;
  /** Unsaved changes. Never true for a parked tab — see the module comment. */
  readonly dirty: boolean;
  /** Monotonic tick of the last activation, for choosing what to park. */
  readonly usedAt: number;
}

/**
 * How many tabs keep their document in memory, the active one included.
 *
 * Three rather than one because switching between two documents is the common
 * case — copying between a lecture PDF and your notes — and re-reading from disk
 * on every switch would make that feel broken. Three rather than ten because the
 * point is to bound the memory a tablet has to find.
 */
export const MAX_LIVE_TABS = 3;

/**
 * A hard cap on open tabs.
 *
 * Parked tabs cost almost nothing, so this is about the strip staying usable
 * rather than about memory — and about unsaved tabs, which cannot be parked and
 * so *do* accumulate.
 */
export const MAX_TABS = 12;

/** Is the document in this tab worth keeping in memory, or can disk hold it? */
export function isParkable(tab: Tab): boolean {
  return tab.session !== null && !tab.dirty && tab.path !== null;
}

/** Tabs holding a document in memory right now. */
export function liveTabs(tabs: readonly Tab[]): readonly Tab[] {
  return tabs.filter((tab) => tab.session !== null);
}

/**
 * Which tabs to park, oldest first, to get back to `maxLive` live documents.
 *
 * Returns ids rather than mutating, so the decision can be tested without a
 * store and the caller can release each tab's PDF sources as it goes.
 *
 * `pinned` are the tabs on screen — the one being drawn on, and the one in the
 * reference pane beside it. Parking a document that is *visible* would blank it,
 * so they are excluded however old they are. Unsaved tabs are excluded too, so
 * this can legitimately return fewer tabs than reaching the target needs:
 * bounding memory is best effort, not losing work is not.
 */
export function tabsToPark(
  tabs: readonly Tab[],
  pinned: readonly (string | null)[],
  maxLive = MAX_LIVE_TABS,
): readonly string[] {
  const onScreen = new Set(pinned.filter((id): id is string => id !== null));
  const live = liveTabs(tabs);
  // Never park below what is on screen: two visible documents need two live
  // sessions even if the budget is smaller than that.
  let excess = live.length - Math.max(onScreen.size, 1, maxLive);
  if (excess <= 0) return [];

  const candidates = live
    .filter((tab) => !onScreen.has(tab.id) && isParkable(tab))
    .sort((a, b) => a.usedAt - b.usedAt);

  const park: string[] = [];
  for (const tab of candidates) {
    if (excess <= 0) break;
    park.push(tab.id);
    excess -= 1;
  }
  return park;
}

/** Park a tab: drop its document, keep what is needed to re-open it. */
export function parkTab(tab: Tab): Tab {
  if (!isParkable(tab)) return tab;
  return { ...tab, session: null };
}

/**
 * Is this a document nobody has touched?
 *
 * Opening a file while an untouched blank document is in front replaces it,
 * rather than leaving an empty tab behind — the same thing a browser does with a
 * new tab. Asked of the session rather than the tab because the caller may be
 * holding a freshly captured one.
 */
export function isPristine(session: TabSession | null): boolean {
  if (!session) return false;
  if (session.filePath !== null) return false;
  if (session.document.pages.length !== 1) return false;
  if (session.document.cover) return false;
  // A lecture recorded without a line written is not nothing.
  if ((session.document.recordings?.length ?? 0) > 0) return false;
  const [page] = session.document.pages;
  if (!page) return false;
  return page.strokes.length === 0 && page.media.length === 0;
}

/** Every PDF source a document holds bytes for. */
export function pdfSourceIds(doc: Document): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const page of doc.pages) {
    if (page.pdf) ids.add(page.pdf.sourceId);
  }
  return ids;
}

/**
 * PDF sources a departing tab was the last holder of.
 *
 * The parsed PDF.js document and its page rasters are cached globally by source
 * id, and nothing evicted them — so before tabs, a PDF opened once stayed parsed
 * for the life of the process, and with tabs that becomes one parsed PDF per tab
 * ever opened. This is what makes releasing them safe: only sources no *live*
 * session still refers to.
 *
 * Parked tabs deliberately do not count. A parked tab re-reads its file on
 * activation, which re-opens the PDF from the bytes in it.
 */
export function releasableSources(leaving: TabSession, remaining: readonly Tab[]): readonly string[] {
  const kept = new Set<string>();
  for (const tab of remaining) {
    if (!tab.session) continue;
    for (const id of pdfSourceIds(tab.session.document)) kept.add(id);
  }
  return [...pdfSourceIds(leaving.document)].filter((id) => !kept.has(id));
}

/**
 * Does this session hold unsaved changes?
 *
 * The same reference comparison `selectIsDirty` makes against the live store,
 * but asked of a captured session — needed when a tab is being *restored*, since
 * by then the store holds somebody else's document and cannot answer for it.
 */
export function sessionIsDirty(session: TabSession): boolean {
  return (
    session.document.pages !== session.savedPages ||
    session.document.title !== session.savedTitle ||
    session.document.cover !== session.savedCover ||
    session.document.recordings !== session.savedRecordings
  );
}

/** A label for the strip: the document's title, or something rather than nothing. */
export function tabTitle(session: TabSession): string {
  const title = session.document.title.trim();
  return title === '' ? 'Untitled note' : title;
}
