// The sync scheduler and its status, one per app. startSync() once at boot; everything else follows:
// restore the session, run the engine at the right moments, never overlap runs, back off on errors,
// and publish a tiny external store the UI reads (useSyncStatus in ./useSync).
//
// When it runs: at start, right after sign-in, when the app comes back to the foreground, when the
// network returns, every minute while visible, and about 2 s after local changes. iOS has no Background
// Sync, so everything happens from the page; going to the background also flushes waiting changes.
// Runs never overlap. A run may have started before iOS suspended the page, so a foreground or network
// trigger that arrives mid-run gets one more run right after it, and "Sync now" waits for the run in
// flight and then starts a fresh one.
//
// Offline is not an error: changes wait in the offline queue (dirty records) and the status says so.
// A network failure while the browser still says online (a request cut off or timed out) retries once
// after 5 s; after that the interval and the 'online' event take over.
// Network trouble never signs anyone out. Only a refresh token the server rejects does.
import type { AuthChangeEvent, Session, SupabaseClient } from '@supabase/supabase-js';
import { liveQuery, type Subscription } from 'dexie';
import { db } from '@/data/db';
import * as auth from './auth';
import { SIGN_IN_MESSAGES, SignInError, type SignedInUser } from './auth';
import { getClient, hasStoredSession, isSyncConfigured, readStoredSession, type StoredUser } from './client';
import { createSyncEngine, syncStateKeys, type SyncEngine } from './engine';
import { SyncError, browserOnline, createSupabaseRemote, toSyncError, type RpcClient, type RpcResponse } from './remote';
import type { SyncStatus } from './types';
import { holdBusyUntil } from '@/ui/busy';

export const SYNC_INTERVAL_MS = 60_000;
export const LOCAL_DEBOUNCE_MS = 2_000;
/** One quick retry after a network failure while the browser still says it is online. */
export const OFFLINE_RETRY_MS = 5_000;
/** Wait before retrying after consecutive errors: 5 s, 15 s, 60 s, then every 5 minutes. */
export const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000] as const;

export const SIGNED_OUT_MESSAGE = 'You were signed out. Sign in again to keep syncing.';
export const AUTH_STUCK_MESSAGE = "Sync couldn't confirm your sign-in. If this keeps happening, sign out and back in.";
export const LOAD_FAILED_MESSAGE = "Sync couldn't start. Close and reopen the app to try again.";

const LAST_SYNC_KEY = (accountId: string) => `fb-sync-last:${accountId}`;

type Trigger = 'start' | 'signin' | 'visible' | 'hidden' | 'online' | 'interval' | 'local' | 'manual' | 'retry';

// ---------- Status store ----------

let status: SyncStatus = initialStatus();
const listeners = new Set<() => void>();

function initialStatus(): SyncStatus {
  if (!isSyncConfigured()) return { state: 'unconfigured', pending: 0 };
  const stored = readStoredSession();
  if (!stored) return { state: 'signedOut', pending: 0 };
  return { state: browserOnline() ? 'idle' : 'offline', email: stored.email, lastSyncedAt: readLastSynced(stored.id), pending: 0 };
}

function setStatus(patch: Partial<SyncStatus>) {
  const next = { ...status, ...patch };
  if (
    next.state === status.state &&
    next.email === status.email &&
    next.lastSyncedAt === status.lastSyncedAt &&
    next.pending === status.pending &&
    next.error === status.error
  ) {
    return;
  }
  status = next;
  for (const l of [...listeners]) l();
}

export function getSyncStatus(): SyncStatus {
  return status;
}

