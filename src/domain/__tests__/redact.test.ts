import { describe, expect, it } from 'vitest';
import { REDACTED, cleanTerms, containsSensitive, findSensitive, redact } from '../coach/redact';

const TERMS = ['Summit Wealth', 'Lakefront', 'Harbor Point Advisors', 'JPM', 'Smith & Co', "O'Neil Partners"];

describe('redaction', () => {
  it('replaces terms case-insensitively', () => {
    expect(redact('Call with summit wealth about the LOI', TERMS)).toBe(`Call with ${REDACTED} about the LOI`);
    expect(redact('LAKEFRONT diligence', TERMS)).toBe(`${REDACTED} diligence`);
  });

  it('catches possessives, plurals, and punctuation around terms', () => {
    expect(redact("JPM's team", TERMS)).toBe(`${REDACTED} team`);
    expect(redact('(Lakefront).', TERMS)).toBe(`(${REDACTED}).`);
    expect(redact('Lakefront’s numbers', TERMS)).not.toMatch(/lakefront/i);
  });

  it('catches spacing and joining variants of multi-word terms', () => {
    for (const v of ['Summit-Wealth', 'summit_wealth', 'SummitWealth', 'Summit  Wealth', 'Summit\nWealth', 'summit.wealth']) {
      expect(redact(`met ${v} today`, TERMS)).toBe(`met ${REDACTED} today`);
    }
  });

  it('long terms are caught even inside other words (hashtags, run-ons)', () => {
    expect(redact('#LakefrontDeal', TERMS)).not.toMatch(/lakefront/i);
    expect(redact('prelakefront', TERMS)).not.toMatch(/lakefront/i);
  });

  it('short terms only match whole words, so ordinary words survive', () => {
    expect(redact('JPMorgan-style thinking', ['JP'])).toBe('JPMorgan-style thinking');
    expect(redact('Met with JP today', ['JP'])).toBe(`Met with ${REDACTED} today`);
  });

  it('prefers the longest term when terms overlap', () => {
    const out = redact('Harbor Point Advisors and Harbor', ['Harbor', 'Harbor Point Advisors']);
    expect(out).toBe(`${REDACTED} and ${REDACTED}`);
  });

  it('handles regex characters, ampersands, and apostrophes in terms', () => {
    expect(redact('Smith & Co and Smith and Co', TERMS)).toBe(`${REDACTED} and ${REDACTED}`);
    expect(redact("O'Neil Partners and O’Neil Partners", TERMS)).toBe(`${REDACTED} and ${REDACTED}`);
    expect(redact('a+b (c)', ['a+b', '(c)'])).not.toMatch(/a\+b/);
  });

  it('folds lookalike full-width characters before matching', () => {
    expect(redact('Ｌａｋｅｆｒｏｎｔ call', TERMS)).not.toMatch(/lakefront/i);
  });

  it('no terms means no change', () => {
    expect(redact('anything goes', [])).toBe('anything goes');
    expect(redact('anything goes', ['  ', 'a'])).toBe('anything goes');
  });

  it('finds terms for the typing warning', () => {
    expect(findSensitive('Prep the summit wealth memo', TERMS)).toEqual(['Summit Wealth']);
    expect(findSensitive('Nothing here', TERMS)).toEqual([]);
    expect(containsSensitive(redact('Lakefront and JPM', TERMS), TERMS)).toBe(false);
  });

  it('cleans term lists', () => {
    expect(cleanTerms(['  Lakefront ', 'lakefront', '', 'x', 'Summit   Wealth'])).toEqual(['Lakefront', 'Summit Wealth']);
  });
});

describe('reserved words', () => {
  it('rejects single packet words but allows names that contain them', async () => {
    const { termProblem } = await import('../coach/redact');
    expect(termProblem('Work')).toMatch(/own words/);
    expect(termProblem('coach')).toMatch(/own words/);
    expect(termProblem('Summit Work Partners')).toBeNull();
    expect(termProblem('Lakefront')).toBeNull();
    expect(termProblem('x')).toMatch(/short/);
  });
});
