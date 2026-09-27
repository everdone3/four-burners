// The app lock controller: a framework-agnostic state machine for the Face ID lock (a WebAuthn platform
// passkey used as a local access gate, NOT encryption) and the privacy shield.
//
// THE FACE ID LOCK IS AN ACCESS GATE, NOT ENCRYPTION. The data stays unencrypted in IndexedDB. The lock keeps
// someone holding your unlocked device from casually opening the app. It does not stop anyone who can run
// script in this origin, attach Web Inspector, or read the device's storage. Full statement: webauthnLocal.ts.
//
// Files: passkey.ts runs the WebAuthn ceremonies, webauthnLocal.ts verifies them, store.ts owns storage,
// useLock.ts is the React binding. index.html and index.css hold the pre-paint gate and the shield styles.
//
// CONTRACT (implemented exactly; the notes marked "Also:" are details the implementation adds):
//
// Storage (all device-local, never synced or backed up):
// - localStorage 'fb-lock'           LockRecord JSON (present = enrolled on this device)
// - localStorage 'fb-lock-user-id'   32 random bytes (base64url), kept even when the lock is turned off,
//                                    reused when re-enabling, so this device never overwrites another
//                                    device's synced passkey (same rp.id + user.id overwrites).
// - localStorage 'fb-lock-idle'      IdleMinutes (default DEFAULT_IDLE_MINUTES)
// - localStorage 'fb-lock-active'    ms timestamp of the last interaction / last time the app was hidden
//                                    while unlocked. Also: removed whenever the app locks or starts
//                                    locked (a cold start keeps no stamp from the last session), so a
//                                    trusted reload of a locked app can never read a fresh stamp and open
//                                    it. Also: a return to the screen that stays open counts as activity.
// - sessionStorage 'fb-lock-reload'  set by markTrustedReload() right before an app-initiated reload
// - localStorage 'fb-lock-log'       ring buffer (last 60) of LockLogEntry for on-device diagnostics
// A record whose rpId !== location.hostname counts as not enrolled here (state.otherHost = true).
// "Enrolled here" is exactly the inline script's test (v === 1, rpId === hostname); a damaged record for
// this host still counts as enrolled and fails closed (unlock fails, recovery takes over).
//
// DOM (the UI renders the app in #app-layer and the lock screen in #lock-layer, both inside #root):
// - <html data-lock="locked"> while locked or unlocking; removed when unlocked or off. index.css hides
//   #app-layer (and anything portaled straight into <body>) while it is set.
// - <html data-shield> while the page is hidden or coming back from hidden; index.css blurs and dims
//   the app with it (instantly on, short fade off). Not drawn while locked.
//
// Launch: index.html runs an inline script before the bundle: if a valid record for this host exists it
// sets <html data-lock="locked">, so no app content can paint before the lock screen. startLock() then
// starts 'locked' with coldStart = true. EXCEPTION: a reload marked by markTrustedReload() within the
// last 30 s (an app update or a database upgrade reload) follows the idle rule instead, so an update
// never locks you out mid-use. A normal launch is always locked (SPEC: "Face ID lock on open").
// Also: a page that starts hidden starts with the shield on, and with idleMinutes 0 a trusted reload that
// comes back hidden (you left while it loaded) starts locked.
//
// Shield (SPEC: blur on visibilitychange/pagehide). On document 'visibilitychange' to hidden and on
// 'pagehide', synchronously (never in requestAnimationFrame): set <html data-shield> (CSS blurs and dims
// the app), abort any Face ID prompt in flight, record 'fb-lock-active' = now, lock immediately when
// idleMinutes is 0 or idle is already exceeded, and stop the foreground idle timer. iOS takes the app
// switcher snapshot BEFORE any DOM event runs (WebKit freezes the layer tree first), so the snapshot
// still shows content; the shield guarantees the first frame after returning is covered. Never react to
// window 'blur' (it fires for system sheets and on iPad multitasking). On 'visibilitychange' to visible
// and 'pageshow' with persisted: if locked or idle exceeded, lock (keep the shield, show the lock screen,
// try one automatic unlock); otherwise clear the shield (a short fade is fine) and restart the timer.
// Also: the shield goes up even when the lock is off (the SPEC's blur does not depend on Face ID). When
// markTrustedReload() ran while visible and unlocked, the hide events of that reload's own unload (within
// 5 s) do not count as leaving the screen for idleMinutes 0; a reload marked while hidden still locks.
//
// Idle: interaction = trusted pointerdown, keydown, wheel, input (capture phase). Check then record: if
// the deadline already passed, lock instead (and swallow that event, plus the click that follows it).
// Foreground check every 10 s while visible. idleMinutes 0 still locks after 1 minute idle in the
// foreground. A negative time delta (clock moved back) fails closed (locks). Also: interaction writes to
// storage at most once a second (the in-memory stamp is exact). A foreground idle lock or "Lock now" makes
// no automatic attempt; the lock screen's button does it.
//
// Unlock (WebAuthn get): rpId = record.rpId, fresh 32-byte challenge, userVerification 'required',
// allowCredentials [{ type: 'public-key', id, transports: ['internal'] }] (hides QR / other device /
// security keys), an AbortController plus an own 120 s watchdog (Safari ignores options.timeout). One
// ceremony at a time: a new one aborts the old. Verify locally with webauthnLocal.verifyAssertion (UV
// required; signCount not enforced). Hold the update registry busy (src/ui/busy.ts) while a prompt is up.
// NotAllowedError = cancelled or failed (indistinguishable): stay locked, failures++, never auto-retry.
// "The document is not focused." (NotAllowedError) or AbortError: stay locked quietly, result
// 'not-focused' / 'cancelled' without counting a failure. Automatic attempts: at most one per unlock
// opportunity (cold start, or a resume that needed unlocking), only when visible and document.hasFocus()
// (else wait up to 1.5 s for window 'focus', then give up and let the button do it). Never call
// PublicKeyCredential.signal* (WebKit bugs delete other passkeys).
// Also, results and messages: NotAllowedError -> 'cancelled' + failures++; a credential that fails local
// verification, our 120 s watchdog, or any other error (SecurityError, NotSupportedError...) -> 'failed' +
// failures++ (a hung prompt should lead to "Can't unlock?", not loop quietly); not focused ->
// 'not-focused'; aborted by hide / a newer attempt / the browser -> 'cancelled' (quiet). Each failure sets
// state.message. The controller makes the automatic attempts itself (the lock screen never needs to pass
// auto); when focus arrives late it waits 300 ms more so the tap that brought focus can start its own
// ceremony instead of racing a second one, and it skips an automatic attempt within 3 s of the previous
// ceremony (rapid app switching, WebKit bug 291258). A tap (unlock()) cancels a pending automatic attempt.
// Also, "never auto-retry" read strictly: once a try has counted as a failure on this lock screen
// (state.failures > 0), a resume makes no automatic attempt either; the button does it. This keeps a deleted passkey or a
// recovery trip to Mail for the email code from popping a system sheet on every return, and stays clear
// of WebKit's progressive rate limiter. Any lock (idle, hide, "Lock now") aborts a prompt in flight,
// including the one Disable is showing.
//
// Enable: create() with rp { id: location.hostname, name: 'Four Burners' }, user { id: fb-lock-user-id,
// name = displayName = label }, pubKeyCredParams [-7, -257], authenticatorSelection { authenticatorAttachment:
// 'platform', residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
// attestation 'none'; verify with webauthnLocal (registration), take the key from getPublicKey() with
// the CBOR fallback; then immediately a test get(); save the record ONLY after the test unlock passes.
// Disable: requires a successful unlock ceremony first; then delete the record (keep fb-lock-user-id).
// Also: both return 'cancelled' for NotAllowedError or an abort, 'failed' otherwise. Busy is held for the
// whole enable flow. Enable waits up to 1.5 s for focus before the test get(): create() has no focus
// check but get() does, and the passkey sheet may leave the page unfocused. When the test get() fails
// only for lack of focus (or is aborted quietly), the new, verified credential is kept in memory (never
// saved) for 5 minutes, and the next enableLock() (the user's "Try again" tap, which brings focus) runs
// just the test get() for it instead of a second create(). A lock, reset or recovery during enable
// cancels it.
//
// Recovery (passkey deleted, or Face ID keeps failing): the lock screen offers a fresh email-code
// sign-in (sync) or "Reset this device". completeRecovery() unlocks and turns the lock off (the passkey
// may be gone; the user can turn it on again to make a new one). resetLock() removes the record (used by
// recovery and by erase). Also: resetLock() also turns the lock off in memory, so call it only after the
// data is gone (erase) or right before a reload.
//
// Diagnostics: start, hidden/pagehide, visible/pageshow, every lock with its reason, unlock start and
// result (error name and message), enable/disable results, focus waits, availability, trusted reloads.
import { holdBusy } from '../ui/busy';
import { abortCeremony, createCredential, describeFailure, getAssertion, isCeremonyActive, type CeremonyFailure } from './passkey';
import * as store from './store';
import {
  DEFAULT_IDLE_MINUTES,
  IDLE_CHOICES,
  type DisableResult,
  type EnableResult,
  type IdleMinutes,
  type LockDevice,
  type LockLogEntry,
  type LockRecord,
  type LockState,
  type UnlockResult,
} from './types';

