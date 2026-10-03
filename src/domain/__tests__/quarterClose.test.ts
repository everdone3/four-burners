import { describe, expect, it } from 'vitest';
import { dateRange } from '../dates';
import { carryForward, carryOverflow, quarterHighlights, quarterNeedingClose, suggestedGrade, type HighlightsInput } from '../quarterClose';
import { DEFAULT_SETTINGS, type Goal, type LogEntry, type Person, type Quarter, type Touchpoint, type WeeklyReview } from '../types';

const T = '2026-07-01T12:00:00Z';
const quarter: Quarter = {
  id: '2026-Q3', createdAt: T, updatedAt: T, intentHistory: [], status: 'active', theme: 'Present',
  intents: { family: 'high', friends: 'steady', health: 'high', work: 'low' },
};
const goal = (id: string, g: Partial<Goal> = {}): Goal => ({
  id, burner: 'health', title: id, type: 'number', target: 90, startDate: '2026-07-01', deadline: '2026-09-30',
  quarterId: '2026-Q3', order: 0, createdAt: T, updatedAt: T, ...g,
});
const log = (goalId: string, d: string, value = 1): LogEntry => ({
  id: `${goalId}-${d}-${value}`, goalId, value, localDate: d, at: `${d}T15:00:00Z`, offsetMin: -240, createdAt: T, updatedAt: T,
});

describe('grades', () => {
  it('suggests a grade from the fraction done', () => {
    expect(suggestedGrade(1, true)).toBe('A');
    expect(suggestedGrade(0.92, false)).toBe('A');
    expect(suggestedGrade(0.8, false)).toBe('B');
    expect(suggestedGrade(0.5, false)).toBe('C');
    expect(suggestedGrade(0.3, false)).toBe('D');
    expect(suggestedGrade(0.1, false)).toBe('F');
  });
});

describe('carry forward', () => {
  it('copies the goal into the next quarter with fresh progress and a link back', () => {
    const g = goal('run', { why: 'Strong at 50', whenWhere: 'Tue/Thu 6 AM', unit: 'miles', personIds: ['p'], grade: 'B', closeDecision: 'carry' });
    const c = carryForward(g, { quarterId: '2026-Q4', startDate: '2026-10-01', deadline: '2026-12-31' }, 'new', 'now', 2);
    expect(c).toMatchObject({
      id: 'new', quarterId: '2026-Q4', title: 'run', why: 'Strong at 50', whenWhere: 'Tue/Thu 6 AM', target: 90, unit: 'miles',
      startDate: '2026-10-01', deadline: '2026-12-31', order: 2, carriedFromId: 'run', personIds: ['p'],
    });
    expect(c.grade).toBeUndefined();
    expect(c.closeDecision).toBeUndefined();
  });

  it('keeps an Apple Health link, so the evening automation keeps filling it in', () => {
    const g = goal('steps', { health: { metric: 'steps', min: 9000 } });
    const c = carryForward(g, { quarterId: '2026-Q4', startDate: '2026-10-01', deadline: '2026-12-31' }, 'new', 'now', 0);
    expect(c.health).toEqual({ metric: 'steps', min: 9000 });
  });

  it('carries only unfinished milestone steps, with fresh ids', () => {
    const g = goal('trip', {
      type: 'milestone',
      milestones: [
        { id: 'a', title: 'Pick dates', doneAt: T },
        { id: 'b', title: 'Book flights' },
        { id: 'c', title: 'Book house' },
      ],
    });
    const c = carryForward(g, { quarterId: '2026-Q4', startDate: '2026-10-01', deadline: '2026-12-31' }, 'new', 'now', 0);
    expect(c.milestones?.map((m) => m.title)).toEqual(['Book flights', 'Book house']);
    expect(c.milestones?.every((m) => !m.doneAt && m.id.startsWith('new-'))).toBe(true);
  });

  it('flags burners that would exceed 4 goals', () => {
    const goals = ['a', 'b', 'c'].map((id) => goal(id));
    expect(carryOverflow(goals, { a: 'carry', b: 'modify', c: 'carry' })).toEqual([]);
    expect(carryOverflow(goals, { a: 'carry', b: 'modify', c: 'carry' }, { health: 2 })).toEqual(['health']);
    expect(carryOverflow(goals, { a: 'drop', b: 'modify', c: 'carry' }, { health: 2 })).toEqual([]);
  });
});

describe('quarter needing close', () => {
  const q = (id: string, status: 'active' | 'closed') => ({ id, status });
  it('finds the most recent open past quarter with goals', () => {
    const goals = [goal('x', { quarterId: '2026-Q2' }), goal('y', { quarterId: '2026-Q3' })];
    expect(quarterNeedingClose([q('2026-Q2', 'closed'), q('2026-Q3', 'active'), q('2026-Q4', 'active')], goals, '2026-Q4')?.id).toBe('2026-Q3');
    expect(quarterNeedingClose([q('2026-Q3', 'closed'), q('2026-Q4', 'active')], goals, '2026-Q4')).toBeUndefined();
    expect(quarterNeedingClose([q('2026-Q3', 'active')], goals, '2026-Q3')).toBeUndefined();
    // An empty past quarter (no goals) never needs a close.
    expect(quarterNeedingClose([q('2026-Q1', 'active')], goals, '2026-Q4')).toBeUndefined();
  });
});

