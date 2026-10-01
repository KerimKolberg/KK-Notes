/**
 * The open tabs, and the one live document behind them.
 *
 * See `tabs.ts` for why a tab is a captured *session* rather than a mounted
 * view. This is the store that owns the list and moves sessions in and out of
 * {@link useDocumentStore}, which continues to hold exactly one document and to
 * know nothing about tabs — every existing action, selector and undo stack keeps
 * working on "the open document" unchanged.
 *
 * Nothing here runs on the drawing hot path. A stroke changes the document
 * store; this store is touched only when a tab is opened, switched or closed, so
 * the strip cannot cost frames.
 */
import { create } from 'zustand';
import { createStrokeId } from '../inking/engine/ids';
import { useDocumentStore } from './store';
import {
  MAX_TABS,
  isPristine,
  parkTab,
  releasableSources,
  sessionIsDirty,
  tabTitle,
  tabsToPark,
  type Tab,
  type TabSession,
} from './tabs';

/** Read the live document out of the document store as a session. */
export function captureSession(): TabSession {
  const s = useDocumentStore.getState();
  return {
    document: s.document,
    filePath: s.filePath,
    savedPages: s.savedPages,
    savedTitle: s.savedTitle,
    savedCover: s.savedCover,
    readOnly: s.readOnly,
    history: { undo: s.structureUndo, redo: s.structureRedo },
  };
}

/** Put a session back into the document store, becoming the live document. */
export function restoreSession(session: TabSession): void {
  useDocumentStore.setState({
    document: session.document,
    filePath: session.filePath,
    savedPages: session.savedPages,
    savedTitle: session.savedTitle,
    savedCover: session.savedCover,
    readOnly: session.readOnly,
    structureUndo: session.history?.undo ?? [],
    structureRedo: session.history?.redo ?? [],
    // Interaction state belongs to the moment, not the document: a selection
    // restored into a document the user has just come back to is a selection
    // they did not make.
    selectedMedia: null,
    lassoSelection: null,
    scrollRequest: 0,
  });
}

/** Free the PDFs a departing session was the last to hold. */
async function releaseSession(leaving: TabSession, remaining: readonly Tab[]): Promise<void> {
  const sources = releasableSources(leaving, remaining);
  if (sources.length === 0) return;
  const { releasePdfSource } = await import('../pdf/pdfRenderer');
  for (const id of sources) releasePdfSource(id);
}

/** The narrowest window a side-by-side split is worth offering on, in CSS px. */
export const MIN_SPLIT_WIDTH = 900;

export interface TabStore {
  tabs: readonly Tab[];
  activeId: string | null;
  /** Monotonic tick, so "least recently used" does not depend on the clock. */
  clock: number;
  /**
   * The tab shown in the reference pane beside the editor, if any.
   *
   * Read-only by design: it renders from the tab's captured session through the
   * page rasteriser, so it costs one cached texture per visible page and has no
   * pointer pipeline, no live canvases and no animation frame of its own. Two
   * *editable* panes would mean pane-scoping all 94 places that read the document
   * store, and two of everything that makes drawing fast — which is the opposite
   * of the trade this app makes.
   */
  splitId: string | null;
  /** Fraction of the stage the editor keeps, 0.25–0.75. */
  splitRatio: number;
  /** Which side the reference pane is on. */
  splitSide: 'right' | 'left';

  /**
   * Open a document in a tab and make it live.
   *
   * Reuses the active tab when it holds a blank untouched document, so opening a
   * file from the library does not leave an empty tab behind it.
   */
  openTab: (session: TabSession) => string;
  /** Adopt whatever the document store already holds as the first tab. */
  adoptCurrent: () => string;
  activate: (id: string) => Promise<void>;
  close: (id: string) => Promise<void>;
  /**
   * Drop the documents of tabs past the live budget, freeing their PDFs.
   *
   * Public because the rule is worth exercising directly in a test, and because
   * a caller that has just made memory pressure worse (a large import) can ask
   * for it without waiting for the next tab switch.
   */
  park: () => Promise<void>;
  /**
   * Take the document the store *now* holds as a new tab, putting `previous`
   * back on the tab it came from.
   *
   * For the loaders that open a document by writing straight into the document
   * store — which is all of them, and reasonably so, since that is what opening a
   * document meant before tabs existed. Rather than rewrite each to hand back a
   * document instead, the caller captures what was open, runs the loader, and
   * calls this; {@link openDocumentInTab} does that bracketing.
   */
  adoptLoaded: (previous: TabSession, previousId: string | null) => string;
  /** Show a tab in the reference pane. Ignored for the tab already being edited. */
  showInSplit: (id: string) => Promise<void>;
  closeSplit: () => void;
  setSplitRatio: (ratio: number) => void;
  /** Put the reference pane on the other side, which puts the editor on the other side too. */
  swapSides: () => void;
  /**
   * Swap what each half is for: the document in the pane becomes the one being edited, and the one that was being
   * edited goes into the pane to be read. Neither has to be saved first — the pane renders a captured session, and
   * both stay in memory while they are on screen.
   */
  swapRoles: () => Promise<void>;
}