const TRUSTED_RELOAD_MS = 30_000;
const RELOAD_UNLOAD_MS = 5_000;
const IDLE_CHECK_MS = 10_000;
const FOREGROUND_IDLE_MIN_MS = 60_000;
const FOCUS_WAIT_MS = 1_500;
const FOCUS_GRACE_MS = 300;
const AUTO_MIN_GAP_MS = 3_000;
const ACTIVE_WRITE_MS = 1_000;
const SWALLOW_CLICK_MS = 1_000;
const PENDING_ENROLL_MS = 5 * 60_000;
const INTERACTIONS = ['pointerdown', 'keydown', 'wheel', 'input'] as const;

const MESSAGES = {
  notAllowed: "Unlock didn't go through. Try again.",
  notFocused: 'Tap Unlock to continue.',
  timeout: 'The unlock prompt stopped responding. Try again.',
  invalid: "This passkey couldn't be verified. Try again.",
  error: "Unlock isn't available right now. Try again.",
} as const;

// ---------- State ----------

let state: LockState = {
  phase: 'off',
  idleMinutes: DEFAULT_IDLE_MINUTES,
  coldStart: false,
  failures: 0,
  device: 'other',
  otherHost: false,
  available: 'unknown',
  label: 'Four Burners lock',
};
const listeners = new Set<() => void>();
let started = false;
let record: LockRecord | null = null;
/** In-memory copy of 'fb-lock-active' (exact; storage is written at most once a second). */
let lastActive: number | null = null;
let lastActiveWrite = 0;
let idleTimer: ReturnType<typeof setInterval> | undefined;
/** Bumped by anything that takes over the lock state, so a stale unlock result is ignored. */
let unlockSeq = 0;
let autoOpportunity = false;
let autoRunning = false;
let cancelAutoWait: (() => void) | null = null;
let lastCeremonyAt = 0;
let setupRunning = false;
let reloadMarkedVisibleAt = 0;
let swallowClicksUntil = 0;
/** A created and verified credential whose test unlock could not run (no focus). Never saved as is. */
let pendingEnroll: { record: LockRecord; at: number } | null = null;

