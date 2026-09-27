// The app lock gate (Phase 6): puts the lock screen in front of the app and keeps the app out of reach
// while this device is locked.
//
// THE FACE ID LOCK IS AN ACCESS GATE, NOT ENCRYPTION. The data stays unencrypted on this device, and the
// app keeps running behind the lock (sync still pulls and pushes). This only stops someone holding your
// unlocked device from casually opening the app. Full statement: src/lock/webauthnLocal.ts.
//
// Two layers inside #root:
// - #app-layer holds the app. On a cold start that begins locked it is not mounted at all, so no screen,
//   query or effect of the app runs until the first unlock. Once mounted it stays mounted (a re-lock keeps
//   your place): while locked it is inert and aria-hidden, and the lock CSS (html[data-lock], set by
//   index.html before any paint and then by the controller) hides it.
// - #lock-layer holds the lock screen and the note shown after an email-code recovery.
// The app gets its own error boundary inside #app-layer, so a crash in a screen can never take the lock
// screen down with it (main.tsx's outer boundary only sees errors in the gate and the lock screen).
// startLock() runs in main.tsx before the first render.
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import type { LockPhase } from '@/lock/types';
import { useLockState } from '@/lock/useLock';
import { spring, useReducedMotion } from '../motion';
import { ErrorBoundary } from './ErrorBoundary';
import { LockScreen, clearRecoveryDraft } from './LockScreen';

const NOTE_MS = 9_000;

/** The app is open: no lock on this device, or unlocked. */
export function isOpenPhase(phase: LockPhase): boolean {
  return phase === 'unlocked' || phase === 'off';
}

/**
 * What the gate shows. open: the app is reachable and the lock screen is gone. mount: the app may be
 * mounted now (once mounted it stays). A locked cold start never mounts it before the first unlock, and
 * after "Reset this device" (leaving) nothing opens or mounts in the moment before the page reloads.
 */
export function gateDecision(phase: LockPhase, coldStart: boolean, leaving: boolean): { open: boolean; mount: boolean } {
  const open = isOpenPhase(phase) && !leaving;
  return { open, mount: !leaving && (open || !coldStart) };
}

export function LockGate({ children }: { children: ReactNode }) {
  const state = useLockState();
  const [leaving, setLeaving] = useState(false);
  const { open, mount } = gateDecision(state.phase, state.coldStart, leaving);
  // Mount the app once it has been open (or was never held back by a cold start), then keep it.
  const [mounted, setMounted] = useState(mount);
  if (!mounted && mount) setMounted(true);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(id);
  }, [note]);

  // A recovery code sent earlier is moot once the app is open (Face ID worked after all). Left behind, it
  // would bring up "Can't unlock?" and the code step at once on the next lock, for up to an hour.
  useEffect(() => {
    if (open) clearRecoveryDraft();
  }, [open]);

  // Synchronous, so this render lands before the one resetLock() triggers (a store update can render
  // ahead of an ordinary state update).
  const onLeaving = () => flushSync(() => setLeaving(true));

  return (
    <>
      <div id="app-layer" className="h-full" inert={!open} aria-hidden={open ? undefined : true}>
        {mounted && <ErrorBoundary>{children}</ErrorBoundary>}
      </div>
      {/* Taps pass through while the lock screen plays its exit. */}
      <div id="lock-layer" style={open ? { pointerEvents: 'none' } : undefined}>
        <AnimatePresence>{!open && <LockScreen key="lock" state={state} onRecovered={setNote} onLeaving={onLeaving} />}</AnimatePresence>
        <AnimatePresence>{note && <RecoveryNote key="note" text={note} onDismiss={() => setNote(null)} />}</AnimatePresence>
        {/* Stays mounted, so screen readers announce the note (they skip live regions inserted with their text). */}
        <div role="status" aria-live="polite" className="sr-only">
          {note}
        </div>
      </div>
    </>
  );
}

/** A toast of its own: the app's ToastProvider may not be mounted yet when recovery finishes. */
function RecoveryNote({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  const reduced = useReducedMotion();
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[101] flex justify-center px-4 pb-[calc(max(env(safe-area-inset-bottom),16px)+24px)]">
      <motion.div
        initial={reduced ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={reduced ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.96 }}
        transition={spring}
        className="pointer-events-auto relative flex w-full max-w-md items-center gap-2 overflow-hidden rounded-2xl border border-white/10 bg-[#141416]/95 py-2 pr-2 pl-4 shadow-[0_10px_40px_-8px_rgba(0,0,0,0.9)] backdrop-blur-xl"
        style={{ boxShadow: '0 0 0 1px rgba(94,234,212,0.18), 0 10px 40px -10px rgba(94,234,212,0.35)' }}
      >
        <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full bg-teal-300" style={{ boxShadow: '0 0 10px 2px rgba(94,234,212,0.6)' }} />
        <span className="flex-1 text-[15px] leading-snug">{text}</span>
        <button type="button" onClick={onDismiss} className="min-h-11 rounded-xl px-3.5 text-[15px] font-bold text-ember active:bg-white/10">
          OK
        </button>
      </motion.div>
    </div>
  );
}
