// Guided quarter close: grade every goal, then carry it forward, modify it, or drop it.
import { motion } from 'motion/react';
import { useMemo, useState } from 'react';
import {
  BURNERS,
  BURNER_LABELS,
  GOAL_LIMITS,
  GRADES,
  GRADE_LABELS,
  carryOverflow,
  computeDashboard,
  nextQuarterId,
  quarterHighlights,
  quarterLabel,
  quarterSpan,
  suggestedGrade,
  summaryFrom,
  type BurnerId,
  type CloseDecision,
  type Goal,
  type GoalProgress,
} from '@/domain';
import type { AppState } from '@/data/hooks';
import { closeQuarter, decideGoal, gradeGoal } from '@/data/repo';
import { celebrate } from '../fx/Celebrations';
import { sfx } from '../fx/audio';
import { LavaBar, MiniFlame, MoltenButton, ShimmerText } from '../components/sizzle';
import { navigate } from '../router';
import { PALETTES } from '../theme';
import { progressText } from '../labels';
import { highlightsInputFor, inputFor } from '../stateInput';

const DECISIONS: { value: CloseDecision; label: string; hint: string }[] = [
  { value: 'carry', label: 'Carry forward', hint: 'Same goal, fresh start' },
  { value: 'modify', label: 'Modify', hint: 'Carry it, then tweak it' },
  { value: 'drop', label: 'Drop', hint: 'Let it go' },
];

function suggestedDecision(goal: Goal, p: GoalProgress): CloseDecision {
  if (goal.type === 'yesno' || (goal.type === 'milestone' && p.complete)) return 'drop';
  return p.fraction >= 0.6 ? 'carry' : 'modify';
}

