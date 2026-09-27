// App updates through the service worker (src/sw.ts). A new version installs in the background and waits.
// If nothing is in progress it takes over right away (the reload keeps the #/ route); otherwise a small
// pill offers a reload, and the update applies by itself the next time the app goes to the background. The same
// goes for a second tab when another one switches versions: it reloads at once only if nothing is in progress.
// Never automatically, visible or hidden, while a reload would lose something: text typed into any field
// (sheets keep it only in memory), or a hold from busy.ts (share sheet, file picker, restore). When the
// last hold is released, or on the next hide with nothing typed, it tries again. A tap on Reload always reloads.
// iOS resumes Home Screen apps without a navigation, so the browser never looks for updates on its own:
// check on resume, on back/forward cache restores, when the network returns, and hourly.
// Production builds only: in dev and in tests the service worker is never registered and all of this is inert.
//
// The app lock (src/lock; an access gate, not encryption: see src/lock/webauthnLocal.ts): every reload
// the app starts goes through reloadApp(), which marks it trusted so the lock follows the idle rule instead
// of locking you out mid-use. The lock screen itself counts as a safe point for a silent update: a reload
// while locked is not marked, so it comes back locked (and a Face ID prompt in flight holds busy.ts). The
// recovery sheet is a dialog with a code field, so it is not a safe point, like any other sheet.
import { useEffect, useSyncExternalStore } from 'react';
import { getLockState, markTrustedReload } from '@/lock/controller';
import { isBusy, onIdle } from './busy';

declare global {
  /** Short commit hash of this build ('dev' locally). Set in vite.config.ts. */
  const __APP_VERSION__: string;
}
export const APP_VERSION = __APP_VERSION__;

/** none: running the latest known version. ready: an update is waiting (or took over from another tab). applying: reloading into it. */
export type UpdateStatus = 'none' | 'ready' | 'applying';
export type CheckResult = 'current' | 'ready' | 'offline' | 'failed' | 'unavailable';

const HOUR = 60 * 60_000;
const MIN_GAP = 60_000; // automatic checks at most once a minute (quick app switches)
const AFTER_BUSY = 2_500; // after a share or restore, leave its result on screen this long before reloading
const ANNOUNCE_KEY = 'fb-updated-from';

let status: UpdateStatus = 'none';
let registration: ServiceWorkerRegistration | undefined;
let applyFn: (() => Promise<void>) | undefined;
let safePoint: () => boolean = () => false;
let started = false;
let lastCheck = 0;
let manualCheckAt = 0;
// The new version already controls this page (another tab switched, or the handover finished): only a reload is left.
let reloadPending = false;
// The update being applied was started by the app, not by a tap: the reload still waits for a safe moment.
let autoApplying = false;
const listeners = new Set<() => void>();

function setStatus(next: UpdateStatus) {
  if (status === next) return;
  status = next;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => void listeners.delete(l);
}

export function useUpdateStatus(): UpdateStatus {
  return useSyncExternalStore(subscribe, () => status, () => status);
}

// Screens where a reload would interrupt you: the guided flows (same list as FLOWS in router.ts) and the reel.
const BUSY_SCREENS = new Set(['review', 'close', 'setup', 'checkin', 'onboarding', 'about', 'reel']);
const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file', 'image', 'hidden']);

/**
 * Text typed into a field anywhere on the page: sheets and forms keep it only in memory, so a reload loses it.
 * Read-only and disabled fields do not count.
 */
function hasTypedText(): boolean {
  return Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')).some(
    (el) => !el.disabled && !el.readOnly && !NON_TEXT_INPUTS.has(el.type) && el.value.trim() !== '',
  );
}

/** A reload would lose something even with the app in the background: a hold (busy.ts) or typed text. */
export function hasUnsavedWork(): boolean {
  return isBusy() || hasTypedText();
}

/** True when reloading now would not interrupt anything: no guided flow, no open sheet, no typing, nothing held. */
export function isUpdateSafePoint(): boolean {
  if (hasUnsavedWork()) return false;
  const screen = location.hash.replace(/^#\/?/, '').split('/')[0];
  if (BUSY_SCREENS.has(screen)) return false;
  if (document.querySelector('[role="dialog"]')) return false; // Log sheet, editors, note prompt
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable)) return false;
  if (el instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(el.type)) return false;
  return true;
}

/**
 * Every reload the app starts itself (an update here, a database upgrade in main.tsx). Marked trusted
 * only while unlocked: a marked reload may come back unlocked (within the idle time), so a reload from the
 * lock screen (after "Lock now", say) stays unmarked and comes back locked. With the lock off there is
 * nothing to skip, so nothing is marked. The lock can never block a reload.
 */
export function reloadApp() {
  try {
    if (getLockState().phase === 'unlocked') markTrustedReload();
  } catch {
    // The lock failed: reload unmarked, which comes back locked if a lock is set up.
  }
  location.reload();
}

/**
 * Switch to the waiting version now. The page reloads once the new service worker takes over.
 * auto: the app started it, not a tap, so the reload itself also waits until nothing would be lost.
 */
