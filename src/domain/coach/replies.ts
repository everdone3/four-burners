// Parse a pasted coach reply into next week's suggested actions (docs/coach-design.md, "Reply parsing").
// Implements rules R2 to R12, plus the cap of 5 from R13. The UI parts of R1 and R13 live elsewhere.
// Pure and deterministic: no DOM, no clock, never throws. For speed and safety only the last 400 lines are
// parsed, each line is capped in length, and every regex is linear (no nested quantifiers over user text).
import type { BurnerId } from '../types';
import { PACKET_END, PACKET_HEADER } from './constants';

export interface ParsedAction {
  text: string;
  burner?: BurnerId;
}

export interface ParsedReply {
  actions: ParsedAction[];
  /** Where the actions came from. Always 'none' when actions is empty. */
  source: 'heading' | 'weak-heading' | 'fallback' | 'none';
  /** True when the paste is the packet itself (sent back by mistake) rather than Claude's reply. */
  isPacketEcho: boolean;
}

const MAX_ACTIONS = 5;
const MAX_LINES = 400;
const MAX_LINE_CHARS = 2000;
const ECHO_PROSE_MIN = 40;
const HEADING_MAX_WORDS = 8;
const HEADING_MAX_CHARS = 60;
const LONG_HEADING_MAX_WORDS = 20;
const INTRO_LINE_MAX = 120;
const SPLIT_OVER = 90;
const HARD_MAX = 120;
const CUT_AT = 117;

const BURNER_NAMES: readonly BurnerId[] = ['family', 'friends', 'health', 'work'];
const BURNER_SET: ReadonlySet<string> = new Set(BURNER_NAMES);

// ---------------------------------------------------------------------------------------------------
// Character classes and patterns

// One emoji: an Extended_Pictographic (or a flag pair), optional U+FE0F or skin tone, optional ZWJ chain.
const EMOJI =
  '(?:\\p{Extended_Pictographic}|\\p{Regional_Indicator}{2})[\\uFE0F\\u{1F3FB}-\\u{1F3FF}]*' +
  '(?:\\u200D\\p{Extended_Pictographic}[\\uFE0F\\u{1F3FB}-\\u{1F3FF}]*)*';
// Keycap: digit (or # *), optional U+FE0F, then U+20E3.
const KEYCAP = '[0-9#*]\\uFE0F?\\u20E3';

const RE_INVISIBLE = /[\uFEFF\u200B\u2060]/g;
const RE_UNICODE_SPACE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
const RE_FENCE = /^(?:`{3,}|~{3,})[^`~]*$/;
const RE_RULE = /^([-*_])(?: *\1){2,}$/;
const RE_SETEXT = /^={3,}$/;
const RE_QUOTE_MARK = /^ {0,3}> ?/;

// List markers (R3). Bullet glyphs: bullet, middle dot, triangle, white bullet, small squares, circles, squares.
const RE_BULLET = /^([-*+])\s+(\S.*)$/;
const RE_GLYPH = /^([\u2022\u00B7\u2023\u25E6\u25AA\u25AB\u25CF\u25CB\u25A0\u25A1])\uFE0F?\s*(\S.*)$/;
const RE_DASH_ITEM = /^[\u2013\u2014]\s+(\S.*)$/;
const RE_NUMBER = /^([1-9]\d?)[.)]\s+(\S.*)$/;
const RE_PAREN_NUMBER = /^\(([1-9]\d?)\)\s+(\S.*)$/;
const RE_KEYCAP_ITEM = /^([0-9])\uFE0F?\u20E3\s*(\S.*)$/;
// Checkbox glyphs: ballot boxes (empty, checked, crossed), check marks, white heavy check mark.
const RE_CHECK_ITEM = /^[\u2610\u2611\u2612\u2713\u2714\u2705]\uFE0F?\s*(\S.*)$/;
const RE_CHECK_LEAD = /^[\u2610\u2611\u2612\u2713\u2714\u2705]\uFE0F?\s*/;
const RE_BARE_BOX = /^\[[ xX]?\]\s+(\S.*)$/;
const RE_INNER_BOX = /^\[[ xX]?\]\s+/;
const RE_EMOJI_ITEM = new RegExp(`^${EMOJI}\\s+(\\S.*)$`, 'u');
const RE_LEAD_GLYPH = new RegExp(`^(?:${KEYCAP}|${EMOJI})\\s*`, 'u');
/** Secondary glyphs mark a child when they follow a primary marker with no extra indent (rendered copies). */
const SECONDARY_GLYPHS: ReadonlySet<string> = new Set(['\u25E6', '\u25AA', '\u25AB', '\u25CB']);

