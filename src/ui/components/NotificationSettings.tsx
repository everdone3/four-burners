// Settings > Notifications: turn push on or off for this device, send a test, and choose what arrives when.
// The schedule (daily, weekly, nudges, quiet hours) is part of Settings, so it syncs and every device shares
// it; each device opts in to receiving for itself. Sending happens on the server (src/server/notify).
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { inQuietHours, parseTime, type NotifyPrefs, type ReminderPref, type Settings } from '@/domain';
import { saveSettings } from '@/data/repo';
import { detectDevice, sendTestPush, turnOffPush, turnOnPush, usePushState, type Availability, type EnableResult, type PushDeviceState } from '@/notify/push';
import { timeAgo } from '@/sync/useSync';
import { useReducedMotion } from '../motion';
import { MoltenButton } from './sizzle';
import { GhostButton, Row, Toggle } from './ui';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// ---------- Copy (pure, tested) ----------

/** Why this device can't turn notifications on, or null when it can. */
export function availabilityText(av: Availability, device: string): string | null {
  switch (av) {
    case 'unconfigured':
      return "Notifications aren't set up in this build. See README > Notifications.";
    case 'needsInstall':
      return `On ${device === 'iPad' ? 'iPad' : 'iPhone'}, notifications need the Home Screen app: tap Share, then Add to Home Screen, and open Four Burners from there.`;
    case 'unsupported':
      return "This browser can't receive notifications here. Open the installed app (a production build).";
    case 'signedOut':
      return 'Reminders come from your sync server. Sign in under Sync across devices first.';
    case 'denied':
      return `Notifications are blocked for Four Burners. Turn them on in ${device === 'Mac' ? 'System Settings' : 'iOS Settings'} > Notifications > Four Burners, then come back.`;
    default:
      return null;
  }
}

/** The status line under "Notifications on this device". */
export function deviceStatusText(s: PushDeviceState, device: string, now = Date.now()): string {
  if (s.checking) return 'Checking...';
  if (!s.subscribed) return s.server?.gone ? 'Stopped. iOS dropped this device. Turn it on again.' : 'Off';
  const err = s.server?.lastError;
  const errAt = s.server?.lastErrorAt;
  const sent = s.server?.lastSentAt;
  if (err && errAt && (!sent || Date.parse(errAt) > Date.parse(sent))) return `On, but the last one didn't arrive (${timeAgo(errAt, now)}). Try a test.`;
  return sent ? `On for this ${device}. Last one ${timeAgo(sent, now)}.` : `On for this ${device}.`;
}

export type Note = { tone: 'ok' | 'warn' | 'error'; text: string };

export function enableNote(r: EnableResult): Note {
  if (r === 'ok') return { tone: 'ok', text: 'Notifications are on for this device.' };
  if (r === 'denied') return { tone: 'warn', text: 'Notifications were not allowed. You can allow them later in Settings > Notifications.' };
  if (r === 'unavailable') return { tone: 'warn', text: "This device can't turn notifications on right now." };
  return { tone: 'error', text: "Couldn't turn notifications on. Check your connection and try again." };
}

/** A reminder time that falls inside quiet hours never arrives on time. */
export function quietClash(r: ReminderPref, quiet: NotifyPrefs['quiet']): boolean {
  const t = parseTime(r.time);
  return r.on && t !== null && inQuietHours(t, quiet);
}

const NOTE_STYLE = {
  ok: { color: '#8ef0c4', glow: '0 0 12px rgba(110,231,183,0.45)' },
  warn: { color: '#ffd27a', glow: '0 0 12px rgba(255,190,90,0.45)' },
  error: { color: '#fda4af', glow: 'none' },
} as const;

const timeInput = 'shrink-0 rounded-xl border border-line bg-raised px-3 py-2 text-[16px] [color-scheme:dark] disabled:opacity-40';

// ---------- Panel ----------

