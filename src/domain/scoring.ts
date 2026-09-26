// Dashboard scores and per-burner flame state.
// Everything is computed "as of" input.today: entries dated after it are ignored, so the same
// function answers "how did this look last Sunday?" for weekly reviews and the quarter reel.
import {
  DIM_FADE_DAYS,
  DIM_FLOOR,
  DIM_GRACE_DAYS,
  INTENT_WEIGHTS,
  PILOT_BRIGHTNESS,
  PILOT_HEAT,
  RECENT_ACTIVE_DAYS,
} from './config';
import { addDays, dateRange, diffDays } from './dates';
import { goalProgress, type GoalProgress } from './goals';
import { consistencyScore, dailyStreak, timeZoneExcusedDates, type StreakResult } from './streaks';
import {
  BURNERS,
  type BurnerId,
  type CrunchPeriod,
  type EnergyEntry,
  type Goal,
  type Intent,
  type LocalDate,
  type LogEntry,
  type Person,
  type Quarter,
  type Settings,
  type Stamp,
  type Touchpoint,
  type WeeklyAction,
} from './types';

export interface DashboardInput {
  quarter: Quarter;
  quarterStart: LocalDate;
  goals: readonly Goal[];
  logs: readonly LogEntry[];
  energy: readonly EnergyEntry[];
  people: readonly Person[];
  touchpoints: readonly Touchpoint[];
  crunch: readonly CrunchPeriod[];
  actions?: readonly WeeklyAction[];
  settings: Settings;
  today: LocalDate;
}

export type BurnerStatus = 'on_track' | 'behind' | 'slipping' | 'idle';

export interface BurnerSummary {
  burner: BurnerId;
  intent: Intent;
  goals: { goal: Goal; progress: GoalProgress }[];
  /** Mean goal pace 0..1, or null with no goals. */
  pace: number | null;
  /** 0..1, drives flame size and intensity. */
  heat: number;
  /** DIM_FLOOR..1, drops gently when a burner goes quiet. */
  brightness: number;
  status: BurnerStatus;
  lastActive?: LocalDate;
  activeDaysLast7: number;
}

export interface Dashboard {
  progressScore: number;
  consistencyScore: number;
  streak: StreakResult;
  burners: Record<BurnerId, BurnerSummary>;
  inCrunchToday: boolean;
}

/** Expand crunch periods to a set of dates, capping open-ended periods at `today`. */
export function crunchDateSet(periods: readonly CrunchPeriod[], today: LocalDate): Set<LocalDate> {
  const out = new Set<LocalDate>();
  for (const p of periods) {
    if (p.deleted) continue;
    const end = p.end && p.end < today ? p.end : today;
    if (p.start > end) continue;
    for (const d of dateRange(p.start, end)) out.add(d);
  }
  return out;
}

/** The crunch period covering `today`, if any. */
export function activeCrunch(periods: readonly CrunchPeriod[], today: LocalDate): CrunchPeriod | undefined {
  return periods.find((p) => !p.deleted && p.start <= today && (!p.end || p.end >= today));
}

/** Drop deleted entries and anything dated after `asOf`. */
function upTo<T extends { deleted?: boolean; localDate: LocalDate }>(xs: readonly T[], asOf: LocalDate): T[] {
  return xs.filter((x) => !x.deleted && x.localDate <= asOf);
}

/** All check-in stamps up to `asOf`: logs, energy ratings, touchpoints, and completed actions. */
export function checkInStamps(
  input: Pick<DashboardInput, 'logs' | 'energy' | 'touchpoints' | 'actions'>,
  asOf = '9999-12-31',
): Stamp[] {
  const actionStamps = (input.actions ?? []).filter((a) => !a.deleted && a.done).map((a) => a.done!);
  return [
    ...upTo(input.logs, asOf),
    ...upTo(input.energy, asOf),
    ...upTo(input.touchpoints, asOf),
    ...actionStamps.filter((s) => s.localDate <= asOf),
  ];
}

/** Dates each burner saw activity (goal logs, touchpoints with its people, completed actions). */
export function burnerActivity(
  input: Pick<DashboardInput, 'goals' | 'logs' | 'people' | 'touchpoints' | 'actions'>,
  asOf: LocalDate,
): Record<BurnerId, Set<LocalDate>> {
  const out: Record<BurnerId, Set<LocalDate>> = { family: new Set(), friends: new Set(), health: new Set(), work: new Set() };
  const goalBurner = new Map(input.goals.filter((g) => !g.deleted).map((g) => [g.id, g.burner]));
  const personBurner = new Map(input.people.filter((p) => !p.deleted).map((p) => [p.id, p.burner]));
  for (const l of upTo(input.logs, asOf)) {
    const b = goalBurner.get(l.goalId);
    if (b) out[b].add(l.localDate);
  }
  for (const t of upTo(input.touchpoints, asOf)) {
    const b = personBurner.get(t.personId);
    if (b) out[b].add(t.localDate);
  }
  for (const a of input.actions ?? []) {
    if (!a.deleted && a.done && a.burner && a.done.localDate <= asOf) out[a.burner].add(a.done.localDate);
  }
  return out;
}

