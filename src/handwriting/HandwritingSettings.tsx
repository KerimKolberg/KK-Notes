import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useDesktopStore } from '../desktop/desktopStore';
import { useDocumentStore } from '../document/store';
import { usePreferencesStore } from '../preferences/store';
import { Row, Switch } from '../ui/SettingsRow';
import { DEFAULT_RECOGNIZER, handwritingProgress, recognizerLabel } from './inkText';
import { checkRecognizers, useRecognizerStore } from './recognizer';

const NOTE = 'px-1 text-xs text-zinc-500 dark:text-zinc-400';

/**
 * Reading handwriting for search, in the settings: on or off, which language to read it in (where Windows has
 * more than one), and how far it has got with this note. Only where the device can read handwriting; in the
 * app elsewhere a line says where it can.
 */
export function HandwritingSettings() {
  const { enabled, chosen, setEnabled, setChosen } = usePreferencesStore(
    useShallow((s) => ({
      enabled: s.handwritingSearch,
      chosen: s.handwritingRecognizer,
      setEnabled: s.setHandwritingSearch,
      setChosen: s.setHandwritingRecognizer,
    })),
  );
  const { status, names, error } = useRecognizerStore(useShallow((s) => ({ status: s.status, names: s.names, error: s.error })));
  const isDesktop = useDesktopStore((s) => s.isDesktop);
  const recognizer = chosen && names.includes(chosen) ? chosen : null;
  const progress = useDocumentStore(useShallow((s) => handwritingProgress(s.document.pages, recognizer ?? DEFAULT_RECOGNIZER)));

  useEffect(() => {
    void checkRecognizers();
  }, []);

  if (status === 'unknown' || status === 'checking') return null;
  if (status === 'none') {
    return isDesktop ? (
      <p className={NOTE} data-handwriting-unavailable>
        Handwriting search reads handwriting with Windows&rsquo; handwriting recognition, which this device does not have.
        Notes whose handwriting was read on a Windows PC are still searchable here.
      </p>
    ) : null;
  }

  return (
    <>
      <Row label="Handwriting search">
        <Switch checked={enabled} onChange={setEnabled}>
          <span data-handwriting-search>Read my handwriting</span>
        </Switch>
      </Row>
      {enabled && names.length > 1 && (
        <Row label="Language">
          <select
            value={recognizer ?? ''}
            onChange={(e) => setChosen(e.target.value || null)}
            aria-label="Language to read handwriting in"
            data-handwriting-recognizer
            className="h-8 max-w-[11rem] rounded-lg border border-zinc-300 bg-white px-2 text-xs text-zinc-900 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
          >
            <option value="">Windows default</option>
            {names.map((name) => (
              <option key={name} value={name}>
                {recognizerLabel(name)}
              </option>
            ))}
          </select>
        </Row>
      )}
      <p className={NOTE} data-handwriting-note>
        {enabled
          ? `${progress.total > 0 ? `Read on ${progress.read} of ${progress.total} ${progress.total === 1 ? 'page' : 'pages'} with handwriting in this note. ` : ''}Windows reads it on this PC a moment after you stop writing; nothing leaves the device. It is saved with the note, so it is found on your other devices too.`
          : 'Off: new handwriting is not read, and only what was read before is found.'}
      </p>
      {(status === 'failed' || error) && (
        <p className="px-1 text-xs text-rose-600 dark:text-rose-300" data-handwriting-error>
          {status === 'failed' ? 'Reading handwriting has stopped: ' : 'A page could not be read: '}
          {error ?? 'Windows could not read it.'} If no language has handwriting installed, add it in Windows Settings → Time
          &amp; language → Language &amp; region → a language&rsquo;s options → Handwriting.
        </p>
      )}
    </>
  );
}
