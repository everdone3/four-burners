// About me profile: the ABOUT ME block (rendered into packets, returned revised by Claude),
// one-line summaries for the ME line, and parsing key people from interview answers.
// CONTRACT below; implementation per docs/coach-design.md ("Onboarding interview" sections).
import { CADENCE_OPTIONS } from '../people';
import { BURNERS, type BurnerId, type BurnerProfile, type ProfileFields, type TravelRhythm } from '../types';
import { PACKET_END, PACKET_HEADER } from './constants';

export const TRAVEL_LABELS: Record<TravelRhythm, string> = {
  rare: 'Rarely',
  monthly: 'A trip or two a month',
  weekly: 'Most weeks',
  mostly_away: 'More away than home',
};

export interface AboutMeParse {
  /** True when at least 3 labeled fields were recognized. */
  ok: boolean;
  /** Only fields that are present, non-empty, and differ from current. Never wipes a field. */
  patch: Partial<ProfileFields>;
  /** Dotted field paths that changed, e.g. "lifeContext", "burners.family.winning", "travel". */
  changedFields: string[];
  warnings: string[];
  /** True when the pasted text is the packet itself rather than Claude's reply. */
  isPacketEcho: boolean;
}

export interface PersonDraft {
  name: string;
  burner: 'family' | 'friends';
  cadenceDays: number;
  include: boolean;
}

// ---------------------------------------------------------------------------------------------
// Field table: label order, dotted path, and parse aliases (label lowercased, non-letters removed).

type TextKey = 'matters' | 'winning';

interface FieldDef {
  label: string;
  path: string;
  kind: 'text' | 'travel';
  top?: 'lifeContext' | 'crunch';
  burner?: BurnerId;
  key?: TextKey;
  aliases: string[];
}

const FIELDS: FieldDef[] = [
  { label: 'Life', path: 'lifeContext', kind: 'text', top: 'lifeContext', aliases: ['life', 'lifecontext', 'liferightnow'] },
  {
    label: 'Family people',
    path: 'burners.family.matters',
    kind: 'text',
    burner: 'family',
    key: 'matters',
    aliases: ['familypeople', 'familywhomatters', 'familywhomatter', 'family'],
  },
  {
    label: 'Family win',
    path: 'burners.family.winning',
    kind: 'text',
    burner: 'family',
    key: 'winning',
    aliases: ['familywin', 'familywinning', 'familywins', 'winningathome'],
  },
  {
    label: 'Friends people',
    path: 'burners.friends.matters',
    kind: 'text',
    burner: 'friends',
    key: 'matters',
    aliases: ['friendspeople', 'friendswhomatter', 'friendswhomatters', 'friends'],
  },
  {
    label: 'Friends win',
    path: 'burners.friends.winning',
    kind: 'text',
    burner: 'friends',
    key: 'winning',
    aliases: ['friendswin', 'friendswinning', 'friendswins'],
  },
  { label: 'Health focus', path: 'burners.health.matters', kind: 'text', burner: 'health', key: 'matters', aliases: ['healthfocus', 'health'] },
  {
    label: 'Health win',
    path: 'burners.health.winning',
    kind: 'text',
    burner: 'health',
    key: 'winning',
    aliases: ['healthwin', 'healthwinning', 'healthwins'],
  },
  {
    label: 'Work focus',
    path: 'burners.work.matters',
    kind: 'text',
    burner: 'work',
    key: 'matters',
    aliases: ['workfocus', 'work', 'workbigpicture'],
  },
  { label: 'Work win', path: 'burners.work.winning', kind: 'text', burner: 'work', key: 'winning', aliases: ['workwin', 'workwinning', 'workwins'] },
  // 'rhythm' and 'workrhythm': the onboarding template's ASK asks for a "Rhythm" line.
  { label: 'Travel', path: 'travel', kind: 'travel', aliases: ['travel', 'timeontheroad', 'travelrhythm', 'rhythm', 'workrhythm'] },
  { label: 'Crunch', path: 'crunch', kind: 'text', top: 'crunch', aliases: ['crunch', 'crunchperiods', 'dealseason', 'crunchpattern'] },
];

const ALIAS = new Map<string, FieldDef>();
for (const f of FIELDS) for (const a of f.aliases) ALIAS.set(a, f);

function getText(p: ProfileFields | undefined, f: FieldDef): string {
  if (!p) return '';
  if (f.top) return p[f.top] ?? '';
  if (f.burner && f.key) return p.burners?.[f.burner]?.[f.key] ?? '';
  return '';
}

// ---------------------------------------------------------------------------------------------
// Text helpers.

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
const NBSP = /[\u00A0\u2007\u202F]/g;
// Small and vertical dash forms (FE58, FE31, FE32) are listed too; NFKC also folds them into em/en dashes.
const DASH_CLASS = '\\u2012\\u2013\\u2014\\u2015\\u2E3A\\u2E3B\\uFE58\\uFE31\\uFE32';
const DASH_BETWEEN_DIGITS = new RegExp(`(\\d)\\s*[${DASH_CLASS}]+\\s*(?=\\d)`, 'g');
const DASH_ANY = new RegExp(`\\s*[${DASH_CLASS}]+\\s*`, 'g');

/**
 * NFKC (design "field prep"), smart punctuation to ASCII (quotes, ellipsis), invisible characters removed.
 * NFKC runs first so lookalike dash forms become real dashes here and are sanitized, rather than
 * turning into em dashes later when redact() normalizes the packet.
 */
function asciiPunct(s: string): string {
  return s
    .normalize('NFKC')
    .replace(ZERO_WIDTH, '')
    .replace(NBSP, ' ')
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/\u2026/g, '...');
}

