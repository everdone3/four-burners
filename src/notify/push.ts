// This device's Web Push subscription. iOS web apps cannot schedule local notifications, so reminders come
// from the server (the notify Edge Function, on a pg_cron schedule) through Web Push. Each device opts in
// for itself; what to send and when (Settings.notify) syncs and is shared by every device.
//
// Requirements, all checked here: a build with the VAPID public key and sync configured, signed in to sync
// (the server sends to your account's devices), the service worker (production builds), and on iPhone and
// iPad the app installed to the Home Screen and opened from there (iOS 16.4+).
//
// The server learns your current time zone from this device: every open (at most every 30 minutes, or at
// once when the zone changed) refreshes the subscription, so reminders follow you when you travel.
import { useEffect, useSyncExternalStore } from 'react';
import { getClient, getSyncConfig } from '@/sync/client';
import { getSyncStatus, subscribeSyncStatus } from '@/sync/manager';
import { b64urlDecode } from '@/server/notify/webpush';

export type Availability =
  /** This build has no VAPID key or no sync configuration. */
  | 'unconfigured'
  /** iPhone or iPad Safari tab: add to Home Screen first. */
  | 'needsInstall'
  /** No push in this browser, or no service worker (dev builds). */
  | 'unsupported'
  | 'signedOut'
  /** Notifications blocked for the app in system settings. */
  | 'denied'
  | 'ready';

/** What the server last recorded for this device's subscription. */
export interface ServerStatus {
  lastSentAt?: string;
  lastError?: string;
  lastErrorAt?: string;
  /** The push service dropped this subscription; it must be renewed. */
  gone: boolean;
}

export interface PushDeviceState {
  availability: Availability;
  /** Subscribed in this browser, with permission. */
  subscribed: boolean;
  endpoint?: string;
  server?: ServerStatus;
  /** True until the first check finishes. */
  checking: boolean;
}

/** Everything the browser and the server provide, injectable for tests. */
export interface PushEnv {
  vapidKey: string | null;
  syncConfigured: boolean;
  signedIn(): boolean;
  /** The service worker registration, or undefined when there is none (dev builds, unsupported browsers). */
  registration(): Promise<Pick<ServiceWorkerRegistration, 'pushManager'> | undefined>;
  /** 'unsupported' when the browser has no Notification or PushManager. */
  permission(): NotificationPermission | 'unsupported';
  requestPermission(): Promise<NotificationPermission>;
  /** Safari on iPhone or iPad, not opened from the Home Screen. */
  isIosBrowserTab(): boolean;
  rpc(fn: 'push_subscribe' | 'push_unsubscribe', args: Record<string, unknown>): Promise<unknown>;
  /** POST to the notify function as the signed-in user. Resolves with its JSON body, rejects with a message. */
  invokeNotify(body: Record<string, unknown>): Promise<unknown>;
  timeZone(): string;
  device(): string;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  now(): number;
}

/** The last refresh sent to the server, so app opens do not call it every time. */
const BEAT_KEY = 'fb-push-beat';
export const BEAT_INTERVAL_MS = 30 * 60_000;

interface Beat {
  at: number;
  tz: string;
  endpoint: string;
}

function readBeat(env: PushEnv): Beat | null {
  try {
    const b = JSON.parse(env.storage?.getItem(BEAT_KEY) ?? 'null') as Beat | null;
    return b && typeof b.at === 'number' ? b : null;
  } catch {
    return null;
  }
}

function writeBeat(env: PushEnv, b: Beat | null) {
  try {
    if (b) env.storage?.setItem(BEAT_KEY, JSON.stringify(b));
    else env.storage?.removeItem(BEAT_KEY);
  } catch {
    // storage unavailable: the next open refreshes again, which is harmless
  }
}

function parseStatus(raw: unknown): ServerStatus {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  return { lastSentAt: str(r.last_sent_at), lastError: str(r.last_error), lastErrorAt: str(r.last_error_at), gone: r.gone === true };
}

