import { memo, useCallback, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Italic,
  Lock,
  LockOpen,
  Strikethrough,
  Underline,
  type LucideIcon,
} from 'lucide-react';
import {
  DEFAULT_TABLE_LINE_OPACITY,
  DEFAULT_TABLE_LINE_WIDTH,
  NOTE_BUBBLE_RADIUS,
  NOTE_COLORS,
  NOTE_FONT_SIZE,
  NOTE_LINE_HEIGHT,
  NOTE_SHAPES,
} from '../constants';
import {
  RESIZE_HANDLES,
  addTableColumn,
  addTableRow,
  columnFractions,
  handlePositions,
  noteBodyBox,
  noteLipHeight,
  noteShapeOf,
  noteTailPoints,
  noteTailSize,
  noteTextLocalBox,
  imageCenter,
  isLocked,
  moveImage,
  removeTableColumn,
  removeTableRow,
  resizeImage,
  resizeTrack,
  rotationFromPointer,
  rowFractions,
  setColumnFractions,
  setRowFractions,
  setTableCell,
  sortedByZ,
  tableCell,
  TEXT_FONTS,
  TEXT_SIZES,
  textCss,
  textStyleOf,
  toLocalDelta,
  trackEdges,
  type ResizeHandle,
} from '../media';
import { useDocumentStore } from '../store';
import type { MediaObject, NoteShape, Page, StickyNote, TableLayer, TextBox, TextFontId, TextStyle } from '../types';

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
/** The lip a table is dragged by, page units. A note's comes from its shape. */
const TABLE_LIP = 14;
/** How wide the divider's invisible grab strip is, page units. */
const DIVIDER_GRAB = 7;

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
          if (item.kind === 'text') {
            return (
              <TextCard
                key={item.id}
                item={item}
                box={box}
                editable={active && !isLocked(item)}
                selected={item.id === selectedId}
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
              selected={item.id === selectedId}
              zoom={zoom}
              onDragBody={bodyHandlers(raw)}
              onCell={(row, column, value) => updateMedia(page.id, item.id, setTableCell(item, row, column, value))}
              onPatch={(patch) => updateMedia(page.id, item.id, patch)}
            />
          );
        })}

        {/* Grips and select shields, after every object so each one's overlay
            sits above its own content but still below anything stacked on top
            of it. A note or a table is full of inputs that swallow a press, so
            without this the only way to pick one up would be its lip. */}
        {active &&
          items.map((raw) => {
            const item = shown(raw);
            return (
              <MediaGrips
                key={`grips-${item.id}`}
                item={item}
                zoom={zoom}
                selected={item.id === selectedId}
                locked={isLocked(item)}
                onSelect={() => selectMedia({ pageId: page.id, mediaId: item.id })}
                onDragBody={bodyHandlers(raw)}
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

interface MediaGripsProps {
  item: MediaObject;
  zoom: number;
  selected: boolean;
  locked: boolean;
  onSelect: () => void;
  onDragBody: BodyHandlers;
}

/**
 * The two things every placed object needs and none of them can provide from
 * the inside: something obvious to drag it by, and a way to be picked up at
 * all.
 *
 * The shield covers the whole object until it is selected, so one press
 * anywhere on a table takes hold of the table; once selected it steps aside
 * and the cells take the pointer, so the second press types into one. The grip
 * stays either way, because a selected table still has to be movable without
 * hitting a cell. Both ride the object's own rotation.
 */
function MediaGrips({ item, zoom, selected, locked, onSelect, onDragBody }: MediaGripsProps) {
  // Constant on-screen size, like the resize handles: a grip that shrank with
  // the zoom would be unhittable on the page overview.
  const gripHeight = 10 / zoom;
  const gripWidth = Math.min(item.width * 0.6, 44 / zoom);
  const dot = 2.5 / zoom;
  return (
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
        zIndex: item.zIndex,
        pointerEvents: 'none',
      }}
    >
      {!selected && (
        <div
          data-media-shield={item.id}
          style={{ position: 'absolute', inset: 0, pointerEvents: 'auto', cursor: locked ? 'default' : 'move', touchAction: 'none' }}
          {...onDragBody}
        />
      )}
      {!locked && (
        <div
          role="presentation"
          title="Drag to move"
          data-media-grip={item.id}
          style={{
            position: 'absolute',
            left: '50%',
            top: -(gripHeight + 3 / zoom),
            width: gripWidth,
            height: gripHeight,
            transform: 'translateX(-50%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: dot,
            borderRadius: 9999,
            background: selected ? 'rgba(37, 99, 235, 0.95)' : 'rgba(63, 63, 70, 0.9)',
            boxShadow: `0 ${1 / zoom}px ${3 / zoom}px rgba(0,0,0,0.35)`,
            cursor: 'move',
            pointerEvents: 'auto',
            touchAction: 'none',
          }}
          onPointerDown={(e) => {
            onSelect();
            onDragBody.onPointerDown(e);
          }}
          onPointerMove={onDragBody.onPointerMove}
          onPointerUp={onDragBody.onPointerUp}
          onPointerCancel={onDragBody.onPointerCancel}
        >
          {[0, 1, 2].map((i) => (
            <span key={i} style={{ width: dot, height: dot, borderRadius: '50%', background: 'rgba(255,255,255,0.9)' }} />
          ))}
        </div>
      )}
    </div>
  );
}

interface NoteCardProps {
  note: StickyNote;
  box: CSSProperties;
  editable: boolean;
  onDragBody: BodyHandlers;
  onText: (text: string) => void;
}

/**
 * A sticky note.
 *
 * The card is drawn as an absolutely-placed body inside the object's box
 * rather than as the box itself, so a shape that does not fill its box — a
 * speech bubble, whose tail hangs below the body — still has one rectangle
 * for the transform handles to work with. The outline is CSS: a border radius
 * for the rectangle and the ellipse, and a clipped triangle for the tail.
 *
 * The textarea is placed at the shape's own text box rather than filling the
 * card, which is what keeps a line of text from running out through the
 * curve of an oval.
 */
function NoteCard({ note, box, editable, onDragBody, onText }: NoteCardProps) {
  const shape = noteShapeOf(note);
  const body = noteBodyBox(note);
  const text = noteTextLocalBox(note);
  const lip = noteLipHeight(note);
  const tail = noteTailSize(note);
  const tailPoints = noteTailPoints(note);
  const radius = shape === 'ellipse' ? '50%' : shape === 'bubble' ? `${NOTE_BUBBLE_RADIUS}px` : '2px';
  return (
    <div
      data-media-id={note.id}
      data-media-kind="note"
      data-note-shape={shape}
      // Visible overflow so a bubble's tail is not clipped away by its own card.
      style={{ ...box, overflow: 'visible' }}
    >
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: body.width,
          height: body.height,
          background: note.color,
          borderRadius: radius,
          boxShadow: '0 2px 6px rgba(0,0,0,0.18)',
        }}
      />
      {shape === 'bubble' && (
        <div
          aria-hidden="true"
          data-note-tail
          style={{
            position: 'absolute',
            left: tailPoints[0].x,
            top: body.height - 1,
            width: tail.width,
            height: tail.height + 1,
            background: note.color,
            clipPath: 'polygon(0% 0%, 100% 0%, 25% 100%)',
          }}
        />
      )}
      {lip > 0 && (
        <div
          aria-hidden="true"
          title="Drag to move"
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: '100%',
            height: lip,
            borderTopLeftRadius: radius,
            borderTopRightRadius: radius,
            cursor: editable ? 'move' : 'default',
            background: 'rgba(0,0,0,0.06)',
          }}
          {...onDragBody}
        />
      )}
      <textarea
        aria-label="Sticky note text"
        data-note-text
        value={note.text}
        readOnly={!editable}
        placeholder={editable ? 'Note…' : ''}
        onChange={(e) => onText(e.target.value)}
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          left: text.x,
          top: text.y,
          width: text.width,
          height: text.height,
          resize: 'none',
          border: 'none',
          outline: 'none',
          background: 'transparent',
          padding: 0,
          font: `${NOTE_FONT_SIZE}px/${NOTE_LINE_HEIGHT} system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`,
          color: '#27272a',
          overflow: 'auto',
        }}
      />
    </div>
  );
}

