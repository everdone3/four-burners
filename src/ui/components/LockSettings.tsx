// Settings > App lock: turn the Face ID lock on or off for this device, choose when it locks, lock now.
//
// THE FACE ID LOCK IS AN ACCESS GATE, NOT ENCRYPTION. The passkey only decides whether the app opens; your
// data stays unencrypted on this device, and the copy below says so. Full statement: src/lock/webauthnLocal.ts.
//
// Turning it on and off both run a passkey prompt, so both calls happen first thing in the tap. Each
// device enrolls its own passkey; nothing here syncs.
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { disableLock, enableLock, lockNow, setIdleMinutes } from '@/lock/controller';
import { IDLE_CHOICES, type DisableResult, type EnableResult, type IdleMinutes, type LockDevice } from '@/lock/types';
import { useLockState } from '@/lock/useLock';
import { useReducedMotion } from '../motion';
import { MoltenButton } from './sizzle';
import { GhostButton } from './ui';

// ---------- Copy (pure, tested) ----------

/** What the device calls its screen-lock check. */
export function biometricName(device: LockDevice): string {
  if (device === 'iphone') return 'Face ID';
  if (device === 'mac') return 'Touch ID';
  return 'Face ID or Touch ID';
}

/** The switch row. */
export function lockRowLabel(device: LockDevice): string {
  return `Lock with ${biometricName(device)}`;
}

