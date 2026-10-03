// Calendar-aware crunch mode (optional): read a calendar feed (ICS), find travel and all-day away events, and
// suggest turning on Travel/Crunch mode. Always a suggestion: nothing here ever turns it on.
// Pure. The calendar Edge Function fetches the feed (browsers can't, because of CORS) and runs parseIcs;
// the app runs awayPeriods and crunchSuggestion on the result.
import { activeCrunch } from './scoring';
import { addDays, localDateFor } from './dates';
import type { CrunchPeriod, LocalDate } from './types';

// ---------- Feed address ----------

/**
 * A calendar feed address as an https URL, or null. webcal:// (what Apple and Outlook hand out) is the same
 * feed over https. Plain http is refused: the address is a secret, and so is what it returns.
 */
export function normalizeFeedUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim().replace(/^webcals?:\/\//i, 'https://');
  if (raw.length > 2000) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return null;
  return u.toString();
}

/**
 * Whether the server may fetch this host: a public name only. No IP literals, no localhost, no internal
 * names, so a pasted address can never make the server reach its own network.
 */
export function isPublicFeedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (!h.includes('.')) return false;
  if (/^[\d.]+$/.test(h) || h.includes(':') || h.startsWith('[')) return false;
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|supabase\.internal)$/.test(h)) return false;
  return /^[a-z0-9.-]+$/.test(h);
}

/** True for addresses the server must never fetch: private, loopback, link-local, carrier NAT, multicast, ULA. */
export function isPrivateAddress(ip: string): boolean {
  const a = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a.replace(/^::ffff:/, ''));
  if (v4) {
    const [x, y] = [Number(v4[1]), Number(v4[2])];
    return (
      x === 0 || x === 10 || x === 127 || x >= 224 ||
      (x === 100 && y >= 64 && y <= 127) ||
      (x === 169 && y === 254) ||
      (x === 172 && y >= 16 && y <= 31) ||
      (x === 192 && y === 168) ||
      (x === 198 && (y === 18 || y === 19))
    );
  }
  if (!a.includes(':')) return true; // not an address we understand: refuse
  return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a) || a.startsWith('64:ff9b:');
}

// ---------- ICS ----------

export interface CalEvent {
  summary: string;
  location?: string;
  /** First day, in the time zone the event was written in (UTC times use the device offset). */
  start: LocalDate;
  /** Last day, inclusive. */
  end: LocalDate;
  allDay: boolean;
  /** "Show as free" (TRANSP:TRANSPARENT): birthdays and reminders, never travel on their own. */
  free: boolean;
  /** Timed events: how long, in hours. */
  hours?: number;
}

export interface ParsedCalendar {
  name?: string;
  events: CalEvent[];
  /** Recurring events skipped (travel is not recurring; birthdays and holidays are). */
  skippedRecurring: number;
}

function unescapeText(s: string): string {
  return s.replace(/\\([nN,;\\])/g, (_, c: string) => (c === 'n' || c === 'N' ? ' ' : c)).replace(/\s+/g, ' ').trim();
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** One content line: NAME;PARAM=V;PARAM="quoted:v":VALUE. The value starts at the first colon outside quotes. */
function parseLine(line: string): Prop | null {
  let inQuote = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ':' && !inQuote) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const [name, ...params] = line.slice(0, colon).split(';');
  const p: Record<string, string> = {};
  for (const kv of params) {
    const eq = kv.indexOf('=');
    if (eq > 0) p[kv.slice(0, eq).toUpperCase()] = kv.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params: p, value: line.slice(colon + 1) };
}

interface When {
  date: LocalDate;
  allDay: boolean;
  /** Timed values: midnight exactly (an event ending at 00:00 ends the day before). */
  midnight: boolean;
  /** Timed values: milliseconds on the event's own wall clock (UTC for Z times), for durations. */
  ms: number;
}

/**
 * A DTSTART/DTEND value as a lived date. UTC times are shifted by the device offset and the day boundary
 * (a 1 AM flight belongs to the day you were living); zoned and floating times keep their own date.
 */
function parseWhen(p: Prop, offsetMin: number, dayBoundaryHour: number): When | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(p.value.trim());
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  if (!Number.isFinite(ms)) return null;
  if (!m[4] || p.params.VALUE === 'DATE') return { date, allDay: true, midnight: false, ms };
  const midnight = m[4] === '00' && m[5] === '00' && (m[6] ?? '00') === '00';
  if (m[7] === 'Z') {
    const at = new Date(ms);
    const localMin = (((at.getUTCHours() * 60 + at.getUTCMinutes() + offsetMin) % 1440) + 1440) % 1440;
    return { date: localDateFor(at, offsetMin, dayBoundaryHour), allDay: false, midnight: localMin === 0, ms };
  }
  return { date, allDay: false, midnight, ms };
}

