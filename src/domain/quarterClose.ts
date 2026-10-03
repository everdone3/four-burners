// Quarter close: highlights for the reel, suggested grades, and carrying goals forward.
import { GOAL_LIMITS, INTENT_WEIGHTS } from './config';
import { addDays, dateRange, quarterSpan, weekday } from './dates';
import { goalProgress } from './goals';
import { intentOn } from './intents';
import { burnerActivity, checkInStamps, computeDashboard, crunchDateSet, type DashboardInput } from './scoring';
import { dailyStreak, habitStreak } from './streaks';
import {
  BURNERS,
  type BurnerId,
  type CloseDecision,
  type Goal,
  type Grade,
  type Instant,
  type LocalDate,
  type QuarterId,
  type QuarterSummary,
  type WeeklyReview,
} from './types';

export const GRADES: readonly Grade[] = ['A', 'B', 'C', 'D', 'F'] as const;

export const GRADE_LABELS: Record<Grade, string> = {
  A: 'Crushed it',
  B: 'Strong',
  C: 'Partial',
  D: 'Barely',
  F: 'Missed',
};

/** A starting grade from how much of the goal got done. You can always change it. */
export function suggestedGrade(fraction: number, complete: boolean): Grade {
  if (complete || fraction >= 0.9) return 'A';
  if (fraction >= 0.75) return 'B';
  if (fraction >= 0.5) return 'C';
  if (fraction >= 0.25) return 'D';
  return 'F';
}

/** Copy a goal into the next quarter with fresh progress. Unfinished milestone steps carry; done ones do not. */
export function carryForward(
  goal: Goal,
  next: { quarterId: QuarterId; startDate: LocalDate; deadline: LocalDate },
  id: string,
  at: Instant,
  order: number,
): Goal {
  const open = goal.milestones?.filter((m) => !m.doneAt) ?? [];
  const steps = goal.type === 'milestone' ? (open.length ? open : goal.milestones ?? []) : undefined;
  return {
    id,
    createdAt: at,
    updatedAt: at,
    quarterId: next.quarterId,
    burner: goal.burner,
    title: goal.title,
    type: goal.type,
    why: goal.why,
    whenWhere: goal.whenWhere,
    target: goal.target,
    unit: goal.unit,
    habitPeriod: goal.habitPeriod,
    milestones: steps?.map((m, i) => ({ id: `${id}-s${i}`, title: m.title })),
    personIds: goal.personIds,
    health: goal.health,
    startDate: next.startDate,
    deadline: next.deadline,
    order,
    carriedFromId: goal.id,
  };
}

/** Burners where carrying these decisions forward would exceed the goal limit. */
export function carryOverflow(
  goals: readonly Goal[],
  decisions: Record<string, CloseDecision | undefined>,
  alreadyInNext: Partial<Record<BurnerId, number>> = {},
): BurnerId[] {
  return BURNERS.filter((b) => {
    const carrying = goals.filter((g) => g.burner === b && (decisions[g.id] === 'carry' || decisions[g.id] === 'modify')).length;
    return carrying + (alreadyInNext[b] ?? 0) > GOAL_LIMITS.max;
  });
}

export interface Highlights {
  quarterId: QuarterId;
  theme?: string;
  asOf: LocalDate;
  progressScore: number;
  consistencyScore: number;
  checkInDays: number;
  daysInQuarter: number;
  totalLogs: number;
  touchpointCount: number;
  actionsDone: number;
  longestStreak: number;
  habitStreaks: { title: string; burner: BurnerId; periods: number; unit: 'week' | 'month' }[];
  brightest?: { burner: BurnerId; pace: number; activeDays: number };
  burnerDays: Record<BurnerId, number>;
  topWins: { text: string; burner?: BurnerId }[];
  comeback?: { title: string; burner: BurnerId; from: number; to: number };
  mostConnected: { name: string; burner: BurnerId; count: number }[];
  energyAvg: number | null;
  crunchDays: number;
  goalsDone: number;
  goalsTotal: number;
}

export interface HighlightsInput extends Omit<DashboardInput, 'quarterStart'> {
  reviews?: readonly WeeklyReview[];
}