export function idleLabel(minutes: IdleMinutes): string {
  if (minutes === 0) return 'Immediately';
  if (minutes === 60) return '1 hour';
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/** Under "Lock after": what the choice means (it also counts time on screen without a tap). */
export function idleHint(minutes: IdleMinutes): string {
  if (minutes === 0) return 'Locks every time you leave the app, and after 1 minute without a tap.';
  // Leaving does not lock at once here: the controller locks once you have been away (or idle) this long.
  return 'Locks after this long away from the app or without a tap.';
}

const isApple = (device: LockDevice) => device !== 'other';

/** Before turning it on: what it is, and what it is not. */
export function lockExplainer(label: string, device: LockDevice): string {
  const where = isApple(device) ? 'saved in your Passwords' : 'saved in your password manager';
  return `Uses a passkey named "${label}", ${where}. It locks the app on this device. It does not encrypt your data.`;
}

/** Setting it up runs two prompts: one creates the passkey, one proves it works before the lock turns on. */
export function enableHint(device: LockDevice): string {
  const twice = 'twice: once to create the passkey and once to test it.';
  if (device === 'iphone') return `iOS will ask for Face ID ${twice}`;
  if (device === 'ipad') return `iPadOS will ask for Face ID or Touch ID ${twice}`;
  if (device === 'mac') return `Your Mac will ask for Touch ID ${twice}`;
  return `You'll be asked to confirm ${twice}`;
}

/** isUserVerifyingPlatformAuthenticatorAvailable() said no (a hint only, so "Try anyway" stays). */
export function unavailableText(device: LockDevice): string {
  if (device === 'mac') return 'Set up Touch ID or a login password and turn on iCloud Keychain to use this.';
  if (device === 'other') return 'Set a screen lock on this device to use this.';
  return 'Set a device passcode and turn on iCloud Keychain to use this.';
}

export const OTHER_HOST_TEXT = 'The lock was set up on another address of this app. Set it up here to lock this one too.';

/** The privacy shield, on or off. The switcher line is only true (and only needed) on iPhone and iPad. */
export function blurNote(device: LockDevice): string {
  const base = 'The app also blurs when you leave it.';
  if (device === 'iphone' || device === 'ipad') return `${base} The app switcher preview is taken by iOS before any app can react, so it may still show your screen.`;
  return base;
}

export type Note = { tone: 'ok' | 'warn' | 'error'; text: string };

export function enableNote(result: EnableResult): Note {
  if (result === 'ok') return { tone: 'ok', text: 'The lock is on for this device.' };
  if (result === 'cancelled') return { tone: 'warn', text: 'Cancelled. The lock is still off.' };
  return { tone: 'error', text: "Couldn't set up the lock. Try again." };
}

export function disableNote(result: DisableResult, device: LockDevice): Note {
  if (result === 'ok') {
    const how = isApple(device)
      ? 'To delete the passkey too: open the Passwords app, search "Four Burners", then Delete.'
      : 'To delete the passkey too, remove "Four Burners" from your password manager.';
    return { tone: 'ok', text: `The lock is off. ${how}` };
  }
  if (result === 'cancelled') return { tone: 'warn', text: 'Cancelled. The lock is still on.' };
  return { tone: 'error', text: "Couldn't confirm it's you. The lock is still on." };
}

const NOTE_STYLE = {
  ok: { color: '#8ef0c4', glow: '0 0 12px rgba(110,231,183,0.45)' },
  warn: { color: '#ffd27a', glow: '0 0 12px rgba(255,190,90,0.45)' },
  error: { color: '#fda4af', glow: 'none' },
} as const;

// ---------- Panel ----------

export function LockSettings() {
  const state = useLockState();
  const reduced = useReducedMotion();
  const [busy, setBusy] = useState<'enable' | 'disable' | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const on = state.phase !== 'off';
  const device = state.device;
  const name = biometricName(device);

  const enable = () => {
    if (busy) return;
    // First thing in the tap: the passkey sheet opens from here.
    let pending: Promise<EnableResult>;
    try {
      pending = enableLock();
    } catch {
      pending = Promise.resolve('failed');
    }
    setBusy('enable');
    setNote(null);
    pending
      .then(
        (r) => setNote(enableNote(r)),
        () => setNote(enableNote('failed')),
      )
      .finally(() => setBusy(null));
  };

  const disable = () => {
    if (busy) return;
    // Turning it off asks for Face ID first, from the tap.
    let pending: Promise<DisableResult>;
    try {
      pending = disableLock();
    } catch {
      pending = Promise.resolve('failed');
    }
    setBusy('disable');
    setNote(null);
    pending
      .then(
        (r) => setNote(disableNote(r, device)),
        () => setNote(disableNote('failed', device)),
      )
      .finally(() => setBusy(null));
  };

  // No switch when setting up needs a word first: a plain button carries the action instead.
  const special = !on && (state.otherHost || state.available === 'no');
  const status = busy ? `Waiting for ${name}...` : on ? `On. ${state.idleMinutes === 0 ? 'Locks right away.' : `Locks after ${idleLabel(state.idleMinutes)}.`}` : 'Off';

  return (
    <div>
      <div className="flex items-center gap-3.5">
        <LockOrb on={on} busy={!!busy} />
        <div className="min-w-0 flex-1">
          <div className="text-[16px] font-semibold">{lockRowLabel(device)}</div>
          <div className="text-[14px] text-dim">{status}</div>
        </div>
        {!special && <LockSwitch on={on} busy={!!busy} label={lockRowLabel(device)} onToggle={on ? disable : enable} />}
      </div>

      {!on && (
        <div className="mt-3.5">
          {state.otherHost && <Callout text={OTHER_HOST_TEXT} />}
          {!state.otherHost && state.available === 'no' && <Callout text={unavailableText(device)} />}
          <p className="text-[14px] leading-relaxed text-dim">{lockExplainer(state.label, device)}</p>
          <p className="mt-2 text-[14px] leading-relaxed text-dim">{enableHint(device)}</p>
          {/* The shield blurs the app on every hide, lock or no lock (controller.ts), so this is true here too. */}
          <p className="mt-2 text-[13px] leading-relaxed text-dim">{blurNote(device)}</p>
          {special && (
            <MoltenButton className="mt-4 h-13 w-full text-[17px] disabled:opacity-60" disabled={!!busy} onClick={enable}>
              {busy ? `Waiting for ${name}...` : state.otherHost ? 'Set it up here' : 'Try anyway'}
            </MoltenButton>
          )}
        </div>
      )}

      {on && (
        <div className="mt-3">
          <div className="flex items-center justify-between gap-4 py-2">
            <div className="min-w-0">
              <div className="text-[16px]">Lock after</div>
              <div className="text-[13px] text-dim">{idleHint(state.idleMinutes)}</div>
            </div>
            <select
              aria-label="Lock after"
              className="shrink-0 rounded-xl border border-line bg-raised px-3 py-2"
              value={state.idleMinutes}
              onChange={(e) => setIdleMinutes(Number(e.target.value) as IdleMinutes)}
            >
              {IDLE_CHOICES.map((m) => (
                <option key={m} value={m}>
                  {idleLabel(m)}
                </option>
              ))}
            </select>
          </div>
          <GhostButton className="mt-2 flex w-full items-center justify-center gap-2" disabled={!!busy} onClick={() => lockNow()}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
              <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
            </svg>
            Lock now
          </GhostButton>
          <p className="mt-3 text-[13px] leading-relaxed text-dim">Passkey: {state.label}</p>
          <p className="mt-1 text-[13px] leading-relaxed text-dim">{blurNote(device)}</p>
        </div>
      )}

      {/* One live region that stays mounted, so each new note is announced. */}
      <div role="status" aria-live="polite">
        <AnimatePresence mode="wait" initial={false}>
          {note && (
            <motion.p
              key={note.text}
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              className="mt-3 text-[15px] leading-snug font-semibold"
              style={{ color: NOTE_STYLE[note.tone].color, textShadow: NOTE_STYLE[note.tone].glow }}
            >
              {note.text}
            </motion.p>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function Callout({ text }: { text: string }) {
  return (
    <div className="mb-3 rounded-2xl border border-amber-300/25 bg-amber-300/[0.07] px-3.5 py-2.5 text-[14px] text-amber-100" role="note">
      {text}
    </div>
  );
}

/** Glowing lock tile: molten while on, cold while off, pulsing while a prompt is up. */
function LockOrb({ on, busy }: { on: boolean; busy: boolean }) {
  const reduced = useReducedMotion();
  const lit = on || busy;
  return (
    <motion.span
      aria-hidden
      className="grid h-13 w-13 shrink-0 place-items-center rounded-2xl"
      style={{
        background: lit ? 'radial-gradient(circle at 50% 30%, rgba(255,174,59,0.42), rgba(255,90,31,0.12))' : 'radial-gradient(circle at 50% 30%, rgba(255,255,255,0.12), rgba(255,255,255,0.03))',
        color: lit ? '#ffd9a0' : '#a8a8b3',
      }}
      animate={
        reduced || !lit
          ? { boxShadow: lit ? '0 0 18px -4px rgba(255,140,50,0.6)' : '0 0 0px 0px rgba(255,140,50,0)' }
          : { boxShadow: ['0 0 14px -4px rgba(255,140,50,0.45)', '0 0 28px -2px rgba(255,140,50,0.9)', '0 0 14px -4px rgba(255,140,50,0.45)'] }
      }
      transition={reduced || !lit ? { duration: 0.3 } : { duration: busy ? 1.1 : 2.8, repeat: Infinity, ease: 'easeInOut' }}
    >
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
        {on ? <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /> : <path d="M8 10.5V8a4 4 0 0 1 7.6-1.7" />}
        <path d="M12 14.5v2" />
      </svg>
    </motion.span>
  );
}

function LockSwitch({ on, busy, label, onToggle }: { on: boolean; busy: boolean; label: string; onToggle: () => void }) {
  const reduced = useReducedMotion();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={busy}
      onClick={onToggle}
      className="relative h-8 w-13 shrink-0 rounded-full transition"
      style={{
        background: on ? 'linear-gradient(90deg, #ffb454, #ff6a2b)' : 'rgba(255,255,255,0.15)',
        boxShadow: on || busy ? '0 0 16px -2px #ff8a3d' : undefined,
        animation: busy && !reduced ? 'glow-pulse 1.1s ease-in-out infinite' : undefined,
      }}
    >
      <span className="absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-all" style={{ left: on ? 24 : 4 }} />
    </button>
  );
}