export function NotificationSettings({ settings }: { settings: Settings }) {
  const push = usePushState();
  const reduced = useReducedMotion();
  const [busy, setBusy] = useState<'on' | 'off' | 'test' | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const prefs = settings.notify;
  const device = detectDevice();
  const blocker = push.checking ? null : availabilityText(push.availability, device);
  const save = (patch: Partial<NotifyPrefs>) => void saveSettings({ notify: { ...prefs, ...patch } });

  const turnOn = () => {
    if (busy) return;
    // First thing in the tap: iOS only shows the permission prompt from a user gesture.
    const pending = turnOnPush().catch((): EnableResult => 'failed');
    setBusy('on');
    setNote(null);
    pending.then((r) => setNote(enableNote(r))).finally(() => setBusy(null));
  };
  const turnOff = () => {
    if (busy) return;
    setBusy('off');
    setNote(null);
    turnOffPush()
      .then(() => setNote({ tone: 'ok', text: 'Notifications are off for this device.' }))
      .catch(() => setNote({ tone: 'error', text: "Couldn't turn notifications off. Try again." }))
      .finally(() => setBusy(null));
  };
  const test = () => {
    if (busy) return;
    setBusy('test');
    setNote(null);
    sendTestPush()
      .then((r) => setNote(r.ok ? { tone: 'ok', text: 'Sent. It should arrive in a few seconds.' } : { tone: 'error', text: r.message }))
      .finally(() => setBusy(null));
  };

  const canToggle = push.availability === 'ready' || push.subscribed;
  const status = busy === 'on' ? 'Turning on...' : busy === 'off' ? 'Turning off...' : deviceStatusText(push, device);

  return (
    <div>
      <div className="flex items-center gap-3.5">
        <BellOrb on={push.subscribed} busy={busy === 'on' || busy === 'off'} />
        <div className="min-w-0 flex-1">
          <div className="text-[16px] font-semibold">Notifications on this {device === 'Browser' ? 'device' : device}</div>
          <div className="text-[14px] text-dim">{status}</div>
        </div>
        {canToggle && push.subscribed && <Toggle checked label="Notifications on this device" disabled={!!busy} onChange={turnOff} />}
      </div>

      {blocker && !push.subscribed && (
        <div className="mt-3.5 rounded-2xl border border-amber-300/25 bg-amber-300/[0.07] px-3.5 py-2.5 text-[14px] text-amber-100" role="note">
          {blocker}
        </div>
      )}

      {canToggle && !push.subscribed && !push.checking && (
        <>
          <MoltenButton className="mt-4 h-13 w-full text-[17px] disabled:opacity-60" disabled={!!busy} onClick={turnOn}>
            {busy === 'on' ? 'Waiting...' : push.server?.gone ? 'Turn on again' : 'Turn on notifications'}
          </MoltenButton>
          <p className="mt-2.5 text-[13px] leading-relaxed text-dim">Each device turns them on for itself. The schedule below is shared by all of them.</p>
        </>
      )}

      {push.subscribed && (
        <GhostButton className="mt-3 w-full" disabled={!!busy} onClick={test}>
          {busy === 'test' ? 'Sending...' : 'Send a test notification'}
        </GhostButton>
      )}

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

      {push.availability !== 'unconfigured' && (
        <div className="mt-4 border-t border-white/[0.08] pt-2">
          <ReminderRow
            label="Daily check-in"
            hint="Skipped on days you already checked in, and during Travel/Crunch."
            pref={prefs.daily}
            clash={quietClash(prefs.daily, prefs.quiet)}
            onChange={(daily) => save({ daily })}
          />
          <ReminderRow
            label="Weekly review"
            hint={`${DAYS[settings.reviewDay]}s, your review day. Skipped once the review is done.`}
            pref={prefs.weekly}
            clash={quietClash(prefs.weekly, prefs.quiet)}
            onChange={(weekly) => save({ weekly })}
          />
          <Row label="Smart nudges" hint="When a burner slips against its intent or someone is overdue. One a day at most, never during Travel/Crunch.">
            <Toggle checked={prefs.nudges} label="Smart nudges" onChange={(nudges) => save({ nudges })} />
          </Row>
          <Row label="Quiet hours" hint="Nothing arrives in them, wherever you are.">
            <Toggle checked={prefs.quiet.on} label="Quiet hours" onChange={(on) => save({ quiet: { ...prefs.quiet, on } })} />
          </Row>
          {prefs.quiet.on && (
            <div className="flex items-center justify-end gap-2 pb-2 text-[15px] text-dim">
              <input
                type="time"
                aria-label="Quiet hours start"
                className={timeInput}
                value={prefs.quiet.start}
                onChange={(e) => parseTime(e.target.value) !== null && save({ quiet: { ...prefs.quiet, start: e.target.value } })}
              />
              <span>to</span>
              <input
                type="time"
                aria-label="Quiet hours end"
                className={timeInput}
                value={prefs.quiet.end}
                onChange={(e) => parseTime(e.target.value) !== null && save({ quiet: { ...prefs.quiet, end: e.target.value } })}
              />
            </div>
          )}
          <p className="pt-2 text-[13px] leading-relaxed text-faint">
            Times follow the time zone of the device you opened most recently. Nudges can show a goal or a person's name on the lock screen;
            work names on your confidentiality list are always hidden. To hide all previews: iOS Settings &gt; Notifications &gt; Four Burners &gt; Show
            Previews.
          </p>
        </div>
      )}
    </div>
  );
}

function ReminderRow({ label, hint, pref, clash, onChange }: { label: string; hint: string; pref: ReminderPref; clash: boolean; onChange: (p: ReminderPref) => void }) {
  return (
    <div className="py-2">
      <Row label={label} hint={hint}>
        <Toggle checked={pref.on} label={label} onChange={(on) => onChange({ ...pref, on })} />
      </Row>
      {pref.on && (
        <div className="flex items-center justify-end gap-3">
          {clash && <span className="text-[13px] text-amber-200">Inside quiet hours</span>}
          <input
            type="time"
            aria-label={`${label} time`}
            className={timeInput}
            value={pref.time}
            onChange={(e) => parseTime(e.target.value) !== null && onChange({ ...pref, time: e.target.value })}
          />
        </div>
      )}
    </div>
  );
}

/** Glowing bell tile: molten while on, cold while off, pulsing while working. */
function BellOrb({ on, busy }: { on: boolean; busy: boolean }) {
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
        <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z" />
        <path d="M10 20.5a2 2 0 0 0 4 0" />
        {!on && <path d="M4 4l16 16" />}
      </svg>
    </motion.span>
  );
}
