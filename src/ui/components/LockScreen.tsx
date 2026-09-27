// The lock screen (Phase 6): covers the app while this device is locked.
//
// THE FACE ID LOCK IS AN ACCESS GATE, NOT ENCRYPTION. Your data stays unencrypted on this device; the
// passkey only decides whether this screen lets you through. Anyone who can run script in this origin,
// attach Web Inspector, or read the device's storage gets past it. Full statement: src/lock/webauthnLocal.ts.
//
// One primary button runs the Face ID prompt straight from the tap. The controller already makes the one
// automatic attempt per unlock opportunity (cold start, or a resume that needed unlocking), so this screen
// never adds another. After two failed tries, "Can't unlock?" opens recovery: restore a deleted passkey,
// sign in again with an email code (only when this device is signed in to sync), or reset this device.
// Everything here works before the app has ever mounted (cold start): no app state, no toast provider.
import { AnimatePresence, motion, useAnimationControls } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { completeRecovery, getLockState, resetLock, unlock } from '@/lock/controller';
import type { LockDevice, LockState } from '@/lock/types';
import { wipeAll } from '@/data/repo';
import { SIGN_IN_MESSAGES, SignInError, normalizeCode, normalizeEmail } from '@/sync/auth';
import { eraseDeviceSync, sendCode, syncNow, verifyCode } from '@/sync/manager';
import type { SyncStatus } from '@/sync/types';
import { useSyncStatus } from '@/sync/useSync';
import { useReducedMotion } from '../motion';
import { MoltenButton } from './sizzle';
import { sendFailure } from './SyncPanel';
import { GhostButton, Sheet } from './ui';

// ---------- Copy (pure, tested) ----------

/** The unlock button, and the line under it, for each kind of device. */
export function unlockCopy(device: LockDevice): { button: string; subtitle?: string } {
  switch (device) {
    case 'iphone':
      return { button: 'Unlock with Face ID' };
    case 'ipad':
      return { button: 'Unlock', subtitle: 'Face ID, Touch ID or your passcode' };
    case 'mac':
      return { button: 'Unlock with Touch ID', subtitle: 'or your Mac password' };
    default:
      return { button: 'Unlock' };
  }
}

/** Unlock failures before "Can't unlock?" shows up. */
export const RECOVERY_AFTER_FAILURES = 2;

/** How long after a prompt started a further tap on Unlock is ignored. */
export const PROMPT_TAP_GUARD_MS = 3_000;

/**
 * Whether a tap on Unlock should start a Face ID prompt. While one is opening, a second tap (a double
 * click, a held Enter key, a tap right after the automatic attempt began) would abort it and start
 * another, and rapid repeated prompts confuse iOS (WebKit bug 291258). After a few seconds a tap may
 * restart a prompt that never showed up (the controller's own watchdog only fires after 120 s).
 * unlockingSince = 0 means the prompt started but this screen has not noted when yet: too soon.
 */
export function tapStartsPrompt(unlocking: boolean, unlockingSince: number, now: number): boolean {
  if (!unlocking) return true;
  if (unlockingSince <= 0) return false;
  const age = now - unlockingSince;
  return age < 0 || age >= PROMPT_TAP_GUARD_MS;
}

/** The tap handler for Unlock and Try again: straight into unlock(), unless a prompt just started. */
function useUnlockTap(unlocking: boolean): () => void {
  const since = useRef(0);
  useEffect(() => {
    if (!unlocking) since.current = 0;
    else if (!since.current) since.current = Date.now();
  }, [unlocking]);
  return () => {
    const now = Date.now();
    // The live phase, not the last render: a double click can land before React redraws.
    if (!tapStartsPrompt(getLockState().phase === 'unlocking', since.current, now)) return;
    since.current = now;
    void unlock();
  };
}

/** The passkey name to look for in the Passwords app. */
export function passkeyName(state: Pick<LockState, 'label'>): string {
  return state.label.trim() || 'Four Burners lock';
}

/** How to bring back a passkey that was deleted (Apple keeps deleted passwords for 30 days). */
export function restoreSteps(label: string, device: LockDevice): string[] {
  if (device === 'other') return [`Open your password manager and restore "${label}" if it was deleted.`, 'Come back and tap Try again.'];
  return ['Open the Passwords app.', 'Go to Recently Deleted.', `Restore "${label}".`, 'Come back and tap Try again.'];
}

