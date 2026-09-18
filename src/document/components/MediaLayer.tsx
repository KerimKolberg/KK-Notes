import { memo, useCallback, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Lock, LockOpen } from 'lucide-react';
import { NOTE_COLORS } from '../constants';
import {
  RESIZE_HANDLES,
  addTableColumn,
  addTableRow,
  handlePositions,
  imageCenter,
  isLocked,
  moveImage,
  removeTableColumn,
  removeTableRow,
  resizeImage,
  rotationFromPointer,
  setTableCell,
  sortedByZ,
  tableCell,
  toLocalDelta,
  type ResizeHandle,
} from '../media';
import { useDocumentStore } from '../store';
import type { MediaObject, Page, StickyNote, TableLayer } from '../types';

export interface MediaLayerProps {
  page: Page;
  zoom: number;
  /** Only the select tool interacts with media. */
  active: boolean;
}

type DragKind = 'move' | 'resize' | 'rotate';

interface Drag {
  kind: DragKind;
  handle?: ResizeHandle;
  pointerId: number;
  startX: number;
  startY: number;
  origin: MediaObject;
}

const HANDLE_CURSORS: Record<ResizeHandle, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
};

const ROTATION_HANDLE_OFFSET = 28;

/**
 * z-10 media layer: images, sticky notes and tables in page units inside a
 * zoom-scaled container, with one transform box (8 resize handles, rotation
 * handle, body drag) shared by all three and a contextual toolbar on the
 * selected object. Transform previews live in local state and are committed
 * to the store on release.
 *
 * Notes and tables are real HTML, not canvas: they are typed into, so they
 * need the platform's own text editing, selection and IME.
 */
