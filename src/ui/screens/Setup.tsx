// Guided quarter setup: theme, intents (High cap), goals (pre-filled with carried goals), then ignition.
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import {
  BURNERS,
  BURNER_LABELS,
  GOAL_LIMITS,
  INTENT_LABELS,
  MAX_HIGH_BURNERS,
  countHigh,
  prevQuarterId,
  quarterLabel,
  quarterSpan,
  type BurnerId,
  type Goal,
  type Intent,
} from '@/domain';
import type { AppState } from '@/data/hooks';
import { ensureQuarter, finishSetup, setSetupIntents, setTheme } from "@/data/repo";
import { Flame } from '../components/Flame';
import { MiniFlame, MoltenButton, ShimmerText, StepEmbers } from '../components/sizzle';
import { GhostButton, Segmented, inputClass } from '../components/ui';
import { celebrate } from '../fx/Celebrations';
import { sfx } from '../fx/audio';
import { navigate } from '../router';
import { PALETTES } from '../theme';
import { fmtDay } from '../stateInput';
import { GoalEditor } from './GoalEditor';
import { CoachPanel } from '../components/CoachPanel';
import { buildQuarterSetupPacket } from '@/domain/coach/packets';
import { highlightsInputFor } from '../stateInput';
import { useReducedMotion } from '../motion';

const STEPS = ['Theme', 'Intents', 'Goals', 'Pressure test', 'Ignite'] as const;
const THEME_IDEAS = ['Present', 'Foundations', 'Less but better', 'Strong', 'All in', 'Reset', 'Momentum'];
const stepKey = (q: string) => `fb-setup-step-${q}`;

export function SetupScreen({ state, quarterId }: { state: AppState; quarterId: string }) {
  const quarter = state.quarters.find((q) => q.id === quarterId);
  // The next quarter may not exist yet (setup opened ahead of time); create it on the fly.
  useEffect(() => {
    if (!quarter) void ensureQuarter(quarterId);
  }, [quarter, quarterId]);
  if (!quarter) return <div className="grid h-dvh place-items-center text-dim">Preparing {quarterLabel(quarterId)}...</div>;
  return <SetupFlow state={state} quarterId={quarterId} />;
}

