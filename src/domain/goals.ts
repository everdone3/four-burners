// Goal limits, creation checks, and per-goal progress with proration.
import {
  CRUNCH_EXPECTATION,
  GOAL_LIMITS,
  INTENT_EXPECTATION,
  NEW_GOAL_GRACE_DAYS,
  PACE_THRESHOLDS,
} from './config';
import { addDays, dateRange, diffDays, maxDate, minDate } from './dates';
import type { BurnerId, Goal, Intent, LocalDate, LogEntry } from './types';

// ---------- Limits ----------

export interface GoalSlot {
  allowed: boolean;
  /** True once the burner has reached the suggested count (3); a 4th is allowed but optional. */
  pastSuggested: boolean;
  message?: string;
}

export function goalSlot(existingInBurner: number): GoalSlot {
  if (existingInBurner >= GOAL_LIMITS.max) {
    return {
      allowed: false,
      pastSuggested: true,
      message: `${GOAL_LIMITS.max} goals is the limit for a burner. Fewer goals burn brighter.`,
    };
  }
  if (existingInBurner >= GOAL_LIMITS.suggested) {
    return {
      allowed: true,
      pastSuggested: true,
      message: `${GOAL_LIMITS.suggested} is the sweet spot. A ${GOAL_LIMITS.max}th is fine if it matters.`,
    };
  }
  return { allowed: true, pastSuggested: false };
}

// ---------- Creation checks ----------

export type GoalWarningCode = 'no_why' | 'no_when_where' | 'no_target' | 'low_outweighs_high';

export interface GoalWarning {
  code: GoalWarningCode;
  message: string;
}

export type GoalDraft = Pick<Goal, 'burner' | 'type' | 'title'> &
  Partial<Pick<Goal, 'why' | 'whenWhere' | 'target' | 'milestones'>>;

/**
 * Rule-based checks shown while creating a goal. Warnings, never blockers.
 * `goalCounts` should reflect counts *including* this draft if it were saved.
 */
export function checkGoal(
  draft: GoalDraft,
  intents: Record<BurnerId, Intent>,
  goalCounts: Record<BurnerId, number>,
): GoalWarning[] {
  const out: GoalWarning[] = [];
  if (!draft.why?.trim()) {
    out.push({ code: 'no_why', message: 'Add a why. It is what pulls you back when this slips.' });
  }
  if (!draft.whenWhere?.trim()) {
    out.push({
      code: 'no_when_where',
      message: 'Add when and where you will do it. Specific plans get done.',
    });
  }
  if ((draft.type === 'number' || draft.type === 'habit') && !(draft.target && draft.target > 0)) {
    out.push({ code: 'no_target', message: 'Set a target so progress can be measured.' });
  }
  const burners = Object.keys(intents) as BurnerId[];
  const lows = burners.filter((b) => intents[b] === 'low');
  const highs = burners.filter((b) => intents[b] === 'high');
  if (lows.includes(draft.burner) && highs.length > 0) {
    const maxHigh = Math.max(...highs.map((b) => goalCounts[b] ?? 0));
    if ((goalCounts[draft.burner] ?? 0) > maxHigh) {
      out.push({
        code: 'low_outweighs_high',
        message: 'This Low burner would have more goals than a High one. Worth a second look.',
      });
    }
  }
  return out;
}

// ---------- Progress ----------

export type GoalStatus = 'done' | 'on_track' | 'behind' | 'slipping';

export interface GoalProgress {
  /** Logged amount in the goal's own units (count for habits, steps for milestones). */
  actual: number;
  /** Full target over the goal's prorated window. */
  required: number;
  /** actual / required, 0..1 */
  fraction: number;
  /** Where you should be by now, 0..1, after proration, intent and crunch adjustments. */
  expected: number;
  /** fraction / expected, capped at 1. 1 means on or ahead of pace. */
  pace: number;
  status: GoalStatus;
  complete: boolean;
}

export interface ProgressContext {
  intent: Intent;
  /** Local dates in Travel/Crunch mode. Expectations are softened on these days. */
  crunchDates?: ReadonlySet<LocalDate>;
}

const MONTH_DAYS = 365.25 / 12;

/** Days in the goal's window: from when it was added until its deadline, inclusive. */
export function windowDays(goal: Pick<Goal, 'startDate' | 'deadline'>): number {
  return Math.max(1, diffDays(goal.startDate, goal.deadline) + 1);
}