export const MediaLayer = memo(function MediaLayer({ page, zoom, active }: MediaLayerProps) {
  const { selectedMedia, selectMedia, updateMedia, removeMedia, bringMediaToFront, sendMediaToBack } = useDocumentStore(
    useShallow((s) => ({
      selectedMedia: s.selectedMedia,
      selectMedia: s.selectMedia,
      updateMedia: s.updateMedia,
      removeMedia: s.removeMedia,
      bringMediaToFront: s.bringMediaToFront,
      sendMediaToBack: s.sendMediaToBack,
    })),
  );
  const [draft, setDraft] = useState<MediaObject | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedId = selectedMedia?.pageId === page.id ? selectedMedia.mediaId : null;
  const items = sortedByZ(page.media);
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const shown = (item: MediaObject): MediaObject => (draft && draft.id === item.id ? draft : item);

  const pagePoint = useCallback(
    (clientX: number, clientY: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom };
    },
    [zoom],
  );

  const begin = useCallback(
    (e: ReactPointerEvent<HTMLElement>, kind: DragKind, item: MediaObject, handle?: ResizeHandle) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      selectMedia({ pageId: page.id, mediaId: item.id });
      // A locked object still selects — that is how it gets unlocked — but
      // no drag starts, so it cannot be nudged out of place by accident.
      if (isLocked(item)) return;
      e.preventDefault();
      dragRef.current = { kind, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, origin: item, ...(handle ? { handle } : {}) };
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic pointer */
      }
    },
    [page.id, selectMedia],
  );

  const onMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      const dx = (e.clientX - drag.startX) / zoom;
      const dy = (e.clientY - drag.startY) / zoom;
      if (drag.kind === 'move') {
        setDraft(moveImage(drag.origin, dx, dy));
      } else if (drag.kind === 'resize' && drag.handle) {
        const local = toLocalDelta(drag.origin, dx, dy);
        // Images keep their aspect ratio by default; a note or a table is a
        // container, and squaring one off is usually exactly what is wanted.
        const keepAspect = drag.origin.kind === 'image' ? !e.shiftKey : e.shiftKey;
        setDraft(resizeImage(drag.origin, drag.handle, local.x, local.y, keepAspect));
      } else if (drag.kind === 'rotate') {
        const p = pagePoint(e.clientX, e.clientY);
        setDraft({ ...drag.origin, rotation: rotationFromPointer(drag.origin, p, e.shiftKey ? 15 : 0) });
      }
    },
    [zoom, pagePoint],
  );

  const finish = useCallback(
    (e: ReactPointerEvent<HTMLElement>, commit: boolean) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      dragRef.current = null;
      setDraft((current) => {
        if (commit && current && current.id === drag.origin.id) {
          const { x, y, width, height, rotation } = current;
          updateMedia(page.id, current.id, { x, y, width, height, rotation });
        }
        return null;
      });
    },
    [page.id, updateMedia],
  );

  const bodyHandlers = (raw: MediaObject) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => begin(e, 'move', raw),
    onPointerMove: onMove,
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => finish(e, true),
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => finish(e, false),
  });

  return (
    <div
      className="absolute inset-0 z-10"
      style={{ pointerEvents: active ? 'auto' : 'none' }}
      data-media-layer={page.id}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.mediaCanvas !== undefined) selectMedia(null);
      }}
    >
      <div
        ref={containerRef}
        data-media-canvas
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: page.dimensions.width,
          height: page.dimensions.height,
          transform: `scale(${zoom})`,
          transformOrigin: '0 0',
        }}
      >
        {items.map((raw) => {
          const item = shown(raw);
          const box: CSSProperties = {
            position: 'absolute',
            left: item.x,
            top: item.y,
            width: item.width,
            height: item.height,
            transform: `rotate(${item.rotation}deg)`,
            transformOrigin: 'center',
            zIndex: item.zIndex,
            pointerEvents: active ? 'auto' : 'none',
            outline: item.id === selectedId ? '1.5px solid rgba(37, 99, 235, 0.9)' : 'none',
            outlineOffset: -1,
          };
          if (item.kind === 'image') {
            return (
              <img
                key={item.id}
                src={item.src}
                alt=""
                draggable={false}
                data-media-id={item.id}
                data-media-kind="image"
                style={{ ...box, cursor: active ? (isLocked(item) ? 'default' : 'move') : 'default', userSelect: 'none' }}
                {...bodyHandlers(raw)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  selectMedia({ pageId: page.id, mediaId: raw.id });
                }}
              />
            );
          }
          if (item.kind === 'note') {
            return (
              <NoteCard
                key={item.id}
                note={item}
                box={box}
                editable={active && !isLocked(item)}
                onDragBody={bodyHandlers(raw)}
                onText={(text) => updateMedia(page.id, item.id, { text })}
              />
            );
          }
          return (
            <TableCard
              key={item.id}
              table={item}
              box={box}
              editable={active && !isLocked(item)}
              onDragBody={bodyHandlers(raw)}
              onCell={(row, column, value) => updateMedia(page.id, item.id, setTableCell(item, row, column, value))}
            />
          );
        })}

        {active && selected && (
          <TransformBox
            item={shown(selected)}
            zoom={zoom}
            onBegin={(e, kind, handle) => begin(e, kind, selected, handle)}
            onMove={onMove}
            onEnd={finish}
            onDelete={() => removeMedia(page.id, selected.id)}
            onFront={() => bringMediaToFront(page.id, selected.id)}
            onBack={() => sendMediaToBack(page.id, selected.id)}
            onToggleLock={() => updateMedia(page.id, selected.id, { locked: !isLocked(selected) })}
            onPatch={(patch) => updateMedia(page.id, selected.id, patch)}
          />
        )}
      </div>
    </div>
  );
});

/** The pointer handlers that make a grip drag its object. */
interface BodyHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
}

interface NoteCardProps {
  note: StickyNote;
  box: CSSProperties;
  editable: boolean;
  onDragBody: BodyHandlers;
  onText: (text: string) => void;
}

/**
 * A sticky note. The card is dragged by its lip; the textarea below it takes
 * the pointer for text, because a note whose body you cannot click into is
 * not a note.
 */
