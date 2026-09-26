import { describe, expect, it } from 'vitest';
import { checkGoal, elapsedFraction, goalProgress, goalSlot, requiredFor } from '../goals';
import type { Goal, LogEntry } from '../types';

const base = {
  createdAt: '2026-07-01T12:00:00Z',
  updatedAt: '2026-07-01T12:00:00Z',
  quarterId: '2026-Q3',
  order: 0,
};

const goal = (g: Partial<Goal>): Goal =>
  ({ id: 'g', burner: 'health', title: 'x', type: 'number', startDate: '2026-07-01', deadline: '2026-09-30', ...base, ...g }) as Goal;

const log = (goalId: string, value: number, localDate: string, extra: Partial<LogEntry> = {}): LogEntry => ({
  id: `${goalId}-${localDate}-${value}-${Math.random()}`,
  goalId,
  value,
  localDate,
  at: `${localDate}T15:00:00Z`,
  offsetMin: -240,
  createdAt: `${localDate}T15:00:00Z`,
  updatedAt: `${localDate}T15:00:00Z`,
  ...extra,
});

describe('goal slots', () => {
  it('suggests 3, allows a 4th, blocks a 5th', () => {
    expect(goalSlot(2)).toMatchObject({ allowed: true, pastSuggested: false });
    expect(goalSlot(3)).toMatchObject({ allowed: true, pastSuggested: true });
    expect(goalSlot(4).allowed).toBe(false);
  });
});

describe('goal checks', () => {
  const intents = { family: 'high', friends: 'steady', health: 'high', work: 'low' } as const;
  const counts = { family: 2, friends: 2, health: 3, work: 3 };

  it('warns on missing why, when/where, and target', () => {
    const codes = checkGoal({ burner: 'health', type: 'number', title: 'Run' }, intents, counts).map((w) => w.code);
    expect(codes).toEqual(['no_why', 'no_when_where', 'no_target']);
  });

  it('habit needs a target too; yes/no does not', () => {
    const full = { why: 'w', whenWhere: 'ww' };
    expect(checkGoal({ burner: 'health', type: 'habit', title: 'x', ...full }, intents, counts).map((w) => w.code)).toEqual(['no_target']);
    expect(checkGoal({ burner: 'health', type: 'yesno', title: 'x', ...full }, intents, counts)).toEqual([]);
  });

  it('warns when a Low burner would outnumber every High burner', () => {
    const full = { why: 'w', whenWhere: 'ww' };
    const w = checkGoal({ burner: 'work', type: 'yesno', title: 'x', ...full }, intents, { ...counts, work: 4 });
    expect(w.map((x) => x.code)).toEqual(['low_outweighs_high']);
    expect(checkGoal({ burner: 'work', type: 'yesno', title: 'x', ...full }, intents, counts)).toEqual([]);
  });
});

describe('required totals and proration', () => {
  it('habit 2x/week across a full 13-week quarter is 26', () => {
    expect(requiredFor(goal({ type: 'habit', target: 2, habitPeriod: 'week' }))).toBe(26);
  });

  it('habit 2x/month across a full quarter is 6', () => {
    expect(requiredFor(goal({ type: 'habit', target: 2, habitPeriod: 'month' }))).toBe(6);
  });

  it('a habit added mid-quarter only requires the remaining weeks', () => {
    // Added Aug 19, 43 days left: 2/week * 43/7 = 12.3 -> 12
    expect(requiredFor(goal({ type: 'habit', target: 2, habitPeriod: 'week', startDate: '2026-08-19' }))).toBe(12);
  });

  it('expectation for a mid-quarter goal starts at zero on the day it was added', () => {
    const late = goal({ startDate: '2026-08-19' });
    expect(elapsedFraction(late, '2026-08-18')).toBe(0);
    expect(elapsedFraction(late, '2026-08-19')).toBeCloseTo(0.5 / 43);
    expect(elapsedFraction(late, '2026-10-05')).toBe(1);
  });

  it('a goal added mid-quarter is judged against remaining time, not the full quarter', () => {
    const late = goal({ id: 'late', target: 100, startDate: '2026-08-19' }); // 43-day window
    const logs = [log('late', 30, '2026-09-01')];
    // Sep 1 is day 14 of 43 -> ~31% elapsed. 30/100 done -> on pace.
    const p = goalProgress(late, logs, '2026-09-01', { intent: 'high' });
    expect(p.status).toBe('on_track');
    // The same numbers judged over the full quarter would look behind.
    const full = goal({ id: 'late', target: 100 });
    expect(goalProgress(full, logs, '2026-09-01', { intent: 'high' }).pace).toBeLessThan(0.9);
  });
});