function setState(patch: Partial<LockState>) {
  const keys = Object.keys(patch) as (keyof LockState)[];
  if (keys.every((k) => state[k] === patch[k])) return;
  state = { ...state, ...patch };
  notify();
}

function notify() {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      // a broken listener must not stop the others
    }
  }
}

function log(event: string, detail?: string) {
  store.appendLog(event, detail);
}

// ---------- Environment ----------

function detectDevice(): LockDevice {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const ua = nav?.userAgent ?? '';
  if (/iPhone|iPod/.test(ua)) return 'iphone';
  if (/iPad/.test(ua)) return 'ipad';
  // iPadOS asks for desktop sites by default and reports itself as a Mac, but with a touch screen.
  if (/Macintosh/.test(ua)) return (nav?.maxTouchPoints ?? 0) > 1 ? 'ipad' : 'mac';
  return 'other';
}

function labelFor(device: LockDevice): string {
  switch (device) {
    case 'iphone':
      return 'Four Burners lock · iPhone';
    case 'ipad':
      return 'Four Burners lock · iPad';
    case 'mac':
      return 'Four Burners lock · Mac';
    default:
      return 'Four Burners lock';
  }
}

function hostname(): string {
  return typeof location === 'undefined' ? '' : location.hostname;
}

function isVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

