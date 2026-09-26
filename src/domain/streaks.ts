// Streaks, grace days, consistency, and time zone forgiveness.
import { CONSISTENCY_WINDOW_DAYS } from './config';
import { addDays, dateRange, diffDays, localDateFor, maxDate, startOfWeek } from './dates';
import type { LocalDate, Stamp } from './types';

export interface StreakInput {
  /** Lived dates with at least one check-in. */
  activeDates: ReadonlySet<LocalDate>;
  today: LocalDate;
  graceDaysPerWeek: number;
  /** Dates that neither count nor break the streak (Travel/Crunch, time zone skips). */
  pausedDates?: ReadonlySet<LocalDate>;
}

export interface StreakResult {
  current: number;
  longest: number;
  /** Grace days used in the current week while the current streak is alive. */
  graceUsedThisWeek: number;
}

/**
 * Daily streak with automatic grace days. A missed day is forgiven if the week
 * (Mon to Sun) still has grace left. Today never breaks a streak since it is not over.
 */
export function dailyStreak({ activeDates, today, graceDaysPerWeek, pausedDates }: StreakInput): StreakResult {
  if (activeDates.size === 0) return { current: 0, longest: 0, graceUsedThisWeek: 0 };
  const first = [...activeDates].sort()[0];
  if (first > today) return { current: 0, longest: 0, graceUsedThisWeek: 0 };
  const graceUsed = new Map<LocalDate, number>();
  let run = 0;
  let longest = 0;
  for (const d of dateRange(first, today)) {
    if (activeDates.has(d)) {
      run++;
    } else if (pausedDates?.has(d) || d === today) {
      // neither counts nor breaks
    } else if (run > 0) {
      const wk = startOfWeek(d);
      const used = graceUsed.get(wk) ?? 0;
      if (used < graceDaysPerWeek) graceUsed.set(wk, used + 1);
      else run = 0;
    }
    if (run === 0) graceUsed.clear();
    longest = Math.max(longest, run);
  }
  return { current: run, longest, graceUsedThisWeek: run > 0 ? (graceUsed.get(startOfWeek(today)) ?? 0) : 0 };
}

/**
 * Period streak for habit goals: consecutive weeks (or months) where the target was met.
 * The current period counts if already met, and never breaks the streak while in progress.
 */
export function periodStreak(
  countsByPeriod: ReadonlyMap<LocalDate, number>,
  periodStarts: readonly LocalDate[],
  target: number,
  pausedPeriods?: ReadonlySet<LocalDate>,
): StreakResult {
  let run = 0;
  let longest = 0;
  periodStarts.forEach((p, i) => {
    const met = (countsByPeriod.get(p) ?? 0) >= target;
    const isCurrent = i === periodStarts.length - 1;
    if (met) run++;
    else if (pausedPeriods?.has(p) || isCurrent) {
      // hold
    } else run = 0;
    longest = Math.max(longest, run);
  });
  return { current: run, longest, graceUsedThisWeek: 0 };
}

/**
 * Dates that were skipped only because of a time zone change (e.g. flying west to east across
 * the date line jumps from Monday evening to Wednesday morning). If two consecutive check-ins
 * are at most one lived day apart when both are viewed in either one's time zone, the calendar
 * dates between them are excused.
 */
export function timeZoneExcusedDates(stamps: readonly Stamp[], dayBoundaryHour: number): Set<LocalDate> {
  const out = new Set<LocalDate>();
  const sorted = [...stamps].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (a.offsetMin === b.offsetMin) continue;
    if (diffDays(a.localDate, b.localDate) < 2) continue;
    const ta = new Date(a.at);
    const tb = new Date(b.at);
    const lived = [a.offsetMin, b.offsetMin].some(
      (o) => diffDays(localDateFor(ta, o, dayBoundaryHour), localDateFor(tb, o, dayBoundaryHour)) <= 1,
    );
    if (lived) {
      for (let d = addDays(a.localDate, 1); d < b.localDate; d = addDays(d, 1)) out.add(d);
    }
  }
  return out;
}

export interface ConsistencyInput extends StreakInput {
  /** Do not count days before this (e.g. first day using the app). */
  since: LocalDate;
}

/**
 * Consistency score 0..100. Mostly check-in coverage over the last 28 days (grace days
 * forgiven, paused days excluded), with a small bonus for the current streak.
 */
export function consistencyScore(input: ConsistencyInput): number {
  const { activeDates, today, graceDaysPerWeek, pausedDates, since } = input;
  const start = maxDate(since, addDays(today, -(CONSISTENCY_WINDOW_DAYS - 1)));
  if (start > today) return 0;
  const byWeek = new Map<LocalDate, { active: number; missed: number }>();
  let counted = 0;
  for (const d of dateRange(start, today)) {
    if (pausedDates?.has(d)) continue;
    const isActive = activeDates.has(d);
    if (d === today && !isActive) continue; // today is still open
    counted++;
    const wk = startOfWeek(d);
    const w = byWeek.get(wk) ?? { active: 0, missed: 0 };
    if (isActive) w.active++;
    else w.missed++;
    byWeek.set(wk, w);
  }
  if (counted === 0) return activeDates.has(today) ? 100 : 0;
  let covered = 0;
  // Grace only covers misses in weeks where you actually showed up.
  for (const w of byWeek.values()) covered += w.active + (w.active > 0 ? Math.min(w.missed, graceDaysPerWeek) : 0);
  const coverage = Math.min(1, covered / counted);
  const streak = dailyStreak(input).current;
  const bonus = Math.min(1, streak / 14);
  return Math.round((coverage * 0.85 + bonus * 0.15) * 100);
}
