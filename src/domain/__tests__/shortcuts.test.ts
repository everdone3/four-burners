import { describe, expect, it } from 'vitest';
import {
  canLinkHealth,
  healthDate,
  healthLogId,
  healthReply,
  logReply,
  matchByName,
  nameWords,
  notFoundReply,
  parseAmount,
  parseAt,
  parseTouchType,
  planHealthLogs,
  planLog,
  readHealthDay,
  stampFor,
  touchReply,
} from '../shortcuts';
import type { Goal, LogEntry, Person } from '../types';

const T = '2026-07-01T12:00:00Z';
const goal = (id: string, over: Partial<Goal> = {}): Goal => ({
  id, burner: 'health', title: id, type: 'habit', target: 2, habitPeriod: 'week', startDate: '2026-07-01', deadline: '2026-09-30',
  quarterId: '2026-Q3', order: 0, createdAt: T, updatedAt: T, ...over,
});
const names = (xs: string[]) => xs.map((title) => ({ title }));
const pick = (xs: string[], q: string) => {
  const m = matchByName(names(xs), q, (x) => x.title);
  return m.kind === 'match' ? m.item.title : m.kind === 'ambiguous' ? m.items.map((i) => i.title) : null;
};

describe('names', () => {
  it('normalizes words: case, accents, punctuation, filler', () => {
    expect(nameWords('My Date-Night goal!')).toEqual(['date', 'night']);
    expect(nameWords('Café with Zoë')).toEqual(['cafe', 'with', 'zoe']);
    expect(nameWords("Mom's call")).toEqual(['moms', 'call']);
    expect(nameWords('The')).toEqual(['the']);
  });

  const goals = ['Date night', 'Run 300 miles', 'Read 12 books', 'Lift 3x a week', 'Night walk'];
  it('finds a goal by what Siri heard', () => {
    expect(pick(goals, 'date night')).toBe('Date night');
    expect(pick(goals, 'Log my date night goal')).toBe('Date night');
    expect(pick(goals, 'run')).toBe('Run 300 miles');
    expect(pick(goals, 'books')).toBe('Read 12 books');
    expect(pick(goals, 'lift')).toBe('Lift 3x a week');
  });

  it('exact wins over partial, and says when it is ambiguous', () => {
    expect(pick(['Walk', 'Walk the dog'], 'walk')).toBe('Walk');
    expect(pick(goals, 'night')).toBe('Night walk'); // a name that starts with it wins
    expect(pick(['Date night', 'Late night'], 'night')).toEqual(['Date night', 'Late night']);
    expect(pick(goals, 'swim')).toBeNull();
    expect(pick(goals, '  ')).toBeNull();
  });
});

describe('time from the phone', () => {
  const now = new Date('2026-10-03T01:30:00Z');
  it('reads Shortcuts ISO dates with their offset', () => {
    expect(parseAt('2026-10-02T20:15:03-05:00')).toEqual({ instant: new Date('2026-10-03T01:15:03Z'), offsetMin: -300 });
    expect(parseAt('2026-10-02T20:15-0500')?.offsetMin).toBe(-300);
    expect(parseAt('2026-10-03T10:15:00+09:00')?.offsetMin).toBe(540);
    expect(parseAt('2026-10-03T01:15:00Z')?.offsetMin).toBe(0);
    for (const bad of ['Oct 2, 2026 at 8:15 PM', '2026-10-02', '2026-10-02T20:15:00', '2026-10-02T20:15:00+15:00', 5, null]) expect(parseAt(bad)).toBeNull();
  });

  it('dates the entry to the day lived where the phone is', () => {
    expect(stampFor('2026-10-02T20:15:00-05:00', 3, 0, now)).toEqual({ at: '2026-10-03T01:15:00.000Z', offsetMin: -300, localDate: '2026-10-02' });
    // 1:00 AM before a 3 AM boundary belongs to the day before.
    expect(stampFor('2026-10-03T01:00:00+09:00', 3, 0, new Date('2026-10-02T16:30:00Z')).localDate).toBe('2026-10-02');
  });

  it('falls back to the server clock in the given zone when the phone time is missing or way off', () => {
    expect(stampFor(undefined, 3, -300, now)).toEqual({ at: now.toISOString(), offsetMin: -300, localDate: '2026-10-02' });
    expect(stampFor('2020-01-01T10:00:00Z', 3, -300, now).at).toBe(now.toISOString());
    expect(stampFor('2026-10-05T10:00:00Z', 3, -300, now).at).toBe(now.toISOString());
  });
});