interface TextCardProps {
  item: TextBox;
  box: CSSProperties;
  editable: boolean;
  selected: boolean;
  onDragBody: BodyHandlers;
  onText: (text: string) => void;
}

/**
 * Typed text on the page.
 *
 * A `textarea` rather than a canvas draw, because the point of this tool is
 * the *keyboard*: an editable field is what gives a caret, a selection, IME
 * composition for non-Latin input, autocorrect on a phone and the system's own
 * text handles — none of which are worth reimplementing, and all of which are
 * what typing into a page should feel like.
 *
 * The box has no card and no border of its own. An empty one would therefore
 * be invisible and unfindable, so while the media layer is live an empty box
 * shows a dashed outline; it disappears the moment there is text, and never
 * appears in the export.
 */
/**
 * How tall the drag strip above a text box is, in page px.
 *
 * Above rather than over: a text box is all text, so a strip laid on top of it
 * would eat the first line's taps.
 */
const TEXT_GRAB_HEIGHT = 14;

function TextCard({ item, box, editable, selected, onDragBody, onText }: TextCardProps) {
  const style = textStyleOf(item);
  const css = textCss(style);
  const empty = item.text === '';
  return (
    <div data-media-id={item.id} data-media-kind="text" style={{ ...box, overflow: 'visible' }}>
      {(empty || selected) && editable && (
        <div
          aria-hidden="true"
          data-text-outline
          style={{
            position: 'absolute',
            inset: 0,
            border: '1px dashed rgba(113, 113, 122, 0.55)',
            borderRadius: 3,
            pointerEvents: 'none',
          }}
        />
      )}
      {/* A grab strip along the top edge, so a box full of text can still be
          picked up without selecting the text inside it. */}
      <div
        aria-hidden="true"
        title="Drag to move"
        style={{
          position: 'absolute',
          left: 0,
          top: -TEXT_GRAB_HEIGHT,
          width: '100%',
          height: TEXT_GRAB_HEIGHT,
          cursor: editable ? 'move' : 'default',
        }}
        {...onDragBody}
      />
      <textarea
        aria-label="Text"
        data-text-content
        value={item.text}
        readOnly={!editable}
        placeholder={editable ? 'Type…' : ''}
        onChange={(e) => onText(e.target.value)}
        onPointerDown={(e) => e.stopPropagation()}
        spellCheck={false}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          resize: 'none',
          border: 'none',
          outline: 'none',
          background: 'transparent',
          padding: 0,
          overflow: 'hidden',
          fontFamily: css.fontFamily,
          fontSize: css.fontSize,
          lineHeight: css.lineHeight,
          fontWeight: css.fontWeight,
          fontStyle: css.fontStyle,
          textDecorationLine: css.textDecorationLine,
          color: css.color,
          textAlign: css.textAlign,
        }}
      />
    </div>
  );
}

