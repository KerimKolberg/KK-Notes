import { useEffect } from 'react';
import { useDesktopStore } from '../../desktop/desktopStore';
import { useTabStore } from '../tabStore';

/** How long a notice that offers a choice stays before it goes by itself, in ms. */
const CHOICE_LINGER_MS = 10_000;

/**
 * A notice that carries a choice ("Add its pages to my note instead", "Discard"), and any notice on a window too narrow
 * to show one in the top bar (which keeps them from `xl` up).
 *
 * The top bar has no room for a sentence and a button between the title and the view controls: with one it ran into the
 * page counter. And on a smaller window a choice offered there was simply not there, so could not be made.
 */
export function NoticeToast() {
  const notice = useDesktopStore((s) => s.notice);
  const setNotice = useDesktopStore((s) => s.setNotice);
  const splitId = useTabStore((s) => s.splitId);
  // A choice that has been overtaken (the split it offered is already showing) or ignored for a while is not left on the page.
  useEffect(() => {
    if (!notice?.action) return;
    const timer = window.setTimeout(() => setNotice(null), CHOICE_LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [notice, setNotice]);
  useEffect(() => {
    if (splitId && useDesktopStore.getState().notice?.action?.label === 'Split screen') setNotice(null);
  }, [splitId, setNotice]);
  if (!notice) return null;
  return (
    <div
      role="status"
      data-notice-toast
      className={`absolute left-1/2 top-[calc(0.5rem+var(--dock-top,0px))] z-40 flex max-w-[min(32rem,calc(100%-1.5rem))] -translate-x-1/2 items-center gap-2 rounded-xl bg-zinc-900/95 px-3 py-2 text-xs text-white shadow-lg ${notice.action ? '' : 'xl:hidden'}`}
    >
      <span className="min-w-0 flex-1">{notice.text}</span>
      {notice.action && (
        <button type="button" className="shrink-0 rounded px-1.5 py-0.5 font-medium text-blue-300 hover:bg-white/10" onClick={notice.action.run}>
          {notice.action.label}
        </button>
      )}
      <button type="button" className="shrink-0 rounded px-1 text-zinc-400 hover:text-white" aria-label="Dismiss" onClick={() => setNotice(null)}>
        ×
      </button>
    </div>
  );
}