function hasFocus(): boolean {
  try {
    return typeof document === 'undefined' || typeof document.hasFocus !== 'function' || document.hasFocus();
  } catch {
    return true;
  }
}

function html(): HTMLElement | null {
  return typeof document === 'undefined' ? null : (document.documentElement ?? null);
}

function setLockAttr(on: boolean) {
  const el = html();
  if (!el) return;
  if (on) el.dataset.lock = 'locked';
  else delete el.dataset.lock;
}

function setShield(on: boolean) {
  const el = html();
  if (!el) return;
  if (on) el.dataset.shield = 'on';
  else delete el.dataset.shield;
}

/** Drops focus from a field in the now hidden app (closes the iOS keyboard; keys cannot reach it). */
function blurFocused() {
  try {
    const el = typeof document === 'undefined' ? null : (document.activeElement as { blur?: () => void } | null);
    el?.blur?.();
  } catch {
    // nothing focused
  }
}

function describeVisibility(): string {
  return `${isVisible() ? 'visible' : 'hidden'}, focus ${hasFocus() ? 'yes' : 'no'}`;
}

// ---------- Idle ----------

function idleLimitMs(): number {
  return Math.max(state.idleMinutes * 60_000, FOREGROUND_IDLE_MIN_MS);
}

/** Deadline passed, nothing recorded, or the clock moved back: all fail closed. */
function idleExceeded(now: number): boolean {
  if (lastActive === null) return true;
  const d = now - lastActive;
  return d < 0 || d >= idleLimitMs();
}

function idleDetail(now: number): string {
  if (lastActive === null) return 'no activity recorded';
  const d = now - lastActive;
  return d < 0 ? `clock moved back ${Math.round(-d / 1000)} s` : `idle ${Math.round(d / 1000)} s`;
}

function touch(now: number, force = false) {
  lastActive = now;
  if (force || now - lastActiveWrite >= ACTIVE_WRITE_MS || now < lastActiveWrite) {
    lastActiveWrite = now;
    store.writeActive(now);
  }
}

function startIdleTimer() {
  stopIdleTimer();
  if (state.phase !== 'unlocked' || !isVisible()) return;
  idleTimer = setInterval(() => {
    const now = Date.now();
    if (state.phase === 'unlocked' && isVisible() && idleExceeded(now)) lock('idle', `foreground timer, ${idleDetail(now)}`);
  }, IDLE_CHECK_MS);
}

function stopIdleTimer() {
  if (idleTimer !== undefined) clearInterval(idleTimer);
  idleTimer = undefined;
}

// ---------- Transitions ----------

function lock(reason: string, detail?: string) {
  if (!record) return;
  if (state.phase === 'locked') {
    setLockAttr(true);
    return;
  }
  unlockSeq++;
  // Any prompt: an unlock in flight, or the one Disable shows (it would only end in 'failed' behind the lock).
  abortCeremony('cancel');
  cancelPendingAuto();
  stopIdleTimer();
  lastActive = null;
  store.clearActive();
  setLockAttr(true);
  blurFocused();
  setState({ phase: 'locked', failures: 0, message: undefined });
  log('lock', detail ? `${reason}: ${detail}` : reason);
}

function applyUnlocked() {
  touch(Date.now(), true);
  setLockAttr(false);
  if (isVisible()) setShield(false);
  setState({ phase: 'unlocked', coldStart: false, failures: 0, message: undefined });
  startIdleTimer();
}

/** Lock off on this device (disable, recovery, reset). */
function applyOff() {
  unlockSeq++;
  abortCeremony('cancel');
  cancelPendingAuto();
  autoOpportunity = false;
  pendingEnroll = null;
  stopIdleTimer();
  record = null;
  store.removeRecord();
  lastActive = null;
  store.clearActive();
  setLockAttr(false);
  if (isVisible()) setShield(false);
  setState({ phase: 'off', coldStart: false, failures: 0, message: undefined, otherHost: false });
}

// ---------- Page lifecycle ----------

