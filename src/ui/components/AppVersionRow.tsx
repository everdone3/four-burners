// Settings row: which build is running, and a manual "Check for updates" (updates also install on their own).
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { APP_VERSION, applyUpdate, checkForUpdates, useUpdateStatus, type CheckResult } from '../useAppUpdate';
import { useReducedMotion } from '../motion';
import { MoltenButton } from './sizzle';

type Local = 'idle' | 'checking' | Exclude<CheckResult, 'ready'>;

const NOTE: Record<Exclude<Local, 'idle' | 'checking'>, string> = {
  current: 'Up to date',
  offline: 'Offline. Try again later.',
  failed: 'Could not check',
  unavailable: 'Not available here',
};

export function AppVersionRow() {
  const status = useUpdateStatus();
  const reduced = useReducedMotion();
  const [local, setLocal] = useState<Local>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const check = async () => {
    clearTimeout(resetTimer.current);
    setLocal('checking');
    const result = await checkForUpdates();
    // "ready" is shown from the shared status (and usually applies right away from here). The worker reports
    // it a moment after installing, so keep saying Checking... until then instead of flashing the button.
    setLocal(result === 'ready' ? 'checking' : result);
    resetTimer.current = setTimeout(() => setLocal('idle'), 4000);
  };

  const view = status !== 'none' ? status : local;
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <div className="text-[16px]">
          Version <span className="font-mono text-[15px] text-ember tabular">{APP_VERSION}</span>
        </div>
        <div className="text-[13px] text-dim">Updates install on their own.</div>
      </div>
      {/* The live region stays mounted (screen readers skip regions inserted with their text); only its content swaps. */}
      <div className="shrink-0" aria-live="polite">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={view}
            className="flex items-center gap-2"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6, filter: 'blur(4px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -6, filter: 'blur(4px)' }}
            transition={{ duration: 0.18 }}
          >
            {view === 'idle' && (
              <button
                onClick={() => void check()}
                className="min-h-10 rounded-xl border border-line bg-raised px-3 text-[15px] font-medium transition active:scale-[0.97] active:bg-white/10"
              >
                Check for updates
              </button>
            )}
            {(view === 'checking' || view === 'applying') && (
              <span className="flex min-h-10 items-center gap-2 text-[15px] text-dim">
                <Spinner reduced={reduced} />
                {view === 'checking' ? 'Checking...' : 'Updating...'}
              </span>
            )}
            {view === 'ready' && (
              <>
                <span className="text-[15px] font-semibold text-ember">Update ready</span>
                <MoltenButton className="h-10 px-4 text-[15px]" onClick={() => applyUpdate(true)}>
                  Reload
                </MoltenButton>
              </>
            )}
            {view === 'current' && (
              <span className="flex min-h-10 items-center gap-1.5 text-[15px] font-medium text-white">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ffae3b" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ filter: 'drop-shadow(0 0 6px #ff8a3d)' }} aria-hidden>
                  <path d="M5 12.5l4.5 4.5L19 7.5" />
                </svg>
                {NOTE.current}
              </span>
            )}
            {(view === 'offline' || view === 'failed' || view === 'unavailable') && (
              <span className="flex min-h-10 items-center text-right text-[14px] text-dim">{NOTE[view]}</span>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function Spinner({ reduced }: { reduced: boolean }) {
  return (
    <motion.span
      aria-hidden
      className="h-4 w-4 rounded-full border-2 border-ember/25 border-t-ember"
      style={{ boxShadow: '0 0 10px -2px #ff8a3d' }}
      animate={reduced ? undefined : { rotate: 360 }}
      transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
    />
  );
}