describe('amounts and touch types', () => {
  it('parses amounts', () => {
    expect(parseAmount(3)).toBe(3);
    expect(parseAmount('2.5')).toBe(2.5);
    expect(parseAmount('8,432')).toBe(8432);
    expect(parseAmount('2,5')).toBe(2.5);
    for (const bad of [0, -1, 'abc', '', null, undefined, Infinity, 1e9]) expect(parseAmount(bad)).toBeNull();
  });
  it('reads how you connected', () => {
    expect(parseTouchType('Phone call')).toBe('call');
    expect(parseTouchType('FaceTime')).toBe('call');
    expect(parseTouchType('iMessage')).toBe('text');
    expect(parseTouchType('In person')).toBe('in_person');
    expect(parseTouchType('in-person')).toBe('in_person');
    expect(parseTouchType('coffee')).toBe('in_person');
    expect(parseTouchType('letter')).toBe('other');
    expect(parseTouchType(undefined)).toBe('other');
  });
});

describe('logging by voice', () => {
  it('needs an amount only for Number goals; Milestone goals stay in the app', () => {
    expect(planLog(goal('Run', { type: 'number', target: 300, unit: 'miles' }), '3.1')).toEqual({ ok: true, value: 3.1, source: 'shortcut' });
    expect(planLog(goal('Run', { type: 'number', unit: 'miles' }), undefined)).toEqual({ ok: false, message: 'How much for "Run"? Send an amount in miles.' });
    expect(planLog(goal('Date night'), undefined)).toMatchObject({ ok: true, value: 1 });
    expect(planLog(goal('Date night'), 2)).toMatchObject({ ok: true, value: 2 });
    expect(planLog(goal('Date night'), 2.5)).toMatchObject({ ok: true, value: 1 });
    expect(planLog(goal('Will', { type: 'yesno' }), 7)).toMatchObject({ ok: true, value: 1 });
    expect(planLog(goal('Launch', { type: 'milestone' }), 1)).toMatchObject({ ok: false });
  });

  it('replies with progress including the new log', () => {
    const g = goal('Run 300 miles', { type: 'number', target: 300, unit: 'miles' });
    const logs: LogEntry[] = [10, 3.1].map((v, i) => ({ id: `l${i}`, goalId: g.id, value: v, localDate: '2026-08-01', at: T, offsetMin: 0, createdAt: T, updatedAt: T }));
    expect(logReply(g, 3.1, logs, '2026-08-01', 'high')).toBe('Logged 3.1 miles to "Run 300 miles". 13.1 of 300 so far.');
    expect(logReply(goal('Will', { type: 'yesno' }), 1, [], '2026-08-01', 'low')).toBe('Marked "Will" done. Nice work.');
    const p: Person = { id: 'p', name: 'Sam', burner: 'friends', cadenceDays: 7, order: 0, createdAt: T, updatedAt: T };
    expect(touchReply(p, 'in_person')).toBe('Logged a time in person with Sam.');
    expect(notFoundReply('goal', 'swim', ['Run', 'Read'])).toBe('No goal matches "swim". Try one of: Run, Read.');
  });
});

