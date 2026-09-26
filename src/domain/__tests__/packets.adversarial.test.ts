// Adversarial review of src/domain/coach/packets.ts: every way a private note or a sensitive term could
// reach the final packet text, line-start faking, budgets, empty data, formats, and coaching quality.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PACKET_END, PACKET_HEADER } from '../coach/constants';
import {
  buildCheckinPacket,
  buildOnboardingPacket,
  buildQuarterSetupPacket,
  buildWeeklyPacket,
  finalizePacket,
  packetGate,
  type BuiltPacket,
  type CheckinPacketInput,
  type OnboardingPacketInput,
  type QuarterSetupPacketInput,
  type WeeklyPacketInput,
} from '../coach/packets';
import { REDACTED } from '../coach/redact';
import { addDays, dateRange, quarterSpan, weekday } from '../dates';
import type { DashboardInput } from '../scoring';
import {
  DEFAULT_SETTINGS,
  EMPTY_PROFILE_FIELDS,
  type BurnerId,
  type CrunchPeriod,
  type EnergyEntry,
  type Goal,
  type LocalDate,
  type LogEntry,
  type Person,
  type Profile,
  type ProfileFields,
  type Quarter,
  type Settings,
  type Touchpoint,
  type WeeklyAction,
  type WeeklyReview,
} from '../types';

// ---------------------------------------------------------------------------------------------
// Fixtures

const ch = (...codes: number[]) => String.fromCodePoint(...codes);
const EM = ch(0x2014);
const EN = ch(0x2013);
const BANNED = new RegExp(`[${EN}${EM}]`);
const WEEK = '2026-09-14';
const SUNDAY = '2026-09-20';