export function CloseScreen({ state, quarterId }: { state: AppState; quarterId: string }) {
  const quarter = state.quarters.find((q) => q.id === quarterId);
  const span = quarterSpan(quarterId);
  const asOf = state.today < span.end ? state.today : span.end;
  const dash = useMemo(() => {
    const input = inputFor(state, quarterId, asOf);
    return input ? computeDashboard(input) : null;
  }, [state, quarterId, asOf]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!quarter || !dash) return <div className="grid h-dvh place-items-center text-dim">Quarter not found.</div>;
  const nextId = nextQuarterId(quarterId);
  const inNext = BURNERS.reduce(
    (acc, b) => ({ ...acc, [b]: state.data.allGoals.filter((g) => g.quarterId === nextId && g.burner === b && !g.carriedFromId).length }),
    {} as Record<BurnerId, number>,
  );
  const all = BURNERS.flatMap((b) => dash.burners[b].goals);
  const decisionOf = (g: Goal, p: GoalProgress) => g.closeDecision ?? suggestedDecision(g, p);
  const decisions = Object.fromEntries(all.map(({ goal, progress }) => [goal.id, decisionOf(goal, progress)]));
  const overflow = carryOverflow(all.map((x) => x.goal), decisions, inNext);
  const alreadyClosed = quarter.status === 'closed';

  const close = async (e: React.MouseEvent) => {
    setError('');
    if (overflow.length) {
      setError(`${overflow.map((b) => BURNER_LABELS[b]).join(' and ')} would carry more than ${GOAL_LIMITS.max} goals. Drop or finish one first.`);
      return;
    }
    setBusy(true);
    const x = e.clientX;
    const y = e.clientY;
    // Anything left untouched takes its suggested grade and decision.
    for (const { goal, progress } of all) {
      if (!goal.grade) await gradeGoal(goal.id, suggestedGrade(progress.fraction, progress.complete));
      if (!goal.closeDecision) await decideGoal(goal.id, suggestedDecision(goal, progress));
    }
    const input = highlightsInputFor(state, quarterId);
    const summary = input ? summaryFrom(quarterHighlights(input)) : { progressScore: dash.progressScore, consistencyScore: dash.consistencyScore, longestStreak: 0, checkInDays: 0 };
    const next = await closeQuarter(quarterId, summary);
    celebrate({ kind: 'complete', burner: 'family', x, y, title: `${quarterLabel(quarterId)} closed`, subtitle: 'On to the next one' });
    setTimeout(() => navigate(`setup/${next}`, { replace: true }), 1100);
  };

  return (
    <div className="px-safe pt-safe pb-40">
      <header className="flex items-center justify-between pt-1">
        <button onClick={() => navigate('')} className="-ml-2 grid h-11 w-11 place-items-center rounded-full text-dim active:bg-white/10" aria-label="Close (choices are saved)">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </header>
      <div className="text-[12px] font-bold tracking-[0.22em] text-ember uppercase">Quarter close</div>
      <h1 className="mt-1 font-display text-[40px] leading-tight font-black">
        <ShimmerText>Grade {quarterLabel(quarterId)}</ShimmerText>
      </h1>
      <p className="mt-2 text-[16px] text-dim">
        Honest grades, then decide what comes with you. Suggestions are filled in; change anything.
      </p>

      {BURNERS.map((b) => {
        const goals = dash.burners[b].goals;
        if (!goals.length) return null;
        const p = PALETTES[b];
        return (
          <section key={b} className="mt-8">
            <div className="mb-3 flex items-center gap-2.5">
              <MiniFlame burner={b} size={24} />
              <h2 className="font-display text-[24px] font-bold" style={{ color: p.accent }}>
                {BURNER_LABELS[b]}
              </h2>
            </div>
            <div className="space-y-3">
              {goals.map(({ goal, progress }) => {
                const grade = goal.grade ?? suggestedGrade(progress.fraction, progress.complete);
                const decision = decisionOf(goal, progress);
                return (
                  <motion.div
                    key={goal.id}
                    layout
                    className="rounded-3xl border bg-[#0a0a0c]/90 p-4 backdrop-blur"
                    style={{ borderColor: decision === 'drop' ? 'rgba(255,255,255,0.06)' : `${p.mid}44`, opacity: decision === 'drop' ? 0.7 : 1 }}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-[17px] font-semibold">{goal.title}</span>
                      <span className="shrink-0 text-[13px] text-dim tabular">{progressText(goal, progress)}</span>
                    </div>
                    <div className="mt-2.5">
                      <LavaBar fraction={progress.fraction} color={p.accent} hot={p.core} />
                    </div>

                    <div className="mt-4 flex items-center justify-between gap-1.5" role="radiogroup" aria-label={`Grade for ${goal.title}`}>
                      {GRADES.map((g) => {
                        const on = g === grade;
                        return (
                          <motion.button
                            key={g}
                            role="radio"
                            aria-checked={on}
                            aria-label={`${g}, ${GRADE_LABELS[g]}`}
                            whileTap={{ scale: 0.88 }}
                            disabled={alreadyClosed}
                            onClick={() => {
                              sfx.tick();
                              void gradeGoal(goal.id, g);
                            }}
                            className="grid h-13 flex-1 place-items-center rounded-2xl font-display text-[22px] font-black"
                            style={
                              on
                                ? { background: `linear-gradient(135deg, ${p.core}, ${p.mid} 50%, ${p.outer})`, color: '#000', boxShadow: `0 0 22px -4px ${p.mid}` }
                                : { boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.55)' }
                            }
                          >
                            {g}
                          </motion.button>
                        );
                      })}
                    </div>
                    <div className="mt-1.5 text-center text-[12px] font-semibold tracking-wider text-faint uppercase">{GRADE_LABELS[grade]}{!goal.grade ? ' (suggested)' : ''}</div>

                    <div className="mt-3 grid grid-cols-3 gap-2" role="radiogroup" aria-label={`Next quarter for ${goal.title}`}>
                      {DECISIONS.map((d) => {
                        const on = d.value === decision;
                        return (
                          <button
                            key={d.value}
                            role="radio"
                            aria-checked={on}
                            disabled={alreadyClosed}
                            onClick={() => {
                              sfx.tick();
                              void decideGoal(goal.id, d.value);
                            }}
                            className="min-h-14 rounded-2xl px-2 text-[14px] leading-tight font-semibold"
                            style={
                              on
                                ? d.value === 'drop'
                                  ? { background: 'rgba(255,255,255,0.12)', color: '#fff', boxShadow: 'inset 0 0 0 1.5px rgba(255,255,255,0.5)' }
                                  : { background: `${p.mid}26`, color: p.core, boxShadow: `inset 0 0 0 1.5px ${p.mid}` }
                                : { boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.6)' }
                            }
                          >
                            {d.label}
                            <span className="mt-0.5 block text-[11px] font-medium opacity-70">{d.hint}</span>
                          </button>
                        );
                      })}
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </section>
        );
      })}

      {all.length === 0 && <p className="mt-8 text-[16px] text-dim">No goals in this quarter. You can close it straight away.</p>}

      <div className="pb-safe fixed inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black via-black/95 to-transparent px-5 pt-10">
        <div className="mx-auto max-w-xl">
          {(error || overflow.length > 0) && (
            <p className="mb-2 text-center text-[14px] text-rose-300">
              {error || `${overflow.map((b) => BURNER_LABELS[b]).join(' and ')}: carrying more than ${GOAL_LIMITS.max} goals.`}
            </p>
          )}
          {alreadyClosed ? (
            <MoltenButton className="h-15 w-full text-[18px]" onClick={() => navigate(`setup/${nextId}`, { replace: true })}>
              Set up {quarterLabel(nextId)}
            </MoltenButton>
          ) : (
            <MoltenButton className="h-15 w-full text-[18px]" disabled={busy} onClick={close}>
              Close {quarterLabel(quarterId)} and carry forward
            </MoltenButton>
          )}
        </div>
      </div>
    </div>
  );
}