function onHidden(source: string) {
  setShield(true); // first, synchronously
  const aborted = abortCeremony('hidden');
  cancelPendingAuto();
  stopIdleTimer();
  const now = Date.now();
  let outcome = state.phase as string;
  if (state.phase === 'unlocking') {
    unlockSeq++;
    setState({ phase: 'locked' });
    outcome = 'locked (prompt closed)';
  } else if (state.phase === 'unlocked') {
    const reloadUnload = reloadMarkedVisibleAt > 0 && now - reloadMarkedVisibleAt >= 0 && now - reloadMarkedVisibleAt < RELOAD_UNLOAD_MS;
    if (idleExceeded(now)) {
      lock('idle', `on hide, ${idleDetail(now)}`);
      outcome = 'locked';
    } else if (state.idleMinutes === 0 && !reloadUnload) {
      lock('left the screen', 'idle setting 0');
      outcome = 'locked';
    } else {
      touch(now, true);
      outcome = reloadUnload ? 'unlocked (trusted reload)' : 'unlocked';
    }
  }
  log(source, `${outcome}${aborted ? ', prompt aborted' : ''}`);
}

function onShown(source: string) {
  if (!isVisible()) return;
  const now = Date.now();
  if (!record) {
    setShield(false);
    log(source, 'lock off');
    return;
  }
  if (state.phase === 'unlocked') {
    if (!idleExceeded(now)) {
      log(source, `unlocked, ${idleDetail(now)}`);
      // Coming back counts as activity (check, then record), so the app never locks a few seconds after
      // you reopened it just because the hide was near the idle limit.
      touch(now, true);
      setShield(false);
      startIdleTimer();
      return;
    }
    lock('idle', `on return, ${idleDetail(now)}`);
  }
  log(source, `${state.phase}, ${describeVisibility()}`);
  offerAuto('resume');
}

function onVisibilityChange() {
  if (document.visibilityState === 'hidden') onHidden('hidden');
  else onShown('visible');
}

function onPageHide(e: PageTransitionEvent) {
  onHidden(e.persisted ? 'pagehide (persisted)' : 'pagehide');
}

function onPageShow(e: PageTransitionEvent) {
  if (e.persisted) onShown('pageshow (persisted)');
  else log('pageshow', describeVisibility());
}

function onInteraction(e: Event) {
  if (!e.isTrusted || state.phase !== 'unlocked') return;
  const now = Date.now();
  if (idleExceeded(now)) {
    lock('idle', `on ${e.type}, ${idleDetail(now)}`);
    if (e.type !== 'wheel') e.preventDefault(); // wheel listens passively
    e.stopImmediatePropagation();
    if (e.type === 'pointerdown') swallowClicksUntil = now + SWALLOW_CLICK_MS;
    return;
  }
  touch(now);
}

/** The click that ends a swallowed pointerdown must not land on the lock screen or the app. */
function onClickCapture(e: Event) {
  if (swallowClicksUntil === 0) return;
  const now = Date.now();
  const swallow = now < swallowClicksUntil && now >= swallowClicksUntil - SWALLOW_CLICK_MS;
  swallowClicksUntil = 0;
  if (!swallow) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}

function install() {
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
  for (const type of INTERACTIONS) window.addEventListener(type, onInteraction, { capture: true, passive: type === 'wheel' });
  window.addEventListener('click', onClickCapture, { capture: true });
}

function checkAvailability() {
  const PKC = (globalThis as { PublicKeyCredential?: { isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean> } })
    .PublicKeyCredential;
  if (!PKC || typeof navigator === 'undefined' || !navigator.credentials) {
    setState({ available: 'no' });
    log('available', 'no WebAuthn here');
    return;
  }
  if (typeof PKC.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') return;
  let check: Promise<boolean>;
  try {
    check = PKC.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch (e) {
    log('available', `error: ${String(e)}`);
    return;
  }
  Promise.resolve(check).then(
    (ok) => {
      setState({ available: ok ? 'yes' : 'no' });
      log('available', ok ? 'yes' : 'no');
    },
    (e: unknown) => log('available', `error: ${String(e)}`),
  );
}

// ---------- Automatic attempts ----------

function cancelPendingAuto() {
  const c = cancelAutoWait;
  cancelAutoWait = null;
  c?.();
}

/** Resolves true when the document has focus, false after `ms`, on hide, or when cancelled. */
function waitForFocus(ms: number): Promise<boolean> {
  if (hasFocus()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
      if (cancelAutoWait === cancel) cancelAutoWait = null;
      resolve(v);
    };
    const onFocus = () => finish(true);
    const cancel = () => finish(false);
    const timer = setTimeout(() => finish(hasFocus()), ms);
    window.addEventListener('focus', onFocus);
    cancelAutoWait = cancel;
  });
}

