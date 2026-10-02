// Notifications: which reminders are due right now, and which smart nudge (if any) is worth sending.
// Pure rules. The notify Edge Function (src/server/notify, bundled into supabase/functions/notify) runs them
// every few minutes against your synced data, in the time zone of the device you used most recently.
//
// - Daily check-in reminder at your time. Skipped if you already checked in today, and during Travel/Crunch.
// - Weekly review reminder at your time on the weekly review day. Skipped once that review is done.
// - Smart nudges: a burner slipping against its intent, or a key person overdue. One a day at most, never
//   during Travel/Crunch, each subject rests a few days before it can nudge again. Low burners barely ever do.
// - Quiet hours: nothing is sent in them. A reminder that falls inside waits until they end (if still fresh).
// Times are wall-clock times wherever you are. "Today" follows the day boundary (a 1 AM moment at 3 AM
// boundary still belongs to yesterday), the same rule as logging.
import {
  INTENT_WEIGHTS,
  NUDGE_COOLDOWN_DAYS,
  NUDGE_PACE,
  NUDGE_QUIET_DAYS,
  NUDGE_WINDOW,
  PERSON_NUDGE_RATIO,
  REMINDER_LATE_LIMIT_MIN,
} from './config';
import { addDays, diffDays, localDateFor, quarterOf, weekday } from './dates';
import { cadenceLabel, personStatus } from './people';
import { activeCrunch, checkInStamps, computeDashboard } from './scoring';
import { dueReviewWeek } from './reviews';
import { redact } from './coach/redact';
import {
  BURNER_LABELS,
  DEFAULT_NOTIFY_PREFS,
  DEFAULT_SETTINGS,
  type BurnerId,
  type CrunchPeriod,
  type EnergyEntry,
  type Goal,
  type Intent,
  type LocalDate,
  type LogEntry,
  type NotifyPrefs,
  type Person,
  type Quarter,
  type ReminderPref,
  type Settings,
  type Touchpoint,
  type WeeklyAction,
  type WeeklyReview,
} from './types';

// ---------- Settings, read defensively (the server reads them from synced JSON) ----------

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 'HH:MM' (24h) to minutes after midnight, or null if malformed. */
export function parseTime(s: unknown): number | null {
  const m = typeof s === 'string' ? TIME_RE.exec(s) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Minutes after midnight to 'HH:MM'. */
export function formatTime(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const time = (v: unknown, d: string) => (parseTime(v) === null ? d : (v as string));

function reminder(v: unknown, d: ReminderPref): ReminderPref {
  const r = (v && typeof v === 'object' ? v : {}) as Partial<ReminderPref>;
  return { on: bool(r.on, d.on), time: time(r.time, d.time) };
}

/** The notification prefs inside any stored settings value, with defaults for anything missing or malformed. */
export function notifyPrefsOf(settings: unknown): NotifyPrefs {
  const n = ((settings as { notify?: unknown } | null)?.notify ?? {}) as Partial<Record<keyof NotifyPrefs, unknown>>;
  const d = DEFAULT_NOTIFY_PREFS;
  const q = (n.quiet && typeof n.quiet === 'object' ? n.quiet : {}) as Partial<NotifyPrefs['quiet']>;
  return {
    daily: reminder(n.daily, d.daily),
    weekly: reminder(n.weekly, d.weekly),
    nudges: bool(n.nudges, d.nudges),
    quiet: { on: bool(q.on, d.quiet.on), start: time(q.start, d.quiet.start), end: time(q.end, d.quiet.end) },
  };
}

/** Full settings from a stored value (synced JSON), with defaults for anything missing or malformed. */
export function settingsOf(value: unknown): Settings {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<Settings>;
  const d = DEFAULT_SETTINGS;
  const int = (x: unknown, lo: number, hi: number, def: number) =>
    typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi ? x : def;
  return {
    ...d,
    dayBoundaryHour: int(v.dayBoundaryHour, 0, 23, d.dayBoundaryHour),
    graceDaysPerWeek: int(v.graceDaysPerWeek, 0, 7, d.graceDaysPerWeek),
    reviewDay: int(v.reviewDay, 0, 6, d.reviewDay),
    sensitiveTerms: Array.isArray(v.sensitiveTerms) ? v.sensitiveTerms.filter((t): t is string => typeof t === 'string') : [],
    notify: notifyPrefsOf(v),
  };
}

// ---------- Local time in a named time zone ----------

/** True if the runtime knows this IANA time zone name. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Minutes east of UTC in a time zone at an instant (e.g. -300 for Chicago in summer). Unknown zones count as UTC. */
export function zoneOffsetMin(now: Date, timeZone: string): number {
  if (!isValidTimeZone(timeZone)) return 0;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(now.getTime() / 1000) * 1000) / 60_000);
}