/** One control on the floating toolbar over a selected object. */
const toolbarButton =
  'inline-flex h-7 items-center rounded-md px-2 text-xs font-medium text-white hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-blue-300';

/** Colours a text box can be set in: ink colours, on paper. */
const TEXT_COLORS: readonly string[] = ['#18181b', '#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#2563eb', '#7c3aed', '#ffffff'];

/**
 * The formatting controls for the selected text box.
 *
 * Everything applies to the whole box, which is what makes the model simple
 * enough to export exactly: PDF has no "bold" attribute, only separate fonts,
 * so a box that is one style throughout resolves to one font. Mixed runs
 * inside a box would need a different data model and a much harder export.
 */
function TextToolbar({ item, onPatch }: { item: TextBox; onPatch: (patch: Partial<MediaObject>) => void }) {
  const style = textStyleOf(item);
  const patch = (next: Partial<TextStyle>): void => onPatch(next as Partial<MediaObject>);
  const toggle = (
    key: 'bold' | 'italic' | 'underline' | 'strikethrough',
    Icon: LucideIcon,
    label: string,
  ) => (
    <button
      type="button"
      className={`${toolbarButton} ${style[key] ? 'bg-blue-500 hover:bg-blue-500' : ''}`}
      aria-pressed={style[key]}
      data-text-toggle={key}
      onClick={() => patch({ [key]: !style[key] } as Partial<TextStyle>)}
      title={label}
      aria-label={label}
    >
      <Icon size={14} aria-hidden="true" />
    </button>
  );

  return (
    <>
      <select
        aria-label="Font"
        data-text-font
        className="h-6 rounded bg-white/10 px-1 text-xs text-white focus-visible:outline-2 focus-visible:outline-blue-300"
        value={style.fontFamily}
        onChange={(e) => patch({ fontFamily: e.target.value as TextFontId })}
      >
        {TEXT_FONTS.map((font) => (
          <option key={font.id} value={font.id} className="text-zinc-900">
            {font.label}
          </option>
        ))}
      </select>
      <select
        aria-label="Font size"
        data-text-size
        className="h-6 rounded bg-white/10 px-1 text-xs tabular-nums text-white focus-visible:outline-2 focus-visible:outline-blue-300"
        value={style.fontSize}
        onChange={(e) => patch({ fontSize: Number(e.target.value) })}
      >
        {TEXT_SIZES.map((size) => (
          <option key={size} value={size} className="text-zinc-900">
            {size}
          </option>
        ))}
      </select>

      <span className="mx-0.5 h-5 w-px bg-white/20" aria-hidden="true" />
      <div className="flex items-center gap-0.5" role="group" aria-label="Text style">
        {toggle('bold', Bold, 'Bold')}
        {toggle('italic', Italic, 'Italic')}
        {toggle('underline', Underline, 'Underline')}
        {toggle('strikethrough', Strikethrough, 'Strikethrough')}
      </div>

      <span className="mx-0.5 h-5 w-px bg-white/20" aria-hidden="true" />
      <div className="flex items-center gap-0.5" role="group" aria-label="Alignment">
        {([
          ['left', AlignLeft, 'Align left'],
          ['center', AlignCenter, 'Align centre'],
          ['right', AlignRight, 'Align right'],
        ] as const).map(([value, Icon, label]) => (
          <button
            key={value}
            type="button"
            className={`${toolbarButton} ${style.align === value ? 'bg-blue-500 hover:bg-blue-500' : ''}`}
            aria-pressed={style.align === value}
            data-text-align={value}
            onClick={() => patch({ align: value })}
            title={label}
            aria-label={label}
          >
            <Icon size={14} aria-hidden="true" />
          </button>
        ))}
      </div>

      <span className="mx-0.5 h-5 w-px bg-white/20" aria-hidden="true" />
      <div className="flex items-center gap-0.5" role="group" aria-label="Text colour">
        {TEXT_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className={`h-5 w-5 rounded-full ring-1 hover:ring-white focus-visible:outline-2 focus-visible:outline-blue-300 ${
              style.color.toLowerCase() === color ? 'ring-2 ring-white' : 'ring-white/40'
            }`}
            style={{ background: color }}
            data-text-color={color}
            onClick={() => patch({ color })}
            title={`Text colour ${color}`}
            aria-label={`Text colour ${color}`}
          />
        ))}
        <input
          type="color"
          aria-label="Custom text colour"
          data-text-color-custom
          className="h-5 w-5 cursor-pointer rounded border-0 bg-transparent p-0"
          value={/^#[0-9a-f]{6}$/i.test(style.color) ? style.color : '#18181b'}
          onChange={(e) => patch({ color: e.target.value })}
        />
      </div>
    </>
  );
}