/** Days in an ISO 8601 duration (P2D, P1W, PT36H rounds down), for events with DURATION instead of DTEND. */
function durationDays(v: string): number {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?)?/.exec(v.trim());
  if (!m) return 0;
  return (Number(m[1] ?? 0) * 7) + Number(m[2] ?? 0) + Math.floor(Number(m[3] ?? 0) / 24);
}

const MAX_EVENTS = 20_000;

/**
 * The events of an ICS feed that overlap [from, to]. Cancelled events and recurring series are skipped.
 * `offsetMin` and `dayBoundaryHour`: the device's UTC offset and day boundary, for events stored in UTC.
 */
export function parseIcs(text: string, window: { from: LocalDate; to: LocalDate }, offsetMin = 0, dayBoundaryHour = 0): ParsedCalendar {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const out: ParsedCalendar = { events: [], skippedRecurring: 0 };
  let ev: Record<string, Prop> | null = null;
  let depth = 0; // nested components inside a VEVENT (VALARM)
  let seen = 0;
  for (const line of lines) {
    if (!line) continue;
    const up = line.toUpperCase();
    if (up === 'BEGIN:VEVENT') {
      ev = {};
      depth = 0;
      continue;
    }
    if (ev && up.startsWith('BEGIN:')) {
      depth++;
      continue;
    }
    if (ev && up.startsWith('END:') && up !== 'END:VEVENT') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (up === 'END:VEVENT') {
      if (ev && ++seen <= MAX_EVENTS) {
        const e = toEvent(ev, offsetMin, dayBoundaryHour);
        if (e === 'recurring') out.skippedRecurring++;
        else if (e && e.end >= window.from && e.start <= window.to) out.events.push(e);
      }
      ev = null;
      continue;
    }
    const p = parseLine(line);
    if (!p) continue;
    if (ev) {
      if (depth === 0 && !(p.name in ev)) ev[p.name] = p;
    } else if (p.name === 'X-WR-CALNAME' && !out.name) out.name = unescapeText(p.value).slice(0, 80);
  }
  out.events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return out;
}

function toEvent(ev: Record<string, Prop>, offsetMin: number, dayBoundaryHour: number): CalEvent | 'recurring' | null {
  if (ev.STATUS?.value.trim().toUpperCase() === 'CANCELLED') return null;
  if (ev.RRULE || ev.RDATE) return 'recurring';
  const start = ev.DTSTART && parseWhen(ev.DTSTART, offsetMin, dayBoundaryHour);
  if (!start) return null;
  let end = start.date;
  let hours: number | undefined;
  const dtend = ev.DTEND && parseWhen(ev.DTEND, offsetMin, dayBoundaryHour);
  if (dtend) {
    // All-day ends are exclusive; a timed event ending exactly at midnight ends the day before.
    end = dtend.allDay || dtend.midnight ? addDays(dtend.date, -1) : dtend.date;
    if (!start.allDay) hours = Math.max(0, (dtend.ms - start.ms) / 3_600_000);
  } else if (ev.DURATION) {
    const days = durationDays(ev.DURATION.value);
    end = start.allDay ? addDays(start.date, Math.max(1, days) - 1) : addDays(start.date, days);
    if (!start.allDay) hours = durationHours(ev.DURATION.value);
  }
  if (end < start.date) end = start.date;
  // Outlook and Exchange write all-day events as midnight-to-midnight times, flagged like this.
  const outlookAllDay = ev['X-MICROSOFT-CDO-ALLDAYEVENT']?.value.trim().toUpperCase() === 'TRUE';
  const allDay = start.allDay || outlookAllDay || (start.midnight && !!dtend?.midnight && (hours ?? 0) >= 24);
  return {
    summary: unescapeText(ev.SUMMARY?.value ?? '').slice(0, 120),
    ...(ev.LOCATION?.value ? { location: unescapeText(ev.LOCATION.value).slice(0, 120) } : {}),
    start: start.date,
    end,
    allDay,
    free: ev.TRANSP?.value.trim().toUpperCase() === 'TRANSPARENT',
    ...(!allDay && hours !== undefined ? { hours: Math.round(hours * 10) / 10 } : {}),
  };
}

/** Hours in an ISO 8601 duration (PT2H30M is 2.5), for timed events. */
function durationHours(v: string): number {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/.exec(v.trim());
  if (!m) return 0;
  return Number(m[1] ?? 0) * 168 + Number(m[2] ?? 0) * 24 + Number(m[3] ?? 0) + Number(m[4] ?? 0) / 60;
}

// ---------- Away periods ----------

/** Words that mark travel or time away. Matched on whole words, case-insensitive. */
const AWAY_WORDS =
  /\b(trip|travel(?:l?ing)?|vacation|vacay|pto|ooo|out of (?:the )?office|on leave|away from|offsite|off-site|conference|summit|retreat|hotel|airbnb|stay at|road ?trip|sabbatical)\b/i;