describe('Apple Health', () => {
  it('reads a day of numbers, dropping nonsense', () => {
    expect(readHealthDay({ steps: '8,432', workouts: 1, activeMinutes: '41.6', sleepHours: 7.25 })).toEqual({ steps: 8432, workouts: 1, activeMinutes: 42, sleepHours: 7.3 });
    expect(readHealthDay({ sleepMinutes: 450, exerciseMinutes: 30 })).toEqual({ sleepHours: 7.5, activeMinutes: 30 });
    expect(readHealthDay({ sleepSeconds: 27000 })).toEqual({ sleepHours: 7.5 });
    expect(readHealthDay({ steps: 9_999_999, workouts: 'lots', sleepHours: 30 })).toEqual({});
    expect(readHealthDay({ workouts: 0 })).toEqual({ workouts: 0 });
  });

  const steps = goal('Walk 900k steps', { type: 'number', target: 900_000, health: { metric: 'steps' } });
  const lift = goal('Work out 3x a week', { target: 3, health: { metric: 'workouts' } });
  const sleep = goal('Sleep 7 hours', { target: 5, health: { metric: 'sleepHours', min: 7 } });
  const unlinked = goal('Stretch');
  const family = goal('Family walks', { burner: 'family', health: { metric: 'steps' } });

  it('turns a day into logs on linked goals', () => {
    const plan = planHealthLogs([steps, lift, sleep, unlinked, family], { steps: 9120, workouts: 2, sleepHours: 6.5 }, '2026-08-01');
    expect(plan.map((p) => [p.goal.title, p.value, p.id])).toEqual([
      ['Walk 900k steps', 9120, healthLogId(steps.id, '2026-08-01')],
      ['Work out 3x a week', 1, 'health-Work out 3x a week-2026-08-01'],
    ]);
    expect(planHealthLogs([sleep], { sleepHours: 7 }, '2026-08-01')).toHaveLength(1);
    // A Habit day already logged by hand is not counted again; Number goals still add the amount.
    expect(planHealthLogs([steps, lift], { steps: 100, workouts: 1 }, '2026-08-01', new Set([lift.id, steps.id])).map((p) => p.goal.title)).toEqual(['Walk 900k steps']);
  });

  it('skips days outside a goal, zeros and deleted goals', () => {
    expect(planHealthLogs([steps], { steps: 100 }, '2026-10-01')).toEqual([]);
    expect(planHealthLogs([steps], { steps: 0 }, '2026-08-01')).toEqual([]);
    expect(planHealthLogs([{ ...steps, deleted: true }], { steps: 100 }, '2026-08-01')).toEqual([]);
    expect(planHealthLogs([{ ...steps, type: 'milestone' }], { steps: 100 }, '2026-08-01')).toEqual([]);
    expect(canLinkHealth({ burner: 'work', type: 'number' })).toBe(false);
  });

  it('takes a recent date from the Shortcut, otherwise today', () => {
    expect(healthDate('2026-08-01', '2026-08-02')).toBe('2026-08-01');
    expect(healthDate('2026-07-01', '2026-08-02')).toBe('2026-08-02');
    // Just after midnight, before the day boundary: the phone's new calendar day is accepted.
    expect(healthDate('2026-08-03', '2026-08-02')).toBe('2026-08-03');
    expect(healthDate('2026-08-04', '2026-08-02')).toBe('2026-08-02');
    expect(healthDate('Aug 1', '2026-08-02')).toBe('2026-08-02');
  });

  it('says what it did', () => {
    const plan = planHealthLogs([steps, lift], { steps: 9120, workouts: 1 }, '2026-08-01');
    expect(healthReply(plan, { steps: 9120, workouts: 1 }, '2026-08-01')).toBe('Health for 2026-08-01: 9,120 steps to "Walk 900k steps"; "Work out 3x a week" counted.');
    expect(healthReply([], {}, '2026-08-01')).toMatch(/^No Health numbers/);
    expect(healthReply([], { steps: 5 }, '2026-08-01')).toMatch(/No linked goal/);
    for (const s of [healthReply(plan, { steps: 1 }, 'x'), notFoundReply('person', 'x', [])]) expect(s).not.toMatch(/—/);
  });
});