let seq = 0;
const nid = (k: string) => `${k}-${seq++}`;
const stamp = (d: LocalDate, hour = 12) => `${d}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const rec = (d: LocalDate) => ({ createdAt: stamp(d, 9), updatedAt: stamp(d, 9) });

function settings(terms: string[]): Settings {
  return { ...DEFAULT_SETTINGS, sensitiveTerms: terms };
}

function mkQuarter(id: string, over: Partial<Quarter> = {}): Quarter {
  return {
    id,
    ...rec(quarterSpan(id).start),
    theme: '',
    intents: { family: 'high', friends: 'low', health: 'steady', work: 'high' },
    intentHistory: [],
    status: 'active',
    ...over,
  };
}

function mkGoal(over: Partial<Goal> & Pick<Goal, 'burner' | 'title' | 'type'>, q = '2026-Q3'): Goal {
  const span = quarterSpan(q);
  return { id: nid('goal'), quarterId: q, startDate: span.start, deadline: span.end, order: 0, ...rec(span.start), ...over };
}

function mkLog(goalId: string, d: LocalDate, value = 1, extra: Partial<LogEntry> = {}): LogEntry {
  return { id: nid('log'), goalId, value, localDate: d, at: stamp(d, 8 + (seq % 10)), offsetMin: 0, ...rec(d), ...extra };
}

function mkEnergy(d: LocalDate, rating: EnergyEntry['rating']): EnergyEntry {
  return { id: nid('energy'), rating, localDate: d, at: stamp(d, 21), offsetMin: 0, ...rec(d) };
}

function mkPerson(name: string, burner: 'family' | 'friends', cadenceDays: number, order: number): Person {
  return { id: nid('person'), name, burner, cadenceDays, order, ...rec('2026-07-01') };
}

function mkTouch(personId: string, d: LocalDate, type: Touchpoint['type'] = 'call', extra: Partial<Touchpoint> = {}): Touchpoint {
  return { id: nid('touch'), personId, type, localDate: d, at: stamp(d, 18), offsetMin: 0, ...rec(d), ...extra };
}

function mkCrunch(start: LocalDate, end: LocalDate | undefined, label?: string): CrunchPeriod {
  return { id: nid('crunch'), start, end, label, ...rec(start) };
}

function mkReview(weekStart: LocalDate, wins: string[], misses: string[], focus = ''): WeeklyReview {
  return { id: `review-${weekStart}`, weekStart, step: 5, wins, misses, focus, focusBurners: [], ...rec(addDays(weekStart, 6)) };
}

function mkAction(weekStart: LocalDate, text: string, burner: BurnerId, order: number, doneOn?: LocalDate): WeeklyAction {
  return {
    id: nid('action'),
    weekStart,
    text,
    burner,
    order,
    ...rec(addDays(weekStart, -1)),
    ...(doneOn ? { done: { at: stamp(doneOn, 18), offsetMin: 0, localDate: doneOn } } : {}),
  };
}

function mkProfile(fields: ProfileFields): Profile {
  return { id: 'me', ...rec('2026-07-01'), source: 'interview', ...fields };
}

function profileWith(v: string): ProfileFields {
  return {
    lifeContext: `Home with ${v} nearby.`,
    burners: {
      family: { matters: `Mom near ${v}, every week.`, winning: `Dinner before ${v} calls.` },
      friends: { matters: `Pal from ${v}, monthly.`, winning: `Reach out to ${v} friends.` },
      health: { matters: `Runs by ${v}.`, winning: `Three runs past ${v}.` },
      work: { matters: `I lead deals at ${v}.`, winning: `Deep work, no ${v} fire drills.` },
    },
    travel: 'weekly',
    crunch: `${v} closings take over.`,
  };
}

interface Planted {
  weekly: WeeklyPacketInput;
  checkin: CheckinPacketInput;
  setup: QuarterSetupPacketInput;
  onboarding: OnboardingPacketInput;
}

/**
 * One value planted into every user-written field every packet type prints: theme, intent-change reason,
 * goal titles, whys, whens, units, milestone steps (done this week and next), public log notes, person
 * names, touchpoint notes, crunch labels (this week, ahead, planned next quarter), open actions, wins,
 * misses (repeating), review focus, the check-in question, all profile fields, last quarter's goal titles
 * and wins, and draft goals (titles, whys, whens, units, steps).
 */
function planted(v: string, terms: string[]): Planted {
  seq = 0;
  const q = mkQuarter('2026-Q3', {
    theme: `${v} year`,
    intentHistory: [{ burner: 'health', from: 'high', to: 'steady', reason: `Because of ${v}`, at: stamp('2026-08-25'), localDate: '2026-08-25' }],
  });
  const G = {
    bed: mkGoal({ burner: 'family', title: `${v} bedtime`, type: 'habit', target: 3, habitPeriod: 'week', why: `So ${v} waits`, whenWhere: `After ${v} calls`, order: 0 }),
    trip: mkGoal({
      burner: 'family',
      title: 'Plan the trip',
      type: 'milestone',
      milestones: [
        { id: 'm1', title: `Pick ${v} dates` },
        { id: 'm2', title: `Book ${v} flights` },
        { id: 'm3', title: `Share ${v} plan` },
      ],
      why: 'Together time.',
      whenWhere: 'Sundays',
      order: 1,
    }),
    host: mkGoal({ burner: 'friends', title: `Host ${v} dinner`, type: 'yesno', why: `Because ${v} matters`, whenWhere: `A ${v} Saturday`, order: 0 }),
    run: mkGoal({ burner: 'health', title: 'Run 150 miles', type: 'number', target: 150, unit: `${v} laps`, why: 'Strong at 50.', whenWhere: 'Mornings', order: 0 }),
    deep: mkGoal({ burner: 'work', title: 'Deep work', type: 'habit', target: 4, habitPeriod: 'week', why: `Beat ${v}`, whenWhere: `Before ${v} opens`, order: 0 }),
  };
  const logs: LogEntry[] = [];
  for (const d of dateRange('2026-07-01', '2026-09-13')) {
    if (weekday(d) === 0) logs.push(mkLog(G.bed.id, d));
    if (weekday(d) === 1) logs.push(mkLog(G.run.id, d, 3));
    if (weekday(d) === 2) logs.push(mkLog(G.deep.id, d));
  }
  logs.push(mkLog(G.bed.id, '2026-09-14', 1, { note: `Read about ${v} tonight` }));
  logs.push(mkLog(G.run.id, '2026-09-15', 4, { note: `Ran past ${v} again` }));
  logs.push(mkLog(G.deep.id, '2026-09-16', 1, { note: `Wrote the ${v} memo` }));
  logs.push(mkLog(G.trip.id, '2026-07-20', 1, { milestoneId: 'm1' }));
  logs.push(mkLog(G.trip.id, '2026-09-17', 1, { milestoneId: 'm2' }));
  const energy = dateRange('2026-08-10', SUNDAY).map((d, i) => mkEnergy(d, ((i % 3) + 2) as EnergyEntry['rating']));
  const P = { mom: mkPerson(`${v} Mom`, 'family', 7, 0), pal: mkPerson(`Pal ${v}`, 'friends', 30, 1), old: mkPerson(`Old ${v}`, 'friends', 14, 2) };
  const touchpoints = [
    mkTouch(P.mom.id, '2026-09-15', 'call', { note: `Talked about ${v}` }),
    mkTouch(P.pal.id, '2026-09-18', 'text', { note: `He joined ${v}` }),
    mkTouch(P.old.id, '2026-08-01', 'call'),
  ];
  const crunch = [mkCrunch('2026-09-17', '2026-09-17', `${v} close`), mkCrunch('2026-09-23', '2026-09-25', `${v} trip`), mkCrunch('2026-10-12', '2026-10-16', `${v} offsite`)];
  const actions = [
    mkAction(WEEK, `Send ${v} recap`, 'work', 0),
    mkAction(WEEK, 'Book the sitter', 'family', 1, '2026-09-16'),
    mkAction(addDays(WEEK, 7), `Call ${v} back`, 'work', 0),
  ];
  const reviews = ['2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07'].map((w) => mkReview(w, [`Won the ${v} pitch`], [`Missed ${v} call`], `Focus on ${v}`));
  const review = mkReview(WEEK, [`Won the ${v} pitch`, `Great ${v} week`], [`Missed ${v} call`, `Late for ${v}`]);
  const prof = mkProfile(profileWith(v));
  const s = settings(terms);
  const dash: DashboardInput = { quarter: q, quarterStart: quarterSpan(q.id).start, goals: Object.values(G), logs, energy, people: Object.values(P), touchpoints, crunch, actions, settings: s, today: SUNDAY };

  const closed = { ...q, status: 'closed' as const };
  const prevGoals = Object.values(G).map((g) => ({ ...g, grade: 'B' as const, closeDecision: 'carry' as const }));
  const q4 = mkQuarter('2026-Q4', { theme: `Beyond ${v}` });
  const drafts = [
    mkGoal({ ...prevGoals[0], id: nid('goal'), quarterId: '2026-Q4', startDate: '2026-10-01', deadline: '2026-12-31', carriedFromId: prevGoals[0].id, grade: undefined, closeDecision: undefined }, '2026-Q4'),
    mkGoal({ burner: 'health', title: `${v} half marathon`, type: 'milestone', milestones: [{ id: 'h1', title: `Register at ${v}` }, { id: 'h2', title: `Train with ${v}` }], why: `Prove ${v} wrong`, whenWhere: `Near ${v}`, order: 1 }, '2026-Q4'),
    mkGoal({ burner: 'work', title: `${v} reading`, type: 'number', target: 6, unit: `${v} books`, why: `Know ${v}`, whenWhere: `${v} flights`, order: 0 }, '2026-Q4'),
  ];
  return {
    weekly: { input: dash, reviews, review, weekStart: WEEK, profile: prof },
    checkin: { input: { ...dash, today: '2026-09-26' }, reviews: [...reviews, review], profile: prof, question: `Should I drop ${v} prep?` },
    setup: {
      draftQuarter: q4,
      draftGoals: drafts,
      previous: { ...dash, quarter: closed, goals: prevGoals, today: '2026-10-01', reviews: [...reviews, review] },
      quarters: [closed, q4],
      crunch,
      logs,
      goalsAll: [...prevGoals, ...drafts],
      reviews: [...reviews, review],
      settings: s,
      profile: prof,
      today: '2026-10-01',
    },
    onboarding: { profile: profileWith(v), people: Object.values(P), settings: s, today: '2026-09-26' },
  };
}

function buildAll(p: Planted): BuiltPacket[] {
  return [buildWeeklyPacket(p.weekly), buildCheckinPacket(p.checkin), buildQuarterSetupPacket(p.setup), buildOnboardingPacket(p.onboarding)];
}

function lines(p: BuiltPacket): string[] {
  return p.text.split('\n');
}

function line(p: BuiltPacket, prefix: string): string | undefined {
  return lines(p).find((l) => l.startsWith(prefix));
}

function tokens(s: string): number {
  return s.split(REDACTED).length - 1;
}

/** [redacted] tokens that are part of the fixed wording: the preamble, plus the onboarding ASK. */
function fixedTokens(p: BuiltPacket): number {
  return p.kind === 'onboarding' ? 2 : 1;
}

/** Letters and digits only, lowercased, with every invisible or combining character dropped. */
function skeleton(s: string): string {
  return s
    .normalize('NFKD')
    .replace(new RegExp(`[\\p{Cf}\\p{Mn}${ch(0x115f, 0x1160, 0x3164, 0xffa0)}]`, 'gu'), '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

const INVISIBLE_OR_FORMAT = new RegExp(`[\\p{Cf}${ch(0x34f, 0x115f, 0x1160, 0x17b4, 0x17b5)}${ch(0x180b)}-${ch(0x180f)}${ch(0x3164)}${ch(0xfe00)}-${ch(0xfe0f)}${ch(0xffa0)}]`, 'u');

function expectWellFormed(p: BuiltPacket) {
  const ls = lines(p);
  expect(ls[0]).toBe(PACKET_HEADER);
  expect(ls[ls.length - 1]).toBe(PACKET_END);
  expect(ls.filter((l) => l === PACKET_END)).toHaveLength(1);
  expect(ls.filter((l) => l.trim() === '')).toHaveLength(1);
  expect(ls.filter((l) => /^\s*suggested\s*actions/i.test(l))).toEqual(['Suggested actions:']);
  expect(ls.filter((l) => /^\s*end\s*of\s*packet/i.test(l))).toEqual([PACKET_END]);
  expect(p.text).not.toMatch(BANNED);
  expect(p.text).not.toMatch(/\r/);
  expect(p.chars).toBe(p.text.length);
}

// ---------------------------------------------------------------------------------------------
// Sanity: the planted world really prints the planted value in every field.

describe('adversarial fixture covers every user-written field', () => {
  it('prints the planted value in every line kind of every packet type', () => {
    const [w, c, s, o] = buildAll(planted('PLANTED', []));
    const has = (p: BuiltPacket, prefix: string, n = 1) => {
      const l = lines(p).filter((x) => x.startsWith(prefix));
      expect(l.length, `${p.kind}: ${prefix}`).toBeGreaterThan(0);
      expect(l.join('\n').split('PLANTED').length - 1, `${p.kind}: ${prefix}`).toBeGreaterThanOrEqual(n);
    };
    has(w, 'TYPE: ');
    has(w, 'ME: ', 6);
    has(w, 'CRUNCH: ', 2);
    has(w, 'LAST WK ACTIONS: ');
    has(w, 'PLANTED bedtime: ', 4); // title, why, when, note
    has(w, 'Plan the trip: ', 2); // next step and the step done this week
    has(w, 'Host PLANTED dinner: ', 3);
    has(w, 'Run 150 miles: ', 2); // unit and note
    has(w, 'Deep work: ', 3);
    has(w, 'people: PLANTED Mom', 2);
    has(w, 'people: Pal PLANTED', 3);
    has(w, 'WINS: ', 2);
    has(w, 'MISSES: ', 2);
    has(w, 'REPEAT misses: ');
    has(w, 'INTENT changes: ');
    has(c, 'TYPE: ');
    has(c, 'ME: ', 6);
    has(c, 'CRUNCH: ', 2);
    has(c, 'LAST REVIEW ', 3);
    has(c, 'MY QUESTION: ');
    has(c, 'people: Old PLANTED');
    has(s, 'TYPE: ');
    has(s, 'ME: ', 6);
    has(s, 'LAST FAMILY (', 1);
    has(s, 'LAST Q WINS: ');
    has(s, 'REPEAT misses last Q: ');
    has(s, 'CRUNCH history: ');
    has(s, 'PLANTED half marathon: ', 5);
    has(s, 'PLANTED reading: ', 4);
    for (const prefix of ['Life: ', 'Family people: ', 'Family win: ', 'Friends people: ', 'Friends win: ', 'Health focus: ', 'Health win: ', 'Work focus: ', 'Work win: ', 'Crunch: ']) has(o, prefix);
    has(o, 'KEY PEOPLE: ', 3);
  });
});

// ---------------------------------------------------------------------------------------------
// Sensitive terms hidden by Unicode tricks, joiners, and punctuation

const TERMS = ['Summit Wealth', 'Lakefront', 'J.P. Morgan', `Smith${EN}Barney`];
const TERM_SKELETONS = ['summitwealth', 'lakefront', 'jpmorgan', 'smithbarney'];

function expectNoTerm(p: BuiltPacket, label: string) {
  const sk = skeleton(p.text);
  for (const t of TERM_SKELETONS) expect(sk.includes(t), `${label}: ${p.kind} leaks ${t}`).toBe(false);
  expect(p.safe, `${label}: ${p.kind} ${p.problems.join(' ')}`).toBe(true);
  expect(p.text).not.toMatch(BANNED);
  expect(p.text, `${label}: ${p.kind} keeps an invisible character`).not.toMatch(INVISIBLE_OR_FORMAT);
  expect(p.stats.redactions, `${label}: ${p.kind} redaction count`).toBe(tokens(p.text) - fixedTokens(p));
}

describe('adversarial: sensitive terms never survive, however they are spelled', () => {
  const variants: [string, string][] = [
    ['plain', 'Summit Wealth'],
    ['Unicode hyphen U+2010', `Summit${ch(0x2010)}Wealth`],
    ['non-breaking hyphen U+2011', `Summit${ch(0x2011)}Wealth`],
    ['minus sign U+2212', `Summit${ch(0x2212)}Wealth`],
    ['em dash between the words', `Summit${EM}Wealth`],
    ['spaced en dash between the words', `Summit ${EN} Wealth`],
    ['invisible separator U+2063', `Summit${ch(0x2063)}Wealth`],
    ['right-to-left override U+202E', `Summit${ch(0x202e)}Wealth`],
    ['bidi isolate U+2066', `Summit${ch(0x2066)} Wealth`],
    ['combining grapheme joiner U+034F', `Sum${ch(0x34f)}mit Wealth`],
    ['variation selector U+FE0F', `Summit${ch(0xfe0f)} Wealth`],
    ['Mongolian vowel separator U+180E', `Summit${ch(0x180e)}Wealth`],
    ['Hangul filler U+3164', `Summit${ch(0x3164)}Wealth`],
    ['tag characters', `Summit${ch(0xe0041)}Wealth`],
    ['full-width letters', `${ch(0xff33)}ummit ${ch(0xff37)}ealth`],
    ['hyphenated single-word term', 'Lake-front'],
    ['underscored single-word term', 'lake_front'],
    ['dotted single-word term', 'Lake.front'],
    ['em dash inside a single-word term', `Lake${EM}front`],
    ['Unicode hyphen inside a single-word term', `LAKE${ch(0x2010)}FRONT`],
    ['term entered with dots, typed without', 'JP Morgan'],
    ['term entered with dots, typed joined', 'JPMorgan'],
    ['term entered with dots, typed hyphenated', 'jp-morgan'],
    ['term entered with an en dash, typed exactly', `Smith${EN}Barney`],
    ['term entered with an en dash, typed with a space', 'Smith Barney'],
    ['term entered with an en dash, typed joined', 'SmithBarney'],
    ['term entered with an en dash, typed hyphenated', 'Smith-Barney'],
  ];
  for (const [label, v] of variants) {
    it(`${label}: redacted in every field of every packet type`, () => {
      for (const p of buildAll(planted(v, TERMS))) {
        expectWellFormed(p);
        expectNoTerm(p, label);
      }
    });
  }

  it('a term that only appears after sanitizing (em dash becomes ", ") is redacted', () => {
    const terms = ['Smith, Jones'];
    for (const p of buildAll(planted(`Smith${EM}Jones`, terms))) {
      expect(skeleton(p.text)).not.toContain('smithjones');
      expect(p.safe).toBe(true);
    }
  });

  it('a term formed only by the template joining two fields is still redacted (finalize is the safety net)', () => {
    // The people line prints "{{name}} {{type}} {{dows}}": the name alone and the word "text" alone are fine,
    // but together they spell the term.
    const pl = planted('Harbor', ['Harbor Text']);
    const p = buildWeeklyPacket(pl.weekly);
    expect(line(p, 'people: Pal ')).toBe(`people: Pal ${REDACTED} Fri "He joined Harbor"; Old Harbor OVERDUE 50d (every 14d)`);
    expect(p.text).not.toMatch(/harbor\s*text/i);
    expect(p.safe).toBe(true);
    expect(p.stats.redactions).toBe(tokens(p.text) - 1);
  });

  it('two fields on consecutive lines never fuse into one redaction that swallows a line break', () => {
    // Goal A's "when" ends with "Summit" and the next goal's title starts with "Wealth": each field alone is
    // fine, and redacting across the newline would silently merge two packet lines into one.
    const pl = planted('Fine', TERMS);
    const goals = pl.weekly.input.goals.map((g) => (g.title === 'Deep work' ? { ...g, whenWhere: 'Tuesdays at the Summit' } : g));
    goals.push(mkGoal({ burner: 'work', title: 'Wealth of reading', type: 'habit', target: 1, habitPeriod: 'week', why: 'w', whenWhere: 'x', order: 5 }));
    const input = { ...pl.weekly.input, goals, logs: pl.weekly.input.logs.map((l) => ({ ...l, note: undefined })) };
    for (const p of [buildWeeklyPacket({ ...pl.weekly, input }), buildCheckinPacket({ ...pl.checkin, input: { ...input, today: '2026-09-26' } })]) {
      expectWellFormed(p);
      expect(line(p, 'Deep work: '), p.kind).toMatch(/\| when: Tuesdays at the Summit$/);
      expect(line(p, 'Wealth of reading: '), p.kind).toBeDefined();
      expect(p.safe, p.problems.join(' ')).toBe(true);
    }
    expect(finalizePacket('a Summit\nWealth b', TERMS)).toBe('a Summit\nWealth b');
  });

  it('a term split across a field cap is never left half visible', () => {
    for (const v of [`${'word '.repeat(10)}Summit${EM}Wealth partners and more words here`, `${'x'.repeat(50)} Lake-front`]) {
      for (const p of buildAll(planted(v, TERMS))) expectNoTerm(p, 'capped');
    }
  });

  it('possessives, plurals, and punctuation around a term', () => {
    for (const v of [`Summit${ch(0x2010)}Wealth's`, '(Lake-front)', 'Lake-fronts', '#Summit_Wealth,', `"Lake${EM}front"`]) {
      for (const p of buildAll(planted(v, TERMS))) expectNoTerm(p, v);
    }
  });

  it('a short term glued to digits is redacted ("JPM2026"), without touching other words', () => {
    for (const v of ['JPM2026 offsite', 'Q4JPM review', 'the jpm2027 plan']) {
      for (const p of buildAll(planted(v, ['JPM']))) {
        expect(p.text, `${p.kind}: ${v}`).not.toMatch(/jpm/i);
        expect(p.safe).toBe(true);
      }
    }
    const p = buildWeeklyPacket(planted('JPM2026 at 6am, Q3', ['JPM']).weekly);
    expect(line(p, 'TYPE: ')).toContain(`theme: ${REDACTED} 2026 at 6am, Q3 year`);
  });

  it('a dash or joiner next to a digit never hides a term with a digit in it', () => {
    const cases: [string[], string, RegExp][] = [
      [['Fund 3'], `Fund${EM}3 memo`, /fund\W*3/i],
      [['Fund3'], 'Fund-3 memo', /fund\W*3/i],
      [['Fund3'], `Fund${EN}3 memo`, /fund\W*3/i],
      [['401 Partners'], `401${EM}Partners memo`, /401\W*partners/i],
    ];
    for (const [terms, v, re] of cases) {
      for (const p of buildAll(planted(v, terms))) {
        expect(p.text, `${p.kind}: ${v}`).not.toMatch(re);
        expect(p.safe).toBe(true);
      }
    }
    // Digit ranges still read "3 to 4" when no term hides behind them.
    expect(line(buildWeeklyPacket(planted(`3${EN}4 runs`, ['Fund3']).weekly), 'TYPE: ')).toContain('theme: 3 to 4 runs year');
  });

  it('accents never hide a term, in either direction', () => {
    const cases: [string[], string, string][] = [
      [['Societe Generale'], `Soci${ch(0xe9)}t${ch(0xe9)} G${ch(0xe9)}n${ch(0xe9)}rale`, 'societegenerale'],
      [[`Cr${ch(0xe9)}dit Agricole`], 'Credit Agricole', 'creditagricole'],
      [[`Nestl${ch(0xe9)}`], 'nestle', 'nestle'],
      [['Nestle'], `NESTL${ch(0xc9)}`, 'nestle'],
    ];
    for (const [terms, v, sk] of cases) {
      for (const p of buildAll(planted(`${v} review`, terms))) {
        expect(skeleton(p.text), `${p.kind}: ${v}`).not.toContain(sk);
        expect(p.safe).toBe(true);
      }
    }
  });

  it('only the word that hides a term changes: other hyphens, accents, and digits stay as typed', () => {
    const p = buildWeeklyPacket(planted(`Lake-front check-in, caf${ch(0xe9)} at 6am`, TERMS).weekly);
    expect(line(p, 'TYPE: ')).toContain(`theme: ${REDACTED} check-in, caf${ch(0xe9)} at 6am year`);
    const q = buildWeeklyPacket(planted(`Summit${EM}Wealth, less${EM}more`, TERMS).weekly);
    expect(line(q, 'TYPE: ')).toContain(`theme: ${REDACTED}, less-more year`);
  });

  it('ordinary hyphens, dashes, and dots are left alone when no term hides behind them', () => {
    const p = buildWeeklyPacket(planted('check-in', TERMS).weekly);
    expect(line(p, 'check-in bedtime: ')).toContain('| why: So check-in waits | when: After check-in calls');
    const q = buildWeeklyPacket(planted(`less${EM}more`, TERMS).weekly);
    expect(line(q, 'TYPE: ')).toContain('theme: less, more year');
    expect(q.stats.redactions).toBe(0);
  });
});

