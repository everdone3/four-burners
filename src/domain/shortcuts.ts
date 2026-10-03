// Apple Shortcuts, Siri and Apple Health: the rules behind the shortcuts Edge Function.
// Pure. Finding a goal or person by a spoken name, dating an entry by the phone's own clock, turning a day of
// Health numbers into logs on linked goals, and the short replies Siri reads back. No em dashes in replies.
import { addDays, localDateFor } from './dates';
import { goalProgress } from './goals';
import type { EntrySource, Goal, HealthMetric, Intent, LocalDate, LogEntry, Person, Stamp, TouchpointType } from './types';

// ---------- Names ----------

const FILLER = new Set(['my', 'the', 'a', 'an', 'goal', 'to', 'for']);

/** Lowercase words without accents or punctuation, minus filler ("my", "the", "goal"). */
export function nameWords(s: string): string[] {
  const words = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const kept = words.filter((w) => !FILLER.has(w));
  return kept.length ? kept : words;
}

export type NameMatch<T> = { kind: 'match'; item: T } | { kind: 'ambiguous'; items: T[] } | { kind: 'none' };

/**
 * Find the one item a spoken or typed name means. Tries, in order: the same words; one name starting with the
 * other; every spoken word found in the name (or as the start of a word in it); every word of the name found
 * in what was said. The first test with any hit decides: one hit is a match, several are ambiguous.
 */
export function matchByName<T>(items: readonly T[], query: string, nameOf: (t: T) => string): NameMatch<T> {
  const q = nameWords(query);
  if (!q.length) return { kind: 'none' };
  const qs = q.join(' ');
  const named = items.map((item) => ({ item, w: nameWords(nameOf(item)) })).filter((x) => x.w.length);
  const tests: ((w: string[]) => boolean)[] = [
    (w) => w.join(' ') === qs,
    (w) => {
      const s = w.join(' ');
      return s.startsWith(`${qs} `) || qs.startsWith(`${s} `);
    },
    (w) => q.every((x) => w.some((y) => y === x || (x.length >= 3 && y.startsWith(x)))),
    (w) => w.every((y) => q.includes(y)),
  ];
  for (const test of tests) {
    const hits = named.filter((x) => test(x.w)).map((x) => x.item);
    if (hits.length === 1) return { kind: 'match', item: hits[0] };
    if (hits.length > 1) return { kind: 'ambiguous', items: hits };
  }
  return { kind: 'none' };
}

// ---------- When ----------

const ISO_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})$/;

/** An ISO 8601 time with its UTC offset, as Shortcuts formats "Current Date" (e.g. 2026-10-02T20:15:03-05:00). */
export function parseAt(at: unknown): { instant: Date; offsetMin: number } | null {
  const m = typeof at === 'string' ? ISO_WITH_OFFSET.exec(at.trim()) : null;
  if (!m) return null;
  let offsetMin = 0;
  if (m[7] !== 'Z') {
    const sign = m[7][0] === '-' ? -1 : 1;
    const digits = m[7].slice(1).replace(':', '');
    offsetMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2)));
    if (Math.abs(offsetMin) > 14 * 60) return null;
  }
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)) - offsetMin * 60_000;
  if (!Number.isFinite(ms)) return null;
  return { instant: new Date(ms), offsetMin };
}

/** How far a Shortcut's own time may differ from the server's before it is ignored (an automation can run late). */
const AT_MAX_PAST_MS = 7 * 86_400_000;
const AT_MAX_FUTURE_MS = 86_400_000;

/**
 * When an entry happened and the lived day it belongs to. The phone's time ("at", with its offset) wins, so
 * a log on the road lands on the day you are living there; without it, the server's time in `fallbackOffsetMin`.
 */
export function stampFor(at: unknown, dayBoundaryHour: number, fallbackOffsetMin: number, now: Date): Stamp {
  const p = parseAt(at);
  const ok = p && p.instant.getTime() >= now.getTime() - AT_MAX_PAST_MS && p.instant.getTime() <= now.getTime() + AT_MAX_FUTURE_MS;
  const instant = ok ? p.instant : now;
  const offsetMin = ok ? p.offsetMin : fallbackOffsetMin;
  return { at: instant.toISOString(), offsetMin, localDate: localDateFor(instant, offsetMin, dayBoundaryHour) };
}

// ---------- Amounts and types ----------

