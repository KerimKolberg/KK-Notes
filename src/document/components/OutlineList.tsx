import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { currentRow, initiallyCollapsed, visibleRows, type ContentsRow } from '../contents';
import type { ContentsSection } from '../useContents';

interface OutlineListProps {
  readonly sections: readonly ContentsSection[];
  /** The page in view, to mark the chapter it is in. */
  readonly pageIndex: number;
  /** Go to a page, `within` page units down it. */
  readonly onPick: (pageIndex: number, within: number) => void;
}

/**
 * The contents of one or more PDFs, as an indented list: an entry goes to its page, a chevron folds what is
 * nested under it, and the chapter the page in view belongs to is marked. Used by the contents panel beside the
 * note and by the list in the reading pane.
 */
export const OutlineList = memo(function OutlineList({ sections, pageIndex, onPick }: OutlineListProps) {
  const many = sections.length > 1;
  if (sections.length === 0) {
    return (
      <p className="px-3 py-3 text-sm text-zinc-500 dark:text-zinc-400" data-contents-empty>
        No page here comes from a PDF, so there is no table of contents to show.
      </p>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto py-1" data-contents-list>
      {sections.map((section) => (
        <section key={section.sourceId} data-contents-source={section.name}>
          {many && (
            <h3 className="truncate px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400" title={section.name}>
              {section.name}
            </h3>
          )}
          <SectionRows section={section} pageIndex={pageIndex} onPick={onPick} />
        </section>
      ))}
    </div>
  );
});

function SectionRows({ section, pageIndex, onPick }: { readonly section: ContentsSection; readonly pageIndex: number; readonly onPick: OutlineListProps['onPick'] }) {
  const rows = section.rows;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string> | null>(null);
  // Folded as it first arrives; after that, as the reader leaves it.
  const folded = useMemo(() => collapsed ?? (rows ? initiallyCollapsed(rows) : new Set<string>()), [collapsed, rows]);
  const shown = useMemo(() => (rows ? visibleRows(rows, folded) : []), [rows, folded]);
  const current = useMemo(() => (rows ? currentRow(rows, pageIndex) : null), [rows, pageIndex]);
  const currentRef = useRef<HTMLLIElement>(null);
  const scrolled = useRef(false);

  // Once, when the list first fills: bring the chapter in view into the list's view, without scrolling anything
  // outside the list (scrollIntoView would).
  useEffect(() => {
    if (scrolled.current || !currentRef.current) return;
    scrolled.current = true;
    const item = currentRef.current;
    const list = item.closest<HTMLElement>('[data-contents-list]');
    if (!list) return;
    const top = item.offsetTop - list.offsetTop;
    if (top > list.clientHeight - item.offsetHeight) list.scrollTop = top - list.clientHeight / 3;
  }, [shown]);

  if (!rows) {
    return <p className="px-3 py-2 text-sm text-zinc-500 dark:text-zinc-400" data-contents-loading>Reading the table of contents…</p>;
  }
  if (rows.length === 0) {
    return (
      <p className="px-3 py-2 text-sm text-zinc-500 dark:text-zinc-400" data-contents-none>
        This PDF has no table of contents of its own.
      </p>
    );
  }

  const toggle = (row: ContentsRow): void => {
    const next = new Set(folded);
    if (next.has(row.key)) next.delete(row.key);
    else next.add(row.key);
    setCollapsed(next);
  };

  return (
    <ul>
      {shown.map((row) => {
        const isCurrent = row.key === current;
        const missing = row.pageIndex === null;
        return (
          <li
            key={row.key}
            ref={isCurrent ? currentRef : undefined}
            className={`flex items-center gap-0.5 pr-2 ${isCurrent ? 'bg-blue-50 dark:bg-blue-950/40' : ''}`}
            style={{ paddingLeft: 4 + row.depth * 14 }}
            data-contents-row={row.key}
            data-contents-current={isCurrent || undefined}
          >
            {row.hasChildren ? (
              <button
                type="button"
                aria-label={folded.has(row.key) ? `Show what is under ${row.title}` : `Fold what is under ${row.title}`}
                aria-expanded={!folded.has(row.key)}
                data-contents-fold
                className="inline-flex h-6 w-5 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                onClick={() => toggle(row)}
              >
                {folded.has(row.key) ? <ChevronRight size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
              </button>
            ) : (
              <span className="w-5 shrink-0" aria-hidden="true" />
            )}
            <button
              type="button"
              disabled={missing}
              title={missing ? `${row.title} — that page is not in this note` : row.title}
              data-contents-go
              className={`flex min-w-0 flex-1 items-baseline gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-zinc-100 disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent dark:hover:bg-zinc-800 ${
                row.depth === 0 ? 'font-medium text-zinc-900 dark:text-zinc-100' : 'text-zinc-700 dark:text-zinc-300'
              }`}
              onClick={() => {
                if (row.pageIndex !== null) onPick(row.pageIndex, row.within);
              }}
            >
              <span className="min-w-0 flex-1 truncate">{row.title}</span>
              <span className="shrink-0 text-xs tabular-nums text-zinc-400">{missing ? '—' : row.pageIndex! + 1}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