function sameKey(sub: PushSubscription, vapidKey: string): boolean {
  const key = sub.options?.applicationServerKey;
  if (!key) return true; // not reported (older Safari): assume it matches
  const a = new Uint8Array(key);
  const b = b64urlDecode(vapidKey);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function keysOf(sub: PushSubscription): { p256dh: string; auth: string } | null {
  const j = sub.toJSON() as { keys?: { p256dh?: string; auth?: string } };
  return j.keys?.p256dh && j.keys.auth ? { p256dh: j.keys.p256dh, auth: j.keys.auth } : null;
}

async function save(env: PushEnv, sub: PushSubscription): Promise<ServerStatus> {
  const keys = keysOf(sub);
  if (!keys) throw new Error('The subscription has no keys.');
  const tz = env.timeZone();
  const status = parseStatus(
    await env.rpc('push_subscribe', { p_endpoint: sub.endpoint, p_p256dh: keys.p256dh, p_auth: keys.auth, p_device: env.device(), p_time_zone: tz }),
  );
  writeBeat(env, { at: env.now(), tz, endpoint: sub.endpoint });
  return status;
}

async function subscribeFresh(env: PushEnv, reg: Pick<ServiceWorkerRegistration, 'pushManager'>): Promise<PushSubscription> {
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlDecode(env.vapidKey!) });
}

/** What this device can do right now (no server call). */
export async function availability(env: PushEnv): Promise<{ availability: Availability; reg?: Pick<ServiceWorkerRegistration, 'pushManager'> }> {
  if (!env.vapidKey || !env.syncConfigured) return { availability: 'unconfigured' };
  if (env.permission() === 'unsupported') return { availability: env.isIosBrowserTab() ? 'needsInstall' : 'unsupported' };
  const reg = await env.registration();
  if (!reg) return { availability: 'unsupported' };
  if (!env.signedIn()) return { availability: 'signedOut', reg };
  if (env.permission() === 'denied') return { availability: 'denied', reg };
  return { availability: 'ready', reg };
}

/**
 * Check this device, and refresh its subscription on the server when due (time zone, last seen). A
 * subscription the push service dropped, or one made with an older key, is renewed quietly when the
 * browser allows it; otherwise the state says so and Settings offers to turn it on again.
 */
export async function refreshDevice(env: PushEnv, opts: { force?: boolean } = {}): Promise<PushDeviceState> {
  const { availability: av, reg } = await availability(env);
  if (!reg) return { availability: av, subscribed: false, checking: false };
  let sub = await reg.pushManager.getSubscription();
  if (!sub || env.permission() !== 'granted' || av !== 'ready') {
    return { availability: av, subscribed: !!sub && env.permission() === 'granted', endpoint: sub?.endpoint, checking: false };
  }
  const beat = readBeat(env);
  const due =
    opts.force || !beat || beat.endpoint !== sub.endpoint || beat.tz !== env.timeZone() || env.now() - beat.at >= BEAT_INTERVAL_MS || !sameKey(sub, env.vapidKey!);
  if (!due) return { availability: av, subscribed: true, endpoint: sub.endpoint, checking: false };

  let server: ServerStatus | undefined;
  try {
    if (!sameKey(sub, env.vapidKey!)) throw new RenewError();
    server = await save(env, sub);
    if (server.gone) throw new RenewError();
  } catch (e) {
    if (!(e instanceof RenewError)) return { availability: av, subscribed: true, endpoint: sub.endpoint, checking: false };
    // Renew: drop the dead subscription and make a new one (permission is already granted).
    const old = sub.endpoint;
    try {
      await sub.unsubscribe().catch(() => false);
      sub = await subscribeFresh(env, reg);
      server = await save(env, sub);
      await env.rpc('push_unsubscribe', { p_endpoint: old }).catch(() => undefined);
    } catch {
      return { availability: av, subscribed: false, server: { gone: true }, checking: false };
    }
  }
  return { availability: av, subscribed: true, endpoint: sub.endpoint, server, checking: false };
}

