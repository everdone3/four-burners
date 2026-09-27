// Weekly review: a guided six-step ritual. Every change is saved as you go, and the flow
// reopens exactly where you left it (step, lists, and even half-typed text).
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BURNERS,
  BURNER_LABELS,
  INTENT_LABELS,
  actionsWeekFor,
  addDays,
  quarterOf,
  reviewWeekFor,
  suggestActions,
  suggestMisses,
  suggestWins,
  weekSummary,
  type BurnerId,
  type DashboardInput,
  type WeekSummary,
  type WeeklyReview,
} from '@/domain';
import type { AppState } from '@/data/hooks';
import { addAction, completeReview, getOrCreateReview, removeAction, saveReview } from '@/data/repo';
import { celebrate } from '../fx/Celebrations';
import { sfx } from '../fx/audio';
import { CountUp, MiniFlame, MoltenButton, StepEmbers } from '../components/sizzle';
import { GhostButton, inputClass } from '../components/ui';
import { CoachPanel } from '../components/CoachPanel';
import { buildWeeklyPacket } from '@/domain/coach/packets';
import { SensitiveWarning } from '../components/Sensitive';
import { navigate } from '../router';
import { PALETTES } from '../theme';
import { STATUS_COLOR, STATUS_LABEL } from '../labels';
import { inputFor, weekLabel } from '../stateInput';
import { useReducedMotion } from '../motion';

const STEPS = [
  { key: 'summary', title: 'Your week', kicker: 'Step 1' },
  { key: 'wins', title: 'Wins', kicker: 'Step 2' },
  { key: 'misses', title: 'Misses', kicker: 'Step 3' },
  { key: 'coach', title: 'Coach', kicker: 'Optional' },
  { key: 'focus', title: "Next week's focus", kicker: 'Step 5' },
  { key: 'actions', title: 'Actions', kicker: 'Step 6' },
] as const;

const MAX_ACTIONS = 7;

export function ReviewScreen({ state }: { state: AppState }) {
  // Lock the week when the review opens, so crossing midnight mid-review does not switch weeks.
  const [weekStart] = useState(() => reviewWeekFor(state.today, state.settings.reviewDay));
  const [ready, setReady] = useState(false);
  useEffect(() => {
    getOrCreateReview(weekStart).then(() => setReady(true));
  }, [weekStart]);
  const review = state.data.reviews.find((r) => r.weekStart === weekStart);
  if (!ready || !review) return <div className="h-dvh" />;
  return <ReviewFlow state={state} review={review} />;
}

