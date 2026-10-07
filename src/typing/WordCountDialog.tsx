import { useEffect } from 'react';
import { BookOpenText, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { textStats } from '../document/richText';
import { useDocumentStore } from '../document/store';
import { showWordCount, useTypingStore } from './typingStore';
import { chainBoxes } from './flow/engine';
import { countNote } from './wordCount';
import type { Page } from '../document/types';

function chainTexts(pages: readonly Page[], boxId: string): string[] {
  const page = pages.find((p) => p.media.some((m) => m.id === boxId));
  return page ? chainBoxes(pages, page.id).map((c) => c.box.text) : [];
}

/** Word Count (Ctrl+Shift+G, or the count in the format bar): the note's, the box's, and the selection's. */
export function WordCountDialog() {
  const open = useTypingStore((s) => s.countOpen);
  if (!open) return null;
  return <Counts />;
}

function Counts() {
  const doc = useDocumentStore((s) => s.document);
  const { controller, selectedText } = useTypingStore(useShallow((s) => ({ controller: s.controller, selectedText: s.selectedText })));
  const box = useDocumentStore((s) => {
    const id = controller?.mediaId ?? s.selectedMedia?.mediaId;
    for (const page of s.document.pages) for (const m of page.media) if (m.id === id && m.kind === 'text') return m;
    return null;
  });
  const note = countNote(doc);
  // Page text is one text, all its pages.
  const here = box ? textStats(box.flow ? chainTexts(doc.pages, box.id) : [box.text]) : null;
  const selection = selectedText ? textStats([selectedText]) : null;
  const close = (): void => {
    showWordCount(false);
    controller?.focus();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const rows: [string, number | string][] = [
    ['Words', note.typed.words],
    ['Characters (with spaces)', note.typed.characters],
    ['Characters (no spaces)', note.typed.charactersNoSpaces],
    ['Paragraphs', note.typed.paragraphs],
    ['Pages with typed text', `${note.pagesWithText} of ${note.pages}`],
  ];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Word count"
        data-word-count
        className="flex w-full max-w-sm flex-col gap-3 rounded-2xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
      >
        <div className="flex items-center gap-2">
          <BookOpenText size={16} className="text-blue-600 dark:text-blue-400" aria-hidden="true" />
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-zinc-900 dark:text-zinc-100">Word count</h2>
          <button type="button" aria-label="Close" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={close}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <Table title="This note" rows={rows} data="note" />
        {here && <Table title="This text" rows={[['Words', here.words], ['Characters', here.characters]]} data="box" />}
        {selection && <Table title="Selected" rows={[['Words', selection.words], ['Characters', selection.characters]]} data="selection" />}
        {note.handwriting !== null && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400" data-word-count-handwriting>
            Handwriting, as read: {note.handwriting} {note.handwriting === 1 ? 'word' : 'words'} (not counted above).
          </p>
        )}
      </div>
    </div>
  );
}

function Table({ title, rows, data }: { title: string; rows: [string, number | string][]; data: string }) {
  return (
    <section data-word-count-section={data}>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{title}</h3>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-zinc-600 dark:text-zinc-300">{label}</dt>
            <dd className="text-right font-medium tabular-nums text-zinc-900 dark:text-zinc-100" data-count={label}>
              {typeof value === 'number' ? value.toLocaleString() : value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