// Heading keywords (R6). Matched on normalized lowercase text.
const RE_STRONG = /\b(?:actions?|next steps?|to-?dos?|to do|try|moves?|experiments?|quick wins?)\b/;
const RE_WEAK = /\b(?:this week(?:'s)?|next week(?:'s)?|week ahead|coming week|plan)\b/;
// 'last wk' covers the packet's own "LAST WK ACTIONS:" label, so an echoed packet is never read as actions.
const RE_NEGATIVE =
  /\b(?:went well|wins?|miss(?:es|ed)|slipp(?:ed|ing)|noticed|what i see|what i'm seeing|stood out|work(?:ing|ed)|patterns?|questions?|recap|summary|numbers|data|observations?|reflections?|last week|last wk)\b/;
const RE_QUICK_WINS = /\bquick wins?\b/g;

// Item cleaning (R9).
const RE_QUALIFIER = /^(?:bonus|optional|stretch|extra)\s*:\s*/i;
// A burner name may carry the packet's own intent suffix ('FAMILY (High):'), which Claude often mirrors.
const RE_TAG =
  /^(family|friends|health|work)(?:\s*\((?:high|steady|low)\))?(?:\s*[:\uFF1A]|\s+-\s+|\s*(?:[\u2013\u2014\u2015|]|-{2,}))\s*/i;
/** Only a burner label: 'Health', 'FAMILY (High)'. Matched after a trailing colon is trimmed. */
const RE_BURNER_LABEL = /^(family|friends|health|work)(?:\s*\((?:high|steady|low)\))?$/i;
const RE_INTENT_LEAD = /^\((?:high|steady|low)\)/i;
// A clause after a bold lead that gives the reason rather than more of the action.
const RE_RATIONALE = /^\s+(?:so|because|since|which|given|otherwise|it|it's|that's|you're|you'll|you've|they|they're)\b/i;
const RE_TAG_SUFFIX = /\s*[([](family|friends|health|work)[)\]][.;,!]?$/i;
const RE_SUFFIX_ONLY = /^\s*[([](family|friends|health|work)[)\]][.;,!]?\s*$/i;

// Validity (R11): meta lines and headings, matched on actionKey() output.
const META_PATTERNS: readonly RegExp[] = [
  /^(?:(?:your|my|the|some|a few|two|three|four|five|[2-5]) )?(?:(?:suggested|recommended|concrete|next|quick|small|possible|key) )?(?:actions?|action items?|action steps?|steps|next steps?|todos?|to dos?|moves?|experiments?|quick wins?|things to try|ideas|options|suggestions)(?: (?:for )?(?:this|next|the) (?:coming )?week(?: ahead)?)?$/,
  /^(?:pick|choose|select|try|do) (?:one|two|three|any|[1-3])(?: or (?:two|three|[23]))?(?: of (?:these|them|the following|this list))?(?: (?:for|this|next) \w+(?: \w+)?)?$/,
  /^any of (?:these|them|the following)$/,
  /^(?:for )?(?:this|next|the coming|the) weeks?(?: (?:ahead|focus|plan|actions?|moves?))?$/,
  /^here(?:s| are| is)\b/,
  /^burner action$/,
];

const PRONOUNS: ReadonlySet<string> = new Set([
  'you', 'your', "you're", "you've", 'i', "i'm", "i've", 'my', 'we', "we're", 'our', 'it', "it's",
  'this', 'that', "that's", 'these', 'those', 'the', 'there', "there's", 'he', 'she', 'they', "they're", 'their',
]);

/**
 * Subject pronouns that open a remark ('You've got this', 'They're small on purpose'), never an action.
 * Used for emoji-led lines and inline heading remainders, the two weakest item forms.
 */
const REMARK_OPENERS: ReadonlySet<string> = new Set([
  'you', "you're", "you've", "you'll", 'i', "i'm", "i've", "i'll", "i'd", 'we', "we're", "we've", "we'll",
  'it', "it's", 'they', "they're", "that's", "there's",
]);

const ABBREVIATIONS: ReadonlySet<string> = new Set(['dr', 'mr', 'mrs', 'ms', 'st', 'vs', 'e.g', 'i.e', 'a.m', 'p.m']);

// ---------------------------------------------------------------------------------------------------
// Types

type Family = 'bullet' | 'number' | 'checkbox' | 'emoji';
type Tier = 'strong' | 'weak';

interface Item {
  indent: number;
  family: Family;
  /** Marker glyph: the bullet character, 'n' for numbers, 'box' for checkboxes, 'emoji'. */
  glyph: string;
  num?: number;
  content: string;
  /** Emoji-led item that belongs to a run of 2 or more emoji-led lines. */
  emojiRun?: boolean;
}

type Line =
  | { kind: 'blank' }
  | { kind: 'rule' }
  | { kind: 'text'; indent: number; text: string }
  | { kind: 'item'; item: Item }
  | { kind: 'emoji'; indent: number; text: string; item: Item };

interface NormLine {
  text: string;
  rule: boolean;
}

interface HeadingCandidate {
  tier: Tier;
  /** True when the form alone qualifies it (':' ending, '#', fully wrapped, or a prefix before ':'). */
  standalone: boolean;
  /** Text after the colon on the same line (prefix form only). */
  inline?: string;
}

interface LineHeading {
  cand: HeadingCandidate | null;
  /** A NEGATIVE heading-shaped line: never a heading, and it blocks heading ownership. */
  blocker: boolean;
}

interface Block {
  start: number;
  items: Item[];
  inlineParts?: string[];
  minIndent: number;
  firstFamily: Family;
  baseFamily: Family;
  lastNum?: number;
  owner?: Tier;
}

interface Cleaned {
  text: string;
  burner?: BurnerId;
  endsColon: boolean;
  isLabel: boolean;
  labelText: string;
}

interface Flat {
  text: string;
  burner?: BurnerId;
}

interface Evaluated {
  flat: Flat[];
  actions: ParsedAction[];
}

// ---------------------------------------------------------------------------------------------------
// Small string helpers (manual loops where a regex anchored only at the end could backtrack)

function trimEndChars(s: string, chars: string): string {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1])) end--;
  return s.slice(0, end);
}

