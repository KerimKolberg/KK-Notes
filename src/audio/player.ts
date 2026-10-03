/**
 * Playing a note's recordings back.
 *
 * One recording at a time, through a plain audio element on a blob of the recording's bytes. The position is kept in
 * the store a few times a second while it plays, which is what the replay reads: ink written later than the position
 * is shown faded (`replay.ts`), and with "tap ink" on, tapping a stroke plays from when it was written. The length
 * shown is the recording's own: a recording made by a browser engine does not say how long it is.
 */
import { create } from 'zustand';
import { useDesktopStore } from '../desktop/desktopStore';
import { useDocumentStore } from '../document/store';
import type { Recording } from '../document/types';
import { errorMessage } from '../lib/errors';

export interface PlayerState {
  readonly open: boolean;
  readonly recordingId: string | null;
  readonly playing: boolean;
  /** Seconds into the recording. */
  readonly time: number;
  readonly rate: number;
  /** While on, tapping ink plays from when it was written, and taps do not draw. */
  readonly tapToSeek: boolean;
  /** When each stroke of the chosen recording was begun, in seconds; `null` with none chosen. */
  readonly markTimes: ReadonlyMap<string, number> | null;
  /** A word from the player, shown in it for a moment (a notice would cover it on a narrow screen). */
  readonly message: string | null;
}

export const PLAYBACK_RATES = [1, 1.25, 1.5, 2] as const;

export const usePlayerStore = create<PlayerState>()(() => ({
  open: false,
  recordingId: null,
  playing: false,
  time: 0,
  rate: 1,
  tapToSeek: false,
  markTimes: null,
  message: null,
}));

/** How often the position is put in the store while playing. */
const TICK_MS = 100;
/** How long a word from the player stays. */
const MESSAGE_MS = 2500;

let audio: HTMLAudioElement | null = null;
let url: string | null = null;
let frame = 0;
let lastTick = 0;
let messageTimer: ReturnType<typeof setTimeout> | undefined;

/** Say something in the player for a moment. */
export function say(message: string): void {
  clearTimeout(messageTimer);
  usePlayerStore.setState({ message });
  messageTimer = setTimeout(() => usePlayerStore.setState({ message: null }), MESSAGE_MS);
}

/** The open note's recording with this id. */
export function recordingById(id: string | null): Recording | null {
  if (!id) return null;
  return useDocumentStore.getState().document.recordings?.find((r) => r.id === id) ?? null;
}

function release(): void {
  cancelAnimationFrame(frame);
  frame = 0;
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  audio = null;
  if (url) URL.revokeObjectURL(url);
  url = null;
}

function tick(now: number): void {
  frame = 0;
  if (!audio) return;
  if (now - lastTick >= TICK_MS) {
    lastTick = now;
    usePlayerStore.setState({ time: audio.currentTime });
  }
  if (!audio.paused) frame = requestAnimationFrame(tick);
}

function load(recording: Recording): void {
  release();
  const { rate } = usePlayerStore.getState();
  url = URL.createObjectURL(new Blob([recording.data], { type: recording.mime }));
  const el = new Audio(url);
  el.preload = 'auto';
  el.playbackRate = rate;
  el.addEventListener('ended', () => {
    cancelAnimationFrame(frame);
    usePlayerStore.setState({ playing: false, time: recording.duration });
  });
  el.addEventListener('pause', () => usePlayerStore.setState({ playing: false, time: el.currentTime }));
  el.addEventListener('play', () => {
    usePlayerStore.setState({ playing: true });
    if (!frame) frame = requestAnimationFrame(tick);
  });
  audio = el;
  usePlayerStore.setState({
    recordingId: recording.id,
    playing: false,
    time: 0,
    markTimes: new Map(recording.marks.map((m) => [m.strokeId, m.t])),
  });
}

/** Open the player on a recording: the one given, or the note's latest. */
export function openPlayer(id?: string): void {
  const recordings = useDocumentStore.getState().document.recordings ?? [];
  const recording = (id ? recordings.find((r) => r.id === id) : undefined) ?? recordings[recordings.length - 1];
  if (!recording) return;
  if (usePlayerStore.getState().recordingId !== recording.id || !audio) load(recording);
  usePlayerStore.setState({ open: true });
  // A notice is about what came before (the recording being added), and on a narrow screen it would sit on the player.
  const { notice, setNotice } = useDesktopStore.getState();
  if (notice && !notice.action) setNotice(null);
}

export function closePlayer(): void {
  release();
  clearTimeout(messageTimer);
  usePlayerStore.setState({ open: false, recordingId: null, playing: false, time: 0, tapToSeek: false, markTimes: null, message: null });
}

export function togglePlayer(): void {
  if (usePlayerStore.getState().open) closePlayer();
  else openPlayer();
}

export async function play(): Promise<void> {
  const recording = recordingById(usePlayerStore.getState().recordingId);
  if (!audio || !recording) return;
  // From the start again once it has played to the end.
  if (usePlayerStore.getState().time >= recording.duration - 0.05) seek(0);
  try {
    await audio.play();
  } catch (error) {
    say(`Could not play: ${errorMessage(error)}`);
  }
}

export function pause(): void {
  audio?.pause();
}

export function togglePlaying(): void {
  if (usePlayerStore.getState().playing) pause();
  else void play();
}

/** Go to `t` seconds into the recording. */
export function seek(t: number): void {
  const recording = recordingById(usePlayerStore.getState().recordingId);
  if (!recording) return;
  const to = Math.min(Math.max(0, t), recording.duration);
  if (audio) audio.currentTime = to;
  usePlayerStore.setState({ time: to });
}

export function skip(by: number): void {
  seek(usePlayerStore.getState().time + by);
}

export function setRate(rate: number): void {
  if (audio) audio.playbackRate = rate;
  usePlayerStore.setState({ rate });
}

export function setTapToSeek(on: boolean): void {
  usePlayerStore.setState({ tapToSeek: on });
}

/** Play from a little before `t`, so the start of what was being said then is heard. */
export function playFrom(t: number): void {
  seek(t - 1.5);
  void play();
}

// Another note, or the recording taken out of this one: the player has nothing to play.
useDocumentStore.subscribe((state, previous) => {
  const { open, recordingId } = usePlayerStore.getState();
  if (!open && !recordingId) return;
  if (state.document.id !== previous.document.id || !recordingById(recordingId)) closePlayer();
});
