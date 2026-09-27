// "Sync across devices": sign in with an emailed code, then a live status line with a glowing orb.
// Shown in Settings and in the onboarding "Sign in to sync" sheet. Everything here reads the sync
// manager's status store, so it updates live as runs start, finish, go offline, or fail.
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { SIGN_IN_MESSAGES, SignInError, isValidEmail, normalizeCode, parseSignInLink } from '@/sync/auth';
import { sendCode, signOut, startSync, syncNow, verifyCode } from '@/sync/manager';
import type { SyncStatus } from '@/sync/types';
import { describeSyncStatus, pendingNote, useSyncStatus } from '@/sync/useSync';
import { sfx } from '../fx/audio';
import { haptic } from '../fx/haptics';
import { useReducedMotion } from '../motion';
import { MoltenButton } from './sizzle';
import { GhostButton, inputClass } from './ui';

const RESEND_MS = 60_000;
// Codes stay valid for an hour, so a code step survives iOS reloading the app while you check Mail.
const DRAFT_KEY = 'fb-sync-signin';
const DRAFT_MAX_AGE_MS = 60 * 60_000;

interface Draft {
  email: string;
  sentAt: number;
}

function readDraft(): Draft | null {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as Draft | null;
    return d && typeof d.email === 'string' && Date.now() - d.sentAt < DRAFT_MAX_AGE_MS ? d : null;
  } catch {
    return null;
  }
}

function writeDraft(d: Draft | null) {
  try {
    if (d) localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    // storage unavailable
  }
}