export function computeDashboard(input: DashboardInput): Dashboard {
  const { quarter, goals, settings, today } = input;
  const crunch = crunchDateSet(input.crunch, today);
  const stamps = checkInStamps(input, today);
  const activeDates = new Set(stamps.map((s) => s.localDate));
  const paused = new Set([...crunch, ...timeZoneExcusedDates(stamps, settings.dayBoundaryHour)]);

  const liveGoals = goals.filter((g) => !g.deleted && g.quarterId === quarter.id);
  const liveLogs = upTo(input.logs, today);
  const activityByBurner = burnerActivity({ ...input, goals: liveGoals }, today);

  const last7 = dateRange(addDays(today, -6), today);
  const nonCrunchLast7 = last7.filter((d) => !crunch.has(d)).length;

  const burners = {} as Record<BurnerId, BurnerSummary>;
  let weighted = 0;
  let weights = 0;

  for (const b of BURNERS) {
    const intent = quarter.intents[b];
    const bGoals = liveGoals
      .filter((g) => g.burner === b)
      .sort((x, y) => x.order - y.order)
      .map((goal) => ({ goal, progress: goalProgress(goal, liveLogs, today, { intent, crunchDates: crunch }) }));
    const pace = bGoals.length ? bGoals.reduce((s, g) => s + g.progress.pace, 0) / bGoals.length : null;
    if (pace !== null) {
      weighted += INTENT_WEIGHTS[intent] * pace;
      weights += INTENT_WEIGHTS[intent];
    }

    const act = activityByBurner[b];
    const activeDaysLast7 = last7.filter((d) => act.has(d)).length;
    const needed = RECENT_ACTIVE_DAYS[intent] * (nonCrunchLast7 / 7);
    const recent = needed < 0.5 ? 1 : Math.min(1, activeDaysLast7 / needed);
    const heat = Math.max(PILOT_HEAT, pace === null ? recent : 0.6 * pace + 0.4 * recent);

    const sorted = [...act].sort();
    const lastActive = sorted[sorted.length - 1];
    // Silence is measured from the last activity, or from when the burner's first goal began.
    const firstGoalStart = bGoals.map((g) => g.goal.startDate).sort()[0];
    const quietFrom = lastActive ?? firstGoalStart;
    let brightness: number;
    if (!quietFrom) {
      brightness = PILOT_BRIGHTNESS; // nothing set up yet: a steady pilot light, not a dying flame
    } else {
      const quietDays =
        quietFrom >= today
          ? 0
          : dateRange(addDays(quietFrom, 1), today).filter((d) => !crunch.has(d)).length;
      const over = Math.max(0, quietDays - DIM_GRACE_DAYS[intent]);
      brightness = Math.max(DIM_FLOOR, 1 - (over / DIM_FADE_DAYS) * (1 - DIM_FLOOR));
    }

    const status: BurnerStatus =
      pace === null
        ? act.size
          ? 'on_track'
          : 'idle'
        : pace >= 0.9
          ? 'on_track'
          : pace >= 0.6
            ? 'behind'
            : 'slipping';

    burners[b] = { burner: b, intent, goals: bGoals, pace, heat, brightness, status, lastActive, activeDaysLast7 };
  }

  const firstActive = [...activeDates].sort()[0];
  // Consistency is a rolling window that carries across quarter boundaries (a new quarter is not a reset).
  const since = firstActive ?? today;
  const streakInput = {
    activeDates,
    today,
    graceDaysPerWeek: settings.graceDaysPerWeek,
    pausedDates: paused,
  };

  return {
    progressScore: weights ? Math.round((weighted / weights) * 100) : 0,
    consistencyScore: consistencyScore({ ...streakInput, since }),
    streak: dailyStreak(streakInput),
    burners,
    inCrunchToday: crunch.has(today),
  };
}

/** Days since a person was last contacted, and how that compares to their cadence. */
export function daysSince(from: LocalDate | undefined, today: LocalDate): number | null {
  return from ? diffDays(from, today) : null;
}
