/**
 * Recording sound while writing.
 *
 * The microphone is recorded with the browser engine's own recorder (`MediaRecorder`, Opus in WebM, about 4 KB a
 * second) in one-second chunks kept in memory, and every stroke begun while it runs is noted with when it was begun
 * (`stroke.createdAt`, in seconds from the start). Stopping puts the recording in the note — the audio as bytes, the
 * strokes as marks — and saves the note when it has a file, because a lecture is not something to lose to a forgotten
 * Save. Leaving the note while it runs (another tab, the library, opening a file) stops it and puts it in that note
 * wherever the note went: its tab, or straight into its file; closing the window waits for it to be saved first.
 */
import { create } from 'zustand';
import { useDesktopStore } from '../desktop/desktopStore';
import { isTauri } from '../desktop/tauri';
import { selectIsDirty, useDocumentStore, type DocumentStore } from '../document/store';
import type { Document, Recording, RecordingMark } from '../document/types';
import { createStrokeId } from '../inking/engine/ids';
import type { Stroke } from '../inking/types';
import { closePlayer } from './player';
import { closesToTray, prepareToQuit } from '../desktop/background';
import { errorMessage } from '../lib/errors';

export type RecorderStatus = 'idle' | 'starting' | 'recording' | 'stopping';

export interface RecorderState {
  readonly status: RecorderStatus;
  /** `performance.now()` when the recording began. */
  readonly startedAt: number;
  /** The note it belongs to. */
  readonly documentId: string | null;
}

export const useRecorderStore = create<RecorderState>()(() => ({ status: 'idle', startedAt: 0, documentId: null }));

/** Kept low: speech is clear at this rate, and an hour is about 15 MB. */
export const AUDIO_BITS_PER_SECOND = 32_000;
/** How often the recorder hands over what it has, so a stop that cannot wait loses at most this much. */
export const CHUNK_MS = 1000;

const notice = (text: string): void => useDesktopStore.getState().setNotice({ text });

/** The first of the formats this engine can record in, best first; `''` to let it choose. */
export function pickMime(isSupported: (type: string) => boolean): string {
  for (const type of ['audio/webm;codecs=opus', 'audio/mp4;codecs=opus', 'audio/mp4', 'audio/webm']) {
    if (isSupported(type)) return type;
  }
  return '';
}

/** When a stroke was begun, in seconds into the recording: its own start time if that falls in it, else now. */
export function markTime(stroke: Pick<Stroke, 'createdAt'>, startedAt: number, now: number): number {
  const at = stroke.createdAt >= startedAt && stroke.createdAt <= now ? stroke.createdAt : now;
  return Math.round(((at - startedAt) / 1000) * 100) / 100;
}

/**
 * The strokes new in `next` (not in `seen`), marked with when they were begun. Only pages whose stroke list changed
 * are looked at, so a stroke committed to a long note costs one page's worth of work.
 */
export function newMarks(
  previous: readonly { readonly id: string; readonly strokes: readonly Stroke[] }[],
  next: readonly { readonly id: string; readonly strokes: readonly Stroke[] }[],
  seen: Set<string>,
  startedAt: number,
  now: number,
): RecordingMark[] {
  const before = new Map(previous.map((p) => [p.id, p.strokes]));
  const out: RecordingMark[] = [];
  for (const page of next) {
    if (before.get(page.id) === page.strokes) continue;
    for (const stroke of page.strokes) {
      if (seen.has(stroke.id)) continue;
      seen.add(stroke.id);
      out.push({ strokeId: stroke.id, t: markTime(stroke, startedAt, now) });
    }
  }
  return out;
}

/** The chunks in order, as far as they run without a gap (one still being read is left for later). */
export function joinChunks(chunks: readonly (ArrayBuffer | undefined)[]): ArrayBuffer | null {
  const parts: ArrayBuffer[] = [];
  for (const chunk of chunks) {
    if (!chunk) break;
    parts.push(chunk);
  }
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  if (total === 0) return null;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(new Uint8Array(part), at);
    at += part.byteLength;
  }
  return out.buffer;
}

interface Session {
  readonly recorder: MediaRecorder;
  readonly stream: MediaStream;
  readonly mime: string;
  readonly startedAt: number;
  readonly startedIso: string;
  readonly documentId: string;
  readonly chunks: (ArrayBuffer | undefined)[];
  next: number;
  reading: number;
  readonly seen: Set<string>;
  readonly marks: RecordingMark[];
  stop: () => void;
}

let session: Session | null = null;

