import { memo, useCallback, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  RESIZE_HANDLES,
  handlePositions,
  imageCenter,
  moveImage,
  resizeImage,
  rotationFromPointer,
  sortedByZ,
  toLocalDelta,
  type ResizeHandle,
} from '../media';
import { useDocumentStore } from '../store';
import type { ImageLayer, Page } from '../types';

export interface MediaLayerProps {
  page: Page;
  zoom: number;
  /** Only the select tool interacts with images. */
  active: boolean;
}

type DragKind = 'move' | 'resize' | 'rotate';

interface Drag {
  kind: DragKind;
  handle?: ResizeHandle;
  pointerId: number;
  startX: number;
  startY: number;
  origin: ImageLayer;
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
 * z-10 media layer: user-placed images in page units inside a zoom-scaled
 * container, with a transform box (8 resize handles, rotation handle, body
 * drag) and a contextual toolbar on the selected image. Transform previews
 * live in local state and are committed to the store on release.
 */
export const MediaLayer = memo(function MediaLayer({ page, zoom, active }: MediaLayerProps) {
  const { selectedImage, selectImage, updateImage, removeImage, bringImageToFront, sendImageToBack } = useDocumentStore(
    useShallow((s) => ({
      selectedImage: s.selectedImage,
      selectImage: s.selectImage,
      updateImage: s.updateImage,
      removeImage: s.removeImage,
      bringImageToFront: s.bringImageToFront,
      sendImageToBack: s.sendImageToBack,
    })),
  );
  const [draft, setDraft] = useState<ImageLayer | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedId = selectedImage?.pageId === page.id ? selectedImage.imageId : null;
  const images = sortedByZ(page.images);
  const selected = images.find((img) => img.id === selectedId) ?? null;
  const shown = (img: ImageLayer): ImageLayer => (draft && draft.id === img.id ? draft : img);

  const pagePoint = useCallback(
    (clientX: number, clientY: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom };
    },
    [zoom],
  );

  const begin = useCallback(
    (e: ReactPointerEvent<HTMLElement>, kind: DragKind, image: ImageLayer, handle?: ResizeHandle) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      selectImage({ pageId: page.id, imageId: image.id });
      dragRef.current = { kind, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, origin: image, ...(handle ? { handle } : {}) };
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic pointer */
      }
    },
    [page.id, selectImage],
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
        setDraft(resizeImage(drag.origin, drag.handle, local.x, local.y, !e.shiftKey));
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
          updateImage(page.id, current.id, { x, y, width, height, rotation });
        }
        return null;
      });
    },
    [page.id, updateImage],
  );

  const interactive = active;

  return (
    <div
      className="absolute inset-0 z-10"
      style={{ pointerEvents: interactive ? 'auto' : 'none' }}
      data-media-layer={page.id}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.mediaCanvas !== undefined) selectImage(null);
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
        {images.map((raw) => {
          const img = shown(raw);
          return (
            <img
              key={img.id}
              src={img.src}
              alt=""
              draggable={false}
              data-image-id={img.id}
              style={{
                position: 'absolute',
                left: img.x,
                top: img.y,
                width: img.width,
                height: img.height,
                transform: `rotate(${img.rotation}deg)`,
                transformOrigin: 'center',
                zIndex: img.zIndex,
                cursor: interactive ? 'move' : 'default',
                userSelect: 'none',
                pointerEvents: interactive ? 'auto' : 'none',
                outline: img.id === selectedId ? '1.5px solid rgba(37, 99, 235, 0.9)' : 'none',
                outlineOffset: -1,
              }}
              onPointerDown={(e) => begin(e, 'move', raw)}
              onPointerMove={onMove}
              onPointerUp={(e) => finish(e, true)}
              onPointerCancel={(e) => finish(e, false)}
              onContextMenu={(e) => {
                e.preventDefault();
                selectImage({ pageId: page.id, imageId: raw.id });
              }}
            />
          );
        })}

        {interactive && selected && (
          <TransformBox
            image={shown(selected)}
            zoom={zoom}
            onBegin={(e, kind, handle) => begin(e, kind, selected, handle)}
            onMove={onMove}
            onEnd={finish}
            onDelete={() => removeImage(page.id, selected.id)}
            onFront={() => bringImageToFront(page.id, selected.id)}
            onBack={() => sendImageToBack(page.id, selected.id)}
          />
        )}
      </div>
    </div>
  );
});

interface TransformBoxProps {
  image: ImageLayer;
  zoom: number;
  onBegin: (e: ReactPointerEvent<HTMLElement>, kind: DragKind, handle?: ResizeHandle) => void;
  onMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onEnd: (e: ReactPointerEvent<HTMLElement>, commit: boolean) => void;
  onDelete: () => void;
  onFront: () => void;
  onBack: () => void;
}

function TransformBox({ image, zoom, onBegin, onMove, onEnd, onDelete, onFront, onBack }: TransformBoxProps) {
  const handles = handlePositions(image);
  const centre = imageCenter(image);
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
  const rad = (image.rotation * Math.PI) / 180;
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
          left: image.x,
          top: image.y,
          width: image.width,
          height: image.height,
          transform: `rotate(${image.rotation}deg)`,
          transformOrigin: 'center',
          border: `${1 / zoom}px dashed rgba(37, 99, 235, 0.7)`,
          pointerEvents: 'none',
          zIndex: 9999,
          boxSizing: 'border-box',
        }}
      />
      {RESIZE_HANDLES.map((h) => (
        <div
          key={h}
          role="presentation"
          data-resize-handle={h}
          style={handleStyle(handles[h], HANDLE_CURSORS[h])}
          onPointerDown={(e) => onBegin(e, 'resize', h)}
          {...drag}
        />
      ))}
      <div
        role="presentation"
        data-rotate-handle
        style={{ ...handleStyle(rotHandle, 'grab'), borderRadius: '50%' }}
        onPointerDown={(e) => onBegin(e, 'rotate')}
        {...drag}
      />
      <div
        role="toolbar"
        aria-label="Image actions"
        data-image-toolbar
        style={{
          position: 'absolute',
          left: toolbarPos.x,
          top: toolbarPos.y,
          transform: `translate(-50%, 0) scale(${1 / zoom})`,
          transformOrigin: 'top center',
          zIndex: 10001,
          pointerEvents: 'auto',
        }}
        className="flex items-center gap-0.5 rounded-lg bg-zinc-900/90 p-1 shadow-lg backdrop-blur"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button type="button" className={toolbarButton} onClick={onFront} title="Bring to front" aria-label="Bring to front">
          Front
        </button>
        <button type="button" className={toolbarButton} onClick={onBack} title="Send to back" aria-label="Send to back">
          Back
        </button>
        <button type="button" className={`${toolbarButton} text-rose-200`} onClick={onDelete} title="Delete image" aria-label="Delete image">
          Delete
        </button>
      </div>
    </>
  );
}
