// Work confidentiality: sensitive terms (company or client names) are removed from every packet.
// Redaction errs on the side of removing too much. Leaking a client name is the failure to avoid.

export const REDACTED = '[redacted]';

/** Terms shorter than this are only matched as whole words; longer ones also match inside words. */
const EMBEDDED_MIN = 5;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Normalize a user-entered term list: trim, collapse whitespace, drop blanks and duplicates. */
export function cleanTerms(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const t = raw.replace(/\s+/g, ' ').trim();
    if (t.length < 2) continue;
    const k = t.toLocaleLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/**
 * Build one pattern per term. Whitespace inside a term matches any run of whitespace or
 * hyphens/underscores/dots ("Summit Wealth" also catches "Summit-Wealth", "summit_wealth", "SummitWealth").
 * Matching is case-insensitive and Unicode-aware; curly and straight apostrophes are treated alike.
 */
function termPattern(term: string): string {
  const parts = term.split(' ').map((p) =>
    escapeRegex(p)
      .replace(/'|’/g, "['’]")
      // Treat & and "and" as interchangeable ("Smith & Co" vs "Smith and Co").
      .replace(/^&$/, '(?:&|and)')
      .replace(/^and$/i, '(?:&|and)'),
  );
  const body = parts.join('[\\s\\-_.]*');
  const long = term.replace(/\s/g, '').length >= EMBEDDED_MIN;
  // Short terms: whole words only (with an optional possessive or plural). Long terms: anywhere.
  return long ? body : `(?<![\\p{L}\\p{N}])${body}(?:['’]s|s|es)?(?![\\p{L}\\p{N}])`;
}

function buildRegex(terms: readonly string[]): RegExp | null {
  const list = cleanTerms(terms).sort((a, b) => b.length - a.length);
  if (!list.length) return null;
  return new RegExp(list.map(termPattern).join('|'), 'giu');
}

/** Replace every sensitive term in text with [redacted]. */
export function redact(text: string, terms: readonly string[]): string {
  const re = buildRegex(terms);
  if (!re) return text;
  // NFKC folds lookalike characters (full-width letters, ligatures) so they cannot slip through.
  const normalized = text.normalize('NFKC');
  return normalized.replace(re, REDACTED);
}

/** Which sensitive terms appear in text (for the gentle warning while typing a Work note). */
export function findSensitive(text: string, terms: readonly string[]): string[] {
  const found: string[] = [];
  const normalized = text.normalize('NFKC');
  for (const t of cleanTerms(terms)) {
    const re = new RegExp(termPattern(t), 'iu');
    if (re.test(normalized)) found.push(t);
  }
  return found;
}

/** Final safety check used by tests and the packet builder: true if any term survived. */
export function containsSensitive(text: string, terms: readonly string[]): boolean {
  return findSensitive(text, terms).length > 0;
}

/**
 * Single words the packets themselves use (labels, burner names, intents). Redacting one would
 * blank out the packet's own structure, so they cannot be sensitive terms on their own.
 * Multi-word names that contain them ("Summit Work Partners") are fine.
 */
const RESERVED_WORDS = new Set(
  (
    'four burners burner coach packet end of family friends health work high steady low suggested actions action ' +
    'type week weekly review quarter crunch me why when pace active trimmed redacted progress consistency streak ' +
    'energy days day wins misses notes note people goals goal draft last prior off track ask load now done yes no ' +
    'travel life theme people setup check in about the and a'
  ).split(' '),
);

/** Why a term cannot be added, or null if it is fine. */
export function termProblem(term: string): string | null {
  const t = term.replace(/\s+/g, ' ').trim();
  if (t.length < 2) return 'Too short to match safely.';
  if (!t.includes(' ') && RESERVED_WORDS.has(t.toLowerCase())) {
    return `"${t}" is one of the app's own words, so redacting it would scramble your packets. Add the full name instead.`;
  }
  return null;
}