export function subscribeSyncStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ---------- Device-local memory ----------

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readLastSynced(accountId: string): string | undefined {
  try {
    return store()?.getItem(LAST_SYNC_KEY(accountId)) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeLastSynced(accountId: string, at: string | null) {
  try {
    if (at) store()?.setItem(LAST_SYNC_KEY(accountId), at);
    else store()?.removeItem(LAST_SYNC_KEY(accountId));
  } catch {
    // storage unavailable
  }
}

// ---------- Scheduler state ----------

let generation = 0; // bumped by stopSync, so async work from an older run of the manager bails out
let bootPromise: Promise<void> | null = null;
let client: SupabaseClient | null = null;
let clientLoading: Promise<SupabaseClient | null> | null = null;
let authSub: { unsubscribe(): void } | null = null;
let account: StoredUser | null = null;
let engine: SyncEngine | null = null;
let pendingSub: Subscription | null = null;
let running: Promise<void> | null = null;
let runningEngine: SyncEngine | null = null;
let again = false;
/** A local change (or a background flush) arrived mid-run and may have missed its push: go once more after. */
let rerun = false;
/**
 * 'visible' or 'online' arrived mid-run. That run may have started before iOS suspended the page (its
 * request may be dead), so pull once more after it, even with nothing waiting to push.
 */
let followUp = false;
/** Set once an 'offline' failure has scheduled its quick retry; cleared by the next success. */
let offlineRetried = false;
/** Set while eraseDeviceSync runs: no auth event or trigger may start syncing (a run would refill the device). */
let erasing = false;
let failures = 0;
let backoffUntil = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let localTimer: ReturnType<typeof setTimeout> | undefined;
/** Set while this module signs out on purpose: the message to show (undefined for a normal sign-out). */
let ownSignOut: { message?: string } | null = null;
const cleanups: (() => void)[] = [];

/** The engine's remote talks to whichever client is loaded (runs always load it first). */
const rpcClient: RpcClient = {
  rpc: (fn, args) => (client ? (client.rpc(fn, args) as unknown as PromiseLike<RpcResponse>) : Promise.reject(new TypeError('Failed to fetch'))),
};

// ---------- Boot ----------

/** Start syncing. Idempotent; call once at app boot. Does nothing but report 'unconfigured' without keys. */
export function startSync(): Promise<void> {
  bootPromise ??= boot(generation);
  return bootPromise;
}

async function boot(gen: number): Promise<void> {
  if (!isSyncConfigured()) {
    setStatus({ state: 'unconfigured', pending: 0, email: undefined, lastSyncedAt: undefined, error: undefined });
    return;
  }
  listen();
  // Show the saved account right away: works offline and before supabase-js loads.
  const stored = readStoredSession();
  if (stored) setAccount(stored);
  else setStatus({ state: 'signedOut', email: undefined, lastSyncedAt: undefined, pending: 0 });
  await loadClient(gen);
}

function loadClient(gen: number): Promise<SupabaseClient | null> {
  if (client) return Promise.resolve(client);
  clientLoading ??= (async () => {
    try {
      const c = await getClient();
      if (gen !== generation) return null;
      client = c;
      // Keep the callback synchronous: auth-js awaits subscribers while it holds its session lock.
      const { data } = c.auth.onAuthStateChange((event, session) => {
        if (gen === generation) onAuthEvent(event, session);
      });
      authSub = data.subscription;
      return c;
    } catch {
      // supabase-js could not load (offline before it was ever cached). The next trigger tries again.
      if (gen === generation && account) setStatus(browserOnline() ? { state: 'error', error: LOAD_FAILED_MESSAGE } : { state: 'offline', error: undefined });
      return null;
    } finally {
      clientLoading = null;
    }
  })();
  return clientLoading;
}

function listen() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const onOnline = () => void requestSync('online');
  const onOffline = () => {
    if (engine) setStatus({ state: 'offline', error: undefined });
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') void requestSync('visible');
    // Going to the background: push waiting changes while iOS still lets the page run.
    else if (status.pending > 0) void holdBusyUntil('sync push', requestSync('hidden'));
  };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  document.addEventListener('visibilitychange', onVisibility);
  const interval = setInterval(() => {
    if (document.visibilityState === 'visible') void requestSync('interval');
  }, SYNC_INTERVAL_MS);
  cleanups.push(() => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    document.removeEventListener('visibilitychange', onVisibility);
    clearInterval(interval);
  });
}