describe('adversarial: invisible and look-alike characters', () => {
  it('bidi controls, zero-width characters, and selectors never reach the packet', () => {
    const v = `Date${ch(0x200b)}night ${ch(0x202e)}reversed${ch(0x202c)} ${ch(0x2066)}iso${ch(0x2069)} tag${ch(0xe0041)} cgj${ch(0x34f)} vs${ch(0xfe0f)}`;
    for (const p of buildAll(planted(v, []))) {
      expect(p.text, p.kind).not.toMatch(INVISIBLE_OR_FORMAT);
      expect(p.text).toContain('Datenight reversed iso tag cgj vs');
    }
  });

  it('Unicode hyphens and minus signs print as a plain hyphen', () => {
    const p = buildWeeklyPacket(planted(`check${ch(0x2010)}in ${ch(0x2212)}5`, []).weekly);
    expect(line(p, 'TYPE: ')).toContain('theme: check-in -5 year');
    expect(p.text).not.toMatch(new RegExp(`[${ch(0x2010, 0x2011, 0x2212)}]`));
  });
});

describe('adversarial: the Copy gate and finalizePacket catch hidden terms too', () => {
  it('packetGate flags terms hidden by invisible characters, Unicode hyphens, dashes, or joiners', () => {
    for (const text of [
      `Met Summit${ch(0x2063)}Wealth today`,
      `Met Summit${ch(0x2010)}Wealth today`,
      `Met Summit${EM}Wealth today`,
      'Met at the Lake-front today',
      'Met JP Morgan today',
      'Met Smith Barney today',
    ]) {
      const g = packetGate(text, TERMS, []);
      expect(g.safe, text).toBe(false);
      expect(g.problems[0], text).toContain('sensitive term');
    }
    expect(packetGate('Met the check-in crew today', TERMS, []).safe).toBe(true);
  });

  it('the gate names the user own term once, dash free (the reason is shown in the UI)', () => {
    const g = packetGate('Met Smith Barney and SmithBarney and JP Morgan today', TERMS, []);
    expect(g.problems).toEqual(['A sensitive term is still in the packet (J.P. Morgan, Smith-Barney).']);
    expect(g.problems.join(' ')).not.toMatch(BANNED);
  });

  it('finalizePacket drops invisible characters, maps Unicode hyphens, redacts, and stays idempotent', () => {
    const raw = `A Summit${ch(0x2011)}Wealth B${ch(0x200b)}C ${ch(0x202e)}D check${ch(0x2010)}in`;
    const once = finalizePacket(raw, TERMS);
    expect(once).toBe(`A ${REDACTED} BC D check-in`);
    expect(finalizePacket(once, TERMS)).toBe(once);
  });
});