/** The email this device is signed in to sync with, when an email-code sign-in can unlock it. */
export function recoveryEmail(s: SyncStatus): string | null {
  const signedIn = s.state === 'idle' || s.state === 'syncing' || s.state === 'offline' || s.state === 'error';
  return signedIn && s.email ? s.email : null;
}

/** The plain warning before "Reset this device" erases everything. */
export function resetWarning(s: SyncStatus): string {
  const signedIn = s.state !== 'signedOut' && s.state !== 'unconfigured';
  if (!signedIn) return 'Everything on this device will be erased. Your data is gone unless you have a backup.';
  if (s.pending > 0) {
    const what = s.pending === 1 ? "1 change on this device hasn't" : `${s.pending} changes on this device haven't`;
    return `${what} synced and will be lost. Everything else stays in your sync account.`;
  }
  return 'Everything on this device will be erased, and it will sign out of sync. Your sync account keeps its copy.';
}

/** Shown once the email-code recovery has turned the lock off. */
export function recoveryDoneText(device: LockDevice): string {
  const what = device === 'iphone' ? 'Face ID lock' : device === 'mac' ? 'Touch ID lock' : 'The app lock';
  return `${what} is off. Turn it on again in Settings to make a new passkey.`;
}

// ---------- Recovery draft ----------

// A sent code stays valid for an hour, and iOS may reload the app while you check Mail. The draft brings
// the code step (and "Can't unlock?") back right away instead of waiting for two more failed tries.
const DRAFT_KEY = 'fb-lock-recovery';
const DRAFT_MAX_AGE_MS = 60 * 60_000;
const RESEND_MS = 60_000;

interface Draft {
  email: string;
  sentAt: number;
}

export function readRecoveryDraft(): Draft | null {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as Draft | null;
    return d && typeof d.email === 'string' && typeof d.sentAt === 'number' && Date.now() - d.sentAt < DRAFT_MAX_AGE_MS ? d : null;
  } catch {
    return null;
  }
}

function writeRecoveryDraft(d: Draft | null) {
  try {
    if (d) localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    // storage unavailable
  }
}

/** The app opened (Face ID worked after all, or the lock is off): a code sent earlier is no longer needed. */
export function clearRecoveryDraft() {
  writeRecoveryDraft(null);
}

// ---------- The lock screen ----------