/** Resolves true after `ms`, false when cancelled (a tap took over, or the page was hidden). */
function grace(ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (cancelAutoWait === cancel) cancelAutoWait = null;
      resolve(true);
    }, ms);
    const cancel = () => {
      clearTimeout(timer);
      resolve(false);
    };
    cancelAutoWait = cancel;
  });
}

function offerAuto(reason: string) {
  if (!record || (state.phase !== 'locked' && state.phase !== 'unlocking')) return;
  if (autoRunning || isCeremonyActive()) {
    log('auto skipped', `${reason}, already running`);
    return;
  }
  // Never an automatic retry: after a counted failure the button does it (see the header).
  if (state.failures > 0) {
    log('auto skipped', `${reason}, after ${state.failures} failed ${state.failures === 1 ? 'try' : 'tries'}`);
    return;
  }
  // The lock screen's recovery sheet is open (for example, coming back from Mail with the code): a Face ID
  // prompt over the code field would be in the way, and a failure there would count.
  if (recoveryOpen()) {
    log('auto skipped', `${reason}, recovery open`);
    return;
  }
  const since = Date.now() - lastCeremonyAt;
  if (lastCeremonyAt > 0 && since >= 0 && since < AUTO_MIN_GAP_MS) {
    log('auto skipped', `${reason}, last prompt ${Math.round(since / 100) / 10} s ago`);
    return;
  }
  autoOpportunity = true;
  log('auto offered', reason);
  void unlock({ auto: true });
}

/** A dialog (the recovery sheet) is open on the lock screen. */
function recoveryOpen(): boolean {
  try {
    return typeof document !== 'undefined' && !!document.querySelector?.('#lock-layer [role="dialog"]');
  } catch {
    return false;
  }
}

async function runAuto(): Promise<UnlockResult> {
  autoRunning = true;
  try {
    if (!hasFocus()) {
      log('focus wait', describeVisibility());
      const focused = await waitForFocus(FOCUS_WAIT_MS);
      if (!focused) {
        const gaveUp = isVisible() && state.phase === 'locked';
        log(gaveUp ? 'focus timeout' : 'focus wait ended', describeVisibility());
        return gaveUp ? 'not-focused' : 'cancelled';
      }
      log('focus arrived');
      // The tap that brought focus may be on the Unlock button: let it start its own ceremony.
      if (!(await grace(FOCUS_GRACE_MS))) return 'cancelled';
    }
    if (state.phase !== 'locked' || !isVisible() || isCeremonyActive()) return 'cancelled';
    return await runUnlock('auto');
  } finally {
    autoRunning = false;
  }
}

async function runUnlock(kind: 'auto' | 'tap'): Promise<UnlockResult> {
  const rec = record!;
  const seq = ++unlockSeq;
  lastCeremonyAt = Date.now();
  setState({ phase: 'unlocking', message: undefined });
  log('unlock start', `${kind}, ${describeVisibility()}`);
  const r = await getAssertion(rec);
  if (seq !== unlockSeq || record !== rec) {
    log('unlock result', `${kind}: ${r.ok ? 'ok' : describeFailure(r)} (ignored, superseded)`);
    return 'cancelled';
  }
  if (r.ok) {
    applyUnlocked();
    log('unlock result', `${kind}: ok`);
    return 'ok';
  }
  log('unlock result', `${kind}: ${describeFailure(r)}`);
  const { result, counts, message } = unlockFailure(r);
  setState({ phase: 'locked', failures: counts ? state.failures + 1 : state.failures, message });
  return result;
}

function unlockFailure(f: CeremonyFailure): { result: UnlockResult; counts: boolean; message?: string } {
  switch (f.kind) {
    case 'not-allowed':
      return { result: 'cancelled', counts: true, message: MESSAGES.notAllowed };
    case 'not-focused':
      return { result: 'not-focused', counts: false, message: MESSAGES.notFocused };
    case 'aborted':
      return f.reason === 'timeout' ? { result: 'failed', counts: true, message: MESSAGES.timeout } : { result: 'cancelled', counts: false };
    case 'invalid':
      return { result: 'failed', counts: true, message: MESSAGES.invalid };
    default:
      return { result: 'failed', counts: true, message: MESSAGES.error };
  }
}

