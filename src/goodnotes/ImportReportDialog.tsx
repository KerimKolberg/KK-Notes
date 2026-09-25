/**
 * What came in from GoodNotes, said plainly.
 *
 * This exists because the import is inference. GoodNotes publishes no format, so
 * the app cannot promise a faithful read — and a feature that cannot promise
 * that has to show its working instead. Counts, the caveats, and, when it went
 * wrong, what the archive actually held plus the route that does work.
 *
 * Shown once per import and dismissed by hand rather than on a timer: the whole
 * point is that it is read.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, Check } from 'lucide-react';
import { useImportReportStore } from './reportStore';

const button =
  'inline-flex h-9 items-center justify-center rounded-lg px-3 text-sm font-medium transition-colors ' +
  'bg-zinc-100 text-zinc-800 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500';
const primary = 'bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-400';

/** `1.4 kB`, `212 kB`, `3.1 MB` — enough to tell a page from a thumbnail. */
function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ImportReportDialog(): React.JSX.Element | null {
  const outcome = useImportReportStore((s) => s.outcome);
  const setOutcome = useImportReportStore((s) => s.setOutcome);
  const [showFiles, setShowFiles] = useState(false);

  useEffect(() => {
    if (!outcome) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOutcome(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [outcome, setOutcome]);

  // Collapse the listing again between imports, so the next one opens closed.
  useEffect(() => {
    if (!outcome) setShowFiles(false);
  }, [outcome]);

  if (!outcome) return null;
  const failed = outcome.kind === 'failed';
  const entries = failed ? outcome.entries : outcome.report.entries;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onPointerDown={(e) => e.target === e.currentTarget && setOutcome(null)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={failed ? 'GoodNotes import failed' : 'GoodNotes import summary'}
        data-goodnotes-report
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-zinc-900"
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
          {failed ? (
            <AlertTriangle size={18} className="text-amber-600 dark:text-amber-400" aria-hidden="true" />
          ) : (
            <Check size={18} className="text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          )}
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            {failed ? 'That notebook could not be read' : `Imported ${outcome.report.title}`}
          </h2>
        </header>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4 text-sm text-zinc-700 dark:text-zinc-300">
          {failed ? (
            <p data-report-message>{outcome.message}</p>
          ) : (
            <>
              <p data-report-counts className="text-zinc-900 dark:text-zinc-100">
                {outcome.report.pages} page{outcome.report.pages === 1 ? '' : 's'} and{' '}
                {outcome.report.strokes.toLocaleString()} stroke
                {outcome.report.strokes === 1 ? '' : 's'}, scaled from {outcome.report.fit.source}.
              </p>
              <ul className="mt-3 list-disc space-y-1.5 pl-5" data-report-warnings>
                {outcome.report.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </>
          )}

          {entries.length > 0 && (
            <div className="mt-4">
              <button
                type="button"
                className="text-xs font-medium text-blue-700 hover:underline dark:text-blue-300"
                onClick={() => setShowFiles((open) => !open)}
                data-report-toggle-files
              >
                {showFiles ? 'Hide' : 'Show'} what the archive held ({entries.length} file
                {entries.length === 1 ? '' : 's'})
              </button>
              {showFiles && (
                <ul
                  className="mt-2 max-h-48 overflow-auto rounded-lg bg-zinc-50 p-2 font-mono text-xs text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-400"
                  data-report-files
                >
                  {entries.map((entry) => (
                    <li key={entry.name} className="flex justify-between gap-3">
                      <span className="truncate">{entry.name}</span>
                      <span className="shrink-0">{size(entry.bytes)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <footer className="flex shrink-0 justify-end gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <button type="button" className={`${button} ${primary}`} onClick={() => setOutcome(null)} data-report-dismiss>
            {failed ? 'Close' : 'Got it'}
          </button>
        </footer>
      </div>
    </div>
  );
}
