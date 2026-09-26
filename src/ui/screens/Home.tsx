import { motion } from 'motion/react';
import { BURNERS, BURNER_LABELS, INTENT_LABELS, daysLeftInQuarter, quarterLabel } from '@/domain';
import type { AppState } from '@/data/hooks';
import { Flame } from '../components/Flame';
import { ScoreRing } from '../components/ui';
import { navigate } from '../router';
import { PALETTES } from '../theme';
import { STATUS_COLOR, STATUS_LABEL } from '../labels';

export function Home({ state }: { state: AppState }) {
  const { quarter, dashboard, today } = state;
  const daysLeft = daysLeftInQuarter(today);
  return (
    <div className="px-safe pt-safe pb-40">
      <header className="flex items-start justify-between pt-2">
        <div>
          <div className="text-[13px] font-medium tracking-[0.14em] text-dim uppercase">
            {quarterLabel(quarter.id)} · {daysLeft} {daysLeft === 1 ? 'day' : 'days'} left
          </div>
          <h1 className="mt-1 font-display text-[34px] leading-tight font-bold">
            {quarter.theme ? quarter.theme : 'Four Burners'}
          </h1>
        </div>
        <button
          aria-label="Settings"
          onClick={() => navigate('settings')}
          className="-mr-2 grid h-11 w-11 place-items-center rounded-full text-dim active:bg-white/10"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
        </button>
      </header>

      <section className="mt-5 flex justify-between gap-4 rounded-3xl border border-line bg-surface px-5 py-4">
        <ScoreRing value={dashboard.progressScore} label="Progress" color="#ffae3b" />
        <ScoreRing value={dashboard.consistencyScore} label="Consistency" color="#5ad1ff" />
      </section>
      {dashboard.streak.current > 1 && (
        <p className="mt-3 text-center text-[14px] text-dim">
          {dashboard.streak.current} day check-in streak
          {dashboard.streak.graceUsedThisWeek > 0 ? ' (grace day used this week)' : ''}
        </p>
      )}

      <section className="mt-5 grid grid-cols-2 gap-3">
        {BURNERS.map((b, i) => {
          const s = dashboard.burners[b];
          return (
            <motion.button
              key={b}
              onClick={() => navigate(`burner/${b}`)}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 * i, duration: 0.4 }}
              whileTap={{ scale: 0.97 }}
              className="relative flex h-[232px] flex-col overflow-hidden rounded-3xl border border-line bg-surface text-left"
              aria-label={`${BURNER_LABELS[b]}, ${INTENT_LABELS[s.intent]}, ${STATUS_LABEL[s.status]}`}
            >
              <div className="absolute inset-x-0 top-2 bottom-[60px]">
                <Flame burner={b} intent={s.intent} heat={s.heat} brightness={s.brightness} />
              </div>
              <div className="relative mt-auto bg-gradient-to-t from-black/90 to-transparent px-4 pt-3 pb-3.5">
                <div className="flex items-baseline justify-between">
                  <span className="text-[19px] font-semibold" style={{ color: PALETTES[b].accent }}>
                    {BURNER_LABELS[b]}
                  </span>
                  <span className="text-[12px] font-semibold tracking-wider text-dim uppercase">{INTENT_LABELS[s.intent]}</span>
                </div>
                <div className={`mt-0.5 text-[13px] ${STATUS_COLOR[s.status]}`}>{STATUS_LABEL[s.status]}</div>
              </div>
            </motion.button>
          );
        })}
      </section>

      {dashboard.inCrunchToday && (
        <p className="mt-4 rounded-2xl border border-line bg-surface px-4 py-3 text-[14px] text-dim">
          Travel/Crunch mode is on. Expectations are softened and streaks are paused.
        </p>
      )}
    </div>
  );
}
