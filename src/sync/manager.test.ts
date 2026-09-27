import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeEngine {
  opts: { accountId: string };
  syncNow: () => Promise<unknown>;
  pendingCount: () => Promise<number>;
  forget: ReturnType<typeof vi.fn>;
}

interface FakeSub {
  fn: () => Promise<number>;
  next: (n: number) => void;
  closed: boolean;
  unsubscribe(): void;
}

const fake = vi.hoisted(() => {
  const state = {
    configured: true,
    stored: null as null | { id: string; email?: string },
    cb: null as null | ((event: string, session: unknown) => void),
    engines: [] as FakeEngine[],
    subs: [] as FakeSub[],
    pending: 0,
    syncNow: vi.fn(),
    getSession: vi.fn(),
    refreshSession: vi.fn(),
    signOut: vi.fn(),
    verifyOtp: vi.fn(),
    signInWithOtp: vi.fn(),
    getClient: vi.fn(),
    bulkDelete: vi.fn(),
    client: null as unknown,
  };
  state.client = {
    auth: {
      onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
        state.cb = cb;
        return { data: { subscription: { unsubscribe: () => (state.cb = null) } } };
      },
      getSession: (...a: unknown[]) => state.getSession(...a),
      refreshSession: (...a: unknown[]) => state.refreshSession(...a),
      signOut: (...a: unknown[]) => state.signOut(...a),
      verifyOtp: (...a: unknown[]) => state.verifyOtp(...a),
      signInWithOtp: (...a: unknown[]) => state.signInWithOtp(...a),
    },
    rpc: vi.fn(),
  };
  return state;
});

vi.mock('./client', () => ({
  isSyncConfigured: () => fake.configured,
  getClient: () => fake.getClient(),
  readStoredSession: () => fake.stored,
  hasStoredSession: () => !!fake.stored,
  clearStoredSession: () => {
    fake.stored = null;
  },
}));

vi.mock('./engine', () => ({
  createSyncEngine: (opts: { accountId: string }) => {
    const e: FakeEngine = {
      opts,
      syncNow: () => fake.syncNow(opts.accountId),
      pendingCount: async () => fake.pending,
      forget: vi.fn(async () => undefined),
    };
    fake.engines.push(e);
    return e;
  },
  syncStateKeys: (id: string) => [`syncCursor:${id}`, `syncJoined:${id}`, `syncJoinStarted:${id}`, `syncSchema:${id}`, 'syncEpoch'],
}));

vi.mock('@/data/db', () => ({ db: { kv: { bulkDelete: (...a: unknown[]) => fake.bulkDelete(...a) } } }));

vi.mock('dexie', () => ({
  liveQuery: (fn: () => Promise<number>) => ({
    subscribe: (observer: { next: (n: number) => void }) => {
      const sub: FakeSub = {
        fn,
        next: observer.next,
        closed: false,
        unsubscribe() {
          this.closed = true;
        },
      };
      fake.subs.push(sub);
      void fn().then((n) => !sub.closed && observer.next(n));
      return sub;
    },
  }),
}));

import {
  AUTH_STUCK_MESSAGE,
  SIGNED_OUT_MESSAGE,
  eraseDeviceSync,
  getSyncStatus,
  sendCode,
  signOut,
  startSync,
  stopSync,
  subscribeSyncStatus,
  syncNow,
  verifyCode,
} from './manager';
import { GENERIC_MESSAGE, PAUSED_MESSAGE, SERVER_MESSAGE, SyncError } from './remote';
import { describeSyncStatus, pendingNote, timeAgo } from './useSync';
import type { SyncStatus } from './types';

const USER = { id: 'user-1', email: 'me@example.com' };
const SESSION = { access_token: 'a', refresh_token: 'r', user: USER };
const NOW = new Date('2026-09-26T12:00:00.000Z');

let win: EventTarget;
let doc: EventTarget & { visibilityState: string };
let nav: { onLine: boolean };
let storage: Map<string, string>;

