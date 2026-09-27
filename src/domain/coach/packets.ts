// Coaching packets: plain text the user pastes into their Claude app.
// CONTRACT (types and signatures below) is shared with the UI. Implementation follows the design in
// docs/coach-design.md. Pure functions only: no Dexie, no DOM, no Date.now() (pass `today`).
//
// Pipeline for every packet (docs/coach-design.md, "Privacy pipeline"):
// 1. Select: logs and touchpoints are scrubbed first (private notes and edit history removed), so
//    nothing downstream can ever see a private note. All numbers come from structured fields.
// 2. Render: every user-written value goes through field prep (sanitize, redact, cap) as it is printed.
// 3. Finalize: dash sanitize and redact over the whole string, preamble included.
// 4. Gate: no sensitive term, no em or en dash, and no private note text in the final string.
// Budgets are soft. Over budget, a trimming ladder re-renders with detail flags; the finished string
// is never cut.
import { NEW_GOAL_GRACE_DAYS, RECENT_ACTIVE_DAYS } from '../config';
import { addDays, dateRange, diffDays, prevQuarterId, quarterSpan, startOfMonth, startOfWeek, weekday } from '../dates';
import { actualFor, checkGoal, goalProgress, requiredFor, windowDays, type GoalProgress, type GoalStatus } from '../goals';
import { intentOn } from '../intents';
import { energyOn, energyTrend } from '../logs';
import { cadenceLabel, peopleByUrgency, type ConnectionState } from '../people';
import { quarterHighlights, type HighlightsInput } from '../quarterClose';
import { weekSummary } from '../reviews';
import { checkInStamps, computeDashboard, crunchDateSet, type BurnerStatus, type DashboardInput } from '../scoring';
import {
  BURNERS,
  BURNER_LABELS,
  EMPTY_PROFILE_FIELDS,
  INTENT_LABELS,
  type BurnerId,
  type CrunchPeriod,
  type EnergyEntry,
  type Goal,
  type Intent,
  type LocalDate,
  type LogEntry,
  type PacketKind,
  type Person,
  type Profile,
  type ProfileFields,
  type Quarter,
  type QuarterId,
  type Settings,
  type Touchpoint,
  type TouchpointType,
  type TravelRhythm,
  type WeeklyAction,
  type WeeklyReview,
} from '../types';
import { PACKET_BUDGETS, PACKET_END, PACKET_HEADER } from './constants';
import { profileIsEmpty, renderAboutMeBlock, travelLabel } from './profile';
import { REDACTED, findSensitive, redact } from './redact';

export interface PacketStats {
  /** How many sensitive-term occurrences were replaced with [redacted]. */
  redactions: number;
  /** How many private notes exist in the packet's time window and were left out. */
  privateOmitted: number;
  /** Trimming-ladder steps applied to fit the budget, in order (also printed on the TRIMMED line). */
  trimmed: string[];
}

export interface BuiltPacket {
  kind: PacketKind;
  scope: string;
  /** The exact final string: what the preview shows and what Copy copies. */
  text: string;
  chars: number;
  /** Soft budget for this kind (PACKET_BUDGETS). chars > budget shows amber. */
  budget: number;
  stats: PacketStats;
  /** Copy gate: false if a sensitive term, an em/en dash, or a private note survived. Copy is disabled. */
  safe: boolean;
  /** Human-readable reasons when safe is false. */
  problems: string[];
}

/** Weekly review packet. `input` is for the quarter containing the reviewed week, as of `input.today`. */
export interface WeeklyPacketInput {
  input: DashboardInput;
  reviews: readonly WeeklyReview[];
  /** The review being written (wins, misses, focus come from here). */
  review: WeeklyReview;
  /** Monday of the reviewed week. */
  weekStart: LocalDate;
  profile?: Profile;
}

/** On-demand mid-quarter check-in, as of input.today. */
export interface CheckinPacketInput {
  input: DashboardInput;
  reviews: readonly WeeklyReview[];
  profile?: Profile;
  /** Optional one-line question the user types before copying. */
  question?: string;
}

/** Quarter setup stress test, built from the unsaved draft (after close, or first quarter). */
export interface QuarterSetupPacketInput {
  draftQuarter: Quarter;
  draftGoals: readonly Goal[];
  /** The quarter just closed, for LAST Q lines. Null for a first quarter. */
  previous: HighlightsInput | null;
  /** All quarters (for crunch history), all crunch periods, all logs (for LOAD rates), reviews (repeat misses). */
  quarters: readonly Quarter[];
  crunch: readonly CrunchPeriod[];
  logs: readonly LogEntry[];
  goalsAll: readonly Goal[];
  reviews: readonly WeeklyReview[];
  settings: Settings;
  profile?: Profile;
  today: LocalDate;
}

/** Onboarding refinement: asks Claude to tighten the About me profile. */
export interface OnboardingPacketInput {
  profile: ProfileFields;
  /** Key people already confirmed (optional; interview text is used otherwise). */
  people?: readonly Person[];
  settings: Settings;
  today: LocalDate;
}

/** Result of the Copy gate on a finished packet string. */
export interface PacketGate {
  safe: boolean;
  problems: string[];
}

// =============================================================================================
// Fixed text

const PREAMBLE = [
  PACKET_HEADER,
  'Be my executive coach: candid, direct, warm, clearly in my corner. Ground every point in my numbers and words; do not recap. Under 180 words plus actions. Plain text: no markdown, filler, generic motivation, em or en dashes. At most one question.',
  'Judge each burner by its intent: light activity on a Low burner is on track.',
  'Crunch days (travel, deals) have lower expectations built in: do not pile on; suggest the smallest move that keeps a burner lit.',
  'If a goal is behind or slipping, remind me of its why, in my words.',
  `Work: habits and priorities only. Never ask about clients, deals, or firms, or guess what ${REDACTED} hides.`,
  'pace = % of where my intent expects me by now. active x/y = active days vs expected.',
  `If ${PACKET_END} is missing, say the paste was cut off.`,
  'End with 2 or 3 actions, each with a day or trigger, nothing after:',
  'Suggested actions:',
  '- Burner: action',
].join('\n');

const ASK_WEEKLY = 'ASK: Coach my week against my intents: what held up, the one pattern that matters most, and what to let go.';
const ASK_WEEKLY_CRUNCH = ' Plan next week around the crunch ahead.';
const ASK_WEEKLY_END = ' Then Suggested actions.';

function askCheckin(daysLeft: number, hasQuestion: boolean): string {
  return (
    `ASK: Where do I stand with ${daysLeft}d left, judged by intent? Which goals are still realistic, which to shrink or drop, ` +
    'and whether an intent should change (max 2 High). Name the one burner that needs a move now.' +
    (hasQuestion ? ' Answer my question.' : '') +
    ' Then Suggested actions for the next 7 days.'
  );
}

const ASK_SETUP =
  'ASK: Stress-test this plan before I commit, up to 250 words, most important first. Flag vague or unmeasurable goals, ' +
  'missing or weak whys and whens, and over-commitment given my crunch history, LOAD, and last Q. Rules: max 2 High, ' +
  '3 to 4 goals per burner. Say what to cut or shrink. Then Suggested actions as specific edits.';

const TRAVEL_CHOICES = (['rare', 'monthly', 'weekly', 'mostly_away'] as TravelRhythm[]).map((t) => travelLabel(t)).join(', ');

const ASK_ONBOARDING =
  'ASK: Up to 300 words plus the profile. First, up to 3 gaps or tensions you see (a burner with no clear win, a rhythm ' +
  'that collides with home). Then my revised profile as a block: a line ABOUT ME, the same 11 labeled lines in the same ' +
  `order, and a line END ABOUT ME. First person, only facts I gave, no work specifics, one short line each; keep ${REDACTED} ` +
  `as is; Travel is one of: ${TRAVEL_CHOICES}. Then Suggested actions for setting up my first quarter.`;

const SKIPPED_LINE = 'Empty lines are questions I skipped. You may ask about one of them.';

// =============================================================================================
// Field prep: sanitize, redact, cap

const CAP = {
  aboutMe: 450,
  aboutMeShort: 250,
  title: 60,
  why: 90,
  when: 90,
  note: 90,
  win: 100,
  miss: 100,
  focus: 100,
  action: 80,
  crunchLabel: 30,
  reason: 60,
  question: 200,
  name: 40,
  theme: 60,
  step: 60,
  unit: 30,
} as const;

const MAX_WINS = 6;
const MAX_ONBOARDING_PEOPLE = 24;
const MIN_PRIVATE_CHARS = 12;

/** Characters from code points, so this source file stays plain ASCII. */
const cc = (...codes: number[]): string => String.fromCharCode(...codes);
const DASH_CHARS = cc(0x2012, 0x2013, 0x2014, 0x2015, 0x2e3a, 0x2e3b);
const FIELD_DASH_DIGITS = new RegExp(`(\\d)\\s*[${DASH_CHARS}]+\\s*(?=\\d)`, 'g');
const FIELD_DASH_ANY = new RegExp(`\\s*[${DASH_CHARS}]+\\s*`, 'g');
const LINE_DASH_DIGITS = new RegExp(`(\\d)[ \\t]*[${DASH_CHARS}]+[ \\t]*(?=\\d)`, 'g');
const LINE_DASH_ANY = new RegExp(`[ \\t]*[${DASH_CHARS}]+[ \\t]*`, 'g');
const BANNED_DASH = new RegExp(`[${cc(0x2013, 0x2014)}]`);
/**
 * Characters that render as nothing (or nearly nothing) but split a word for a matcher: every format
 * character (zero-width spaces and joiners, bidi overrides and isolates, soft hyphen, tag characters) plus
 * the combining grapheme joiner, variation selectors, and Hangul fillers. "Summit<U+2063>Wealth" reads as
 * the term on screen, so these are dropped before redaction, and a bidi override can never reorder the
 * preview.
 */