/** Em and en dashes never reach a packet: "3 (dash) 4" becomes "3 to 4", any other dash a comma. */
function sanitizeDashes(s: string): string {
  return s
    .replace(DASH_BETWEEN_DIGITS, '$1 to ')
    .replace(DASH_ANY, ', ')
    .replace(/,(?:\s*,)+/g, ',')
    .replace(/([.!?;:]),\s/g, '$1 ')
    .replace(/\s+,/g, ',')
    .replace(/^\s*,\s*/, '')
    .replace(/\s*,\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** One clean line: ASCII punctuation, whitespace runs collapsed, dashes sanitized. */
function oneLine(s: string | undefined | null): string {
  return sanitizeDashes(collapse(asciiPunct(s ?? '')));
}

/** Cut at a word boundary so the result (including "...") is at most `cap` characters. */
function capAtWord(s: string, cap: number): string {
  if (s.length <= cap) return s;
  const room = Math.max(1, cap - 3);
  let cut = s.slice(0, room);
  if (s[room] !== ' ') {
    const sp = cut.lastIndexOf(' ');
    if (sp >= room * 0.5) cut = cut.slice(0, sp);
  }
  cut = cut.replace(/[\s,;:.|]+$/, '');
  return `${cut}...`;
}

const RENDER_CAP = 400;
const PARSE_CAP = 600;

function renderValue(s: string | undefined | null): string {
  return capAtWord(oneLine(s), RENDER_CAP);
}

// ---------------------------------------------------------------------------------------------
// Rendering.

export function travelLabel(t: TravelRhythm | null): string {
  return t ? (TRAVEL_LABELS[t] ?? '') : '';
}

/** "ABOUT ME\nLife: ...\n...\nEND ABOUT ME" with the 11 labeled lines. */
export function renderAboutMeBlock(p: ProfileFields): string {
  const lines = ['ABOUT ME'];
  for (const f of FIELDS) {
    const v = f.kind === 'travel' ? travelLabel(p?.travel ?? null) : renderValue(getText(p, f));
    lines.push(v ? `${f.label}: ${v}` : `${f.label}:`);
  }
  lines.push('END ABOUT ME');
  return lines.join('\n');
}

/** One line for the ME: field in weekly/check-in/setup packets, capped (default 450) at a word boundary. */
export function profileLine(p: ProfileFields | undefined, cap = 450): string {
  if (!p) return '';
  const parts: [string, string][] = [
    ['Life', p.lifeContext],
    ['Family', p.burners?.family?.winning],
    ['Friends', p.burners?.friends?.winning],
    ['Health', p.burners?.health?.winning],
    ['Work', p.burners?.work?.winning],
    ['Travel', travelLabel(p.travel ?? null)],
    ['Crunch', p.crunch],
  ].map(([label, v]) => [label as string, oneLine(v)]);
  const line = parts
    .filter(([, v]) => v)
    .map(([label, v]) => `${label}: ${v}`)
    .join(' | ');
  return line ? capAtWord(line, cap) : '';
}

export function profileIsEmpty(p: ProfileFields | undefined): boolean {
  if (!p) return true;
  if (p.travel) return false;
  return FIELDS.every((f) => f.kind === 'travel' || !getText(p, f).trim());
}

// ---------------------------------------------------------------------------------------------
// Parsing a coach reply.

const START_KEYS = new Set(['aboutme', 'aboutmeblock', 'revisedaboutme', 'updatedaboutme', 'aboutmerevised', 'aboutmeupdated']);
const END_KEYS = new Set(['endaboutme', 'endofaboutme', 'endaboutmeblock', 'aboutmeend']);
const PACKET_END_KEY = PACKET_END.toLowerCase().replace(/[^a-z]/g, '');
const OLD_PACKET_HEADER = 'FOUR BURNERS COACHING PACKET';

const BULLET = /^\s*(?:[-*+]\s+|[\u2022\u2023\u25E6\u25AA\u25CF\u2043\u2219]\s*|\d{1,2}[.)]\s*)/;
const QUOTE_PREFIX = /^\s*(?:>\s*)+/;
const RULE_LINE = /^\s*(?:[-*_]\s*){3,}$/;
const REDACTED_TOKEN = /[[({<]\s*redacted[^\])}>]*[\])}>]/gi;
const REDACTED_WORD = /\bredacted\b/i;

const EMPTY_TOKENS = new Set([
  'none',
  'n/a',
  'na',
  'n.a',
  'nil',
  'null',
  'unknown',
  'not provided',
  'tbd',
  'tba',
  'tbc',
  'blank',
  'empty',
  'skipped',
  'unanswered',
  'not given',
  'not specified',
  'not set',
  '-',
  '--',
]);

/**
 * Placeholder phrasings that mean "nothing here" or "keep what I had". Each must match the whole value,
 * so a real sentence that merely starts this way ("None of my family lives nearby") is kept.
 */
const EMPTY_PATTERNS: RegExp[] = [
  /^[-_.?\s]+$/,
  /^(?:none|nothing|no\s+answer|no\s+response|no\s+info(?:rmation)?|no\s+details?)(?:\s+(?:given|provided|specified|listed|mentioned|yet|here|shared|noted|stated|so\s+far))?$/,
  /^not\s+(?:yet\s+)?(?:provided|given|specified|mentioned|answered|shared|stated|set|listed|known|applicable|available|discussed|included|filled(?:\s+in)?|captured|covered|described)(?:\s+yet)?$/,
  /^(?:left\s+(?:blank|empty)|question\s+skipped|skipped(?:\s+(?:this|it|question))?|(?:you|i)\s+skipped(?:\s+(?:this|it|that))?|(?:you|i)\s+left\s+(?:this|it|that)\s+(?:blank|empty|out))(?:\s+for\s+now)?$/,
  /^(?:unchanged|no\s+changes?|not\s+changed|no\s+update|same|same\s+as\s+(?:before|above|current|original|yours|now|you\s+(?:had|wrote|said))|as\s+(?:before|is|above|written)|(?:keep|kept)(?:\s+as\s+is)?|keep\s+(?:yours|current|existing))$/,
  /^to\s+be\s+(?:decided|determined|confirmed|added)$/,
];

/** A trailing or leading editor's note such as "(unchanged)" or "[revised]" that is not part of the value. */
const ANNOTATION = String.raw`[([](?:unchanged|same|same as before|no change|no changes|new|revised|updated|edited|tightened|added|kept|kept as is|as before|your words)[)\]]`;
const ANNOTATION_TRAIL = new RegExp(`\\s*${ANNOTATION}\\s*$`, 'i');
const ANNOTATION_LEAD = new RegExp(`^\\s*${ANNOTATION}\\s*`, 'i');

function normalizeLines(text: string): string[] {
  return (text ?? '')
    .normalize('NFKC')
    .replace(/\r\n?|[\u2028\u2029\u0085]/g, '\n')
    .replace(ZERO_WIDTH, '')
    .replace(NBSP, ' ')
    .replace(/[\uFF1A\uFE55\uFE13\u2236]/g, ':')
    .split('\n')
    .filter((l) => !/^\s*(?:```|~~~)/.test(l));
}

/** Marker key: markdown and a trailing parenthetical stripped, lowercased, letters only. */
function markerKey(line: string): string {
  const s = line
    .replace(/[*_#>`~]/g, '')
    .replace(/\s*\([^)]*\)[\s:.]*$/, '')
    .trim();
  return s.toLowerCase().replace(/[^a-z]/g, '');
}

