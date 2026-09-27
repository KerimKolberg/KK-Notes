/**
 * The open documents, as a strip under the top bar.
 *
 * Only shown when more than one is open: a single tab is what every notes app
 * looks like anyway, and a strip that is always there would spend a row of a
 * 13-inch tablet saying "you have one document open".
 *
 * The active tab's label and dirty marker come from the document store, so they
 * follow a rename or the first stroke immediately. That costs nothing on the
 * drawing path: both are reference comparisons in a selector, so a stroke
 * re-renders this only on the transition from saved to unsaved, once.
 */
import { useCallback } from 'react';
import { X } from 'lucide-react';
import { selectIsDirty, useDocumentStore } from '../store';
import { useTabStore } from '../tabStore';
import { useDesktopStore } from '../../desktop/desktopStore';
import { confirmDiscard } from '../../desktop/fileService';

export function TabStrip(): React.JSX.Element | null {
  const tabs = useTabStore((s) => s.tabs);
  const activeId = useTabStore((s) => s.activeId);
  const activate = useTabStore((s) => s.activate);
  const close = useTabStore((s) => s.close);
  // The live document's own title and dirty state, for whichever tab is active.
  const liveTitle = useDocumentStore((s) => s.document.title);
  const liveDirty = useDocumentStore(selectIsDirty);

  const onClose = useCallback(
    (id: string, dirty: boolean, title: string) => {
      void (async () => {
        // Closing a tab is the one place unsaved work can vanish without the
        // document being on screen to show for it, so it asks.
        if (dirty && !(await confirmDiscard(`“${title}” has unsaved changes. Close it anyway?`))) return;
        try {
          await close(id);
        } catch (error) {
          useDesktopStore
            .getState()
            .setNotice({ text: `Could not close ${title}: ${error instanceof Error ? error.message : String(error)}` });
        }
      })();
    },
    [close],
  );

  if (tabs.length < 2) return null;

  return (
    <div
      className="flex shrink-0 items-stretch gap-1 overflow-x-auto border-b border-zinc-200 bg-zinc-50 px-1 dark:border-zinc-800 dark:bg-zinc-900"
      role="tablist"
      aria-label="Open documents"
      data-tab-strip
    >
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        const title = active ? (liveTitle.trim() === '' ? 'Untitled note' : liveTitle) : tab.title;
        const dirty = active ? liveDirty : tab.dirty;
        return (
          <div
            key={tab.id}
            className={`group flex min-w-0 shrink-0 items-center gap-1 rounded-t-lg border-b-2 pl-2.5 pr-1 ${
              active
                ? 'border-blue-500 bg-white dark:bg-zinc-950'
                : 'border-transparent text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'
            }`}
            data-tab
            data-tab-active={active || undefined}
            // A parked tab is a normal tab that happens to be read back from
            // disk when tapped; surfaced only for the tests and the curious.
            data-tab-parked={tab.session === null || undefined}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => void activate(tab.id)}
              className="min-w-0 max-w-[10rem] truncate py-2 text-left text-xs font-medium"
              title={tab.path ?? title}
            >
              {title}
              {dirty && (
                <span className="ml-1 text-blue-500" aria-label="Unsaved changes" data-tab-dirty>
                  •
                </span>
              )}
            </button>
            <button
              type="button"
              aria-label={`Close ${title}`}
              data-tab-close
              onClick={() => onClose(tab.id, dirty, title)}
              // Always hit-testable at 44 px even though the icon is small: this
              // is a touch target on a tablet, not a hover affordance.
              className="flex h-11 w-7 items-center justify-center rounded text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
            >
              <X size={13} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
