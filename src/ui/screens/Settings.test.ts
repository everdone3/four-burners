// "Erase all data on this device": one last push of unsynced changes first, and a confirmation that says
// plainly when changes that exist only on this device will be lost.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncStatus } from '@/sync/types';
import { ERASE_SYNC_WAIT_MS, eraseConfirmText, pushBeforeErase, unsyncedCount } from './Settings';

/** A stand-in for the sync manager's status store and syncNow. */
function fakeSync(initial: SyncStatus, onSync: (set: (patch: Partial<SyncStatus>) => void) => Promise<void>) {
  let status = initial;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<SyncStatus>) => {
    status = { ...status, ...patch };
    for (const l of [...listeners]) l();
  };
  const syncNow = vi.fn(() => onSync(set));
  return {
    api: {
      getSyncStatus: () => status,
      subscribeSyncStatus: (l: () => void) => {
        listeners.add(l);
        return () => void listeners.delete(l);
      },
      syncNow,
    },
    syncNow,
    listeners,
  };
}

describe('pushBeforeErase', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not sync or wait when nothing is pending', async () => {
    const f = fakeSync({ state: 'idle', email: 'me@example.com', pending: 0 }, async () => undefined);
    await expect(pushBeforeErase(f.api)).resolves.toBe(0);
    expect(f.syncNow).not.toHaveBeenCalled();
  });

  it('does not sync when signed out', async () => {
    const f = fakeSync({ state: 'signedOut', pending: 0 }, async () => undefined);
    await expect(pushBeforeErase(f.api)).resolves.toBe(0);
    expect(f.syncNow).not.toHaveBeenCalled();
  });

  it('pushes pending changes first and reports none left once they land', async () => {
    const f = fakeSync({ state: 'idle', email: 'me@example.com', pending: 3 }, async (set) => {
      set({ state: 'syncing' });
      await new Promise((r) => setTimeout(r, 300));
      set({ pending: 0 });
      set({ state: 'idle' });
    });
    const p = pushBeforeErase(f.api);
    await vi.advanceTimersByTimeAsync(300);
    await expect(p).resolves.toBe(0);
    expect(f.syncNow).toHaveBeenCalledTimes(1);
    expect(f.listeners.size).toBe(0);
  });

  it('reports what is still pending when offline, without waiting out the full timeout', async () => {
    const f = fakeSync({ state: 'offline', email: 'me@example.com', pending: 2 }, async () => undefined);
    let result: number | undefined;
    void pushBeforeErase(f.api).then((n) => (result = n));
    await vi.advanceTimersByTimeAsync(1000);
    expect(result).toBe(2);
    expect(f.syncNow).toHaveBeenCalledTimes(1);
  });

  it('gives up after a short wait when the server hangs', async () => {
    const f = fakeSync({ state: 'idle', email: 'me@example.com', pending: 1 }, (set) => {
      set({ state: 'syncing' });
      return new Promise<void>(() => undefined);
    });
    let result: number | undefined;
    void pushBeforeErase(f.api).then((n) => (result = n));
    await vi.advanceTimersByTimeAsync(ERASE_SYNC_WAIT_MS - 1);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe(1);
    expect(f.listeners.size).toBe(0);
  });

  it('treats a failed push like any other: the changes are still pending', async () => {
    const f = fakeSync({ state: 'idle', email: 'me@example.com', pending: 4 }, async () => {
      throw new Error('paused');
    });
    let result: number | undefined;
    void pushBeforeErase(f.api).then((n) => (result = n));
    await vi.advanceTimersByTimeAsync(1000);
    expect(result).toBe(4);
  });

  it('still counts the changes when the push ends in a sign-out (a dead session), though the status then says 0', async () => {
    // The manager signs out when the refresh token is rejected, and a signed-out status always has pending 0.
    const f = fakeSync({ state: 'error', email: 'me@example.com', pending: 3 }, async (set) => {
      set({ state: 'syncing' });
      await new Promise((r) => setTimeout(r, 200));
      set({ state: 'signedOut', email: undefined, pending: 0 });
    });
    let result: number | undefined;
    void pushBeforeErase(f.api).then((n) => (result = n));
    await vi.advanceTimersByTimeAsync(1000);
    expect(result).toBe(3);
    expect(eraseConfirmText(result!)).toMatch(/^3 changes on this device have not synced yet and will be lost\./);
    expect(f.listeners.size).toBe(0);
  });

  it('reports 0 when the push lands and a sign-out follows', async () => {
    const f = fakeSync({ state: 'idle', email: 'me@example.com', pending: 2 }, async (set) => {
      set({ state: 'syncing' });
      await new Promise((r) => setTimeout(r, 200));
      set({ pending: 0 });
      set({ state: 'signedOut', email: undefined, pending: 0 });
    });
    let result: number | undefined;
    void pushBeforeErase(f.api).then((n) => (result = n));
    await vi.advanceTimersByTimeAsync(1000);
    expect(result).toBe(0);
  });
});

describe('eraseConfirmText', () => {
  it('keeps the usual wording when everything is synced', () => {
    expect(eraseConfirmText(0)).toBe(
      'Erase everything on this device? This cannot be undone. This device also signs out of sync, and your account keeps its copy.',
    );
  });

  it('says plainly how many unsynced changes will be lost, and never that the account has a copy', () => {
    const one = eraseConfirmText(1);
    expect(one).toMatch(/^1 change on this device has not synced yet and will be lost\./);
    expect(one).not.toMatch(/keeps its copy/);
    const many = eraseConfirmText(5);
    expect(many).toMatch(/^5 changes on this device have not synced yet and will be lost\./);
    expect(many).toMatch(/cannot be undone/);
    expect(many).not.toMatch(/—/);
  });
});

describe('unsyncedCount', () => {
  it('counts pending changes only while signed in', () => {
    expect(unsyncedCount({ state: 'offline', pending: 3 })).toBe(3);
    expect(unsyncedCount({ state: 'error', pending: 2 })).toBe(2);
    expect(unsyncedCount({ state: 'signedOut', pending: 3 })).toBe(0);
    expect(unsyncedCount({ state: 'unconfigured', pending: 1 })).toBe(0);
  });
});