// ---------- Accounts ----------

function onAuthEvent(event: AuthChangeEvent, session: Session | null) {
  if (session?.user) {
    const isNew = account?.id !== session.user.id || status.state === 'signedOut';
    setAccount({ id: session.user.id, email: session.user.email ?? undefined });
    if (event === 'INITIAL_SESSION') void requestSync('start');
    else if (event === 'SIGNED_IN' && isNew) void requestSync('signin');
    // The token could not refresh earlier (no network) and now has: the queue can go.
    else if (event === 'TOKEN_REFRESHED' && status.state === 'offline') void requestSync('online');
    return;
  }
  if (event === 'SIGNED_OUT') {
    handleSignedOut(ownSignOut ? ownSignOut.message : SIGNED_OUT_MESSAGE);
    return;
  }
  if (event !== 'INITIAL_SESSION') return;
  if (hasStoredSession()) {
    // Offline gotcha: with an expired access token and no network, supabase-js reports no session even
    // though the refresh token is still saved. That is not a sign-out; keep the account and try later.
    const stored = readStoredSession();
    if (stored) setAccount(stored);
    if (!browserOnline()) setStatus({ state: 'offline', error: undefined });
    void requestSync('start');
    return;
  }
  // The saved session is gone (the server rejected it during startup), or there never was one.
  handleSignedOut(account ? SIGNED_OUT_MESSAGE : undefined);
}

function setAccount(user: StoredUser) {
  if (erasing) return;
  if (engine && account?.id === user.id) {
    if (user.email && user.email !== account.email) {
      account = user;
      setStatus({ email: user.email });
    }
    return;
  }
  dropAccount();
  account = user;
  const eng = createSyncEngine({ db, remote: createSupabaseRemote(rpcClient), accountId: user.id });
  engine = eng;
  pendingSub = liveQuery(() => eng.pendingCount()).subscribe({
    next: (n) => onPending(eng, n),
    error: () => undefined,
  });
  setStatus({ state: browserOnline() ? 'idle' : 'offline', email: user.email, lastSyncedAt: readLastSynced(user.id), error: undefined });
}

/** Stop syncing for the current account (its cursor stays, so signing back in is not a fresh join). */
function dropAccount() {
  pendingSub?.unsubscribe();
  pendingSub = null;
  clearTimeout(localTimer);
  clearTimeout(retryTimer);
  failures = 0;
  backoffUntil = 0;
  rerun = false;
  followUp = false;
  offlineRetried = false;
  engine = null;
  account = null;
}

function handleSignedOut(message?: string) {
  dropAccount();
  setStatus({ state: 'signedOut', email: undefined, lastSyncedAt: undefined, pending: 0, error: message });
}

function onPending(eng: SyncEngine, n: number) {
  if (eng !== engine) return;
  setStatus({ pending: n });
  if (n > 0) scheduleLocal();
}

/** Local changes: sync shortly after the last one (typing keeps pushing this back). */
function scheduleLocal() {
  clearTimeout(localTimer);
  localTimer = setTimeout(() => {
    if (status.pending > 0) void requestSync('local');
  }, LOCAL_DEBOUNCE_MS);
}

// ---------- Runs ----------

function requestSync(trigger: Trigger): Promise<void> {
  if (!engine || erasing) return Promise.resolve();
  if (running) {
    // A run for another account is finishing: go again for the new one afterward.
    if (runningEngine !== engine) again = true;
    // A change saved after this run's push read the queue waits for the next run, so make sure there is one.
    else if (trigger === 'local' || trigger === 'hidden') rerun = true;
    else if (trigger === 'visible' || trigger === 'online') followUp = true;
    return running;
  }
  const forced = trigger === 'manual' || trigger === 'retry' || trigger === 'signin';
  const backingOff = Date.now() < backoffUntil && !(trigger === 'online' && status.state === 'offline');
  if (!forced && backingOff) return Promise.resolve();
  if (!browserOnline()) {
    setStatus({ state: 'offline', error: undefined });
    return Promise.resolve();
  }
  return run(engine);
}

