import { useLayoutEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { textGrabStrip, TEXT_LINE_HEIGHT } from '../document/media';
import { isRichEmpty, richBaseOf, richOf, richPatch } from '../document/richText';
import { useDocumentStore, type TextEditKind } from '../document/store';
import type { RichText, TextBox } from '../document/types';
import { useEditorModule } from './editorLoader';
import { renderRich } from './richDom';
import type { EditorEdges } from './editor/RichEditor';

export interface BodyHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
}

interface RichTextCardProps {
  readonly item: TextBox;
  readonly pageId: string;
  readonly box: CSSProperties;
  readonly editable: boolean;
  readonly selected: boolean;
  readonly zoom: number;
  readonly onDragBody: BodyHandlers;
  /** Page text: what happens at its edges, where it continues on the pages around it. */
  readonly edges?: EditorEdges;
  /** Page text: called after each change, to let it flow on (`flow/`). */
  readonly onEdited?: (mediaId: string) => void;
}

/**
 * Typed text on the page: the words and their formatting, edited in place with the keyboard.
 *
 * The box has no card and no border of its own. An empty one would therefore be invisible and unfindable, so
 * while the media layer is live an empty box shows a dashed outline; it disappears the moment there is text, and
 * never appears in the export. It is as tall as its text (a box from before text could be formatted in parts kept
 * the size it was given, and hid what overflowed, until it is edited), and page text is the page's own size.
 */
export function RichTextCard({ item, pageId, box, editable, selected, zoom, onDragBody, edges, onEdited }: RichTextCardProps) {
  const editor = useEditorModule();
  const strip = textGrabStrip(zoom);
  const rich = richOf(item);
  const empty = isRichEmpty(rich);
  const grows = item.rich !== undefined && !item.flow;
  const cardRef = useRef<HTMLDivElement>(null);

  // A box that grows with its text keeps its height in step while it is being worked on — a size or a style
  // chosen for the whole box changes it without a keystroke.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card || !grows || !selected || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const height = card.offsetHeight;
      const current = useDocumentStore.getState().document.pages.find((p) => p.id === pageId)?.media.find((m) => m.id === item.id);
      if (current && Math.abs(current.height - height) > 0.5) useDocumentStore.getState().updateMedia(pageId, item.id, { height });
    });
    observer.observe(card);
    return () => observer.disconnect();
  }, [grows, selected, pageId, item.id]);

  const onChange = (next: RichText, kind: TextEditKind, height: number): void => {
    const patch: Partial<TextBox> = { ...richPatch(next), ...(item.flow ? {} : { height: Math.max(height, item.fontSize * TEXT_LINE_HEIGHT) }) };
    useDocumentStore.getState().editText(pageId, item.id, patch, kind);
    onEdited?.(item.id);
  };

  const style: CSSProperties = {
    ...box,
    overflow: item.rich || item.flow ? 'visible' : 'hidden',
    ...(grows ? { height: 'auto', minHeight: item.fontSize * TEXT_LINE_HEIGHT } : {}),
  };
  return (
    <div ref={cardRef} data-media-id={item.id} data-media-kind="text" data-text-flow={item.flow ? '' : undefined} style={style}>
      {(empty || selected) && editable && !item.flow && (
        <div
          aria-hidden="true"
          data-text-outline
          style={{ position: 'absolute', inset: 0, border: '1px dashed rgba(113, 113, 122, 0.55)', borderRadius: 3, pointerEvents: 'none' }}
        />
      )}
      {/* A grab strip along the top edge, so a box full of text can still be picked up without selecting the
          text inside it. Sized in screen px (hence `/ zoom`) so it stays a finger-sized target at any zoom.
          Page text has none: it is where the page's margins put it. */}
      {!item.flow && (
        <div
          aria-hidden="true"
          title="Drag to move"
          data-text-grab
          style={{ position: 'absolute', left: 0, top: strip.top, width: '100%', height: strip.height, cursor: editable ? 'move' : 'default', touchAction: 'none' }}
          {...onDragBody}
        />
      )}
      {editor ? (
        <editor.RichEditor
          box={item}
          pageId={pageId}
          editable={editable}
          placeholder={item.flow ? 'Type here…' : 'Type…'}
          onChange={onChange}
          {...(edges ? { edges } : {})}
        />
      ) : (
        <StaticRich item={item} />
      )}
    </div>
  );
}

/** The text as the editor will show it, until the editor has loaded. */
function StaticRich({ item }: { item: TextBox }) {
  const ref = useRef<HTMLDivElement>(null);
  const rich = richOf(item);
  const base = richBaseOf(item);
  useLayoutEffect(() => {
    ref.current?.replaceChildren(renderRich(rich, base));
  }, [rich, base.fontFamily, base.fontSize, base.color, base.align]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={ref} data-rich-static />;
}
