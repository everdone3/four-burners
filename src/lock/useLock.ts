// React binding for the app lock state (controller.ts).
// The Face ID lock is an access gate, not encryption: see the header of webauthnLocal.ts.
import { useSyncExternalStore } from 'react';
import { getLockState, subscribeLock } from './controller';
import type { LockState } from './types';

/** The live lock state. The object is replaced on every change, so it is safe to use as a dependency. */
export function useLockState(): LockState {
  return useSyncExternalStore(subscribeLock, getLockState, getLockState);
}
