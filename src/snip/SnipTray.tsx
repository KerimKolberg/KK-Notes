import { memo, useCallback, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Check, ChevronDown, ChevronUp, GripHorizontal, Scissors, Trash2, X } from 'lucide-react';
import { usePreferencesStore } from '../preferences/store';
import { dragSnip } from './dragSnip';
import { placeSnip } from './place';
import { useSnipStore, type Snip } from './snipStore';

/**
 * The snipping tool's own corner of the screen: whether it is on, and the snips taken so far, to drag onto a page.
 *
 * It belongs to no document: a snip cut from one tab is still here after switching to another, which is how an
 * exercise is cut from its sheet and put in the notes. Each snip is dragged onto a page (resting on a tab on the
 * way opens it), or placed with a tap near the top of the page in view.
 */
export const SnipTray = memo(function SnipTray() {
  const mode = useSnipStore((s) => s.mode);
  const snips = useSnipStore((s) => s.snips);
  const trayOpen = useSnipStore((s) => s.trayOpen);
  const setMode = useSnipStore((s) => s.setMode);
  const setTrayOpen = useSnipStore((s) => s.setTrayOpen);
  const clear = useSnipStore((s) => s.clear);
  const remove = useSnipStore((s) => s.remove);
  // The toolbar docked down the left edge would sit under it, so it takes the other side then.
  const dock = usePreferencesStore((s) => s.paletteDock);

  // It can be pulled aside by its title, since it sits over a corner of the page that someone may want to snip.
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const startMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
      e.preventDefault();
      const from = { x: e.clientX - offset.x, y: e.clientY - offset.y };
      const move = (ev: PointerEvent): void => setOffset({ x: ev.clientX - from.x, y: ev.clientY - from.y });
      const up = (): void => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [offset],
  );

  if (!mode && snips.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Snips"
      data-snip-tray
      style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
      className={`absolute top-3 z-30 flex max-h-[70%] w-52 flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white/95 shadow-xl dark:border-zinc-700 dark:bg-zinc-900/95 ${
        dock === 'left' ? 'right-3' : 'left-3'
      }`}
    >
      <div
        className="flex cursor-grab touch-none items-center gap-1 border-b border-zinc-200 px-2 py-1.5 active:cursor-grabbing dark:border-zinc-700"
        data-snip-grip
        title="Drag to move; double-click to put back"
        onPointerDown={startMove}
        onDoubleClick={() => setOffset({ x: 0, y: 0 })}
      >
        <GripHorizontal size={12} className="text-zinc-300" aria-hidden="true" />
        <Scissors size={14} className={mode ? 'text-blue-600 dark:text-blue-400' : 'text-zinc-500'} aria-hidden="true" />
        <span className="flex-1 truncate text-xs font-semibold text-zinc-800 dark:text-zinc-100" data-snip-count>
          {snips.length === 0 ? 'Snip' : `Snips · ${snips.length}`}
        </span>
        {snips.length > 0 && (
          <>
            <button
              type="button"
              aria-label="Remove all snips"
              title="Remove all snips"
              data-snip-clear
              className="inline-flex h-6 w-6 items-center justify-center rounded text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              onClick={clear}
            >
              <Trash2 size={13} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={trayOpen ? 'Fold the tray' : 'Open the tray'}
              data-snip-fold
              className="inline-flex h-6 w-6 items-center justify-center rounded text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              onClick={() => setTrayOpen(!trayOpen)}
            >
              {trayOpen ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
            </button>
          </>
        )}
        {mode && (
          <button
            type="button"
            data-snip-done
            className="rounded bg-blue-600 px-1.5 py-0.5 text-[11px] font-medium text-white hover:bg-blue-500"
            onClick={() => setMode(false)}
          >
            Done
          </button>
        )}
      </div>

      {mode && (
        <p className="px-2.5 py-1.5 text-[11px] leading-snug text-blue-700 dark:text-blue-300" data-snip-hint>
          Drag over a page to cut a piece out of it, with a pen, mouse or finger. Esc stops.
        </p>
      )}

      {trayOpen && snips.length > 0 && (
        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2" data-snip-list={snips.length}>
          {snips.map((snip) => (
            <SnipItem key={snip.id} snip={snip} onRemove={() => remove(snip.id)} />
          ))}
        </ul>
      )}
      {trayOpen && snips.length > 0 && (
        <p className="border-t border-zinc-100 px-2.5 py-1.5 text-[10px] leading-snug text-zinc-400 dark:border-zinc-800">
          Drag one onto a page. Held over a tab, it opens that tab.
        </p>
      )}
    </div>
  );
});

function SnipItem({ snip, onRemove }: { snip: Snip; onRemove: () => void }) {
  return (
    <li
      data-snip={snip.id}
      className="group relative overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-600"
    >
      <img
        src={snip.src}
        alt={`Snip from ${snip.from}`}
        draggable={false}
        data-snip-image
        style={{ touchAction: 'none' }}
        className="block max-h-32 w-full cursor-grab select-none object-contain"
        onPointerDown={(e) => {
          e.preventDefault();
          dragSnip(snip, e.nativeEvent);
        }}
      />
      <div className="flex items-center gap-1 border-t border-zinc-100 bg-zinc-50 px-1.5 py-0.5 dark:border-zinc-700 dark:bg-zinc-800">
        <span className="min-w-0 flex-1 truncate text-[10px] text-zinc-500 dark:text-zinc-400">{snip.from}</span>
        <button
          type="button"
          aria-label="Place on the page in view"
          title="Place on the page in view"
          data-snip-place
          className="inline-flex h-5 w-5 items-center justify-center rounded text-blue-600 hover:bg-blue-100 dark:text-blue-300 dark:hover:bg-blue-950"
          onClick={() => placeSnip(snip)}
        >
          <Check size={12} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Remove this snip"
          data-snip-remove
          className="inline-flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700"
          onClick={onRemove}
        >
          <X size={12} aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}