function ReviewFlow({ state, review }: { state: AppState; review: WeeklyReview }) {
  const reduced = useReducedMotion();
  const [step, setStep] = useState(Math.min(review.step, STEPS.length - 1));
  const [dir, setDir] = useState(1);
  const weekEnd = addDays(review.weekStart, 6);
  const actionsWeek = actionsWeekFor(review.weekStart);

  const input = useMemo(
    () => inputFor(state, quarterOf(weekEnd < state.today ? weekEnd : state.today).id) ?? inputFor(state, state.quarter.id)!,
    [state, weekEnd],
  );
  const summary = useMemo(() => weekSummary(input, review.weekStart), [input, review.weekStart]);
  const coached = state.data.replies.some((r) => r.kind === "weekly" && r.scope === review.weekStart);

  const go = (to: number) => {
    sfx.tick();
    setDir(to > step ? 1 : -1);
    setStep(to);
    void saveReview(review.id, { step: to });
    window.scrollTo({ top: 0 });
  };

  const finish = async (e: React.MouseEvent) => {
    celebrate({
      kind: 'complete',
      burner: review.focusBurners[0] ?? topBurner(summary),
      x: e.clientX,
      y: e.clientY,
      title: 'Week sealed',
      subtitle: review.focus || undefined,
    });
    await completeReview(review.id);
    setTimeout(() => navigate('', { replace: true }), 900);
  };

  const s = STEPS[step];
  return (
    <div className="px-safe pt-safe flex min-h-dvh flex-col pb-36">
      <header className="flex items-center justify-between gap-3 pt-1">
        <button onClick={() => navigate('')} className="-ml-2 grid h-11 w-11 place-items-center rounded-full text-dim active:bg-white/10" aria-label="Close review (progress is saved)">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
        <StepEmbers count={STEPS.length} current={step} />
        <span className="w-11 text-right text-[12px] font-semibold text-faint tabular">{step + 1}/{STEPS.length}</span>
      </header>

      <div className="mt-4">
        <div className="text-[12px] font-semibold tracking-[0.2em] text-ember uppercase">
          Weekly review · {weekLabel(review.weekStart, weekEnd)}
        </div>
        <AnimatePresence mode="wait" initial={false} custom={dir}>
          <motion.div
            key={s.key}
            custom={dir}
            initial={reduced ? { opacity: 0 } : { opacity: 0, x: 40 * dir, filter: 'blur(6px)' }}
            animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, x: -40 * dir, filter: 'blur(6px)' }}
            transition={{ duration: 0.28, ease: 'easeOut' }}
          >
            <h1 className="mt-1 font-display text-[40px] leading-tight font-black tracking-tight">{s.title}</h1>
            <div className="mt-4">
              {s.key === 'summary' && <SummaryStep s={summary} />}
              {s.key === 'wins' && (
                <ListStep
                  review={review}
                  field="wins"
                  draftKey="win"
                  prompt="What went well? Small counts."
                  placeholder="Home for dinner four nights"
                  suggestions={suggestWins(summary)}
                  accent="#6ee7b7"
                />
              )}
              {s.key === 'misses' && (
                <ListStep
                  review={review}
                  field="misses"
                  draftKey="miss"
                  prompt="What slipped? Name it without judgment."
                  placeholder="Skipped Thursday's run"
                  suggestions={suggestMisses(summary)}
                  accent="#fda4af"
                />
              )}
              {s.key === "coach" && <CoachStep state={state} review={review} input={input} />}
              {s.key === 'focus' && <FocusStep review={review} />}
              {s.key === 'actions' && (
                <ActionsStep
                  state={state}
                  weekStart={actionsWeek}
                  suggestions={suggestActions(summary, inputFor(state, state.quarter.id) ?? { goals: [] })}
                />
              )}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="pb-safe fixed inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black via-black/95 to-transparent px-5 pt-10">
        <div className="mx-auto flex max-w-xl gap-3">
          {step > 0 && (
            <GhostButton className="h-15 px-6" onClick={() => go(step - 1)}>
              Back
            </GhostButton>
          )}
          {step < STEPS.length - 1 ? (
            <MoltenButton
              className="h-15 flex-1 text-[18px]"
              onClick={() => {
                // Skipping is only recorded when no coach reply was saved for this week.
                if (s.key === 'coach' && !coached) void saveReview(review.id, { coachSkipped: true });
                go(step + 1);
              }}
            >
              {s.key === 'coach' && !coached ? 'Skip for now' : 'Next'}
            </MoltenButton>
          ) : (
            <MoltenButton className="h-15 flex-1 text-[18px]" onClick={finish}>
              Seal the week
            </MoltenButton>
          )}
        </div>
      </div>
    </div>
  );
}

function topBurner(s: WeekSummary): BurnerId {
  return [...BURNERS].sort((a, b) => s.burners[b].activeDays - s.burners[a].activeDays)[0];
}

// ---------- Step 1: summary ----------

