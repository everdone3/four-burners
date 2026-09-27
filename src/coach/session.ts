// Remembers that a packet was just copied, so when you come back from the Claude app
// the right screen opens its "Paste coach reply" field automatically.
// Stored in localStorage because iOS may reload the installed app while you are away.
import type { PacketKind } from '@/domain';

const KEY = 'fb-coach-pending';
/** Coming back later than this no longer auto-opens the paste field. */
export const MAX_AGE_MS = 2 * 60 * 60_000;

export interface PendingCoach {
  kind: PacketKind;
  scope: string;
  chars: number;
  copiedAt: number;
}

export function markCopied(p: Omit<PendingCoach, 'copiedAt'>) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...p, copiedAt: Date.now() }));
  } catch {
    // storage unavailable; the paste field is still one tap away
  }
  notify();
}

export function readPending(): PendingCoach | null {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? 'null') as PendingCoach | null;
    if (!p || Date.now() - p.copiedAt > MAX_AGE_MS) return null;
    return p;
  } catch {
    return null;
  }
}

/** True if a packet of this kind and scope was copied recently and no reply has been saved yet. */
export function isPending(kind: PacketKind, scope: string): boolean {
  const p = readPending();
  return !!p && p.kind === kind && p.scope === scope;
}

export function clearPending() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
  notify();
}

/** Same-tab listeners (the "storage" event only fires in other tabs). */
export const PENDING_EVENT = "fb-coach-pending";
function notify() {
  globalThis.dispatchEvent?.(new Event(PENDING_EVENT));
}
