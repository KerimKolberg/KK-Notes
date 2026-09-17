import { useCallback, useEffect, type DragEvent as ReactDragEvent } from 'react';
import { viewportToPagePoint } from '../layout';
import { createImageLayer, nextZIndex } from '../media';
import { useDocumentStore } from '../store';
import { useToolStore } from '../toolStore';
import type { Point } from '../../inking/types';

export interface DecodedImage {
  readonly src: string;
  readonly mime: string;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
}

/** Read an image file into a data URL and measure it. */
export async function readImageFile(file: Blob): Promise<DecodedImage> {
  const src = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read image'));
    reader.readAsDataURL(file);
  });
  const bitmap = await createImageBitmap(file);
  const decoded = { src, mime: file.type || 'image/png', naturalWidth: bitmap.width, naturalHeight: bitmap.height };
  bitmap.close();
  return decoded;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

/**
 * Clipboard paste and drag-and-drop of images (and PDFs) onto pages.
 * Returns drop handlers for the viewer container.
 */
export function useMediaInput(onPdfDropped?: (file: File) => void) {
  const addImage = useDocumentStore((s) => s.addImage);
  const setTool = useToolStore((s) => s.update);

  const placeImage = useCallback(
    async (file: Blob, pageIndex: number | null, at: Point | null) => {
      const state = useDocumentStore.getState();
      if (state.readOnly) return;
      const doc = state.document;
      const index = pageIndex ?? doc.activePageIndex;
      const page = doc.pages[index];
      if (!page) return;
      const decoded = await readImageFile(file);
      const layer = createImageLayer({
        ...decoded,
        page: page.dimensions,
        ...(at ? { at } : {}),
        zIndex: nextZIndex(page.images),
      });
      addImage(page.id, layer);
      state.setActivePage(index);
      setTool({ tool: 'select' });
    },
    [addImage, setTool],
  );

  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      if (isEditableTarget(e.target)) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            void placeImage(file, null, null);
            return;
          }
        }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [placeImage]);

  const onDragOver = useCallback((e: ReactDragEvent<HTMLElement>) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const onDrop = useCallback(
    (e: ReactDragEvent<HTMLElement>) => {
      const files = [...e.dataTransfer.files];
      if (files.length === 0) return;
      e.preventDefault();
      const frame = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-page-index]') ?? null;
      let pageIndex: number | null = null;
      let at: Point | null = null;
      if (frame) {
        pageIndex = Number(frame.dataset.pageIndex);
        const rect = frame.getBoundingClientRect();
        const zoom = useDocumentStore.getState().document.zoom;
        at = viewportToPagePoint(e.clientX, e.clientY, rect, zoom);
      }
      for (const file of files) {
        if (file.type.startsWith('image/')) void placeImage(file, pageIndex, at);
        else if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) onPdfDropped?.(file);
      }
    },
    [placeImage, onPdfDropped],
  );

  return { onDragOver, onDrop, placeImage };
}