function nextId(): string {
  return `tab_${createStrokeId()}`;
}

export const useTabStore = create<TabStore>()((set, get) => ({
  tabs: [],
  activeId: null,
  clock: 1,
  splitId: null,
  splitRatio: 0.6,
  splitSide: 'right',

  openTab: (session) => {
    const { tabs, activeId, clock } = get();
    const active = tabs.find((tab) => tab.id === activeId) ?? null;
    // Read out of the store rather than off the tab record. The record's `dirty`
    // and `title` are only as fresh as the last transition, and the decision
    // below turns on them: a renamed document would look untouched and be
    // *replaced*, losing the rename. This is also why no subscription is needed
    // to keep those fields live — nothing reads them until they are rewritten
    // from a captured session, and that capture is the truth.
    const live = active?.session ? captureSession() : null;

    // A blank untouched tab is replaced rather than added to.
    if (active && live && !sessionIsDirty(live) && isPristine(live)) {
      const replaced: Tab = {
        ...active,
        title: tabTitle(session),
        path: session.filePath,
        session,
        dirty: false,
        usedAt: clock + 1,
      };
      set({
        tabs: tabs.map((tab) => (tab.id === active.id ? replaced : tab)),
        clock: clock + 1,
      });
      restoreSession(session);
      return active.id;
    }

    if (tabs.length >= MAX_TABS) {
      throw new Error(`Only ${MAX_TABS} tabs can be open at once. Close one first.`);
    }

    // The outgoing tab keeps its work, and its label: both come from the session
    // captured here, so the record is correct without anything having watched it.
    const captured =
      active && live
        ? { ...active, session: live, title: tabTitle(live), path: live.filePath, dirty: sessionIsDirty(live) }
        : active;
    const id = nextId();
    const opened: Tab = {
      id,
      title: tabTitle(session),
      path: session.filePath,
      session,
      dirty: false,
      usedAt: clock + 1,
    };
    const withCapture = captured ? tabs.map((tab) => (tab.id === captured.id ? captured : tab)) : tabs;
    set({ tabs: [...withCapture, opened], activeId: id, clock: clock + 1 });
    restoreSession(session);
    void get().park();
    return id;
  },

  adoptCurrent: () => {
    const existing = get().activeId;
    if (existing) return existing;
    const session = captureSession();
    const id = nextId();
    const { clock } = get();
    set({
      tabs: [
        {
          id,
          title: tabTitle(session),
          path: session.filePath,
          session,
          dirty: sessionIsDirty(session),
          usedAt: clock + 1,
        },
      ],
      activeId: id,
      clock: clock + 1,
    });
    return id;
  },

  activate: async (id) => {
    const { tabs, activeId, clock } = get();
    if (id === activeId) return;
    const target = tabs.find((tab) => tab.id === id);
    if (!target) return;
    // Editing what the reference pane is showing: the document that was being edited takes its place in the pane,
    // so the two swap rather than one being shown beside itself (or the pane being lost).
    const takesOverPane = get().splitId === id;

    // Captured with its label, so the record is right without anything watching.
    const outgoing = tabs.find((tab) => tab.id === activeId) ?? null;
    let captured = outgoing;
    if (outgoing?.session) {
      const live = captureSession();
      captured = { ...outgoing, session: live, title: tabTitle(live), path: live.filePath, dirty: sessionIsDirty(live) };
    }

    // A parked tab has to come back off disk before it can be shown.
    let session = target.session;
    if (!session) {
      // Only ever true for a tab that was parked, and parking requires a path —
      // so this is a broken invariant rather than a situation to handle.
      if (!target.path) throw new Error(`“${target.title}” cannot be reopened: it was never saved.`);
      const { openDocumentFromPath } = await import('../desktop/fileService');
      const loaded = await openDocumentFromPath(target.path);
      session = {
        document: loaded.document,
        filePath: target.path,
        savedPages: loaded.document.pages,
        savedTitle: loaded.document.title,
        savedCover: loaded.document.cover,
        readOnly: false,
      };
    }

    const now = clock + 1;
    set({
      tabs: tabs.map((tab) => {
        if (tab.id === captured?.id) return captured;
        if (tab.id === id) {
          return {
            ...tab,
            session,
            usedAt: now,
            title: tabTitle(session),
            path: session.filePath,
            dirty: sessionIsDirty(session),
          };
        }
        return tab;
      }),
      activeId: id,
      clock: now,
      ...(takesOverPane ? { splitId: outgoing?.id ?? null } : {}),
    });
    restoreSession(session);
    void get().park();
  },

  close: async (id) => {
    const { tabs, activeId } = get();
    const closing = tabs.find((tab) => tab.id === id);
    if (!closing) return;
    // A closed document cannot stay on screen beside the editor.
    if (get().splitId === id) set({ splitId: null });

    const remaining = tabs.filter((tab) => tab.id !== id);
    // The session the store holds is newer than the captured one for the active
    // tab, so release what is actually in memory.
    const leaving = id === activeId ? captureSession() : closing.session;

    if (remaining.length === 0) {
      set({ tabs: [], activeId: null });
      if (leaving) void releaseSession(leaving, []);
      useDocumentStore.getState().newDocument();
      get().adoptCurrent();
      return;
    }

    if (id === activeId) {
      // Fall to the neighbour on the right, then the left — where the eye is.
      const index = tabs.findIndex((tab) => tab.id === id);
      const next = tabs[index + 1] ?? tabs[index - 1]!;
      set({ tabs: remaining });
      if (leaving) void releaseSession(leaving, remaining);
      set({ activeId: null });
      await get().activate(next.id);
      return;
    }

    set({ tabs: remaining });
    if (leaving) void releaseSession(leaving, remaining);
  },

  adoptLoaded: (previous, previousId) => {
    const { tabs, clock } = get();
    const loaded = captureSession();
    const previousTab = previousId ? tabs.find((tab) => tab.id === previousId) : undefined;

    // A blank untouched document is replaced rather than left behind, the same
    // rule `openTab` follows — asked of `previous`, since the store has moved on.
    if (previousTab && !previousTab.dirty && isPristine(previous)) {
      const replaced: Tab = {
        ...previousTab,
        title: tabTitle(loaded),
        path: loaded.filePath,
        session: loaded,
        dirty: false,
        usedAt: clock + 1,
      };
      set({
        tabs: tabs.map((tab) => (tab.id === previousTab.id ? replaced : tab)),
        activeId: previousTab.id,
        clock: clock + 1,
      });
      return previousTab.id;
    }

    if (tabs.length >= MAX_TABS) {
      // The document is already loaded, so refusing now would leave the store
      // holding something with no tab. Reuse the tab it came from instead and
      // say nothing: the alternative is losing the open document entirely.
      const target = previousTab ?? tabs[tabs.length - 1];
      if (target) {
        set({
          tabs: tabs.map((tab) =>
            tab.id === target.id
              ? { ...tab, title: tabTitle(loaded), path: loaded.filePath, session: loaded, dirty: false, usedAt: clock + 1 }
              : tab,
          ),
          activeId: target.id,
          clock: clock + 1,
        });
        return target.id;
      }
    }

    const id = nextId();

    // No tab for what was open. Reachable only before any document view has
    // mounted — the mount adopts one — but if that document was real work it
    // needs a tab of its own, or opening this one discards it silently.
    if (!previousTab && !isPristine(previous)) {
      const ownTab = nextId();
      set({
        tabs: [
          ...tabs,
          {
            id: ownTab,
            title: tabTitle(previous),
            path: previous.filePath,
            session: previous,
            dirty: sessionIsDirty(previous),
            usedAt: clock + 1,
          },
          { id, title: tabTitle(loaded), path: loaded.filePath, session: loaded, dirty: false, usedAt: clock + 2 },
        ],
        activeId: id,
        clock: clock + 2,
      });
      void get().park();
      return id;
    }

    // The outgoing tab's label has to be restored along with its session. The
    // loader overwrote the document store before getting here, so reading the
    // label from the store at this point would give the *incoming* document's
    // name — which showed up as two tabs both called "Second", one holding
    // "First".
    const restored = previousTab
      ? {
          ...previousTab,
          session: previous,
          title: tabTitle(previous),
          path: previous.filePath,
          dirty: sessionIsDirty(previous),
        }
      : null;
    const withPrevious = restored ? tabs.map((tab) => (tab.id === restored.id ? restored : tab)) : tabs;
    set({
      tabs: [
        ...withPrevious,
        { id, title: tabTitle(loaded), path: loaded.filePath, session: loaded, dirty: false, usedAt: clock + 1 },
      ],
      activeId: id,
      clock: clock + 1,
    });
    void get().park();
    return id;
  },

  showInSplit: async (id) => {
    const { tabs, activeId, splitId } = get();
    // The document being edited is already on screen; showing it twice would
    // mean rendering a stale session beside the live one.
    if (id === activeId || id === splitId) return;
    const target = tabs.find((tab) => tab.id === id);
    if (!target) return;

    if (target.session) {
      set({ splitId: id });
      return;
    }
    // Parked, so it has to come back off disk before it can be shown — the same
    // read `activate` does, without taking over the editor.
    if (!target.path) return;
    const { openDocumentFromPath } = await import('../desktop/fileService');
    const loaded = await openDocumentFromPath(target.path);
    const session: TabSession = {
      document: loaded.document,
      filePath: target.path,
      savedPages: loaded.document.pages,
      savedTitle: loaded.document.title,
      savedCover: loaded.document.cover,
      readOnly: true,
    };
    set({
      tabs: get().tabs.map((tab) => (tab.id === id ? { ...tab, session, title: tabTitle(session) } : tab)),
      splitId: id,
    });
  },

  closeSplit: () => {
    if (get().splitId === null) return;
    set({ splitId: null });
    // Whatever was only being kept live for the pane can go now.
    void get().park();
  },

  setSplitRatio: (ratio) => set({ splitRatio: Math.min(0.75, Math.max(0.25, ratio)) }),

  swapSides: () => set({ splitSide: get().splitSide === 'right' ? 'left' : 'right' }),

  swapRoles: async () => {
    const { splitId } = get();
    if (splitId) await get().activate(splitId);
  },

  /**
   * Park what the budget says to, releasing each one's PDFs.
   *
   * Called after every activation and open rather than on a timer, because the
   * only moment the live set changes is when a tab does.
   */
  park: async () => {
    const { tabs, activeId } = get();
    if (!activeId) return;
    const ids = tabsToPark(tabs, [activeId, get().splitId]);
    if (ids.length === 0) return;
    const parked = tabs.map((tab) => (ids.includes(tab.id) ? parkTab(tab) : tab));
    set({ tabs: parked });
    for (const id of ids) {
      const leaving = tabs.find((tab) => tab.id === id)?.session;
      if (leaving) await releaseSession(leaving, parked);
    }
  },
}));