export interface LocalClock {
  /** The lived date (after the day boundary). */
  localDate: LocalDate;
  /** Wall-clock minutes after midnight, 0..1439. */
  minutes: number;
  offsetMin: number;
}

export function clockIn(now: Date, timeZone: string, dayBoundaryHour: number): LocalClock {
  const offsetMin = zoneOffsetMin(now, timeZone);
  const wall = Math.floor((now.getTime() / 60_000 + offsetMin) % 1440);
  return { localDate: localDateFor(now, offsetMin, dayBoundaryHour), minutes: (wall + 1440) % 1440, offsetMin };
}

/** Minutes since the day boundary: orders times within one lived day (2 AM comes after 11 PM at a 3 AM boundary). */
export function livedMinutes(wallMin: number, dayBoundaryHour: number): number {
  return (((wallMin - dayBoundaryHour * 60) % 1440) + 1440) % 1440;
}

/** Whether a wall-clock time falls in quiet hours. The window may wrap past midnight; start == end means none. */
export function inQuietHours(wallMin: number, quiet: NotifyPrefs['quiet']): boolean {
  if (!quiet.on) return false;
  const s = parseTime(quiet.start);
  const e = parseTime(quiet.end);
  if (s === null || e === null || s === e) return false;
  return s < e ? wallMin >= s && wallMin < e : wallMin >= s || wallMin < e;
}

/** A reminder set for `at` is due from that time until REMINDER_LATE_LIMIT_MIN later, within the same lived day. */
export function reminderDue(clock: LocalClock, at: string, dayBoundaryHour: number): boolean {
  const target = parseTime(at);
  if (target === null) return false;
  const late = livedMinutes(clock.minutes, dayBoundaryHour) - livedMinutes(target, dayBoundaryHour);
  return late >= 0 && late < REMINDER_LATE_LIMIT_MIN;
}

// ---------- What is due ----------

/** What the server remembers per account, so nothing is sent twice. */
export interface NotifyState {
  /** Lived date the daily reminder was last handled (sent or skipped). */
  dailyDate?: LocalDate;
  /** Review week (Monday) whose reminder was last handled. */
  weeklyWeek?: LocalDate;
  /** Lived date nudges were last considered. */
  nudgeDate?: LocalDate;
  /** Nudge subject ('burner:health', 'person:<id>') to the lived date it last nudged. */
  nudged?: Record<string, LocalDate>;
}

export interface DueCheck {
  clock: LocalClock;
  quiet: boolean;
  daily: boolean;
  /** The review week the weekly reminder is for, when due. */
  weekly: LocalDate | null;
  nudge: boolean;
}

