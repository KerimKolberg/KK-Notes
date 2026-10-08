import { memo, useEffect, useRef, useState } from 'react';
import { Check, FileText, Folder, Star, Tag } from 'lucide-react';
import { readThumbnailSource } from './libraryService';
import { cardAspect, renderCardImage } from './thumbnail';
import type { LibraryEntry, LibraryLayout } from './types';

/**
 * How a card is selected: `toggle` for a click on it while selecting (or a Ctrl-click), `add` for a right-click or a
 * press held on it — which starts selecting with it — and `range` for a Shift-click, everything from the card
 * selected last to this one.
 */
export type SelectHow = 'toggle' | 'add' | 'range';

/** How long a finger or a pen is held on a card before it is selected rather than opened. */
const LONG_PRESS_MS = 500;
/** How far it may wander meanwhile, px: further is a scroll or a drag. */
const LONG_PRESS_SLOP = 8;

export interface DocumentCardProps {
  entry: LibraryEntry;
  layout: LibraryLayout;
  onOpen: () => void;
  onSelect: (how: SelectHow) => void;
  /** Notes are being selected: a click selects the card rather than opening it. */
  selecting?: boolean;
  selected?: boolean;
  /** Dropping a document onto a folder files it there. */
  onDropEntry?: (fromPath: string) => void;
  /** Documents only: marked as a favourite, their tags, and the two ways to change them. */
  favourite?: boolean;
  tags?: readonly string[];
  onToggleFavourite?: () => void;
  onEditTags?: () => void;
}

/**
 * A control inside a card. The card is itself a button, and a button cannot hold a button, so these
 * are `role="button"` spans that keep the click (and Enter and Space) from opening the note.
 */
function CardAction({ label, pressed, onAct, children, className = '', ...rest }: {
  label: string;
  pressed?: boolean;
  onAct: () => void;
  children: React.ReactNode;
  className?: string;
} & Record<`data-${string}`, string | undefined>) {
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={label}
      title={label}
      {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
      className={`inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-blue-500 ${className}`}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onAct();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.stopPropagation();
          e.preventDefault();
          onAct();
        }
      }}
      onDragStart={(e) => e.preventDefault()}
      {...rest}
    >
      {children}
    </span>
  );
}

/** The tags under a note's name: the first few, and how many more there are. */
function TagChips({ tags }: { tags: readonly string[] }) {
  if (tags.length === 0) return null;
  const shown = tags.slice(0, 3);
  return (
    <span className="mt-0.5 flex flex-wrap gap-1" data-card-tags>
      {shown.map((tag) => (
        <span key={tag} className="max-w-[7rem] truncate rounded-full bg-blue-50 px-1.5 text-[10px] font-medium text-blue-700 dark:bg-blue-950/60 dark:text-blue-300">
          {tag}
        </span>
      ))}
      {tags.length > shown.length && <span className="text-[10px] text-zinc-400">+{tags.length - shown.length}</span>}
    </span>
  );
}

