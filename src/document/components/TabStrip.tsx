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
import { useCallback, useState } from 'react';
import { Columns2, X } from 'lucide-react';
import { selectIsDirty, useDocumentStore } from '../store';
import { MIN_SPLIT_WIDTH, useTabStore } from '../tabStore';
import { useDesktopStore } from '../../desktop/desktopStore';

/**
 * The strip, or nothing.
 *
 * Split in two so that with one document open — the common case, and the one the
 * drawing experience is judged on — *nothing* in the tab feature subscribes to the
 * document store at all. The selectors that follow the live title and dirty state
 * live in {@link Bar}, which is only mounted once there is a second tab to label.
 */
export function TabStrip(): React.JSX.Element | null {
  const count = useTabStore((s) => s.tabs.length);
  if (count < 2) return null;
  return <Bar />;
}

function Bar(): React.JSX.Element {
  const tabs = useTabStore((s) => s.tabs);
  const activeId = useTabStore((s) => s.activeId);
  const activate = useTabStore((s) => s.activate);
  const close = useTabStore((s) => s.close);
  const splitId = useTabStore((s) => s.splitId);
  const showInSplit = useTabStore((s) => s.showInSplit);
  const closeSplit = useTabStore((s) => s.closeSplit);
  // Side by side is only worth offering where there is room for two documents;
  // on a phone it would leave two unusable columns.
  const roomToSplit = typeof window === 'undefined' ? false : window.innerWidth >= MIN_SPLIT_WIDTH;
  // The live document's own title and dirty state, for whichever tab is active.
  // Both are reference comparisons, so a stroke re-renders this only on the one
  // transition from saved to unsaved.
  const liveTitle = useDocumentStore((s) => s.document.title);
  const liveDirty = useDocumentStore(selectIsDirty);

  /** The tab whose close is waiting on an answer about its unsaved changes. */
  const [pending, setPending] = useState<{ id: string; title: string } | null>(null);

  const closeNow = useCallback(
    (id: string, title: string) => {
      void (async () => {
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

  const onClose = useCallback(
    (id: string, dirty: boolean, title: string) => {
      // Closing is the one place unsaved work can vanish with the document not on
      // screen to show for it — so it asks, and offers to save rather than making
      // the choice "lose it or keep the tab forever".
      if (dirty) {
        setPending({ id, title });
        return;
      }
      closeNow(id, title);
    },
    [closeNow],
  );

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
            data-tab-id={tab.id}
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
            {roomToSplit && !active && (
              <button
                type="button"
                aria-label={tab.id === splitId ? `Stop showing ${title} beside the editor` : `Show ${title} beside the editor`}
                data-tab-split
                data-tab-split-on={tab.id === splitId || undefined}
                onClick={() => (tab.id === splitId ? closeSplit() : void showInSplit(tab.id))}
                className={`flex h-11 w-7 items-center justify-center rounded ${
                  tab.id === splitId
                    ? 'text-blue-600 dark:text-blue-400'
                    : 'text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-100'
                }`}
              >
                <Columns2 size={13} aria-hidden="true" />
              </button>
            )}
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
      {pending && (
        <CloseDialog
          title={pending.title}
          onCancel={() => setPending(null)}
          onDiscard={() => {
            const { id, title } = pending;
            setPending(null);
            closeNow(id, title);
          }}
          onSave={() => {
            const { id, title } = pending;
            setPending(null);
            void (async () => {
              // Save acts on the *live* document, so a tab being saved has to be
              // the live one first. Activating it is also the honest thing: it
              // shows what is about to be written.
              if (id !== useTabStore.getState().activeId) await activate(id);
              const { actionSave } = await import('../../desktop/fileActions');
              // A failed or cancelled save leaves the tab open — closing anyway
              // would be the data loss the prompt exists to prevent.
              if (!(await actionSave())) return;
              closeNow(id, title);
            })().catch((error: unknown) => {
              useDesktopStore.getState().setNotice({
                text: `Could not save ${title}: ${error instanceof Error ? error.message : String(error)}`,
              });
            });
          }}
        />
      )}
    </div>
  );
}

const dialogButton =
  'inline-flex h-9 items-center justify-center rounded-lg px-3 text-sm font-medium transition-colors ' +
  'bg-zinc-100 text-zinc-800 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700';

/**
 * Cancel, discard, or save — three answers, because two is the wrong number.
 *
 * A plain confirm can only offer "lose the changes" or "keep the tab open", and
 * neither is what someone closing a tab they have written in actually wants.
 */
function CloseDialog({
  title,
  onCancel,
  onDiscard,
  onSave,
}: {
  title: string;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
}): React.JSX.Element {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onPointerDown={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Unsaved changes"
        data-close-tab-dialog
        className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl dark:bg-zinc-900"
      >
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Unsaved changes</h2>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
          “{title}” has changes that are not saved anywhere.
        </p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" className={dialogButton} onClick={onCancel} data-close-cancel>
            Cancel
          </button>
          <button
            type="button"
            className={`${dialogButton} text-rose-700 hover:bg-rose-100 dark:text-rose-300 dark:hover:bg-rose-950`}
            onClick={onDiscard}
            data-close-discard
          >
            Discard
          </button>
          <button
            type="button"
            className={`${dialogButton} bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-400`}
            onClick={onSave}
            data-close-save
          >
            Save and close
          </button>
        </div>
      </div>
    </div>
  );
}
