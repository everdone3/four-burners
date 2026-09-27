// React binding for the sync status store, plus the one-line status text the UI shows.
import { useSyncExternalStore } from 'react';
import { getSyncStatus, subscribeSyncStatus } from './manager';
import type { SyncStatus } from './types';

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(subscribeSyncStatus, getSyncStatus, getSyncStatus);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "just now", "5 min ago", "3 hr ago", "2 days ago". */
export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s) || s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `${plural(Math.floor(h / 24), 'day')} ago`;
}

/** The live status line for a signed-in device. */
export function describeSyncStatus(s: SyncStatus, now = Date.now()): string {
  switch (s.state) {
    case 'syncing':
      return 'Syncing...';
    case 'offline':
      return s.pending > 0 ? `Offline, ${plural(s.pending, 'change')} waiting` : 'Offline. Changes sync when you reconnect.';
    case 'error':
      return s.error ?? 'Sync hit a problem. It will try again soon.';
    case 'idle':
      return s.lastSyncedAt ? `Synced ${timeAgo(s.lastSyncedAt, now)}` : 'Not synced yet';
    case 'signedOut':
      return 'Signed out';
    default:
      return "Sync isn't set up";
  }
}

/** Secondary line: changes still waiting while online. */
export function pendingNote(s: SyncStatus): string | null {
  if (s.pending <= 0 || s.state === 'offline') return null;
  return `${plural(s.pending, 'change')} waiting to sync`;
}
