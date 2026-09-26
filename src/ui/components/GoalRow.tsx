// A goal with its progress and one-tap logging.
// Habit and Yes/No: tap once to log. Number: tap to open amount chips, tap a chip.
// Milestone: tap to reveal the next step, tap to complete it.
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import type { Goal, GoalProgress, LogEntry } from '@/domain';
import { logProgress } from '@/data/repo';
import { flare } from './Flame';
import { inputClass, useToast } from './ui';
import { PALETTES } from '../theme';
import { STATUS_COLOR, STATUS_LABEL, goalTypeHint, progressText } from '../labels';

export function useLogger() {
  const toast = useToast();
  return async (goal: Goal, progress: GoalProgress, value: number, milestoneId?: string) => {
    await logProgress(goal, value, { milestoneId });
    const willComplete = !progress.complete && progress.actual + value >= progress.required && progress.required > 0;
    flare(goal.burner, willComplete ? 2 : 0.6);
    const what =
      goal.type === 'number'
        ? `${value}${goal.unit ? ` ${goal.unit}` : ''}`
        : goal.type === 'milestone'
          ? goal.milestones?.find((m) => m.id === milestoneId)?.title ?? 'Step'
          : goal.title;
    toast({ message: willComplete ? `${goal.title} complete. Nicely done.` : `Logged ${what}` });
  };
}

function amountChips(goal: Goal, logs: readonly LogEntry[]): number[] {
  const mine = logs.filter((l) => l.goalId === goal.id).sort((a, b) => (a.at < b.at ? 1 : -1));
  const recent = [...new Set(mine.slice(0, 8).map((l) => l.value))].slice(0, 2);
  const base = (goal.target ?? 0) >= 50 ? [1, 5] : [1];
  return [...new Set([...recent, ...base])].sort((a, b) => a - b).slice(0, 4);
}

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
  const log = useLogger();
  const accent = PALETTES[goal.burner].accent;
  const nextStep = goal.milestones?.find((m) => !m.doneAt);

  const onTap = async () => {
    if (progress.complete && goal.type !== 'number' && goal.type !== 'habit') return;
    if (goal.type === 'habit' || goal.type === 'yesno') {
      await log(goal, progress, 1);
    } else {
      setOpen((o) => !o);
    }
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface">
      <button onClick={onTap} className="flex w-full items-center gap-3 px-4 py-3.5 text-left active:bg-white/5">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[17px] font-medium">{goal.title}</span>
          </div>
          <div className="mt-0.5 flex gap-2 text-[13px]">
            <span className="text-dim">{progressText(goal, progress)}</span>
            <span className={STATUS_COLOR[progress.status]}>{STATUS_LABEL[progress.status]}</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
            <motion.div
              className="h-full rounded-full"
              style={{ background: accent, boxShadow: `0 0 10px ${accent}` }}
              initial={false}
              animate={{ width: `${Math.round(progress.fraction * 100)}%` }}
              transition={{ duration: 0.6, ease: [0.2, 0.8, 0.2, 1] }}
            />
          </div>
          {showBurner && <div className="mt-1 text-[12px] text-faint">{goalTypeHint(goal)}</div>}
        </div>
        <span
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full border text-xl font-light"
          style={{ borderColor: `${accent}66`, color: accent }}
          aria-hidden
        >
          {progress.complete && goal.type !== 'number' && goal.type !== 'habit' ? '✓' : '+'}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="border-t border-line"
          >
            {goal.type === 'number' && (
              <div className="flex flex-wrap gap-2 p-3">
                {amountChips(goal, logs).map((v) => (
                  <button
                    key={v}
                    onClick={async () => {
                      await log(goal, progress, v);
                      setOpen(false);
                    }}
                    className="min-h-11 min-w-16 rounded-xl bg-raised px-4 text-[16px] font-semibold active:scale-95"
                    style={{ color: accent }}
                  >
                    +{v}
                  </button>
                ))}
                <form
                  className="flex min-w-32 flex-1 gap-2"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const v = Number(custom);
                    if (!v) return;
                    await log(goal, progress, v);
                    setCustom('');
                    setOpen(false);
                  }}
                >
                  <input
                    className={`${inputClass} !py-2`}
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
                  <button
                    onClick={async () => {
                      await log(goal, progress, 1, nextStep.id);
                      setOpen(false);
                    }}
                    className="min-h-12 w-full rounded-xl bg-raised px-4 text-left text-[16px] active:scale-[0.99]"
                  >
                    <span className="text-dim">Complete next step: </span>
                    <span className="font-semibold" style={{ color: accent }}>
                      {nextStep.title}
                    </span>
                  </button>
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
