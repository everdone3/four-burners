// Moments when reloading the page would lose work or cut you off, and that the page itself cannot show:
// the iOS share sheet or the file picker is open, or a restore is running. Code that starts one holds it
// here until it ends; the update flow (useAppUpdate) does not reload while anything is held, and tries
// again once the last hold is released.

const holds = new Set<{ reason: string }>();
const idleListeners = new Set<() => void>();

/** Holds off reloads until the returned function runs. Calling it again does nothing. */
export function holdBusy(reason: string): () => void {
  const hold = { reason };
  holds.add(hold);
  return () => {
    if (!holds.delete(hold) || holds.size > 0) return;
    idleListeners.forEach((l) => l());
  };
}

/** Holds off reloads until work settles (either way), and passes it through. */
export function holdBusyUntil<T>(reason: string, work: Promise<T>): Promise<T> {
  const release = holdBusy(reason);
  work.then(release, release);
  return work;
}

export function isBusy(): boolean {
  return holds.size > 0;
}

/** What is held right now (for debugging). */
export function busyReasons(): string[] {
  return [...holds].map((h) => h.reason);
}

/** Runs l each time the last hold is released. Returns an unsubscribe function. */
export function onIdle(l: () => void): () => void {
  idleListeners.add(l);
  return () => void idleListeners.delete(l);
}