function run(eng: SyncEngine): Promise<void> {
  const gen = generation;
  const current = () => eng === engine && gen === generation;
  const p = (async () => {
    setStatus({ state: 'syncing' });
    try {
      const c = await loadClient(gen);
      if (!c) throw new SyncError(browserOnline() ? 'server' : 'offline', { message: LOAD_FAILED_MESSAGE });
      if (!current() || !(await ensureSession(c))) return;
      try {
        await eng.syncNow();
      } catch (e) {
        // An auth failure gets one token refresh and one retry per run.
        const err = toSyncError(e);
        if (err.kind !== 'auth' || !current()) throw err;
        if (!(await refreshSession(c))) {
          if (current()) await signOutHere(SIGNED_OUT_MESSAGE);
          return;
        }
        if (!current()) return;
        await eng.syncNow();
      }
      if (current()) onSuccess();
    } catch (e) {
      if (current()) onFailure(toSyncError(e));
    }
  })();
  running = p;
  runningEngine = eng;
  void p.finally(() => {
    if (running !== p) return;
    running = null;
    runningEngine = null;
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const pullAgain = followUp && !hidden;
    followUp = false;
    if (again) {
      again = false;
      rerun = false;
      void requestSync('signin');
    } else if (pullAgain) {
      // A full run (push, then pull) also covers a change that arrived mid-run.
      rerun = false;
      void requestSync('visible');
    } else if (rerun) {
      rerun = false;
      // On the way to the background there is no time for the debounce (iOS suspends the page soon).
      if (hidden) {
        if (status.pending > 0) void holdBusyUntil('sync push', requestSync('hidden'));
      } else {
        scheduleLocal();
      }
    }
  });
  return p;
}

/**
 * True when there is a usable session for the current account. Throws SyncError offline/paused when
 * the session can't be refreshed right now but is still saved (never a sign-out).
 */
async function ensureSession(c: SupabaseClient): Promise<boolean> {
  let res = await c.auth.getSession();
  // Another tab refreshed the token at the same moment and supabase-js discarded ours: read the saved one.
  if (!res.data.session && isRefreshDiscarded(res.error)) res = await c.auth.getSession();
  const { data, error } = res;
  const user = data.session?.user;
  if (user) {
    if (user.id === account?.id) return true;
    // Another tab signed in to a different account.
    setAccount({ id: user.id, email: user.email ?? undefined });
    again = true;
    return false;
  }
  if (hasStoredSession()) throw unreachable(error);
  handleSignedOut(SIGNED_OUT_MESSAGE);
  return false;
}

/** False when the refresh token was rejected (the session is dead). Throws when the server can't be reached. */
async function refreshSession(c: SupabaseClient): Promise<boolean> {
  const { data, error } = await c.auth.refreshSession();
  if (data.session) return true;
  if ((error as { name?: string } | null)?.name === 'AuthRetryableFetchError') throw unreachable(error);
  // Not a rejection: another tab refreshed (or signed out) at the same moment. What is saved now decides.
  if (isRefreshDiscarded(error)) return hasStoredSession();
  return false;
}

/** supabase-js threw away a refresh result because the saved session changed while it was in flight. */
function isRefreshDiscarded(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'AuthRefreshDiscardedError';
}

function unreachable(error: unknown): SyncError {
  const httpStatus = (error as { status?: number } | null)?.status ?? 0;
  if (!browserOnline() || httpStatus === 0) return new SyncError('offline', { detail: error });
  return new SyncError('paused', { status: httpStatus, detail: error });
}

function onSuccess() {
  failures = 0;
  backoffUntil = 0;
  offlineRetried = false;
  clearTimeout(retryTimer);
  const at = new Date().toISOString();
  if (account) writeLastSynced(account.id, at);
  setStatus({ state: 'idle', lastSyncedAt: at, error: undefined });
}