/** Enable and disable: NotAllowedError or an abort is a cancel, anything else a failure. */
function setupFailure(f: CeremonyFailure): 'cancelled' | 'failed' {
  if (f.kind === 'not-allowed') return 'cancelled';
  if (f.kind === 'aborted' && f.reason !== 'timeout') return 'cancelled';
  return 'failed';
}

// ---------- Public API ----------

/** Install listeners and read storage (idempotent). Call once at boot, before rendering. */
export function startLock(): void {
  if (started) return;
  started = true;
  const now = Date.now();
  const device = detectDevice();
  const read = store.readRecord(hostname());
  record = read.record;
  lastActive = store.readActive();
  const reloadAt = store.consumeReload();
  const trusted = reloadAt !== null && now - reloadAt >= 0 && now - reloadAt < TRUSTED_RELOAD_MS;
  // idleExceeded() reads state.idleMinutes, so set it before deciding.
  state = { ...state, idleMinutes: store.readIdle(), device, label: labelFor(device), otherHost: read.otherHost };
  // With idle 0, a trusted reload that comes back hidden means you left while it loaded: that is leaving.
  const leftDuringReload = trusted && state.idleMinutes === 0 && !isVisible();
  const phase = !record ? 'off' : trusted && !leftDuringReload && !idleExceeded(now) ? 'unlocked' : 'locked';
  const why = trusted
    ? `trusted reload, ${leftDuringReload ? 'came back hidden with idle setting 0' : idleDetail(now)}`
    : reloadAt !== null
      ? 'stale reload mark'
      : 'launch';
  if (phase === 'locked') {
    // Locked from the start: drop the last session's activity stamp, exactly as lock() does, so no later
    // trusted reload of this locked page can find a fresh stamp and open without Face ID.
    lastActive = null;
    store.clearActive();
  }
  setLockAttr(phase === 'locked');
  if (!isVisible()) setShield(true);
  state = { ...state, phase, coldStart: phase === 'locked', failures: 0, message: undefined };
  notify(); // device, label and the rest changed above even when the phase did not
  install();
  startIdleTimer();
  log('start', `${phase}, ${device}, ${why}, ${describeVisibility()}${read.otherHost ? ', record for another address' : ''}`);
  checkAvailability();
  if (phase === 'locked') setTimeout(() => offerAuto('cold start'), 0);
}

export function getLockState(): LockState {
  return state;
}