/** Total required for the goal over its prorated window. */
export function requiredFor(goal: Goal): number {
  switch (goal.type) {
    case 'number':
      return Math.max(0, goal.target ?? 0);
    case 'habit': {
      const perPeriod = Math.max(0, goal.target ?? 0);
      const periodDays = goal.habitPeriod === 'month' ? MONTH_DAYS : 7;
      return Math.max(perPeriod > 0 ? 1 : 0, Math.round((perPeriod * windowDays(goal)) / periodDays));
    }
    case 'yesno':
      return 1;
    case 'milestone':
      return goal.milestones?.length ?? 0;
  }
}

export function actualFor(goal: Goal, logs: readonly LogEntry[]): number {
  const mine = logs.filter((l) => l.goalId === goal.id && !l.deleted);
  switch (goal.type) {
    case 'number':
    case 'habit':
      return mine.reduce((s, l) => s + l.value, 0);
    case 'yesno':
      return mine.some((l) => l.value > 0) ? 1 : 0;
    case 'milestone': {
      // Counted from logs (not doneAt) so "as of" a past date only sees steps done by then.
      const done = new Set(mine.map((l) => l.milestoneId).filter(Boolean));
      return goal.milestones?.filter((m) => done.has(m.id)).length ?? 0;
    }
  }
}

/**
 * Fraction of the goal's window that has elapsed as of `today`, 0..1.
 * Today counts as half a day (it is not over yet). Crunch days count at a reduced weight,
 * so expectations stop climbing as fast while traveling.
 */
export function elapsedFraction(
  goal: Pick<Goal, 'startDate' | 'deadline'>,
  today: LocalDate,
  crunchDates?: ReadonlySet<LocalDate>,
): number {
  if (today < goal.startDate) return 0;
  const total = windowDays(goal);
  if (today > goal.deadline) {
    // Past the deadline: all days elapsed, still honoring crunch softening.
    return weightedDays(goal.startDate, goal.deadline, crunchDates) / total;
  }
  const beforeToday =
    today > goal.startDate ? weightedDays(goal.startDate, addDays(today, -1), crunchDates) : 0;
  const todayWeight = crunchDates?.has(today) ? CRUNCH_EXPECTATION : 1;
  return Math.min(1, (beforeToday + 0.5 * todayWeight) / total);
}

function weightedDays(a: LocalDate, b: LocalDate, crunch?: ReadonlySet<LocalDate>): number {
  if (b < a) return 0;
  if (!crunch || crunch.size === 0) return diffDays(a, b) + 1;
  let sum = 0;
  for (const d of dateRange(a, b)) sum += crunch.has(d) ? CRUNCH_EXPECTATION : 1;
  return sum;
}

/** Yes/No goals ramp expectation quadratically: little pressure early, more near the deadline. */
function shapeExpectation(type: Goal['type'], elapsed: number): number {
  return type === 'yesno' ? elapsed * elapsed : elapsed;
}

export function goalProgress(
  goal: Goal,
  logs: readonly LogEntry[],
  today: LocalDate,
  ctx: ProgressContext,
): GoalProgress {
  const required = requiredFor(goal);
  const actual = actualFor(goal, logs);
  const fraction = required > 0 ? Math.min(1, actual / required) : 0;
  const complete = required > 0 && actual >= required;
  const elapsed = elapsedFraction(goal, today, ctx.crunchDates);
  const expected = shapeExpectation(goal.type, elapsed) * INTENT_EXPECTATION[ctx.intent];
  let pace: number;
  if (complete) pace = 1;
  else if (expected < 0.02 || diffDays(goal.startDate, today) < NEW_GOAL_GRACE_DAYS) pace = 1; // too early to judge
  else pace = Math.min(1, fraction / expected);
  const status: GoalStatus = complete
    ? 'done'
    : pace >= PACE_THRESHOLDS.onTrack
      ? 'on_track'
      : pace >= PACE_THRESHOLDS.behind
        ? 'behind'
        : 'slipping';
  return { actual, required, fraction, expected, pace, status, complete };
}

/** Clamp a goal's window to the quarter it belongs to. */
export function clampWindow(
  startDate: LocalDate,
  deadline: LocalDate,
  quarterStart: LocalDate,
  quarterEnd: LocalDate,
): { startDate: LocalDate; deadline: LocalDate } {
  const s = maxDate(startDate, quarterStart);
  return { startDate: s, deadline: maxDate(s, minDate(deadline, quarterEnd)) };
}