class RenewError extends Error {}

export type EnableResult = 'ok' | 'denied' | 'unavailable' | 'failed';

/** Turn notifications on for this device. Call first thing in a tap: iOS only asks for permission from one. */
export async function enableDevice(env: PushEnv): Promise<{ result: EnableResult; state?: PushDeviceState }> {
  if (env.permission() === 'unsupported' || !env.vapidKey) return { result: 'unavailable' };
  let permission: NotificationPermission;
  try {
    permission = env.permission() === 'granted' ? 'granted' : await env.requestPermission();
  } catch {
    return { result: 'failed' };
  }
  if (permission !== 'granted') return { result: 'denied' };
  const { availability: av, reg } = await availability(env);
  if (av !== 'ready' || !reg) return { result: 'unavailable' };
  try {
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub, env.vapidKey)) {
      await sub.unsubscribe().catch(() => false);
      sub = null;
    }
    sub ??= await subscribeFresh(env, reg);
    let server = await save(env, sub);
    if (server.gone) {
      await sub.unsubscribe().catch(() => false);
      sub = await subscribeFresh(env, reg);
      server = await save(env, sub);
    }
    return { result: 'ok', state: { availability: 'ready', subscribed: true, endpoint: sub.endpoint, server, checking: false } };
  } catch {
    return { result: 'failed' };
  }
}

/** Turn notifications off for this device: the server forgets it, and the browser drops the subscription. */
export async function disableDevice(env: PushEnv): Promise<void> {
  const reg = await env.registration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  // If the server can't be reached, unsubscribing still stops delivery: the next send gets "gone" and the
  // server stops using it.
  await env.rpc('push_unsubscribe', { p_endpoint: sub.endpoint }).catch(() => undefined);
  await sub.unsubscribe().catch(() => false);
  writeBeat(env, null);
}

export type TestResult = { ok: true } | { ok: false; message: string };

/** Ask the server to send a test notification to this device. */
export async function sendTest(env: PushEnv): Promise<TestResult> {
  const reg = await env.registration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return { ok: false, message: 'Turn notifications on first.' };
  try {
    const out = (await env.invokeNotify({ action: 'test', endpoint: sub.endpoint })) as { ok?: boolean; status?: number } | null;
    if (out?.ok) return { ok: true };
    return { ok: false, message: testFailure(out?.status) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    if (/not subscribed/i.test(msg)) return { ok: false, message: 'The server lost this device. Turn notifications off and on again.' };
    if (/missing secrets/i.test(msg)) return { ok: false, message: 'The notify function is missing its secrets. See README > Notifications.' };
    return { ok: false, message: "Couldn't reach the notification server. Check your connection and that the notify function is deployed." };
  }
}

/** Plain words for a push service refusal. */
export function testFailure(status: number | undefined): string {
  if (status === 404 || status === 410) return 'This device stopped accepting notifications. Turn them off and on again.';
  if (status === 401 || status === 403) return "The push service rejected the server's key. Check VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.";
  return "The push service didn't accept the test. Try again in a minute.";
}

// ---------- The browser ----------

/** "iPhone", "iPad", "Mac" or "Browser". */
export function detectDevice(): string {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const ua = nav?.userAgent ?? '';
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && (nav?.maxTouchPoints ?? 0) > 1)) return 'iPad';
  if (/Macintosh/.test(ua)) return 'Mac';
  return 'Browser';
}

