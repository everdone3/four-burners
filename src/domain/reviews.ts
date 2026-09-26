// Weekly review: which week is due, the rule-based summary, and suggestions.
import { RECENT_ACTIVE_DAYS } from './config';
import { addDays, dateRange, startOfWeek, weekday } from './dates';
import { energyOn, energyTrend, type EnergyTrend } from './logs';
import { peopleByUrgency } from './people';
import { burnerActivity, checkInStamps, computeDashboard, crunchDateSet, type BurnerStatus, type DashboardInput } from './scoring';
import type { StreakResult } from './streaks';
import { BURNERS, BURNER_LABELS, type BurnerId, type Intent, type LocalDate, type WeeklyAction } from './types';

/** Days the review stays "due" starting on review day (e.g. Sunday through Wednesday). */
export const REVIEW_WINDOW_DAYS = 4;

/** Monday of the week whose review is due today, or null if none is due. */
export function dueReviewWeek(today: LocalDate, reviewDay: number): LocalDate | null {
  const thisWeek = startOfWeek(today);
  for (const w of [thisWeek, addDays(thisWeek, -7)]) {
    const dueStart = addDays(w, reviewDay);
    if (today >= dueStart && today <= addDays(dueStart, REVIEW_WINDOW_DAYS - 1)) return w;
  }
  return null;
}

/** The week to review when opened by hand: the due week, else this week from Thursday on, else last week. */
export function reviewWeekFor(today: LocalDate, reviewDay: number): LocalDate {
  return dueReviewWeek(today, reviewDay) ?? (weekday(today) >= 3 ? startOfWeek(today) : addDays(startOfWeek(today), -7));
}

/** Actions created in a review are for the week after the reviewed week. */
export function actionsWeekFor(reviewedWeek: LocalDate): LocalDate {
  return addDays(reviewedWeek, 7);
}

export type Trend = 'up' | 'down' | 'flat' | 'new';

export interface BurnerWeek {
  intent: Intent;
  status: BurnerStatus;
  pace: number | null;
  prevPace: number | null;
  trend: Trend;
  activeDays: number;
  expectedActiveDays: number;
  logCount: number;
}

export interface WeekSummary {
  weekStart: LocalDate;
  weekEnd: LocalDate;
  /** Days of the week that have happened (1..7). */
  daysElapsed: number;
  checkInDays: number;
  /** Monday..Sunday: whether you checked in that day. */
  checkedIn: boolean[];
  burners: Record<BurnerId, BurnerWeek>;
  streak: StreakResult;
  progressScore: number;
  energy: EnergyTrend & { days: (number | null)[] };
  overduePeople: { name: string; burner: BurnerId; daysSince: number | null }[];
  connected: string[];
  crunchDays: number;
  completedGoals: { title: string; burner: BurnerId }[];
  actions: { done: number; total: number; undone: { text: string; burner?: BurnerId }[] };
  bestDay?: { date: LocalDate; count: number };
}

export function weekSummary(input: Omit<DashboardInput, 'today'> & { today: LocalDate }, weekStart: LocalDate): WeekSummary {
  const weekEnd = addDays(weekStart, 6);
  const asOf = input.today < weekEnd ? input.today : weekEnd;
  const days = dateRange(weekStart, asOf);
  const now = computeDashboard({ ...input, today: asOf });
  const prevDay = addDays(weekStart, -1);
  const hasPrev = prevDay >= input.quarterStart;
  const before = hasPrev ? computeDashboard({ ...input, today: prevDay }) : null;
  const crunch = crunchDateSet(input.crunch, asOf);
  const activity = burnerActivity(input, asOf);
  const inWeek = (d: LocalDate) => d >= weekStart && d <= asOf;

  const goalBurner = new Map(input.goals.filter((g) => !g.deleted).map((g) => [g.id, g.burner]));
  const logCounts: Record<BurnerId, number> = { family: 0, friends: 0, health: 0, work: 0 };
  for (const l of input.logs) {
    if (l.deleted || !inWeek(l.localDate)) continue;
    const b = goalBurner.get(l.goalId);
    if (b) logCounts[b]++;
  }

  const nonCrunch = days.filter((d) => !crunch.has(d)).length;
  const burners = {} as Record<BurnerId, BurnerWeek>;
  for (const b of BURNERS) {
    const cur = now.burners[b];
    const prevPace = before?.burners[b].pace ?? null;
    const trend: Trend =
      cur.pace === null || prevPace === null ? 'new' : cur.pace - prevPace > 0.05 ? 'up' : prevPace - cur.pace > 0.05 ? 'down' : 'flat';
    burners[b] = {
      intent: cur.intent,
      status: cur.status,
      pace: cur.pace,
      prevPace,
      trend,
      activeDays: days.filter((d) => activity[b].has(d)).length,
      expectedActiveDays: Math.round(RECENT_ACTIVE_DAYS[cur.intent] * (nonCrunch / 7) * 10) / 10,
      logCount: logCounts[b],
    };
  }

  const stamps = checkInStamps(input, asOf).filter((s) => inWeek(s.localDate));
  const perDay = new Map<LocalDate, number>();
  for (const s of stamps) perDay.set(s.localDate, (perDay.get(s.localDate) ?? 0) + 1);
  let bestDay: WeekSummary['bestDay'];
  for (const [date, count] of perDay) if (!bestDay || count > bestDay.count) bestDay = { date, count };

  const completedGoals: WeekSummary['completedGoals'] = [];
  for (const b of BURNERS) {
    for (const { goal, progress } of now.burners[b].goals) {
      const was = before?.burners[b].goals.find((g) => g.goal.id === goal.id)?.progress.complete ?? false;
      if (progress.complete && !was) completedGoals.push({ title: goal.title, burner: b });
    }
  }

  const people = input.people.filter((p) => !p.deleted);
  const connectedIds = new Set(input.touchpoints.filter((t) => !t.deleted && inWeek(t.localDate)).map((t) => t.personId));
  const weekActions = (input.actions ?? []).filter((a): a is WeeklyAction => !a.deleted && a.weekStart === weekStart);

  return {
    weekStart,
    weekEnd,
    daysElapsed: days.length,
    checkInDays: perDay.size,
    checkedIn: dateRange(weekStart, weekEnd).map((d) => perDay.has(d)),
    burners,
    streak: now.streak,
    progressScore: now.progressScore,
    energy: { ...energyTrend(input.energy, asOf), days: dateRange(weekStart, weekEnd).map((d) => (d <= asOf ? energyOn(input.energy, d)?.rating ?? null : null)) },
    overduePeople: peopleByUrgency(people, input.touchpoints, asOf)
      .filter((s) => s.state === 'overdue' || s.state === 'due')
      .map((s) => ({ name: s.person.name, burner: s.person.burner, daysSince: s.daysSince })),
    connected: people.filter((p) => connectedIds.has(p.id)).map((p) => p.name),
    crunchDays: days.filter((d) => crunch.has(d)).length,
    completedGoals,
    actions: {
      done: weekActions.filter((a) => a.done).length,
      total: weekActions.length,
      undone: weekActions.filter((a) => !a.done).map((a) => ({ text: a.text, burner: a.burner })),
    },
    bestDay,
  };
}

