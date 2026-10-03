/**
 * The handwriting recogniser, behind the desktop shell.
 *
 * On Windows the shell reads ink with the system's own recogniser (`src-tauri/src/handwriting.rs`); elsewhere it
 * has none, and a browser has no shell at all. Whether this device can read handwriting is asked once and kept
 * here, with the names of the recognisers (languages) it has, for the reader and the settings to share.
 */
import { create } from 'zustand';
import { isTauri, tauriInvoke } from '../desktop/tauri';
import type { InkWord } from '../document/types';
import { toInkWord } from './inkText';

export type RecognizerStatus =
  /** Not asked yet. */
  | 'unknown'
  | 'checking'
  /** It can read handwriting. */
  | 'ready'
  /** It has no recogniser: not Windows, or Windows with no handwriting installed. */
  | 'none'
  /** It has one, but reading keeps failing; `error` says how. */
  | 'failed';

export interface RecognizerState {
  readonly status: RecognizerStatus;
  /** The recognisers installed, by name ("Microsoft English (US) Handwriting Recognizer", …). */
  readonly names: readonly string[];
  /** Why reading last failed, in the shell's words. */
  readonly error: string | null;
}

export const useRecognizerStore = create<RecognizerState>()(() => ({ status: 'unknown', names: [], error: null }));

/** Ask, once, whether this device can read handwriting. Later calls answer from what was found. */
export async function checkRecognizers(): Promise<boolean> {
  const { status } = useRecognizerStore.getState();
  if (status === 'ready') return true;
  if (status !== 'unknown') return false;
  if (!isTauri()) {
    useRecognizerStore.setState({ status: 'none' });
    return false;
  }
  useRecognizerStore.setState({ status: 'checking' });
  try {
    const found = await tauriInvoke<{ names?: unknown }>('ink_recognizers');
    const names = Array.isArray(found?.names) ? found.names.filter((n): n is string => typeof n === 'string' && n.trim().length > 0) : [];
    useRecognizerStore.setState({ status: names.length > 0 ? 'ready' : 'none', names });
    return names.length > 0;
  } catch {
    // An older shell without the command, or no recogniser to be had.
    useRecognizerStore.setState({ status: 'none', names: [] });
    return false;
  }
}

/** Read a page's handwriting (see `recognizerInput`), with `recognizer` or the system's default. */
export async function recognizeInk(strokes: readonly { points: number[] }[], recognizer: string | null): Promise<InkWord[]> {
  const raw = await tauriInvoke<unknown>('recognize_ink', { strokes, recognizer });
  if (!Array.isArray(raw)) return [];
  const words: InkWord[] = [];
  for (const item of raw) {
    const word = toInkWord(item);
    if (word) words.push(word);
  }
  return words;
}