interface TableCardProps {
  table: TableLayer;
  box: CSSProperties;
  editable: boolean;
  /** Dividers only appear on the selected table; otherwise they are in the way. */
  selected: boolean;
  zoom: number;
  onDragBody: BodyHandlers;
  onCell: (row: number, column: number, value: string) => void;
  onPatch: (patch: Partial<TableLayer>) => void;
}

/** The grid's line weight and tint, with the defaults older files lack. */
function gridLine(table: TableLayer): { width: number; color: string } {
  const width = table.lineWidth ?? DEFAULT_TABLE_LINE_WIDTH;
  const opacity = table.lineOpacity ?? DEFAULT_TABLE_LINE_OPACITY;
  return { width, color: `rgba(161, 161, 170, ${opacity})` };
}

/**
 * A grid of text inputs filling the box, with the column and row shares the
 * table carries — so a dragged divider is part of the document rather than a
 * view state that evaporates on reload.
 */
function TableCard({ table, box, editable, selected, zoom, onDragBody, onCell, onPatch }: TableCardProps) {
  const columns = columnFractions(table);
  const rows = rowFractions(table);
  const line = gridLine(table);
  const gridHeight = Math.max(1, table.height - TABLE_LIP);
  return (
    <div
      data-media-id={table.id}
      data-media-kind="table"
      data-table-size={`${table.rows}x${table.columns}`}
      style={{
        ...box,
        background: '#ffffff',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        border: `${line.width}px solid ${line.color}`,
      }}
    >
      <div
        aria-hidden="true"
        title="Drag to move"
        style={{ height: TABLE_LIP, flexShrink: 0, cursor: editable ? 'move' : 'default', background: '#e4e4e7' }}
        {...onDragBody}
      />
      <div
        role="table"
        style={{
          position: 'relative',
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: columns.map((f) => `${f}fr`).join(' '),
          gridTemplateRows: rows.map((f) => `${f}fr`).join(' '),
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
                border: `${line.width}px solid ${line.color}`,
                outline: 'none',
                padding: '2px 5px',
                font: '13px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
                color: '#18181b',
                background: 'transparent',
              }}
            />
          )),
        )}
        {editable &&
          selected &&
          trackEdges(columns)
            .slice(1, -1)
            .map((edge, i) => (
              <TrackDivider
                key={`col-${i}`}
                axis="column"
                index={i + 1}
                edge={edge}
                zoom={zoom}
                length={table.width}
                onResize={(position) => onPatch(setColumnFractions(table, resizeTrack(columns, i + 1, position)))}
              />
            ))}
        {editable &&
          selected &&
          trackEdges(rows)
            .slice(1, -1)
            .map((edge, i) => (
              <TrackDivider
                key={`row-${i}`}
                axis="row"
                index={i + 1}
                edge={edge}
                zoom={zoom}
                length={gridHeight}
                onResize={(position) => onPatch(setRowFractions(table, resizeTrack(rows, i + 1, position)))}
              />
            ))}
      </div>
    </div>
  );
}