function standalone(): boolean {
  return (navigator as { standalone?: boolean }).standalone === true || !!globalThis.matchMedia?.('(display-mode: standalone)').matches;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Error message from a supabase-js functions.invoke failure (the function's own {error} when it sent one). */
async function invokeError(error: unknown): Promise<string> {
  const ctx = (error as { context?: unknown }).context;
  if (ctx instanceof Response) {
    const body = (await ctx.json().catch(() => null)) as { error?: unknown } | null;
    if (typeof body?.error === 'string') return body.error;
  }
  return error instanceof Error ? error.message : 'Request failed';
}

export function browserPushEnv(): PushEnv {
  const vapid = (import.meta.env as unknown as { VITE_VAPID_PUBLIC_KEY?: string }).VITE_VAPID_PUBLIC_KEY?.trim() || null;
  return {
    vapidKey: vapid,
    syncConfigured: getSyncConfig() !== null,
    signedIn: () => {
      const s = getSyncStatus().state;
      return s !== 'signedOut' && s !== 'unconfigured';
    },
    async registration() {
      if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return undefined;
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg || !import.meta.env.PROD) return reg;
      // First launch: the worker may still be registering.
      return Promise.race([navigator.serviceWorker.ready, new Promise<undefined>((r) => setTimeout(() => r(undefined), 5_000))]);
    },
    permission: () =>
      typeof Notification === 'undefined' || typeof PushManager === 'undefined' ? 'unsupported' : Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    isIosBrowserTab: () => {
      const d = detectDevice();
      return (d === 'iPhone' || d === 'iPad') && !standalone();
    },
    async rpc(fn, args) {
      const { data, error } = await (await getClient()).rpc(fn, args);
      if (error) throw new Error(error.message);
      return data;
    },
    async invokeNotify(body) {
      const { data, error } = await (await getClient()).functions.invoke('notify', { body });
      if (error) throw new Error(await invokeError(error));
      return data;
    },
    timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    device: detectDevice,
    storage: storage(),
    now: () => Date.now(),
  };
}

// ---------- Live state for the UI ----------

let state: PushDeviceState = { availability: 'unsupported', subscribed: false, checking: true };
const listeners = new Set<() => void>();
let env: PushEnv | null = null;
let inflight: Promise<PushDeviceState> | null = null;

function setState(next: PushDeviceState) {
  state = next;
  listeners.forEach((l) => l());
}

function getEnv(): PushEnv {
  return (env ??= browserPushEnv());
}

export function getPushState(): PushDeviceState {
  return state;
}

/** Re-check this device (and refresh the server's copy when due). Concurrent calls share one run. */
export function checkPush(opts: { force?: boolean } = {}): Promise<PushDeviceState> {
  inflight ??= refreshDevice(getEnv(), opts)
    .catch((): PushDeviceState => ({ ...state, checking: false }))
    .then((s) => {
      setState(s);
      return s;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export async function turnOnPush(): Promise<EnableResult> {
  const out = await enableDevice(getEnv());
  if (out.state) setState(out.state);
  else void checkPush();
  return out.result;
}

export async function turnOffPush(): Promise<void> {
  await disableDevice(getEnv());
  await checkPush();
}

export const sendTestPush = () => sendTest(getEnv());

export function usePushState(): PushDeviceState {
  useEffect(() => {
    void checkPush({ force: true });
  }, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => state,
    () => state,
  );
}

let started = false;

/**
 * At launch: keep this device's subscription fresh (time zone, last seen) on each return to the app, and
 * when sync signs in. Also opens the screen a tapped notification points to, if the app was already open.
 */
export function startPush(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  void checkPush();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkPush();
  });
  let wasSignedIn = getEnv().signedIn();
  subscribeSyncStatus(() => {
    const now = getEnv().signedIn();
    // A sign-in (maybe a different account) re-registers this device with the server right away.
    if (now !== wasSignedIn) void checkPush({ force: now });
    wasSignedIn = now;
  });
  navigator.serviceWorker?.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { type?: string; hash?: unknown } | null;
    if (d?.type === 'fb-open' && typeof d.hash === 'string' && d.hash.startsWith('#/')) location.hash = d.hash;
  });
}