function SetupFlow({ state, quarterId }: { state: AppState; quarterId: string }) {
  const reduced = useReducedMotion();
  const quarter = state.quarters.find((q) => q.id === quarterId)!;
  const span = quarterSpan(quarterId);
  const [step, setStepState] = useState(() => Number(localStorage.getItem(stepKey(quarterId)) ?? 0) || 0);
  const setStep = (n: number) => {
    sfx.tick();
    setStepState(n);
    localStorage.setItem(stepKey(quarterId), String(n));
    window.scrollTo({ top: 0 });
  };
  const goals = state.data.allGoals.filter((g) => g.quarterId === quarterId);

  const ignite = async (e: React.MouseEvent) => {
    const x = e.clientX;
    const y = e.clientY;
    await finishSetup(quarterId);
    localStorage.removeItem(stepKey(quarterId));
    BURNERS.forEach((b, i) =>
      setTimeout(() => celebrate({ kind: i === 3 ? 'complete' : 'log', burner: b, x: i === 3 ? x : innerWidth * (0.2 + 0.2 * i), y: i === 3 ? y : innerHeight * 0.4, title: `${quarterLabel(quarterId)} is lit`, subtitle: quarter.theme }), i * 220),
    );
    setTimeout(() => navigate('', { replace: true }), 1600);
  };

  return (
    <div className="px-safe pt-safe pb-40">
      <header className="flex items-center justify-between pt-1">
        <button onClick={() => navigate('')} className="-ml-2 grid h-11 w-11 place-items-center rounded-full text-dim active:bg-white/10" aria-label="Close setup (progress is saved)">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
        <StepEmbers count={STEPS.length} current={step} />
        <span className="w-11" />
      </header>
      <div className="mt-3 text-[12px] font-bold tracking-[0.22em] text-ember uppercase">
        Set up {quarterLabel(quarterId)} · {fmtDay(span.start)} to {fmtDay(span.end)}
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={step}
          initial={reduced ? { opacity: 0 } : { opacity: 0, x: 30 }}
          animate={{ opacity: 1, x: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, x: -30 }}
          transition={{ duration: 0.25 }}
        >
          {step === 0 && <ThemeStep quarterId={quarterId} theme={quarter.theme} />}
          {step === 1 && <IntentsStep quarterId={quarterId} intents={quarter.intents} words={state.profile?.burners} />}
          {step === 2 && <GoalsStep state={state} quarterId={quarterId} goals={goals} intents={quarter.intents} />}
          {step === 3 && <PressureTestStep state={state} quarterId={quarterId} goals={goals} />}
          {step === 4 && <IgniteStep quarterId={quarterId} goals={goals} intents={quarter.intents} theme={quarter.theme} />}
        </motion.div>
      </AnimatePresence>

      <div className="pb-safe fixed inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black via-black/95 to-transparent px-5 pt-10">
        <div className="mx-auto flex max-w-xl gap-3">
          {step > 0 && (
            <GhostButton className="h-15 px-6" onClick={() => setStep(step - 1)}>
              Back
            </GhostButton>
          )}
          {step < STEPS.length - 1 ? (
            <MoltenButton className="h-15 flex-1 text-[18px]" onClick={() => setStep(step + 1)}>
              Next
            </MoltenButton>
          ) : (
            <MoltenButton className="h-15 flex-1 text-[19px]" onClick={ignite}>
              🔥 Light it up
            </MoltenButton>
          )}
        </div>
      </div>
    </div>
  );
}