function memoryStorage(m: Map<string, string>) {
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

/** Let promise chains and zero-delay timers settle. */
async function flush() {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
}

function fire(event: string, session: unknown) {
  fake.cb?.(event, session);
}

async function bootSignedIn() {
  fake.stored = USER;
  await startSync();
  fire('INITIAL_SESSION', SESSION);
  await flush();
}

async function emitPending(n: number) {
  fake.pending = n;
  for (const s of fake.subs) if (!s.closed) s.next(await s.fn());
}

function setVisible(visible: boolean) {
  doc.visibilityState = visible ? 'visible' : 'hidden';
  doc.dispatchEvent(new Event('visibilitychange'));
}

function deferred<T = unknown>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  win = new EventTarget();
  doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  nav = { onLine: true };
  storage = new Map();
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('navigator', nav);
  vi.stubGlobal('localStorage', memoryStorage(storage));

  fake.configured = true;
  fake.stored = null;
  fake.cb = null;
  fake.engines = [];
  fake.subs = [];
  fake.pending = 0;
  fake.syncNow.mockReset().mockResolvedValue({ pushed: 0, pulled: 0, applied: 0 });
  fake.getSession.mockReset().mockImplementation(async () => ({ data: { session: fake.stored ? SESSION : null }, error: null }));
  fake.refreshSession.mockReset().mockResolvedValue({ data: { session: SESSION, user: USER }, error: null });
  fake.signOut.mockReset().mockImplementation(async () => {
    // Like supabase-js: forget the session, then tell subscribers.
    fake.stored = null;
    fake.cb?.('SIGNED_OUT', null);
    return { error: null };
  });
  fake.verifyOtp.mockReset();
  fake.signInWithOtp.mockReset().mockResolvedValue({ data: {}, error: null });
  fake.getClient.mockReset().mockImplementation(() => (fake.configured ? Promise.resolve(fake.client) : Promise.reject(new Error('Sync is not configured in this build.'))));
  fake.bulkDelete.mockReset().mockResolvedValue(undefined);
  stopSync();
});