function trimStartChars(s: string, chars: string): string {
  let i = 0;
  while (i < s.length && chars.includes(s[i])) i++;
  return s.slice(i);
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function straightenQuotes(s: string): string {
  return s.replace(/[\u2018\u2019\u02BC]/g, "'").replace(/[\u201C\u201D]/g, '"');
}

function toBurner(s: string): BurnerId | undefined {
  const k = s.toLowerCase();
  return BURNER_SET.has(k) ? (k as BurnerId) : undefined;
}

/** The burner when the text is only a burner label ('Health', 'Family:', 'FAMILY (High)'). */
function burnerLabel(s: string): BurnerId | undefined {
  const m = RE_BURNER_LABEL.exec(trimEndChars(s.trim(), ':\uFF1A '));
  return m ? toBurner(m[1]) : undefined;
}

// ---------------------------------------------------------------------------------------------------
// R2. Normalize

function normalizeLine(raw: string): NormLine {
  let s = raw.length > MAX_LINE_CHARS ? raw.slice(0, MAX_LINE_CHARS) : raw;
  s = s.replace(RE_INVISIBLE, '').replace(RE_UNICODE_SPACE, ' ').replace(/\t/g, '    ').trimEnd();
  for (let k = 0; k < 8 && RE_QUOTE_MARK.test(s); k++) s = s.replace(RE_QUOTE_MARK, '');
  const t = s.trim();
  if (RE_FENCE.test(t)) return { text: '', rule: false };
  if (RE_RULE.test(t)) return { text: '', rule: true };
  // A setext underline ('=====') is not content; the heading line above it still counts.
  if (RE_SETEXT.test(t)) return { text: '', rule: false };
  return { text: s.trimEnd(), rule: false };
}

function startsWithHeader(raw: readonly string[]): boolean {
  for (const r of raw) {
    const t = normalizeLine(r).text.trim();
    if (t) return t.startsWith(PACKET_HEADER);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------
// R3. List-item lines

function listItem(indent: number, family: Family, glyph: string, content: string, num?: number): Item {
  // After a bullet or number marker, one optional checkbox is removed. Checked or not, it is offered.
  const c = family === 'bullet' || family === 'number' ? content.replace(RE_INNER_BOX, '') : content;
  return num === undefined ? { indent, family, glyph, content: c } : { indent, family, glyph, num, content: c };
}

function parseMarker(body: string, indent: number): Item | null {
  let m: RegExpExecArray | null;
  if ((m = RE_BULLET.exec(body))) return listItem(indent, 'bullet', m[1], m[2]);
  if ((m = RE_GLYPH.exec(body))) return listItem(indent, 'bullet', m[1], m[2]);
  if ((m = RE_DASH_ITEM.exec(body))) return listItem(indent, 'bullet', '-', m[1]);
  if ((m = RE_NUMBER.exec(body)) || (m = RE_PAREN_NUMBER.exec(body)) || (m = RE_KEYCAP_ITEM.exec(body))) {
    return listItem(indent, 'number', 'n', m[2], Number(m[1]));
  }
  if ((m = RE_CHECK_ITEM.exec(body)) || (m = RE_BARE_BOX.exec(body))) return listItem(indent, 'checkbox', 'box', m[1]);
  if ((m = RE_EMOJI_ITEM.exec(body))) return listItem(indent, 'emoji', 'emoji', m[1]);
  return null;
}

function classify(nl: NormLine): Line {
  if (nl.rule) return { kind: 'rule' };
  const body = nl.text.trimStart();
  if (!body) return { kind: 'blank' };
  const indent = nl.text.length - body.length;
  const item = parseMarker(body, indent);
  if (!item) return { kind: 'text', indent, text: body };
  if (item.family !== 'emoji') return { kind: 'item', item };
  // An emoji-led lead-in ending with ':' is a heading or intro line, never an item.
  if (/[:\uFF1A]$/.test(item.content)) return { kind: 'text', indent, text: body };
  return { kind: 'emoji', indent, text: body, item };
}

// ---------------------------------------------------------------------------------------------------
// R6. Headings

interface NormHeading {
  norm: string;
  words: number;
  endsColon: boolean;
  hash: boolean;
  wrapped: boolean;
}

function normalizeHeading(raw: string): NormHeading {
  let t = collapse(raw);
  let hash = false;
  let wrapped = false;
  let endsColon = false;
  const h = /^#{1,6}(?=\s|[A-Za-z])\s*/.exec(t);
  if (h) {
    hash = true;
    t = trimEndChars(t.slice(h[0].length), '# ').trim();
  }
  t = t.replace(/^>\s*/, '').replace(RE_LEAD_GLYPH, '');
  for (let k = 0; k < 4; k++) {
    let changed = false;
    if (t.endsWith(':') || t.endsWith('\uFF1A')) {
      endsColon = true;
      t = t.slice(0, -1).trimEnd();
      changed = true;
    }
    const w = /^(\*\*|__)(.+)\1$/.exec(t) ?? /^([*_])(.+)\1$/.exec(t);
    if (w && w[2].trim() && !w[2].includes(w[1])) {
      wrapped = true;
      t = w[2].trim();
      changed = true;
    }
    const p = /\s*\([^()]*\)$/.exec(t);
    if (p && p.index > 0) {
      t = t.slice(0, p.index);
      changed = true;
    }
    if (!changed) break;
  }
  const norm = collapse(straightenQuotes(t).replace(/\*+/g, '')).toLowerCase();
  return { norm, words: norm ? norm.split(' ').length : 0, endsColon, hash, wrapped };
}

function isNegative(norm: string): boolean {
  return RE_NEGATIVE.test(norm.replace(RE_QUICK_WINS, ' '));
}

function tierOf(norm: string): Tier | 'negative' | null {
  // The packet asks for exactly 'Suggested actions:'. A heading that opens with it stays strong even when a
  // negative word follows ('Suggested actions based on the pattern'), unless it points at last week.
  if (/^suggested actions?\b/.test(norm) && !/\blast (?:week|wk)\b/.test(norm)) return 'strong';
  if (isNegative(norm)) return 'negative';
  if (RE_STRONG.test(norm)) return 'strong';
  if (RE_WEAK.test(norm)) return 'weak';
  return null;
}

function fits(h: NormHeading): boolean {
  return h.words > 0 && h.words <= HEADING_MAX_WORDS && h.norm.length <= HEADING_MAX_CHARS;
}

function analyzeHeading(text: string): LineHeading {
  // Prefix form: the text before the first colon, with more text after it on the same line.
  const plain = text.replace(/\*\*|__/g, '');
  const colon = plain.indexOf(':');
  if (colon > 0) {
    const rest = plain.slice(colon + 1).trim();
    if (rest) {
      const p = normalizeHeading(plain.slice(0, colon));
      const tier = tierOf(p.norm);
      if ((tier === 'strong' || tier === 'weak') && fits(p)) {
        return { cand: { tier, standalone: true, inline: rest }, blocker: false };
      }
    }
  }
  const h = normalizeHeading(text);
  const tier = tierOf(h.norm);
  const formed = h.endsColon || h.hash || h.wrapped;
  if (tier === 'negative') return { cand: null, blocker: formed };
  if (!tier) return { cand: null, blocker: false };
  if (fits(h)) return { cand: { tier, standalone: formed }, blocker: false };
  // A longer lead-in ending with ':' that names a STRONG keyword counts as a weak heading.
  if (tier === 'strong' && h.endsColon && h.words <= LONG_HEADING_MAX_WORDS) {
    return { cand: { tier: 'weak', standalone: true }, blocker: false };
  }
  return { cand: null, blocker: false };
}

// ---------------------------------------------------------------------------------------------------
// R9 and R10. Clean one item

function boldLead(s: string): string {
  // Bold italic (***X***) counts as bold.
  const m = /^(\*{2,3}|_{2,3})(.+?)\1(.*)$/.exec(s);
  if (!m) return s;
  const x = m[2].trim();
  const rest = m[3];
  if (!x) return s;
  if (!/[\p{L}\p{N}]/u.test(rest)) return `${x}${rest.trim()}`;
  // A bold burner label ('**Family**', '**Health (Steady)**') followed by text is a tag, with or without a
  // separator: '**Family** Book the sitter' becomes 'Family: Book the sitter'.
  // Without a separator the text must start with a capital or digit, so '**Work** out Tuesday' stays a sentence.
  if (burnerLabel(x)) {
    let r = rest.trim();
    const intent = RE_INTENT_LEAD.exec(r);
    if (intent) r = r.slice(intent[0].length);
    const bare = trimStartChars(r, ' :\uFF1A-|\u2013\u2014\u2015');
    const separated = bare.length < r.trimStart().length || x.endsWith(':') || x.endsWith('\uFF1A');
    if (intent || separated || /^[\p{Lu}\p{N}]/u.test(bare)) {
      const head = `${trimEndChars(x, ':\uFF1A ')}${intent ? ` ${intent[0]}` : ''}`;
      return bare ? `${head}: ${bare}` : head;
    }
  }
  if (x.endsWith(':') || x.endsWith('\uFF1A')) return `${x} ${rest.trim()}`;
  if (/^\s*[:\uFF1A]/.test(rest)) return `${x}: ${rest.replace(/^\s*[:\uFF1A]\s*/, '')}`;
  if (RE_SUFFIX_ONLY.test(rest)) return `${x} ${rest.trim()}`;
  // A rationale clause after the bold ('so date night happens', 'because mornings survive travel') is dropped.
  if (RE_RATIONALE.test(straightenQuotes(rest))) return x;
  // The bold is emphasis inside a sentence that keeps going ("**Book the sitter** for Friday").
  if (!/[.!?]$/.test(x) && (/^\s+[\p{Ll}\p{N}]/u.test(rest) || (!x.includes(' ') && /^\s+\p{L}/u.test(rest)))) {
    return `${x}${rest}`;
  }
  // Otherwise keep only the bold lead phrase, dropping the rationale.
  return x;
}

function stripEmphasis(s: string): string {
  return s
    .replace(/`([^`]+)`/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<![\p{L}\p{N}_])__([^_]+)__(?![\p{L}\p{N}_])/gu, '$1')
    .replace(/(?<![\p{L}\p{N}*])\*(?=\S)([^*]+)(?<=\S)\*(?![\p{L}\p{N}*])/gu, '$1')
    .replace(/(?<![\p{L}\p{N}_])_(?=\S)([^_]+)(?<=\S)_(?![\p{L}\p{N}_])/gu, '$1')
    .replace(/\*\*/g, '');
}

function stripMarkdown(s: string): string {
  // The link text excludes '[' as well as ']' so a long run of '[' is scanned once, not once per bracket.
  const linked = s.replace(/\[([^[\]]+)\]\([^()\s]*\)/g, '$1');
  // Leave URLs alone: underscores and asterisks inside them are not emphasis.
  return linked
    .split(/(\bhttps?:\/\/\S+)/i)
    .map((part, i) => (i % 2 === 1 ? part : stripEmphasis(part)))
    .join('');
}

function convertDashes(s: string): string {
  let t = s
    .replace(/\s*(?:\u2014|\u2015|-{2,})\s*/g, ', ')
    .replace(/(\d)\s+[-\u2013]\s+(?=\d)/g, '$1-')
    .replace(/\s+[-\u2013]\s+/g, ', ')
    .replace(/\u2013/g, '-');
  // Remove dashes left at the very start or end, but keep a leading minus sign on a number.
  t = trimStartChars(t, ' ,');
  if (/^-+(?!\d)/.test(t)) t = trimStartChars(t, '- ,');
  t = trimEndChars(t, ' ,-');
  return t.replace(/,(?:\s*,)+/g, ',').replace(/\s+,/g, ',').replace(/ {2,}/g, ' ').trim();
}

const QUOTE_PAIRS: Readonly<Record<string, string>> = { '"': '"', "'": "'", '\u201C': '\u201D', '\u2018': '\u2019' };

function unwrapQuotes(s: string): string {
  const t = s.trim();
  if (t.length < 2) return t;
  const close = QUOTE_PAIRS[t[0]];
  if (close && t.endsWith(close)) {
    const inner = t.slice(1, -1).trim();
    if (inner) return inner;
  }
  return t;
}

function keepsFinalPeriod(t: string, end: number): boolean {
  return /(?:^|[\s(\d])(?:a\.m|p\.m|etc)\.$/i.test(t.slice(Math.max(0, end - 5), end));
}

/** R9 step 7: strip trailing '.', ',', ';', ':' and ellipses, keeping the period of a.m., p.m., etc. */
function stripTrailing(s: string): string {
  let end = s.length;
  while (end > 0) {
    const ch = s[end - 1];
    if (ch === ' ') {
      end--;
      continue;
    }
    if (ch === '.' || ch === ',' || ch === ';' || ch === ':' || ch === '\uFF1A' || ch === '\u2026') {
      if (ch === '.' && keepsFinalPeriod(s, end)) break;
      end--;
      continue;
    }
    break;
  }
  return s.slice(0, end);
}

function finishText(s: string): string {
  return stripTrailing(unwrapQuotes(stripTrailing(unwrapQuotes(s))));
}

function capitalizeFirst(s: string): string {
  const m = /^\S+/.exec(s);
  if (!m) return s;
  const word = m[0];
  if (!/^\p{Ll}/u.test(word) || /\p{Lu}/u.test(word)) return s;
  const first = String.fromCodePoint(word.codePointAt(0) ?? 0);
  return first.toUpperCase() + s.slice(first.length);
}

/** R10: the first sentence, or null when there is no sentence break. */
function firstSentence(s: string): string | null {
  for (const m of s.matchAll(/[.!] +(?=[\p{Lu}\p{N}])/gu)) {
    const at = m.index ?? 0;
    if (s[at] === '.') {
      let j = at;
      while (j > 0 && /[\p{L}.]/u.test(s[j - 1])) j--;
      const token = trimStartChars(s.slice(j, at), '.').toLowerCase();
      if (ABBREVIATIONS.has(token) || /^\p{L}$/u.test(token)) continue;
    }
    return s.slice(0, at + 1);
  }
  return null;
}

function truncate(s: string): string {
  const windowText = s.slice(0, CUT_AT + 1);
  const space = windowText.lastIndexOf(' ');
  const cut = space > 0 ? s.slice(0, space) : s.slice(0, CUT_AT);
  return `${trimEndChars(cut, ' ,;:.-')}...`;
}

function stripLeadGlyphs(input: string): string {
  let s = input;
  for (let k = 0; k < 4; k++) {
    const next = s.replace(RE_INNER_BOX, '').replace(RE_CHECK_LEAD, '').replace(RE_LEAD_GLYPH, '').trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

function cleanContent(input: string): Cleaned {
  // (1) Leftover checkbox, leading emoji or keycap.
  let s = stripLeadGlyphs(collapse(input));
  // (2) Bold lead, (3) leftover markdown, (4) leading qualifier. Glyphs are stripped again in case
  // they sat inside the bold ('**<emoji> Book the sitter**').
  s = stripLeadGlyphs(collapse(stripMarkdown(boldLead(s)))).replace(RE_QUALIFIER, '');
  const labelText = s;
  const label = burnerLabel(s);
  const isLabel = label !== undefined;
  // (5) Burner tag, once only; otherwise a '(Health)' or '[Work]' suffix.
  let burner: BurnerId | undefined;
  const tag = RE_TAG.exec(s);
  if (tag) {
    burner = toBurner(tag[1]);
    s = s.slice(tag[0].length).replace(RE_QUALIFIER, '');
  } else {
    const suffix = RE_TAG_SUFFIX.exec(s);
    if (suffix) {
      burner = toBurner(suffix[1]);
      s = s.slice(0, suffix.index);
    }
  }
  if (label && !burner) burner = label;
  s = s.trim();
  const endsColon = s.endsWith(':') || s.endsWith('\uFF1A');
  // (6) Dashes, (7) wrapping quotes and trailing punctuation, (8) capitalize a lowercase first word.
  s = capitalizeFirst(finishText(convertDashes(s)));
  // R10. Length.
  if (s.length > SPLIT_OVER) {
    const first = firstSentence(s);
    if (first) s = finishText(first);
  }
  if (s.length > HARD_MAX) s = truncate(s);
  return { text: s, burner, endsColon, isLabel, labelText };
}

// ---------------------------------------------------------------------------------------------------
// R11 and R12. Validity and dedupe

/** Dedupe key (R12): lowercase, quotes straightened, burner tag removed, only letters, digits and single spaces. */
export function actionKey(text: string): string {
  let s = collapse(straightenQuotes((typeof text === 'string' ? text : '').normalize('NFKC')));
  const tag = RE_TAG.exec(s);
  if (tag) s = s.slice(tag[0].length);
  else {
    const suffix = RE_TAG_SUFFIX.exec(s);
    if (suffix) s = s.slice(0, suffix.index);
  }
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function endsWithQuestion(text: string): boolean {
  return trimEndChars(text.trim(), '"\')]\u201D\u2019').endsWith('?');
}

function isValidAction(text: string): boolean {
  const t = text.trim();
  if (t.length < 6) return false;
  if (endsWithQuestion(t)) return false;
  if (!/\p{L}/u.test(t)) return false;
  if (t.split(' ').filter(Boolean).length < 2) return false;
  const key = actionKey(t);
  if (!key || BURNER_SET.has(key) || burnerLabel(t)) return false;
  return !META_PATTERNS.some((re) => re.test(key));
}

function firstWordKey(text: string): string {
  const first = straightenQuotes(text.trim()).split(' ')[0] ?? '';
  return first.toLowerCase().replace(/[^a-z']/g, '');
}

function startsWithPronoun(text: string): boolean {
  return PRONOUNS.has(firstWordKey(text));
}

function startsWithRemark(text: string): boolean {
  return REMARK_OPENERS.has(firstWordKey(text));
}

function dedupe(list: readonly Flat[]): ParsedAction[] {
  const out: ParsedAction[] = [];
  const at = new Map<string, number>();
  for (const a of list) {
    const key = actionKey(a.text);
    const j = at.get(key);
    if (j === undefined) {
      at.set(key, out.length);
      out.push(a.burner ? { text: a.text, burner: a.burner } : { text: a.text });
    } else if (!out[j].burner && a.burner) {
      out[j].burner = a.burner;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// R5. Nesting

interface TreeNode {
  item: Item;
  clean: Cleaned;
  children: TreeNode[];
}

function sameColumn(a: Item, b: Item): boolean {
  return Math.abs(a.indent - b.indent) <= 1;
}

function buildTree(items: readonly Item[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const stack: TreeNode[] = [];
  for (const item of items) {
    const node: TreeNode = { item, clean: cleanContent(item.content), children: [] };
    let parent: TreeNode | null = null;
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (item.indent >= top.item.indent + 2) {
        parent = top;
        break;
      }
      if (item.indent <= top.item.indent - 2) {
        stack.pop();
        continue;
      }
      if (item.glyph === top.item.glyph) {
        stack.pop();
        parent = stack.length ? stack[stack.length - 1] : null;
        break;
      }
      // A secondary glyph after a different marker in the same column is a child (rendered copies).
      if (SECONDARY_GLYPHS.has(item.glyph) && !stack.some((n) => sameColumn(n.item, item) && n.item.glyph === item.glyph)) {
        parent = top;
        break;
      }
      stack.pop();
    }
    (parent ? parent.children : roots).push(node);
    stack.push(node);
  }
  return roots;
}

function uniqueCapitalizedBurner(text: string): BurnerId | undefined {
  const found = new Set<string>();
  for (const m of text.matchAll(/\b(Family|Friends|Health|Work)\b/g)) found.add(m[1]);
  return found.size === 1 ? toBurner([...found][0]) : undefined;
}

function flatten(nodes: readonly TreeNode[], inherited: BurnerId | undefined, out: Flat[]): void {
  for (const n of nodes) {
    const c = n.clean;
    if ((c.endsColon || c.isLabel) && n.children.length) {
      // A label parent is dropped; its children move up and inherit its burner.
      flatten(n.children, c.burner ?? uniqueCapitalizedBurner(c.labelText) ?? inherited, out);
    } else {
      // Children of a normal item are elaboration and are dropped.
      const burner = c.burner ?? inherited;
      out.push(burner ? { text: c.text, burner } : { text: c.text });
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// R7. Inline items after a strong heading's colon

function splitInline(rest: string): string[] {
  const parts: string[] = [];
  for (const segment of rest.split(';')) {
    const cuts: { at: number; len: number }[] = [];
    let expected = 1;
    for (const m of segment.matchAll(/(^|\s)(\(([1-9]\d?)\)|([1-9]\d?)[.)])(?=\s)/g)) {
      if (Number(m[3] ?? m[4]) !== expected) continue;
      cuts.push({ at: (m.index ?? 0) + m[1].length, len: m[2].length });
      expected++;
    }
    let from = 0;
    for (const c of cuts) {
      parts.push(segment.slice(from, c.at));
      from = c.at + c.len;
    }
    parts.push(segment.slice(from));
  }
  return parts.map((p) => p.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------------------------------
// Parse the (already sliced) lines

interface LinesResult {
  actions: ParsedAction[];
  source: ParsedReply['source'];
  hasList: boolean;
  proseChars: number;
}

function parseLines(normLines: readonly NormLine[]): LinesResult {
  const lines: Line[] = normLines.map(classify);
  const n = lines.length;
  const headingMemo = new Map<number, LineHeading>();
  const headingAt = (i: number): LineHeading => {
    const L = lines[i];
    if (L.kind !== 'text') return { cand: null, blocker: false };
    let h = headingMemo.get(i);
    if (!h) {
      h = analyzeHeading(L.text);
      headingMemo.set(i, h);
    }
    return h;
  };

  // R3. Emoji-led lines are items only in a run of 2 or more, or right under a heading candidate.
  // An emoji-led line that opens with a subject pronoun ('<emoji> You've got this.') is a closing remark, not
  // an action, so it is prose even inside a run.
  for (let i = 0; i < n; i++) {
    const L = lines[i];
    if (L.kind === 'emoji' && startsWithRemark(L.item.content)) lines[i] = { kind: 'text', indent: L.indent, text: L.text };
  }
  const emojiCandidate = lines.map((L) => L.kind === 'emoji');
  let underHeading = false;
  // A tight emoji list (two items on adjacent lines) ends at a blank line: a later lone emoji line is prose.
  let tight = false;
  let afterBlank = false;
  for (let i = 0; i < n; i++) {
    const L = lines[i];
    if (L.kind === 'blank') {
      afterBlank = true;
      continue;
    }
    if (L.kind !== 'emoji') {
      underHeading = false;
      tight = false;
      afterBlank = false;
      continue;
    }
    const inRun = (i > 0 && emojiCandidate[i - 1]) || (i + 1 < n && emojiCandidate[i + 1]);
    let headed: boolean = underHeading && !(afterBlank && tight);
    if (!headed) {
      let j = i - 1;
      if (j >= 0 && lines[j].kind === 'blank') j--;
      headed = j >= 0 && headingAt(j).cand !== null;
    }
    if (inRun || headed) {
      if (!afterBlank && i > 0 && lines[i - 1].kind === 'item') tight = true;
      lines[i] = { kind: 'item', item: { ...L.item, emojiRun: inRun } };
      underHeading = headed;
    } else {
      lines[i] = { kind: 'text', indent: L.indent, text: L.text };
      underHeading = false;
      tight = false;
    }
    afterBlank = false;
  }

  const headingShaped = (i: number): boolean => {
    const h = headingAt(i);
    return h.blocker || (h.cand !== null && h.cand.standalone);
  };

  // R4. Group items into blocks.
  const blocks: Block[] = [];
  const blockAt = new Map<number, Block>();
  const continuation: boolean[] = new Array<boolean>(n).fill(false);
  let cur: Block | null = null;
  let blank = false;
  let joinable = false;
  for (let i = 0; i < n; i++) {
    const L = lines[i];
    if (L.kind === 'blank') {
      blank = true;
      joinable = false;
      continue;
    }
    if (L.kind === 'rule') {
      cur = null;
      blank = false;
      joinable = false;
      continue;
    }
    if (L.kind === 'item') {
      const it = L.item;
      if (cur && blank) {
        const deeper = it.indent >= cur.minIndent + 2;
        const sameFamily = it.family === cur.firstFamily || it.family === cur.baseFamily;
        const restart = !deeper && it.family === 'number' && it.num === 1 && cur.lastNum !== undefined && cur.lastNum !== 1;
        if ((!deeper && !sameFamily) || restart) cur = null;
      }
      if (!cur) {
        cur = { start: i, items: [], minIndent: it.indent, firstFamily: it.family, baseFamily: it.family };
        blocks.push(cur);
        blockAt.set(i, cur);
      }
      if (it.indent < cur.minIndent + 2) {
        cur.baseFamily = it.family;
        if (it.family === 'number') cur.lastNum = it.num;
      }
      cur.minIndent = Math.min(cur.minIndent, it.indent);
      cur.items.push({ ...it });
      blank = false;
      joinable = true;
      continue;
    }
    if (L.kind === 'text' && cur && L.indent >= cur.minIndent + 2 && !headingShaped(i)) {
      // Indented continuation: elaboration, ignored, unless it is a hard wrap of the item line.
      continuation[i] = true;
      const last = cur.items[cur.items.length - 1];
      // Joined content stays within the per-line cap, so a wall of wrapped lines cannot build one huge item.
      const fitsCap = last.content.length + L.text.length < MAX_LINE_CHARS;
      if (joinable && !blank && fitsCap && !/[.!?:;]$/.test(last.content) && /^\p{Ll}/u.test(L.text)) {
        last.content = `${last.content} ${L.text}`;
        continue;
      }
      joinable = false;
      continue;
    }
    // An unindented non-item line ends the block at once (no lazy continuation).
    cur = null;
    blank = false;
    joinable = false;
  }

  // R6. Confirm headings: shape alone, or followed by a list block after at most one blank line.
  const heading: (HeadingCandidate | null)[] = new Array<HeadingCandidate | null>(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (lines[i].kind !== 'text' || continuation[i]) continue;
    const c = headingAt(i).cand;
    if (!c) continue;
    const next = lines[i + 1];
    const after = lines[i + 2];
    if (c.standalone || next?.kind === 'item' || (next?.kind === 'blank' && after?.kind === 'item')) heading[i] = c;
  }

  // R7. Which block belongs to a heading.
  const inlineBlocks: Block[] = [];
  for (let h = 0; h < n; h++) {
    const c = heading[h];
    if (!c) continue;
    let owned: Block | undefined;
    let texts = 0;
    for (let j = h + 1; j < n; j++) {
      const L = lines[j];
      if (L.kind === 'blank') continue;
      if (L.kind === 'rule') break;
      if (L.kind === 'item') {
        owned = blockAt.get(j);
        break;
      }
      if (L.kind !== 'text' || continuation[j] || heading[j] || headingAt(j).blocker) break;
      texts++;
      if (texts > 1 || L.text.length > INTRO_LINE_MAX) break;
    }
    if (owned) owned.owner = c.tier;
    else if (c.tier === 'strong' && c.inline) {
      const parts = splitInline(c.inline);
      if (parts.length) {
        inlineBlocks.push({ start: h, items: [], inlineParts: parts, minIndent: 0, firstFamily: 'bullet', baseFamily: 'bullet', owner: 'strong' });
      }
    }
  }

  const memo = new Map<Block, Evaluated>();
  const evaluate = (b: Block): Evaluated => {
    const hit = memo.get(b);
    if (hit) return hit;
    let flat: Flat[];
    if (b.inlineParts) {
      // A part that opens with a pronoun ('they're small on purpose') is a remark, not an action.
      flat = b.inlineParts
        .map((p): Flat => {
          const c = cleanContent(p);
          return c.burner ? { text: c.text, burner: c.burner } : { text: c.text };
        })
        .filter((f) => !startsWithRemark(f.text));
    } else {
      flat = [];
      flatten(buildTree(b.items), undefined, flat);
    }
    const result = { flat, actions: dedupe(flat.filter((f) => isValidAction(f.text))).slice(0, MAX_ACTIONS) };
    memo.set(b, result);
    return result;
  };

  const hasList = lines.some((L) => L.kind === 'item');
  let proseChars = 0;
  for (const L of lines) if (L.kind === 'text') proseChars += L.text.length;
  const done = (actions: ParsedAction[], source: ParsedReply['source']): LinesResult => ({
    actions,
    source: actions.length ? source : 'none',
    hasList,
    proseChars,
  });

  // R8. Choose exactly one block: the last strong-headed list, then the last weak-headed list. An inline
  // heading ('Suggested actions: a; b') is used only when no headed list yields an action, so a closing remark
  // after the list ('These actions are small on purpose: travel weeks punish ambition.') cannot replace it.
  for (const tier of ['strong', 'weak'] as const) {
    for (let k = blocks.length - 1; k >= 0; k--) {
      if (blocks[k].owner !== tier) continue;
      const r = evaluate(blocks[k]);
      if (r.actions.length) return done(r.actions, tier === 'strong' ? 'heading' : 'weak-heading');
    }
  }
  for (let k = inlineBlocks.length - 1; k >= 0; k--) {
    const r = evaluate(inlineBlocks[k]);
    if (r.actions.length) return done(r.actions, 'heading');
  }
  for (let k = blocks.length - 1; k >= 0; k--) {
    const b = blocks[k];
    // In fallback, emoji-led lines only count as a run of 2 or more.
    if (b.items.some((it) => it.family === 'emoji' && !it.emojiRun)) continue;
    const r = evaluate(b);
    if (!r.flat.length) continue;
    const questions = r.flat.filter((f) => endsWithQuestion(f.text)).length;
    if (questions * 2 >= r.flat.length) continue;
    // Conservative stops: a NEGATIVE lead-in right above, or a pronoun-led observation list.
    let j = b.start - 1;
    while (j >= 0 && lines[j].kind === 'blank') j--;
    const above = j >= 0 ? lines[j] : null;
    if (above && above.kind === 'text') {
      const h = normalizeHeading(above.text);
      if (h.endsColon && isNegative(h.norm)) return done([], 'none');
    }
    const pronounLed = r.flat.filter((f) => startsWithPronoun(f.text)).length;
    if (pronounLed * 2 >= r.flat.length) return done([], 'none');
    return done(r.actions, 'fallback');
  }
  return done([], 'none');
}

// ---------------------------------------------------------------------------------------------------
// Public API

/**
 * Extract up to 5 suggested actions from a pasted coach reply. Tolerant of markdown and rendered copies,
 * partial pastes, and whole-chat copies that include the packet (everything up to the last END OF PACKET
 * line is ignored). Never adds anything by itself; the UI offers each action as a chip.
 */
export function parseSuggestedActions(reply: string): ParsedReply {
  const text = typeof reply === 'string' ? reply : '';
  const raw = text.replace(/\r\n?|[\u2028\u2029]/g, '\n').split('\n');
  let end = -1;
  for (let i = raw.length - 1; i >= 0; i--) {
    if (raw[i].includes(PACKET_END) && normalizeLine(raw[i]).text.trim() === PACKET_END) {
      end = i;
      break;
    }
  }
  const hasHeader = text.includes(PACKET_HEADER);
  // A paste that opens with the packet and has no END line is a cut-off packet. If Claude's reply follows it
  // (whole chat copied) and yields actions, offer them; otherwise it is the packet pasted back by mistake.
  // The packet's own template line ('- Burner: action') is never a valid action.
  const cutOffPacket = end < 0 && hasHeader && startsWithHeader(raw);
  const from = Math.max(end + 1, raw.length - MAX_LINES);
  const parsed = parseLines(raw.slice(from).map(normalizeLine));
  if (cutOffPacket && parsed.actions.length === 0) return { actions: [], source: 'none', isPacketEcho: true };
  const isPacketEcho =
    hasHeader && end >= 0 && parsed.actions.length === 0 && !parsed.hasList && parsed.proseChars < ECHO_PROSE_MIN;
  if (isPacketEcho) return { actions: [], source: 'none', isPacketEcho };
  return { actions: parsed.actions, source: parsed.source, isPacketEcho: false };
}

/** Clean one extracted action line (R9 and R10): marker, checkbox, emoji, markdown, burner tag, dashes, punctuation. */
export function cleanAction(line: string): string {
  const one = (typeof line === 'string' ? line : '').replace(/[\r\n\u2028\u2029]+/g, ' ');
  const body = normalizeLine(one).text.trim();
  const item = parseMarker(body, 0);
  return cleanContent(item ? item.content : body).text;
}
