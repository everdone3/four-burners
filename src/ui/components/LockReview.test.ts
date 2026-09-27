// Review fixes for the lock UI (Phase 6): the Unlock tap guard, the recovery draft, the reset sequence,
// the gate's decisions, and the error screen failing closed. (The lock is an access gate, not encryption:
// see src/lock/webauthnLocal.ts.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LockPhase, LockState } from '@/lock/types';

const calls: string[] = [];
let phase: LockPhase = 'locked';
let wipeFails = false;

vi.mock('@/lock/controller', () => ({
  unlock: vi.fn(async () => 'ok'),
  completeRecovery: vi.fn(),
  resetLock: vi.fn(() => void calls.push('resetLock')),
  getLockState: () => ({ phase }) as LockState,
  subscribeLock: () => () => undefined,
}));
vi.mock('@/lock/useLock', () => ({ useLockState: () => ({ phase }) as LockState }));
vi.mock('@/sync/manager', () => ({
  getSyncStatus: () => ({ state: 'signedOut', pending: 0 }),
  subscribeSyncStatus: () => () => undefined,
  syncNow: async () => undefined,
  sendCode: async () => undefined,
  verifyCode: async () => ({ id: 'u1' }),
  eraseDeviceSync: vi.fn(async () => void calls.push('eraseDeviceSync')),
}));
vi.mock('@/data/repo', () => ({
  wipeAll: vi.fn(async () => {
    calls.push('wipeAll');
    if (wipeFails) throw new Error('quota');
  }),
}));
vi.mock('@/data/backup', () => ({ buildBackupFile: async () => undefined, saveBackupFile: async () => 'shared' }));

const { PROMPT_TAP_GUARD_MS, clearRecoveryDraft, eraseAndReset, readRecoveryDraft, tapStartsPrompt } = await import('./LockScreen');
const { gateDecision } = await import('./LockGate');
const { lockEngaged } = await import('./ErrorBoundary');

/** A Storage good enough for these tests. */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

let replace: ReturnType<typeof vi.fn>;
beforeEach(() => {
  calls.length = 0;
  phase = 'locked';
  wipeFails = false;
  replace = vi.fn(() => void calls.push('replace'));
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('location', { hash: '#/', hostname: 'localhost', replace });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tapStartsPrompt', () => {
  const t0 = 1_000_000;
  it('starts a prompt whenever none is up', () => {
    expect(tapStartsPrompt(false, 0, t0)).toBe(true);
    expect(tapStartsPrompt(false, t0, t0)).toBe(true);
  });

  it('ignores a second tap while a prompt is still opening (double click, held Enter, tap after the automatic attempt)', () => {
    expect(tapStartsPrompt(true, t0, t0 + 150)).toBe(false);
    expect(tapStartsPrompt(true, t0, t0 + PROMPT_TAP_GUARD_MS - 1)).toBe(false);
    // Started, but the screen has not noted when yet: too soon.
    expect(tapStartsPrompt(true, 0, t0)).toBe(false);
  });

  it('lets a tap restart a prompt that never showed up after a few seconds', () => {
    expect(tapStartsPrompt(true, t0, t0 + PROMPT_TAP_GUARD_MS)).toBe(true);
    expect(tapStartsPrompt(true, t0, t0 + 60_000)).toBe(true);
  });

  it('does not get stuck when the clock moves back', () => {
    expect(tapStartsPrompt(true, t0, t0 - 5_000)).toBe(true);
  });
});

describe('recovery draft', () => {
  it('reads a fresh draft and drops expired, damaged or foreign ones without throwing', () => {
    const now = Date.now();
    localStorage.setItem('fb-lock-recovery', JSON.stringify({ email: 'me@example.com', sentAt: now - 60_000 }));
    expect(readRecoveryDraft()).toEqual({ email: 'me@example.com', sentAt: now - 60_000 });
    localStorage.setItem('fb-lock-recovery', JSON.stringify({ email: 'me@example.com', sentAt: now - 2 * 60 * 60_000 }));
    expect(readRecoveryDraft()).toBeNull();
    for (const junk of ['{not json', '5', '"text"', '[]', 'null', '{"email":42,"sentAt":1}', '{"email":"a@b.co"}']) {
      localStorage.setItem('fb-lock-recovery', junk);
      expect(readRecoveryDraft()).toBeNull();
    }
  });

  it('survives storage that throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    });
    expect(readRecoveryDraft()).toBeNull();
    expect(() => clearRecoveryDraft()).not.toThrow();
  });

  it('clearRecoveryDraft removes it', () => {
    localStorage.setItem('fb-lock-recovery', JSON.stringify({ email: 'me@example.com', sentAt: Date.now() }));
    clearRecoveryDraft();
    expect(localStorage.getItem('fb-lock-recovery')).toBeNull();
  });
});

describe('eraseAndReset', () => {
  it('forgets sync, wipes, holds the gate, removes the lock, then reloads, in that order', async () => {
    localStorage.setItem('fb-lock-recovery', JSON.stringify({ email: 'me@example.com', sentAt: Date.now() }));
    const ok = await eraseAndReset(() => void calls.push('leaving'));
    expect(ok).toBe(true);
    expect(calls).toEqual(['eraseDeviceSync', 'wipeAll', 'leaving', 'resetLock', 'replace']);
    expect(replace).toHaveBeenCalledWith('/');
    expect(localStorage.getItem('fb-lock-recovery')).toBeNull();
  });

  it('keeps the lock and stays put when the wipe fails (the data is still here)', async () => {
    wipeFails = true;
    const ok = await eraseAndReset(() => void calls.push('leaving'));
    expect(ok).toBe(false);
    expect(calls).toEqual(['eraseDeviceSync', 'wipeAll']);
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('gateDecision', () => {
  it('a locked cold start neither opens nor mounts the app', () => {
    expect(gateDecision('locked', true, false)).toEqual({ open: false, mount: false });
    expect(gateDecision('unlocking', true, false)).toEqual({ open: false, mount: false });
  });

  it('a re-lock keeps the app mounted but not open', () => {
    expect(gateDecision('locked', false, false)).toEqual({ open: false, mount: true });
  });

  it('opens and mounts when unlocked or off', () => {
    expect(gateDecision('unlocked', false, false)).toEqual({ open: true, mount: true });
    expect(gateDecision('off', false, false)).toEqual({ open: true, mount: true });
  });

  it('after "Reset this device" nothing opens or mounts before the reload, even though the lock is now off', () => {
    expect(gateDecision('off', false, true)).toEqual({ open: false, mount: false });
    expect(gateDecision('locked', true, true)).toEqual({ open: false, mount: false });
  });
});

describe('lockEngaged (error screen)', () => {
  function withLockAttr(value: string | null) {
    vi.stubGlobal('document', { documentElement: { getAttribute: (n: string) => (n === 'data-lock' ? value : null) } });
  }

  it('follows the controller', () => {
    withLockAttr(null);
    phase = 'locked';
    expect(lockEngaged()).toBe(true);
    phase = 'unlocking';
    expect(lockEngaged()).toBe(true);
    phase = 'unlocked';
    expect(lockEngaged()).toBe(false);
    phase = 'off';
    expect(lockEngaged()).toBe(false);
  });

  it('fails closed on <html data-lock> even when the controller says off (it never started)', () => {
    withLockAttr('locked');
    phase = 'off';
    expect(lockEngaged()).toBe(true);
  });
});