/** A positive amount from a number or text ("3", "2.5", "8,432"). */
export function parseAmount(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.trim().replace(/,(?=\d{3}\b)/g, '').replace(',', '.')) : NaN;
  return Number.isFinite(n) && n > 0 && n < 1e7 ? Math.round(n * 100) / 100 : null;
}

/** "call", "Phone call", "text", "iMessage", "in person", "saw them", ... Anything else counts as other. */
export function parseTouchType(v: unknown): TouchpointType {
  const s = typeof v === 'string' ? v.toLowerCase().replace(/[^a-z]+/g, ' ').trim() : '';
  if (/\b(call|called|phone|facetime|rang)\b/.test(s)) return 'call';
  if (/\b(text|texted|message|messaged|imessage|whatsapp|sms|email)\b/.test(s)) return 'text';
  if (/\b(in ?person|inperson|saw|met|visit|visited|dinner|lunch|coffee)\b/.test(s)) return 'in_person';
  return 'other';
}

const TOUCH_LABEL: Record<TouchpointType, string> = { call: 'call', text: 'text', in_person: 'time in person', other: 'connection' };

export function formatAmount(n: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(n);
}

// ---------- Logging by voice ----------

export type LogPlan =
  | { ok: true; value: number; source: EntrySource }
  | { ok: false; message: string };

/** What a voice log of `goal` records. Number goals need an amount; Habit and Yes/No count once. */
export function planLog(goal: Goal, amount: unknown): LogPlan {
  if (goal.type === 'milestone') return { ok: false, message: `"${goal.title}" has steps. Check off the next step in the app.` };
  if (goal.type === 'number') {
    const value = parseAmount(amount);
    if (value === null) return { ok: false, message: `How much for "${goal.title}"? Send an amount${goal.unit ? ` in ${goal.unit}` : ''}.` };
    return { ok: true, value, source: 'shortcut' };
  }
  if (goal.type === 'habit') {
    const n = parseAmount(amount);
    return { ok: true, value: n && Number.isInteger(n) && n <= 20 ? n : 1, source: 'shortcut' };
  }
  return { ok: true, value: 1, source: 'shortcut' };
}

/** What Siri says after a log, with progress including it. */
export function logReply(goal: Goal, value: number, logs: readonly LogEntry[], today: LocalDate, intent: Intent): string {
  const p = goalProgress(goal, logs, today, { intent });
  const title = goal.title;
  if (goal.type === 'yesno') return `Marked "${title}" done. Nice work.`;
  const amount = goal.type === 'number' ? `${formatAmount(value)}${goal.unit ? ` ${goal.unit}` : ''} to ` : '';
  const progress = p.required > 0 ? ` ${formatAmount(p.actual)} of ${formatAmount(p.required)}${p.complete ? '. Goal complete!' : ' so far.'}` : '';
  return `Logged ${amount}"${title}".${progress}`;
}

export function touchReply(person: Person, type: TouchpointType): string {
  return `Logged a ${TOUCH_LABEL[type]} with ${person.name}.`;
}

/** Shown when a name matches nothing or more than one thing. */
export function notFoundReply(kind: 'goal' | 'person', query: string, candidates: readonly string[]): string {
  const what = kind === 'goal' ? 'goal' : 'person';
  if (!candidates.length) return kind === 'goal' ? 'You have no goals this quarter yet.' : 'You have no key people yet.';
  const list = candidates.slice(0, 6).join(', ');
  return `No ${what} matches "${query.trim().slice(0, 60)}". Try one of: ${list}.`;
}

export function ambiguousReply(query: string, names: readonly string[]): string {
  return `"${query.trim().slice(0, 60)}" could be ${names.slice(0, 4).join(' or ')}. Say a little more of the name.`;
}

// ---------- Apple Health ----------

export const HEALTH_METRICS: Record<HealthMetric, { label: string; unit: string; defaultMin: number; max: number }> = {
  steps: { label: 'Steps', unit: 'steps', defaultMin: 8000, max: 200_000 },
  workouts: { label: 'Workouts', unit: 'workouts', defaultMin: 1, max: 20 },
  activeMinutes: { label: 'Exercise minutes', unit: 'minutes', defaultMin: 30, max: 1440 },
  sleepHours: { label: 'Sleep', unit: 'hours', defaultMin: 7, max: 24 },
};