/** Which kinds are due at `now`, from the clock and the state alone (no data needed yet). */
export function dueNow(now: Date, timeZone: string, settings: Settings, state: NotifyState): DueCheck {
  const prefs = notifyPrefsOf(settings);
  const b = settings.dayBoundaryHour;
  const clock = clockIn(now, timeZone, b);
  const quiet = inQuietHours(clock.minutes, prefs.quiet);
  const none: DueCheck = { clock, quiet, daily: false, weekly: null, nudge: false };
  if (quiet) return none;

  const daily = prefs.daily.on && state.dailyDate !== clock.localDate && reminderDue(clock, prefs.daily.time, b);

  let weekly: LocalDate | null = null;
  if (prefs.weekly.on && weekday(clock.localDate) === settings.reviewDay && reminderDue(clock, prefs.weekly.time, b)) {
    const week = dueReviewWeek(clock.localDate, settings.reviewDay);
    if (week && state.weeklyWeek !== week) weekly = week;
  }

  const lived = livedMinutes(clock.minutes, b);
  const nudge =
    prefs.nudges &&
    state.nudgeDate !== clock.localDate &&
    lived >= livedMinutes(parseTime(NUDGE_WINDOW.start)!, b) &&
    lived < livedMinutes(parseTime(NUDGE_WINDOW.end)!, b);

  return { clock, quiet, daily, weekly, nudge };
}

// ---------- Messages ----------

export type PushKind = 'daily' | 'weekly' | 'nudge' | 'test';

/** What a notification says. Lock-screen visible, so private notes never appear and sensitive terms are redacted. */
export interface PushMessage {
  kind: PushKind;
  title: string;
  body: string;
  /** Where a tap opens the app (a hash route). */
  url: string;
  /** Same tag replaces an older notification of the same kind. */
  tag: string;
  /** Nudges only: what this nudge was about, for its cooldown. */
  subject?: string;
}