/** The round tick of a selected card, and the empty ring of one that is not. */
function SelectMark({ selected }: { selected: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 shadow-sm ${
        selected ? 'border-blue-600 bg-blue-600 text-white' : 'border-zinc-400 bg-white/90 dark:border-zinc-500 dark:bg-zinc-900/90'
      }`}
    >
      {selected && <Check size={13} strokeWidth={3} />}
    </span>
  );
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
export const DocumentCard = memo(function DocumentCard({
  entry,
  layout,
  onOpen,
  onSelect,
  selecting = false,
  selected = false,
  onDropEntry,
  favourite = false,
  tags = [],
  onToggleFavourite,
  onEditTags,
}: DocumentCardProps) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [image, setImage] = useState<string | null>(null);
  const [aspect, setAspect] = useState('794 / 1123');
  const [title, setTitle] = useState(entry.name);
  const [pages, setPages] = useState<number | null>(null);
  const [dropping, setDropping] = useState(false);
  const press = useRef<{ id: number; x: number; y: number; timer: number } | null>(null);
  /** A held press selected the card: the click its release brings does not undo that. */
  const held = useRef(false);
  /** The kind of pointer last pressed on the card. */
  const pressedWith = useRef<string | null>(null);
  /** A drag the browser began from a finger held on the card. */
  const fingerDrag = useRef(false);

  const letGo = (): void => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(() => letGo, []);

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
    onClick: (e: React.MouseEvent) => {
      if (held.current) {
        held.current = false;
        return;
      }
      if (e.shiftKey) onSelect('range');
      else if (selecting || e.ctrlKey || e.metaKey) onSelect('toggle');
      else onOpen();
    },
    // A right-click selects, as a press held with a finger does — Android sends this for that press too. It used to
    // delete the note, behind a question the app's web view did not always show.
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      onSelect('add');
    },
    onPointerDown: (e: React.PointerEvent) => {
      held.current = false;
      pressedWith.current = e.pointerType;
      letGo();
      if (e.pointerType === 'mouse' || e.button !== 0) return;
      const timer = window.setTimeout(() => {
        press.current = null;
        held.current = true;
        onSelect('add');
      }, LONG_PRESS_MS);
      press.current = { id: e.pointerId, x: e.clientX, y: e.clientY, timer };
    },
    onPointerMove: (e: React.PointerEvent) => {
      const at = press.current;
      if (at && e.pointerId === at.id && Math.hypot(e.clientX - at.x, e.clientY - at.y) > LONG_PRESS_SLOP) letGo();
    },
    onPointerUp: letGo,
    onPointerCancel: letGo,
    onPointerLeave: letGo,
    ...(selecting ? { 'aria-pressed': selected } : {}),
    'data-library-selected': selecting ? String(selected) : undefined,
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      // A finger held still is where a touch drag starts, and Android starts one sooner than the press above
      // selects; one that ends without being dropped on a folder was the press, and selects as it would have.
      fingerDrag.current = pressedWith.current === 'touch' && !held.current;
      letGo();
      e.dataTransfer.setData('text/notes-entry', entry.path);
      e.dataTransfer.effectAllowed = 'move';
    },
    onDragEnd: (e: React.DragEvent) => {
      if (fingerDrag.current && e.dataTransfer.dropEffect === 'none') onSelect('add');
      fingerDrag.current = false;
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
          className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-blue-500 ${
            selected ? 'bg-blue-50 hover:bg-blue-100 dark:bg-blue-950/50 dark:hover:bg-blue-950' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'
          } ${dropping ? 'ring-2 ring-blue-500' : ''}`}
        >
          {selecting && <SelectMark selected={selected} />}
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
            {!entry.isFolder && <TagChips tags={tags} />}
          </span>
          {!entry.isFolder && !selecting && onToggleFavourite && onEditTags && (
            <>
              <CardAction label="Edit tags" onAct={onEditTags} className="text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700" data-card-tags-button="">
                <Tag size={15} aria-hidden="true" />
              </CardAction>
              <CardAction
                label={favourite ? 'Remove from favourites' : 'Add to favourites'}
                pressed={favourite}
                onAct={onToggleFavourite}
                className={favourite ? 'text-amber-500' : 'text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700'}
                data-card-favourite=""
              >
                <Star size={16} fill={favourite ? 'currentColor' : 'none'} aria-hidden="true" />
              </CardAction>
            </>
          )}
        </button>
      </li>
    );
  }

  return (
    <li className="list-none">
      <button {...common} className={`${CARD} ${selected || dropping ? 'ring-2 ring-blue-500' : ''}`}>
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
        {selecting ? (
          <span className="pointer-events-none absolute left-1.5 top-1.5">
            <SelectMark selected={selected} />
          </span>
        ) : (
          // With a mouse, the way into selecting shows on the card the pointer is over.
          <CardAction
            label="Select"
            onAct={() => onSelect('add')}
            className="pointer-events-none absolute left-1.5 top-1.5 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100"
            data-card-select=""
          >
            <SelectMark selected={false} />
          </CardAction>
        )}
        {!entry.isFolder && !selecting && onToggleFavourite && onEditTags && (
          // Over the corner of the picture, on a disc so they read against any page.
          <span className="absolute right-1.5 top-1.5 flex gap-1">
            <CardAction
              label="Edit tags"
              onAct={onEditTags}
              className="bg-white/90 text-zinc-500 shadow-sm hover:bg-white hover:text-zinc-800 dark:bg-zinc-900/90"
              data-card-tags-button=""
            >
              <Tag size={14} aria-hidden="true" />
            </CardAction>
            <CardAction
              label={favourite ? 'Remove from favourites' : 'Add to favourites'}
              pressed={favourite}
              onAct={onToggleFavourite}
              className={`bg-white/90 shadow-sm hover:bg-white dark:bg-zinc-900/90 ${favourite ? 'text-amber-500' : 'text-zinc-500 hover:text-zinc-800'}`}
              data-card-favourite=""
            >
              <Star size={15} fill={favourite ? 'currentColor' : 'none'} aria-hidden="true" />
            </CardAction>
          </span>
        )}
        <span className="flex items-start gap-2 border-t border-zinc-200 px-2.5 py-2 dark:border-zinc-700">
          {!entry.isFolder && <FileText size={14} className="mt-0.5 shrink-0 text-zinc-400" aria-hidden="true" />}
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
              {entry.isFolder ? entry.name : title}
            </span>
            <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</span>
            {!entry.isFolder && <TagChips tags={tags} />}
          </span>
        </span>
      </button>
    </li>
  );
});