const INVISIBLE = new RegExp(
  `[\\p{Cf}${cc(0x034f, 0x115f, 0x1160, 0x17b4, 0x17b5)}${cc(0x180b)}-${cc(0x180f)}${cc(0x3164)}${cc(0xfe00)}-${cc(0xfe0f)}${cc(0xffa0)}` +
    `${String.fromCodePoint(0xe0100)}-${String.fromCodePoint(0xe01ef)}]`,
  'gu',
);
/** Unicode hyphens and minus signs print as "-", which redact() treats as a joiner inside a term. */
const UNICODE_HYPHENS = new RegExp(`[${cc(0x2010, 0x2011, 0x2043, 0x2212, 0x02d7, 0xfe63, 0xff0d)}]`, 'g');
const CONTROL_CHARS = new RegExp(`[${cc(0x00)}-${cc(0x1f)}${cc(0x7f)}-${cc(0x9f)}${cc(0x2028, 0x2029)}]`, 'g');
const SINGLE_QUOTES = new RegExp(`[${cc(0x2018, 0x2019, 0x201a, 0x201b, 0x2032, 0x2035)}]`, 'g');
const DOUBLE_QUOTES = new RegExp(`[${cc(0x201c, 0x201d, 0x201e, 0x201f, 0x2033, 0x2036, 0x00ab, 0x00bb)}]`, 'g');
const ELLIPSIS = new RegExp(cc(0x2026), 'g');
/** A dash between two letters or digits, optionally spaced: "Summit<em>Wealth", "Summit <en> Wealth", "Fund<em>3". */
const LETTER_DASH = new RegExp(`(?<=[\\p{L}\\p{N}]) ?[${DASH_CHARS}]+ ?(?=[\\p{L}\\p{N}])`, 'gu');
/** Joiner punctuation inside a word: "Lake-front", "lake_front", "Lake.front", "Lake<em>front", "Fund-3". */
const LETTER_JOINER = new RegExp(`(?<=[\\p{L}\\p{N}])[-_.${cc(0x00b7)}${DASH_CHARS}]+(?=[\\p{L}\\p{N}])`, 'gu');
/** Where letters meet digits: "JPM2026" reads "JPM 2026", so a whole-word term still matches. */
const LETTER_DIGIT = /(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/gu;
const COMBINING = /\p{Mn}/gu;

/** Accents dropped: "Societe Generale" and "Soci(e acute)t(e acute)" read alike. */
function foldAccents(s: string): string {
  return s.normalize('NFKD').replace(COMBINING, '').normalize('NFKC');
}

/** Every reading at once, for a term hidden by more than one trick. */
function allReadings(s: string): string {
  return foldAccents(s.replace(LETTER_DASH, '-').replace(LETTER_JOINER, '').replace(LETTER_DIGIT, ' '));
}

/**
 * Normalize without touching dashes: NFKC, invisible characters dropped, control characters and line
 * breaks to spaces, straight quotes, Unicode hyphens to "-", whitespace runs to one space.
 */
function normalizeText(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  return String(raw)
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .normalize('NFKC')
    .replace(CONTROL_CHARS, ' ')
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(ELLIPSIS, '...')
    .replace(UNICODE_HYPHENS, '-')
    .replace(/\s+/g, ' ');
}

/** Digit-dash-digit to "3 to 4", other dashes to ", ", double quotes to single, stray commas tidied. */
function dashSanitize(s: string): string {
  return s
    .replace(FIELD_DASH_DIGITS, '$1 to ')
    .replace(FIELD_DASH_ANY, ', ')
    .replace(/"/g, "'")
    .replace(/,(?:\s*,)+/g, ',')
    .replace(/([.!?;:]),(?=\s|$)/g, '$1')
    .replace(/\s+,/g, ',')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .replace(/\s{2,}/g, ' ');
}

/**
 * Field sanitize: normalizeText, then dashSanitize. Every whitespace run (newlines included) becomes one
 * space, so user text can never start a line in the packet.
 */
function sanitize(raw: unknown): string {
  return dashSanitize(normalizeText(raw));
}

/** Cut at a word boundary so the result (with "...") is at most `cap` chars. Never splits a redaction token. */
function capText(s: string, cap: number): string {
  if (s.length <= cap) return s;
  const room = Math.max(1, cap - 3);
  let end = room;
  if (s[room] !== ' ') {
    const sp = s.lastIndexOf(' ', room);
    if (sp >= room * 0.5) end = sp;
  }
  const bracket = s.lastIndexOf('[', end - 1);
  if (bracket !== -1 && s.startsWith(REDACTED, bracket) && bracket + REDACTED.length > end) end = bracket;
  const cut = s.slice(0, end).replace(/[\s,;:.|'(]+$/, '');
  return `${cut || s.slice(0, room)}...`;
}

function tokenCount(s: string): number {
  let n = 0;
  for (let i = s.indexOf(REDACTED); i !== -1; i = s.indexOf(REDACTED, i + REDACTED.length)) n++;
  return n;
}

/** Per-render context: the sensitive terms field prep redacts. */
interface Ctx {
  terms: readonly string[];
}

function newCtx(terms: readonly string[]): Ctx {
  return { terms };
}

/** `alt` redacted, if that finds more terms than `best` already has; otherwise `best` unchanged. */
function adoptIfMore(best: string, alt: string, terms: readonly string[]): string {
  if (alt === best) return best;
  const r = redact(alt, terms);
  return tokenCount(r) > tokenCount(best) ? r : best;
}

/** A reading applied word by word, so only the word that hides a term changes. */
function perWord(s: string, reading: (w: string) => string, terms: readonly string[]): string {
  return s.replace(/\S+/g, (w) => adoptIfMore(w, reading(w), terms));
}

/**
 * redact() plus the readings a person would still recognize as the term: a dash between the words
 * ("Summit<em>Wealth" reads "Summit-Wealth"), joiners inside a word ("Lake-front" reads "Lakefront"),
 * letters glued to digits ("JPM2026"), accents ("Societe" for the accented spelling), and all of these
 * at once. A reading is adopted only when it redacts more, word by word where it can, so ordinary hyphens,
 * dashes, and accents are left alone. Each reading starts from the already redacted text, so no earlier
 * redaction is ever undone.
 */
function redactReadings(s: string, terms: readonly string[]): string {
  let best = redact(s, terms);
  best = adoptIfMore(best, best.replace(LETTER_DASH, '-'), terms);
  best = perWord(best, (w) => w.replace(LETTER_JOINER, ''), terms);
  best = perWord(best, (w) => w.replace(LETTER_DIGIT, ' '), terms);
  best = adoptIfMore(best, best.replace(LETTER_JOINER, ''), terms);
  best = adoptIfMore(best, foldAccents(best), terms);
  return adoptIfMore(best, allReadings(best), terms);
}

/**
 * Field prep for one user-written value, uncapped: normalize, redact (before the dash rewrite, so a term
 * typed with its own dash still matches, and in the dash and joiner readings), dash sanitize, then redact
 * again (terms that only appear after sanitizing).
 */
function prepText(raw: unknown, terms: readonly string[]): string {
  const n = normalizeText(raw);
  if (!n.trim()) return '';
  return redact(dashSanitize(redactReadings(n, terms)), terms);
}

/** Field prep for one user-written value: sanitize, then redact(), then cap. */
function prep(c: Ctx, raw: unknown, cap?: number): string {
  const text = prepText(raw, c.terms);
  if (!text) return '';
  return cap ? capText(text, cap) : text;
}

/** Term punctuation that people often type differently: "J.P. Morgan", "Smith-Barney", "Smith<en>Barney". */
const TERM_PUNCT = new RegExp(`[-_./${cc(0x00b7)}${DASH_CHARS}]+`, 'g');

/**
 * A sensitive term plus its normalized form, a form with its inner punctuation turned into spaces, and
 * both without accents. redact() lets any run of spaces, hyphens, underscores, or dots stand for a space
 * inside a term, so "J.P. Morgan" also catches "JP Morgan" and "JPMorgan", and "Smith<en>Barney" also
 * catches "Smith Barney" and "Smith-Barney". The original is always kept, so this only ever redacts more.
 */
function termForms(t: string): string[] {
  const n = normalizeText(t).trim();
  const spaced = n.replace(TERM_PUNCT, ' ').replace(/\s+/g, ' ').trim();
  return [t, n, spaced, foldAccents(n), foldAccents(spaced)].filter(Boolean);
}

function packetTerms(terms: readonly string[] | undefined): string[] {
  const out = new Set<string>();
  for (const t of terms ?? []) if (typeof t === 'string') for (const form of termForms(t)) out.add(form);
  return [...out];
}

/** The user's own terms behind the forms the gate found, dash free for the UI: "Smith-Barney". */
function termsForUi(found: readonly string[], terms: readonly string[]): string[] {
  const key = (s: string) => s.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  const original = new Map<string, string>();
  for (const t of terms) if (typeof t === 'string') for (const f of termForms(t)) if (!original.has(key(f))) original.set(key(f), t);
  const ui = found.map((f) => normalizeText(original.get(key(f)) ?? f).replace(FIELD_DASH_ANY, '-').trim());
  return [...new Set(ui)];
}

/**
 * A title that starts a line must not look like a packet line: a list item, the end marker, the header,
 * a burner line ("FAMILY (Low)"), a trend row ("progress 90 90"), or any other label the templates print
 * ("OFF TRACK 3+", "PRIOR 4 WKS", "DRAFT WORK", "no goals set"). Case-insensitive.
 */
const RISKY_LINE_START = new RegExp(
  '^(?:[-*+>#]|\\d{1,2}[.)](?:\\s|$)|suggested\\s*actions?\\b|end\\s*of\\s*packet\\b|(?:end\\s*)?about\\s*me\\b|four\\s*burners\\b' +
    '|(?:family|friends|health|work|burner)\\s*[:(]|(?:last|draft)\\s+(?:family|friends|health|work|q|wk|review)\\b' +
    '|prior\\s+\\d|no\\s+goals\\s+(?:set|drafted)\\b|off\\s*track\\b|energy\\s+by\\s+day\\s+type\\b|crunch\\s+days\\b' +
    '|(?:progress|check-?ins?|energy|actions\\s+done|active\\s+days)\\s*[\\d:-])',
  'i',
);
/** Any colon that is not part of a clock time reads as a label ("Type:", "Me:", "ASK:"); "10:30" does not. */
const LABEL_COLON = /(?<!\d):|:(?!\d)/;
const BULLET_CHARS = cc(0x2022, 0x00b7, 0x25e6, 0x25aa, 0x25cf, 0x2023);

function lineStart(s: string): string {
  return s && (RISKY_LINE_START.test(s) || LABEL_COLON.test(s) || BULLET_CHARS.includes(s[0])) ? `'${s}'` : s;
}

// =============================================================================================
// Finalize and Copy gate

function finalize(text: string, terms: readonly string[]): string {
  const s = text
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(/\r\n?/g, '\n')
    .replace(UNICODE_HYPHENS, '-')
    .replace(LINE_DASH_DIGITS, '$1 to ')
    .replace(LINE_DASH_ANY, ', ');
  // Line by line: redact() lets whitespace join the words of a term, and a newline must never be one of
  // them, or two fields on consecutive lines would fuse into one redaction and merge two packet lines.
  const expanded = packetTerms(terms);
  return s
    .split('\n')
    .map((l) => redact(l, expanded))
    .join('\n');
}

/** Dash sanitize and redact() over the whole rendered string, preamble included. Idempotent. */
export function finalizePacket(text: string, terms: readonly string[]): string {
  return finalize(text, terms);
}

/**
 * Sensitive terms the gate can still see in the text: as written, after dropping invisible characters,
 * and in the dash and joiner readings field prep uses.
 */
function sensitiveIn(text: string, terms: readonly string[]): string[] {
  const found = new Set<string>();
  // Line by line, like finalize: a packet line is the unit, and a newline never joins a term.
  for (const l of text.split(/\r?\n/)) {
    const n = normalizeText(l);
    const readings = [l, n, n.replace(LETTER_DASH, '-'), n.replace(LETTER_JOINER, ''), n.replace(LETTER_DIGIT, ' '), foldAccents(n), allReadings(n)];
    for (const reading of readings) for (const t of findSensitive(reading, terms)) found.add(t);
  }
  return [...found];
}

function alnum(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

const STATIC_ALNUM = alnum(
  [
    PREAMBLE,
    ASK_WEEKLY + ASK_WEEKLY_CRUNCH + ASK_WEEKLY_END,
    askCheckin(0, true),
    ASK_SETUP,
    ASK_ONBOARDING,
    SKIPPED_LINE,
    'not written yet. none written. no goals set. not enough history yet. first quarter in the app. no goals drafted. none logged.',
  ].join('\n'),
);

/** Normalized forms of a private note to search for: raw, redacted, and a leading slice (a capped leak). */
function privateNeedles(note: string, terms: readonly string[]): string[] {
  const out = new Set<string>();
  for (const form of [alnum(note), alnum(prepText(note, terms))]) {
    if (form.length < MIN_PRIVATE_CHARS) continue;
    out.add(form);
    if (form.length > 40) out.add(form.slice(0, 40));
  }
  return [...out];
}

/**
 * The Copy gate on the exact final string: no sensitive term, no em or en dash, and no private note of
 * 12+ normalized chars (lowercased letters and digits) as a substring. A private note whose text the user
 * also wrote somewhere public (`publicTexts`), or that matches the fixed packet wording, is not a leak.
 */
export function packetGate(
  text: string,
  terms: readonly string[],
  privateNotes: readonly string[],
  publicTexts: readonly string[] = [],
): PacketGate {
  const problems: string[] = [];
  const raw = terms;
  terms = packetTerms(terms);
  // Shown in the UI, so the user's own terms are listed, dash free and without duplicates.
  const found = termsForUi(sensitiveIn(text, terms), raw);
  if (found.length) problems.push(`A sensitive term is still in the packet (${found.join(', ')}).`);
  if (BANNED_DASH.test(text)) problems.push('The packet contains an em or en dash.');
  const hay = alnum(text);
  let allowed: string[] | null = null;
  outer: for (const note of privateNotes) {
    if (!note) continue;
    for (const needle of privateNeedles(note, terms)) {
      if (!hay.includes(needle)) continue;
      // Compare against public texts both as written and as redacted (a note naming a sensitive term
      // appears only redacted). A note is excused only when its WHOLE text (raw or redacted) is written
      // somewhere public or is fixed packet wording; a public text that merely shares its opening words
      // does not excuse a cut-off leak of the rest.
      allowed ??= [STATIC_ALNUM, ...publicTexts.flatMap((t) => [alnum(t), alnum(prepText(t, terms))])];
      const whole = [alnum(note), alnum(prepText(note, terms))].filter((f) => f.length >= MIN_PRIVATE_CHARS);
      if (whole.some((w) => allowed!.some((a) => a.includes(w)))) continue;
      problems.push('A private note appears in the packet.');
      break outer;
    }
  }
  return { safe: problems.length === 0, problems };
}

// =============================================================================================
// Selection helpers (privacy)

/** A copy of the log with its edit history dropped and its note kept only when it is not private. */
function scrubLog(l: LogEntry): LogEntry {
  const out: LogEntry = { ...l };
  delete out.edits;
  delete out.notePrivate;
  if (!(l.note && l.note.trim() && !l.notePrivate)) delete out.note;
  return out;
}

function scrubTouchpoint(t: Touchpoint): Touchpoint {
  const out: Touchpoint = { ...t };
  delete out.notePrivate;
  if (!(t.note && t.note.trim() && !t.notePrivate)) delete out.note;
  return out;
}

function scrubLogs(logs: readonly LogEntry[] | undefined): LogEntry[] {
  return (logs ?? []).map(scrubLog);
}

function scrubTouchpoints(tps: readonly Touchpoint[] | undefined): Touchpoint[] {
  return (tps ?? []).map(scrubTouchpoint);
}

function scrubInput(input: DashboardInput): DashboardInput {
  return { ...input, logs: scrubLogs(input.logs), touchpoints: scrubTouchpoints(input.touchpoints) };
}

/** Every private note text (and every earlier note version) the gate must never find in a packet. */
function privateNotesOf(logs: readonly LogEntry[] | undefined, touchpoints: readonly Touchpoint[] | undefined): string[] {
  const out: string[] = [];
  for (const l of logs ?? []) {
    if (l.notePrivate && l.note?.trim()) out.push(l.note);
    for (const e of l.edits ?? []) {
      if (!e.prevNote?.trim()) continue;
      // A value-only correction records the unchanged public note as prevNote; that is not a hidden version.
      if (!l.notePrivate && l.note && alnum(e.prevNote) === alnum(l.note)) continue;
      out.push(e.prevNote);
    }
  }
  for (const t of touchpoints ?? []) if (t.notePrivate && t.note?.trim()) out.push(t.note);
  return out;
}

/** Private notes (log and touchpoint) dated inside [from, to], for the "left out" count. */
function privateInWindow(
  logs: readonly LogEntry[] | undefined,
  touchpoints: readonly Touchpoint[] | undefined,
  from: LocalDate,
  to: LocalDate,
): number {
  const hit = (x: { deleted?: boolean; localDate: LocalDate; note?: string; notePrivate?: boolean }) =>
    !x.deleted && !!x.notePrivate && !!x.note?.trim() && x.localDate >= from && x.localDate <= to;
  return (logs ?? []).filter(hit).length + (touchpoints ?? []).filter(hit).length;
}

function goalTexts(goals: readonly Goal[] | undefined): string[] {
  return (goals ?? []).flatMap((g) => [g.title, g.why ?? '', g.whenWhere ?? '', g.unit ?? '', ...(g.milestones ?? []).map((m) => m.title)]);
}

function profileTexts(p: ProfileFields | undefined): string[] {
  if (!p) return [];
  return [p.lifeContext, p.crunch, ...BURNERS.flatMap((b) => [p.burners?.[b]?.matters ?? '', p.burners?.[b]?.winning ?? ''])];
}

function reviewTexts(reviews: readonly (WeeklyReview | undefined)[]): string[] {
  return reviews.flatMap((r) => (r ? [...(r.wins ?? []), ...(r.misses ?? []), r.focus ?? ''] : []));
}

function noteTexts(logs: readonly LogEntry[], tps: readonly Touchpoint[]): string[] {
  return [...logs.map((l) => l.note ?? ''), ...tps.map((t) => t.note ?? '')];
}

function quarterTexts(qs: readonly (Quarter | undefined)[]): string[] {
  return qs.flatMap((q) => (q ? [q.theme ?? '', ...(q.intentHistory ?? []).map((h) => h.reason)] : []));
}

// =============================================================================================
// Formatting

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOWS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const STATUS_TEXT: Record<BurnerStatus, string> = { on_track: 'on track', behind: 'behind', slipping: 'slipping', idle: 'idle' };
const TOUCH_TEXT: Record<TouchpointType, string> = { call: 'call', text: 'text', in_person: 'in person', other: 'other' };

/** "Sep 14" */
function md(d: LocalDate): string {
  return `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
}

function dowOf(d: LocalDate): string {
  return DOWS[weekday(d)];
}

/** "Wed Sep 23" */
function dmd(d: LocalDate): string {
  return `${dowOf(d)} ${md(d)}`;
}

/** "20" in the same month as `a`, else "Oct 4". */
function endShort(a: LocalDate, b: LocalDate): string {
  return a.slice(0, 7) === b.slice(0, 7) ? String(Number(b.slice(8, 10))) : md(b);
}

/** "Sep 8", "Sep 8 to 9", or "Sep 28 to Oct 2". */
function spanShort(a: LocalDate, b: LocalDate): string {
  return a === b ? md(a) : `${md(a)} to ${endShort(a, b)}`;
}

function yearOf(id: QuarterId): string {
  return id.slice(0, 4);
}

/** "Q3", or "Q4 2025" when the year differs from `refYear`. */
function qLabel(id: QuarterId, refYear?: string): string {
  const [y, q] = id.split('-');
  return refYear && refYear !== y ? `${q} ${y}` : q;
}

/** Max 1 decimal, trailing .0 dropped. */
function num(n: number): string {
  const r = Math.round(n * 10) / 10;
  return r === 0 ? '0' : String(r);
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function avg(xs: readonly number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function numOrDash(n: number | null | undefined): string {
  return n === null || n === undefined ? '-' : num(n);
}

function byDateThenAt<T extends { localDate: LocalDate; at?: string }>(a: T, b: T): number {
  if (a.localDate !== b.localDate) return a.localDate < b.localDate ? -1 : 1;
  const x = a.at ?? '';
  const y = b.at ?? '';
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Unique weekday names in date order: "Mon Wed". */
function dowList(dates: readonly LocalDate[]): string {
  return [...new Set([...dates].sort())].map(dowOf).join(' ');
}

function sumValues(ls: readonly LogEntry[]): number {
  return ls.reduce((s, l) => s + l.value, 0);
}

function normText(s: string): string {
  return sanitize(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

type Line = string | null | undefined | false;

function assemble(body: readonly Line[]): string {
  const kept = body.filter((l): l is string => typeof l === 'string' && l.trim() !== '');
  return [PREAMBLE, '', ...kept, PACKET_END].join('\n');
}

function trimmedLine(trimmed: readonly string[]): Line {
  return trimmed.length ? `TRIMMED for length: ${trimmed.join(', ')}` : null;
}

/** Up to `max` prepped items joined "; ". */
function joinPrepped(c: Ctx, items: readonly string[] | undefined, cap: number, max: number): string {
  return (items ?? [])
    .filter((x) => sanitize(x))
    .slice(0, max)
    .map((x) => prep(c, x, cap))
    .filter(Boolean)
    .join('; ');
}

/** Split `total` chars fairly: short items keep their full length and the rest share what is left. */
function fairShare(lengths: readonly number[], total: number): number[] {
  const out = lengths.map(() => 0);
  let left = Math.max(0, total);
  const order = lengths.map((n, i) => ({ n, i })).sort((a, b) => a.n - b.n || a.i - b.i);
  order.forEach(({ n, i }, k) => {
    out[i] = Math.min(n, Math.floor(left / (order.length - k)));
    left -= out[i];
  });
  return out;
}

/**
 * ME line in profileLine() format ("Life: ... | Family: ... | Travel: Most weeks | Crunch: ..."), from
 * redacted fields (so a cap never splits a term). When the fields are longer than `cap`, each one gets a
 * fair share, cut at a word boundary, instead of the first fields filling the line: every burner's win,
 * Travel, and Crunch always reach the coach.
 */
function meLine(c: Ctx, p: ProfileFields | undefined, cap: number): string {
  if (!p || profileIsEmpty(p)) return '';
  const w = (b: BurnerId) => prep(c, p.burners?.[b]?.winning);
  const parts = (
    [
      ['Life', prep(c, p.lifeContext)],
      ['Family', w('family')],
      ['Friends', w('friends')],
      ['Health', w('health')],
      ['Work', w('work')],
      ['Travel', travelLabel(p.travel ?? null)],
      ['Crunch', prep(c, p.crunch)],
    ] as [string, string][]
  ).filter(([, v]) => v);
  const join = (ps: readonly [string, string][]) => ps.map(([label, v]) => `${label}: ${v}`).join(' | ');
  const whole = join(parts);
  if (whole.length <= cap) return whole;
  // The Travel label is fixed wording and short, so it is never cut.
  const fixed = join(parts.map(([label, v]) => [label, label === 'Travel' ? v : ''])).length;
  const cut = parts.filter(([label]) => label !== 'Travel');
  const shares = fairShare(
    cut.map(([, v]) => v.length),
    cap - fixed,
  );
  const sized = new Map(cut.map(([label, v], i) => [label, capText(v, Math.max(16, shares[i]))]));
  const line = join(parts.map(([label, v]) => [label, sized.get(label) ?? v]));
  return line.length <= cap ? line : capText(line, cap);
}

// =============================================================================================
// Build loop and trimming ladder

interface LadderStep {
  id: string;
  label: string;
}

/** Renders the packet body with the given detail flags, redacting user text with `terms`. */
type Render = (flags: ReadonlySet<string>, trimmed: readonly string[], terms: readonly string[]) => string;

interface BuildSpec {
  kind: PacketKind;
  scope: string;
  terms: readonly string[];
  render: Render;
  ladder: readonly LadderStep[];
  privateNotes: readonly string[];
  publicTexts: readonly string[];
  privateOmitted: number;
}

function buildPacket(spec: BuildSpec): BuiltPacket {
  const budget = PACKET_BUDGETS[spec.kind];
  // Field prep redacts with every spelling of each term; the gate below gets the user's own list.
  const expanded = packetTerms(spec.terms);
  const run = (flags: readonly string[], trimmed: readonly string[], terms: readonly string[] = expanded): string =>
    finalize(spec.render(new Set(flags), trimmed, terms), terms);
  let flags: string[] = [];
  let trimmed: string[] = [];
  let out = run(flags, trimmed);
  for (const step of spec.ladder) {
    if (out.length <= budget) break;
    const next = [...flags, step.id];
    // A step that changes nothing is skipped, so the TRIMMED line only names detail that is really missing.
    if (run(next, trimmed) === out) continue;
    flags = next;
    trimmed = [...trimmed, step.label];
    out = run(flags, trimmed);
  }
  // Counted on the exact final string: tokens in it minus those the same render has without any terms
  // (the fixed wording, and anything the user typed literally). A token a field cap cut off never counts.
  const redactions = Math.max(0, tokenCount(out) - tokenCount(run(flags, trimmed, [])));
  const gate = packetGate(out, spec.terms, spec.privateNotes, spec.publicTexts);
  return {
    kind: spec.kind,
    scope: spec.scope,
    text: out,
    chars: out.length,
    budget,
    stats: { redactions, privateOmitted: spec.privateOmitted, trimmed },
    safe: gate.safe,
    problems: gate.problems,
  };
}

const WEEKLY_LADDER: readonly LadderStep[] = [
  { id: 'notes1', label: 'some notes' },
  { id: 'energyType', label: 'energy by day type' },
  { id: 'freshPeople', label: 'names of ok people' },
  { id: 'whenOnTrack', label: 'when on on-track goals' },
  { id: 'whyOnTrack', label: 'why on on-track goals' },
  { id: 'repeatMisses', label: 'repeat misses' },
  { id: 'activeTrend', label: 'active days trend' },
  { id: 'meShort', label: 'ME shortened' },
  { id: 'notesAll', label: 'all notes' },
];

const CHECKIN_LADDER: readonly LadderStep[] = [
  { id: 'energyType', label: 'energy by day type' },
  { id: 'whenOnTrack', label: 'when on on-track goals' },
  { id: 'whyOnTrack', label: 'why on on-track goals' },
  { id: 'reviewMisses', label: 'last review misses' },
  { id: 'lastReview', label: 'last review' },
  { id: 'meShort', label: 'ME shortened' },
];

const SETUP_LADDER: readonly LadderStep[] = [
  { id: 'wins', label: 'last Q wins' },
  { id: 'repeatMisses', label: 'repeat misses' },
  { id: 'steps', label: 'milestone steps' },
  { id: 'pct', label: 'last Q percents' },
  { id: 'meShort', label: 'ME shortened' },
];

// =============================================================================================
// Goals (weekly and check-in)

interface NoteView {
  date: LocalDate;
  key: string;
  text: string;
}

interface GoalView {
  burner: BurnerId;
  title: string;
  why?: string;
  when?: string;
  status: GoalStatus;
  pace: number;
  isNew: boolean;
  done: boolean;
  doneDate: LocalDate | null;
  addedOn: LocalDate | null;
  progress: (c: Ctx) => string;
  /** Weekly: this week's amount. Check-in: the rate (realism signal). */
  extra: (c: Ctx) => string;
  /** Public notes this week, newest first (weekly only). */
  notes: NoteView[];
}

/** Non-deleted logs up to `asOf`, grouped by goal, oldest first. */
function logsByGoal(logs: readonly LogEntry[], asOf: LocalDate): Map<string, LogEntry[]> {
  const out = new Map<string, LogEntry[]>();
  for (const l of logs) {
    if (l.deleted || l.localDate > asOf) continue;
    const arr = out.get(l.goalId);
    if (arr) arr.push(l);
    else out.set(l.goalId, [l]);
  }
  for (const arr of out.values()) arr.sort(byDateThenAt);
  return out;
}

/** The lived date the goal reached its target, from its logs (oldest first). */
function completionDate(goal: Goal, gl: readonly LogEntry[]): LocalDate | null {
  const required = requiredFor(goal);
  if (required <= 0) return null;
  if (goal.type === 'yesno') return gl.find((l) => l.value > 0)?.localDate ?? null;
  if (goal.type === 'milestone') {
    const ids = new Set((goal.milestones ?? []).map((m) => m.id));
    const done = new Set<string>();
    for (const l of gl) {
      if (!l.milestoneId || !ids.has(l.milestoneId)) continue;
      done.add(l.milestoneId);
      if (done.size >= required) return l.localDate;
    }
    return null;
  }
  let sum = 0;
  for (const l of gl) {
    sum += l.value;
    if (sum >= required) return l.localDate;
  }
  return null;
}

/** Milestone ids done (per logs) and the first date each was done. */
function milestoneDone(gl: readonly LogEntry[]): Map<string, LocalDate> {
  const out = new Map<string, LocalDate>();
  for (const l of gl) if (l.milestoneId && !out.has(l.milestoneId)) out.set(l.milestoneId, l.localDate);
  return out;
}

function unitSuffix(c: Ctx, unit: string | undefined): string {
  const u = prep(c, unit, CAP.unit);
  return u ? ` ${u}` : '';
}

/** "/3" after a count, or ", NO TARGET" when the goal has none (never a made-up "/0" or "/?"). */
function ofTarget(goal: Goal, suffix = ''): string {
  return goal.target && goal.target > 0 ? `/${num(goal.target)}${suffix}` : `${suffix}, NO TARGET`;
}

function numberProgress(c: Ctx, goal: Goal, actual: number): string {
  return goal.target && goal.target > 0
    ? `${num(actual)}/${num(goal.target)}${unitSuffix(c, goal.unit)}`
    : `${num(actual)}${unitSuffix(c, goal.unit)}, NO TARGET`;
}

function milestoneProgress(c: Ctx, goal: Goal, done: ReadonlyMap<string, LocalDate>): string {
  const ms = goal.milestones ?? [];
  const n = ms.filter((m) => done.has(m.id)).length;
  const next = ms.find((m) => !done.has(m.id));
  const nextText = next ? prep(c, next.title, CAP.step) : '';
  return `steps ${n}/${ms.length}${nextText ? `, next: ${nextText}` : ''}`;
}

function paceFlag(g: GoalView): string {
  if (g.isNew) return 'pace new';
  const flag = g.status === 'behind' ? ' BEHIND' : g.status === 'slipping' ? ' SLIPPING' : '';
  return `pace ${pct(g.pace)}${flag}`;
}

function offTrack(g: GoalView): boolean {
  return g.status === 'behind' || g.status === 'slipping';
}

function baseView(goal: Goal, p: GoalProgress, gl: readonly LogEntry[], asOf: LocalDate, quarterStart: LocalDate) {
  return {
    burner: goal.burner,
    title: goal.title,
    why: goal.why,
    when: goal.whenWhere,
    status: p.status,
    pace: p.pace,
    isNew: diffDays(goal.startDate, asOf) < NEW_GOAL_GRACE_DAYS,
    done: p.complete,
    doneDate: p.complete ? completionDate(goal, gl) : null,
    addedOn: goal.startDate > quarterStart ? goal.startDate : null,
  };
}

function weeklyGoalView(
  goal: Goal,
  p: GoalProgress,
  gl: readonly LogEntry[],
  weekStart: LocalDate,
  asOf: LocalDate,
  quarterStart: LocalDate,
): GoalView {
  const inWeek = gl.filter((l) => l.localDate >= weekStart);
  const weekSum = sumValues(inWeek);
  const weekDows = dowList(inWeek.map((l) => l.localDate));
  let progress: (c: Ctx) => string = () => '';
  let extra: (c: Ctx) => string = () => '';
  if (goal.type === 'number') {
    progress = (c) => numberProgress(c, goal, p.actual);
    extra = () => (weekSum > 0 ? `wk +${num(weekSum)} (${weekDows})` : 'wk 0');
  } else if (goal.type === 'habit' && goal.habitPeriod === 'month') {
    const monthSum = sumValues(gl.filter((l) => l.localDate >= startOfMonth(asOf)));
    progress = () => `mo ${num(monthSum)}${ofTarget(goal)}`;
    extra = () => (weekSum > 0 ? `wk ${num(weekSum)} (${weekDows})` : 'wk 0');
  } else if (goal.type === 'habit') {
    progress = () => `wk ${num(weekSum)}${ofTarget(goal, weekDows ? ` (${weekDows})` : '')}`;
  } else if (goal.type === 'yesno') {
    progress = () => 'yes/no, not done';
  } else if (goal.type === 'milestone') {
    const done = milestoneDone(gl);
    const stepsThisWeek = (goal.milestones ?? []).filter((m) => {
      const d = done.get(m.id);
      return d !== undefined && d >= weekStart;
    });
    progress = (c) => milestoneProgress(c, goal, done);
    extra = (c) => {
      const titles = stepsThisWeek.map((m) => prep(c, m.title, CAP.step)).filter(Boolean);
      return titles.length ? `wk: ${titles.join(', ')} done` : '';
    };
  }
  const notes = inWeek
    .filter((l) => l.note && sanitize(l.note))
    .sort(byDateThenAt)
    .reverse()
    .map((l) => ({ date: l.localDate, key: `${l.localDate}|${l.at ?? ''}`, text: l.note as string }));
  return { ...baseView(goal, p, gl, asOf, quarterStart), progress, extra, notes };
}

function checkinGoalView(goal: Goal, p: GoalProgress, gl: readonly LogEntry[], today: LocalDate, quarterStart: LocalDate): GoalView {
  const last28 = sumValues(gl.filter((l) => l.localDate >= addDays(today, -27)));
  let progress: (c: Ctx) => string = () => '';
  let extra: (c: Ctx) => string = () => '';
  if (goal.type === 'number') {
    progress = (c) => numberProgress(c, goal, p.actual);
    const recent = `last 4 wks ${num(last28 / 4)}/wk`;
    if (goal.target && goal.target > 0) {
      const remaining = Math.max(0, p.required - p.actual);
      const daysLeft = diffDays(today, goal.deadline) + 1;
      const need = daysLeft > 0 ? `needs ${num(remaining / (daysLeft / 7))}/wk` : `needs ${num(remaining)}, deadline passed`;
      extra = () => `${need}, ${recent}`;
    } else {
      extra = () => recent;
    }
  } else if (goal.type === 'habit') {
    const monthly = goal.habitPeriod === 'month';
    progress = () =>
      goal.target && goal.target > 0
        ? `${num(p.actual)}/${num(p.required)} (${num(goal.target)}/${monthly ? 'mo' : 'wk'})`
        : `${num(p.actual)}, NO TARGET`;
    extra = () => (monthly ? `last 4 wks ${num(last28)}` : `last 4 wks ${num(last28 / 4)}/wk`);
  } else if (goal.type === 'yesno') {
    progress = () => 'not done';
  } else if (goal.type === 'milestone') {
    const done = milestoneDone(gl);
    progress = (c) => milestoneProgress(c, goal, done);
  }
  return { ...baseView(goal, p, gl, today, quarterStart), progress, extra, notes: [] };
}

/** The "title: ..." line shared by weekly and check-in. */
function goalLine(c: Ctx, g: GoalView, flags: ReadonlySet<string>, notes: readonly NoteView[] = []): string {
  const title = lineStart(prep(c, g.title, CAP.title)) || 'Untitled goal';
  if (g.done) return `${title}: DONE${g.doneDate ? ` ${md(g.doneDate)}` : ''}`;
  let s = `${title}${g.addedOn ? ` (added ${md(g.addedOn)})` : ''}: ${g.progress(c)}`;
  const extra = g.extra(c);
  const weeklyStyle = flags.has('weekly');
  if (extra && weeklyStyle) s += `, ${extra}`;
  s += `, ${paceFlag(g)}`;
  if (extra && !weeklyStyle) s += `, ${extra}`;
  const keepDetail = offTrack(g);
  if (keepDetail || !flags.has('whyOnTrack')) s += ` | why: ${prep(c, g.why, CAP.why) || 'MISSING'}`;
  if (keepDetail || !flags.has('whenOnTrack')) s += ` | when: ${prep(c, g.when, CAP.when) || 'MISSING'}`;
  const noteText = notes.map((n) => `${dowOf(n.date)} "${prep(c, n.text, CAP.note)}"`).join('; ');
  if (noteText) s += ` | notes: ${noteText}`;
  return s;
}

/** Notes shown: up to `perGoal` newest per goal, then the `perPacket` newest overall. */
function pickNotes(goals: readonly GoalView[], perGoal: number, perPacket: number): Map<GoalView, NoteView[]> {
  const cands = goals.filter((g) => !g.done).flatMap((g) => g.notes.slice(0, perGoal).map((n) => ({ g, n })));
  cands.sort((a, b) => (a.n.key < b.n.key ? 1 : a.n.key > b.n.key ? -1 : 0));
  const out = new Map<GoalView, NoteView[]>();
  for (const { g, n } of cands.slice(0, perPacket)) {
    const arr = out.get(g);
    if (arr) arr.push(n);
    else out.set(g, [n]);
  }
  return out;
}

// =============================================================================================
// People, crunch, energy, patterns

interface PersonView {
  name: string;
  state: ConnectionState | 'contacted';
  daysSince: number | null;
  cadence: number;
  contacts: string;
  note: string | null;
}

function peopleOf(people: readonly Person[], burner: BurnerId): Person[] {
  return people.filter((p) => !p.deleted && p.burner === burner);
}

/** Contacted this week first (in list order), then everyone else by urgency. */
function weeklyPeopleViews(people: readonly Person[], tps: readonly Touchpoint[], from: LocalDate, asOf: LocalDate): PersonView[] {
  const byPerson = new Map<string, Touchpoint[]>();
  for (const t of tps) {
    if (t.deleted || t.localDate < from || t.localDate > asOf) continue;
    const arr = byPerson.get(t.personId);
    if (arr) arr.push(t);
    else byPerson.set(t.personId, [t]);
  }
  const contacted: PersonView[] = [...people]
    .filter((p) => byPerson.has(p.id))
    .sort((a, b) => a.order - b.order)
    .map((p) => {
      const list = [...(byPerson.get(p.id) ?? [])].sort(byDateThenAt);
      const types = new Map<TouchpointType, LocalDate[]>();
      for (const t of list) types.set(t.type, [...(types.get(t.type) ?? []), t.localDate]);
      const contacts = [...types].map(([type, dates]) => `${TOUCH_TEXT[type] ?? 'other'} ${dowList(dates)}`).join(', ');
      const withNote = [...list].reverse().find((t) => t.note && sanitize(t.note));
      return { name: p.name, state: 'contacted' as const, daysSince: 0, cadence: p.cadenceDays, contacts, note: withNote?.note ?? null };
    });
  const rest: PersonView[] = peopleByUrgency(people, tps, asOf)
    .filter((s) => !byPerson.has(s.person.id))
    .map((s) => ({ name: s.person.name, state: s.state, daysSince: s.daysSince, cadence: s.person.cadenceDays, contacts: '', note: null }));
  return [...contacted, ...rest];
}

function statusPerson(name: string, p: PersonView): string {
  switch (p.state) {
    case 'overdue':
      return `${name} OVERDUE ${p.daysSince}d (every ${p.cadence}d)`;
    case 'due':
      return `${name} due now ${p.daysSince}d (every ${p.cadence}d)`;
    case 'approaching':
      return `${name} due soon ${p.daysSince}d (every ${p.cadence}d)`;
    case 'never':
      return `${name} none logged (every ${p.cadence}d)`;
    default:
      return `${name} ok`;
  }
}

function weeklyPeopleText(c: Ctx, views: readonly PersonView[], flags: ReadonlySet<string>): string {
  const parts: string[] = [];
  let ok = 0;
  for (const p of views) {
    if (p.state === 'fresh' && flags.has('freshPeople')) {
      ok++;
      continue;
    }
    const name = prep(c, p.name, CAP.name) || 'Someone';
    if (p.state === 'contacted') {
      const note = p.note && !flags.has('notesAll') ? prep(c, p.note, CAP.note) : '';
      parts.push(`${name} ${p.contacts}${note ? ` "${note}"` : ''}`);
    } else {
      parts.push(statusPerson(name, p));
    }
  }
  if (ok) parts.push(`${ok} ok`);
  return parts.join('; ');
}

/** Check-in people: only those needing attention, then a count of the rest. */
function checkinPeopleText(c: Ctx, people: readonly Person[], tps: readonly Touchpoint[], today: LocalDate): string {
  const parts: string[] = [];
  let ok = 0;
  for (const s of peopleByUrgency(people, tps, today)) {
    if (s.state === 'fresh') {
      ok++;
      continue;
    }
    const view: PersonView = { name: s.person.name, state: s.state, daysSince: s.daysSince, cadence: s.person.cadenceDays, contacts: '', note: null };
    parts.push(statusPerson(prep(c, s.person.name, CAP.name) || 'Someone', view));
  }
  if (ok) parts.push(`${ok} ok`);
  return parts.join('; ');
}

interface CrunchItem {
  text: string;
  label?: string;
}

function crunchItemText(c: Ctx, it: CrunchItem): string {
  const label = prep(c, it.label, CAP.crunchLabel);
  return label ? `${it.text} ("${label}")` : it.text;
}

function liveCrunch(periods: readonly CrunchPeriod[] | undefined): CrunchPeriod[] {
  return (periods ?? []).filter((p) => !p.deleted).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

function isOn(p: CrunchPeriod, d: LocalDate): boolean {
  return p.start <= d && (!p.end || p.end >= d);
}

function onNowText(p: CrunchPeriod): string {
  return p.end ? `on now until ${md(p.end)}` : 'on now, no end';
}

function aheadItems(live: readonly CrunchPeriod[], today: LocalDate): CrunchItem[] {
  const horizon = addDays(today, 14);
  return live
    .filter((p) => p.start > today && p.start <= horizon)
    .map((p) => ({ text: `${dmd(p.start)}${!p.end ? ', no end' : p.end === p.start ? '' : ` to ${dmd(p.end)}`}`, label: p.label }));
}

interface WeeklyCrunch {
  week: CrunchItem[];
  now: CrunchItem | null;
  ahead: CrunchItem[];
  crunchAhead: boolean;
}

function weeklyCrunch(periods: readonly CrunchPeriod[], weekStart: LocalDate, asOf: LocalDate, today: LocalDate): WeeklyCrunch {
  const live = liveCrunch(periods);
  const week: CrunchItem[] = [];
  const listed = new Set<CrunchPeriod>();
  for (const p of live) {
    const a = p.start > weekStart ? p.start : weekStart;
    const b = p.end && p.end < asOf ? p.end : asOf;
    if (a > b) continue;
    week.push({ text: a === b ? dowOf(a) : `${dowOf(a)} to ${dowOf(b)}`, label: p.label });
    listed.add(p);
  }
  let now: CrunchItem | null = null;
  let stillOn = false;
  const cur = live.find((p) => isOn(p, today));
  if (cur && (!cur.end || cur.end > asOf)) {
    now = { text: onNowText(cur), label: listed.has(cur) ? undefined : cur.label };
    stillOn = !cur.end || cur.end > today;
  }
  const ahead = aheadItems(live, today);
  return { week, now, ahead, crunchAhead: stillOn || ahead.length > 0 };
}

function weeklyCrunchText(c: Ctx, w: WeeklyCrunch): string {
  const parts: string[] = [];
  if (w.week.length) parts.push(w.week.map((it) => crunchItemText(c, it)).join(', '));
  if (w.now) parts.push(crunchItemText(c, w.now));
  if (w.ahead.length) parts.push(`Ahead: ${w.ahead.map((it) => crunchItemText(c, it)).join('; ')}`);
  return parts.join('. ');
}

function checkinCrunchText(c: Ctx, periods: readonly CrunchPeriod[], today: LocalDate): string {
  const live = liveCrunch(periods);
  const recentFrom = addDays(today, -13);
  const now = live.filter((p) => isOn(p, today)).map((p) => crunchItemText(c, { text: onNowText(p), label: p.label }));
  const past = live
    .filter((p) => !isOn(p, today) && p.start <= today && p.end && p.end < today && p.end >= recentFrom)
    .map((p) => crunchItemText(c, { text: spanShort(p.start, p.end as LocalDate), label: p.label }));
  const ahead = aheadItems(live, today).map((it) => crunchItemText(c, it));
  const parts = [...now];
  if (past.length) parts.push(past.join(', '));
  if (ahead.length) parts.push(`Ahead: ${ahead.join('; ')}`);
  return parts.join('. ');
}

/** Dates with any log on a Health goal. */
function healthLogDays(goals: readonly Goal[], logs: readonly LogEntry[]): Set<LocalDate> {
  const health = new Set(goals.filter((g) => !g.deleted && g.burner === 'health').map((g) => g.id));
  return new Set(logs.filter((l) => !l.deleted && health.has(l.goalId)).map((l) => l.localDate));
}

/** "crunch 2.3 (3d), weekday 3.2 (17d), weekend 4 (9d); with a Health log 3.7 (15d), without 3 (14d)" */
function energyByTypeText(
  energy: readonly EnergyEntry[],
  crunch: ReadonlySet<LocalDate>,
  healthDays: ReadonlySet<LocalDate>,
  from: LocalDate,
  to: LocalDate,
): string {
  const rated: { d: LocalDate; r: number }[] = [];
  for (const d of dateRange(from, to)) {
    const e = energyOn(energy, d);
    if (e) rated.push({ d, r: e.rating });
  }
  if (rated.length < 10) return '';
  const buckets: [string, number[]][] = [
    ['crunch', []],
    ['weekday', []],
    ['weekend', []],
  ];
  for (const x of rated) buckets[crunch.has(x.d) ? 0 : weekday(x.d) >= 5 ? 2 : 1][1].push(x.r);
  let s = buckets
    .filter(([, v]) => v.length >= 2)
    .map(([name, v]) => `${name} ${num(avg(v) as number)} (${v.length}d)`)
    .join(', ');
  const withLog = rated.filter((x) => healthDays.has(x.d)).map((x) => x.r);
  const without = rated.filter((x) => !healthDays.has(x.d)).map((x) => x.r);
  if (withLog.length >= 3 && without.length >= 3) {
    s += `${s ? '; ' : ''}with a Health log ${num(avg(withLog) as number)} (${withLog.length}d), without ${num(avg(without) as number)} (${without.length}d)`;
  }
  return s;
}

/** Goals behind or slipping at 3+ of the given week-end points, judged with the intent in force that day. */
function chronicGoals(
  goals: readonly Goal[],
  byGoal: ReadonlyMap<string, LogEntry[]>,
  quarter: Quarter,
  crunch: readonly CrunchPeriod[],
  points: readonly LocalDate[],
  skip: (g: Goal) => boolean,
): { title: string; n: number }[] {
  const crunchAt = new Map(points.map((pt) => [pt, crunchDateSet(crunch, pt)]));
  const out: { title: string; n: number; idx: number }[] = [];
  goals.forEach((g, idx) => {
    if (skip(g)) return;
    const gl = byGoal.get(g.id) ?? [];
    let n = 0;
    for (const pt of points) {
      if (pt < g.startDate) continue;
      const p = goalProgress(
        g,
        gl.filter((l) => l.localDate <= pt),
        pt,
        { intent: intentOn(quarter, g.burner, pt), crunchDates: crunchAt.get(pt) },
      );
      if (p.status === 'behind' || p.status === 'slipping') n++;
    }
    if (n >= 3) out.push({ title: g.title, n, idx });
  });
  return out.sort((a, b) => b.n - a.n || a.idx - b.idx).slice(0, 3);
}

function liveReviews(reviews: readonly WeeklyReview[] | undefined): WeeklyReview[] {
  return (reviews ?? []).filter((r) => r && !r.deleted);
}

function actionText(c: Ctx, a: { text: string; burner?: BurnerId }): string {
  const t = prep(c, a.text, CAP.action);
  if (!t) return '';
  return a.burner ? `${t} (${BURNER_LABELS[a.burner]})` : t;
}

// =============================================================================================
// Weekly

export function buildWeeklyPacket(i: WeeklyPacketInput): BuiltPacket {
  const terms = i.input.settings?.sensitiveTerms ?? [];
  const input = scrubInput(i.input);
  const { quarter } = input;
  const span = quarterSpan(quarter.id);
  const weekStart = i.weekStart;
  const weekEnd = addDays(weekStart, 6);
  const today = input.today;
  const asOf = today < weekEnd ? today : weekEnd;
  const review = i.review;

  // ---- selectPacketData: every value below comes from scrubbed records and structured fields.
  const summary = weekSummary(input, weekStart);
  const dash = computeDashboard({ ...input, today: asOf });
  const crunchSet = crunchDateSet(input.crunch, asOf);
  const byGoal = logsByGoal(input.logs, asOf);
  const daysLeft = Math.max(0, diffDays(asOf, span.end));

  const dayItems = (weekStart <= asOf ? dateRange(weekStart, asOf) : []).map((d, idx) => {
    const e = summary.energy.days[idx];
    return `${dowOf(d)} ${e ?? '-'}${crunchSet.has(d) ? ' crunch' : ''}${summary.checkedIn[idx] ? '' : ' no check-in'}`;
  });
  const weekEnergy = avg(summary.energy.days.filter((x): x is number => x !== null));
  const priorEnergy = avg(
    dateRange(addDays(weekStart, -7), addDays(weekStart, -1))
      .map((d) => energyOn(input.energy, d)?.rating)
      .filter((x): x is EnergyEntry['rating'] => x !== undefined),
  );
  const weekLine =
    `WEEK: check-ins ${summary.checkInDays}/${summary.daysElapsed}, streak ${dash.streak.current}d (best ${dash.streak.longest}), ` +
    `energy ${numOrDash(weekEnergy)} (prior wk ${numOrDash(priorEnergy)}), progress ${summary.progressScore}, consistency ${dash.consistencyScore}`;

  const goalViews = {} as Record<BurnerId, GoalView[]>;
  for (const b of BURNERS) {
    goalViews[b] = dash.burners[b].goals.map(({ goal, progress }) =>
      weeklyGoalView(goal, progress, byGoal.get(goal.id) ?? [], weekStart, asOf, span.start),
    );
  }
  const allViews = BURNERS.flatMap((b) => goalViews[b]);

  const burnerLine = {} as Record<BurnerId, string>;
  for (const b of BURNERS) {
    const w = summary.burners[b];
    burnerLine[b] =
      `${b.toUpperCase()} (${INTENT_LABELS[w.intent]}): ${STATUS_TEXT[w.status]}` +
      `${w.pace !== null ? `, pace ${pct(w.pace)}` : ''}, active ${w.activeDays}/${num(w.expectedActiveDays)}`;
  }

  const people = {
    family: weeklyPeopleViews(peopleOf(input.people, 'family'), input.touchpoints, weekStart, asOf),
    friends: weeklyPeopleViews(peopleOf(input.people, 'friends'), input.touchpoints, weekStart, asOf),
  };

  const crunchInfo = weeklyCrunch(input.crunch, weekStart, asOf, today);

  // Prior 4 full weeks, oldest first; each from weekSummary as of that Sunday.
  const trendWeeks = [4, 3, 2, 1].map((k) => {
    const monday = addDays(weekStart, -7 * k);
    const sunday = addDays(monday, 6);
    const s = weekSummary({ ...input, today: sunday }, monday);
    const has = s.checkInDays > 0;
    const dashIf = (v: string) => (has ? v : '-');
    const e = avg(s.energy.days.filter((x): x is number => x !== null));
    return {
      monday,
      has,
      // Weeks before this quarter cannot be scored against this quarter's goals.
      progress: dashIf(sunday >= input.quarterStart ? String(s.progressScore) : '-'),
      checkIns: dashIf(String(s.checkInDays)),
      energy: dashIf(numOrDash(e)),
      crunch: dashIf(String(s.crunchDays)),
      actions: dashIf(s.actions.total ? `${s.actions.done}/${s.actions.total}` : '-'),
      active: Object.fromEntries(BURNERS.map((b) => [b, dashIf(String(s.burners[b].activeDays))])) as Record<BurnerId, string>,
    };
  });
  const hasTrend = trendWeeks.filter((t) => t.has).length >= 2;
  const energyType = hasTrend
    ? energyByTypeText(input.energy, crunchSet, healthLogDays(input.goals, input.logs), addDays(asOf, -34), asOf)
    : '';

  const quarterGoals = BURNERS.flatMap((b) => dash.burners[b].goals.map((g) => g.goal));
  const doneIds = new Set(BURNERS.flatMap((b) => dash.burners[b].goals.filter((g) => g.progress.complete).map((g) => g.goal.id)));
  const chronic = chronicGoals(
    quarterGoals,
    byGoal,
    quarter,
    input.crunch,
    [asOf, addDays(weekEnd, -7), addDays(weekEnd, -14), addDays(weekEnd, -21), addDays(weekEnd, -28)],
    (g) => doneIds.has(g.id),
  );

  const prior4 = liveReviews(i.reviews)
    .filter((r) => r.weekStart < weekStart && r.id !== review?.id)
    .sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1))
    .slice(0, 4);
  const priorMissSets = prior4.map((r) => new Set((r.misses ?? []).map(normText).filter(Boolean)));
  const seenMiss = new Set<string>();
  const repeatMisses: { text: string; n: number }[] = [];
  for (const m of review?.misses ?? []) {
    const key = normText(m);
    if (!key || seenMiss.has(key)) continue;
    seenMiss.add(key);
    const n = priorMissSets.filter((s) => s.has(key)).length;
    if (n >= 2) repeatMisses.push({ text: m, n });
  }
  repeatMisses.sort((a, b) => b.n - a.n);

  const changes = [...(quarter.intentHistory ?? [])].filter((ch) => ch.localDate <= today).sort(byDateThenAt);

  const privateOmitted = privateInWindow(i.input.logs, i.input.touchpoints, weekStart, weekEnd);
  const publicTexts = [
    ...goalTexts(i.input.goals),
    ...noteTexts(input.logs, input.touchpoints),
    ...reviewTexts([review, ...liveReviews(i.reviews)]),
    ...(input.actions ?? []).map((a) => a.text),
    ...(input.crunch ?? []).map((p) => p.label ?? ''),
    ...quarterTexts([quarter]),
    ...input.people.map((p) => p.name),
    ...profileTexts(i.profile),
  ];

  // ---- render
  const render: Render = (flagsIn, trimmed, t) => {
    const flags = new Set(flagsIn);
    flags.add('weekly');
    const c = newCtx(t);
    const L: Line[] = [];
    const theme = prep(c, quarter.theme, CAP.theme);
    L.push(
      `TYPE: weekly review, ${md(weekStart)} to ${endShort(weekStart, weekEnd)}, ${yearOf(quarter.id)} | ${qLabel(quarter.id)}, ` +
        `${daysLeft}d left${theme ? ` | theme: ${theme}` : ''}`,
    );
    L.push(trimmedLine(trimmed));
    L.push(`ME: ${meLine(c, i.profile, flags.has('meShort') ? CAP.aboutMeShort : CAP.aboutMe) || 'not written yet'}`);
    const crunchText = weeklyCrunchText(c, crunchInfo);
    L.push(crunchText && `CRUNCH: ${crunchText}`);
    L.push(`DAYS (energy 1 to 5): ${dayItems.length ? dayItems.join(', ') : 'none yet'}`);
    L.push(weekLine);
    if (summary.actions.total) {
      const open = summary.actions.undone.map((a) => actionText(c, a)).filter(Boolean).join('; ');
      L.push(`LAST WK ACTIONS: ${summary.actions.done}/${summary.actions.total} done${open ? `; open: ${open}` : ''}`);
    }
    const notes = flags.has('notesAll') ? new Map<GoalView, NoteView[]>() : flags.has('notes1') ? pickNotes(allViews, 1, 3) : pickNotes(allViews, 2, 6);
    for (const b of BURNERS) {
      L.push(burnerLine[b]);
      if (!goalViews[b].length) L.push('no goals set');
      for (const g of goalViews[b]) L.push(goalLine(c, g, flags, notes.get(g)));
      if (b === 'family' || b === 'friends') {
        const text = weeklyPeopleText(c, people[b], flags);
        L.push(text && `people: ${text}`);
      }
    }
    L.push(`WINS: ${joinPrepped(c, review?.wins, CAP.win, MAX_WINS) || 'none written'}`);
    L.push(`MISSES: ${joinPrepped(c, review?.misses, CAP.miss, MAX_WINS) || 'none written'}`);
    if (hasTrend) {
      L.push(`PRIOR 4 WKS, oldest first (${trendWeeks.map((t) => md(t.monday)).join(', ')})`);
      L.push(`progress ${trendWeeks.map((t) => t.progress).join(' ')}`);
      L.push(`check-ins ${trendWeeks.map((t) => t.checkIns).join(' ')}`);
      L.push(`energy ${trendWeeks.map((t) => t.energy).join(' ')}`);
      L.push(`crunch days ${trendWeeks.map((t) => t.crunch).join(' ')}`);
      L.push(`actions done ${trendWeeks.map((t) => t.actions).join(' ')}`);
      if (!flags.has('activeTrend')) {
        L.push(`active days: ${BURNERS.map((b) => `${BURNER_LABELS[b]} ${trendWeeks.map((t) => t.active[b]).join(' ')}`).join(', ')}`);
      }
      if (energyType && !flags.has('energyType')) L.push(`energy by day type, last 5 wks: ${energyType}`);
    } else {
      L.push('PRIOR 4 WKS: not enough history yet');
    }
    if (chronic.length) {
      L.push(`OFF TRACK 3+ of last 5 wk ends: ${chronic.map((x) => `${prep(c, x.title, CAP.title) || 'Untitled goal'} ${x.n}/5`).join(', ')}`);
    }
    if (repeatMisses.length && !flags.has('repeatMisses')) {
      const items = repeatMisses
        .map((x) => ({ t: prep(c, x.text, CAP.miss), n: x.n }))
        .filter((x) => x.t)
        .slice(0, 3)
        .map((x) => `${x.t} ${x.n} of 4 wks`);
      L.push(items.length ? `REPEAT misses: ${items.join('; ')}` : null);
    }
    if (changes.length) {
      const groups = new Map<LocalDate, string[]>();
      for (const ch of changes) {
        const reason = prep(c, ch.reason, CAP.reason);
        const entry = `${BURNER_LABELS[ch.burner]} ${INTENT_LABELS[ch.from]} to ${INTENT_LABELS[ch.to]}${reason ? ` (${reason})` : ''}`;
        groups.set(ch.localDate, [...(groups.get(ch.localDate) ?? []), entry]);
      }
      L.push(`INTENT changes: ${[...groups].map(([d, es]) => `${md(d)}: ${es.join('; ')}`).join('; ')}`);
    }
    L.push(ASK_WEEKLY + (crunchInfo.crunchAhead ? ASK_WEEKLY_CRUNCH : '') + ASK_WEEKLY_END);
    return assemble(L);
  };

  return buildPacket({
    kind: 'weekly',
    scope: weekStart,
    terms,
    render,
    ladder: WEEKLY_LADDER,
    privateNotes: privateNotesOf(i.input.logs, i.input.touchpoints),
    publicTexts,
    privateOmitted,
  });
}

// =============================================================================================
// Mid-quarter check-in

export function buildCheckinPacket(i: CheckinPacketInput): BuiltPacket {
  const terms = i.input.settings?.sensitiveTerms ?? [];
  const input = scrubInput(i.input);
  const { quarter } = input;
  const today = input.today;
  const span = quarterSpan(quarter.id);

  // ---- selectPacketData
  const dash = computeDashboard(input);
  const crunchSet = crunchDateSet(input.crunch, today);
  const byGoal = logsByGoal(input.logs, today);
  const daysTotal = diffDays(span.start, span.end) + 1;
  const dayN = Math.min(daysTotal, Math.max(1, diffDays(span.start, today) + 1));
  const daysLeft = daysTotal - dayN;

  const window14 = dateRange(addDays(today, -13), today);
  const stampDates = new Set(checkInStamps(input, today).map((s) => s.localDate));
  const trend = energyTrend(input.energy, today);
  const nowLine =
    `NOW: progress ${dash.progressScore}, consistency ${dash.consistencyScore}, streak ${dash.streak.current}d, ` +
    `check-ins 14d ${window14.filter((d) => stampDates.has(d)).length}/14, crunch days 14d ${window14.filter((d) => crunchSet.has(d)).length}, ` +
    `energy 7d ${numOrDash(trend.recent)} (prior 7d ${numOrDash(trend.prior)})`;

  const nonCrunch7 = dateRange(addDays(today, -6), today).filter((d) => !crunchSet.has(d)).length;
  const history = [...(quarter.intentHistory ?? [])].filter((ch) => ch.localDate <= today).sort(byDateThenAt);
  const burnerLine = {} as Record<BurnerId, string>;
  const goalViews = {} as Record<BurnerId, GoalView[]>;
  for (const b of BURNERS) {
    const s = dash.burners[b];
    const change = history.filter((ch) => ch.burner === b).pop();
    const expected7 = (RECENT_ACTIVE_DAYS[s.intent] * nonCrunch7) / 7;
    const ago = s.lastActive ? diffDays(s.lastActive, today) : null;
    const lastActive = ago === null ? 'never' : ago <= 0 ? 'today' : `${ago}d ago`;
    burnerLine[b] =
      `${b.toUpperCase()} (${INTENT_LABELS[s.intent]}${change ? `, was ${INTENT_LABELS[change.from]} until ${md(change.localDate)}` : ''}): ` +
      `${STATUS_TEXT[s.status]}${s.pace !== null ? `, pace ${pct(s.pace)}` : ''}, active 7d ${s.activeDaysLast7}/${num(expected7)}, last active ${lastActive}`;
    goalViews[b] = s.goals.map(({ goal, progress }) => checkinGoalView(goal, progress, byGoal.get(goal.id) ?? [], today, span.start));
  }

  const energyType = energyByTypeText(
    input.energy,
    crunchSet,
    healthLogDays(input.goals, input.logs),
    span.start < today ? span.start : today,
    today,
  );

  const lastSunday = weekday(today) === 6 ? today : addDays(startOfWeek(today), -1);
  const doneIds = new Set(BURNERS.flatMap((b) => dash.burners[b].goals.filter((g) => g.progress.complete).map((g) => g.goal.id)));
  const chronic = chronicGoals(
    BURNERS.flatMap((b) => dash.burners[b].goals.map((g) => g.goal)),
    byGoal,
    quarter,
    input.crunch,
    [0, 1, 2, 3].map((k) => addDays(lastSunday, -7 * k)),
    (g) => doneIds.has(g.id),
  );

  const lastReview = liveReviews(i.reviews)
    .filter((r) => r.weekStart <= today)
    .sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1))[0];
  const reviewActions: WeeklyAction[] = lastReview
    ? (input.actions ?? []).filter((a) => !a.deleted && a.weekStart === addDays(lastReview.weekStart, 7)).sort((a, b) => a.order - b.order)
    : [];

  const privateOmitted = privateInWindow(i.input.logs, i.input.touchpoints, addDays(today, -13), today);
  const publicTexts = [
    ...goalTexts(i.input.goals),
    ...noteTexts(input.logs, input.touchpoints),
    ...reviewTexts(liveReviews(i.reviews)),
    ...(input.actions ?? []).map((a) => a.text),
    ...(input.crunch ?? []).map((p) => p.label ?? ''),
    ...quarterTexts([quarter]),
    ...input.people.map((p) => p.name),
    ...profileTexts(i.profile),
    i.question ?? '',
  ];

  // ---- render
  const render: Render = (flags, trimmed, t) => {
    const c = newCtx(t);
    const L: Line[] = [];
    const theme = prep(c, quarter.theme, CAP.theme);
    const question = prep(c, i.question, CAP.question);
    L.push(
      `TYPE: mid-quarter check-in, ${dowOf(today)} ${md(today)}, ${today.slice(0, 4)} | ${qLabel(quarter.id)} day ${dayN}/${daysTotal}, ` +
        `${daysLeft}d left${theme ? ` | theme: ${theme}` : ''}`,
    );
    L.push(trimmedLine(trimmed));
    L.push(`ME: ${meLine(c, i.profile, flags.has('meShort') ? CAP.aboutMeShort : CAP.aboutMe) || 'not written yet'}`);
    const crunchText = checkinCrunchText(c, input.crunch, today);
    L.push(crunchText && `CRUNCH: ${crunchText}`);
    L.push(nowLine);
    for (const b of BURNERS) {
      L.push(burnerLine[b]);
      if (!goalViews[b].length) L.push('no goals set');
      for (const g of goalViews[b]) L.push(goalLine(c, g, flags));
      if (b === 'family' || b === 'friends') {
        const text = checkinPeopleText(c, peopleOf(input.people, b), input.touchpoints, today);
        L.push(text && `people: ${text}`);
      }
    }
    if (energyType && !flags.has('energyType')) L.push(`energy by day type, quarter so far: ${energyType}`);
    if (chronic.length) {
      L.push(`OFF TRACK 3+ of last 4 wk ends: ${chronic.map((x) => `${prep(c, x.title, CAP.title) || 'Untitled goal'} ${x.n}/4`).join(', ')}`);
    }
    if (lastReview && !flags.has('lastReview')) {
      const focus = prep(c, lastReview.focus, CAP.focus) || 'none';
      const misses = flags.has('reviewMisses') ? null : joinPrepped(c, lastReview.misses, CAP.miss, MAX_WINS) || 'none';
      const done = reviewActions.filter((a) => a.done).length;
      const open = reviewActions.filter((a) => !a.done).map((a) => actionText(c, a)).filter(Boolean).join('; ');
      L.push(
        `LAST REVIEW wk of ${md(lastReview.weekStart)}: focus: ${focus}${misses === null ? '' : `; misses: ${misses}`}; ` +
          `actions ${reviewActions.length ? `${done}/${reviewActions.length}` : 'none set'}${open ? `; open: ${open}` : ''}`,
      );
    }
    L.push(question && `MY QUESTION: ${question}`);
    L.push(askCheckin(daysLeft, !!question));
    return assemble(L);
  };

  return buildPacket({
    kind: 'checkin',
    scope: today,
    terms,
    render,
    ladder: CHECKIN_LADDER,
    privateNotes: privateNotesOf(i.input.logs, i.input.touchpoints),
    publicTexts,
    privateOmitted,
  });
}

// =============================================================================================
// Quarter setup

const CHECK_WORDS: Record<string, string> = { no_why: 'no why', no_when_where: 'no when', no_target: 'no target' };

function intentPath(q: Quarter, b: BurnerId): string {
  const changes = (q.intentHistory ?? []).filter((c) => c.burner === b).sort(byDateThenAt);
  if (!changes.length) return INTENT_LABELS[q.intents?.[b] ?? 'steady'];
  return INTENT_LABELS[changes[0].from] + changes.map((c) => ` to ${INTENT_LABELS[c.to]} ${md(c.localDate)}`).join('');
}

function sameSteps(draft: Goal, src: Goal): boolean {
  const srcTitles = new Set((src.milestones ?? []).map((m) => normText(m.title)));
  return (draft.milestones ?? []).every((m) => srcTitles.has(normText(m.title)));
}

function isModified(draft: Goal, src: Goal): boolean {
  return (
    normText(draft.title) !== normText(src.title) ||
    draft.type !== src.type ||
    (draft.target ?? null) !== (src.target ?? null) ||
    normText(draft.unit ?? '') !== normText(src.unit ?? '') ||
    (draft.type === 'habit' && (draft.habitPeriod ?? 'week') !== (src.habitPeriod ?? 'week')) ||
    (draft.type === 'milestone' && !sameSteps(draft, src))
  );
}

const MONTH_DAYS = 365.25 / 12;

/** What the LAST Q lines print about the quarter just closed. */
interface PrevInfo {
  label: string;
  line: string;
  burners: Record<BurnerId, { path: string; goals: { title: string; pct: number; grade?: string; decision?: string }[] }>;
  topWins: string[];
  repeat: { text: string; n: number }[];
}

export function buildQuarterSetupPacket(i: QuarterSetupPacketInput): BuiltPacket {
  const terms = i.settings?.sensitiveTerms ?? [];
  const dq = i.draftQuarter;
  const span = quarterSpan(dq.id);
  const year = yearOf(dq.id);
  const today = i.today;
  const logs = scrubLogs(i.logs);
  const goalsAll = (i.goalsAll ?? []).filter((g) => g);
  const prev: HighlightsInput | null = i.previous
    ? { ...i.previous, logs: scrubLogs(i.previous.logs), touchpoints: scrubTouchpoints(i.previous.touchpoints) }
    : null;

  // ---- selectPacketData
  const weeks = Math.round((diffDays(span.start, span.end) + 1) / 7);

  let prevInfo: PrevInfo | null = null;
  if (prev) {
    const h = quarterHighlights(prev);
    const pspan = quarterSpan(prev.quarter.id);
    const asOf = prev.today < pspan.end ? prev.today : pspan.end;
    const pdash = computeDashboard({ ...prev, quarterStart: pspan.start, today: asOf });
    const label = qLabel(prev.quarter.id, year);
    const burners = {} as PrevInfo['burners'];
    for (const b of BURNERS) {
      burners[b] = {
        path: intentPath(prev.quarter, b),
        goals: pdash.burners[b].goals.map(({ goal, progress }) => ({
          title: goal.title,
          pct: Math.round(progress.fraction * 100),
          grade: goal.grade,
          decision: goal.closeDecision,
        })),
      };
    }
    const qReviews = liveReviews(i.reviews?.length ? i.reviews : prev.reviews).filter(
      (r) => r.weekStart >= pspan.start && r.weekStart <= pspan.end,
    );
    const counts = new Map<string, { text: string; n: number }>();
    for (const r of [...qReviews].sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1))) {
      const seen = new Set<string>();
      for (const m of r.misses ?? []) {
        const key = normText(m);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const cur = counts.get(key);
        counts.set(key, { text: cur?.text ?? m, n: (cur?.n ?? 0) + 1 });
      }
    }
    const repeat = [...counts.values()].filter((x) => x.n >= 3).sort((a, b) => b.n - a.n);
    prevInfo = {
      label,
      line:
        `LAST Q ${label}: progress ${h.progressScore}, consistency ${h.consistencyScore}, check-ins ${h.checkInDays}/${h.daysInQuarter}d, ` +
        `best streak ${h.longestStreak}d, energy ${numOrDash(h.energyAvg)}, goals done ${h.goalsDone}/${h.goalsTotal}`,
      burners,
      topWins: h.topWins.map((w) => w.text).slice(0, 5),
      repeat,
    };
  }

  // Crunch history: up to 4 most recent earlier quarters with data, newest first.
  const crunchAll = crunchDateSet(i.crunch ?? [], today);
  const crunchDaysIn = (qid: QuarterId) => {
    const s = quarterSpan(qid);
    let n = 0;
    for (const d of crunchAll) if (d >= s.start && d <= s.end) n++;
    return n;
  };
  const earlierIds = new Set<QuarterId>(
    [...(i.quarters ?? []).filter((q) => q && !q.deleted).map((q) => q.id), ...(prev ? [prev.quarter.id] : [])].filter((id) => id < dq.id),
  );
  const pastQuarters = [...earlierIds]
    .sort((a, b) => (a < b ? 1 : -1))
    .map((id) => ({ id, days: crunchDaysIn(id) }))
    .filter((q) => q.days > 0 || goalsAll.some((g) => !g.deleted && g.quarterId === q.id))
    .slice(0, 4);
  const planned = liveCrunch(i.crunch).filter((p) => p.start >= span.start && p.start <= span.end);

  // LOAD: draft habits per week vs habit logs per week last quarter, split by crunch weeks.
  const drafts = (i.draftGoals ?? []).filter((g) => g && !g.deleted);
  const draftHabits = drafts.filter((g) => g.type === 'habit');
  let load: string | null = null;
  if (draftHabits.length) {
    const perWeek = draftHabits.reduce((s, g) => s + (g.target ?? 0) * (g.habitPeriod === 'month' ? 12 / 52 : 1), 0);
    const lastQ = prev?.quarter.id ?? prevQuarterId(dq.id);
    const lspan = quarterSpan(lastQ);
    const lastDay = lspan.end < today ? lspan.end : today;
    const habitIds = new Set(goalsAll.filter((g) => !g.deleted && g.type === 'habit' && g.quarterId === lastQ).map((g) => g.id));
    const rates = { normal: { logs: 0, days: 0 }, crunch: { logs: 0, days: 0 } };
    if (habitIds.size && lspan.start <= lastDay) {
      const perDay = new Map<LocalDate, number>();
      for (const l of logs) {
        if (l.deleted || !habitIds.has(l.goalId) || l.localDate < lspan.start || l.localDate > lastDay) continue;
        perDay.set(l.localDate, (perDay.get(l.localDate) ?? 0) + l.value);
      }
      for (let w = startOfWeek(lspan.start); w <= lastDay; w = addDays(w, 7)) {
        const a = w < lspan.start ? lspan.start : w;
        const e = addDays(w, 6) > lastDay ? lastDay : addDays(w, 6);
        const days = dateRange(a, e);
        const bucket = days.filter((d) => crunchAll.has(d)).length >= 2 ? rates.crunch : rates.normal;
        bucket.days += days.length;
        bucket.logs += days.reduce((s, d) => s + (perDay.get(d) ?? 0), 0);
      }
    }
    const rate = (r: { logs: number; days: number }) => (r.days ? `${num((r.logs / r.days) * 7)}/wk` : '-');
    load = `LOAD: draft habits ${num(perWeek)}/wk; last Q logged ${rate(rates.normal)} in normal wks, ${rate(rates.crunch)} in crunch wks`;
  }

  // Draft goals per burner, with carry-over context.
  const counts = Object.fromEntries(BURNERS.map((b) => [b, drafts.filter((g) => g.burner === b).length])) as Record<BurnerId, number>;
  const intents = Object.fromEntries(BURNERS.map((b) => [b, dq.intents?.[b] ?? 'steady'])) as Record<BurnerId, Intent>;
  const draftByBurner = Object.fromEntries(
    BURNERS.map((b) => [b, drafts.filter((g) => g.burner === b).sort((x, y) => x.order - y.order)]),
  ) as Record<BurnerId, Goal[]>;
  const logsBySrc = logsByGoal(logs, today);
  const carryInfo = new Map<Goal, { modified: boolean; pct: number; grade?: string; rate: string }>();
  for (const g of drafts) {
    const src = g.carriedFromId ? goalsAll.find((x) => x.id === g.carriedFromId) : undefined;
    if (!src) continue;
    const srcEnd = src.deadline < today ? src.deadline : today;
    const srcLogs = (logsBySrc.get(src.id) ?? []).filter((l) => l.localDate <= srcEnd);
    const actual = actualFor(src, srcLogs);
    const required = requiredFor(src);
    const fraction = required > 0 ? Math.min(1, actual / required) : 0;
    const srcDays = Math.max(1, diffDays(src.startDate, srcEnd) + 1);
    let rate = '';
    if (g.type === 'number' && src.type === 'number') {
      const last = `last Q ${num(actual / (srcDays / 7))}/wk`;
      rate = g.target && g.target > 0 ? `needs ${num(g.target / (windowDays(g) / 7))}/wk, ${last}` : last;
    } else if (g.type === 'habit' && src.type === 'habit') {
      rate = g.habitPeriod === 'month' ? `last Q ${num(actual / (srcDays / MONTH_DAYS))}/mo` : `last Q ${num(actual / (srcDays / 7))}/wk`;
    }
    carryInfo.set(g, { modified: isModified(g, src), pct: Math.round(fraction * 100), grade: src.grade, rate });
  }

  // App checks: checkGoal() warnings in plain words.
  const goalChecks: { title: string; words: string[] }[] = [];
  const lowFlagged = new Set<BurnerId>();
  for (const b of BURNERS) {
    for (const g of draftByBurner[b]) {
      const warnings = checkGoal(
        { burner: g.burner, type: g.type, title: g.title, why: g.why, whenWhere: g.whenWhere, target: g.target, milestones: g.milestones },
        intents,
        counts,
      );
      const words = warnings.map((w) => CHECK_WORDS[w.code]).filter((w): w is string => !!w);
      if (words.length) goalChecks.push({ title: g.title, words });
      if (warnings.some((w) => w.code === 'low_outweighs_high')) lowFlagged.add(b);
    }
  }
  const highs = BURNERS.filter((b) => intents[b] === 'high').sort((a, b) => counts[b] - counts[a]);
  const burnerChecks = [...lowFlagged].map((b) =>
    highs.length
      ? `${BURNER_LABELS[b]} (Low) has ${counts[b]} goals vs ${BURNER_LABELS[highs[0]]} (High) ${counts[highs[0]]}`
      : `${BURNER_LABELS[b]} (Low) has ${counts[b]} goals`,
  );

  const publicTexts = [
    ...goalTexts(drafts),
    ...goalTexts(goalsAll),
    ...goalTexts(prev?.goals),
    ...noteTexts(logs, []),
    ...(prev ? noteTexts(prev.logs, prev.touchpoints) : []),
    ...reviewTexts(liveReviews(i.reviews)),
    ...reviewTexts(liveReviews(prev?.reviews)),
    ...(i.crunch ?? []).map((p) => p.label ?? ''),
    ...quarterTexts([dq, ...(i.quarters ?? []), prev?.quarter]),
    ...(prev?.people ?? []).map((p) => p.name),
    ...profileTexts(i.profile),
  ];

  // ---- render
  const render: Render = (flags, trimmed, t) => {
    const c = newCtx(t);
    const L: Line[] = [];
    const theme = prep(c, dq.theme, CAP.theme);
    L.push(
      `TYPE: quarter setup, ${qLabel(dq.id)} ${year}, ${md(span.start)} to ${md(span.end)} (${weeks} wks)${theme ? ` | theme: ${theme}` : ''}`,
    );
    L.push(trimmedLine(trimmed));
    L.push(`ME: ${meLine(c, i.profile, flags.has('meShort') ? CAP.aboutMeShort : CAP.aboutMe) || 'not written yet'}`);
    if (prevInfo) {
      L.push(prevInfo.line);
      for (const b of BURNERS) {
        const pb = prevInfo.burners[b];
        const items = pb.goals.map(
          (g) =>
            `${prep(c, g.title, CAP.title) || 'Untitled goal'}${flags.has('pct') ? '' : ` ${g.pct}%`} ${g.grade ?? '-'} ${g.decision ?? 'undecided'}`,
        );
        L.push(`LAST ${b.toUpperCase()} (${pb.path}): ${items.length ? items.join('; ') : 'no goals'}`);
      }
      if (!flags.has('wins')) {
        const wins = joinPrepped(c, prevInfo.topWins, CAP.win, 5);
        L.push(wins && `LAST Q WINS: ${wins}`);
      }
      if (!flags.has('repeatMisses') && prevInfo.repeat.length) {
        const items = prevInfo.repeat
          .map((x) => ({ t: prep(c, x.text, CAP.miss), n: x.n }))
          .filter((x) => x.t)
          .slice(0, 3)
          .map((x) => `${x.t} ${x.n} wks`);
        L.push(items.length ? `REPEAT misses last Q: ${items.join('; ')}` : null);
      }
    } else {
      L.push('LAST Q: first quarter in the app');
    }
    const history = pastQuarters.length ? pastQuarters.map((q) => `${qLabel(q.id, year)} ${q.days}d`).join(', ') : 'none logged';
    const plannedText = planned
      .map((p) => crunchItemText(c, { text: p.end ? spanShort(p.start, p.end) : `${md(p.start)}, no end`, label: p.label }))
      .join('; ');
    L.push(`CRUNCH history: ${history}${plannedText ? `. Planned: ${plannedText}` : ''}`);
    L.push(load);
    for (const b of BURNERS) {
      const gs = draftByBurner[b];
      L.push(`DRAFT ${b.toUpperCase()} (${INTENT_LABELS[intents[b]]}), ${gs.length} ${gs.length === 1 ? 'goal' : 'goals'}:`);
      if (!gs.length) L.push('no goals drafted');
      for (const g of gs) L.push(draftGoalLine(c, g, flags, carryInfo.get(g), span.end));
    }
    const checks = [
      ...goalChecks.map((x) => `${prep(c, x.title, CAP.title) || 'Untitled goal'}: ${x.words.join(', ')}`),
      ...burnerChecks,
    ];
    L.push(checks.length ? `APP CHECKS: ${checks.join('; ')}` : null);
    L.push(ASK_SETUP);
    return assemble(L);
  };

  return buildPacket({
    kind: 'quarter_setup',
    scope: dq.id,
    terms,
    render,
    ladder: SETUP_LADDER,
    privateNotes: [...privateNotesOf(i.logs, []), ...(i.previous ? privateNotesOf(i.previous.logs, i.previous.touchpoints) : [])],
    publicTexts,
    privateOmitted: 0,
  });
}

function draftSpec(c: Ctx, g: Goal, flags: ReadonlySet<string>): string {
  switch (g.type) {
    case 'number':
      return g.target && g.target > 0 ? `target ${num(g.target)}${unitSuffix(c, g.unit)}` : 'NO TARGET';
    case 'habit':
      return g.target && g.target > 0 ? `${num(g.target)}/${g.habitPeriod === 'month' ? 'mo' : 'wk'}` : 'NO TARGET';
    case 'yesno':
      return 'yes/no';
    case 'milestone': {
      const steps = (g.milestones ?? []).map((m) => m.title).filter((t) => sanitize(t));
      if (!steps.length) return 'NO STEPS';
      const shown = flags.has('steps') ? steps.slice(0, 3) : steps;
      const more = steps.length - shown.length;
      return `steps: ${shown.map((t) => prep(c, t, CAP.step)).join(', ')}${more > 0 ? `, +${more} more` : ''}`;
    }
    default:
      return 'NO TARGET';
  }
}

function draftGoalLine(
  c: Ctx,
  g: Goal,
  flags: ReadonlySet<string>,
  carry: { modified: boolean; pct: number; grade?: string; rate: string } | undefined,
  quarterEnd: LocalDate,
): string {
  const title = lineStart(prep(c, g.title, CAP.title)) || 'Untitled goal';
  let s = `${title}: ${draftSpec(c, g, flags)}`;
  if (carry?.rate) s += ` (${carry.rate})`;
  if (carry) s += `, carried${carry.modified ? ' and changed' : ''}, was ${carry.pct}%${carry.grade ? ` ${carry.grade}` : ''}`;
  if (g.deadline && g.deadline !== quarterEnd) s += `, due ${md(g.deadline)}`;
  s += ` | why: ${prep(c, g.why, CAP.why) || 'MISSING'} | when: ${prep(c, g.whenWhere, CAP.when) || 'MISSING'}`;
  return s;
}

// =============================================================================================
// Onboarding

export function buildOnboardingPacket(i: OnboardingPacketInput): BuiltPacket {
  const terms = i.settings?.sensitiveTerms ?? [];
  const profile = i.profile ?? EMPTY_PROFILE_FIELDS;
  const burnerRank: Record<string, number> = { family: 0, friends: 1 };
  const people = (i.people ?? [])
    .filter((p) => p && !p.deleted && sanitize(p.name))
    .sort((a, b) => (burnerRank[a.burner] ?? 2) - (burnerRank[b.burner] ?? 2) || a.order - b.order)
    .slice(0, MAX_ONBOARDING_PEOPLE);

  const render: Render = (_flags, _trimmed, t) => {
    const c = newCtx(t);
    // Redact before renderAboutMeBlock caps each value, so a cap can never leave half a term behind.
    const field = (b: BurnerId, k: 'matters' | 'winning') => prep(c, profile.burners?.[b]?.[k]);
    const prepped: ProfileFields = {
      lifeContext: prep(c, profile.lifeContext),
      burners: {
        family: { matters: field('family', 'matters'), winning: field('family', 'winning') },
        friends: { matters: field('friends', 'matters'), winning: field('friends', 'winning') },
        health: { matters: field('health', 'matters'), winning: field('health', 'winning') },
        work: { matters: field('work', 'matters'), winning: field('work', 'winning') },
      },
      travel: profile.travel ?? null,
      crunch: prep(c, profile.crunch),
    };
    const block = renderAboutMeBlock(prepped).split('\n');
    const anySkipped = block.some((l) => /^[A-Za-z][A-Za-z ]*:$/.test(l));
    // "Family: Mom every week, Dad every 2 weeks | Friends: Jake every 2 weeks"
    const keyPeople = (['family', 'friends'] as const)
      .map((b) => {
        const names = people
          .filter((p) => p.burner === b)
          .map((p) => `${prep(c, p.name, CAP.name)} ${cadenceLabel(p.cadenceDays).toLowerCase()}`);
        return names.length ? `${BURNER_LABELS[b]}: ${names.join(', ')}` : '';
      })
      .filter(Boolean)
      .join(' | ');
    const L: Line[] = [
      'TYPE: onboarding, refine my About me profile',
      ...block,
      anySkipped && SKIPPED_LINE,
      keyPeople && `KEY PEOPLE: ${keyPeople}`,
      ASK_ONBOARDING,
    ];
    return assemble(L);
  };

  return buildPacket({
    kind: 'onboarding',
    scope: 'profile',
    terms,
    render,
    ladder: [],
    privateNotes: [],
    publicTexts: [...profileTexts(profile), ...people.map((p) => p.name)],
    privateOmitted: 0,
  });
}