function stripLinePrefix(line: string): string {
  return line.replace(QUOTE_PREFIX, '').replace(/^\s*#{1,6}\s+/, '').replace(BULLET, '');
}

const FIELD_BY_PATH = new Map(FIELDS.map((f) => [f.path, f]));

/** First word of a longer label to the field (top-level) or burner it names. */
const LABEL_HEAD: Record<string, string> = {
  life: 'lifeContext',
  family: 'family',
  friends: 'friends',
  friend: 'friends',
  friendship: 'friends',
  friendships: 'friends',
  health: 'health',
  work: 'work',
  career: 'work',
  travel: 'travel',
  traveling: 'travel',
  travelling: 'travel',
  crunch: 'crunch',
  deal: 'crunch',
  deals: 'crunch',
};
const WIN_WORDS = new Set(['win', 'wins', 'winning', 'winner', 'goal', 'goals', 'success']);
/** Burner named inside "Winning at home", "Winning with friends", "Win at work". */
const WIN_TARGET: Record<string, BurnerId> = { home: 'family', family: 'family', friends: 'friends', friend: 'friends', health: 'health', work: 'work' };
/**
 * Words allowed after the head word of a longer label ("Health focus areas", "Work at 30,000 feet").
 * Anything else ("Family dinners: four a week") is text, not a label, so it stays a continuation.
 */
const LABEL_VOCAB = new Set([
  ...WIN_WORDS,
  'people', 'person', 'who', 'matter', 'matters', 'focus', 'focuses', 'area', 'areas', 'role', 'big', 'picture',
  'context', 'right', 'now', 'covers', 'honestly', 'overview', 'circle', 'key', 'important', 'looks', 'look', 'like',
  'at', 'with', 'for', 'of', 'the', 'my', 'in', 'this', 'quarter', 'rhythm', 'pattern', 'patterns', 'period',
  'periods', 'season', 'seasons', 'frequency', 'feet', 'on', 'road', 'current', 'summary', 'what',
]);
const LABEL_LEAD = new Set(['my', 'your', 'the', 'revised', 'updated', 'new', 'current', 'tightened', 'final', 'key']);

/** Field for a label: exact alias first (doc step 5), then a short label that starts with a field word. */
function labelField(raw: string): FieldDef | null {
  const cleaned = raw.replace(/[*_`~]/g, '').replace(/\([^)]*\)\s*$/, '');
  const exact = ALIAS.get(cleaned.toLowerCase().replace(/[^a-z]/g, ''));
  if (exact) return exact;
  let words = cleaned.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  while (words.length && LABEL_LEAD.has(words[0])) words = words.slice(1);
  if (!words.length || words.length > 5) return null;
  const again = ALIAS.get(words.join(''));
  if (again) return again;
  if (WIN_WORDS.has(words[0])) {
    const b = words.slice(1).map((w) => WIN_TARGET[w]).find(Boolean);
    return b ? (FIELD_BY_PATH.get(`burners.${b}.winning`) ?? null) : null;
  }
  const head = LABEL_HEAD[words[0]];
  const rest = words.slice(1);
  if (!head || !rest.every((w) => LABEL_VOCAB.has(w))) return null;
  if (head === 'lifeContext' || head === 'travel' || head === 'crunch') return FIELD_BY_PATH.get(head) ?? null;
  const key = rest.some((w) => WIN_WORDS.has(w)) ? 'winning' : 'matters';
  return FIELD_BY_PATH.get(`burners.${head}.${key}`) ?? null;
}

interface LabelHit {
  field: FieldDef;
  rest: string;
  /**
   * A markdown heading label ("## Life"): its value may follow a blank line. A bold label alone on its
   * line ("**Family win**") takes the next lines but still ends at a blank line, so closing prose after
   * an empty last field ("**Crunch**", blank, "Hope this helps!") is never swallowed.
   */
  heading: boolean;
}

const DASH_SEPARATOR = new RegExp(`^(.{1,40}?)(?:\\s+-{1,2}\\s+|\\s*[${DASH_CLASS}]\\s*)(.*)$`);

/** "Label: value", or "Label - value" when the label is capitalized or marked up. */
function parseLabelLine(line: string): LabelHit | null {
  const s = stripLinePrefix(line);
  const idx = s.indexOf(':');
  if (idx > 0 && idx <= 40) {
    const field = labelField(s.slice(0, idx));
    if (field) return { field, rest: s.slice(idx + 1), heading: false };
  }
  const m = DASH_SEPARATOR.exec(s);
  if (m && /^[\s*_]*\p{Lu}/u.test(m[1])) {
    const field = labelField(m[1]);
    if (field) return { field, rest: m[2], heading: false };
  }
  return null;
}

/** A label alone on its line: a markdown heading, a bold or italic label, or an exact label in title case. */
function headingLabel(line: string): LabelHit | null {
  const s = line.replace(QUOTE_PREFIX, '').replace(BULLET, '').trim();
  const hashed = /^#{1,6}\s/.test(s);
  const marked = hashed || /^(\*\*|__|\*|_)[^*_]+?:?\1:?$/.test(s);
  const inner = s
    .replace(/^#{1,6}\s+/, '')
    .replace(/[*_`]/g, '')
    .trim()
    .replace(/\s*:$/, '')
    .trim();
  // "**Life: The context**" is a bolded label line with a value, not a bare heading.
  if (!inner || inner.length > 40 || inner.includes(':')) return null;
  let field: FieldDef | null | undefined;
  if (marked) field = labelField(inner);
  // A plain "Crunch:" is a colon label with an empty value (a blank line after it still ends it).
  else if (/^\p{Lu}/u.test(inner) && !s.endsWith(':')) field = FIELDS.find((f) => f.label.toLowerCase() === inner.toLowerCase());
  return field ? { field, rest: '', heading: hashed } : null;
}

function stripInlineMarkdown(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, '$1')
    .replace(/(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])/g, '$1')
    .replace(/^[\s*_]+/, '')
    .replace(/[\s*_]+$/, '');
}

function stripWrappingQuotes(s: string): string {
  const m = /^"([^"]*)"$/.exec(s) ?? /^'([^']*)'$/.exec(s);
  return m ? m[1].trim() : s;
}