/** A note put away while it was being recorded into, as it was when it went. */
interface Released {
  readonly document: Document;
  readonly filePath: string | null;
  /** Whether it had changes that were not saved. */
  readonly dirty: boolean;
}

/** Start recording into the open note. `false` when it could not (no microphone, or it was not allowed). */
export async function startRecording(): Promise<boolean> {
  if (session || useRecorderStore.getState().status !== 'idle') return false;
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    notice('This device cannot record sound in the app.');
    return false;
  }
  useRecorderStore.setState({ status: 'starting' });
  // What is played back would be recorded again.
  closePlayer();
  const wanted = useDocumentStore.getState().document.id;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: { ideal: 1 }, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    useRecorderStore.setState({ status: 'idle' });
    const name = error instanceof Error ? error.name : '';
    notice(
      name === 'NotAllowedError' || name === 'SecurityError'
        ? 'The microphone was not allowed. Allow it for the app (on Windows also in Settings → Privacy & security → Microphone) and try again.'
        : name === 'NotFoundError'
          ? 'No microphone was found.'
          : `Could not start recording: ${errorMessage(error)}`,
    );
    return false;
  }
  if (useDocumentStore.getState().document.id !== wanted) {
    // The note was left while the microphone was being asked for: nothing to record into.
    stream.getTracks().forEach((t) => t.stop());
    useRecorderStore.setState({ status: 'idle' });
    return false;
  }
  const mime = pickMime((type) => MediaRecorder.isTypeSupported(type));
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: AUDIO_BITS_PER_SECOND });
  } catch (error) {
    stream.getTracks().forEach((t) => t.stop());
    useRecorderStore.setState({ status: 'idle' });
    notice(`Could not start recording: ${errorMessage(error)}`);
    return false;
  }

  const document = useDocumentStore.getState().document;
  const startedAt = performance.now();
  const seen = new Set<string>();
  for (const page of document.pages) for (const stroke of page.strokes) seen.add(stroke.id);
  const s: Session = {
    recorder,
    stream,
    mime: recorder.mimeType || mime || 'audio/webm',
    startedAt,
    startedIso: new Date().toISOString(),
    documentId: document.id,
    chunks: [],
    next: 0,
    reading: 0,
    seen,
    marks: [],
    stop: () => {},
  };
  recorder.ondataavailable = (event) => {
    if (!event.data || event.data.size === 0) return;
    const index = s.next++;
    s.reading += 1;
    void event.data.arrayBuffer().then(
      (buffer) => {
        s.chunks[index] = buffer;
        s.reading -= 1;
      },
      () => {
        s.reading -= 1;
      },
    );
  };

  // All of this before anything is awaited, so no switch of note can fall between the recording starting and its
  // note being watched.
  const unsubscribe = useDocumentStore.subscribe((state, previous) => onDocumentChange(s, state, previous));
  const onUnload = (event: BeforeUnloadEvent): void => {
    // A browser cannot wait for the save; it can only ask.
    event.preventDefault();
  };
  if (!isTauri()) window.addEventListener('beforeunload', onUnload);
  let stopped = false;
  let unlistenClose: (() => void) | null = null;
  s.stop = () => {
    stopped = true;
    unsubscribe();
    unlistenClose?.();
    if (!isTauri()) window.removeEventListener('beforeunload', onUnload);
  };
  session = s;
  recorder.start(CHUNK_MS);
  useRecorderStore.setState({ status: 'recording', startedAt, documentId: s.documentId });

  const unlisten = await guardWindowClose();
  if (stopped) unlisten();
  else unlistenClose = unlisten;
  return true;
}

function onDocumentChange(s: Session, state: DocumentStore, previous: DocumentStore): void {
  if (session !== s) return;
  if (state.document.id !== s.documentId) {
    // The note was put away (another tab, the library, another file): the recording ends and goes with it.
    if (previous.document.id === s.documentId) {
      void finishInto({ document: previous.document, filePath: previous.filePath, dirty: selectIsDirty(previous) });
    }
    return;
  }
  if (state.document.pages === previous.document.pages) return;
  for (const mark of newMarks(previous.document.pages, state.document.pages, s.seen, s.startedAt, performance.now())) s.marks.push(mark);
}

