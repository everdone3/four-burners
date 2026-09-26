// A goal with its progress and one-tap logging.
// Habit and Yes/No: tap once to log. Number: tap to open amount chips, tap a chip.
// Milestone: tap to reveal the next step, tap to complete it.
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import type { Goal, GoalProgress, LogEntry } from '@/domain';
import { logProgress } from '@/data/repo';
import { celebrate } from '../fx/Celebrations';
import { sfx } from '../fx/audio';
import { inputClass, useToast } from './ui';
import { LavaBar } from './sizzle';
import { PALETTES } from '../theme';
import { STATUS_COLOR, STATUS_LABEL, goalTypeHint, progressText } from '../labels';
import { useReducedMotion } from '../motion';

type Point = { x: number; y: number };

export function useLogger() {
  const toast = useToast();
  return async (goal: Goal, progress: GoalProgress, value: number, at: Point, milestoneId?: string) => {
    const willComplete = !progress.complete && progress.actual + value >= progress.required && progress.required > 0;
    const stepName = goal.milestones?.find((m) => m.id === milestoneId)?.title;
    // Celebrate first (inside the tap gesture, so sound and haptics are allowed), then save.
    celebrate({
      kind: willComplete ? 'complete' : 'log',
      burner: goal.burner,
      x: at.x,
      y: at.y,
      title: willComplete ? 'Goal complete' : undefined,
      subtitle: willComplete ? goal.title : undefined,
    });
    await logProgress(goal, value, { milestoneId });
    if (!willComplete) {
      const what = goal.type === 'number' ? `+${value}${goal.unit ? ` ${goal.unit}` : ''}` : goal.type === 'milestone' ? stepName ?? 'Step' : goal.title;
      toast({ message: `Logged ${what}` });
    }
  };
}

function amountChips(goal: Goal, logs: readonly LogEntry[]): number[] {
  const mine = logs.filter((l) => l.goalId === goal.id).sort((a, b) => (a.at < b.at ? 1 : -1));
  const recent = [...new Set(mine.slice(0, 8).map((l) => l.value))].slice(0, 2);
  const base = (goal.target ?? 0) >= 50 ? [1, 5] : [1];
  return [...new Set([...recent, ...base])].sort((a, b) => a - b).slice(0, 4);
}

const pointOf = (e: React.MouseEvent): Point => ({ x: e.clientX || innerWidth / 2, y: e.clientY || innerHeight / 2 });

export function GoalRow({
  goal,
  progress,
  logs,
  showBurner,
}: {
  goal: Goal;
  progress: GoalProgress;
  logs: readonly LogEntry[];
  showBurner?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const [sweep, setSweep] = useState(0);
  const log = useLogger();
  const reduced = useReducedMotion();
  const p = PALETTES[goal.burner];
  const accent = p.accent;
  const nextStep = goal.milestones?.find((m) => !m.doneAt);
  const finished = progress.complete && goal.type !== 'number' && goal.type !== 'habit';

  const doLog = async (value: number, at: Point, milestoneId?: string) => {
    setSweep((n) => n + 1);
    await log(goal, progress, value, at, milestoneId);
  };

  const onTap = async (e: React.MouseEvent) => {
    if (finished) return;
    if (goal.type === 'habit' || goal.type === 'yesno') {
      await doLog(1, pointOf(e));
    } else {
      sfx.tick();
      setOpen((o) => !o);
    }
  };

  return (
    <div
      className="relative overflow-hidden rounded-[20px] border bg-[#0a0a0c]/90 backdrop-blur"
      style={{ borderColor: progress.complete ? `${accent}66` : 'rgba(255,255,255,0.08)', boxShadow: progress.complete ? `0 0 24px -8px ${accent}` : undefined }}
    >
      <AnimatePresence>
        {sweep > 0 && !reduced && (
          <motion.div
            key={sweep}
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{ background: `linear-gradient(100deg, transparent 20%, ${p.mid}55 50%, transparent 80%)` }}
            initial={{ x: '-100%' }}
            animate={{ x: '100%' }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.7, ease: 'easeOut' }}
          />
        )}
      </AnimatePresence>
      <button onClick={onTap} className="relative flex w-full items-center gap-3 px-4 py-4 text-left active:bg-white/[0.04]">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[17px] font-semibold">{goal.title}</div>
          <div className="mt-0.5 flex gap-2 text-[13px]">
            <span className="text-dim tabular">{progressText(goal, progress)}</span>
            <span className={`font-medium ${STATUS_COLOR[progress.status]}`}>{STATUS_LABEL[progress.status]}</span>
          </div>
          <div className="mt-2.5">
            <LavaBar fraction={progress.fraction} color={accent} hot={p.core} />
          </div>
          {showBurner && <div className="mt-1 text-[12px] text-faint">{goalTypeHint(goal)}</div>}
        </div>
        <motion.span
          whileTap={{ scale: 0.85 }}
          className="grid h-12 w-12 shrink-0 place-items-center rounded-full text-[22px] font-light"
          style={{
            color: finished ? '#000' : p.core,
            background: finished ? accent : `radial-gradient(circle at 50% 35%, ${p.mid}55, ${p.outer}22 70%)`,
            boxShadow: `inset 0 0 0 1px ${accent}77, 0 0 18px -4px ${p.mid}`,
          }}
          aria-hidden
        >
          {finished ? '✓' : '+'}
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="relative border-t border-white/[0.06]"
          >
            {goal.type === 'number' && (
              <div className="flex flex-wrap gap-2 p-3">
                {amountChips(goal, logs).map((v, i) => (
                  <motion.button
                    key={v}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.04 }}
                    whileTap={{ scale: 0.9 }}
                    onClick={async (e) => {
                      await doLog(v, pointOf(e));
                      setOpen(false);
                    }}
                    className="min-h-12 min-w-16 rounded-2xl px-4 text-[17px] font-bold"
                    style={{ color: p.core, background: `${p.mid}1f`, boxShadow: `inset 0 0 0 1px ${p.mid}55` }}
                  >
                    +{v}
                  </motion.button>
                ))}
                <form
                  className="flex min-w-32 flex-1 gap-2"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const v = Number(custom);
                    if (!v) return;
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    await doLog(v, { x: r.left + r.width / 2, y: r.top });
                    setCustom('');
                    setOpen(false);
                  }}
                >
                  <input
                    className={`${inputClass} !py-2.5`}
                    inputMode="decimal"
                    placeholder={goal.unit ?? 'Amount'}
                    value={custom}
                    onChange={(e) => setCustom(e.target.value)}
                    aria-label="Custom amount"
                  />
                </form>
              </div>
            )}
            {goal.type === 'milestone' && (
              <div className="p-3">
                {nextStep ? (
                  <motion.button
                    whileTap={{ scale: 0.98 }}
                    onClick={async (e) => {
                      await doLog(1, pointOf(e), nextStep.id);
                      setOpen(false);
                    }}
                    className="min-h-13 w-full rounded-2xl px-4 text-left text-[16px]"
                    style={{ background: `${p.mid}1a`, boxShadow: `inset 0 0 0 1px ${p.mid}44` }}
                  >
                    <span className="text-dim">Complete next step: </span>
                    <span className="font-bold" style={{ color: p.core }}>
                      {nextStep.title}
                    </span>
                  </motion.button>
                ) : (
                  <p className="px-1 text-[15px] text-dim">All steps done.</p>
                )}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
