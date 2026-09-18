import { memo, useEffect, useState } from 'react';
import { FileText, Folder } from 'lucide-react';
import { readThumbnailSource } from './libraryService';
import { cardAspect, renderCardImage } from './thumbnail';
import type { LibraryEntry, LibraryLayout } from './types';

export interface DocumentCardProps {
  entry: LibraryEntry;
  layout: LibraryLayout;
  onOpen: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
  /** Dropping a document onto a folder files it there. */
  onDropEntry?: (fromPath: string) => void;
}

function formatDate(ms: number): string {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

const CARD =
  'group relative flex w-full flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white text-left ' +
  'transition-shadow hover:shadow-md focus-visible:outline-2 focus-visible:outline-blue-500 ' +
  'dark:border-zinc-700 dark:bg-zinc-900';

/**
 * One item in the library.
 *
 * A document's picture is rendered from its first page and nothing else — see
 * `thumbnail.ts` — and only once it is on screen: an `IntersectionObserver`
 * gates the work, so opening a library of two hundred notebooks rasterises the
 * dozen you can see rather than all of them.
 */
export const DocumentCard = memo(function DocumentCard({ entry, layout, onOpen, onContextMenu, onDropEntry }: DocumentCardProps) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [image, setImage] = useState<string | null>(null);
  const [aspect, setAspect] = useState('794 / 1123');
  const [title, setTitle] = useState(entry.name);
  const [pages, setPages] = useState<number | null>(null);
  const [dropping, setDropping] = useState(false);

  useEffect(() => {
    if (!node || entry.isFolder || visible) return;
    if (typeof IntersectionObserver !== 'function') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { rootMargin: '200px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, entry.isFolder, visible]);

  useEffect(() => {
    if (!visible || entry.isFolder) return;
    let cancelled = false;
    void (async () => {
      try {
        const source = await readThumbnailSource(entry.path);
        if (cancelled) return;
        setTitle(source.title);
        setPages(source.pageCount);
        setAspect(cardAspect(source.page));
        const rendered = await renderCardImage(source.page);
        if (!cancelled) setImage(rendered);
      } catch {
        // A document saved by a newer version, or half-written when the
        // battery went. One unreadable card must not empty the library.
        if (!cancelled) setPages(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, entry.isFolder, entry.path, entry.modifiedMs]);

  const subtitle = entry.isFolder
    ? `${entry.childCount} item${entry.childCount === 1 ? '' : 's'}`
    : `${pages === null ? '' : `${pages} page${pages === 1 ? '' : 's'} · `}${formatDate(entry.modifiedMs)}`;

  const dropProps = entry.isFolder && onDropEntry
    ? {
        onDragOver: (e: React.DragEvent) => {
          if (e.dataTransfer.types.includes('text/notes-entry')) {
            e.preventDefault();
            setDropping(true);
          }
        },
        onDragLeave: () => setDropping(false),
        onDrop: (e: React.DragEvent) => {
          e.preventDefault();
          setDropping(false);
          const from = e.dataTransfer.getData('text/notes-entry');
          if (from && from !== entry.path) onDropEntry(from);
        },
      }
    : {};

  const common = {
    ref: setNode as unknown as React.Ref<HTMLButtonElement>,
    type: 'button' as const,
    onClick: onOpen,
    onContextMenu,
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData('text/notes-entry', entry.path);
      e.dataTransfer.effectAllowed = 'move';
    },
    'data-library-entry': entry.path,
    'data-library-kind': entry.isFolder ? 'folder' : 'document',
    ...dropProps,
  };

  if (layout === 'list') {
    return (
      <li className="list-none">
        <button
          {...common}
          className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-zinc-800 ${
            dropping ? 'ring-2 ring-blue-500' : ''
          }`}
        >
          {entry.isFolder ? (
            <Folder size={20} className="shrink-0 text-blue-500" aria-hidden="true" />
          ) : (
            <span
              className="h-10 w-8 shrink-0 overflow-hidden rounded border border-zinc-200 bg-white dark:border-zinc-700"
              aria-hidden="true"
            >
              {image && <img src={image} alt="" className="h-full w-full object-cover" />}
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
              {entry.isFolder ? entry.name : title}
            </span>
            <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</span>
          </span>
        </button>
      </li>
    );
  }

  return (
    <li className="list-none">
      <button {...common} className={`${CARD} ${dropping ? 'ring-2 ring-blue-500' : ''}`}>
        {entry.isFolder ? (
          <span
            className="flex w-full items-center justify-center bg-zinc-50 dark:bg-zinc-800"
            style={{ aspectRatio: '4 / 3' }}
            aria-hidden="true"
          >
            <Folder size={48} className="text-blue-500" strokeWidth={1.4} />
          </span>
        ) : (
          <span
            className="block w-full overflow-hidden bg-white dark:bg-zinc-100"
            style={{ aspectRatio: aspect }}
            aria-hidden="true"
          >
            {image && <img src={image} alt="" className="h-full w-full object-cover object-top" />}
          </span>
        )}
        <span className="flex items-start gap-2 border-t border-zinc-200 px-2.5 py-2 dark:border-zinc-700">
          {!entry.isFolder && <FileText size={14} className="mt-0.5 shrink-0 text-zinc-400" aria-hidden="true" />}
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
              {entry.isFolder ? entry.name : title}
            </span>
            <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</span>
          </span>
        </span>
      </button>
    </li>
  );
});