function isEmptyToken(s: string): boolean {
  const raw = s.trim();
  if (/^<[^>]*>$/.test(raw)) return true;
  // Peel wrapping brackets, quotes, emphasis, and trailing punctuation: "[none]", "(not provided).", "*Unchanged*".
  let k = raw.toLowerCase();
  for (let prev = ''; prev !== k; ) {
    prev = k;
    k = k.replace(/^[\s"'*_`([{]+/, '').replace(/[\s"'*_`)\]}.!,;:]+$/, '');
  }
  return !k || EMPTY_TOKENS.has(k) || EMPTY_PATTERNS.some((re) => re.test(k));
}

/** Value cleaning (doc step 6): markdown, quotes, whitespace, dashes, empty words, editor's notes, 600 cap. */
function cleanValue(raw: string): string {
  let s = collapse(stripInlineMarkdown(asciiPunct(raw ?? '')));
  s = stripWrappingQuotes(s);
  s = sanitizeDashes(s);
  if (isEmptyToken(s)) return '';
  s = s.replace(ANNOTATION_TRAIL, '').replace(ANNOTATION_LEAD, '').trim();
  if (isEmptyToken(s)) return '';
  return capAtWord(s, PARSE_CAP);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `value` equals `current` with each redaction token standing in for some original text. */
function matchesWithRedaction(value: string, current: string): boolean {
  if (!current) return false;
  const parts = value.split(REDACTED_TOKEN);
  if (parts.length < 2) return false;
  const re = new RegExp(`^${parts.map(escapeRegex).join('.+?')}$`, 'is');
  return re.test(current);
}

const TRAVEL_RULES: [RegExp, TravelRhythm][] = [
  // Phrased about being home, which inverts the keywords below: "rarely home" is mostly away.
  [/\b(?:rarely|hardly(?:\s+ever)?|seldom|barely|never|almost\s+never|not\s+often)\s+(?:at\s+)?home\b/, 'mostly_away'],
  [/\b(?:mostly|usually|always|almost\s+always|nearly\s+always|generally)\s+(?:at\s+)?home\b|\bhome\s+(?:most|almost\s+every|nearly\s+every)\b/, 'rare'],
  [/\bno\s+travel\b|\b(?:don'?t|do\s+not|never)\s+travel\b|^never$/, 'rare'],
  [/more away|mostly away|away more|away most|constant|always/, 'mostly_away'],
  [/every other week|every (?:two|2) weeks|bi-?weekly|twice a month/, 'monthly'],
  [/most weeks|weekly|every week|each week|\b(?:a|per|each) week\b|frequent/, 'weekly'],
  [/month|trip or two|few trips|couple (?:of )?trips/, 'monthly'],
  [/rare|seldom|hardly|almost never|mostly home|barely|\b(?:a|per|each) (?:year|quarter)\b|yearly|quarterly|annual/, 'rare'],
];

/** The template's option list echoed back ("Rarely | A trip or two a month | ...") is not a choice. */
function isTravelTemplate(v: string): boolean {
  const s = v.toLowerCase();
  return s.includes('|') && Object.values(TRAVEL_LABELS).filter((l) => s.includes(l.toLowerCase())).length >= 2;
}

function travelFromText(v: string): TravelRhythm | null {
  const s = collapse(v.toLowerCase().replace(/_/g, ' ')).replace(/[.!]+$/, '');
  for (const [t, label] of Object.entries(TRAVEL_LABELS) as [TravelRhythm, string][]) {
    if (s === label.toLowerCase() || s === t.replace(/_/g, ' ')) return t;
  }
  for (const [re, t] of TRAVEL_RULES) if (re.test(s)) return t;
  return null;
}

interface Block {
  from: number;
  to: number;
  ended: 'end' | 'start' | 'stop' | 'eof';
}

interface FieldScan {
  values: Map<FieldDef, string>;
  /** Index of the last line that fed a field value, or -1. */
  lastLine: number;
  /** The last continuation line and the field value before it, so a cut-off fragment can be undone. */
  lastCont: { line: number; field: FieldDef; before: string } | null;
}

function isBlankLine(line: string): boolean {
  const bare = line.replace(QUOTE_PREFIX, '');
  return !bare.trim() || RULE_LINE.test(bare);
}

/** Doc step 5: labeled lines, continuation lines, first occurrence of a label wins. */
function scanFields(lines: readonly string[], from: number, to: number): FieldScan {
  const values = new Map<FieldDef, string>();
  let cur: FieldDef | null = null;
  let closed = false;
  // A heading label ("## Life") has its value on the following lines, possibly after a blank line.
  let awaiting = false;
  let lastLine = -1;
  let lastCont: FieldScan['lastCont'] = null;
  for (let i = from; i < to; i++) {
    const line = lines[i];
    if (isBlankLine(line)) {
      // A blank line ends a value, so prose after the block never leaks into the last field.
      if (!awaiting) closed = true;
      continue;
    }
    const k = markerKey(line);
    if (k.startsWith('suggestedaction') || END_KEYS.has(k) || k === PACKET_END_KEY) break;
    const hit = headingLabel(line) ?? parseLabelLine(line);
    if (hit) {
      if (values.has(hit.field)) {
        // A repeated label (for example a "- Health: ..." action after the block) is not the profile.
        cur = null;
        awaiting = false;
        continue;
      }
      values.set(hit.field, hit.rest);
      cur = hit.field;
      closed = false;
      awaiting = hit.heading;
      lastLine = i;
      lastCont = null;
      continue;
    }
    if (cur && !closed) {
      const bulleted = BULLET.test(line.replace(QUOTE_PREFIX, ''));
      const text = stripLinePrefix(line).trim();
      const prev = (values.get(cur) ?? '').trim();
      const sep = !prev ? '' : bulleted && !/[.;,:!?]$/.test(stripInlineMarkdown(prev)) ? '; ' : ' ';
      values.set(cur, prev + sep + text);
      awaiting = false;
      lastLine = i;
      lastCont = { line: i, field: cur, before: prev };
    }
  }
  return { values, lastLine, lastCont };
}

const LABEL_KEYS = FIELDS.flatMap((f) => [f.label.toLowerCase().replace(/[^a-z]/g, ''), ...f.aliases]);

/** A cut-off reply that ends mid-label ("Work wi") must not glue that fragment onto the previous field. */
function dropCutLabelFragment(lines: readonly string[], scan: FieldScan): void {
  const c = scan.lastCont;
  if (!c || c.line !== scan.lastLine) return;
  const text = stripLinePrefix(lines[c.line]).trim();
  if (text.includes(':')) return;
  const key = text.toLowerCase().replace(/[^a-z]/g, '');
  if (key && LABEL_KEYS.some((l) => l.length > key.length && l.startsWith(key))) scan.values.set(c.field, c.before);
}

/** Paragraphs (runs of non-blank lines) within [from, to). */
function paragraphs(lines: readonly string[], from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (let i = from; i < to; i++) {
    if (isBlankLine(lines[i])) {
      if (start >= 0) out.push([start, i]);
      start = -1;
    } else if (start < 0) start = i;
  }
  if (start >= 0) out.push([start, to]);
  return out;
}

function findBlocks(lines: readonly string[], from: number, to: number): Block[] {
  const blocks: Block[] = [];
  let open: number | null = null;
  for (let i = from; i < to; i++) {
    const k = markerKey(lines[i]);
    if (START_KEYS.has(k)) {
      if (open !== null) blocks.push({ from: open + 1, to: i, ended: 'start' });
      open = i;
    } else if (END_KEYS.has(k)) {
      if (open !== null) blocks.push({ from: open + 1, to: i, ended: 'end' });
      open = null;
    } else if (open !== null && (k.startsWith('suggestedaction') || k === PACKET_END_KEY)) {
      blocks.push({ from: open + 1, to: i, ended: 'stop' });
      open = null;
    }
  }
  if (open !== null) blocks.push({ from: open + 1, to, ended: 'eof' });
  return blocks;
}

function lastNonEmpty(lines: readonly string[], from: number, to: number): number {
  for (let i = to - 1; i >= from; i--) if (lines[i].trim()) return i;
  return -1;
}

interface Choice {
  scan: FieldScan;
  warnings: string[];
}

/** Doc step 4: the last marked block with 3+ labels, or 5+ unmarked label lines. */
function chooseFields(lines: readonly string[], from: number, to: number): Choice | null {
  const blocks = findBlocks(lines, from, to);
  for (let b = blocks.length - 1; b >= 0; b--) {
    const block = blocks[b];
    const scan = scanFields(lines, block.from, block.to);
    if (scan.values.size < 3) continue;
    const warnings: string[] = [];
    if (block.ended === 'eof' && scan.lastLine === lastNonEmpty(lines, block.from, block.to)) {
      warnings.push('Reply may be cut off.');
      dropCutLabelFragment(lines, scan);
    }
    return { scan, warnings };
  }
  // No markers. Prefer the last paragraph that holds 5+ labels, so a gaps list written before the
  // profile ("- Family: your win has no number.") cannot claim fields; then fall back to the whole text.
  const unmarked = ['Markers missing, check before replacing.'];
  const paras = paragraphs(lines, from, to);
  for (let p = paras.length - 1; p >= 0; p--) {
    const scan = scanFields(lines, paras[p][0], paras[p][1]);
    if (scan.values.size >= 5) return { scan, warnings: unmarked };
  }
  const scan = scanFields(lines, from, to);
  if (scan.values.size >= 5) return { scan, warnings: unmarked };
  return null;
}

function emptyParse(isPacketEcho = false): AboutMeParse {
  return { ok: false, patch: {}, changedFields: [], warnings: [], isPacketEcho };
}

/** Parse a coach reply containing a revised ABOUT ME block. */
export function parseAboutMe(text: string, current: ProfileFields): AboutMeParse {
  const lines = normalizeLines(text);
  const upper = lines.join('\n').toUpperCase();
  const to = lines.length;

  // Step 1: packet guard. With a packet header present, only text after END OF PACKET can be a reply.
  let choice: Choice | null;
  if (upper.includes(PACKET_HEADER.toUpperCase()) || upper.includes(OLD_PACKET_HEADER)) {
    let endIdx = -1;
    for (let i = to - 1; i >= 0; i--) {
      if (markerKey(lines[i]) === PACKET_END_KEY) {
        endIdx = i;
        break;
      }
    }
    choice = endIdx < 0 ? null : chooseFields(lines, endIdx + 1, to);
    if (!choice) return emptyParse(true);
  } else {
    choice = chooseFields(lines, 0, to);
  }
  if (!choice) return emptyParse();

  const warnings = [...choice.warnings];
  const patch: Partial<ProfileFields> = {};
  const burners: Partial<Record<BurnerId, Partial<BurnerProfile>>> = {};
  const changedFields: string[] = [];

  for (const f of FIELDS) {
    const raw = choice.scan.values.get(f);
    if (raw === undefined) continue;
    const v = cleanValue(raw);
    if (!v) continue;

    if (f.kind === 'travel') {
      if (isTravelTemplate(v)) continue;
      const t = travelFromText(v);
      if (!t) {
        warnings.push(`Could not read Travel ("${capAtWord(v, 40)}"), kept your current answer.`);
        continue;
      }
      if (t !== (current?.travel ?? null)) {
        patch.travel = t;
        changedFields.push(f.path);
      }
      continue;
    }

    const cur = getText(current, f);
    const same = [cleanValue(cur), cleanValue(renderValue(cur))];
    if (same.includes(v)) continue;
    if (same.some((c) => matchesWithRedaction(v, c))) continue;
    if (REDACTED_WORD.test(v)) {
      warnings.push(`Kept your wording for ${f.label} (the coach saw a redacted name).`);
      continue;
    }
    if (f.top) patch[f.top] = v;
    else if (f.burner && f.key) burners[f.burner] = { ...burners[f.burner], [f.key]: v };
    changedFields.push(f.path);
  }

  // Only changed burners and keys are present; applyAboutMePatch deep-merges them.
  if (Object.keys(burners).length) patch.burners = burners as Record<BurnerId, BurnerProfile>;

  return { ok: true, patch, changedFields, warnings, isPacketEcho: false };
}

/** Apply a parse patch onto current fields (deep merge for burners). */
export function applyAboutMePatch(current: ProfileFields, patch: Partial<ProfileFields>): ProfileFields {
  const pb = (patch.burners ?? {}) as Partial<Record<BurnerId, Partial<BurnerProfile>>>;
  const burners = {} as Record<BurnerId, BurnerProfile>;
  for (const b of BURNERS) {
    const base = current.burners?.[b] ?? { matters: '', winning: '' };
    const over = pb[b] ?? {};
    burners[b] = {
      matters: over.matters !== undefined ? over.matters : base.matters,
      winning: over.winning !== undefined ? over.winning : base.winning,
    };
  }
  return {
    ...current,
    lifeContext: patch.lifeContext !== undefined ? patch.lifeContext : current.lifeContext,
    burners,
    travel: patch.travel !== undefined ? patch.travel : current.travel,
    crunch: patch.crunch !== undefined ? patch.crunch : current.crunch,
  };
}

// ---------------------------------------------------------------------------------------------
// Key people from spoken answers.

const CADENCE_DAYS = CADENCE_OPTIONS.map((o) => o.days);

/** Nearest CADENCE_OPTIONS value (ties go to the more frequent one). */
function snapCadence(days: number): number {
  let best = CADENCE_DAYS[0];
  let bestDiff = Infinity;
  for (const d of CADENCE_DAYS) {
    const diff = Math.abs(d - days);
    if (diff < bestDiff) {
      best = d;
      bestDiff = diff;
    }
  }
  return best;
}

const NUM_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  twelve: 12,
  other: 2,
  couple: 2,
  few: 3,
  several: 3,
  once: 1,
  twice: 2,
  thrice: 3,
};

const NUM = String.raw`(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|twelve|(?:a\s+)?couple(?:\s+of)?|(?:a\s+)?few|several|other)`;
const NUMR = String.raw`${NUM}(?:\s*(?:-|to|or)\s*${NUM})?`;
const UNIT_DAYS: Record<string, number> = { day: 1, week: 7, wk: 7, weekend: 7, month: 30, mo: 30, mth: 30, quarter: 90, year: 365, yr: 365 };
const ADVERB_UNIT: Record<string, string> = { daily: 'day', weekly: 'week', monthly: 'month', quarterly: 'quarter', yearly: 'year', annually: 'year' };

function numValue(text: string): number {
  const parts = text
    .toLowerCase()
    .split(/\s*(?:-|\bto\b|\bor\b)\s*/)
    .filter(Boolean);
  const vals = parts.map((p) => {
    const w = p.replace(/\b(?:a|of|times?)\b/g, '').trim();
    if (/^\d/.test(w)) return parseFloat(w);
    return NUM_WORDS[w] ?? 1;
  });
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function unitDays(unit: string): number {
  return UNIT_DAYS[unit.toLowerCase().replace(/s$/, '')] ?? 7;
}

// "once" is a lead-in too: "once every two weeks" is the same cadence as "every two weeks".
const PRE = String.raw`(?:\b(?:at\s+least|at\s+most|about|around|roughly|approximately|ideally|maybe|probably|usually|normally|hopefully|preferably|like|say|once)\s+)*`;
const SUF = String.raw`(?:\s+(?:or\s+(?:so|two|three|more)|at\s+least|at\s+most|ideally|if\s+possible|if\s+I\s+can|each|apiece|minimum))*`;
const WEEKDAY = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)';

interface CadenceRule {
  re: RegExp;
  days: (m: RegExpExecArray) => number;
}

function rule(core: string, days: (m: RegExpExecArray) => number): CadenceRule {
  return { re: new RegExp(`${PRE}(?:${core})${SUF}\\b`, 'gi'), days };
}

const CADENCE_RULES: CadenceRule[] = [
  // every two weeks, every other week, every couple of months, every few days, every 2-3 weeks, every 2 wks
  rule(
    String.raw`\b(?:every|each)\s+(${NUMR})\s+(days?|weeks?|wks?|months?|mos?|mths?|quarters?|years?|yrs?)`,
    (m) => numValue(m[1]) * unitDays(m[2]),
  ),
  // twice a month, a few times a year, once a week, 3 times per week, 2x a month
  rule(
    String.raw`\b(once|twice|thrice|(?:${NUMR})\s*(?:times|x))\s+(?:a|an|per|each|every)\s+(day|week|month|quarter|year)`,
    (m) => unitDays(m[2]) / numValue(m[1]),
  ),
  // twice weekly
  rule(
    String.raw`\b(once|twice|thrice|(?:${NUMR})\s*(?:times|x))\s+(daily|weekly|monthly|quarterly|yearly|annually)`,
    (m) => unitDays(ADVERB_UNIT[m[2].toLowerCase()]) / numValue(m[1]),
  ),
  // every week, every weekend, each month, every single day
  rule(String.raw`\b(?:every|each)\s+(?:single\s+)?(day|week|weekend|month|quarter|year)`, (m) => unitDays(m[1])),
  // every Sunday, on Sundays, Sundays, weekends
  rule(String.raw`\b(?:every|each|on)\s+${WEEKDAY}s?\b|\b${WEEKDAY}s\b|\b(?:on\s+)?(?:the\s+)?weekends`, () => 7),
  rule(String.raw`\b(?:bi-?weekly|fortnightly)`, () => 14),
  rule(String.raw`\bbi-?monthly`, () => 60),
  rule(String.raw`\b(daily|nightly|weekly|monthly|quarterly|yearly|annually)`, (m) =>
    m[1].toLowerCase() === 'nightly' ? 1 : unitDays(ADVERB_UNIT[m[1].toLowerCase()]),
  ),
  rule(String.raw`\b(?:most\s+days|all\s+the\s+time|constantly|as\s+often\s+as\s+(?:possible|I\s+can))`, () => 1),
];

interface CadenceHit {
  start: number;
  end: number;
  days: number;
}

function findCadence(text: string): CadenceHit[] {
  const hits: CadenceHit[] = [];
  for (const r of CADENCE_RULES) {
    r.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = r.re.exec(text))) {
      if (!m[0]) {
        r.re.lastIndex++;
        continue;
      }
      hits.push({ start: m.index, end: m.index + m[0].length, days: r.days(m) });
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const out: CadenceHit[] = [];
  for (const h of hits) {
    const last = out[out.length - 1];
    if (last && h.start < last.end) continue;
    out.push(h);
  }
  return out;
}

const RELATION_NOUNS = new Set([
  'mom', 'mum', 'mother', 'dad', 'father', 'parent', 'parents', 'sister', 'sisters', 'brother', 'brothers',
  'sibling', 'siblings', 'wife', 'husband', 'spouse', 'partner', 'son', 'sons', 'daughter', 'daughters',
  'kid', 'kids', 'child', 'children', 'boy', 'boys', 'girl', 'girls', 'grandma', 'grandmother', 'grandpa',
  'grandfather', 'grandparents', 'granddaughter', 'grandson', 'grandkids', 'grandchildren', 'aunt', 'aunts',
  'uncle', 'uncles', 'cousin', 'cousins', 'niece', 'nieces', 'nephew', 'nephews', 'stepmom', 'stepdad',
  'stepmother', 'stepfather', 'stepson', 'stepdaughter', 'stepbrother', 'stepsister', 'fiance', 'fiancee',
  'girlfriend', 'boyfriend', 'friend', 'friends', 'buddy', 'pal', 'roommate', 'neighbor', 'neighbour',
  'mentor', 'godfather', 'godmother', 'godson', 'goddaughter', 'twin', 'twins', 'folks', 'bestie',
]);

/** Plural relation words that still read well singular in a label ("my sisters Katie and Anna"). */
const SINGULAR: Record<string, string> = {
  sisters: 'sister',
  brothers: 'brother',
  sons: 'son',
  daughters: 'daughter',
  cousins: 'cousin',
  nieces: 'niece',
  nephews: 'nephew',
  twins: 'twin',
  friends: 'friend',
  aunts: 'aunt',
  uncles: 'uncle',
};
/** Plural group words dropped from the label when names follow ("my kids Maya and Luke"). */
const PLURAL_GROUPS = new Set(['kids', 'children', 'boys', 'girls', 'parents', 'siblings', 'grandkids', 'grandchildren', 'grandparents', 'folks', 'in-laws']);

/** Words that are both a relation and how people name someone ("Mom, my sister" is two people). */
const TITLE_NAMES = new Set(['mom', 'mum', 'mother', 'dad', 'father', 'grandma', 'grandpa', 'grandmother', 'grandfather', 'nana', 'papa', 'granny', 'mommy', 'daddy', 'ma', 'pa', 'pop', 'pops']);

function isRelationNoun(w: string): boolean {
  const k = w.toLowerCase().replace(/'s$/, '');
  return RELATION_NOUNS.has(k) || /-in-laws?$/.test(k);
}

function capFirst(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** A dictated lowercase name word: "mary-kate" -> "Mary-Kate", "o'brien" -> "O'Brien". */
function capNameWord(w: string): string {
  return capFirst(w)
    .replace(/-(\p{Ll})/gu, (_, c: string) => `-${c.toUpperCase()}`)
    .replace(/^(\p{L})'(\p{Ll})/u, (_, a: string, c: string) => `${a}'${c.toUpperCase()}`);
}

function titleCase(s: string): string {
  return s
    .split(' ')
    .map((w) => capNameWord(w))
    .join(' ');
}

function formatPlainName(s: string): string {
  if (s !== s.toLowerCase()) return capFirst(s);
  return /^the\s/i.test(s) ? capFirst(s) : titleCase(s);
}

const LEAD_FILLER =
  /^(?:and|also|plus|with|then|or|probably|maybe|definitely|especially|ideally|at\s+least|about|around|roughly|like|i\s+guess|i\s+think|oh|um|uh|well|so|too|just|honestly|basically|really|mostly|obviously|of\s+course|okay|ok|alright|yeah|yes|first(?:\s+off|\s+of\s+all)?|next|lastly|finally|there(?:'s|\s+is|\s+are))\b[\s,]*/i;
const TRAIL_FILLER = /[\s,]*\b(?:too|as\s+well|also|at\s+least|or\s+so|ideally|if\s+possible|if\s+i\s+can|i\s+guess|i\s+think|i\s+hope|hopefully|each|both|please)$/i;
// Trailing words about how, not who: "call my mom more often", "my mom on the phone". Trimmed from
// name candidates only; a leftover keeps the user's full wording.
const TRAIL_HOW =
  /[\s,]*\b(?:more(?:\s+often)?|more\s+than\s+i\s+do(?:\s+now)?|often|regularly|again|a\s+lot|soon|in\s+person|on\s+the\s+phone|by\s+phone|over\s+the\s+phone|on\s+facetime)$/i;
const LEAD_VERB =
  /^(?:(?:i|we)(?:'d|\s+would)\s+(?:really\s+)?(?:like|love)\s+to\s+|(?:i|we)\s+(?:really\s+)?(?:want|need|hope|try|plan|aim|like|love)\s+to\s+)?(?:see|call|visit|text|talk\s+(?:to|with)|catch\s+up\s+with|hang\s+out\s+with|connect\s+with|check\s+in\s+(?:with|on)|spend\s+(?:real\s+|more\s+|quality\s+)?time\s+with|show\s+up\s+for|be\s+there\s+for|stay\s+close\s+(?:to|with)|keep\s+up\s+with)\s+/i;
// The speaker is never one of their own key people ("Sarah and I", "me and Sarah").
const STOP_FRAGMENT = /^(?:(?:each|both|all)(?:\s+of\s+(?:them|us))?|them|everyone|everybody|others|the\s+others|i|me|myself|us|we|ourselves|you)$/i;
const CLOSER =
  /^(?:(?:i\s+think\s+)?that(?:'s|\s+is)\s+(?:it|all|about\s+it)|nobody\s+else|no\s+one\s+else|none|n\/a|nope|no|nothing|not\s+really|not\s+sure)$/i;
// Pronouns and clause openers ("but honestly it slips", "because she moved") start commentary, not names.
const PRONOUN_START =
  /^(?:i|i'm|i'd|i've|we|we're|they|it|it's|that|that's|this|there|those|these|he|she|you|who|what|when|the\s+rest|but|because|cause|though|although|since|if|unless|whenever|while|which|whose|where)\b/i;

const EDGE_PUNCT = /^[\s,;:.!?"'\-)]+|[\s,;:.!?"'\-(]+$/g;

function cleanFragment(raw: string): string {
  // Empty and letterless parentheticals go ("Maya (12)"), and "(my wife)" reads "(wife)".
  let s = raw
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s*\([^()\p{L}]*\)/gu, ' ')
    .replace(/\(\s*(?:my|our)\s+/gi, '(');
  s = collapse(s).replace(EDGE_PUNCT, '');
  let prev = '';
  while (prev !== s) {
    prev = s;
    s = s.replace(LEAD_FILLER, '').replace(TRAIL_FILLER, '');
    s = s.replace(EDGE_PUNCT, '');
  }
  return s;
}

interface RelationResult {
  name: string;
  /** Singular relation to carry onto following names (plural relation like "my sisters"). */
  carry: string | null;
  /** True when the fragment was a bare relation like "my mom" or "my sister". */
  bare: boolean;
  relation: string | null;
}

/**
 * "my sister Katie" -> "Katie (sister)", "my mom" -> "Mom", "my Aunt Linda" -> "Aunt Linda".
 * Someone else's relation carries no label: "his wife Jen" -> "Jen", "her kids" -> "Her kids".
 */
function applyRelation(fragment: string): RelationResult | null {
  const m = /^(my|our|his|her|their)\s+(.+)$/i.exec(fragment);
  if (!m) return null;
  const own = /^(?:my|our)$/i.test(m[1]);
  const words = m[2].split(' ');
  if (/^\p{Lu}/u.test(words[0])) return { name: words.join(' '), carry: null, bare: false, relation: null };
  let k = words.findIndex((w, i) => i > 0 && /^\p{Lu}/u.test(w));
  let nameWords: string[] = [];
  if (k > 0) {
    nameWords = words.slice(k);
  } else {
    k = -1;
    words.forEach((w, i) => {
      if (isRelationNoun(w)) k = i + 1;
    });
    if (k > 0 && k < words.length) nameWords = words.slice(k).map((w) => capNameWord(w));
  }
  if (!own) {
    const name = nameWords.length ? nameWords.join(' ') : capFirst(fragment.toLowerCase());
    return { name, carry: null, bare: false, relation: null };
  }
  if (!nameWords.length) {
    const relation = words.join(' ').toLowerCase();
    return { name: capFirst(relation), carry: null, bare: true, relation };
  }
  const relWords = words.slice(0, k).map((w) => w.toLowerCase());
  const last = relWords[relWords.length - 1];
  const name = nameWords.join(' ');
  if (PLURAL_GROUPS.has(last)) return { name, carry: null, bare: false, relation: null };
  if (SINGULAR[last]) {
    const relation = [...relWords.slice(0, -1), SINGULAR[last]].join(' ');
    return { name: `${name} (${relation})`, carry: relation, bare: false, relation };
  }
  const relation = relWords.join(' ');
  return { name: `${name} (${relation})`, carry: null, bare: false, relation };
}

/** "Katie my sister" -> "Katie (sister)", "Dave my college roommate" -> "Dave (college roommate)". */
function appositiveName(frag: string): string | null {
  const m = /^(.+?)\s+(?:my|our)\s+([a-z][a-z' -]*)$/i.exec(frag);
  if (!m || /^(?:my|our|his|her|their)\s/i.test(frag)) return null;
  const who = m[1];
  const relWords = m[2].toLowerCase().split(' ');
  const last = relWords[relWords.length - 1];
  if (who.split(' ').length > 2 || !isRelationNoun(last)) return null;
  if (TITLE_NAMES.has(who.toLowerCase()) || isRelationNoun(who)) return null;
  const relation = [...relWords.slice(0, -1), SINGULAR[last] ?? last].join(' ');
  return `${formatPlainName(who)} (${relation})`;
}

const SEPARATOR = /(\s*,\s*(?:and\s+|&\s*|plus\s+)?|\s*&\s*|\s+and\s+|\s+plus\s+|\s*\/\s*)/i;

interface SegmentResult {
  drafts: PersonDraft[];
  leftovers: string[];
  cadence: number | null;
}

function parseSegment(text: string, burner: 'family' | 'friends', fallback: number): SegmentResult {
  const hits = findCadence(text);
  const cadence = hits.length ? snapCadence(hits[0].days) : null;
  let names = text;
  for (let i = hits.length - 1; i >= 0; i--) names = `${names.slice(0, hits[i].start)},${names.slice(hits[i].end)}`;
  names = collapse(names.replace(/\(\s*,?\s*\)/g, ',')).replace(/^[\s,;:.!?\-]+|[\s,;:.!?\-]+$/g, '');
  names = names.replace(LEAD_FILLER, '').replace(LEAD_VERB, '');

  const drafts: PersonDraft[] = [];
  const leftovers: string[] = [];
  const pieces = names.split(SEPARATOR);
  let carry: string | null = null;
  let lastPlain: PersonDraft | null = null;
  for (let i = 0; i < pieces.length; i += 2) {
    const sepBefore = i > 0 ? pieces[i - 1] : '';
    const commaOnly = /,/.test(sepBefore) && !/and|&|plus/i.test(sepBefore);
    let frag = cleanFragment(pieces[i] ?? '');
    frag = frag.replace(LEAD_VERB, '');
    if (!frag || !/\p{L}/u.test(frag) || STOP_FRAGMENT.test(frag) || CLOSER.test(frag)) continue;
    let trimmed = frag;
    for (let prev = ''; prev !== trimmed; ) {
      prev = trimmed;
      trimmed = trimmed.replace(TRAIL_HOW, '').replace(EDGE_PUNCT, '');
    }
    if (!trimmed || !/\p{L}/u.test(trimmed)) continue;
    if (PRONOUN_START.test(frag) || trimmed.split(' ').length > 4) {
      leftovers.push(frag);
      lastPlain = null;
      continue;
    }
    frag = trimmed;
    const appositive = appositiveName(frag);
    if (appositive) {
      // "Katie my sister" (dictated without the comma) names one person.
      drafts.push({ name: appositive, burner, cadenceDays: cadence ?? fallback, include: true });
      carry = null;
      lastPlain = null;
      continue;
    }
    const rel = applyRelation(frag);
    if (rel?.bare && commaOnly && lastPlain && rel.relation) {
      // "Katie, my sister" names one person.
      lastPlain.name = `${lastPlain.name} (${rel.relation})`;
      lastPlain = null;
      continue;
    }
    let name: string;
    if (rel) {
      name = rel.name;
      carry = rel.carry;
      lastPlain = null;
    } else {
      name = formatPlainName(frag);
      if (carry && !/\(/.test(name)) name = `${name} (${carry})`;
    }
    const draft: PersonDraft = { name, burner, cadenceDays: cadence ?? fallback, include: true };
    drafts.push(draft);
    const plain = !rel && !/\(/.test(name) && !TITLE_NAMES.has(name.toLowerCase()) && frag.split(' ').length <= 2;
    if (plain) lastPlain = draft;
    else if (!rel) lastPlain = null;
  }
  return { drafts, leftovers, cadence };
}

/** Split a clause at its cadence phrases when it names several groups ("Mom every week, Dad monthly"). */
function segmentsOf(clause: string): string[] {
  const hits = findCadence(clause);
  if (hits.length < 2) return [clause];
  const before = cleanFragment(clause.slice(0, hits[0].start));
  const cuts = /\p{L}/u.test(before) ? hits.slice(0, -1).map((h) => h.end) : hits.slice(1).map((h) => h.start);
  const out: string[] = [];
  let at = 0;
  for (const c of cuts) {
    out.push(clause.slice(at, c));
    at = c;
  }
  out.push(clause.slice(at));
  return out;
}

/** Turn a spoken answer like "Jake, every two weeks. Priya and Marcus, monthly." into people drafts. */
export function parsePeople(text: string, burner: 'family' | 'friends'): { people: PersonDraft[]; leftovers: string[] } {
  const fallback = burner === 'family' ? 7 : 30;
  const prepared = asciiPunct(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/^\s*(?:[-*+\u2022]|\d{1,2}[.)])\s+/gm, '')
    .replace(/\b(Dr|Mr|Mrs|Ms|Mx|St|Jr|Sr|Prof|Rev)\./gi, '$1')
    .replace(new RegExp(`\\s*[${DASH_CLASS}]+\\s*`, 'g'), ', ')
    .replace(/\s+-\s+/g, ', ');
  const clauses = prepared.split(/(?:(?<!\d)\.|\.(?!\d))+|[;!?\n]+/);

  const people: PersonDraft[] = [];
  const leftovers: string[] = [];
  /** Drafts whose cadence was spoken, as opposed to the burner default. */
  const spoken = new Set<PersonDraft>();
  let pendingDefault: PersonDraft[] = [];
  for (const clause of clauses) {
    if (!clause.trim()) continue;
    for (const seg of segmentsOf(clause)) {
      const r = parseSegment(seg, burner, fallback);
      leftovers.push(...r.leftovers);
      if (!r.drafts.length) {
        // "Jake. Every two weeks." A cadence on its own applies to the names just before it.
        if (r.cadence !== null && pendingDefault.length) {
          for (const d of pendingDefault) {
            d.cadenceDays = r.cadence;
            spoken.add(d);
          }
        }
        if (r.cadence !== null || r.leftovers.length) pendingDefault = [];
        continue;
      }
      people.push(...r.drafts);
      if (r.cadence !== null) for (const d of r.drafts) spoken.add(d);
      pendingDefault = r.cadence === null ? r.drafts : [];
    }
  }

  // Merge by name, keeping the first mention's name and position. A spoken cadence beats the default:
  // "Mom, Dad, and Katie. ... Katie every other week." gives Katie 14, not the default 7.
  const byKey = new Map<string, PersonDraft>();
  const unique: PersonDraft[] = [];
  for (const p of people) {
    const key = p.name.replace(/\s*\([^)]*\)\s*$/, '').toLowerCase();
    const first = byKey.get(key);
    if (!first) {
      byKey.set(key, p);
      unique.push(p);
    } else if (!spoken.has(first) && spoken.has(p)) {
      first.cadenceDays = p.cadenceDays;
      spoken.add(first);
    }
  }
  const seenLeft = new Set<string>();
  const uniqueLeft = leftovers.filter((l) => {
    const k = l.toLowerCase();
    if (seenLeft.has(k)) return false;
    seenLeft.add(k);
    return true;
  });
  return { people: unique, leftovers: uniqueLeft };
}