/** Your synced records the messages are built from. */
export interface NotifyData {
  quarter?: Quarter;
  goals: readonly Goal[];
  logs: readonly LogEntry[];
  energy: readonly EnergyEntry[];
  people: readonly Person[];
  touchpoints: readonly Touchpoint[];
  crunch: readonly CrunchPeriod[];
  actions: readonly WeeklyAction[];
  reviews: readonly WeeklyReview[];
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function dashboardFor(data: NotifyData, settings: Settings, today: LocalDate) {
  if (!data.quarter) return null;
  const span = quarterOf(today);
  return computeDashboard({
    quarter: data.quarter,
    quarterStart: span.start,
    goals: data.goals.filter((g) => !g.deleted && g.quarterId === data.quarter!.id),
    logs: data.logs,
    energy: data.energy,
    people: data.people,
    touchpoints: data.touchpoints,
    crunch: data.crunch,
    actions: data.actions,
    settings,
    today,
  });
}

/** The daily check-in reminder, or null when there is nothing to remind (checked in already, Travel/Crunch). */
export function composeDaily(data: NotifyData, settings: Settings, today: LocalDate): PushMessage | null {
  if (activeCrunch(data.crunch, today)) return null;
  if (checkInStamps(data, today).some((s) => s.localDate === today)) return null;
  const streak = dashboardFor(data, settings, today)?.streak.current ?? 0;
  return {
    kind: 'daily',
    title: 'Time to check in',
    body: streak >= 2 ? `Keep your ${streak} day streak going. Two taps is enough.` : 'Two taps keeps your burners lit.',
    url: '/#/',
    tag: 'daily',
  };
}

/** The weekly review reminder, or null once that week's review is done. */
export function composeWeekly(data: Pick<NotifyData, 'reviews'>, week: LocalDate): PushMessage | null {
  if (data.reviews.some((r) => !r.deleted && r.weekStart === week && r.completedAt)) return null;
  return {
    kind: 'weekly',
    title: 'Weekly review',
    body: "Look back on your week and pick next week's actions. About ten minutes.",
    url: '/#/review',
    tag: 'weekly',
  };
}

interface Candidate {
  score: number;
  message: PushMessage;
}

function cooledDown(nudged: NotifyState['nudged'], subject: string, today: LocalDate, days: number): boolean {
  const last = nudged?.[subject];
  return !last || diffDays(last, today) >= days;
}

/**
 * The one smart nudge worth sending today, or null. Burners nudge when behind their intent-adjusted pace
 * and quiet for a while; people when well past their cadence. The highest-priority candidate wins: High
 * burners first, then people (by how overdue), then Steady, then Low.
 */
export function pickNudge(data: NotifyData, settings: Settings, today: LocalDate, nudged: NotifyState['nudged'] = {}): PushMessage | null {
  if (activeCrunch(data.crunch, today)) return null;
  const terms = settings.sensitiveTerms;
  const safe = (s: string, max: number) => clip(redact(s, terms), max);
  const intentOf = (b: BurnerId): Intent => data.quarter?.intents[b] ?? 'steady';
  const candidates: Candidate[] = [];

  const dash = dashboardFor(data, settings, today);
  if (dash) {
    for (const s of Object.values(dash.burners)) {
      const intent = s.intent;
      if (s.pace === null || s.pace >= NUDGE_PACE[intent]) continue;
      const quietDays = s.lastActive ? diffDays(s.lastActive, today) : Infinity;
      if (quietDays < NUDGE_QUIET_DAYS[intent]) continue;
      const subject = `burner:${s.burner}`;
      if (!cooledDown(nudged, subject, today, NUDGE_COOLDOWN_DAYS[intent])) continue;
      const worst = s.goals.filter((g) => !g.progress.complete).sort((a, b) => a.progress.pace - b.progress.pace)[0];
      if (!worst) continue;
      const title = safe(worst.goal.title, 60);
      const why = worst.goal.why?.trim();
      candidates.push({
        score: INTENT_WEIGHTS[intent] + (NUDGE_PACE[intent] - s.pace),
        message: {
          kind: 'nudge',
          title: `${BURNER_LABELS[s.burner]} could use some heat`,
          body: why
            ? `"${title}" is behind. Why it matters: ${safe(why, 100)}`
            : `"${title}" is behind your pace. One small step today keeps it lit.`,
          url: `/#/burner/${s.burner}`,
          tag: 'nudge',
          subject,
        },
      });
    }
  }

  for (const p of data.people) {
    if (p.deleted) continue;
    const intent = intentOf(p.burner);
    const threshold = PERSON_NUDGE_RATIO[intent];
    const cadence = Math.max(1, p.cadenceDays);
    const st = personStatus(p, data.touchpoints, today);
    // Never contacted: counts from when you added them.
    const added = /^\d{4}-\d{2}-\d{2}/.test(p.createdAt) ? p.createdAt.slice(0, 10) : today;
    const days = st.daysSince ?? Math.max(0, diffDays(added, today));
    const ratio = days / cadence;
    if (ratio < threshold) continue;
    const subject = `person:${p.id}`;
    if (!cooledDown(nudged, subject, today, Math.max(7, Math.round(cadence / 2)))) continue;
    const name = safe(p.name, 40);
    const rhythm = cadenceLabel(cadence).toLowerCase();
    candidates.push({
      // Between High burners (3+) and Steady ones (2 to 2.6); people in a Low burner rank with Low burners.
      score: (intent === 'low' ? 1.5 : 2.7) + Math.min(0.25, (ratio - threshold) / 4),
      message: {
        kind: 'nudge',
        title: `Reach out to ${name}?`,
        body:
          st.daysSince === null
            ? `No connection logged yet (your rhythm: ${rhythm}). A quick text counts.`
            : `${days} days since you last connected (your rhythm: ${rhythm}). A quick text counts.`,
        url: `/#/burner/${p.burner}`,
        tag: 'nudge',
        subject,
      },
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.message ?? null;
}

/** Forget nudge history older than any cooldown, so the stored state stays small. */
export function pruneNudged(nudged: NotifyState['nudged'], today: LocalDate): Record<string, LocalDate> {
  const keep = addDays(today, -120);
  return Object.fromEntries(Object.entries(nudged ?? {}).filter(([, d]) => d >= keep));
}

/** The test notification sent from Settings. */
export const TEST_MESSAGE: PushMessage = {
  kind: 'test',
  title: 'Four Burners',
  body: 'Notifications work on this device.',
  url: '/#/settings',
  tag: 'test',
};
