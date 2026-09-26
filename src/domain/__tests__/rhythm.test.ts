import { describe, expect, it } from 'vitest';
import { addDays, dateRange } from '../dates';
import { actionsWeekFor, dueReviewWeek, reviewWeekFor, suggestActions, suggestMisses, suggestWins, weekSummary } from '../reviews';
import { computeDashboard, activeCrunch, type DashboardInput } from '../scoring';
import { habitStreak } from '../streaks';
import { DEFAULT_SETTINGS, type Goal, type LogEntry, type Person, type Quarter, type Touchpoint, type WeeklyAction } from '../types';

const T = '2026-07-01T12:00:00Z';
const quarter: Quarter = {
  id: '2026-Q3', createdAt: T, updatedAt: T, intentHistory: [], status: 'active',
  intents: { family: 'high', friends: 'steady', health: 'high', work: 'low' },
};
const goal = (id: string, g: Partial<Goal> = {}): Goal => ({
  id, burner: 'health', title: id, type: 'habit', target: 3, habitPeriod: 'week', startDate: '2026-07-01', deadline: '2026-09-30',
  quarterId: '2026-Q3', order: 0, createdAt: T, updatedAt: T, ...g,
});
const log = (goalId: string, d: string, value = 1): LogEntry => ({
  id: `${goalId}-${d}-${Math.random()}`, goalId, value, localDate: d, at: `${d}T15:00:00Z`, offsetMin: -240, createdAt: T, updatedAt: T,
});
const input = (over: Partial<DashboardInput>): DashboardInput => ({
  quarter, quarterStart: '2026-07-01', goals: [], logs: [], energy: [], people: [], touchpoints: [], crunch: [], actions: [],
  settings: DEFAULT_SETTINGS, today: '2026-09-20', ...over,
});

describe('habit streaks', () => {
  const g = goal('lift'); // 3x per week
  const weekLogs = (monday: string, n: number) => [0, 2, 4].slice(0, n).map((i) => log('lift', addDays(monday, i)));

  it('counts consecutive weeks meeting the target; the current week holds', () => {
    const logs = [...weekLogs('2026-08-31', 3), ...weekLogs('2026-09-07', 3), ...weekLogs('2026-09-14', 3), ...weekLogs('2026-09-21', 1)];
    expect(habitStreak(g, logs, '2026-09-23').current).toBe(3);
  });

  it('a short week breaks it', () => {
    const logs = [...weekLogs('2026-08-31', 3), ...weekLogs('2026-09-07', 2), ...weekLogs('2026-09-14', 3)];
    expect(habitStreak(g, logs, '2026-09-20').current).toBe(1);
  });

  it('a mostly-crunch week holds instead of breaking', () => {
    const logs = [...weekLogs('2026-08-31', 3), ...weekLogs('2026-09-14', 3)];
    const crunch = new Set(dateRange('2026-09-07', '2026-09-11'));
    expect(habitStreak(g, logs, '2026-09-20', crunch).current).toBe(2);
    expect(habitStreak(g, logs, '2026-09-20').current).toBe(1);
  });

  it('a partial first week (goal added mid-week) does not break it', () => {
    const late = goal('lift', { startDate: '2026-09-03' }); // Thursday
    const logs = [log('lift', '2026-09-04'), ...weekLogs('2026-09-07', 3), ...weekLogs('2026-09-14', 3)];
    expect(habitStreak(late, logs, '2026-09-20').current).toBe(2);
  });

  it('monthly habits count months', () => {
    const m = goal('date', { target: 2, habitPeriod: 'month' });
    const logs = [log('date', '2026-07-10'), log('date', '2026-07-24'), log('date', '2026-08-07'), log('date', '2026-08-21'), log('date', '2026-09-04')];
    expect(habitStreak(m, logs, '2026-09-20').current).toBe(2);
    expect(habitStreak(m, logs, '2026-09-20').longest).toBe(2);
  });
});

describe('weekly review timing', () => {
  it('is due from review day through the next 3 days', () => {
    // Sunday review day (6). Week of Mon Sep 14 is due Sun Sep 20 through Wed Sep 23.
    expect(dueReviewWeek('2026-09-19', 6)).toBeNull();
    expect(dueReviewWeek('2026-09-20', 6)).toBe('2026-09-14');
    expect(dueReviewWeek('2026-09-23', 6)).toBe('2026-09-14');
    expect(dueReviewWeek('2026-09-24', 6)).toBeNull();
  });

  it('works with a Friday review day', () => {
    expect(dueReviewWeek('2026-09-18', 4)).toBe('2026-09-14');
    expect(dueReviewWeek('2026-09-21', 4)).toBe('2026-09-14'); // Monday, still in window
    expect(dueReviewWeek('2026-09-22', 4)).toBeNull();
  });

  it('opened by hand: this week from Thursday on, otherwise last week', () => {
    expect(reviewWeekFor('2026-09-24', 6)).toBe('2026-09-21'); // Thursday
    expect(reviewWeekFor('2026-09-15', 6)).toBe('2026-09-07'); // Tuesday, not in a window
  });

  it('actions are for the following week', () => {
    expect(actionsWeekFor('2026-09-14')).toBe('2026-09-21');
  });
});