afterEach(() => {
  stopSync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('unconfigured builds', () => {
  it('report unconfigured and never load supabase-js or sync', async () => {
    fake.configured = false;
    stopSync();
    expect(getSyncStatus().state).toBe('unconfigured');
    await startSync();
    expect(getSyncStatus()).toEqual({ state: 'unconfigured', pending: 0 });
    expect(fake.getClient).not.toHaveBeenCalled();
    win.dispatchEvent(new Event('online'));
    setVisible(true);
    await vi.advanceTimersByTimeAsync(120_000);
    await syncNow();
    await eraseDeviceSync();
    await signOut();
    expect(fake.engines).toHaveLength(0);
    expect(fake.syncNow).not.toHaveBeenCalled();
    await expect(sendCode('me@example.com')).rejects.toMatchObject({ code: 'unconfigured' });
  });
});

describe('startup', () => {
  it('is signed out when there is no saved session', async () => {
    await startSync();
    fire('INITIAL_SESSION', null);
    await flush();
    expect(getSyncStatus()).toMatchObject({ state: 'signedOut', pending: 0 });
    expect(getSyncStatus().error).toBeUndefined();
    expect(fake.engines).toHaveLength(0);
  });

  it('shows the saved account right away, then syncs once and remembers when', async () => {
    fake.stored = USER;
    stopSync();
    expect(getSyncStatus()).toMatchObject({ state: 'idle', email: USER.email });
    const seen: SyncStatus[] = [];
    const unsub = subscribeSyncStatus(() => seen.push(getSyncStatus()));
    await startSync();
    fire('INITIAL_SESSION', SESSION);
    await flush();
    unsub();
    expect(fake.engines).toHaveLength(1);
    expect(fake.engines[0].opts.accountId).toBe(USER.id);
    expect(fake.syncNow).toHaveBeenCalledTimes(1);
    expect(seen.map((s) => s.state)).toContain('syncing');
    expect(getSyncStatus()).toMatchObject({ state: 'idle', email: USER.email, lastSyncedAt: NOW.toISOString() });
    expect(storage.get(`fb-sync-last:${USER.id}`)).toBe(NOW.toISOString());
  });

  it('startSync is idempotent', async () => {
    await Promise.all([startSync(), startSync()]);
    await startSync();
    expect(fake.getClient).toHaveBeenCalledTimes(1);
  });
});

describe('sign-in', () => {
  it('verifying a code creates the engine for that user and syncs right away', async () => {
    await startSync();
    fire('INITIAL_SESSION', null);
    fake.verifyOtp.mockImplementation(async () => {
      fake.stored = USER;
      fire('SIGNED_IN', SESSION);
      return { data: { session: SESSION, user: USER }, error: null };
    });
    const user = await verifyCode('me@example.com', '123456');
    await flush();
    expect(user).toEqual(USER);
    expect(fake.engines.map((e) => e.opts.accountId)).toEqual([USER.id]);
    expect(fake.syncNow).toHaveBeenCalledTimes(1);
    expect(getSyncStatus()).toMatchObject({ state: 'idle', email: USER.email, lastSyncedAt: NOW.toISOString() });
  });

  it('a SIGNED_IN for the same user (tab refocus) does not start another run', async () => {
    await bootSignedIn();
    fire('SIGNED_IN', SESSION);
    await flush();
    expect(fake.syncNow).toHaveBeenCalledTimes(1);
  });
});

describe('triggers', () => {
  it('syncs when the network returns and when the app comes back to the foreground', async () => {
    await bootSignedIn();
    win.dispatchEvent(new Event('online'));
    await flush();
    expect(fake.syncNow).toHaveBeenCalledTimes(2);
    setVisible(false);
    await flush();
    expect(fake.syncNow).toHaveBeenCalledTimes(2);
    setVisible(true);
    await flush();
    expect(fake.syncNow).toHaveBeenCalledTimes(3);
  });

  it('syncs every minute while visible, and not while hidden', async () => {
    await bootSignedIn();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.syncNow).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.syncNow).toHaveBeenCalledTimes(3);
    doc.visibilityState = 'hidden';
    await vi.advanceTimersByTimeAsync(180_000);
    expect(fake.syncNow).toHaveBeenCalledTimes(3);
  });

  it('syncs about 2 s after the last local change, only when changes are waiting', async () => {
    await bootSignedIn();
    doc.visibilityState = 'hidden'; // keep the interval out of the way
    await emitPending(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.syncNow).toHaveBeenCalledTimes(1);
    await emitPending(1);
    expect(getSyncStatus().pending).toBe(1);
    await vi.advanceTimersByTimeAsync(1_500);
    await emitPending(2); // typing pushes it back
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fake.syncNow).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(fake.syncNow).toHaveBeenCalledTimes(2);
  });

  it('flushes waiting changes when the app goes to the background', async () => {
    await bootSignedIn();
    await emitPending(3);
    setVisible(false);
    await flush();
    expect(fake.syncNow).toHaveBeenCalledTimes(2);
  });

  it('sends a change made during a run once that run is done', async () => {
    await bootSignedIn();
    const slow = deferred();
    fake.syncNow.mockImplementation(() => slow.promise);
    void syncNow();
    await flush();
    expect(fake.syncNow).toHaveBeenCalledTimes(2);
    // Edited after this run's push read the queue; the debounce fires while the run is still going.
    await emitPending(1);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(fake.syncNow).toHaveBeenCalledTimes(2);
    fake.syncNow.mockResolvedValue({ pushed: 1, pulled: 0, applied: 0 });
    slow.resolve({ pushed: 0, pulled: 0, applied: 0 });
    await flush();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(fake.syncNow).toHaveBeenCalledTimes(3);
  });

  it('a background flush that lands during a run goes right after it', async () => {
    await bootSignedIn();
    const slow = deferred();
    fake.syncNow.mockImplementation(() => slow.promise);
    void syncNow();
    await flush();
    await emitPending(1);
    setVisible(false);
    await flush();
    expect(fake.syncNow).toHaveBeenCalledTimes(2);
    fake.syncNow.mockResolvedValue({ pushed: 1, pulled: 0, applied: 0 });
    slow.resolve({ pushed: 0, pulled: 0, applied: 0 });
    await flush();
    // iOS may suspend the page any moment now: no debounce.
    expect(fake.syncNow).toHaveBeenCalledTimes(3);
  });

  it('does not go again after a run when nothing is left waiting', async () => {
    await bootSignedIn();
    const slow = deferred();
    fake.syncNow.mockImplementation(() => slow.promise);
    void syncNow();
    await flush();
    await emitPending(1);
    await vi.advanceTimersByTimeAsync(2_500);
    await emitPending(0); // the run's push took it
    slow.resolve({ pushed: 1, pulled: 0, applied: 0 });
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.syncNow).toHaveBeenCalledTimes(2);
  });

  it('never overlaps runs, and triggers that arrive mid-run share one run after it', async () => {
    await bootSignedIn();
    const slow = deferred();
    let active = 0;
    let maxActive = 0;
    fake.syncNow.mockImplementation(async () => {
      maxActive = Math.max(maxActive, ++active);
      try {
        return await slow.promise;
      } finally {
        active--;
      }
    });
    const manual = syncNow();
    await flush();
    win.dispatchEvent(new Event('online'));
    setVisible(true);
    await vi.advanceTimersByTimeAsync(60_000);
    const again = syncNow();
    expect(fake.syncNow).toHaveBeenCalledTimes(2);
    expect(getSyncStatus().state).toBe('syncing');
    slow.resolve({ pushed: 1, pulled: 0, applied: 0 });
    await manual;
    await again;
    await flush();
    expect(getSyncStatus().state).toBe('idle');
    // 'online', 'visible' and the second tap: one more run, after the first.
    expect(fake.syncNow).toHaveBeenCalledTimes(3);
    expect(maxActive).toBe(1);
    fake.syncNow.mockResolvedValue({ pushed: 0, pulled: 0, applied: 0 });
    await syncNow();
    expect(fake.syncNow).toHaveBeenCalledTimes(4);
  });

  it('coming back to the foreground during a run cut off by a suspension pulls right after it', async () => {
    await bootSignedIn();
    // An interval run is in flight when iOS suspends the page; its request dies.
    const stale = deferred();
    fake.syncNow.mockImplementationOnce(() => stale.promise);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.syncNow).toHaveBeenCalledTimes(2);
    setVisible(false);
    setVisible(true);
    await flush();
    expect(fake.syncNow).toHaveBeenCalledTimes(2);
    stale.reject(new TypeError('Load failed'));
    await flush();
    // Nothing is waiting to push, and it still pulls now (not at the next tick).
    expect(getSyncStatus().pending).toBe(0);
    expect(fake.syncNow).toHaveBeenCalledTimes(3);
    expect(getSyncStatus().state).toBe('idle');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.syncNow).toHaveBeenCalledTimes(3);
  });

  it('Sync now during a run from before a suspension waits for it, then syncs again', async () => {
    await bootSignedIn();
    const stale = deferred();
    fake.syncNow.mockImplementationOnce(() => stale.promise);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.syncNow).toHaveBeenCalledTimes(2);
    let done = false;
    const tap = syncNow().then(() => (done = true));
    await flush();
    expect(done).toBe(false);
    expect(fake.syncNow).toHaveBeenCalledTimes(2);
    stale.reject(new TypeError('Load failed'));
    await tap;
    expect(fake.syncNow).toHaveBeenCalledTimes(3);
    expect(getSyncStatus().state).toBe('idle');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.syncNow).toHaveBeenCalledTimes(3);
  });
});