// ---------------------------------------------------------------------------------------------
// Private notes

describe('adversarial: private notes and edit history', () => {
  it('quarter setup: private touchpoint notes and every earlier note version stay out', () => {
    const pl = planted('Fine', []);
    const logs = pl.setup.logs.map((l, i) =>
      i % 7 === 0 ? { ...l, edits: [{ at: l.at, prevValue: 2, prevNote: `SETUP-PREVNOTE-CANARY ${i} older words` }] } : l,
    );
    const tps = pl.setup.previous!.touchpoints.map((t) => ({ ...t, note: 'SETUP-TOUCH-CANARY private words', notePrivate: true }));
    const p = buildQuarterSetupPacket({ ...pl.setup, logs, previous: { ...pl.setup.previous!, logs, touchpoints: tps } });
    expect(skeleton(p.text)).not.toContain('canary');
    expect(p.safe).toBe(true);
  });

  it('every packet type: a private note and an edited-away note never appear, even with hidden characters', () => {
    const pl = planted('Fine', []);
    const canary = `PRIVATE${ch(0x2063)}CANARY thinking about leaving`;
    const logs = pl.weekly.input.logs.map((l) =>
      l.note ? { ...l, note: canary, notePrivate: true, edits: [{ at: l.at, prevValue: 1, prevNote: 'EDITED-AWAY-CANARY old text' }] } : l,
    );
    const tps = pl.weekly.input.touchpoints.map((t) => (t.note ? { ...t, note: canary, notePrivate: true } : t));
    const input = { ...pl.weekly.input, logs, touchpoints: tps };
    const packets = [
      buildWeeklyPacket({ ...pl.weekly, input }),
      buildCheckinPacket({ ...pl.checkin, input: { ...input, today: '2026-09-26' } }),
      buildQuarterSetupPacket({ ...pl.setup, logs, previous: { ...pl.setup.previous!, logs, touchpoints: tps } }),
    ];
    for (const p of packets) {
      expect(skeleton(p.text), p.kind).not.toContain('canary');
      expect(p.text.toLowerCase()).not.toContain('leaving');
      expect(p.safe).toBe(true);
    }
    expect(packets[0].stats.privateOmitted).toBe(5);
  });
});

