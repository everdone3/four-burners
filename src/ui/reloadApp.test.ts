// reloadApp (useAppUpdate.ts): every app-initiated reload tells the lock it is trusted, but only while the
// app is open, and the lock can never block the reload. (The lock is an access gate, not encryption: see
// src/lock/webauthnLocal.ts.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LockPhase } from '@/lock/types';

let phase: LockPhase = 'unlocked';
let lockBroken = false;
const markTrustedReload = vi.fn();

vi.mock('@/lock/controller', () => ({
  getLockState: () => {
    if (lockBroken) throw new Error('lock failed');
    return { phase };
  },
  markTrustedReload: () => markTrustedReload(),
}));

const { reloadApp } = await import('./useAppUpdate');

describe('reloadApp', () => {
  let reload: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    phase = 'unlocked';
    lockBroken = false;
    markTrustedReload.mockReset();
    reload = vi.fn();
    vi.stubGlobal('location', { hash: '#/', reload });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('marks the reload trusted right before reloading while unlocked', () => {
    phase = 'unlocked';
    reloadApp();
    expect(markTrustedReload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(markTrustedReload.mock.invocationCallOrder[0]).toBeLessThan(reload.mock.invocationCallOrder[0]);
  });

  it('does not mark a reload from the lock screen (it comes back locked), or with the lock off', () => {
    for (const p of ['locked', 'unlocking', 'off'] as const) {
      phase = p;
      reload.mockClear();
      reloadApp();
      expect(markTrustedReload).not.toHaveBeenCalled();
      expect(reload).toHaveBeenCalledTimes(1);
    }
  });

  it('still reloads when the lock fails', () => {
    lockBroken = true;
    reloadApp();
    expect(reload).toHaveBeenCalledTimes(1);
    lockBroken = false;
    markTrustedReload.mockImplementationOnce(() => {
      throw new Error('storage full');
    });
    reloadApp();
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