describe('offline', () => {
  it('shows offline with waiting changes, without errors or runs', async () => {
    await bootSignedIn();
    nav.onLine = false;
    win.dispatchEvent(new Event('offline'));
    await emitPending(2);
    await vi.advanceTimersByTimeAsync(130_000);
    await syncNow();
    expect(fake.syncNow).toHaveBeenCalledTimes(1);
    expect(getSyncStatus()).toMatchObject({ state: 'offline', pending: 2 });
    expect(getSyncStatus().error).toBeUndefined();
    expect(describeSyncStatus(getSyncStatus())).toBe('Offline, 2 changes waiting');
    nav.onLine = true;
    win.dispatchEvent(new Event('online'));
    await flush();
    expect(fake.syncNow).toHaveBeenCalledTimes(2);
    expect(getSyncStatus().state).toBe('idle');
  });

  it('treats a network failure during a run as offline, not an error', async () => {
    fake.syncNow.mockRejectedValue(new SyncError('offline'));
    await bootSignedIn();
    expect(getSyncStatus().state).toBe('offline');
    expect(getSyncStatus().error).toBeUndefined();
  });

  it('a network failure while the browser says online retries once after 5 s, never in a loop', async () => {
    fake.syncNow.mockRejectedValue(new SyncError('offline'));
    await bootSignedIn();
    doc.visibilityState = 'hidden'; // keep the interval out of the way
    expect(getSyncStatus().state).toBe('offline');
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fake.syncNow).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.syncNow).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fake.syncNow).toHaveBeenCalledTimes(2);
    expect(getSyncStatus()).toMatchObject({ state: 'offline', error: undefined });

    // After a success, the next such failure gets its quick retry again.
    fake.syncNow.mockResolvedValueOnce({ pushed: 0, pulled: 0, applied: 0 });
    await syncNow();
    expect(getSyncStatus().state).toBe('idle');
    await syncNow();
    expect(getSyncStatus().state).toBe('offline');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.syncNow).toHaveBeenCalledTimes(5);
  });

  it('a failure after the browser went offline waits for the network to return (no quick retry)', async () => {
    await bootSignedIn();
    doc.visibilityState = 'hidden';
    const slow = deferred();
    fake.syncNow.mockImplementationOnce(() => slow.promise);
    void syncNow();
    await flush();
    nav.onLine = false;
    slow.reject(new TypeError('Load failed'));
    await flush();
    expect(getSyncStatus().state).toBe('offline');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fake.syncNow).toHaveBeenCalledTimes(2);
    nav.onLine = true;
    win.dispatchEvent(new Event('online'));
    await flush();
    expect(fake.syncNow).toHaveBeenCalledTimes(3);
    expect(getSyncStatus().state).toBe('idle');
  });

  it('a local bug (TypeError) while online is an error, never a silent "offline"', async () => {
    fake.syncNow.mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'id')"));
    await bootSignedIn();
    expect(getSyncStatus()).toMatchObject({ state: 'error', error: GENERIC_MESSAGE });
  });
});

