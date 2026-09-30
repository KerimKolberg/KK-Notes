import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Tag, X } from 'lucide-react';
import { MAX_TAGS, parseTags, tagCounts, useNoteMetaStore } from './noteMeta';

/**
 * Tags for one note: typed, separated by commas, with the ones already in use a tap away.
 * Tags stay on this device (see `noteMeta.ts`), which the dialog says.
 */
export function TagsDialog({ path, name, onClose }: { path: string; name: string; onClose: () => void }) {
  const map = useNoteMetaStore((s) => s.map);
  const setTags = useNoteMetaStore((s) => s.setTags);
  const [text, setText] = useState(() => (map[path]?.tags ?? []).join(', '));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const current = parseTags(text);
  const suggestions = tagCounts(map).filter((t) => !current.some((c) => c.toLowerCase() === t.tag.toLowerCase()));

  const save = (e: FormEvent): void => {
    e.preventDefault();
    setTags(path, current);
    onClose();
  };
  const add = (tag: string): void => setText([...current, tag].join(', '));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      data-tags-backdrop
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label={`Tags for ${name}`}
        data-tags-dialog
        onSubmit={save}
        className="flex w-full max-w-sm flex-col gap-3 rounded-2xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
      >
        <div className="flex items-center gap-2">
          <Tag size={16} className="text-blue-600 dark:text-blue-400" aria-hidden="true" />
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-zinc-900 dark:text-zinc-100">Tags · {name}</h2>
          <button type="button" aria-label="Close" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-300">
          Separate tags with commas
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="school, maths, exam"
            data-tags-input
            className="h-9 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm font-normal text-zinc-900 outline-none focus:border-blue-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
          />
        </label>
        {suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5" data-tags-suggestions>
            {suggestions.slice(0, 12).map((t) => (
              <button
                key={t.tag}
                type="button"
                data-tag-suggestion={t.tag}
                disabled={current.length >= MAX_TAGS}
                onClick={() => add(t.tag)}
                className="rounded-full border border-zinc-200 px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                + {t.tag}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <button type="submit" data-tags-save className="h-9 rounded-lg bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-500">
            Save
          </button>
          <span className="text-[11px] text-zinc-400">Up to {MAX_TAGS}. Kept on this device.</span>
        </div>
      </form>
    </div>
  );
}