/** A flight: the word, or an airport pair with an arrow ("ORD → DEN", "SFO->JFK", "✈"). Counts at any length. */
const FLIGHT_WORD = /\bflights?\b|✈/i;
/** Airport codes are capitals, so this one is case-sensitive. */
const AIRPORT_PAIR = /\b[A-Z]{3}\s*(?:→|->|⇒|✈)\s*[A-Z]{3}\b/;
/** Never travel, whatever else they say: ordinary work items, reminders, birthdays. */
const NOT_AWAY =
  /\b(birthday|bday|anniversary|reminder|due|deadline|payday|garbage|trash|recycling|call|meeting|mtg|sync|review|planning|plan|report|expenses?|prep|book|booking|debrief|recap|webinar|zoom|teams)\b/i;
/** A timed event this long with a travel word is time away (a conference day); shorter is a meeting about it. */
export const AWAY_MIN_HOURS = 4;

/** Why an event looks like time away, or null. */
export function awayReason(e: CalEvent): 'keyword' | 'flight' | 'multi_day' | null {
  if (NOT_AWAY.test(e.summary)) return null;
  if (FLIGHT_WORD.test(e.summary) || AIRPORT_PAIR.test(e.summary)) return 'flight';
  const long = e.allDay || e.end > e.start || (e.hours ?? 0) >= AWAY_MIN_HOURS;
  if (AWAY_WORDS.test(e.summary) && long) return 'keyword';
  // Several days blocked out as busy, all day: a trip or a conference far more often than not.
  if (e.allDay && !e.free && e.end > e.start) return 'multi_day';
  return null;
}

export interface AwayPeriod {
  start: LocalDate;
  end: LocalDate;
  /** Short name for the suggestion, from the event that best explains it. */
  label: string;
  /** Stable id for "not this time". */
  key: string;
}

/** Away events merged into periods: overlapping or back-to-back days (one day apart at most) join up. */
export function awayPeriods(events: readonly CalEvent[]): AwayPeriod[] {
  const away = events
    .map((e) => ({ e, why: awayReason(e) }))
    .filter((x) => x.why)
    .sort((a, b) => (a.e.start < b.e.start ? -1 : a.e.start > b.e.start ? 1 : 0));
  const out: (AwayPeriod & { best: number })[] = [];
  for (const { e, why } of away) {
    // A travel-word event explains a trip best, then a flight, then a long busy block.
    const score = why === 'keyword' ? 3 : why === 'flight' ? 2 : 1;
    const label = (e.summary || 'Away').replace(/\s+/g, ' ').slice(0, 40);
    const last = out[out.length - 1];
    if (last && e.start <= addDays(last.end, 1)) {
      if (e.end > last.end) last.end = e.end;
      if (score > last.best) {
        last.best = score;
        last.label = label;
      }
    } else {
      out.push({ start: e.start, end: e.end, label, key: '', best: score });
    }
  }
  return out.map(({ best: _best, ...p }) => ({ ...p, key: `${p.start}_${p.end}` }));
}

/** How far back a trip already under way may start a Travel/Crunch period (it pauses those days too). */
export const AWAY_BACKDATE_DAYS = 7;

export interface CrunchSuggestion {
  period: AwayPeriod;
  /** Start the Travel/Crunch period here (the trip's first day, up to a week back). */
  start: LocalDate;
  end: LocalDate;
}

const overlaps = (a: { start: LocalDate; end: LocalDate }, b: { start: LocalDate; end: LocalDate }) => a.start <= b.end && b.start <= a.end;

/** A dismissal key ('start_end') as a range. */
function keyRange(key: string): { start: LocalDate; end: LocalDate } | null {
  const m = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/.exec(key);
  return m ? { start: m[1], end: m[2] } : null;
}

/**
 * The trip to suggest Travel/Crunch for today, or null: a period covering today, while Travel/Crunch is off.
 * Never a trip you said "not this time" to (any period overlapping one you dismissed, so a trip whose dates
 * shift a little stays dismissed), nor one you already used Travel/Crunch for (turning it off mid-trip is a
 * decision too). Only a suggestion; never acts.
 */
export function crunchSuggestion(
  periods: readonly AwayPeriod[],
  today: LocalDate,
  crunch: readonly CrunchPeriod[],
  dismissed: readonly string[],
): CrunchSuggestion | null {
  if (activeCrunch(crunch, today)) return null;
  const dismissedRanges = dismissed.map(keyRange).filter((r): r is { start: LocalDate; end: LocalDate } => !!r);
  const decided = (x: AwayPeriod) =>
    dismissedRanges.some((r) => overlaps(r, x)) ||
    crunch.some((c) => (c.deleted ? c.start >= x.start && c.start <= x.end : overlaps({ start: c.start, end: c.end ?? '9999-12-31' }, x)));
  const p = periods.find((x) => x.start <= today && x.end >= today && !decided(x));
  if (!p) return null;
  const floor = addDays(today, -AWAY_BACKDATE_DAYS);
  return { period: p, start: p.start < floor ? floor : p.start, end: p.end };
}