describe('errors and backoff', () => {
  it('retries after 5 s, 15 s, 60 s, then every 5 minutes, and resets on success', async () => {
    fake.syncNow.mockRejectedValue(new SyncError('server'));
    await bootSignedIn();
    doc.visibilityState = 'hidden';
    expect(getSyncStatus()).toMatchObject({ state: 'error', error: SERVER_MESSAGE });
    const calls = () => fake.syncNow.mock.calls.length;
    const steps: [number, number][] = [
      [4_999, 1],
      [1, 2],
      [14_999, 2],
      [1, 3],
      [59_999, 3],
      [1, 4],
      [299_999, 4],
      [1, 5],
      [299_999, 5],
      [1, 6],
    ];
    for (const [ms, expected] of steps) {
      await vi.advanceTimersByTimeAsync(ms);
      expect(calls()).toBe(expected);
    }
    // Automatic triggers wait out the backoff; "Sync now" does not.
    doc.visibilityState = 'visible';
    win.dispatchEvent(new Event('online'));
    await flush();
    expect(calls()).toBe(6);
    fake.syncNow.mockResolvedValue({ pushed: 0, pulled: 0, applied: 0 });
    await syncNow();
    expect(calls()).toBe(7);
    expect(getSyncStatus().state).toBe('idle');
    expect(getSyncStatus().error).toBeUndefined();
    // The next failure starts over at 5 s.
    doc.visibilityState = 'hidden';
    fake.syncNow.mockRejectedValue(new SyncError('paused'));
    await syncNow();
    expect(getSyncStatus()).toMatchObject({ state: 'error', error: PAUSED_MESSAGE });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls()).toBe(9);
  });
});

