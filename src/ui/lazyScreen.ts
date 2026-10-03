// Screens used weekly or quarterly (review, reel, close, setup, onboarding...) load on demand, so a cold start
// only parses Home, a burner and the log sheet. Offline is unaffected: the service worker precaches every
// chunk. Once the app is idle after launch, all of them are fetched anyway, so opening one is instant.
//
// After an app update, an old page can ask for a chunk that no longer exists (its hash changed). Then it
// reloads into the new version once (reloadApp keeps the lock's trust), instead of showing the error screen.
import { lazy, type ComponentType } from 'react';
import { reloadApp } from './useAppUpdate';

const RELOAD_KEY = 'fb-chunk-reload';
const loaders: (() => Promise<unknown>)[] = [];

function reloadOnce(e: unknown): never {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (navigator.onLine && Date.now() - last > 30_000) {
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
      reloadApp();
    }
  } catch {
    // storage unavailable: let the error boundary handle it
  }
  throw e;
}

/** A route screen loaded on demand. `pick` selects the named export. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyScreen<M, P extends object>(load: () => Promise<M>, pick: (m: M) => ComponentType<P>) {
  // The background preload never reloads: it may run while you type, and only a screen you open needs it.
  loaders.push(load);
  return lazy(() => load().then((m) => ({ default: pick(m) }), reloadOnce));
}

let preloaded = false;

/** Fetch every on-demand screen in the background once the app is idle. Safe to call more than once. */
export function preloadScreens(): void {
  if (preloaded) return;
  preloaded = true;
  const go = () => loaders.forEach((l) => void l().catch(() => undefined));
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  if (idle) idle(go, { timeout: 4000 });
  else setTimeout(go, 2500);
}