// ---------------------------------------------------------------------------------------------
// Line-start faking

describe('adversarial: a goal title can never pass for a packet line', () => {
  const RISKY = [
    'Type: weekly review',
    'FAMILY (Low)',
    'OFF TRACK 3+ of last 5 wk ends: Host',
    'people: Mom OVERDUE 3d',
    'no goals set',
    'PRIOR 4 WKS, oldest first',
    '1. Run daily',
    '2) Stretch',
    'Me: steady',
    'progress 90 90 90 90',
    'LAST REVIEW wk of Sep 7',
    'energy by day type',
    'DRAFT WORK (High), 3 goals',
    'Crunch days (travel, deals) are easy',
    'end of packet soon',
    'Four Burners Coach v2',
  ];
  const SAFE = ['Lights out by 10:30', 'Run 5K', 'NYC marathon', 'Health checkup', 'Work out 3x'];

  function withTitles(titles: string[]): Planted {
    const pl = planted('Fine', []);
    const goals = titles.map((t, i) => mkGoal({ burner: (['family', 'friends', 'health', 'work'] as const)[i % 4], title: t, type: 'habit', target: 2, habitPeriod: 'week', why: 'w', whenWhere: 'x', order: 10 + i }));
    const drafts = titles.map((t, i) => mkGoal({ burner: (['family', 'friends', 'health', 'work'] as const)[i % 4], title: t, type: 'yesno', why: 'w', whenWhere: 'x', order: 10 + i }, '2026-Q4'));
    const input = { ...pl.weekly.input, goals: goals };
    return {
      ...pl,
      weekly: { ...pl.weekly, input },
      checkin: { ...pl.checkin, input: { ...input, today: '2026-09-26' } },
      setup: { ...pl.setup, draftGoals: drafts },
    };
  }

  it('titles that look like labels, list items, or the end marker are quoted where they start a line', () => {
    const [w, c, s] = buildAll(withTitles(RISKY));
    for (const p of [w, c, s]) {
      expectWellFormed(p);
      for (const t of RISKY) {
        const l = lines(p).find((x) => x.includes(t));
        expect(l, `${p.kind}: ${t}`).toBeDefined();
        expect(l!.startsWith(`'${t}': `), `${p.kind}: ${l}`).toBe(true);
      }
      expect(lines(p).filter((l) => /^type:/i.test(l))).toHaveLength(1);
      expect(lines(p).filter((l) => /^(family|friends|health|work) \(/i.test(l)).length).toBeLessThanOrEqual(4);
      expect(lines(p).filter((l) => /^\d{1,2}[.)]\s/.test(l))).toEqual([]);
    }
  });

  it('ordinary titles, including clock times, are not quoted', () => {
    const [w, c, s] = buildAll(withTitles(SAFE));
    for (const p of [w, c, s]) for (const t of SAFE) expect(lines(p).some((l) => l.startsWith(`${t}: `)), `${p.kind}: ${t}`).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Preamble, formats, empty data

describe('adversarial: preamble, formats, and empty data', () => {
  it('every packet opens with the preamble exactly as the design doc ships it', () => {
    const doc = readFileSync(new URL('../../../docs/coach-design.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const m = doc.match(/## Shared preamble \(ships exactly\)\n\n```\n([\s\S]*?)\n```/);
    expect(m).not.toBeNull();
    const preamble = m![1];
    expect(preamble.split('\n')).toHaveLength(11);
    for (const p of buildAll(planted('Fine', []))) expect(p.text.startsWith(`${preamble}\n\n`), p.kind).toBe(true);
  });

  it('numbers keep at most 1 decimal and dates print as "Sep 14": no ISO dates, NaN, or undefined', () => {
    for (const p of buildAll(planted('Fine', []))) {
      expect(p.text, p.kind).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(p.text, p.kind).not.toMatch(/\d\.\d{2,}/);
      expect(p.text, p.kind).not.toMatch(/\d\.0(?!\d)/);
      expect(p.text, p.kind).not.toMatch(/undefined|NaN|null|\[object|Infinity/);
    }
  });

  it('empty data: all four packet types build, are well formed, and print no placeholder junk', () => {
    const q = mkQuarter('2026-Q3');
    const dash: DashboardInput = { quarter: q, quarterStart: '2026-07-01', goals: [], logs: [], energy: [], people: [], touchpoints: [], crunch: [], settings: settings([]), today: '2026-07-01' };
    const packets = [
      buildWeeklyPacket({ input: dash, reviews: [], review: mkReview('2026-06-29', [], []), weekStart: '2026-06-29' }),
      buildCheckinPacket({ input: dash, reviews: [] }),
      buildQuarterSetupPacket({ draftQuarter: mkQuarter('2026-Q4'), draftGoals: [], previous: null, quarters: [], crunch: [], logs: [], goalsAll: [], reviews: [], settings: settings([]), today: '2026-09-26' }),
      buildOnboardingPacket({ profile: EMPTY_PROFILE_FIELDS, settings: settings([]), today: '2026-09-26' }),
    ];
    for (const p of packets) {
      expectWellFormed(p);
      expect(p.safe).toBe(true);
      expect(p.text).not.toMatch(/undefined|NaN|null|\[object/);
    }
  });

  it('goals missing a target never print a zero requirement', () => {
    const pl = planted('Fine', []);
    const goals = [
      mkGoal({ burner: 'health', title: 'Walk more', type: 'habit', habitPeriod: 'week', order: 5 }),
      mkGoal({ burner: 'health', title: 'Swim more', type: 'habit', habitPeriod: 'month', order: 6 }),
    ];
    const logs = [...pl.weekly.input.logs, mkLog(goals[0].id, '2026-09-15'), mkLog(goals[1].id, '2026-09-16')];
    const input = { ...pl.weekly.input, goals: [...pl.weekly.input.goals, ...goals], logs };
    const w = buildWeeklyPacket({ ...pl.weekly, input });
    const c = buildCheckinPacket({ ...pl.checkin, input: { ...input, today: '2026-09-26' } });
    expect(line(w, 'Walk more: ')).toMatch(/^Walk more: wk 1 \(Tue\), NO TARGET, pace /);
    expect(line(w, 'Swim more: ')).toMatch(/^Swim more: mo 1, NO TARGET, wk 1 \(Wed\), pace /);
    expect(line(c, 'Walk more: ')).toMatch(/^Walk more: 1, NO TARGET, pace /);
    expect(line(c, 'Swim more: ')).toMatch(/^Swim more: 1, NO TARGET, pace /);
    for (const p of [w, c]) expect(p.text).not.toMatch(/\/0 \(|\/\?/);
  });
});

// ---------------------------------------------------------------------------------------------
// Budgets and coaching quality

const PLACEHOLDER_PROFILE: ProfileFields = {
  lifeContext:
    'Married to Sarah, two kids, 9 and 12. Home base is Charlotte, but I am on a plane most weeks. Work is the busiest it has been, and I want to be more present at home than I was last year.',
  burners: {
    family: { matters: 'Sarah, every week. Maya and Luke, every week. Mom, every week.', winning: 'Home for dinner most nights I am in town. Two real date nights a month. The kids would say I was around, and the winter trip is booked.' },
    friends: { matters: 'Jake, every two weeks. Priya and Marcus, monthly.', winning: 'I reached out before they had to. We hosted one dinner at our place, and I made the October golf weekend.' },
    health: { matters: 'Running and lifting keep me sane.', winning: 'Three workouts a week, even on travel weeks. Lights out by 10:30 most nights. A half marathon on the calendar for spring.' },
    work: { matters: 'I lead acquisitions and business development.', winning: 'Deep work four mornings a week. Follow up on everything within a day. Out of the office by 6:30 when I am home. Fewer reactive days, more thinking time.' },
  },
  travel: 'weekly',
  crunch:
    'A few times a year a closing takes over for two or three weeks: late nights, early flights. Workouts and friend calls slip first. Bedtime with the kids is the one I protect.',
};

describe('adversarial: coaching quality', () => {
  it('ME keeps every burner win, Travel, and Crunch when interview answers are long (fair share, not first come)', () => {
    const pl = planted('Fine', []);
    const prof = mkProfile(PLACEHOLDER_PROFILE);
    const packets = [
      buildWeeklyPacket({ ...pl.weekly, profile: prof }),
      buildCheckinPacket({ ...pl.checkin, profile: prof }),
      buildQuarterSetupPacket({ ...pl.setup, profile: prof }),
    ];
    for (const p of packets) {
      const me = line(p, 'ME: ')!;
      expect(me.length, p.kind).toBeLessThanOrEqual(4 + 450);
      for (const label of ['Life: Married to Sarah', '| Family: Home for dinner', '| Friends: I reached out', '| Health: Three workouts', '| Work: Deep work', '| Travel: Most weeks', '| Crunch: A few times a year']) {
        expect(me, `${p.kind}: ${label}`).toContain(label);
      }
    }
  });

  it('a short profile prints whole, and the ladder cut to 250 still keeps Travel and Crunch', () => {
    const pl = planted('Fine', []);
    const w = buildWeeklyPacket(pl.weekly);
    expect(line(w, 'ME: ')).toBe(
      'ME: Life: Home with Fine nearby. | Family: Dinner before Fine calls. | Friends: Reach out to Fine friends. | Health: Three runs past Fine. | Work: Deep work, no Fine fire drills. | Travel: Most weeks | Crunch: Fine closings take over.',
    );
    const bloated = { ...pl.weekly, profile: mkProfile(PLACEHOLDER_PROFILE) };
    bloated.input = { ...bloated.input, goals: bloated.input.goals.map((g) => ({ ...g, why: `${g.title} ${'because it matters '.repeat(6)}`, whenWhere: `${g.title} ${'on the right mornings '.repeat(5)}` })) };
    bloated.review = mkReview(WEEK, Array.from({ length: 6 }, (_, i) => `Win ${i} ${'more words here '.repeat(8)}`), Array.from({ length: 6 }, (_, i) => `Miss ${i} ${'more words here '.repeat(8)}`));
    const p = buildWeeklyPacket(bloated);
    expect(p.stats.trimmed).toContain('ME shortened');
    const me = line(p, 'ME: ')!;
    expect(me.length).toBeLessThanOrEqual(4 + 250);
    expect(me).toContain('| Travel: Most weeks');
    expect(me).toContain('| Crunch: ');
  });

  it('every slipping goal keeps its why and when under the heaviest trimming, in weekly and check-in', () => {
    const pl = planted('Fine', []);
    const goals = (['family', 'friends', 'health', 'work'] as const).flatMap((b) =>
      [0, 1, 2, 3].map((i) =>
        mkGoal({ burner: b, title: `${b} goal ${i}`, type: 'yesno', why: `Why ${b} ${i} ${'it matters to me '.repeat(5)}`, whenWhere: `When ${b} ${i} ${'on the right day '.repeat(5)}`, order: i }),
      ),
    );
    const input = { ...pl.weekly.input, goals, logs: [] };
    const w = buildWeeklyPacket({ ...pl.weekly, input, profile: mkProfile(PLACEHOLDER_PROFILE) });
    const c = buildCheckinPacket({ ...pl.checkin, input: { ...input, today: '2026-09-26' }, profile: mkProfile(PLACEHOLDER_PROFILE), question: 'What to drop? '.repeat(20) });
    for (const p of [w, c]) {
      expectWellFormed(p);
      expect(p.stats.trimmed).not.toContain('when on on-track goals');
      expect(p.stats.trimmed).not.toContain('why on on-track goals');
      for (const g of goals) {
        const l = line(p, `${g.title}: `)!;
        expect(l, g.title).toMatch(/SLIPPING \| why: Why .* \| when: When /);
      }
      expect(line(p, 'ASK: ')).toBeDefined();
      expect(line(p, 'TYPE: ')).toBeDefined();
    }
    expect(line(c, 'MY QUESTION: ')).toBeDefined();
  });

  it('crunch is flagged in every packet type that has one, and the ASK plans around one ahead', () => {
    const [w, c, s] = buildAll(planted('Fine', []));
    expect(line(w, 'DAYS')).toMatch(/Thu \d crunch/);
    expect(line(w, 'CRUNCH: ')).toBe('CRUNCH: Thu ("Fine close"). Ahead: Wed Sep 23 to Fri Sep 25 ("Fine trip")');
    expect(line(w, 'ASK: ')).toContain('Plan next week around the crunch ahead.');
    expect(line(c, 'CRUNCH: ')).toBe('CRUNCH: Sep 17 ("Fine close"), Sep 23 to 25 ("Fine trip")');
    expect(line(c, 'NOW: ')).toContain('crunch days 14d 4');
    expect(line(s, 'CRUNCH history: ')).toContain('Planned: Oct 12 to 16 ("Fine offsite")');
  });
});