export function applyUpdate(announce = true, auto = false) {
  if (status === 'applying' || (!applyFn && !reloadPending)) return;
  autoApplying = auto;
  if (announce) {
    try {
      sessionStorage.setItem(ANNOUNCE_KEY, APP_VERSION);
    } catch {
      // storage unavailable
    }
  }
  setStatus('applying');
  if (reloadPending) {
    reloadApp();
    return;
  }
  void applyFn?.();
  // Normally the page is gone long before this. If the handover stalled, offer the Reload button again
  // (never a blind reload: that could loop).
  setTimeout(() => {
    if (status === 'applying') setStatus('ready');
  }, 15_000);
}

/** After a reload into a new version the user asked for: the version they came from, once. */
export function takeUpdateAnnouncement(): string | null {
  try {
    const from = sessionStorage.getItem(ANNOUNCE_KEY);
    sessionStorage.removeItem(ANNOUNCE_KEY);
    return from && from !== APP_VERSION ? from : null;
  } catch {
    return null;
  }
}

/** Manual check (Settings). Resolves once any new version has finished downloading. */
export async function checkForUpdates(): Promise<CheckResult> {
  if (status !== 'none') return 'ready';
  const reg = registration;
  if (!reg) return 'unavailable';
  if (!navigator.onLine) return 'offline';
  manualCheckAt = lastCheck = Date.now();
  try {
    await reg.update();
  } catch {
    return navigator.onLine ? 'failed' : 'offline';
  }
  const sw = reg.installing ?? reg.waiting;
  if (sw) await settled(sw);
  return reg.waiting ? 'ready' : 'current';
}

function settled(sw: ServiceWorker): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      sw.removeEventListener('statechange', onChange);
      clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      if (sw.state !== 'installing') done();
    };
    const timer = setTimeout(done, 60_000);
    sw.addEventListener('statechange', onChange);
    onChange();
  });
}

/** Nothing would be lost (hidden), or nothing would be interrupted either (visible). */
function canApplyNow(): boolean {
  if (hasUnsavedWork()) return false;
  return document.visibilityState === 'hidden' || safePoint();
}

/** Apply a waiting update if this is a good moment; otherwise it stays 'ready' for the next one. */
function applyWhenSafe(announce = false) {
  if (status === 'ready' && canApplyNow()) applyUpdate(announce, true);
}

// A new version finished installing and is waiting.
function onUpdateWaiting() {
  if (status === 'none') setStatus('ready');
  // Found while in the background, or nothing in progress: take it now. A tap on "Check for updates"
  // earns a short confirmation after the reload; automatic updates stay silent.
  applyWhenSafe(Date.now() - manualCheckAt < 2 * 60_000);
}

// A new service worker took control of this page. The plugin's own handler would reload unconditionally, and
// only on pages that loaded with a worker already in charge; this one decides for every page.
function onControllerChange() {
  reloadPending = true;
  // You tapped Reload, or nothing would be lost or interrupted: reload into the new version now.
  if ((status === 'applying' && !autoApplying) || canApplyNow()) {
    reloadApp();
    return;
  }
  // Another tab switched versions, or something started since this tab began applying (typing, a share
  // sheet): the pill, then a reload on the next safe moment.
  setStatus('ready');
}

function watchForUpdates(reg: ServiceWorkerRegistration) {
  registration = reg;
  lastCheck = Date.now(); // registering just checked
  const check = () => {
    if (reg.installing || !navigator.onLine || Date.now() - lastCheck < MIN_GAP) return;
    lastCheck = Date.now();
    reg.update().catch(() => {});
  };
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) check();
  });
  window.addEventListener('online', check);
  setInterval(check, HOUR);
  return check;
}

type RegisterSW = typeof import('virtual:pwa-register').registerSW;

/** Wires the update flow to the plugin's registerSW. The app goes through useAppUpdate; exported for tests. */
export function connectUpdates(registerSW: RegisterSW, isSafePoint?: () => boolean) {
  if (isSafePoint) safePoint = isSafePoint;
  const sw = navigator.serviceWorker;
  // A page that opened without a worker gets one on first install (clientsClaim). Same code, nothing to reload.
  let hadController = !!sw.controller;
  sw.addEventListener('controllerchange', () => {
    if (!sw.controller) return;
    if (!hadController && status === 'none') {
      hadController = true;
      return;
    }
    hadController = true;
    onControllerChange();
  });
  let check: (() => void) | undefined;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check?.();
    else applyWhenSafe(); // deferred update: apply as the app leaves the screen, unless something typed would be lost
  });
  // A share sheet, picker or restore just ended. In the background take the update now; on screen, first
  // leave its result ("Backup saved") up for a moment.
  onIdle(() => {
    if (document.visibilityState === 'hidden') applyWhenSafe();
    else setTimeout(() => applyWhenSafe(), AFTER_BUSY);
  });
  const update = registerSW({
    immediate: true,
    onNeedRefresh: onUpdateWaiting,
    onNeedReload() {}, // handled by onControllerChange
    onRegisteredSW(_url, reg) {
      if (reg) check = watchForUpdates(reg);
    },
  });
  applyFn = () => update(true);
}

function start() {
  if (started || !import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  started = true;
  // Loaded lazily and only in production, so dev and tests never touch the plugin's virtual module.
  import('virtual:pwa-register')
    .then(({ registerSW }) => connectUpdates(registerSW))
    .catch(() => {});
}

/** Mount once (App). isSafePoint decides between a silent update and the pill. */
export function useAppUpdate(isSafePoint: () => boolean): UpdateStatus {
  useEffect(() => {
    safePoint = isSafePoint;
  }, [isSafePoint]);
  useEffect(start, []);
  return useUpdateStatus();
}
