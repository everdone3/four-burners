// Home card: "Looks like you're away" when your calendar shows a trip today and Travel/Crunch is off.
// Only a suggestion: Travel/Crunch turns on when you tap, never by itself. Hidden when no calendar is linked.
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { awayPeriods, crunchSuggestion, type CrunchPeriod, type CrunchSuggestion } from '@/domain';
import { acceptSuggestion, dismissSuggestion, refreshCalendar, useCalendar } from '@/calendar/feed';
import { fmtDay } from '../stateInput';
import { haptic } from '../fx/haptics';
import { sfx } from '../fx/audio';
import { useReducedMotion } from '../motion';
import { useToast } from './ui';

/** The card's sentence (pure, tested). */
export function suggestionText(s: CrunchSuggestion, today: string): string {
  const span = s.period.start === s.period.end ? fmtDay(s.period.start) : `${fmtDay(s.period.start)} to ${fmtDay(s.period.end)}`;
  const until = s.end === today ? 'for today' : `through ${fmtDay(s.end)}`;
  return `Your calendar shows "${s.period.label}" (${span}). Turn on Travel/Crunch ${until}? Streaks pause and nudges stay quiet.`;
}

export function CalendarSuggestionCard({ today, crunch }: { today: string; crunch: readonly CrunchPeriod[] }) {
  const cal = useCalendar();
  const reduced = useReducedMotion();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const linked = !!cal?.feed;

  // Check the calendar now and on each return to the app (at most every few hours; see feed.ts).
  useEffect(() => {
    if (!linked) return;
    const check = () => {
      if (document.visibilityState === 'visible') void refreshCalendar();
    };
    check();
    document.addEventListener('visibilitychange', check);
    return () => document.removeEventListener('visibilitychange', check);
  }, [linked]);

  const s = linked && cal?.cache ? crunchSuggestion(awayPeriods(cal.cache.events), today, crunch, cal.dismissed) : null;

  return (
    <AnimatePresence initial={false}>
      {s && (
        <motion.section
          key={s.period.key}
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.97 }}
          className="mt-4 rounded-2xl border px-4 py-3.5"
          style={{ borderColor: 'rgba(125,211,252,0.4)', background: 'linear-gradient(120deg, rgba(56,189,248,0.18), rgba(0,0,0,0.55))', boxShadow: '0 0 30px -12px rgba(56,189,248,0.7)' }}
          aria-label="Travel suggestion from your calendar"
        >
          <div className="flex items-start gap-3">
            <span className="text-[24px] leading-none" aria-hidden>
              ✈️
            </span>
            <p className="flex-1 text-[15px] leading-snug text-sky-50">{suggestionText(s, today)}</p>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              disabled={busy}
              className="h-11 rounded-xl text-[15px] font-semibold text-black disabled:opacity-60"
              style={{ background: 'linear-gradient(90deg, #bae6fd, #38bdf8)', boxShadow: '0 0 18px -4px rgba(56,189,248,0.8)' }}
              onClick={async () => {
                setBusy(true);
                try {
                  await acceptSuggestion(s);
                  sfx.whoosh();
                  haptic('success');
                  toast({ message: `Travel/Crunch on through ${fmtDay(s.end)}` });
                } finally {
                  setBusy(false);
                }
              }}
            >
              Turn it on
            </button>
            <button
              disabled={busy}
              className="h-11 rounded-xl border border-white/15 bg-white/[0.06] text-[15px] font-medium text-white/85 active:bg-white/10"
              onClick={() => void dismissSuggestion(s.period.key)}
            >
              Not this time
            </button>
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