function NoteCard({ note, box, editable, onDragBody, onText }: NoteCardProps) {
  return (
    <div
      data-media-id={note.id}
      data-media-kind="note"
      style={{
        ...box,
        background: note.color,
        borderRadius: 2,
        boxShadow: '0 2px 6px rgba(0,0,0,0.18)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div
        aria-hidden="true"
        title="Drag to move"
        style={{ height: 18, flexShrink: 0, cursor: editable ? 'move' : 'default', background: 'rgba(0,0,0,0.06)' }}
        {...onDragBody}
      />
      <textarea
        aria-label="Sticky note text"
        data-note-text
        value={note.text}
        readOnly={!editable}
        placeholder={editable ? 'Note…' : ''}
        onChange={(e) => onText(e.target.value)}
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          flex: 1,
          minHeight: 0,
          width: '100%',
          resize: 'none',
          border: 'none',
          outline: 'none',
          background: 'transparent',
          padding: '6px 8px',
          font: '15px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          color: '#27272a',
          overflow: 'auto',
        }}
      />
    </div>
  );
}

interface TableCardProps {
  table: TableLayer;
  box: CSSProperties;
  editable: boolean;
  onDragBody: BodyHandlers;
  onCell: (row: number, column: number, value: string) => void;
}

/** A grid of text inputs, sized to fill the box whatever its row/column count. */
function TableCard({ table, box, editable, onDragBody, onCell }: TableCardProps) {
  return (
    <div
      data-media-id={table.id}
      data-media-kind="table"
      data-table-size={`${table.rows}x${table.columns}`}
      style={{ ...box, background: '#ffffff', display: 'flex', flexDirection: 'column', overflow: 'hidden', border: '1px solid #a1a1aa' }}
    >
      <div
        aria-hidden="true"
        title="Drag to move"
        style={{ height: 14, flexShrink: 0, cursor: editable ? 'move' : 'default', background: '#e4e4e7' }}
        {...onDragBody}
      />
      <div
        role="table"
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: `repeat(${table.columns}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${table.rows}, minmax(0, 1fr))`,
        }}
      >
        {Array.from({ length: table.rows }, (_, row) =>
          Array.from({ length: table.columns }, (_, column) => (
            <input
              key={`${row}-${column}`}
              type="text"
              aria-label={`Row ${row + 1} column ${column + 1}`}
              data-cell={`${row}-${column}`}
              value={tableCell(table, row, column)}
              readOnly={!editable}
              onChange={(e) => onCell(row, column, e.target.value)}
              onPointerDown={(e) => e.stopPropagation()}
              style={{
                minWidth: 0,
                border: '0.5px solid #d4d4d8',
                outline: 'none',
                padding: '2px 5px',
                font: '13px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
                color: '#18181b',
                background: 'transparent',
              }}
            />
          )),
        )}
      </div>
    </div>
  );
}

interface TransformBoxProps {
  item: MediaObject;
  zoom: number;
  onBegin: (e: ReactPointerEvent<HTMLElement>, kind: DragKind, handle?: ResizeHandle) => void;
  onMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onEnd: (e: ReactPointerEvent<HTMLElement>, commit: boolean) => void;
  onDelete: () => void;
  onFront: () => void;
  onBack: () => void;
  onToggleLock: () => void;
  onPatch: (patch: Partial<MediaObject>) => void;
}