describe('week summary', () => {
  const run = goal('run', { type: 'number', target: 90, unit: 'miles' });
  const lift = goal('lift', { title: 'Lift', burner: 'health' });
  const date = goal('date', { title: 'Date night', burner: 'family', type: 'yesno' });
  const person: Person = { id: 'p', name: 'Elena', burner: 'friends', cadenceDays: 14, order: 0, createdAt: T, updatedAt: T };
  const tp = (d: string): Touchpoint => ({ id: d, personId: 'p', type: 'call', localDate: d, at: `${d}T18:00:00Z`, offsetMin: -240, createdAt: T, updatedAt: T });
  const action = (text: string, done?: string): WeeklyAction => ({
    id: text, weekStart: '2026-09-14', text, order: 0, createdAt: T, updatedAt: T,
    ...(done ? { done: { at: `${done}T12:00:00Z`, offsetMin: -240, localDate: done }, burner: 'health' as const } : {}),
  });

  const data = input({
    goals: [run, lift, date],
    logs: [
      ...dateRange('2026-07-01', '2026-09-13').map((d) => log('run', d, 1)),
      log('run', '2026-09-15', 3), log('run', '2026-09-17', 4),
      log('lift', '2026-09-15'), log('lift', '2026-09-17'), log('lift', '2026-09-19'),
      log('date', '2026-09-18'),
    ],
    people: [person],
    touchpoints: [tp('2026-08-01')],
    actions: [action('Book the dentist'), action('Hill repeats', '2026-09-16')],
    crunch: [{ id: 'c', start: '2026-09-18', end: '2026-09-19', createdAt: T, updatedAt: T }],
    today: '2026-09-20',
  });
  const s = weekSummary(data, '2026-09-14');

  it('covers the week and counts check-in days', () => {
    expect(s.weekEnd).toBe('2026-09-20');
    expect(s.daysElapsed).toBe(7);
    expect(s.checkInDays).toBe(5); // 15, 16 (action), 17, 18, 19
  });

  it('reports burner activity, completed goals, crunch days, overdue people, and actions', () => {
    expect(s.burners.health.activeDays).toBe(4); // 15, 16 (action), 17, 19
    expect(s.burners.health.logCount).toBe(5);
    expect(s.completedGoals).toEqual([{ title: 'Date night', burner: 'family' }]);
    expect(s.crunchDays).toBe(2);
    expect(s.overduePeople.map((p) => p.name)).toEqual(['Elena']);
    expect(s.actions).toMatchObject({ done: 1, total: 2 });
    expect(s.actions.undone.map((a) => a.text)).toEqual(['Book the dentist']);
  });

  it('suggests wins, misses, and actions from the data', () => {
    expect(suggestWins(s)).toContain('Completed Date night');
    expect(suggestWins(s)).toContain('Finished 1 of 2 planned actions');
    expect(suggestMisses(s)).toContain('Did not get to: Book the dentist');
    expect(suggestMisses(s).some((m) => m.includes('Elena'))).toBe(true);
    const acts = suggestActions(s, data).map((a) => a.text);
    expect(acts).toContain('Call Elena');
    expect(acts).toContain('Book the dentist');
  });
});

describe('as-of scoring and actions', () => {
  it('ignores entries dated after today', () => {
    const g = goal('r', { type: 'number', target: 10 });
    const d = computeDashboard(input({ goals: [g], logs: [log('r', '2026-09-01', 5), log('r', '2026-09-25', 5)], today: '2026-09-10' }));
    expect(d.burners.health.goals[0].progress.actual).toBe(5);
  });

  it('completed actions count as check-ins and burner activity', () => {
    const a: WeeklyAction = {
      id: 'a', weekStart: '2026-09-14', text: 'x', burner: 'work', order: 0, createdAt: T, updatedAt: T,
      done: { at: '2026-09-20T12:00:00Z', offsetMin: -240, localDate: '2026-09-20' },
    };
    const d = computeDashboard(input({ actions: [a] }));
    expect(d.burners.work.lastActive).toBe('2026-09-20');
    expect(d.streak.current).toBe(1);
  });

  it('finds the active crunch period', () => {
    const p = { id: 'c', start: '2026-09-18', end: '2026-09-22', createdAt: T, updatedAt: T };
    expect(activeCrunch([p], '2026-09-20')?.id).toBe('c');
    expect(activeCrunch([p], '2026-09-23')).toBeUndefined();
    expect(activeCrunch([{ ...p, end: undefined }], '2026-12-01')?.id).toBe('c');
  });
});

describe('week summary per-day check-ins', () => {
  it('flags each day of the week', () => {
    const s = weekSummary(input({ goals: [goal('g')], logs: [log('g', '2026-09-15'), log('g', '2026-09-18')], today: '2026-09-20' }), '2026-09-14');
    expect(s.checkedIn).toEqual([false, true, false, false, true, false, false]);
  });
});