function SummaryStep({ s }: { s: WeekSummary }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(s.weekStart, i));
  const labels = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-end justify-between">
          <div>
            <div className="font-display text-[44px] leading-none font-black tabular">
              <CountUp value={s.checkInDays} />
              <span className="text-[22px] text-dim">/{s.daysElapsed}</span>
            </div>
            <div className="mt-1 text-[14px] text-dim">days you checked in</div>
          </div>
          <div className="text-right">
            <div className="font-display text-[28px] font-bold tabular text-ember">
              <CountUp value={s.streak.current} />
            </div>
            <div className="text-[13px] text-dim">day streak{s.streak.graceUsedThisWeek ? ' (grace used)' : ''}</div>
          </div>
        </div>
        <div className="mt-4 flex justify-between">
          {days.map((d, i) => {
            const future = i >= s.daysElapsed;
            const on = s.checkedIn[i];
            return (
              <div key={d} className="flex flex-col items-center gap-1.5">
                <span className="text-[18px]" style={{ opacity: future ? 0.15 : on ? 1 : 0.35, filter: on ? 'drop-shadow(0 0 6px #ff8a3d)' : 'grayscale(1)' }}>
                  {future ? '·' : on ? '🔥' : '○'}
                </span>
                <span className="text-[11px] font-semibold text-faint">{labels[i]}</span>
              </div>
            );
          })}
        </div>
      </Card>

      <Card>
        <SectionLabel>By burner, against intent</SectionLabel>
        <div className="mt-2 divide-y divide-white/[0.06]">
          {BURNERS.map((b) => {
            const w = s.burners[b];
            const p = PALETTES[b];
            const arrow = w.trend === 'up' ? '↑' : w.trend === 'down' ? '↓' : w.trend === 'flat' ? '→' : '';
            return (
              <div key={b} className="flex items-center gap-3 py-3">
                <MiniFlame burner={b} size={26} lit={Math.min(1, 0.3 + w.activeDays / Math.max(1, w.expectedActiveDays))} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[16px] font-semibold" style={{ color: p.accent }}>{BURNER_LABELS[b]}</span>
                    <span className="text-[11px] font-bold tracking-wider text-faint uppercase">{INTENT_LABELS[w.intent]}</span>
                  </div>
                  <div className="text-[13px] text-dim">
                    {w.activeDays} active {w.activeDays === 1 ? 'day' : 'days'} · {INTENT_LABELS[w.intent]} wants about {Math.ceil(w.expectedActiveDays)}
                  </div>
                </div>
                <div className="text-right">
                  <div className={`text-[13px] font-semibold ${STATUS_COLOR[w.status]}`}>{STATUS_LABEL[w.status]}</div>
                  {arrow && <div className={`text-[15px] font-bold ${w.trend === 'up' ? 'text-emerald-300' : w.trend === 'down' ? 'text-rose-300' : 'text-faint'}`}>{arrow}</div>}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3">
        <Card>
          <SectionLabel>Energy</SectionLabel>
          <div className="mt-3 flex h-12 items-end gap-1.5">
            {s.energy.days.map((v, i) => (
              <motion.div
                key={i}
                className="flex-1 rounded-md"
                initial={{ height: 0 }}
                animate={{ height: v ? `${v * 20}%` : '6%' }}
                transition={{ delay: i * 0.05, type: 'spring', stiffness: 200, damping: 20 }}
                style={{ background: v ? 'linear-gradient(to top, #ff5a1f, #ffd27a)' : 'rgba(255,255,255,0.08)', boxShadow: v ? '0 0 10px -2px #ff8a3d' : undefined }}
              />
            ))}
          </div>
          <div className="mt-2 text-[13px] text-dim">
            {s.energy.recent ? `Avg ${s.energy.recent.toFixed(1)}` : 'Not rated'}
            {s.energy.direction === 'up' && ', trending up'}
            {s.energy.direction === 'down' && ', trending down'}
          </div>
        </Card>
        <Card>
          <SectionLabel>Actions</SectionLabel>
          <div className="mt-2 font-display text-[34px] leading-none font-black tabular">
            {s.actions.done}
            <span className="text-[18px] text-dim">/{s.actions.total}</span>
          </div>
          <div className="mt-2 text-[13px] text-dim">{s.actions.total ? 'planned actions done' : 'No actions planned'}</div>
        </Card>
      </div>

      {(s.completedGoals.length > 0 || s.crunchDays > 0 || s.overduePeople.length > 0) && (
        <Card>
          {s.completedGoals.length > 0 && (
            <div className="mb-3">
              <SectionLabel>Completed</SectionLabel>
              <div className="mt-2 flex flex-wrap gap-2">
                {s.completedGoals.map((g) => (
                  <span key={g.title} className="rounded-full px-3 py-1.5 text-[14px] font-semibold" style={{ background: `${PALETTES[g.burner].mid}22`, color: PALETTES[g.burner].core, boxShadow: `0 0 14px -4px ${PALETTES[g.burner].mid}` }}>
                    ✓ {g.title}
                  </span>
                ))}
              </div>
            </div>
          )}
          {s.crunchDays > 0 && (
            <p className="mb-3 text-[14px] text-dim">
              ✈️ {s.crunchDays} Travel/Crunch {s.crunchDays === 1 ? 'day' : 'days'}. Expectations were softened and your streak was paused.
            </p>
          )}
          {s.overduePeople.length > 0 && (
            <div>
              <SectionLabel>Due to connect</SectionLabel>
              <div className="mt-2 flex flex-wrap gap-2">
                {s.overduePeople.map((p) => (
                  <span key={p.name} className="rounded-full px-3 py-1.5 text-[14px]" style={{ boxShadow: `inset 0 0 0 1px ${PALETTES[p.burner].mid}66`, color: PALETTES[p.burner].core }}>
                    {p.name}
                    {p.daysSince !== null && <span className="text-faint"> · {p.daysSince}d</span>}
                  </span>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

// ---------- Steps 2 and 3: wins and misses ----------

function ListStep({
  review,
  field,
  draftKey,
  prompt,
  placeholder,
  suggestions,
  accent,
}: {
  review: WeeklyReview;
  field: 'wins' | 'misses';
  draftKey: 'win' | 'miss';
  prompt: string;
  placeholder: string;
  suggestions: string[];
  accent: string;
}) {
  const items = review[field];
  const [text, setText] = useDraft(review, draftKey);
  const add = (t: string) => {
    const v = t.trim();
    if (!v || items.includes(v)) return;
    sfx.tick();
    void saveReview(review.id, { [field]: [...items, v], drafts: { ...review.drafts, [draftKey]: '' } });
    setText('', false);
  };
  const remove = (t: string) => void saveReview(review.id, { [field]: items.filter((x) => x !== t) });
  const open = suggestions.filter((sg) => !items.includes(sg));

  return (
    <div className="space-y-4">
      <p className="text-[16px] text-dim">{prompt}</p>
      <ul className="space-y-2">
        <AnimatePresence initial={false}>
          {items.map((t) => (
            <motion.li
              key={t}
              layout
              initial={{ opacity: 0, y: 10, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: -30 }}
              className="flex items-start gap-3 rounded-2xl border border-white/[0.08] bg-[#0b0b0d]/90 px-4 py-3"
              style={{ boxShadow: `inset 3px 0 0 ${accent}` }}
            >
              <span className="flex-1 text-[16px]">{t}</span>
              <button onClick={() => remove(t)} className="-mr-1 grid h-8 w-8 shrink-0 place-items-center rounded-full text-faint active:bg-white/10" aria-label={`Remove ${t}`}>
                ×
              </button>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add(text);
        }}
      >
        <input className={inputClass} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} autoCapitalize="sentences" enterKeyHint="done" />
        <button type="submit" disabled={!text.trim()} className="shrink-0 rounded-2xl px-4 text-[16px] font-bold disabled:opacity-30" style={{ background: `${accent}22`, color: accent }}>
          Add
        </button>
      </form>
      <SensitiveWarning text={text} />
      {open.length > 0 && (
        <div>
          <SectionLabel>From your week, tap to add</SectionLabel>
          <div className="mt-2 flex flex-wrap gap-2">
            {open.map((sg) => (
              <motion.button
                key={sg}
                whileTap={{ scale: 0.94 }}
                onClick={() => add(sg)}
                className="min-h-10 rounded-full px-3.5 py-2 text-left text-[14px]"
                style={{ boxShadow: `inset 0 0 0 1px ${accent}55`, color: accent }}
              >
                + {sg}
              </motion.button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Text that persists to the review's drafts as you type (debounced). */
function useDraft(review: WeeklyReview, key: 'win' | 'miss' | 'action'): [string, (v: string, save?: boolean) => void] {
  const [text, setTextState] = useState(review.drafts?.[key] ?? '');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latest = useRef(review);
  latest.current = review;
  const setText = (v: string, save = true) => {
    setTextState(v);
    clearTimeout(timer.current);
    if (save) {
      timer.current = setTimeout(() => void saveReview(latest.current.id, { drafts: { ...latest.current.drafts, [key]: v } }), 300);
    }
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return [text, setText];
}

// ---------- Step 4: coach (optional) ----------

function CoachStep({ state, review, input }: { state: AppState; review: WeeklyReview; input: DashboardInput }) {
  const actionsWeek = actionsWeekFor(review.weekStart);
  // Built before any tap, so Copy can hit the clipboard instantly inside the gesture.
  const packet = useMemo(
    () => buildWeeklyPacket({ input, reviews: state.data.reviews, review, weekStart: review.weekStart, profile: state.profile }),
    [input, state.data.reviews, review, state.profile],
  );
  return (
    <div className="space-y-4">
      <p className="text-[16px] text-dim">
        Optional. Your week, wins, and misses go to your own Claude app as a coaching note. Private notes and sensitive names never leave this phone.
      </p>
      <CoachPanel
        kind="weekly"
        scope={review.weekStart}
        packet={packet}
        replies={state.data.replies}
        actionsWeek={actionsWeek}
        existingActionTexts={state.data.actions.filter((a) => a.weekStart === actionsWeek).map((a) => a.text)}
      />
    </div>
  );
}

// ---------- Step 5: focus ----------

function FocusStep({ review }: { review: WeeklyReview }) {
  const [text, setText] = useState(review.focus);
  // Local mirror so quick successive taps never read a stale list.
  const [picked, setPicked] = useState<BurnerId[]>(review.focusBurners);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const toggle = (b: BurnerId) => {
    sfx.tick();
    setPicked((cur) => {
      const next = cur.includes(b) ? cur.filter((x) => x !== b) : [...cur, b].slice(-2);
      void saveReview(review.id, { focusBurners: next });
      return next;
    });
  };
  return (
    <div className="space-y-5">
      <p className="text-[16px] text-dim">One line to carry into next week.</p>
      <input
        className={`${inputClass} !py-4 font-display !text-[20px] font-semibold`}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          clearTimeout(timer.current);
          const v = e.target.value;
          timer.current = setTimeout(() => void saveReview(review.id, { focus: v.trim() }), 300);
        }}
        placeholder="Protect mornings"
        autoCapitalize="sentences"
      />
      <SensitiveWarning text={text} />
      <div>
        <SectionLabel>Burners to lean into (up to 2)</SectionLabel>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {BURNERS.map((b) => {
            const on = picked.includes(b);
            const p = PALETTES[b];
            return (
              <motion.button
                key={b}
                whileTap={{ scale: 0.95 }}
                onClick={() => toggle(b)}
                aria-pressed={on}
                className="flex min-h-14 items-center gap-3 rounded-2xl px-4 text-[16px] font-semibold"
                style={
                  on
                    ? { background: `linear-gradient(135deg, ${p.mid}33, ${p.outer}33)`, boxShadow: `inset 0 0 0 1.5px ${p.mid}, 0 0 20px -6px ${p.mid}`, color: p.core }
                    : { boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.7)' }
                }
              >
                <MiniFlame burner={b} size={22} lit={on ? 1 : 0.35} />
                {BURNER_LABELS[b]}
              </motion.button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------- Step 6: actions ----------

function ActionsStep({
  state,
  weekStart,
  suggestions,
}: {
  state: AppState;
  weekStart: string;
  suggestions: { text: string; burner?: BurnerId }[];
}) {
  const actions = state.data.actions.filter((a) => a.weekStart === weekStart).sort((a, b) => a.order - b.order);
  const review = state.data.reviews.find((r) => actionsWeekFor(r.weekStart) === weekStart)!;
  const [text, setText] = useDraft(review, 'action');
  const [burner, setBurner] = useState<BurnerId | undefined>(undefined);
  const full = actions.length >= MAX_ACTIONS;
  const add = async (t: string, b?: BurnerId) => {
    const v = t.trim();
    if (!v || full || actions.some((a) => a.text.toLowerCase() === v.toLowerCase())) return;
    sfx.tick();
    await addAction(weekStart, v, b);
  };
  const open = suggestions.filter((sg) => !actions.some((a) => a.text.toLowerCase() === sg.text.toLowerCase()));

  return (
    <div className="space-y-4">
      <p className="text-[16px] text-dim">Specific things you will do next week. They show up on your home screen as one-tap items.</p>
      <ul className="space-y-2">
        <AnimatePresence initial={false}>
          {actions.map((a) => (
            <motion.li
              key={a.id}
              layout
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: -30 }}
              className="flex items-center gap-3 rounded-2xl border border-white/[0.08] bg-[#0b0b0d]/90 px-4 py-3"
            >
              {a.burner ? <MiniFlame burner={a.burner} size={20} /> : <span className="w-3.5" />}
              <span className="flex-1 text-[16px]">{a.text}</span>
              <button onClick={() => void removeAction(a.id)} className="-mr-1 grid h-8 w-8 place-items-center rounded-full text-faint active:bg-white/10" aria-label={`Remove ${a.text}`}>
                ×
              </button>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      {!full ? (
        <form
          className="space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            await add(text, burner);
            setText('', true);
          }}
        >
          <div className="flex gap-2">
            <input className={inputClass} value={text} onChange={(e) => setText(e.target.value)} placeholder="Book the sitter for Friday" autoCapitalize="sentences" enterKeyHint="done" />
            <button type="submit" disabled={!text.trim()} className="shrink-0 rounded-2xl bg-ember/15 px-4 text-[16px] font-bold text-ember disabled:opacity-30">
              Add
            </button>
          </div>
          <SensitiveWarning text={text} />
          <div className="flex items-center gap-2" role="radiogroup" aria-label="Burner for this action">
            <span className="text-[13px] text-faint">Burner:</span>
            {BURNERS.map((b) => (
              <button
                type="button"
                key={b}
                role="radio"
                aria-checked={burner === b}
                aria-label={BURNER_LABELS[b]}
                onClick={() => setBurner(burner === b ? undefined : b)}
                className="grid h-10 w-10 place-items-center rounded-full"
                style={{ boxShadow: burner === b ? `inset 0 0 0 2px ${PALETTES[b].mid}, 0 0 14px -4px ${PALETTES[b].mid}` : 'inset 0 0 0 1px rgba(255,255,255,0.1)' }}
              >
                <MiniFlame burner={b} size={18} lit={burner === b ? 1 : 0.4} />
              </button>
            ))}
          </div>
        </form>
      ) : (
        <p className="text-[14px] text-faint">{MAX_ACTIONS} is plenty for one week.</p>
      )}
      {open.length > 0 && !full && (
        <div>
          <SectionLabel>Suggested, tap to add</SectionLabel>
          <div className="mt-2 flex flex-wrap gap-2">
            {open.map((sg) => (
              <motion.button
                key={sg.text}
                whileTap={{ scale: 0.94 }}
                onClick={() => void add(sg.text, sg.burner)}
                className="flex min-h-10 items-center gap-2 rounded-full px-3.5 py-2 text-left text-[14px]"
                style={{ boxShadow: `inset 0 0 0 1px ${sg.burner ? PALETTES[sg.burner].mid : '#ffae3b'}66` }}
              >
                {sg.burner && <MiniFlame burner={sg.burner} size={16} />}+ {sg.text}
              </motion.button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Bits ----------

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-3xl border border-white/[0.08] bg-[#0b0b0d]/85 p-4 backdrop-blur">{children}</div>;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[12px] font-semibold tracking-[0.14em] text-dim uppercase">{children}</div>;
}