describe('offline session gotcha', () => {
  it('a null INITIAL_SESSION with the refresh token still saved is not a sign-out', async () => {
    fake.stored = USER;
    nav.onLine = false;
    fake.getSession.mockResolvedValue({ data: { session: null }, error: { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' } });
    stopSync();
    await startSync();
    fire('INITIAL_SESSION', null);
    await flush();
    expect(getSyncStatus()).toMatchObject({ state: 'offline', email: USER.email });
    expect(fake.signOut).not.toHaveBeenCalled();
    expect(fake.stored).toEqual(USER);
    expect(fake.engines).toHaveLength(1);
    // Back online: the session refreshes and the queue goes out.
    nav.onLine = true;
    fake.getSession.mockResolvedValue({ data: { session: SESSION }, error: null });
    win.dispatchEvent(new Event('online'));
    await flush();
    expect(fake.syncNow).toHaveBeenCalledTimes(1);
    expect(getSyncStatus().state).toBe('idle');
  });

  it('a later TOKEN_REFRESHED sends the waiting queue', async () => {
    fake.stored = USER;
    fake.getSession.mockResolvedValue({ data: { session: null }, error: { name: 'AuthRetryableFetchError', status: 0 } });
    await startSync();
    fire('INITIAL_SESSION', null);
    await flush();
    expect(getSyncStatus().state).toBe('offline');
    fake.getSession.mockResolvedValue({ data: { session: SESSION }, error: null });
    fire('TOKEN_REFRESHED', SESSION);
    await flush();
    expect(fake.syncNow).toHaveBeenCalledTimes(1);
    expect(getSyncStatus().state).toBe('idle');
  });

  it('a refresh that fails on the network while online stays signed in', async () => {
    fake.stored = USER;
    fake.getSession.mockResolvedValue({ data: { session: null }, error: { name: 'AuthRetryableFetchError', status: 0 } });
    await startSync();
    fire('INITIAL_SESSION', null);
    await flush();
    expect(getSyncStatus().state).toBe('offline');
    fake.getSession.mockResolvedValue({ data: { session: null }, error: { name: 'AuthRetryableFetchError', status: 503 } });
    await syncNow();
    expect(getSyncStatus()).toMatchObject({ state: 'error', error: PAUSED_MESSAGE, email: USER.email });
    expect(fake.signOut).not.toHaveBeenCalled();
  });

  it('a null INITIAL_SESSION after the saved session was removed is a sign-out, with a message', async () => {
    fake.stored = USER;
    stopSync();
    await startSync();
    fake.stored = null; // supabase-js removed it: the server rejected the refresh token
    fire('INITIAL_SESSION', null);
    await flush();
    expect(getSyncStatus()).toMatchObject({ state: 'signedOut', error: SIGNED_OUT_MESSAGE });
  });

  it('a SIGNED_OUT from supabase-js signs out with a message', async () => {
    await bootSignedIn();
    fake.stored = null;
    fire('SIGNED_OUT', null);
    expect(getSyncStatus()).toMatchObject({ state: 'signedOut', error: SIGNED_OUT_MESSAGE, pending: 0 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fake.syncNow).toHaveBeenCalledTimes(1);
  });
});

describe('auth errors', () => {
  it('refreshes once and retries when the token was stale', async () => {
    fake.syncNow.mockRejectedValueOnce(new SyncError('auth'));
    await bootSignedIn();
    expect(fake.refreshSession).toHaveBeenCalledTimes(1);
    expect(fake.syncNow).toHaveBeenCalledTimes(2);
    expect(getSyncStatus().state).toBe('idle');
  });

  it('signs out locally when the refresh token is rejected', async () => {
    fake.syncNow.mockRejectedValue(new SyncError('auth'));
    fake.refreshSession.mockResolvedValue({ data: { session: null, user: null }, error: { name: 'AuthApiError', status: 400, code: 'refresh_token_not_found' } });
    await bootSignedIn();
    expect(fake.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(getSyncStatus()).toMatchObject({ state: 'signedOut', error: SIGNED_OUT_MESSAGE });
    expect(fake.engines[0].forget).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400_000);
    expect(fake.syncNow).toHaveBeenCalledTimes(1);
  });

  it('stays signed in when the refresh cannot reach the server', async () => {
    fake.syncNow.mockRejectedValue(new SyncError('auth'));
    fake.refreshSession.mockResolvedValue({ data: { session: null, user: null }, error: { name: 'AuthRetryableFetchError', status: 0 } });
    await bootSignedIn();
    expect(fake.signOut).not.toHaveBeenCalled();
    expect(getSyncStatus()).toMatchObject({ state: 'offline', email: USER.email });
  });

  it('a refresh discarded because another tab refreshed first is not a sign-out', async () => {
    fake.syncNow.mockRejectedValueOnce(new SyncError('auth'));
    fake.refreshSession.mockResolvedValue({ data: { session: null, user: null }, error: { name: 'AuthRefreshDiscardedError', status: 409 } });
    await bootSignedIn();
    expect(fake.signOut).not.toHaveBeenCalled();
    expect(fake.stored).toEqual(USER);
    expect(fake.syncNow).toHaveBeenCalledTimes(2);
    expect(getSyncStatus()).toMatchObject({ state: 'idle', email: USER.email });
  });

  it('a refresh discarded because the session was removed meanwhile is a sign-out', async () => {
    fake.syncNow.mockRejectedValue(new SyncError('auth'));
    fake.refreshSession.mockImplementation(async () => {
      fake.stored = null;
      return { data: { session: null, user: null }, error: { name: 'AuthRefreshDiscardedError', status: 409 } };
    });
    await bootSignedIn();
    expect(getSyncStatus()).toMatchObject({ state: 'signedOut', error: SIGNED_OUT_MESSAGE });
  });

  it('a discarded refresh while loading the session reads the saved session again', async () => {
    fake.getSession.mockResolvedValueOnce({ data: { session: null }, error: { name: 'AuthRefreshDiscardedError', status: 409 } });
    await bootSignedIn();
    expect(fake.syncNow).toHaveBeenCalledTimes(1);
    expect(getSyncStatus().state).toBe('idle');
    expect(getSyncStatus().error).toBeUndefined();
  });

  it('backs off (without signing out) when auth still fails after a good refresh', async () => {
    fake.syncNow.mockRejectedValue(new SyncError('auth'));
    await bootSignedIn();
    expect(fake.signOut).not.toHaveBeenCalled();
    expect(getSyncStatus()).toMatchObject({ state: 'error', error: AUTH_STUCK_MESSAGE });
  });
});

describe('sign out and erase', () => {
  it('signing out keeps the cursor and local data', async () => {
    await bootSignedIn();
    await signOut();
    expect(fake.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(fake.engines[0].forget).not.toHaveBeenCalled();
    expect(getSyncStatus()).toMatchObject({ state: 'signedOut', pending: 0 });
    expect(getSyncStatus().error).toBeUndefined();
    expect(storage.get(`fb-sync-last:${USER.id}`)).toBe(NOW.toISOString());
  });

  it('eraseDeviceSync forgets the account on this device and signs out', async () => {
    await bootSignedIn();
    await eraseDeviceSync();
    expect(fake.engines[0].forget).toHaveBeenCalledTimes(1);
    expect(fake.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(storage.has(`fb-sync-last:${USER.id}`)).toBe(false);
    expect(getSyncStatus()).toMatchObject({ state: 'signedOut', pending: 0 });
    expect(getSyncStatus().error).toBeUndefined();
  });

  it('eraseDeviceSync waits for a run in flight', async () => {
    await bootSignedIn();
    const slow = deferred();
    fake.syncNow.mockImplementation(() => slow.promise);
    void syncNow();
    await flush();
    let done = false;
    const erase = eraseDeviceSync().then(() => (done = true));
    await flush();
    expect(done).toBe(false);
    slow.resolve({ pushed: 0, pulled: 0, applied: 0 });
    await erase;
    expect(fake.engines[0].forget).toHaveBeenCalled();
    expect(getSyncStatus().state).toBe('signedOut');
  });

  it('eraseDeviceSync lets nothing start syncing again before it has signed out', async () => {
    await bootSignedIn();
    const slow = deferred();
    fake.syncNow.mockImplementation(() => slow.promise);
    void syncNow();
    await flush();
    const erase = eraseDeviceSync();
    await flush();
    // The auto-refresh ticker and a local write, both while erase waits for the run in flight.
    fire('TOKEN_REFRESHED', SESSION);
    fire('SIGNED_IN', SESSION);
    await emitPending(2);
    await vi.advanceTimersByTimeAsync(3_000);
    fake.syncNow.mockResolvedValue({ pushed: 0, pulled: 0, applied: 0 });
    slow.resolve({ pushed: 0, pulled: 0, applied: 0 });
    await erase;
    await flush();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fake.engines).toHaveLength(1);
    expect(fake.syncNow).toHaveBeenCalledTimes(2);
    expect(getSyncStatus()).toMatchObject({ state: 'signedOut', pending: 0 });
    // Signing in again afterward works as usual.
    fake.verifyOtp.mockImplementation(async () => {
      fake.stored = USER;
      fire('SIGNED_IN', SESSION);
      return { data: { session: SESSION, user: USER }, error: null };
    });
    await verifyCode('me@example.com', '123456');
    await flush();
    expect(fake.syncNow).toHaveBeenCalledTimes(3);
    expect(getSyncStatus().state).toBe('idle');
  });

  it('eraseDeviceSync is safe when signed out, and works before startup', async () => {
    await startSync();
    fire('INITIAL_SESSION', null);
    await eraseDeviceSync();
    expect(fake.signOut).not.toHaveBeenCalled();
    expect(getSyncStatus().state).toBe('signedOut');

    stopSync();
    fake.stored = USER;
    await eraseDeviceSync();
    expect(fake.bulkDelete).toHaveBeenCalledWith([`syncCursor:${USER.id}`, `syncJoined:${USER.id}`, `syncJoinStarted:${USER.id}`, `syncSchema:${USER.id}`, 'syncEpoch']);
    expect(fake.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(getSyncStatus().state).toBe('signedOut');
  });

  it('signing out offline still signs out on this device', async () => {
    await bootSignedIn();
    nav.onLine = false;
    fake.signOut.mockResolvedValue({ error: { name: 'AuthRetryableFetchError', status: 0 } });
    await signOut();
    expect(fake.stored).toBeNull();
    expect(getSyncStatus().state).toBe('signedOut');
  });
});

describe('status text', () => {
  const base: SyncStatus = { state: 'idle', pending: 0 };
  const now = NOW.getTime();

  it('says when it last synced', () => {
    expect(describeSyncStatus({ ...base, lastSyncedAt: new Date(now - 20_000).toISOString() }, now)).toBe('Synced just now');
    expect(describeSyncStatus({ ...base, lastSyncedAt: new Date(now - 5 * 60_000).toISOString() }, now)).toBe('Synced 5 min ago');
    expect(describeSyncStatus({ ...base, lastSyncedAt: new Date(now - 3 * 3_600_000).toISOString() }, now)).toBe('Synced 3 hr ago');
    expect(timeAgo(new Date(now - 26 * 3_600_000).toISOString(), now)).toBe('1 day ago');
    expect(describeSyncStatus(base, now)).toBe('Not synced yet');
  });

  it('covers syncing, offline, and errors', () => {
    expect(describeSyncStatus({ ...base, state: 'syncing' })).toBe('Syncing...');
    expect(describeSyncStatus({ ...base, state: 'offline', pending: 1 })).toBe('Offline, 1 change waiting');
    expect(describeSyncStatus({ ...base, state: 'error', error: PAUSED_MESSAGE })).toBe(PAUSED_MESSAGE);
    expect(pendingNote({ ...base, pending: 2 })).toBe('2 changes waiting to sync');
    expect(pendingNote({ ...base, state: 'offline', pending: 2 })).toBeNull();
    for (const s of ['idle', 'syncing', 'offline', 'error', 'signedOut', 'unconfigured'] as const) {
      expect(describeSyncStatus({ ...base, state: s })).not.toMatch(/—/);
    }
  });
});