function ThemeStep({ quarterId, theme }: { quarterId: string; theme?: string }) {
  const [value, setValue] = useState(theme ?? '');
  return (
    <div>
      <h1 className="mt-1 font-display text-[40px] leading-tight font-black">A theme</h1>
      <p className="mt-2 text-[16px] text-dim">One word or a short phrase for the quarter. Optional, and it lives at the top of your dashboard.</p>
      <input
        className={`${inputClass} mt-5 !py-4 font-display !text-[24px] font-bold`}
        value={value}
        maxLength={32}
        onChange={(e) => {
          setValue(e.target.value);
          void setTheme(quarterId, e.target.value);
        }}
        placeholder="Momentum"
        autoCapitalize="words"
      />
      <div className="mt-4 flex flex-wrap gap-2">
        {THEME_IDEAS.map((t) => (
          <button
            key={t}
            onClick={() => {
              sfx.tick();
              setValue(t);
              void setTheme(quarterId, t);
            }}
            className="min-h-11 rounded-full px-4 text-[15px]"
            style={value === t ? { background: 'rgba(255,154,60,0.2)', boxShadow: 'inset 0 0 0 1.5px #ff9a3c', color: '#ffd27a' } : { boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.7)' }}
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}

function IntentsStep({ quarterId, intents, words }: { quarterId: string; intents: Record<BurnerId, Intent>; words?: Record<BurnerId, { winning: string }> }) {
  const highs = countHigh(intents);
  const [error, setError] = useState('');
  return (
    <div>
      <h1 className="mt-1 font-display text-[40px] leading-tight font-black">Intents</h1>
      <p className="mt-2 text-[16px] text-dim">
        Which burners run hot this quarter? Up to {MAX_HIGH_BURNERS} on High. Low is a choice, not a failure.
      </p>
      <div className="mt-5 space-y-3">
        {BURNERS.map((b) => {
          const p = PALETTES[b];
          return (
            <div key={b} className="rounded-3xl border border-white/[0.08] bg-[#0a0a0c]/90 p-4">
              <div className="mb-3 flex items-center gap-2.5">
                <MiniFlame burner={b} size={24} lit={intents[b] === 'high' ? 1 : intents[b] === 'steady' ? 0.7 : 0.4} />
                <span className="font-display text-[20px] font-bold" style={{ color: p.accent }}>
                  {BURNER_LABELS[b]}
                </span>
              </div>
              {words?.[b]?.winning && <p className="-mt-1 mb-3 text-[14px] text-dim"><span className="font-semibold text-white/70">Your words: </span>{words[b].winning}</p>}
              <Segmented
                value={intents[b]}
                onChange={async (i: Intent) => {
                  setError('');
                  const r = await setSetupIntents(quarterId, { ...intents, [b]: i });
                  if (!r.ok) setError(r.error);
                  else sfx.tick();
                }}
                options={(['high', 'steady', 'low'] as Intent[]).map((i) => ({
                  value: i,
                  label: INTENT_LABELS[i],
                  disabled: i === 'high' && intents[b] !== 'high' && highs >= MAX_HIGH_BURNERS,
                }))}
              />
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-center text-[14px] text-faint">{highs}/{MAX_HIGH_BURNERS} on High</p>
      {error && <p className="mt-2 text-center text-[14px] text-rose-300">{error}</p>}
    </div>
  );
}

function GoalsStep({ state, quarterId, goals, intents }: { state: AppState; quarterId: string; goals: Goal[]; intents: Record<BurnerId, Intent> }) {
  const [editor, setEditor] = useState<{ open: boolean; burner: BurnerId; goal?: Goal }>({ open: false, burner: 'family' });
  const counts = Object.fromEntries(BURNERS.map((b) => [b, goals.filter((g) => g.burner === b).length])) as Record<BurnerId, number>;
  const decisionOf = (g: Goal) => state.data.allGoals.find((x) => x.id === g.carriedFromId)?.closeDecision;
  return (
    <div>
      <h1 className="mt-1 font-display text-[40px] leading-tight font-black">Goals</h1>
      <p className="mt-2 text-[16px] text-dim">
        Three a burner is the sweet spot. Carried goals are already here with fresh progress; tap one to tweak it.
      </p>
      <div className="mt-5 space-y-6">
        {BURNERS.map((b) => {
          const p = PALETTES[b];
          const mine = goals.filter((g) => g.burner === b).sort((x, y) => x.order - y.order);
          return (
            <section key={b}>
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <MiniFlame burner={b} size={22} />
                  <span className="font-display text-[20px] font-bold" style={{ color: p.accent }}>
                    {BURNER_LABELS[b]}
                  </span>
                  <span className="text-[12px] font-bold tracking-wider text-faint uppercase">{INTENT_LABELS[intents[b]]}</span>
                </div>
                <span className="text-[13px] text-faint tabular">
                  {mine.length}/{GOAL_LIMITS.max}
                </span>
              </div>
              {state.profile?.burners[b]?.winning && <p className="mb-2 text-[13px] text-dim"><span className="font-semibold text-white/70">Your words: </span>{state.profile.burners[b].winning}</p>}
              <div className="space-y-2">
                {mine.map((g) => {
                  const tweak = decisionOf(g) === 'modify';
                  return (
                    <button
                      key={g.id}
                      onClick={() => setEditor({ open: true, burner: b, goal: g })}
                      className="flex min-h-14 w-full items-center gap-3 rounded-2xl border bg-[#0a0a0c]/90 px-4 py-3 text-left"
                      style={{ borderColor: tweak ? `${p.mid}` : 'rgba(255,255,255,0.08)', boxShadow: tweak ? `0 0 18px -6px ${p.mid}` : undefined }}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[16px] font-semibold">{g.title}</span>
                        {g.carriedFromId && (
                          <span className="block text-[12px] font-semibold" style={{ color: tweak ? p.core : 'rgba(255,255,255,0.45)' }}>
                            {tweak ? 'Carried forward. Tap to tweak it' : 'Carried forward'}
                          </span>
                        )}
                      </span>
                      <span className="text-[14px] text-faint">Edit</span>
                    </button>
                  );
                })}
                {mine.length < GOAL_LIMITS.max && (
                  <button
                    onClick={() => setEditor({ open: true, burner: b })}
                    className="flex min-h-13 w-full items-center justify-center rounded-2xl border border-dashed text-[15px] font-semibold"
                    style={{ borderColor: `${p.mid}55`, color: p.accent }}
                  >
                    + Add a {BURNER_LABELS[b]} goal
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>
      <GoalEditor
        open={editor.open}
        goal={editor.goal}
        onClose={() => setEditor((e) => ({ ...e, open: false }))}
        burner={editor.burner}
        quarterId={quarterId}
        existingCount={counts[editor.burner]}
        intents={intents}
        goalCounts={counts}
      />
    </div>
  );
}

function IgniteStep({ quarterId, goals, intents, theme }: { quarterId: string; goals: Goal[]; intents: Record<BurnerId, Intent>; theme?: string }) {
  return (
    <div>
      <h1 className="mt-1 font-display text-[40px] leading-tight font-black">
        <ShimmerText>Ready to light {quarterLabel(quarterId)}</ShimmerText>
      </h1>
      {theme && <p className="mt-2 font-display text-[22px] font-bold text-white/85">"{theme}"</p>}
      <div className="mt-5 grid grid-cols-2 gap-3">
        {BURNERS.map((b) => {
          const p = PALETTES[b];
          const n = goals.filter((g) => g.burner === b).length;
          return (
            <div key={b} className="relative h-[190px] overflow-hidden rounded-3xl border border-white/[0.08] bg-[#050506]">
              <div className="absolute inset-x-0 top-0 bottom-12">
                <Flame burner={b} intent={intents[b]} heat={0.7} brightness={1} />
              </div>
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black to-transparent px-3.5 pt-4 pb-3">
                <div className="flex items-baseline justify-between">
                  <span className="font-display text-[18px] font-bold" style={{ color: p.accent }}>
                    {BURNER_LABELS[b]}
                  </span>
                  <span className="text-[11px] font-bold tracking-wider text-white/60 uppercase">{INTENT_LABELS[intents[b]]}</span>
                </div>
                <div className="text-[13px] text-dim">
                  {n} {n === 1 ? 'goal' : 'goals'}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PressureTestStep({ state, quarterId, goals }: { state: AppState; quarterId: string; goals: Goal[] }) {
  const quarter = state.quarters.find((q) => q.id === quarterId)!;
  const prevId = prevQuarterId(quarterId);
  const previous = state.quarters.some((q) => q.id === prevId && state.data.allGoals.some((g) => g.quarterId === prevId)) ? highlightsInputFor(state, prevId) : null;
  const packet = useMemo(
    () =>
      buildQuarterSetupPacket({
        draftQuarter: quarter,
        draftGoals: goals,
        previous,
        quarters: state.quarters,
        crunch: state.data.crunch,
        logs: state.data.logs,
        goalsAll: state.data.allGoals,
        reviews: state.data.reviews,
        settings: state.settings,
        profile: state.profile,
        today: state.today,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [quarter, goals, state.data, state.settings, state.profile, state.today],
  );
  return (
    <div>
      <div className="mt-1 text-[12px] font-bold tracking-[0.22em] text-ember uppercase">Optional</div>
      <h1 className="font-display text-[40px] leading-tight font-black">Pressure test</h1>
      <p className="mt-2 mb-5 text-[16px] text-dim">
        Before you commit, let your Claude coach flag vague goals, missing whys or plans, and over-commitment given your travel and crunch history. Make changes back in Goals.
      </p>
      <CoachPanel kind="quarter_setup" scope={quarterId} packet={packet} replies={state.data.replies} />
    </div>
  );
}
