import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useDocumentStore } from '../document/store';
import { parsePageRanges } from './forms';
import { buildPdfPages, loadPdfFile, renderPdfThumbnail, type LoadedPdf } from './import';
import type { ImportSizeMode } from './pdfCoords';

const button =
  'inline-flex h-9 items-center justify-center rounded-lg px-3 text-sm font-medium transition-colors ' +
  'bg-zinc-100 text-zinc-800 hover:bg-zinc-200 disabled:opacity-40 disabled:hover:bg-zinc-100 ' +
  'dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700 dark:disabled:hover:bg-zinc-800 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500';
const primary = 'bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-500 dark:text-white dark:hover:bg-blue-400 disabled:hover:bg-blue-600';

interface ThumbProps {
  loaded: LoadedPdf;
  index: number;
  selected: boolean;
  onToggle: (index: number) => void;
}

const PdfThumb = memo(function PdfThumb({ loaded, index, selected, onToggle }: ThumbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const info = loaded.pages[index];
  useEffect(() => {
    let cancelled = false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderPdfThumbnail(loaded, index, Math.round(150 * dpr))
      .then((bitmap) => {
        const canvas = canvasRef.current;
        if (cancelled || !canvas || bitmap.width === 0) return;
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
        canvas.dataset.ready = 'true';
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [loaded, index]);
  if (!info) return null;
  return (
    <li className="list-none">
      <label
        className={`flex cursor-pointer flex-col gap-1.5 rounded-xl p-2 ${
          selected ? 'bg-blue-50 dark:bg-blue-950/50' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/70'
        }`}
        data-import-thumb={index}
      >
        <div
          className={`relative w-full overflow-hidden rounded-md bg-white shadow ring-1 ${selected ? 'ring-blue-500' : 'ring-black/10 dark:ring-white/10'}`}
          style={{ aspectRatio: `${info.widthPt} / ${info.heightPt}` }}
        >
          <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" aria-hidden="true" />
        </div>
        <span className="flex items-center justify-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-300">
          <input type="checkbox" className="h-3.5 w-3.5 accent-blue-600" checked={selected} onChange={() => onToggle(index)} aria-label={`Import page ${index + 1}`} />
          {index + 1}
        </span>
      </label>
    </li>
  );
});

/**
 * "Import PDF" dialog: pick a file, then import every page or a visual /
 * range selection, preserving page size or normalising to A4.
 */
export function ImportPdfDialog() {
  const open = useDocumentStore((s) => s.importDialogOpen);
  const { setOpen, appendPages, activePageIndex, pageCount } = useDocumentStore(
    useShallow((s) => ({
      setOpen: s.setImportDialogOpen,
      appendPages: s.appendPages,
      activePageIndex: s.document.activePageIndex,
      pageCount: s.document.pages.length,
    })),
  );
  const [loaded, setLoaded] = useState<LoadedPdf | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [sizeMode, setSizeMode] = useState<ImportSizeMode>('preserve');
  const [placement, setPlacement] = useState<'end' | 'after-current'>('end');
  const [range, setRange] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setLoaded(null);
    setSelected(new Set());
    setRange('');
    setBusy(null);
    setError(null);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    reset();
  }, [setOpen, reset]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  const onFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setBusy('Reading PDF…');
    setError(null);
    try {
      const result = await loadPdfFile(file);
      setLoaded(result);
      setSelected(new Set(result.pages.map((p) => p.index)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read this PDF');
    } finally {
      setBusy(null);
    }
  };

  const runImport = async (indices: readonly number[]): Promise<void> => {
    if (!loaded || indices.length === 0) return;
    setBusy(`Importing ${indices.length} page${indices.length === 1 ? '' : 's'}…`);
    try {
      const pages = await buildPdfPages(loaded, indices, { sizeMode });
      appendPages(pages, placement === 'end' ? pageCount : activePageIndex + 1);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
      setBusy(null);
    }
  };

  const toggle = useCallback((index: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  if (!open) return null;
  const all = loaded?.pages.map((p) => p.index) ?? [];

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Import PDF"
        data-import-dialog
        className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-zinc-900"
      >
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-200 px-5 dark:border-zinc-800">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Import PDF</h2>
          <button type="button" className={button} onClick={close}>
            Close
          </button>
        </header>

        <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 px-5 py-3 text-sm dark:border-zinc-800">
          <label className={`${button} ${primary} cursor-pointer`}>
            Choose PDF…
            <input
              type="file"
              accept="application/pdf,.pdf"
              className="sr-only"
              aria-label="PDF file"
              onChange={(e) => {
                void onFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>
          {loaded && (
            <span className="text-zinc-600 dark:text-zinc-300" data-import-page-count={loaded.pages.length}>
              <strong className="font-medium text-zinc-900 dark:text-zinc-100">{loaded.name}</strong> · {loaded.pages.length} page
              {loaded.pages.length === 1 ? '' : 's'}
            </span>
          )}
          {busy && <span className="text-blue-600 dark:text-blue-300" role="status">{busy}</span>}
          {error && <span className="text-rose-600 dark:text-rose-300" role="alert">{error}</span>}
        </div>

        {loaded && (
          <>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-zinc-200 px-5 py-3 text-sm dark:border-zinc-800">
              <fieldset className="flex items-center gap-3">
                <legend className="sr-only">Page size</legend>
                <span className="text-zinc-600 dark:text-zinc-300">Size</span>
                <label className="flex items-center gap-1.5">
                  <input type="radio" name="pdf-size" className="accent-blue-600" checked={sizeMode === 'preserve'} onChange={() => setSizeMode('preserve')} />
                  Keep original
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="radio" name="pdf-size" className="accent-blue-600" checked={sizeMode === 'a4'} onChange={() => setSizeMode('a4')} />
                  Normalise to A4
                </label>
              </fieldset>
              <fieldset className="flex items-center gap-3">
                <legend className="sr-only">Placement</legend>
                <span className="text-zinc-600 dark:text-zinc-300">Insert</span>
                <label className="flex items-center gap-1.5">
                  <input type="radio" name="pdf-place" className="accent-blue-600" checked={placement === 'end'} onChange={() => setPlacement('end')} />
                  At end
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="radio" name="pdf-place" className="accent-blue-600" checked={placement === 'after-current'} onChange={() => setPlacement('after-current')} />
                  After current page
                </label>
              </fieldset>
            </div>

            <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-5 py-3 text-sm dark:border-zinc-800">
              <button type="button" className={button} onClick={() => setSelected(new Set(all))}>
                Select all
              </button>
              <button type="button" className={button} onClick={() => setSelected(new Set())}>
                Select none
              </button>
              <label className="flex items-center gap-2">
                <span className="text-zinc-600 dark:text-zinc-300">Range</span>
                <input
                  type="text"
                  className="h-9 w-32 rounded-lg border border-zinc-300 bg-white px-2 dark:border-zinc-700 dark:bg-zinc-900"
                  placeholder="1-3, 5"
                  aria-label="Page range"
                  value={range}
                  onChange={(e) => setRange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') setSelected(new Set(parsePageRanges(range, loaded.pages.length)));
                  }}
                />
                <button type="button" className={button} onClick={() => setSelected(new Set(parsePageRanges(range, loaded.pages.length)))}>
                  Apply range
                </button>
              </label>
            </div>

            <ol className="grid flex-1 grid-cols-3 content-start gap-2 overflow-y-auto p-4 sm:grid-cols-4 md:grid-cols-5" aria-label="PDF pages">
              {loaded.pages.map((p) => (
                <PdfThumb key={p.index} loaded={loaded} index={p.index} selected={selected.has(p.index)} onToggle={toggle} />
              ))}
            </ol>

            <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
              <button type="button" className={button} disabled={busy !== null || selected.size === 0} onClick={() => void runImport([...selected].sort((a, b) => a - b))}>
                Import selected ({selected.size})
              </button>
              <button type="button" className={`${button} ${primary}`} disabled={busy !== null} onClick={() => void runImport(all)}>
                Import all {loaded.pages.length} pages
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