export const HEALTH_METRIC_IDS = Object.keys(HEALTH_METRICS) as HealthMetric[];

export type HealthDay = Partial<Record<HealthMetric, number>>;

/** One day of Health numbers from a Shortcut. Sleep may come as sleepHours, sleepMinutes or sleepSeconds. Out-of-range values are dropped. */
export function readHealthDay(body: Record<string, unknown>): HealthDay {
  const out: HealthDay = {};
  const raw: Record<HealthMetric, unknown> = {
    steps: body.steps,
    workouts: body.workouts,
    activeMinutes: body.activeMinutes ?? body.exerciseMinutes,
    sleepHours:
      body.sleepHours ??
      (parseAmount(body.sleepMinutes) !== null
        ? parseAmount(body.sleepMinutes)! / 60
        : parseAmount(body.sleepSeconds) !== null
          ? parseAmount(body.sleepSeconds)! / 3600
          : undefined),
  };
  for (const m of HEALTH_METRIC_IDS) {
    const zero = raw[m] === 0 || raw[m] === '0';
    const n = zero ? 0 : parseAmount(raw[m]);
    if (n === null || n > HEALTH_METRICS[m].max) continue;
    out[m] = m === 'sleepHours' ? Math.round(n * 10) / 10 : Math.round(n);
  }
  return out;
}

/** The deterministic id of a goal's Health log for a day, so a resend replaces it instead of adding a second. */
export const healthLogId = (goalId: string, date: LocalDate) => `health-${goalId}-${date}`;

export interface HealthLogPlan {
  goal: Goal;
  id: string;
  value: number;
  /** The Health number it came from. */
  amount: number;
}

/** Goals that can take Health data: Number, Habit and Yes/No goals in the Health burner. */
export function canLinkHealth(goal: Pick<Goal, 'burner' | 'type'>): boolean {
  return goal.burner === 'health' && goal.type !== 'milestone';
}

/**
 * The logs one day of Health numbers makes. Number goals add the day's amount; Habit and Yes/No goals count
 * the day when the metric reaches the link's minimum, unless `loggedByHand` has the goal (that day already
 * counts). Days outside a goal's window, and zero, make nothing.
 */
export function planHealthLogs(goals: readonly Goal[], day: HealthDay, date: LocalDate, loggedByHand: ReadonlySet<string> = new Set()): HealthLogPlan[] {
  const out: HealthLogPlan[] = [];
  for (const goal of goals) {
    const link = goal.health;
    if (goal.deleted || !link || !canLinkHealth(goal) || !(link.metric in HEALTH_METRICS)) continue;
    if (date < goal.startDate || date > goal.deadline) continue;
    const amount = day[link.metric];
    if (amount === undefined || amount <= 0) continue;
    // A Habit or Yes/No day you already logged by hand is counted once, not twice.
    if (goal.type !== 'number' && loggedByHand.has(goal.id)) continue;
    const value = goal.type === 'number' ? amount : amount >= (link.min ?? HEALTH_METRICS[link.metric].defaultMin) ? 1 : 0;
    if (value > 0) out.push({ goal, id: healthLogId(goal.id, date), value, amount });
  }
  return out;
}

/**
 * The day a Shortcut's Health numbers are for ('YYYY-MM-DD', the phone's calendar date), within a week of
 * today; otherwise today. Up to one day ahead is accepted: just after midnight, before the day boundary, the
 * lived day is still yesterday but the phone's numbers are already for the new calendar day.
 */
export function healthDate(v: unknown, today: LocalDate): LocalDate {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return today;
  const d = v.trim();
  return d <= addDays(today, 1) && d >= addDays(today, -7) ? d : today;
}

export function healthReply(applied: readonly HealthLogPlan[], day: HealthDay, date: LocalDate): string {
  const got = HEALTH_METRIC_IDS.filter((m) => day[m] !== undefined);
  if (!got.length) return 'No Health numbers came through. Check the Shortcut sends steps, workouts, activeMinutes or sleepHours.';
  if (!applied.length) return `Got Health data for ${date}. No linked goal needed it today.`;
  const parts = applied.map((a) =>
    a.goal.type === 'number' ? `${formatAmount(a.value)} ${HEALTH_METRICS[a.goal.health!.metric].unit} to "${a.goal.title}"` : `"${a.goal.title}" counted`,
  );
  return `Health for ${date}: ${parts.join('; ')}.`;
}