function onFailure(err: SyncError) {
  if (err.kind === 'offline') {
    // Not an error: the offline queue holds the changes. Coming back online (or the next tick) retries.
    setStatus({ state: 'offline', error: undefined });
    // The browser still says online, so no 'online' event will come: the request may have been cut off
    // by an iOS suspension or timed out. Try once more soon, without backoff (the interval covers the rest).
    if (browserOnline() && !offlineRetried) {
      offlineRetried = true;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => void requestSync('retry'), OFFLINE_RETRY_MS);
    }
    return;
  }
  failures++;
  const delay = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1];
  backoffUntil = Date.now() + delay;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => void requestSync('retry'), delay);
  setStatus({ state: 'error', error: err.kind === 'auth' ? AUTH_STUCK_MESSAGE : err.message });
}

async function signOutHere(message?: string) {
  ownSignOut = { message };
  try {
    await auth.signOut();
  } finally {
    ownSignOut = null;
  }
  handleSignedOut(message);
}

// ---------- Public actions ----------

/** Sync right away ("Sync now"). Skips any error backoff. */
export async function syncNow(): Promise<void> {
  await startSync();
  if (!engine) return;
  clearTimeout(retryTimer);
  backoffUntil = 0;
  // A run in flight may have started before iOS suspended the page (its request may be dead): let it
  // finish, then sync again, so the tap always gets a run that started after it.
  if (running) await running.catch(() => undefined);
  await requestSync('manual');
}

/** Email a sign-in code. Throws SignInError with a message ready to show. */
export async function sendCode(email: string): Promise<void> {
  if (!isSyncConfigured()) throw new SignInError('unconfigured', SIGN_IN_MESSAGES.unconfigured);
  void startSync();
  await auth.sendCode(email);
}

/** Verify a code (or pasted sign-in link), then start the first sync. Throws SignInError. */
export async function verifyCode(email: string, input: string): Promise<SignedInUser> {
  if (!isSyncConfigured()) throw new SignInError('unconfigured', SIGN_IN_MESSAGES.unconfigured);
  await startSync();
  const user = await auth.verifyCode(email, input);
  setAccount(user);
  void requestSync('signin');
  return user;
}

/** Sign out on this device. Other devices stay signed in; data on this device stays. */
export async function signOut(): Promise<void> {
  if (!isSyncConfigured()) return;
  dropAccount();
  await signOutHere(undefined);
}

/**
 * For "Erase all data on this device": forget this account's sync position, then sign out here.
 * Waits for a run in flight, so nothing lands after the wipe. Safe when unconfigured or signed out.
 */
export async function eraseDeviceSync(): Promise<void> {
  if (!isSyncConfigured()) return;
  // Until the session is gone, auth events (token refresh, tab refocus) and triggers must not bring back
  // an engine: a run started now would not be forgotten and could land pulled data after the wipe.
  erasing = true;
  try {
    const eng = engine;
    const acct = account ?? readStoredSession();
    dropAccount();
    if (running) await running.catch(() => undefined);
    try {
      // Also removes the device's sync epoch, which stops a run in flight in any other tab.
      if (eng) await eng.forget();
      else if (acct) await db.kv.bulkDelete(syncStateKeys(acct.id));
    } catch {
      // The wipe that follows clears these keys too.
    }
    if (acct) writeLastSynced(acct.id, null);
    if (acct || hasStoredSession()) await signOutHere(undefined);
    else handleSignedOut();
  } finally {
    erasing = false;
  }
}

/** Tear everything down (tests). The next startSync() starts fresh. */
export function stopSync(): void {
  generation++;
  for (const c of cleanups.splice(0)) c();
  authSub?.unsubscribe();
  authSub = null;
  dropAccount();
  client = null;
  clientLoading = null;
  bootPromise = null;
  running = null;
  runningEngine = null;
  again = false;
  rerun = false;
  followUp = false;
  offlineRetried = false;
  erasing = false;
  ownSignOut = null;
  status = initialStatus();
  for (const l of [...listeners]) l();
}
