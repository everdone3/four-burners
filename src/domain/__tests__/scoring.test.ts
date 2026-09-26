import { describe, expect, it } from 'vitest';
import { dateRange } from '../dates';
import { computeDashboard, crunchDateSet, type DashboardInput } from '../scoring';
import { DEFAULT_SETTINGS, type Goal, type LogEntry, type Quarter } from '../types';
import { INTENT_WEIGHTS, DIM_FLOOR } from '../config';

const T = '2026-07-01T12:00:00Z';
const quarter = (intents: Quarter['intents']): Quarter => ({
  id: '2026-Q3', createdAt: T, updatedAt: T, intents, intentHistory: [], status: 'active',
});
const goal = (id: string, burner: Goal['burner'], target = 90): Goal => ({
  id, burner, title: id, type: 'number', target, startDate: '2026-07-01', deadline: '2026-09-28',
  quarterId: '2026-Q3', order: 0, createdAt: T, updatedAt: T,
});
const log = (goalId: string, value: number, d: string): LogEntry => ({
  id: `${goalId}${d}`, goalId, value, localDate: d, at: `${d}T15:00:00Z`, offsetMin: -240, createdAt: T, updatedAt: T,
});

function input(over: Partial<DashboardInput>): DashboardInput {
  return {
    quarter: quarter({ family: 'high', friends: 'steady', health: 'high', work: 'low' }),
    quarterStart: '2026-07-01',
    goals: [], logs: [], energy: [], people: [], touchpoints: [], crunch: [],
    settings: DEFAULT_SETTINGS, today: '2026-08-15', ...over,
  };
}

describe('progress score', () => {
  it('weights burners by intent (High 3, Steady 2, Low 1)', () => {
    expect(INTENT_WEIGHTS).toEqual({ high: 3, steady: 2, low: 1 });
    // Family (High) fully on pace, Work (Low) with nothing logged.
    const days = dateRange('2026-07-01', '2026-08-15');
    const d = computeDashboard(input({
      goals: [goal('fam', 'family'), goal('wrk', 'work')],
      logs: days.map((x) => log('fam', 1, x)),
    }));
    expect(d.burners.family.pace).toBe(1);
    expect(d.burners.work.pace).toBe(0);
    // (3*1 + 1*0) / (3+1) = 75
    expect(d.progressScore).toBe(75);
  });

  it('a Low burner with light activity is on track', () => {
    // 50% through, 30/90 logged = 33%. Low expects 60% of 50% = 30%.
    const d = computeDashboard(input({ goals: [goal('wrk', 'work')], logs: [log('wrk', 30, '2026-08-10')] }));
    expect(d.burners.work.status).toBe('on_track');
  });

  it('burners without goals are excluded from the score', () => {
    const d = computeDashboard(input({ goals: [goal('h', 'health')], logs: dateRange('2026-07-01', '2026-08-15').map((x) => log('h', 1, x)) }));
    expect(d.progressScore).toBe(100);
    expect(d.burners.friends.pace).toBeNull();
  });

  it('ignores goals from other quarters and deleted goals', () => {
    const other = { ...goal('old', 'health'), quarterId: '2026-Q2' };
    const gone = { ...goal('gone', 'health'), deleted: true };
    const d = computeDashboard(input({ goals: [other, gone] }));
    expect(d.burners.health.goals).toHaveLength(0);
  });
});

describe('flame state', () => {
  it('quiet burners dim gently but never below the floor', () => {
    const d = computeDashboard(input({ goals: [goal('f', 'friends')], today: '2026-09-28' }));
    expect(d.burners.friends.brightness).toBe(DIM_FLOOR);
    const fresh = computeDashboard(input({ goals: [goal('f', 'friends')], logs: [log('f', 1, '2026-09-27')], today: '2026-09-28' }));
    expect(fresh.burners.friends.brightness).toBe(1);
  });

  it('Low burners tolerate longer silence before dimming', () => {
    const logs = [log('w', 1, '2026-08-08'), log('h', 1, '2026-08-08')];
    const d = computeDashboard(input({ goals: [goal('w', 'work'), goal('h', 'health')], logs, today: '2026-08-15' }));
    expect(d.burners.work.brightness).toBe(1);
    expect(d.burners.health.brightness).toBeLessThan(1);
  });

  it('crunch days do not count as silence', () => {
    const logs = [log('h', 1, '2026-08-01')];
    const crunch = [{ id: 'c', start: '2026-08-02', end: '2026-08-14', createdAt: T, updatedAt: T }];
    const d = computeDashboard(input({ goals: [goal('h', 'health')], logs, crunch, today: '2026-08-15' }));
    expect(d.burners.health.brightness).toBe(1);
  });

  it('heat rises with recent activity', () => {
    const cold = computeDashboard(input({ goals: [goal('h', 'health')] }));
    const hot = computeDashboard(input({
      goals: [goal('h', 'health')],
      logs: dateRange('2026-07-01', '2026-08-15').map((x) => log('h', 1, x)),
    }));
    expect(hot.burners.health.heat).toBeGreaterThan(cold.burners.health.heat);
    expect(hot.burners.health.heat).toBeCloseTo(1);
  });
});

describe('crunch periods', () => {
  it('open-ended periods run through today', () => {
    const s = crunchDateSet([{ id: 'c', start: '2026-08-13', createdAt: T, updatedAt: T }], '2026-08-15');
    expect([...s]).toEqual(['2026-08-13', '2026-08-14', '2026-08-15']);
  });
});

describe('fresh start', () => {
  it('a burner with nothing set up is a steady pilot light, not a dying flame', () => {
    const d = computeDashboard(input({ today: '2026-09-28' }));
    expect(d.burners.family.brightness).toBeGreaterThan(DIM_FLOOR);
    expect(d.burners.family.heat).toBeGreaterThan(0);
    expect(d.consistencyScore).toBe(0);
  });
});

describe('consistency across quarters', () => {
  it('does not reset on the first day of a new quarter', () => {
    const q4: Quarter = { ...quarter({ family: 'high', friends: 'steady', health: 'high', work: 'low' }), id: '2026-Q4' };
    const logs = dateRange('2026-09-10', '2026-09-30').map((d) => log('x', 1, d));
    const d = computeDashboard(input({ quarter: q4, quarterStart: '2026-10-01', goals: [goal('x', 'health')], logs, today: '2026-10-01' }));
    expect(d.consistencyScore).toBeGreaterThan(80);
    expect(d.streak.current).toBe(21);
  });
});
