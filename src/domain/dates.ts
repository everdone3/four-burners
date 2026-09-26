// Date math on lived local dates ('YYYY-MM-DD').
// All arithmetic is done on UTC midnight so it is immune to DST and device time zone.
import type { LocalDate, QuarterId, Stamp } from './types';

const DAY_MS = 86_400_000;

function toUtcMs(d: LocalDate): number {
  const [y, m, day] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, day);
}

function fromUtcMs(ms: number): LocalDate {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(d: LocalDate, n: number): LocalDate {
  return fromUtcMs(toUtcMs(d) + n * DAY_MS);
}

/** b - a in whole days. */
export function diffDays(a: LocalDate, b: LocalDate): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / DAY_MS);
}

export function compareDates(a: LocalDate, b: LocalDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minDate(a: LocalDate, b: LocalDate): LocalDate {
  return a < b ? a : b;
}

export function maxDate(a: LocalDate, b: LocalDate): LocalDate {
  return a > b ? a : b;
}

/** 0 = Monday ... 6 = Sunday */
export function weekday(d: LocalDate): number {
  return (new Date(toUtcMs(d)).getUTCDay() + 6) % 7;
}

/** Monday of the week containing d. Weeks run Monday to Sunday. */
export function startOfWeek(d: LocalDate): LocalDate {
  return addDays(d, -weekday(d));
}

export function startOfMonth(d: LocalDate): LocalDate {
  return d.slice(0, 8) + '01';
}

/** Inclusive list of dates from a to b. */
export function dateRange(a: LocalDate, b: LocalDate): LocalDate[] {
  const out: LocalDate[] = [];
  for (let d = a; d <= b; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * The lived local date for an instant, given the UTC offset in effect and the day boundary.
 * With a 3 AM boundary, 1:30 AM on the 5th belongs to the 4th.
 */
export function localDateFor(instant: Date, offsetMin: number, dayBoundaryHour: number): LocalDate {
  const shifted = instant.getTime() + offsetMin * 60_000 - dayBoundaryHour * 3_600_000;
  return fromUtcMs(Math.floor(shifted / DAY_MS) * DAY_MS);
}

/** Device's current offset in minutes east of UTC. */
export function deviceOffsetMin(now: Date = new Date()): number {
  return -now.getTimezoneOffset();
}

/** Build a Stamp for "now" on this device. */
export function stampNow(dayBoundaryHour: number, now: Date = new Date()): Stamp {
  const offsetMin = deviceOffsetMin(now);
  return { at: now.toISOString(), offsetMin, localDate: localDateFor(now, offsetMin, dayBoundaryHour) };
}

/** Today's lived date on this device. */
export function today(dayBoundaryHour: number, now: Date = new Date()): LocalDate {
  return localDateFor(now, deviceOffsetMin(now), dayBoundaryHour);
}

// ---------- Quarters ----------

export interface QuarterSpan {
  id: QuarterId;
  start: LocalDate;
  end: LocalDate;
}

export function quarterOf(d: LocalDate): QuarterSpan {
  const y = Number(d.slice(0, 4));
  const q = Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1;
  return quarterSpan(`${y}-Q${q}`);
}

export function quarterSpan(id: QuarterId): QuarterSpan {
  const [ys, qs] = id.split('-Q');
  const y = Number(ys);
  const q = Number(qs);
  const startMonth = (q - 1) * 3 + 1;
  const start = `${y}-${String(startMonth).padStart(2, '0')}-01`;
  const nextStart =
    q === 4 ? `${y + 1}-01-01` : `${y}-${String(startMonth + 3).padStart(2, '0')}-01`;
  return { id, start, end: addDays(nextStart, -1) };
}

export function nextQuarterId(id: QuarterId): QuarterId {
  return quarterOf(addDays(quarterSpan(id).end, 1)).id;
}

export function prevQuarterId(id: QuarterId): QuarterId {
  return quarterOf(addDays(quarterSpan(id).start, -1)).id;
}

/** Days left in the quarter including today. */
export function daysLeftInQuarter(d: LocalDate): number {
  return diffDays(d, quarterOf(d).end) + 1;
}

export function quarterLabel(id: QuarterId): string {
  const [y, q] = id.split('-');
  return `${q} ${y}`;
}