export function subscribeLock(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Run a Face ID ceremony. `auto` = an automatic attempt (respects the focus rule, at most once per opportunity). */
export async function unlock(opts?: { auto?: boolean }): Promise<UnlockResult> {
  if (!record) return 'ok'; // nothing to unlock: the lock is off here
  if (state.phase === 'unlocked') return 'ok';
  if (opts?.auto) {
    if (!autoOpportunity) return autoRunning || isCeremonyActive() ? 'busy' : 'cancelled';
    autoOpportunity = false;
    if (autoRunning || isCeremonyActive()) return 'busy';
    if (!isVisible()) {
      log('auto skipped', 'hidden');
      return 'cancelled';
    }
    return runAuto();
  }
  cancelPendingAuto(); // a tap wins over a pending automatic attempt
  autoOpportunity = false;
  return runUnlock('tap');
}

/** Enroll this device (create + test unlock). Must be called from a tap. */
export async function enableLock(): Promise<EnableResult> {
  if (record && state.phase === 'unlocked') return 'ok';
  if (state.phase === 'locked' || state.phase === 'unlocking') return 'failed';
  if (setupRunning) {
    log('enable skipped', 'already running');
    return 'cancelled';
  }
  setupRunning = true;
  const release = holdBusy('Face ID setup');
  // A lock, reset or recovery meanwhile bumps unlockSeq (applyOff, lock): then this enable is void.
  const seq = unlockSeq;
  const superseded = () => unlockSeq !== seq;
  try {
    const rpId = hostname();
    const now = Date.now();
    const pending =
      pendingEnroll && pendingEnroll.record.rpId === rpId && now - pendingEnroll.at >= 0 && now - pendingEnroll.at < PENDING_ENROLL_MS
        ? pendingEnroll.record
        : null;
    pendingEnroll = null;
    let candidate: LockRecord;
    if (pending) {
      // The passkey from the last try exists and passed verification; only its test unlock is left.
      log('enable start', `${state.device}, ${rpId}, test unlock of the passkey just created`);
      candidate = pending;
    } else {
      log('enable start', `${state.device}, ${rpId}`);
      const created = await createCredential({ rpId, userId: store.userId(), label: state.label });
      if (!created.ok) {
        log('enable result', `create: ${describeFailure(created)}`);
        return setupFailure(created);
      }
      candidate = created.value;
      if (!hasFocus()) {
        log('focus wait', 'enable test');
        await waitForFocus(FOCUS_WAIT_MS);
      }
      if (superseded()) {
        log('enable result', 'lock changed meanwhile');
        return 'cancelled';
      }
      if (!isVisible()) {
        keepForRetry(candidate);
        log('enable result', 'hidden before the test unlock');
        return 'cancelled';
      }
    }
    const tested = await getAssertion(candidate);
    if (superseded()) {
      log('enable result', 'lock changed meanwhile');
      return 'cancelled';
    }
    if (!tested.ok) {
      // No focus (the passkey sheet can leave the page unfocused) or a quiet abort: keep the verified
      // credential for the next tap. A cancel, a bad credential or an error starts over next time.
      if (tested.kind === 'not-focused' || (tested.kind === 'aborted' && tested.reason !== 'timeout')) keepForRetry(candidate);
      log('enable result', `test unlock: ${describeFailure(tested)}${pendingEnroll ? ' (kept for the next try)' : ''}`);
      return setupFailure(tested);
    }
    if (!store.writeRecord(candidate)) {
      log('enable result', 'could not save the record');
      return 'failed';
    }
    record = candidate;
    setState({ otherHost: false });
    applyUnlocked();
    log('enable result', 'ok');
    return 'ok';
  } finally {
    setupRunning = false;
    release();
  }
}

function keepForRetry(candidate: LockRecord) {
  pendingEnroll = { record: candidate, at: Date.now() };
}

/** Turn the lock off on this device after a successful unlock ceremony. */
export async function disableLock(): Promise<DisableResult> {
  if (!record) return 'ok';
  if (state.phase !== 'unlocked') return 'failed';
  if (setupRunning) {
    log('disable skipped', 'already running');
    return 'cancelled';
  }
  setupRunning = true;
  try {
    const rec = record;
    log('disable start');
    const r = await getAssertion(rec);
    if (!r.ok) {
      log('disable result', describeFailure(r));
      return setupFailure(r);
    }
    if (record !== rec || state.phase !== 'unlocked') {
      log('disable result', 'lock changed meanwhile');
      return 'failed';
    }
    applyOff();
    log('disable result', 'ok');
    return 'ok';
  } finally {
    setupRunning = false;
  }
}

export function setIdleMinutes(minutes: IdleMinutes): void {
  if (!(IDLE_CHOICES as readonly number[]).includes(minutes)) return;
  store.writeIdle(minutes);
  setState({ idleMinutes: minutes });
  log('idle setting', `${minutes} min`);
}

/** Lock right now (Settings "Lock now"). No-op when the lock is off. */
export function lockNow(): void {
  if (!record || state.phase === 'off') return;
  lock('lock now');
}

/** After a fresh email-code sign-in on the lock screen: unlock and turn the lock off. */
export function completeRecovery(): void {
  applyOff();
  log('recovery', 'email code sign-in, lock off');
}

/** Remove this device's lock record (keeps fb-lock-user-id). */
export function resetLock(): void {
  applyOff();
  log('reset', 'record removed');
}

/** Call right before an app-initiated reload (update apply, database upgrade). */
export function markTrustedReload(): void {
  const now = Date.now();
  store.markReload(now);
  // Harmless while locked (a locked page keeps no activity stamp, so the reload comes back locked), but
  // only an open, visible page gets the idle-0 exemption for its own unload.
  const exempt = isVisible() && state.phase === 'unlocked';
  if (exempt) reloadMarkedVisibleAt = now;
  log('trusted reload', `${state.phase}, ${isVisible() ? 'while visible' : 'while hidden'}`);
}

export function getLockLog(): LockLogEntry[] {
  return store.readLog();
}