describe('progress against intent', () => {
  const run = goal({ id: 'run', target: 300, unit: 'miles' });
  // Aug 15 is ~50% through the quarter.
  const logs = [log('run', 100, '2026-08-01')];

  it('same numbers read slipping on High but on track on Low', () => {
    expect(goalProgress(run, logs, '2026-08-15', { intent: 'high' }).status).toBe('behind');
    expect(goalProgress(run, logs, '2026-08-15', { intent: 'low' }).status).toBe('on_track');
  });

  it('completion is done regardless of time', () => {
    const p = goalProgress(run, [log('run', 310, '2026-07-10')], '2026-07-11', { intent: 'high' });
    expect(p).toMatchObject({ status: 'done', complete: true, fraction: 1, pace: 1 });
  });

  it('too early to judge counts as on track', () => {
    expect(goalProgress(run, [], '2026-07-01', { intent: 'high' }).status).toBe('on_track');
  });

  it('deleted logs are ignored', () => {
    const p = goalProgress(run, [log('run', 300, '2026-07-10', { deleted: true })], '2026-08-15', { intent: 'high' });
    expect(p.actual).toBe(0);
  });

  it('crunch days soften expectations', () => {
    const crunch = new Set(['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07']);
    const normal = goalProgress(run, logs, '2026-08-15', { intent: 'high' });
    const soft = goalProgress(run, logs, '2026-08-15', { intent: 'high', crunchDates: crunch });
    expect(soft.expected).toBeLessThan(normal.expected);
    expect(soft.pace).toBeGreaterThan(normal.pace);
  });

  it('yes/no ramps expectation slowly', () => {
    const y = goal({ id: 'y', type: 'yesno' });
    expect(goalProgress(y, [], '2026-08-15', { intent: 'high' }).expected).toBeCloseTo(0.25, 1);
    expect(goalProgress(y, [log('y', 1, '2026-08-01')], '2026-08-15', { intent: 'high' }).status).toBe('done');
  });

  it('milestones count completed steps', () => {
    const m = goal({
      id: 'm',
      type: 'milestone',
      milestones: [
        { id: 'a', title: 'A', doneAt: '2026-07-10T00:00:00Z' },
        { id: 'b', title: 'B' },
        { id: 'c', title: 'C' },
        { id: 'd', title: 'D' },
      ],
    });
    const p = goalProgress(m, [], '2026-08-15', { intent: 'steady' });
    expect(p.actual).toBe(1);
    expect(p.required).toBe(4);
    expect(p.fraction).toBe(0.25);
  });
});

describe('new goal grace', () => {
  it('a goal is not judged in its first 2 days, even late in the quarter', () => {
    const late = goal({ id: 'n', type: 'habit', target: 4, habitPeriod: 'week', startDate: '2026-09-25' });
    expect(goalProgress(late, [], '2026-09-25', { intent: 'high' }).status).toBe('on_track');
    expect(goalProgress(late, [], '2026-09-26', { intent: 'high' }).status).toBe('on_track');
    expect(goalProgress(late, [], '2026-09-28', { intent: 'high' }).status).not.toBe('on_track');
  });
});