/** Wait for the recorder to hand over its last chunk, then make the recording; `null` if nothing was recorded. */
function finish(s: Session): Promise<Recording | null> {
  s.stop();
  // As long as it ran until now, not until the last chunk has been read.
  const duration = Math.round(((performance.now() - s.startedAt) / 1000) * 10) / 10;
  return new Promise((resolve) => {
    let done = false;
    const build = (): void => {
      if (done) return;
      done = true;
      s.stream.getTracks().forEach((t) => t.stop());
      const data = joinChunks(s.chunks);
      if (!data) {
        resolve(null);
        return;
      }
      resolve({
        id: `rec_${createStrokeId()}`,
        startedAt: s.startedIso,
        duration,
        mime: s.mime,
        data,
        marks: [...s.marks].sort((a, b) => a.t - b.t),
      });
    };
    const settle = (): void => {
      // The last chunk's bytes are read asynchronously: give them a moment.
      const started = performance.now();
      const wait = (): void => {
        if (s.reading === 0 || performance.now() - started > 1500) build();
        else setTimeout(wait, 20);
      };
      wait();
    };
    s.recorder.addEventListener('stop', settle, { once: true });
    try {
      if (s.recorder.state === 'inactive') settle();
      else s.recorder.stop();
    } catch {
      settle();
    }
    // A recorder that never says it stopped must not keep the recording from the note.
    setTimeout(settle, 3000);
  });
}

/** Stop recording and put it in its note (see the top of this file for where that is). */
export async function stopRecording(): Promise<void> {
  // Its note is the open one: one put away has already ended the recording (`onDocumentChange`).
  await finishInto(null);
}

async function finishInto(released: Released | null): Promise<void> {
  const s = session;
  if (!s) return;
  session = null;
  useRecorderStore.setState({ status: 'stopping' });
  let recording: Recording | null = null;
  try {
    recording = await finish(s);
  } finally {
    useRecorderStore.setState({ status: 'idle', startedAt: 0, documentId: null });
  }
  if (!recording) {
    notice('Nothing was recorded.');
    return;
  }
  await keep(recording, s.documentId, released);
}

/** Put a finished recording in its note: the open one, its tab, or (for a note that was closed) its file. */
async function keep(recording: Recording, documentId: string, released: Released | null): Promise<void> {
  const store = useDocumentStore.getState();
  if (store.document.id === documentId) {
    store.addRecording(recording);
    if (store.filePath && isTauri()) {
      const { actionSave } = await import('../desktop/fileActions');
      if (await actionSave()) notice(`Recording of ${formatDuration(recording.duration)} saved with the note.`);
    } else {
      notice(`Recording of ${formatDuration(recording.duration)} added. Save the note to keep it.`);
    }
    return;
  }
  const { addRecordingToTab } = await import('../document/tabStore');
  if (released && (await addRecordingToTab(documentId, recording, released.document))) {
    notice('The recording was put with its note, in its tab.');
    return;
  }
  if (released?.filePath && isTauri()) {
    await saveIntoFile(recording, released, released.filePath);
    return;
  }
  notice('The recording could not be kept: its note was closed without being saved anywhere.');
}

/**
 * Put a recording into the file of a note that was closed while it ran. A note left with changes that were not saved
 * may have been left so on purpose, so the recording goes into the file as it is on disk; only when that cannot be
 * read does the note go back to it as it was left.
 */
async function saveIntoFile(recording: Recording, released: Released, path: string): Promise<void> {
  const { openDocumentFromPath, saveDocumentToPath } = await import('../desktop/fileService');
  let base = released.document;
  if (released.dirty) {
    try {
      const onDisk = (await openDocumentFromPath(path)).document;
      if (onDisk.id === released.document.id) base = onDisk;
    } catch {
      // Unreadable: the note as it was left is better than losing the recording.
    }
  }
  try {
    await saveDocumentToPath({ ...base, recordings: [...(base.recordings ?? []), recording] }, path);
    notice(`The recording was saved with “${released.document.title || 'Untitled note'}”.`);
  } catch (error) {
    notice(`The recording could not be saved: ${errorMessage(error)}`);
  }
}

/** On the desktop, closing the window while recording saves the recording first (unless it only goes to the tray). */
async function guardWindowClose(): Promise<() => void> {
  if (!isTauri()) return () => {};
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    return await win.onCloseRequested(async (event) => {
      // Kept running in the tray: the shell hides the window, and the recording goes on. (Not prevented here, the
      // close would be finished by destroying the window, the tray or not.)
      if (closesToTray()) {
        event.preventDefault();
        return;
      }
      if (!session) return;
      event.preventDefault();
      // Otherwise it is finished and put in its note first; a note with no file yet keeps it in the draft, which
      // the next start opens.
      await prepareToQuit();
      await win.destroy();
    });
  } catch {
    return () => {};
  }
}

/** `1:05` for 65 seconds, `1:02:03` past the hour. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}