interface TrackDividerProps {
  axis: 'column' | 'row';
  /** 1-based interior divider index, as `resizeTrack` counts them. */
  index: number;
  /** Where it currently sits, 0..1 across the grid. */
  edge: number;
  zoom: number;
  /** The grid's extent along this axis, page units, for turning px into a share. */
  length: number;
  onResize: (position: number) => void;
}

/**
 * One draggable grid divider. The drag is measured as a delta from where the
 * divider started rather than from the pointer's absolute position, so it
 * survives the table being rotated and needs nothing from the page geometry.
 */
function TrackDivider({ axis, index, edge, zoom, length, onResize }: TrackDividerProps) {
  const start = useRef<{ pointerId: number; client: number; edge: number } | null>(null);
  const column = axis === 'column';
  return (
    <div
      role="separator"
      aria-orientation={column ? 'vertical' : 'horizontal'}
      aria-label={`${column ? 'Column' : 'Row'} divider ${index}`}
      data-table-divider={`${axis}-${index}`}
      style={{
        position: 'absolute',
        ...(column
          ? { left: `${edge * 100}%`, top: 0, bottom: 0, width: DIVIDER_GRAB / zoom, transform: 'translateX(-50%)', cursor: 'col-resize' }
          : { top: `${edge * 100}%`, left: 0, right: 0, height: DIVIDER_GRAB / zoom, transform: 'translateY(-50%)', cursor: 'row-resize' }),
        background: 'rgba(37, 99, 235, 0.25)',
        touchAction: 'none',
        zIndex: 5,
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        start.current = { pointerId: e.pointerId, client: column ? e.clientX : e.clientY, edge };
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* synthetic pointer */
        }
      }}
      onPointerMove={(e) => {
        const from = start.current;
        if (!from || from.pointerId !== e.pointerId || length <= 0) return;
        e.stopPropagation();
        const moved = ((column ? e.clientX : e.clientY) - from.client) / zoom;
        onResize(from.edge + moved / length);
      }}
      onPointerUp={(e) => {
        if (start.current?.pointerId === e.pointerId) start.current = null;
      }}
      onPointerCancel={(e) => {
        if (start.current?.pointerId === e.pointerId) start.current = null;
      }}
    />
  );
}

/** A miniature of a note shape, for the pickers. */
export function NoteShapeGlyph({ shape, size = 13 }: { shape: NoteShape; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true } as const;
  if (shape === 'ellipse') {
    return (
      <svg {...common}>
        <ellipse cx="8" cy="8" rx="7" ry="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    );
  }
  if (shape === 'bubble') {
    return (
      <svg {...common}>
        <rect x="1" y="2" width="14" height="9" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M5 11 L8 11 L5.5 15 Z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
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
        {item.kind === 'text' && <TextToolbar item={item} onPatch={onPatch} />}
        {item.kind === 'note' && (
          <>
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
            <span className="mx-0.5 h-5 w-px bg-white/20" aria-hidden="true" />
            <div className="flex items-center gap-0.5" role="group" aria-label="Note shape">
              {NOTE_SHAPES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`${toolbarButton} ${noteShapeOf(item) === option.id ? 'bg-blue-500 hover:bg-blue-500' : ''}`}
                  aria-pressed={noteShapeOf(item) === option.id}
                  data-note-shape-option={option.id}
                  onClick={() => onPatch({ shape: option.id } as Partial<MediaObject>)}
                  title={option.hint}
                  aria-label={option.hint}
                >
                  <NoteShapeGlyph shape={option.id} />
                </button>
              ))}
            </div>
          </>
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