// ---------- Suggestions (tap to add; never auto-filled) ----------

export function suggestWins(s: WeekSummary): string[] {
  const out: string[] = [];
  for (const g of s.completedGoals) out.push(`Completed ${g.title}`);
  for (const b of BURNERS) {
    const w = s.burners[b];
    if (w.activeDays > 0 && w.activeDays >= w.expectedActiveDays && w.status === 'on_track') {
      out.push(`${BURNER_LABELS[b]} burned bright: ${w.activeDays} active ${w.activeDays === 1 ? 'day' : 'days'}`);
    }
  }
  if (s.connected.length) out.push(`Connected with ${listOf(s.connected)}`);
  if (s.streak.current >= 7) out.push(`${s.streak.current}-day check-in streak`);
  if (s.actions.done > 0) out.push(`Finished ${s.actions.done} of ${s.actions.total} planned actions`);
  if (s.energy.direction === 'up') out.push('Energy trended up');
  return unique(out).slice(0, 6);
}

export function suggestMisses(s: WeekSummary): string[] {
  const out: string[] = [];
  for (const b of BURNERS) {
    const w = s.burners[b];
    if (w.intent !== 'low' && (w.status === 'behind' || w.status === 'slipping')) {
      out.push(`${BURNER_LABELS[b]} fell behind: ${w.activeDays} of about ${Math.ceil(w.expectedActiveDays)} active days`);
    }
  }
  for (const a of s.actions.undone.slice(0, 3)) out.push(`Did not get to: ${a.text}`);
  for (const p of s.overduePeople.slice(0, 2)) {
    out.push(p.daysSince === null ? `Have not connected with ${p.name} yet` : `${p.daysSince} days since I connected with ${p.name}`);
  }
  if (s.energy.direction === 'down') out.push('Energy dipped this week');
  return unique(out).slice(0, 6);
}

export interface ActionSuggestion {
  text: string;
  burner?: BurnerId;
}

export function suggestActions(s: WeekSummary, input: Pick<DashboardInput, 'goals'>): ActionSuggestion[] {
  const out: ActionSuggestion[] = [];
  for (const p of s.overduePeople.slice(0, 2)) out.push({ text: `Call ${p.name}`, burner: p.burner });
  for (const b of BURNERS) {
    const w = s.burners[b];
    if (w.intent === 'low' || (w.status !== 'behind' && w.status !== 'slipping')) continue;
    const goal = input.goals.find((g) => !g.deleted && g.burner === b);
    if (goal) out.push({ text: goal.whenWhere ? `${goal.title}: ${goal.whenWhere}` : `Schedule ${goal.title}`, burner: b });
  }
  for (const a of s.actions.undone.slice(0, 2)) out.push({ text: a.text, burner: a.burner });
  const seen = new Set<string>();
  return out.filter((a) => !seen.has(a.text.toLowerCase()) && !!seen.add(a.text.toLowerCase())).slice(0, 5);
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}

function listOf(names: string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}
