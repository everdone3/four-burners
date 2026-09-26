// Dashboard scores and per-burner flame state.
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

/** All check-in stamps: logs, energy ratings, and touchpoints. */
export function checkInStamps(input: Pick<DashboardInput, 'logs' | 'energy' | 'touchpoints'>): Stamp[] {
  return [...input.logs, ...input.energy, ...input.touchpoints].filter((s) => !s.deleted);
}

export function computeDashboard(input: DashboardInput): Dashboard {
  const { quarter, goals, logs, people, touchpoints, settings, today } = input;
  const crunch = crunchDateSet(input.crunch, today);
  const stamps = checkInStamps(input);
  const activeDates = new Set(stamps.map((s) => s.localDate));
  const paused = new Set([...crunch, ...timeZoneExcusedDates(stamps, settings.dayBoundaryHour)]);

  const liveGoals = goals.filter((g) => !g.deleted && g.quarterId === quarter.id);
  const liveLogs = logs.filter((l) => !l.deleted);
  const personBurner = new Map(people.filter((p) => !p.deleted).map((p) => [p.id, p.burner]));
  const goalBurner = new Map(liveGoals.map((g) => [g.id, g.burner]));

  const activityByBurner: Record<BurnerId, Set<LocalDate>> = {
    family: new Set(),
    friends: new Set(),
    health: new Set(),
    work: new Set(),
  };
  for (const l of liveLogs) {
    const b = goalBurner.get(l.goalId);
    if (b) activityByBurner[b].add(l.localDate);
  }
  for (const t of touchpoints) {
    if (t.deleted) continue;
    const b = personBurner.get(t.personId);
    if (b) activityByBurner[b].add(t.localDate);
  }

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

    const sorted = [...act].filter((d) => d <= today).sort();
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
  const since = firstActive && firstActive > input.quarterStart ? firstActive : input.quarterStart;
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