function TransformBox({ item, zoom, onBegin, onMove, onEnd, onDelete, onFront, onBack, onToggleLock, onPatch }: TransformBoxProps) {
  const handles = handlePositions(item);
  const centre = imageCenter(item);
  const locked = isLocked(item);
  const size = 10 / zoom;
  const drag = {
    onPointerMove: onMove,
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => onEnd(e, true),
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => onEnd(e, false),
  };
  const handleStyle = (p: { x: number; y: number }, cursor: string): CSSProperties => ({
    position: 'absolute',
    left: p.x - size / 2,
    top: p.y - size / 2,
    width: size,
    height: size,
    background: '#fff',
    border: `${1.5 / zoom}px solid #2563eb`,
    borderRadius: 2 / zoom,
    cursor,
    zIndex: 10000,
    boxSizing: 'border-box',
    touchAction: 'none',
  });
  // Rotation handle sits above the top edge, following the box rotation.
  const rad = (item.rotation * Math.PI) / 180;
  const topMid = handles.n;
  const rotHandle = {
    x: topMid.x - Math.sin(rad) * (ROTATION_HANDLE_OFFSET / zoom) * -1,
    y: topMid.y - Math.cos(rad) * (ROTATION_HANDLE_OFFSET / zoom),
  };
  const toolbarPos = { x: centre.x, y: Math.min(...Object.values(handles).map((h) => h.y)) - 44 / zoom };
  const toolbarButton =
    'inline-flex h-7 items-center rounded-md px-2 text-xs font-medium text-white hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-blue-300';

  return (
    <>
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: item.x,
          top: item.y,
          width: item.width,
          height: item.height,
          transform: `rotate(${item.rotation}deg)`,
          transformOrigin: 'center',
          border: `${1 / zoom}px dashed ${locked ? 'rgba(113, 113, 122, 0.8)' : 'rgba(37, 99, 235, 0.7)'}`,
          pointerEvents: 'none',
          zIndex: 9999,
          boxSizing: 'border-box',
        }}
      />
      {/* A locked object shows no grips at all: nothing to grab is the clearest
          possible statement that nothing will move. */}
      {!locked &&
        RESIZE_HANDLES.map((h) => (
          <div
            key={h}
            role="presentation"
            data-resize-handle={h}
            style={handleStyle(handles[h], HANDLE_CURSORS[h])}
            onPointerDown={(e) => onBegin(e, 'resize', h)}
            {...drag}
          />
        ))}
      {!locked && (
        <div
          role="presentation"
          data-rotate-handle
          style={{ ...handleStyle(rotHandle, 'grab'), borderRadius: '50%' }}
          onPointerDown={(e) => onBegin(e, 'rotate')}
          {...drag}
        />
      )}
      <div
        role="toolbar"
        aria-label="Media actions"
        data-media-toolbar
        data-media-locked={locked ? 'true' : undefined}
        style={{
          position: 'absolute',
          left: toolbarPos.x,
          top: toolbarPos.y,
          transform: `translate(-50%, 0) scale(${1 / zoom})`,
          transformOrigin: 'top center',
          zIndex: 10001,
          pointerEvents: 'auto',
          maxWidth: 'calc(100vw - 1rem)',
        }}
        className="flex flex-wrap items-center justify-center gap-0.5 rounded-lg bg-zinc-900/90 p-1 shadow-lg backdrop-blur"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className={`${toolbarButton} ${locked ? 'bg-white/20' : ''}`}
          onClick={onToggleLock}
          title={locked ? 'Unlock' : 'Lock in place'}
          aria-label={locked ? 'Unlock' : 'Lock in place'}
          aria-pressed={locked}
          data-media-lock
        >
          {locked ? <Lock size={14} aria-hidden="true" /> : <LockOpen size={14} aria-hidden="true" />}
        </button>
        {item.kind === 'note' && (
          <div className="flex items-center gap-0.5" role="group" aria-label="Note colour">
            {NOTE_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className="h-5 w-5 rounded-full ring-1 ring-white/40 hover:ring-white focus-visible:outline-2 focus-visible:outline-blue-300"
                style={{ background: color }}
                onClick={() => onPatch({ color } as Partial<MediaObject>)}
                title={`Note colour ${color}`}
                aria-label={`Note colour ${color}`}
              />
            ))}
          </div>
        )}
        {item.kind === 'table' && (
          <div className="flex items-center gap-0.5" role="group" aria-label="Rows and columns">
            <button type="button" className={toolbarButton} onClick={() => onPatch(addTableRow(item))} aria-label="Add row" data-add-row>
              +Row
            </button>
            <button type="button" className={toolbarButton} onClick={() => onPatch(removeTableRow(item))} aria-label="Remove row" data-remove-row>
              −Row
            </button>
            <button type="button" className={toolbarButton} onClick={() => onPatch(addTableColumn(item))} aria-label="Add column" data-add-column>
              +Col
            </button>
            <button
              type="button"
              className={toolbarButton}
              onClick={() => onPatch(removeTableColumn(item))}
              aria-label="Remove column"
              data-remove-column
            >
              −Col
            </button>
          </div>
        )}
        <button type="button" className={toolbarButton} onClick={onFront} title="Bring to front" aria-label="Bring to front">
          Front
        </button>
        <button type="button" className={toolbarButton} onClick={onBack} title="Send to back" aria-label="Send to back">
          Back
        </button>
        <button type="button" className={`${toolbarButton} text-rose-200`} onClick={onDelete} title="Delete" aria-label="Delete">
          Delete
        </button>
      </div>
    </>
  );
}
