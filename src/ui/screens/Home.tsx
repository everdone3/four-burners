import { motion } from "motion/react";
import { useState } from "react";
import { EnergyRow, ReachOut, ThemeSheet } from "../components/HomeExtras";
import { ActionsList, CoachCard, CrunchBanner, CrunchChip, CrunchSheet, NextQuarterReadyCard, QuarterCloseCard, ReviewCard, SetupCard } from "../components/Rituals";
import { BURNERS, BURNER_LABELS, INTENT_LABELS, daysLeftInQuarter, peopleByUrgency, quarterLabel } from "@/domain";
import type { AppState } from '@/data/hooks';
import { Flame } from '../components/Flame';
import { CountUp, GlowCard, IgniteText, ScoreRing, ShimmerText, StreakBadge, setIrisOrigin } from '../components/sizzle';
import { navigate } from '../router';
import { PALETTES } from '../theme';
import { STATUS_COLOR, STATUS_LABEL } from '../labels';
import { sfx } from '../fx/audio';
import { haptic } from '../fx/haptics';
import { useReducedMotion } from '../motion';

// The ignition sequence plays once per app launch, not every time you return home.
let introPlayed = false;

export function Home({ state }: { state: AppState }) {
  const { quarter, dashboard, today } = state;
  const reduced = useReducedMotion();
  const daysLeft = daysLeftInQuarter(today);
  const intro = !introPlayed && !reduced;
  introPlayed = true;
  const d = (s: number) => (intro ? s : 0);
  const [themeOpen, setThemeOpen] = useState(false);
  const [crunchOpen, setCrunchOpen] = useState(false);

  return (
    <div className="px-safe pt-safe relative pb-44">
      <header className="flex items-start justify-between pt-2">
        <div className="min-w-0">
          <motion.div
            initial={intro ? { opacity: 0, letterSpacing: '0.5em' } : false}
            animate={{ opacity: 1, letterSpacing: '0.18em' }}
            transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
            className="text-[13px] font-semibold text-dim uppercase"
          >
            {quarterLabel(quarter.id)} ·{' '}
            <span className="text-white">
              <CountUp value={daysLeft} delay={d(0.3)} duration={intro ? 1.2 : 0.01} />
            </span>{' '}
            {daysLeft === 1 ? 'day' : 'days'} left
          </motion.div>
          <button onClick={() => { sfx.tick(); setThemeOpen(true); }} className="block text-left" aria-label={quarter.theme ? `Quarter theme: ${quarter.theme}. Tap to edit.` : "Set a quarter theme"}>
            <h1 className="mt-1.5 font-display text-[44px] leading-[1.02] font-black tracking-tight">
              <ShimmerText>{intro ? <IgniteText text={quarter.theme ?? 'Four Burners'} delay={0.15} /> : (quarter.theme ?? 'Four Burners')}</ShimmerText>
            </h1>
            {!quarter.theme && <span className="mt-1 block text-[13px] font-medium text-ember">+ Set a theme for the quarter</span>}
          </button>
        </div>
        <button
          aria-label="Settings"
          onClick={() => {
            sfx.tick();
            navigate('settings');
          }}
          className="-mr-2 grid h-11 w-11 shrink-0 place-items-center rounded-full text-dim active:bg-white/10"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
        </button>
      </header>

      {state.pendingClose ? <QuarterCloseCard quarter={state.pendingClose} /> : state.needsSetup ? <SetupCard quarter={quarter} /> : state.nextReady && !state.data.goals.length ? <NextQuarterReadyCard quarter={state.nextReady} /> : null}

      <motion.section
        initial={intro ? { opacity: 0, y: 20, scale: 0.96 } : false}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ delay: d(0.5), duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        className="mt-6"
      >
        <GlowCard color="#ff9a3c" intensity={Math.max(0.3, dashboard.progressScore / 100)} className="bg-black/55 backdrop-blur-xl">
          <div className="flex justify-around gap-2 px-4 pt-5 pb-4">
            <ScoreRing value={dashboard.progressScore} label="Progress" from="#ffd27a" to="#ff5a1f" delay={d(0.8)} />
            <ScoreRing value={dashboard.consistencyScore} label="Consistency" from="#9ae8ff" to="#3b82f6" delay={d(1)} />
          </div>
        </GlowCard>
      </motion.section>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">
        {dashboard.streak.current > 1 && <StreakBadge days={dashboard.streak.current} grace={dashboard.streak.graceUsedThisWeek > 0} />}
        <CrunchChip crunch={state.crunchNow} onOpen={() => setCrunchOpen(true)} />
      </div>
      {state.crunchNow && <CrunchBanner crunch={state.crunchNow} onOpen={() => setCrunchOpen(true)} />}

      <ReviewCard today={today} reviewDay={state.settings.reviewDay} reviews={state.data.reviews} />
      <CoachCard hasProfile={!!state.profile} />

      <section className="mt-6 grid grid-cols-2 gap-3.5">
        {BURNERS.map((b, i) => {
          const s = dashboard.burners[b];
          const p = PALETTES[b];
          return (
            <motion.button
              key={b}
              onClick={(e) => {
                setIrisOrigin(e.clientX, e.clientY);
                sfx.whoosh();
                haptic();
                navigate(`burner/${b}`);
              }}
              initial={intro ? { opacity: 0, y: 30, scale: 0.9 } : false}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ delay: d(0.35 + 0.12 * i), type: 'spring', stiffness: 260, damping: 24 }}
              whileTap={{ scale: 0.95 }}
              className="text-left"
              aria-label={`${BURNER_LABELS[b]}, ${INTENT_LABELS[s.intent]}, ${STATUS_LABEL[s.status]}`}
            >
              <GlowCard color={p.accent} intensity={s.heat * s.brightness} className="h-[262px] overflow-hidden bg-[#050506]">
                <div
                  className="absolute inset-0"
                  style={{ background: `radial-gradient(ellipse at 50% 85%, ${p.outer}${Math.round(20 + 50 * s.heat * s.brightness).toString(16)}, transparent 65%)` }}
                />
                <div className="absolute inset-x-0 top-0 bottom-[58px]">
                  <Flame burner={b} intent={s.intent} heat={s.heat} brightness={s.brightness} ignite={intro ? 0.55 + 0.22 * i : undefined} />
                </div>
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black via-black/90 to-transparent px-4 pt-5 pb-3.5">
                  <div className="flex items-baseline justify-between">
                    <span className="font-display text-[21px] font-bold" style={{ color: p.accent, textShadow: `0 0 16px ${p.mid}88` }}>
                      {BURNER_LABELS[b]}
                    </span>
                    <span
                      className="rounded-full px-2 py-0.5 text-[11px] font-bold tracking-wider uppercase"
                      style={{ background: `${p.mid}22`, color: p.core, boxShadow: `inset 0 0 0 1px ${p.mid}55` }}
                    >
                      {INTENT_LABELS[s.intent]}
                    </span>
                  </div>
                  <div className={`mt-0.5 text-[13px] font-medium ${STATUS_COLOR[s.status]}`}>{STATUS_LABEL[s.status]}</div>
                </div>
              </GlowCard>
            </motion.button>
          );
        })}
      </section>

      <ActionsList actions={state.data.actions} today={today} />
      <EnergyRow entries={state.data.energy} today={today} />
      <ReachOut statuses={peopleByUrgency(state.data.people, state.data.touchpoints, today)} />

      <ThemeSheet open={themeOpen} onClose={() => setThemeOpen(false)} quarterId={quarter.id} theme={quarter.theme} />
      <CrunchSheet open={crunchOpen} onClose={() => setCrunchOpen(false)} crunch={state.crunchNow} today={today} />
    </div>
  );
}
