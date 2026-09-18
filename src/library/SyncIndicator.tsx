import { AlertTriangle, Check, CloudOff, RefreshCw, TriangleAlert } from 'lucide-react';
import type { SyncStatus } from './types';

const LABELS: Readonly<Record<SyncStatus['phase'], string>> = {
  offline: 'Offline',
  syncing: 'Syncing…',
  upToDate: 'Up to date',
  conflicted: 'Needs attention',
  error: 'Sync failed',
};

function relative(ms: number): string {
  if (!ms) return '';
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

export interface SyncIndicatorProps {
  status: SyncStatus;
  onSyncNow: () => void;
  onShowConflicts: () => void;
}

/**
 * The state of sync, in one pill.
 *
 * `Offline` is a first-class state rather than an error: with no account
 * connected — which is every install until one is — there is nothing wrong,
 * and a red warning about it would be noise. A conflict, on the other hand,
 * is the one state that needs the user, so it is the only one that is a
 * button into something.
 */
export function SyncIndicator({ status, onSyncNow, onShowConflicts }: SyncIndicatorProps) {
  const conflicted = status.phase === 'conflicted';
  const failed = status.phase === 'error';
  const tone = conflicted
    ? 'text-amber-700 dark:text-amber-300'
    : failed
      ? 'text-rose-600 dark:text-rose-300'
      : 'text-zinc-500 dark:text-zinc-400';

  const icon = {
    offline: <CloudOff size={14} aria-hidden="true" />,
    syncing: <RefreshCw size={14} className="animate-spin" aria-hidden="true" />,
    upToDate: <Check size={14} aria-hidden="true" />,
    conflicted: <TriangleAlert size={14} aria-hidden="true" />,
    error: <AlertTriangle size={14} aria-hidden="true" />,
  }[status.phase];

  const detail = conflicted
    ? `${status.conflicts.length} file${status.conflicts.length === 1 ? '' : 's'} need you`
    : failed
      ? (status.message ?? '')
      : status.phase === 'upToDate' && status.lastSyncedMs
        ? relative(status.lastSyncedMs)
        : status.phase === 'offline'
          ? status.provider
          : '';

  return (
    <button
      type="button"
      onClick={conflicted ? onShowConflicts : onSyncNow}
      title={
        conflicted
          ? 'Resolve the conflicts'
          : status.phase === 'offline'
            ? `${status.provider} — sync when an account is connected`
            : 'Sync now'
      }
      aria-label={`Sync status: ${LABELS[status.phase]}${detail ? `, ${detail}` : ''}`}
      data-sync-status={status.phase}
      className={`inline-flex max-w-[14rem] items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-zinc-800 ${tone}`}
    >
      {icon}
      <span className="truncate">{LABELS[status.phase]}</span>
      {detail && <span className="hidden truncate text-zinc-400 sm:inline dark:text-zinc-500">· {detail}</span>}
    </button>
  );
}