describe('highlights', () => {
  const run = goal('run', { title: 'Run 90 miles' });
  const lift = goal('lift', { title: 'Lift', type: 'habit', target: 2, habitPeriod: 'week' });
  const trip = goal('trip', { title: 'Plan trip', burner: 'family', type: 'yesno' });
  const comeback = goal('read', { title: 'Read', burner: 'work', target: 13 });
  const people: Person[] = [
    { id: 'm', name: 'Mom', burner: 'family', cadenceDays: 7, order: 0, createdAt: T, updatedAt: T },
    { id: 'j', name: 'Jake', burner: 'friends', cadenceDays: 14, order: 1, createdAt: T, updatedAt: T },
  ];
  const tp = (personId: string, d: string): Touchpoint => ({ id: personId + d, personId, type: 'call', localDate: d, at: `${d}T18:00:00Z`, offsetMin: -240, createdAt: T, updatedAt: T });
  const review: WeeklyReview = {
    id: 'review-2026-09-14', weekStart: '2026-09-14', step: 6, wins: ['Closed the Lakeview memo', 'Plan trip'], misses: [], focus: '', focusBurners: [],
    createdAt: T, updatedAt: T, completedAt: T,
  };
  const days = dateRange('2026-07-01', '2026-09-30');
  const input: HighlightsInput = {
    quarter,
    goals: [run, lift, trip, comeback],
    logs: [
      ...days.map((d) => log('run', d)), // 92 miles, done
      ...days.filter((_, i) => i % 7 === 0 || i % 7 === 3).map((d) => log('lift', d)), // 2x/week, steady streak
      log('trip', '2026-08-20'),
      // Read: nothing for 2 months, then a big finish.
      ...dateRange('2026-09-01', '2026-09-13').map((d) => log('read', d)),
    ],
    energy: [{ id: 'e', rating: 4, localDate: '2026-09-01', at: T, offsetMin: -240, createdAt: T, updatedAt: T }],
    people,
    touchpoints: [tp('m', '2026-07-05'), tp('m', '2026-08-05'), tp('m', '2026-09-05'), tp('j', '2026-08-10')],
    crunch: [],
    actions: [],
    reviews: [review],
    settings: DEFAULT_SETTINGS,
    today: '2026-10-02', // after quarter end: capped at Sep 30
  };
  const h = quarterHighlights(input);

  it('caps at the quarter end and counts the basics', () => {
    expect(h.asOf).toBe('2026-09-30');
    expect(h.daysInQuarter).toBe(92);
    expect(h.checkInDays).toBe(92);
    expect(h.longestStreak).toBe(92);
    expect(h.touchpointCount).toBe(4);
    expect(h.energyAvg).toBe(4);
  });

  it('puts completed goals first in top wins, then review wins, without duplicates', () => {
    expect(h.topWins.map((w) => w.text)).toEqual(['Plan trip', 'Run 90 miles', 'Lift', 'Read', 'Closed the Lakeview memo']);
  });

  it('finds the brightest burner, habit streaks, the comeback, and most-connected people', () => {
    expect(['health', 'family']).toContain(h.brightest?.burner);
    expect(h.habitStreaks[0]).toMatchObject({ title: 'Lift', unit: 'week' });
    expect(h.habitStreaks[0].periods).toBeGreaterThanOrEqual(12);
    expect(h.comeback?.title).toBe('Read');
    expect(h.comeback!.to).toBeGreaterThan(h.comeback!.from);
    expect(h.mostConnected[0]).toEqual({ name: 'Mom', burner: 'family', count: 3 });
    expect(h.goalsDone).toBe(4);
    expect(h.goalsTotal).toBe(4);
  });
});

describe('brightest burner', () => {
  it('weights pace by intent: High at near-full pace beats Low at full pace', () => {
    const q: Quarter = { ...quarter, intents: { family: 'high', friends: 'low', health: 'steady', work: 'low' } };
    const fam = goal('fam', { burner: 'family', target: 92 });
    const fri = goal('fri', { burner: 'friends', target: 10 });
    const days = dateRange('2026-07-01', '2026-09-30');
    const h = quarterHighlights({
      quarter: q, goals: [fam, fri],
      logs: [...days.slice(0, 85).map((d) => log('fam', d)), ...days.slice(0, 10).map((d) => log('fri', d))],
      energy: [], people: [], touchpoints: [], crunch: [], actions: [], settings: DEFAULT_SETTINGS, today: '2026-09-30',
    });
    expect(h.brightest?.burner).toBe('family');
  });
});
