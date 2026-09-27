// Settings > Developer > Lock diagnostics: the lock controller's on-device log (getLockLog) and a snapshot
// of its state, with a Copy button, for troubleshooting Face ID on the phone without Web Inspector.
// The lock is an access gate, not encryption (see src/lock/webauthnLocal.ts). The log holds events and
// short details only: no keys, no challenges, no data.
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { getLockLog } from '@/lock/controller';
import type { LockLogEntry, LockState } from '@/lock/types';
import { useLockState } from '@/lock/useLock';
import { useReducedMotion } from '../motion';
import { GhostButton } from './ui';

const REFRESH_MS = 2_000;

/** "Sep 27, 08:14:03.271" in local time. */
export function fmtLogTime(at: number): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '?';
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${day}, ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** The state line at the top of the copied text. */
export function describeLockState(s: LockState): string {
  return [
    `phase=${s.phase}`,
    `coldStart=${s.coldStart}`,
    `failures=${s.failures}`,
    `idle=${s.idleMinutes}m`,
    `device=${s.device}`,
    `available=${s.available}`,
    `otherHost=${s.otherHost}`,
  ].join(' ');
}

/** Plain text for the clipboard: environment, state, then the log oldest first. */
export function formatLockLog(entries: LockLogEntry[], state: LockState, env: string[] = []): string {
  const lines = entries.map((e) => `${fmtLogTime(e.at)}  ${e.event}${e.detail ? `  ${e.detail}` : ''}`);
  return ['Four Burners lock diagnostics', ...env, describeLockState(state), '', ...(lines.length ? lines : ['(no entries)'])].join('\n');
}

function environment(): string[] {
  if (typeof navigator === 'undefined' || typeof document === 'undefined') return [];
  const standalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    (typeof matchMedia !== 'undefined' && matchMedia('(display-mode: standalone)').matches);
  return [
    `at=${new Date().toISOString()} host=${location.hostname} standalone=${standalone}`,
    `visibility=${document.visibilityState} focus=${document.hasFocus()} webauthn=${typeof PublicKeyCredential !== 'undefined'}`,
    `ua=${navigator.userAgent}`,
  ];
}

function readLog(): LockLogEntry[] {
  try {
    return getLockLog();
  } catch {
    return [];
  }
}

export function LockDiagnostics() {
  const state = useLockState();
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<LockLogEntry[]>([]);
  const [copied, setCopied] = useState<string | null>(null);

  // The log lives in localStorage and grows without a state change, so poll while it is open.
  useEffect(() => {
    if (!open) return;
    setEntries(readLog());
    const id = setInterval(() => setEntries(readLog()), REFRESH_MS);
    return () => clearInterval(id);
  }, [open, state]);

  const copy = async () => {
    const text = formatLockLog(readLog(), state, environment());
    try {
      await navigator.clipboard.writeText(text);
      setCopied('Copied');
    } catch {
      // Older WebKit, or no permission: the classic way, from the same tap.
      const area = document.createElement('textarea');
      area.value = text;
      area.readOnly = true;
      area.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      area.remove();
      setCopied(ok ? 'Copied' : "Couldn't copy. Select the lines instead.");
    }
    setTimeout(() => setCopied(null), 2_500);
  };

  const newestFirst = [...entries].reverse();
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-11 w-full items-center justify-between gap-3 text-left"
      >
        <span>
          <span className="block text-[15px] font-semibold">Lock diagnostics</span>
          <span className="block text-[13px] text-dim">What the Face ID lock did on this device, for troubleshooting.</span>
        </span>
        <motion.svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          aria-hidden
          className="shrink-0 text-dim"
          animate={{ rotate: open ? 90 : 0 }}
          transition={{ duration: reduced ? 0 : 0.2 }}
        >
          <path d="M9 6l6 6-6 6" />
        </motion.svg>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="log"
            initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, height: 'auto' }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={{ duration: 0.22 }}
            className="overflow-hidden"
          >
            <p className="mt-2 font-mono text-[12px] leading-relaxed wrap-break-word text-dim">{describeLockState(state)}</p>
            <div className="mt-2 max-h-72 overflow-y-auto overscroll-contain rounded-2xl border border-line bg-black/40 p-3 select-text">
              {newestFirst.length === 0 ? (
                <p className="text-[13px] text-dim">No entries yet.</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {newestFirst.map((e, i) => (
                    <li key={`${e.at}-${i}`} className="font-mono text-[12px] leading-snug">
                      <span className="text-dim tabular">{fmtLogTime(e.at)}</span> <span className="font-semibold text-amber-100">{e.event}</span>
                      {e.detail && <span className="block wrap-break-word text-dim">{e.detail}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="mt-2.5 flex items-center gap-3">
              <GhostButton className="px-5" onClick={() => void copy()}>
                Copy
              </GhostButton>
              <span role="status" aria-live="polite" className="text-[14px] font-medium text-teal-200">
                {copied}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