/** Everything the highlights reel shows, computed from the quarter's data as of `today` (capped at quarter end). */
export function quarterHighlights(input: HighlightsInput): Highlights {
  const span = quarterSpan(input.quarter.id);
  const asOf = input.today < span.end ? input.today : span.end;
  const within = (d: LocalDate) => d >= span.start && d <= asOf;
  const dashInput: DashboardInput = { ...input, quarterStart: span.start, today: asOf };
  const dash = computeDashboard(dashInput);
  const crunch = crunchDateSet(input.crunch, asOf);
  const goals = input.goals.filter((g) => !g.deleted && g.quarterId === input.quarter.id);
  const goalIds = new Set(goals.map((g) => g.id));
  const logs = input.logs.filter((l) => !l.deleted && goalIds.has(l.goalId) && l.localDate <= asOf);

  const stamps = checkInStamps(input, asOf).filter((s) => within(s.localDate));
  const activeDates = new Set(stamps.map((s) => s.localDate));
  const longestStreak = dailyStreak({
    activeDates,
    today: asOf,
    graceDaysPerWeek: input.settings.graceDaysPerWeek,
    pausedDates: crunch,
  }).longest;

  const habitStreaks = goals
    .filter((g) => g.type === 'habit')
    .map((g) => ({
      title: g.title,
      burner: g.burner,
      periods: habitStreak(g, logs, asOf, crunch).longest,
      unit: (g.habitPeriod === 'month' ? 'month' : 'week') as 'week' | 'month',
    }))
    .filter((h) => h.periods >= 2)
    .sort((a, b) => b.periods - a.periods)
    .slice(0, 3);

  const activity = burnerActivity({ ...input, goals }, asOf);
  const burnerDays = Object.fromEntries(
    BURNERS.map((b) => [b, [...activity[b]].filter(within).length]),
  ) as Record<BurnerId, number>;

  // Brightest: pace weighted by intent, so a High burner at full pace outshines a Low one at full pace.
  // Ties go to the burner with more active days.
  let brightest: Highlights["brightest"];
  const rank = (x: { burner: BurnerId; pace: number; activeDays: number }) =>
    [Math.round(x.pace * INTENT_WEIGHTS[input.quarter.intents[x.burner]] * 100), 0, x.activeDays];
  for (const b of BURNERS) {
    const pace = dash.burners[b].pace;
    if (pace === null && burnerDays[b] === 0) continue;
    const cand = { burner: b, pace: pace ?? 0, activeDays: burnerDays[b] };
    if (!brightest) {
      brightest = cand;
      continue;
    }
    const [a, c] = [rank(cand), rank(brightest)];
    if (a[0] > c[0] || (a[0] === c[0] && (a[1] > c[1] || (a[1] === c[1] && a[2] > c[2])))) brightest = cand;
  }

  // Wins: completed goals first, then wins you wrote in weekly reviews this quarter.
  const done = BURNERS.flatMap((b) => dash.burners[b].goals.filter((g) => g.progress.complete).map((g) => ({ text: g.goal.title, burner: b })));
  const reviewWins = (input.reviews ?? [])
    .filter((r) => !r.deleted && within(r.weekStart))
    .sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1))
    .flatMap((r) => r.wins.map((w) => ({ text: w })));
  // "Completed Date night" from a review and the goal "Date night" are the same win.
  const norm = (t: string) => t.toLowerCase().replace(/^completed /, "").trim();
  const topWins = [...done, ...reviewWins].filter((w, i, xs) => xs.findIndex((x) => norm(x.text) === norm(w.text)) === i).slice(0, 5);

  // Biggest comeback: largest climb from a low point in pace to where the goal finished.
  let comeback: Highlights['comeback'];
  for (const g of goals) {
    // Only goals with a continuous pace can stage a comeback; a Yes/No just flips once.
    if (g.type !== 'number' && g.type !== 'habit') continue;
    const samples = dateRange(addDays(g.startDate, 13), asOf).filter((d) => weekday(d) === 6);
    if (samples.length < 2) continue;
    const paceAt = (d: LocalDate) =>
      goalProgress(g, logs.filter((l) => l.localDate <= d), d, { intent: intentOn(input.quarter, g.burner, d), crunchDates: crunch }).pace;
    const low = Math.min(...samples.slice(0, -1).map(paceAt));
    const end = paceAt(asOf);
    const climb = end - low;
    if (climb >= 0.2 && end >= 0.75 && (!comeback || climb > comeback.to - comeback.from)) {
      comeback = { title: g.title, burner: g.burner, from: low, to: end };
    }
  }

  const people = new Map(input.people.map((p) => [p.id, p]));
  const counts = new Map<string, number>();
  let touchpointCount = 0;
  for (const t of input.touchpoints) {
    if (t.deleted || !within(t.localDate)) continue;
    touchpointCount++;
    counts.set(t.personId, (counts.get(t.personId) ?? 0) + 1);
  }
  const mostConnected = [...counts]
    .map(([id, count]) => ({ p: people.get(id), count }))
    .filter((x) => x.p)
    .map((x) => ({ name: x.p!.name, burner: x.p!.burner as BurnerId, count: x.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  const ratings = input.energy.filter((e) => !e.deleted && within(e.localDate)).map((e) => e.rating as number);
  const allProgress = BURNERS.flatMap((b) => dash.burners[b].goals);

  return {
    quarterId: input.quarter.id,
    theme: input.quarter.theme,
    asOf,
    progressScore: dash.progressScore,
    consistencyScore: dash.consistencyScore,
    checkInDays: activeDates.size,
    daysInQuarter: dateRange(span.start, asOf).length,
    totalLogs: logs.length,
    touchpointCount,
    actionsDone: (input.actions ?? []).filter((a) => !a.deleted && a.done && within(a.done.localDate)).length,
    longestStreak,
    habitStreaks,
    brightest,
    burnerDays,
    topWins,
    comeback,
    mostConnected,
    energyAvg: ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null,
    crunchDays: [...crunch].filter(within).length,
    goalsDone: allProgress.filter((g) => g.progress.complete).length,
    goalsTotal: allProgress.length,
  };
}

export function summaryFrom(h: Highlights): QuarterSummary {
  return {
    progressScore: h.progressScore,
    consistencyScore: h.consistencyScore,
    longestStreak: h.longestStreak,
    checkInDays: h.checkInDays,
  };
}

/** The most recent quarter before `current` that is still open and has goals: it needs closing. */
export function quarterNeedingClose<T extends { id: QuarterId; status: string }>(
  quarters: readonly T[],
  goals: readonly Goal[],
  currentId: QuarterId,
): T | undefined {
  return [...quarters]
    .filter((q) => q.id < currentId && q.status === 'active' && goals.some((g) => !g.deleted && g.quarterId === q.id))
    .sort((a, b) => (a.id < b.id ? 1 : -1))[0];
}