/**
 * Run a loader that opens a document, and land the result in a new tab.
 *
 * The one thing every door into the app now goes through, so that opening a
 * second document adds to what is open instead of replacing it — which is the
 * whole point of tabs, and was the surprising part of dropping a file on a page
 * before them.
 *
 * A loader that opens nothing leaves no trace: the previous document is put back
 * exactly as it was, because some loaders overwrite the store *before* they
 * discover they cannot finish.
 */
export async function openDocumentInTab(load: () => Promise<boolean>): Promise<boolean> {
  const previous = captureSession();
  const previousId = useTabStore.getState().activeId;
  let opened = false;
  try {
    opened = await load();
  } finally {
    if (opened) useTabStore.getState().adoptLoaded(previous, previousId);
    else restoreSession(previous);
  }
  return opened;
}

/**
 * Nothing subscribes to the document store on behalf of tabs, on purpose.
 *
 * An earlier version did: one selector-less `useDocumentStore.subscribe` that
 * re-derived the active tab's label on *every* mutation — every stroke committed,
 * every frame of a pinch-zoom. Measured at 349 ns a call, which is 0.006% of a
 * 180 Hz frame and genuinely negligible. Removed anyway, because it did not need
 * to exist: a tab's label is written from the session captured when it stops
 * being active, and the strip reads the live document directly for the tab that
 * *is* active. There is nothing in between for a watcher to keep in step, so
 * tabs now cost nothing at all while one document is open.
 */