/** Current time, ticking every `ms` (or frozen when null). */
function useNow(ms: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (ms === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export function SyncPanel() {
  const status = useSyncStatus();
  const reduced = useReducedMotion();
  // Safe to call repeatedly; covers a build that forgot to start sync at boot.
  useEffect(() => {
    void startSync();
  }, []);

  const view = status.state === 'unconfigured' ? 'unconfigured' : status.state === 'signedOut' ? 'signin' : 'status';
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={view}
        initial={reduced ? { opacity: 0 } : { opacity: 0, y: 10, filter: 'blur(6px)' }}
        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
        exit={reduced ? { opacity: 0 } : { opacity: 0, y: -8, filter: 'blur(6px)' }}
        transition={{ duration: 0.25 }}
      >
        {view === 'unconfigured' && <Unconfigured />}
        {view === 'signin' && <SignIn notice={status.error} />}
        {view === 'status' && <Status status={status} />}
      </motion.div>
    </AnimatePresence>
  );
}

function Unconfigured() {
  return (
    <div>
      <p className="text-[15px] text-dim">Sync isn't set up in this build yet.</p>
      {import.meta.env.DEV && (
        <p className="mt-1.5 text-[13px] text-dim">Developer: add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY to .env.local, then restart the dev server.</p>
      )}
    </div>
  );
}

// ---------- Signed out: email, then code ----------

/** Shown on the code step when a send was refused for asking too soon: the earlier code still works. */
export const CODE_SENT_RECENTLY = 'A code was sent recently. Enter it here, or request a new one when the timer ends.';

/** Where a failed send leaves the panel, and the line it shows there. */
export function sendFailure(e: unknown): { codeStep: boolean; message: string } {
  // A code went out moments ago: go use it (the countdown shows when a new one is allowed).
  if (e instanceof SignInError && e.code === 'rate_limit') return { codeStep: true, message: CODE_SENT_RECENTLY };
  return { codeStep: false, message: e instanceof SignInError ? e.message : SIGN_IN_MESSAGES.unknown };
}

function SignIn({ notice }: { notice?: string }) {
  const [saved] = useState(readDraft);
  const [step, setStep] = useState<'email' | 'code'>(saved ? 'code' : 'email');
  const [email, setEmail] = useState(saved?.email ?? '');
  const [code, setCode] = useState('');
  const [sentAt, setSentAt] = useState(saved?.sentAt ?? 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Focus the code field when this panel just sent a code, not when a saved code step is restored.
  const [focusCode, setFocusCode] = useState(false);
  const busyRef = useRef(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const now = useNow(step === 'code' ? 1000 : null);
  const wait = Math.max(0, Math.ceil((sentAt + RESEND_MS - now) / 1000));
  const reduced = useReducedMotion();

  const fail = (e: unknown) => setError(e instanceof SignInError ? e.message : SIGN_IN_MESSAGES.unknown);

  const toCodeStep = (address: string) => {
    const t = Date.now();
    setSentAt(t);
    writeDraft({ email: address, sentAt: t });
    setCode('');
    setFocusCode(true);
    setStep('code');
  };

  const send = async () => {
    if (busyRef.current) return;
    const address = email.trim();
    if (!isValidEmail(address)) {
      setError(SIGN_IN_MESSAGES.invalid_email);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await sendCode(address);
      sfx.whoosh();
      haptic();
      toCodeStep(address);
    } catch (e) {
      const f = sendFailure(e);
      if (f.codeStep) toCodeStep(address);
      setError(f.message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const verify = async (value: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await verifyCode(email, value);
      writeDraft(null);
      haptic('success');
      sfx.whoosh();
      // The panel switches to the signed-in view as the status changes.
    } catch (e) {
      fail(e);
      requestAnimationFrame(() => codeRef.current?.select());
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const changeEmail = () => {
    writeDraft(null);
    setStep('email');
    setCode('');
    setError(null);
  };

  return (
    <AnimatePresence mode="wait" initial={false}>
      {step === 'email' ? (
        <motion.form
          key="email"
          noValidate
          initial={reduced ? { opacity: 0 } : { opacity: 0, x: -16 }}
          animate={{ opacity: 1, x: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, x: -16 }}
          transition={{ duration: 0.22 }}
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {notice && <Notice text={notice} />}
          <p className="text-[15px] leading-relaxed text-dim">
            Sign in with your email to keep your iPhone, iPad and Mac in step. Works offline; changes sync when you're back online.
          </p>
          <input
            className={`${inputClass} mt-4`}
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="send"
            placeholder="you@example.com"
            aria-label="Email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setError(null);
            }}
          />
          {error && <ErrorLine text={error} />}
          <MoltenButton type="submit" disabled={busy} className="mt-4 h-14 w-full text-[17px] disabled:opacity-60">
            {busy ? 'Sending...' : 'Send code'}
          </MoltenButton>
        </motion.form>
      ) : (
        <motion.form
          key="code"
          noValidate
          initial={reduced ? { opacity: 0 } : { opacity: 0, x: 16 }}
          animate={{ opacity: 1, x: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, x: 16 }}
          transition={{ duration: 0.22 }}
          onSubmit={(e) => {
            e.preventDefault();
            void verify(code);
          }}
        >
          <p className="text-[15px] leading-relaxed text-dim">
            Enter the code we emailed to <span className="font-semibold wrap-break-word text-white">{email}</span>.
          </p>
          <CodeInput
            inputRef={codeRef}
            autoFocus={focusCode}
            value={code}
            busy={busy}
            onChange={(next, jumped) => {
              setCode(next);
              setError(null);
              // Autofill or paste drops the whole code in one go: sign in without a tap.
              if (jumped && normalizeCode(next)) void verify(next);
            }}
            onSubmitText={(text) => {
              setCode(parseSignInLink(text) ? '' : text);
              void verify(text);
            }}
          />
          <p className="mt-2 text-[13px] text-dim">Got a link instead of a code? Paste it here.</p>
          {error && <ErrorLine text={error} />}
          <MoltenButton type="submit" disabled={busy} className="mt-4 h-14 w-full text-[17px] disabled:opacity-60">
            {busy ? 'Signing in...' : 'Sign in'}
          </MoltenButton>
          <div className="mt-3 flex items-center justify-between gap-2">
            <button type="button" onClick={changeEmail} className="min-h-11 px-1 text-[15px] text-dim active:text-white">
              Use a different email
            </button>
            <button
              type="button"
              disabled={wait > 0 || busy}
              onClick={() => void send()}
              className="min-h-11 px-1 text-[15px] font-semibold text-ember disabled:font-normal disabled:text-faint tabular"
            >
              {wait > 0 ? `New code in ${wait}s` : 'Send a new code'}
            </button>
          </div>
        </motion.form>
      )}
    </AnimatePresence>
  );
}

function CodeInput({
  inputRef,
  autoFocus,
  value,
  busy,
  onChange,
  onSubmitText,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  autoFocus: boolean;
  value: string;
  busy: boolean;
  onChange: (next: string, jumped: boolean) => void;
  onSubmitText: (text: string) => void;
}) {
  const [focused, setFocused] = useState(false);
  const reduced = useReducedMotion();
  const digits = value.replace(/\D/g, '').length;
  const glow = focused || busy;
  return (
    <div className="relative mt-4">
      <motion.div
        aria-hidden
        className="pointer-events-none absolute -inset-px rounded-2xl"
        animate={{ opacity: glow ? 1 : 0 }}
        transition={{ duration: 0.25 }}
        style={{
          boxShadow: '0 0 0 1.5px #ff9a3c, 0 0 28px -4px rgba(255,140,50,0.7)',
          animation: glow && !reduced ? 'glow-pulse 2.4s ease-in-out infinite' : undefined,
        }}
      />
      <input
        ref={inputRef}
        autoFocus={autoFocus}
        className="relative w-full rounded-2xl border border-line bg-raised px-4 py-4 text-center font-display text-[30px] font-bold tracking-[0.32em] text-white outline-none placeholder:font-normal placeholder:tracking-[0.3em] placeholder:text-white/20 tabular"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={10}
        enterKeyHint="go"
        placeholder="000000"
        aria-label="Code from the email"
        value={value}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          const next = e.target.value;
          const added = next.replace(/\D/g, '').length - digits;
          onChange(next, added >= 2 && next.replace(/\D/g, '').length >= 6);
        }}
        onPaste={(e) => {
          // "Copy Link" in Mail may put the link on the pasteboard only as a URL, not as plain text.
          const text = e.clipboardData.getData('text') || e.clipboardData.getData('text/uri-list');
          // A sign-in link (or "Your code is 123456") is longer than the field allows: handle it here.
          if (parseSignInLink(text)) {
            e.preventDefault();
            onSubmitText(text);
            return;
          }
          const found = text.match(/\d[\d \-]{4,14}\d/)?.[0];
          const code = found ? normalizeCode(found) : null;
          if (code && code !== text.trim()) {
            e.preventDefault();
            onSubmitText(code);
          }
        }}
      />
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

function Notice({ text }: { text: string }) {
  return (
    <div className="mb-3 rounded-2xl border border-amber-300/25 bg-amber-300/[0.07] px-3.5 py-2.5 text-[14px] text-amber-100" role="status">
      {text}
    </div>
  );
}

// ---------- Signed in: live status ----------

type Tone = 'ok' | 'busy' | 'offline' | 'error';

const TONES: Record<Tone, { color: string; glow: string }> = {
  ok: { color: '#5eead4', glow: 'rgba(94,234,212,0.55)' },
  busy: { color: '#ffae3b', glow: 'rgba(255,160,60,0.65)' },
  offline: { color: '#a5b4cf', glow: 'rgba(165,180,207,0.35)' },
  error: { color: '#ff7a8f', glow: 'rgba(255,110,130,0.6)' },
};

function toneOf(s: SyncStatus): Tone {
  if (s.state === 'syncing') return 'busy';
  if (s.state === 'offline') return 'offline';
  if (s.state === 'error') return 'error';
  return 'ok';
}

function Status({ status }: { status: SyncStatus }) {
  const now = useNow(30_000);
  // Quick runs finish before "Syncing..." would even be readable: keep the last settled line for them.
  const [settled, setSettled] = useState(status);
  useEffect(() => {
    if (status.state !== 'syncing') setSettled(status);
  }, [status]);
  const [showSyncing, setShowSyncing] = useState(false);
  useEffect(() => {
    if (status.state !== 'syncing') {
      setShowSyncing(false);
      return;
    }
    const id = setTimeout(() => setShowSyncing(true), 450);
    return () => clearTimeout(id);
  }, [status.state]);
  const shown: SyncStatus = status.state === 'syncing' && !showSyncing ? { ...settled, pending: status.pending } : status;
  const tone = toneOf(shown);
  const t = TONES[tone];
  const note = pendingNote(shown);
  const [syncTapped, setSyncTapped] = useState(false);
  // Signing out tells the server first; on plane Wi-Fi with no internet that waits for the request timeout.
  const [signingOut, setSigningOut] = useState(false);

  return (
    <div>
      <div
        className="relative overflow-hidden rounded-2xl px-4 py-3.5"
        style={{
          background: `radial-gradient(120% 160% at 0% 0%, ${t.color}24, transparent 62%), rgba(255,255,255,0.02)`,
          boxShadow: `inset 0 0 0 1px ${t.color}38, 0 0 34px -18px ${t.glow}`,
          transition: 'background 0.6s ease, box-shadow 0.6s ease',
        }}
      >
        <div className="flex items-center gap-3.5">
          <StatusOrb tone={tone} />
          <div className="min-w-0 flex-1">
            {/* The live region stays mounted (screen readers skip regions inserted with their text); only the line inside swaps. */}
            <div aria-live="polite" aria-atomic="true">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={describeSyncStatus(shown, now)}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.18 }}
                  className="text-[17px] leading-snug font-semibold"
                  style={{ color: tone === 'error' ? '#ffd0d7' : '#fff' }}
                >
                  {describeSyncStatus(shown, now)}
                </motion.div>
              </AnimatePresence>
            </div>
            {status.email && <div className="mt-0.5 truncate text-[13px] text-dim">{status.email}</div>}
            {note && <div className="mt-0.5 text-[13px] font-medium text-amber-200">{note}</div>}
          </div>
        </div>
      </div>
      <div className="mt-3 flex gap-2.5">
        <GhostButton
          className="flex flex-1 items-center justify-center gap-2"
          disabled={status.state === 'syncing' && syncTapped}
          onClick={async () => {
            sfx.tick();
            haptic();
            setSyncTapped(true);
            try {
              await syncNow();
            } finally {
              setSyncTapped(false);
            }
          }}
        >
          <SyncIcon spinning={status.state === 'syncing' && showSyncing} />
          Sync now
        </GhostButton>
        <GhostButton
          className="px-5 text-rose-300"
          disabled={signingOut}
          onClick={() => {
            if (!confirm('Sign out on this device? Your data stays here.')) return;
            setSigningOut(true);
            void signOut().finally(() => setSigningOut(false));
          }}
        >
          {signingOut ? 'Signing out...' : 'Sign out'}
        </GhostButton>
      </div>
    </div>
  );
}

/** Glowing status orb: breathes when settled, spins a molten ring while syncing, pulses on errors. */
function StatusOrb({ tone }: { tone: Tone }) {
  const reduced = useReducedMotion();
  const t = TONES[tone];
  return (
    <div className="relative grid h-11 w-11 shrink-0 place-items-center" aria-hidden>
      <motion.span
        className="absolute inset-0 rounded-full"
        style={{ background: `radial-gradient(circle, ${t.glow} 0%, transparent 68%)` }}
        animate={reduced || tone === 'offline' ? { scale: 1, opacity: 0.7 } : { scale: tone === 'error' ? [1, 1.35, 1] : [1, 1.18, 1], opacity: [0.55, 1, 0.55] }}
        transition={{ duration: tone === 'error' ? 1.2 : tone === 'busy' ? 1 : 2.8, repeat: Infinity, ease: 'easeInOut' }}
      />
      {tone === 'busy' && (
        <motion.span
          className="absolute inset-[5px] rounded-full"
          style={{
            background: `conic-gradient(from 0deg, transparent 0deg, ${t.color} 90deg, transparent 200deg)`,
            WebkitMask: 'radial-gradient(circle, transparent 55%, #000 58%)',
            mask: 'radial-gradient(circle, transparent 55%, #000 58%)',
          }}
          animate={reduced ? undefined : { rotate: 360 }}
          transition={{ duration: 0.9, repeat: Infinity, ease: 'linear' }}
        />
      )}
      <motion.span
        className="relative h-3.5 w-3.5 rounded-full"
        initial={reduced ? false : { scale: 0 }}
        animate={{ scale: 1, backgroundColor: t.color }}
        transition={{ type: 'spring', stiffness: 420, damping: 18 }}
        style={{ boxShadow: `0 0 10px 2px ${t.glow}, inset 0 0 3px rgba(255,255,255,0.9)` }}
      />
    </div>
  );
}

function SyncIcon({ spinning }: { spinning: boolean }) {
  const reduced = useReducedMotion();
  return (
    <motion.svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      animate={spinning && !reduced ? { rotate: 360 } : { rotate: 0 }}
      transition={spinning ? { duration: 1, repeat: Infinity, ease: 'linear' } : { duration: 0.3 }}
    >
      <path d="M21 12a9 9 0 0 1-15.4 6.4L3 16" />
      <path d="M3 21v-5h5" />
      <path d="M3 12a9 9 0 0 1 15.4-6.4L21 8" />
      <path d="M21 3v5h-5" />
    </motion.svg>
  );
}
