import { useEffect, useState } from 'react';
import { Hand, Pause, Play, RotateCcw, RotateCw, Square, Trash2, X } from 'lucide-react';
import { useDocumentStore } from '../document/store';
import { IconButton } from '../ui/IconButton';
import { closePlayer, openPlayer, PLAYBACK_RATES, recordingById, seek, setRate, setTapToSeek, skip, togglePlaying, usePlayerStore } from './player';
import { formatDuration, stopRecording, useRecorderStore } from './recorder';

const CARD =
  'absolute left-3 top-3 z-40 rounded-2xl border border-zinc-200 bg-white/95 shadow-xl dark:border-zinc-700 dark:bg-zinc-900/95';

/** While recording, how long it has run and a Stop button; while playing back, the player. */
export function RecordingBar() {
  const status = useRecorderStore((s) => s.status);
  const playerOpen = usePlayerStore((s) => s.open);
  if (status !== 'idle') return <RecordingPill />;
  if (playerOpen) return <Player />;
  return null;
}

function RecordingPill() {
  const status = useRecorderStore((s) => s.status);
  const startedAt = useRecorderStore((s) => s.startedAt);
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(performance.now()), 500);
    return () => clearInterval(timer);
  }, []);
  const recording = status === 'recording';
  return (
    <div className={`${CARD} flex items-center gap-2 py-1 pl-3 pr-1`} role="status" data-recording-bar>
      <span className={`h-2.5 w-2.5 rounded-full bg-rose-600 ${recording ? 'animate-pulse' : 'opacity-40'}`} aria-hidden="true" />
      <span className="text-sm font-medium tabular-nums text-zinc-800 dark:text-zinc-100" data-recording-elapsed>
        {status === 'starting' ? 'Starting…' : status === 'stopping' ? 'Saving…' : `Recording ${formatDuration((now - startedAt) / 1000)}`}
      </span>
      <IconButton icon={Square} label="Stop recording" size="sm" tone="danger" disabled={!recording} onClick={() => void stopRecording()} tooltipSide="bottom" data-recording-stop />
    </div>
  );
}

function Player() {
  const recordingId = usePlayerStore((s) => s.recordingId);
  const playing = usePlayerStore((s) => s.playing);
  const time = usePlayerStore((s) => s.time);
  const rate = usePlayerStore((s) => s.rate);
  const tapToSeek = usePlayerStore((s) => s.tapToSeek);
  const message = usePlayerStore((s) => s.message);
  const recordings = useDocumentStore((s) => s.document.recordings);
  const readOnly = useDocumentStore((s) => s.readOnly);
  const recording = recordingById(recordingId);
  if (!recording || !recordings) return null;

  const remove = (): void => {
    if (!window.confirm(`Delete this recording (${formatDuration(recording.duration)})? The writing stays.`)) return;
    useDocumentStore.getState().removeRecording(recording.id);
  };

  // On a phone two rows: the buttons, then the position and the speed; from a tablet up, one.
  const second = 'order-last sm:order-none';
  return (
    <div className={`${CARD} flex w-[min(34rem,calc(100%-1.5rem))] flex-wrap items-center gap-x-1 gap-y-0.5 p-1`} data-player>
      <IconButton icon={playing ? Pause : Play} label={playing ? 'Pause' : 'Play'} size="sm" active={playing} onClick={togglePlaying} tooltipSide="bottom" data-player-play />
      <IconButton icon={RotateCcw} label="Back 15 seconds" size="sm" onClick={() => skip(-15)} tooltipSide="bottom" />
      <IconButton icon={RotateCw} label="Forward 15 seconds" size="sm" onClick={() => skip(15)} tooltipSide="bottom" />
      {/* A word from the player takes the time's place for a moment, so the buttons stay where they are. */}
      {message ? (
        <span className="max-w-[9rem] px-1 text-xs leading-tight text-amber-700 sm:max-w-none dark:text-amber-300" role="status" data-player-message>
          {message}
        </span>
      ) : (
        <span className="px-1 text-xs tabular-nums text-zinc-600 dark:text-zinc-300" data-player-time>
          {formatDuration(time)} / {formatDuration(recording.duration)}
        </span>
      )}
      <span className={`h-0 basis-full sm:hidden ${second}`} aria-hidden="true" />
      <input
        type="range"
        className={`h-8 min-w-0 flex-[1_1_8rem] accent-blue-600 ${second}`}
        min={0}
        max={recording.duration}
        step={0.1}
        value={Math.min(time, recording.duration)}
        onChange={(e) => seek(Number(e.target.value))}
        aria-label="Position in the recording"
        data-player-seek
      />
      <select
        className={`h-8 rounded-lg border border-zinc-200 bg-transparent px-1 text-xs dark:border-zinc-700 ${second}`}
        value={rate}
        onChange={(e) => setRate(Number(e.target.value))}
        aria-label="Playback speed"
        data-player-rate
      >
        {PLAYBACK_RATES.map((r) => (
          <option key={r} value={r}>
            {r}×
          </option>
        ))}
      </select>
      {recordings.length > 1 && (
        <select
          className={`h-8 max-w-[9rem] rounded-lg border border-zinc-200 bg-transparent px-1 text-xs dark:border-zinc-700 ${second}`}
          value={recording.id}
          onChange={(e) => openPlayer(e.target.value)}
          aria-label="Recording"
          data-player-pick
        >
          {recordings.map((r) => (
            <option key={r.id} value={r.id}>
              {recordingLabel(r.startedAt)} · {formatDuration(r.duration)}
            </option>
          ))}
        </select>
      )}
      <span className="ml-auto sm:ml-0">
        <IconButton
          icon={Hand}
          label="Tap ink to play"
          hint={tapToSeek ? 'on: tap writing to hear it' : 'off'}
          size="sm"
          active={tapToSeek}
          onClick={() => setTapToSeek(!tapToSeek)}
          tooltipSide="bottom"
          data-player-tap
        />
      </span>
      <IconButton icon={Trash2} label="Delete recording" size="sm" tone="danger" disabled={readOnly} onClick={remove} tooltipSide="bottom" data-player-delete />
      <IconButton icon={X} label="Close player" size="sm" onClick={closePlayer} tooltipSide="bottom" data-player-close />
    </div>
  );
}

/** When a recording was made, short: `3 Oct, 14:05`. */
function recordingLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Recording';
  return date.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