export function LockScreen({
  state,
  onRecovered,
  onLeaving,
}: {
  state: LockState;
  onRecovered: (note: string) => void;
  /** "Reset this device" wiped the data and is about to reload: keep this screen up until the page goes. */
  onLeaving?: () => void;
}) {
  const reduced = useReducedMotion();
  const sync = useSyncStatus();
  const email = recoveryEmail(sync);
  const copy = unlockCopy(state.device);
  const unlocking = state.phase === 'unlocking';
  const tapUnlock = useUnlockTap(unlocking);
  // A code sent before iOS reloaded the app, to the account this device is still signed in to.
  const [draft] = useState(readRecoveryDraft);
  const resumable = !!draft && !!email && normalizeEmail(draft.email) === normalizeEmail(email);
  const [sheet, setSheet] = useState(false);
  const canRecover = state.failures >= RECOVERY_AFTER_FAILURES || resumable;

  // A small shake of the button for each failed try.
  const shake = useAnimationControls();
  useEffect(() => {
    if (state.failures > 0 && !reduced) void shake.start({ x: [0, -10, 9, -6, 4, 0], transition: { duration: 0.42 } });
  }, [state.failures, reduced, shake]);

  return (
    <motion.section
      aria-labelledby="lock-title"
      className="fixed inset-0 z-[100] flex overflow-y-auto overscroll-contain bg-black text-white"
      // Appears at once (the app underneath is already hidden); leaves with an iris-like bloom.
      initial={false}
      exit={
        reduced
          ? { opacity: 0, transition: { duration: 0.2 } }
          : { opacity: 0, scale: 1.08, filter: 'blur(12px)', transition: { duration: 0.45, ease: [0.16, 1, 0.3, 1] } }
      }
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3"
        style={{ background: 'radial-gradient(75% 55% at 50% 100%, rgba(255,106,43,0.16), rgba(255,106,43,0.04) 55%, transparent 75%)' }}
      />
      <div className="px-safe pt-safe pb-safe relative m-auto w-full max-w-md">
        <div className="flex flex-col items-center py-8 text-center">
          <Emblem unlocking={unlocking} />
          <motion.h1
            id="lock-title"
            className="mt-7 font-display text-[28px] leading-tight font-bold"
            style={{ textShadow: '0 0 28px rgba(255,150,60,0.35)' }}
            initial={reduced ? false : { opacity: 0, y: 12, filter: 'blur(6px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={{ delay: 0.15, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          >
            Four Burners is locked
          </motion.h1>

          <motion.div
            className="mt-10 w-full max-w-xs"
            initial={reduced ? false : { opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
          >
            <motion.div animate={shake}>
              <MoltenButton
                // Enter or Space unlocks on the Mac without reaching for the mouse.
                autoFocus
                aria-busy={unlocking || undefined}
                // A soft ember ring instead of the stark default when it has keyboard focus.
                className="h-14 w-full text-[17px] outline-none focus-visible:outline-2 focus-visible:outline-offset-[5px] focus-visible:outline-[#ffd27a]/60"
                onClick={tapUnlock}
              >
                <DeviceGlyph device={state.device} />
                {copy.button}
              </MoltenButton>
            </motion.div>
            {copy.subtitle && <p className="mt-2.5 text-[14px] text-dim">{copy.subtitle}</p>}
          </motion.div>

          {/* One live region that stays mounted, so each new message is announced. */}
          <div role="status" aria-live="polite" className="mt-4 min-h-6 w-full max-w-xs">
            <AnimatePresence mode="wait" initial={false}>
              {state.message && (
                <motion.p
                  key={`${state.failures}:${state.message}`}
                  initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6, filter: 'blur(4px)' }}
                  animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.22 }}
                  className="text-[15px] font-medium text-amber-100"
                >
                  {state.message}
                </motion.p>
              )}
            </AnimatePresence>
          </div>

          <AnimatePresence initial={false}>
            {canRecover && (
              <motion.button
                type="button"
                initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                onClick={() => setSheet(true)}
                className="mt-3 min-h-11 rounded-full px-4 text-[16px] font-semibold text-ember active:bg-white/10"
                style={{ textShadow: '0 0 14px rgba(255,160,60,0.45)' }}
              >
                Can't unlock?
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </div>

      <RecoverySheet
        open={sheet}
        onClose={() => setSheet(false)}
        state={state}
        sync={sync}
        onRecovered={onRecovered}
        onTryAgain={tapUnlock}
        onLeaving={onLeaving}
      />
    </motion.section>
  );
}

// ---------- Emblem ----------

const FLAME_PATH = 'M0-190C40-120 110-80 110 10a110 110 0 0 1-220 0c0-50 30-80 50-110 5 40 25 60 45 70C-20-70-25-130 0-190z';

/** The app's flame, breathing in a soft glow; a molten ring circles it while Face ID is up. */
function Emblem({ unlocking }: { unlocking: boolean }) {
  const reduced = useReducedMotion();
  return (
    <div className="relative grid h-44 w-44 place-items-center" aria-hidden>
      <motion.div
        className="absolute inset-0 rounded-full"
        style={{ background: 'radial-gradient(circle, rgba(255,160,70,0.42) 0%, rgba(255,90,31,0.16) 42%, transparent 70%)' }}
        animate={reduced ? { opacity: 0.8, scale: 1 } : { scale: [1, 1.12, 1], opacity: [0.6, 1, 0.6] }}
        transition={reduced ? { duration: 0 } : { duration: 3.8, repeat: Infinity, ease: 'easeInOut' }}
      />
      <AnimatePresence>
        {unlocking && (
          <motion.span
            key="ring"
            className="absolute inset-2 rounded-full"
            style={{
              background: 'conic-gradient(from 0deg, transparent 0deg, #ffd27a 70deg, #ff6a2b 140deg, transparent 220deg)',
              WebkitMask: 'radial-gradient(circle, transparent 63%, #000 65%, #000 69%, transparent 71%)',
              mask: 'radial-gradient(circle, transparent 63%, #000 65%, #000 69%, transparent 71%)',
            }}
            initial={{ opacity: 0 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, rotate: 360 }}
            exit={{ opacity: 0 }}
            transition={reduced ? { duration: 0.2 } : { opacity: { duration: 0.25 }, rotate: { duration: 1.1, repeat: Infinity, ease: 'linear' } }}
          />
        )}
      </AnimatePresence>
      <motion.div
        style={{ filter: 'drop-shadow(0 0 18px rgba(255,140,50,0.75))' }}
        initial={reduced ? false : { scale: 0.55, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
      >
        <svg width="84" height="112" viewBox="-120 -200 240 320">
          <defs>
            <radialGradient id="lock-flame" cx="50%" cy="70%" r="55%">
              <stop offset="0" stopColor="#fff4d6" />
              <stop offset=".35" stopColor="#ffae3b" />
              <stop offset=".72" stopColor="#ff5a1f" stopOpacity=".8" />
              <stop offset="1" stopColor="#ff5a1f" stopOpacity="0" />
            </radialGradient>
          </defs>
          <path
            d={FLAME_PATH}
            fill="url(#lock-flame)"
            style={{ transformBox: 'fill-box', transformOrigin: '50% 100%', animation: reduced ? undefined : 'flicker 2.6s ease-in-out infinite' }}
          />
        </svg>
      </motion.div>
      <div className="absolute bottom-2 flex gap-2.5">
        {[0, 1, 2, 3].map((i) => (
          <motion.span
            key={i}
            className="h-2 w-2 rounded-full bg-ember"
            style={{ boxShadow: '0 0 8px #ff9a3c' }}
            animate={reduced ? { opacity: 0.85 } : { opacity: [0.35, 1, 0.35] }}
            transition={reduced ? { duration: 0 } : { duration: 2.4, repeat: Infinity, delay: i * 0.3, ease: 'easeInOut' }}
          />
        ))}
      </div>
    </div>
  );
}

function DeviceGlyph({ device }: { device: LockDevice }) {
  const common = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
  if (device === 'mac') {
    // Touch ID
    return (
      <svg {...common}>
        <path d="M7 4.6a9 9 0 0 1 10 0" />
        <path d="M4.6 8.4a8.4 8.4 0 0 1 14.8 1.1" />
        <path d="M8.2 20a13 13 0 0 0 1.3-5.6v-1.8a2.5 2.5 0 0 1 5 0v1.2" />
        <path d="M5.2 17.2a15 15 0 0 0 .8-4.6 6 6 0 0 1 10-4.5" />
        <path d="M12 12.6v1.8a16 16 0 0 1-1.7 7" />
        <path d="M17.9 12a17 17 0 0 1-.4 6.2" />
        <path d="M14.4 17.4a19 19 0 0 1-.9 3.6" />
      </svg>
    );
  }
  if (device === 'other') {
    return (
      <svg {...common}>
        <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
        <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
      </svg>
    );
  }
  // Face ID
  return (
    <svg {...common}>
      <path d="M3.5 8V6.5a3 3 0 0 1 3-3H8" />
      <path d="M16 3.5h1.5a3 3 0 0 1 3 3V8" />
      <path d="M20.5 16v1.5a3 3 0 0 1-3 3H16" />
      <path d="M8 20.5H6.5a3 3 0 0 1-3-3V16" />
      <path d="M9 9v1.5" />
      <path d="M15 9v1.5" />
      <path d="M12 9v4h-1" />
      <path d="M9.5 16a3.6 3.6 0 0 0 5 0" />
    </svg>
  );
}

// ---------- Recovery ----------

type View = 'menu' | 'code' | 'reset';

function RecoverySheet({
  open,
  onClose,
  ...panel
}: {
  open: boolean;
  onClose: () => void;
  state: LockState;
  sync: SyncStatus;
  onRecovered: (note: string) => void;
  onTryAgain?: () => void;
  onLeaving?: () => void;
}) {
  // An erase in progress must finish: closing the sheet would only hide it.
  const erasing = useRef(false);
  return (
    <Sheet open={open} onClose={() => !erasing.current && onClose()} title="Can't unlock?">
      <RecoveryPanel {...panel} onClose={onClose} erasingRef={erasing} />
    </Sheet>
  );
}

/** The recovery choices inside the sheet. Exported for tests (static markup of each view). */
export function RecoveryPanel({
  state,
  sync,
  initialView,
  onClose,
  onRecovered,
  onTryAgain = () => void unlock(),
  onLeaving,
  erasingRef,
}: {
  state: LockState;
  sync: SyncStatus;
  initialView?: View;
  onClose: () => void;
  onRecovered: (note: string) => void;
  /** Try again: the lock screen's own tap handler (it ignores a tap while a prompt is opening). */
  onTryAgain?: () => void;
  onLeaving?: () => void;
  erasingRef?: React.RefObject<boolean>;
}) {
  const reduced = useReducedMotion();
  const email = recoveryEmail(sync);
  // A code already sent to this account (before a reload, or before the sheet was closed) picks up there.
  const [resume] = useState(() => {
    const d = readRecoveryDraft();
    return d && email && normalizeEmail(d.email) === normalizeEmail(email) ? d : null;
  });
  const [view, setView] = useState<View>(initialView ?? (resume ? 'code' : 'menu'));
  const [sentAt, setSentAt] = useState(resume?.sentAt ?? 0);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [codeNotice, setCodeNotice] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const label = passkeyName(state);

  const send = async () => {
    if (!email || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    try {
      await sendCode(email);
      toCode(null);
    } catch (e) {
      const f = sendFailure(e);
      // Asked too soon: a code went out moments ago and still works.
      if (f.codeStep) toCode(f.message);
      else setSendError(f.message);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const toCode = (notice: string | null) => {
    if (!email) return;
    const t = Date.now();
    setSentAt(t);
    writeRecoveryDraft({ email, sentAt: t });
    setCodeNotice(notice);
    setView('code');
  };

  const slide = (dir: 1 | -1) =>
    reduced
      ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
      : { initial: { opacity: 0, x: 18 * dir }, animate: { opacity: 1, x: 0 }, exit: { opacity: 0, x: -18 * dir } };

  return (
    <AnimatePresence mode="wait" initial={false}>
      {view === 'menu' && (
        <motion.div key="menu" {...slide(-1)} transition={{ duration: 0.2 }} className="flex flex-col gap-3 pb-2">
          <Choice tone="ember" icon="🔑" title="Restore the passkey">
            <p className="text-[14px] text-dim">If the passkey was deleted, you can bring it back:</p>
            <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-[15px] leading-relaxed">
              {restoreSteps(label, state.device).map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            <GhostButton
              className="mt-3 w-full"
              onClick={() => {
                // First thing in the tap, so the prompt opens right away.
                onTryAgain();
                onClose();
              }}
            >
              Try again
            </GhostButton>
          </Choice>

          {email && (
            <Choice tone="teal" icon="✉️" title="Sign in with an email code">
              <p className="text-[14px] text-dim">
                We'll email a code to <span className="font-semibold wrap-break-word text-white">{email}</span>. Signing in turns the lock off on this
                device.
              </p>
              <MoltenButton className="mt-3 h-12 w-full text-[16px] disabled:opacity-60" disabled={sending} onClick={() => void send()}>
                {sending ? 'Sending...' : 'Email me a code'}
              </MoltenButton>
              {sendError && <ErrorLine text={sendError} />}
            </Choice>
          )}

          <Choice tone="rose" icon="🧯" title="Reset this device">
            <p className="text-[14px] text-dim">Erase everything on this device and start over.</p>
            <GhostButton className="mt-3 w-full text-rose-300" onClick={() => setView('reset')}>
              Reset this device
            </GhostButton>
          </Choice>
        </motion.div>
      )}

      {view === 'code' && (
        <motion.div key="code" {...slide(1)} transition={{ duration: 0.2 }} className="pb-2">
          {email ? (
            <CodeStep
              email={email}
              sentAt={sentAt}
              notice={codeNotice}
              sending={sending}
              sendError={sendError}
              onResend={() => void send()}
              onBack={() => {
                writeRecoveryDraft(null);
                setSendError(null);
                setView('menu');
              }}
              onVerified={() => {
                writeRecoveryDraft(null);
                completeRecovery();
                onRecovered(recoveryDoneText(state.device));
              }}
            />
          ) : (
            <div>
              <p className="text-[15px] text-dim">This device is no longer signed in to sync, so a code can't unlock it.</p>
              <GhostButton className="mt-4 w-full" onClick={() => setView('menu')}>
                Back
              </GhostButton>
            </div>
          )}
        </motion.div>
      )}

      {view === 'reset' && (
        <motion.div key="reset" {...slide(1)} transition={{ duration: 0.2 }} className="pb-2">
          <ResetStep sync={sync} erasingRef={erasingRef} onLeaving={onLeaving} onCancel={() => setView('menu')} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

const TONES = {
  ember: { tile: 'radial-gradient(circle at 50% 30%, rgba(255,174,59,0.38), rgba(255,90,31,0.10))', glow: 'rgba(255,150,60,0.45)' },
  teal: { tile: 'radial-gradient(circle at 50% 30%, rgba(94,234,212,0.34), rgba(40,160,150,0.10))', glow: 'rgba(94,234,212,0.4)' },
  rose: { tile: 'radial-gradient(circle at 50% 30%, rgba(255,122,143,0.34), rgba(200,40,70,0.10))', glow: 'rgba(255,110,130,0.4)' },
} as const;

function Choice({ tone, icon, title, children }: { tone: keyof typeof TONES; icon: string; title: string; children: ReactNode }) {
  const t = TONES[tone];
  return (
    <section className="rounded-3xl border border-line bg-raised/60 p-4" style={{ boxShadow: `0 0 30px -22px ${t.glow}` }}>
      <div className="mb-2 flex items-center gap-3">
        <span aria-hidden className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl text-[20px]" style={{ background: t.tile, boxShadow: `0 0 16px -4px ${t.glow}` }}>
          {icon}
        </span>
        <h3 className="text-[17px] font-semibold">{title}</h3>
      </div>
      {children}
    </section>
  );
}

function CodeStep({
  email,
  sentAt,
  notice,
  sending,
  sendError,
  onResend,
  onBack,
  onVerified,
}: {
  email: string;
  sentAt: number;
  notice: string | null;
  sending: boolean;
  sendError: string | null;
  onResend: () => void;
  onBack: () => void;
  onVerified: () => void;
}) {
  const reduced = useReducedMotion();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [sentAt]);
  const wait = Math.max(0, Math.ceil((sentAt + RESEND_MS - now) / 1000));

  const verify = async (input: string) => {
    // Numeric codes only. A pasted sign-in link is not bound to this email, so it could sign this device
    // in to a different account and turn the lock off; the code is checked against this account's email.
    const digits = normalizeCode(input);
    if (!digits) {
      setError(SIGN_IN_MESSAGES.invalid_code);
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const user = await verifyCode(email, digits);
      if (user.email && normalizeEmail(user.email) !== normalizeEmail(email)) throw new SignInError('unknown', SIGN_IN_MESSAGES.unknown);
      onVerified();
    } catch (e) {
      setError(e instanceof SignInError ? e.message : SIGN_IN_MESSAGES.unknown);
      requestAnimationFrame(() => inputRef.current?.select());
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const shownError = error ?? sendError;
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void verify(code);
      }}
    >
      {notice && (
        <div className="mb-3 rounded-2xl border border-amber-300/25 bg-amber-300/[0.07] px-3.5 py-2.5 text-[14px] text-amber-100" role="status">
          {notice}
        </div>
      )}
      <p className="text-[15px] leading-relaxed text-dim">
        Enter the code we emailed to <span className="font-semibold wrap-break-word text-white">{email}</span>.
      </p>
      <div className="relative mt-4">
        <motion.div
          aria-hidden
          className="pointer-events-none absolute -inset-px rounded-2xl"
          style={{ boxShadow: '0 0 0 1.5px #ff9a3c, 0 0 28px -4px rgba(255,140,50,0.7)', animation: reduced ? undefined : 'glow-pulse 2.4s ease-in-out infinite' }}
          animate={{ opacity: busy ? 1 : 0.55 }}
        />
        <input
          ref={inputRef}
          autoFocus
          className="relative w-full rounded-2xl border border-line bg-raised px-4 py-4 text-center font-display text-[30px] font-bold tracking-[0.32em] text-white outline-none placeholder:font-normal placeholder:tracking-[0.3em] placeholder:text-white/20 tabular"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={12}
          enterKeyHint="go"
          placeholder="000000"
          aria-label="Code from the email"
          value={code}
          // Read-only, not disabled, while checking: disabling the focused field closes the iOS keyboard,
          // and a wrong code would then need another tap before you could fix it.
          readOnly={busy}
          aria-busy={busy || undefined}
          onChange={(e) => {
            const next = e.target.value;
            const added = next.replace(/\D/g, '').length - code.replace(/\D/g, '').length;
            setCode(next);
            setError(null);
            // Autofill or paste drops the whole code in one go: check it without a tap.
            if (added >= 2 && normalizeCode(next)) void verify(next);
          }}
        />
      </div>
      {shownError && <ErrorLine text={shownError} />}
      <MoltenButton type="submit" disabled={busy} className="mt-4 h-14 w-full text-[17px] disabled:opacity-60">
        {busy ? 'Checking...' : 'Unlock'}
      </MoltenButton>
      <div className="mt-3 flex items-center justify-between gap-2">
        <button type="button" onClick={onBack} className="min-h-11 px-1 text-[15px] text-dim active:text-white">
          Back
        </button>
        <button
          type="button"
          disabled={wait > 0 || sending || busy}
          onClick={onResend}
          className="min-h-11 px-1 text-[15px] font-semibold text-ember disabled:font-normal disabled:text-dim tabular"
        >
          {sending ? 'Sending...' : wait > 0 ? `New code in ${wait}s` : 'Send a new code'}
        </button>
      </div>
    </form>
  );
}

/**
 * "Reset this device": forget sync here, wipe the data, then remove the lock and reload. Resolves false,
 * with the lock untouched, when the wipe failed (the data is still here, so it stays behind the lock).
 * Exported for tests.
 */
export async function eraseAndReset(onLeaving?: () => void): Promise<boolean> {
  try {
    await eraseDeviceSync();
  } catch {
    // The wipe below also clears this device's sync position.
  }
  try {
    await wipeAll();
  } catch {
    return false;
  }
  // resetLock() turns the lock off in memory, which would open the gate and mount the app on the empty
  // database (its first-launch effects would run and navigate) in the moment before the reload. Tell the
  // gate to keep the lock screen up until the page goes.
  try {
    onLeaving?.();
  } catch {
    // The reload below still happens.
  }
  try {
    resetLock();
  } catch {
    // The data is gone either way.
  }
  writeRecoveryDraft(null);
  location.replace('/');
  return true;
}

function ResetStep({
  sync,
  erasingRef,
  onLeaving,
  onCancel,
}: {
  sync: SyncStatus;
  erasingRef?: React.RefObject<boolean>;
  onLeaving?: () => void;
  onCancel: () => void;
}) {
  const [erasing, setErasing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signedIn = recoveryEmail(sync) !== null;
  const pending = sync.pending;

  // Sync keeps running while the app is locked. Give unsynced changes one more push, so the warning
  // below can shrink to "nothing will be lost" before you decide.
  useEffect(() => {
    if (signedIn && pending > 0) void syncNow().catch(() => undefined);
    // Only when this step opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reset = async () => {
    if (erasing) return;
    setErasing(true);
    if (erasingRef) erasingRef.current = true;
    setError(null);
    if (await eraseAndReset(onLeaving)) return; // the page is reloading
    if (erasingRef) erasingRef.current = false;
    setErasing(false);
    setError("Couldn't erase this device. Try again.");
  };

  return (
    <div>
      <div className="rounded-2xl border border-rose-400/30 bg-rose-500/[0.08] p-4" style={{ boxShadow: '0 0 30px -18px rgba(255,90,110,0.6)' }}>
        <h3 className="text-[17px] font-semibold text-rose-100">Erase this device?</h3>
        <p className="mt-1.5 text-[15px] leading-relaxed text-rose-100/90" role="status">
          {resetWarning(sync)}
        </p>
      </div>
      <p className="mt-3 text-[14px] text-dim">The lock is removed too. You can turn it on again afterward.</p>
      <button
        type="button"
        disabled={erasing}
        onClick={() => void reset()}
        className="mt-4 min-h-13 w-full rounded-2xl bg-rose-500 px-4 text-[17px] font-semibold text-white transition active:scale-[0.98] disabled:opacity-60"
        style={{ boxShadow: '0 10px 34px -10px rgba(244,63,94,0.8)' }}
      >
        {erasing ? 'Erasing...' : 'Erase this device'}
      </button>
      <GhostButton className="mt-2.5 w-full" disabled={erasing} onClick={onCancel}>
        Cancel
      </GhostButton>
      {error && <ErrorLine text={error} />}
    </div>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="mt-2.5 text-[14px] font-medium text-rose-300" role="alert">
      {text}
    </motion.p>
  );
}
