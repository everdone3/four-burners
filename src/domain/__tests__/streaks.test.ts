import { describe, expect, it } from 'vitest';
import { dateRange, localDateFor } from '../dates';
import { consistencyScore, dailyStreak, periodStreak, timeZoneExcusedDates } from '../streaks';
import type { Stamp } from '../types';

const set = (...d: string[]) => new Set(d);
const range = (a: string, b: string) => dateRange(a, b);

describe('daily streak', () => {
  it('counts consecutive active days', () => {
    const r = dailyStreak({ activeDates: new Set(range('2026-09-14', '2026-09-20')), today: '2026-09-20', graceDaysPerWeek: 0 });
    expect(r.current).toBe(7);
  });

  it('today not yet logged does not break the streak', () => {
    const r = dailyStreak({ activeDates: new Set(range('2026-09-14', '2026-09-19')), today: '2026-09-20', graceDaysPerWeek: 0 });
    expect(r.current).toBe(6);
  });

  it('one missed day is covered by a grace day', () => {
    const active = new Set(range('2026-09-14', '2026-09-20'));
    active.delete('2026-09-17');
    const r = dailyStreak({ activeDates: active, today: '2026-09-20', graceDaysPerWeek: 1 });
    expect(r.current).toBe(6);
    expect(r.graceUsedThisWeek).toBe(1);
  });

  it('two misses in one week break the streak with 1 grace day', () => {
    const active = new Set(range('2026-09-14', '2026-09-20'));
    active.delete('2026-09-16');
    active.delete('2026-09-17');
    const r = dailyStreak({ activeDates: active, today: '2026-09-20', graceDaysPerWeek: 1 });
    expect(r.current).toBe(3);
    expect(r.longest).toBe(3);
  });

  it('grace resets each Monday', () => {
    // Miss Sun 9/20 and Tue 9/22: different weeks, both forgiven.
    const active = new Set(range('2026-09-14', '2026-09-24'));
    active.delete('2026-09-20');
    active.delete('2026-09-22');
    expect(dailyStreak({ activeDates: active, today: '2026-09-24', graceDaysPerWeek: 1 }).current).toBe(9);
  });

  it('grace is configurable', () => {
    const active = new Set(range('2026-09-14', '2026-09-20'));
    active.delete('2026-09-16');
    active.delete('2026-09-17');
    expect(dailyStreak({ activeDates: active, today: '2026-09-20', graceDaysPerWeek: 2 }).current).toBe(5);
  });

  it('paused (Travel/Crunch) days neither count nor break', () => {
    const active = set('2026-09-14', '2026-09-15', '2026-09-20');
    const paused = new Set(range('2026-09-16', '2026-09-19'));
    const r = dailyStreak({ activeDates: active, today: '2026-09-20', graceDaysPerWeek: 0, pausedDates: paused });
    expect(r.current).toBe(3);
  });

  it('tracks the longest streak', () => {
    const active = new Set([...range('2026-08-01', '2026-08-10'), ...range('2026-09-01', '2026-09-03')]);
    const r = dailyStreak({ activeDates: active, today: '2026-09-03', graceDaysPerWeek: 1 });
    expect(r.longest).toBe(10);
    expect(r.current).toBe(3);
  });

  it('empty history is zero', () => {
    expect(dailyStreak({ activeDates: new Set(), today: '2026-09-20', graceDaysPerWeek: 1 }).current).toBe(0);
  });
});

describe('habit period streaks', () => {
  it('counts consecutive weeks meeting target, current week holds', () => {
    const weeks = ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21'];
    const counts = new Map([
      ['2026-08-31', 2],
      ['2026-09-07', 3],
      ['2026-09-14', 2],
      ['2026-09-21', 0],
    ]);
    expect(periodStreak(counts, weeks, 2).current).toBe(3);
    counts.set('2026-09-07', 1);
    expect(periodStreak(counts, weeks, 2).current).toBe(1);
  });
});

describe('time zones never break streaks', () => {
  const B = 3;
  const stamp = (iso: string, offsetMin: number): Stamp => {
    const at = new Date(iso);
    return { at: at.toISOString(), offsetMin, localDate: localDateFor(at, offsetMin, B) };
  };

  it('flying LA to Tokyo skips a calendar date; that date is excused', () => {
    // Mon Sep 21, 8 PM in LA (UTC-7)
    const a = stamp('2026-09-22T03:00:00Z', -420);
    // Next check-in: Wed Sep 23, 10 AM in Tokyo (UTC+9) = Tue 6 PM LA.
    const b = stamp('2026-09-23T01:00:00Z', 540);
    expect(a.localDate).toBe('2026-09-21');
    expect(b.localDate).toBe('2026-09-23');
    const excused = timeZoneExcusedDates([a, b], B);
    expect([...excused]).toEqual(['2026-09-22']);

    const active = set('2026-09-19', '2026-09-20', a.localDate, b.localDate);
    const r = dailyStreak({ activeDates: active, today: '2026-09-23', graceDaysPerWeek: 0, pausedDates: excused });
    expect(r.current).toBe(4);
  });

  it('a genuine missed day in one time zone is not excused', () => {
    const a = stamp('2026-09-22T03:00:00Z', -420); // Mon 8 PM LA
    const b = stamp('2026-09-23T16:00:00Z', -420); // Wed 9 AM LA
    expect(timeZoneExcusedDates([a, b], B).size).toBe(0);
  });

  it('a genuine missed day while also changing zones is not excused', () => {
    const a = stamp('2026-09-22T03:00:00Z', -420); // Mon 8 PM LA
    const b = stamp('2026-09-23T14:00:00Z', -240); // Wed 10 AM NY = Wed 7 AM LA
    expect(timeZoneExcusedDates([a, b], B).size).toBe(0);
  });

  it('flying east to west (repeating a date) never breaks anything', () => {
    const a = stamp('2026-09-22T01:00:00Z', 540); // Tue 10 AM Tokyo
    const b = stamp('2026-09-22T05:00:00Z', -420); // Mon 10 PM LA (same instant order, earlier date)
    const active = set('2026-09-20', a.localDate, b.localDate);
    const r = dailyStreak({ activeDates: active, today: '2026-09-22', graceDaysPerWeek: 0 });
    expect(r.current).toBe(3);
  });

  it('a late-night log across the day boundary stays on the day you were living', () => {
    const late = stamp('2026-09-22T06:30:00Z', -420); // Mon 11:30 PM LA
    const later = stamp('2026-09-22T09:30:00Z', -420); // Tue 2:30 AM LA, before 3 AM
    expect(late.localDate).toBe('2026-09-21');
    expect(later.localDate).toBe('2026-09-21');
  });
});

describe('consistency score', () => {
  it('perfect check-ins score 100', () => {
    const active = new Set(range('2026-08-24', '2026-09-20'));
    expect(consistencyScore({ activeDates: active, today: '2026-09-20', graceDaysPerWeek: 1, since: '2026-07-01' })).toBe(100);
  });

  it('one miss per week is fully forgiven by grace', () => {
    const active = new Set(range('2026-08-24', '2026-09-20'));
    for (const d of ['2026-08-26', '2026-09-02', '2026-09-09', '2026-09-16']) active.delete(d);
    const s = consistencyScore({ activeDates: active, today: '2026-09-20', graceDaysPerWeek: 1, since: '2026-07-01' });
    expect(s).toBe(100);
  });

  it('sparse check-ins score low', () => {
    const active = set('2026-09-01', '2026-09-10');
    const s = consistencyScore({ activeDates: active, today: '2026-09-20', graceDaysPerWeek: 1, since: '2026-07-01' });
    expect(s).toBeLessThan(30);
  });

  it('paused days are excluded from the denominator', () => {
    const active = new Set(range('2026-09-14', '2026-09-20'));
    const paused = new Set(range('2026-08-24', '2026-09-13'));
    const s = consistencyScore({ activeDates: active, today: '2026-09-20', graceDaysPerWeek: 0, pausedDates: paused, since: '2026-07-01' });
    expect(s).toBeGreaterThanOrEqual(90);
  });
});

describe('consistency edge cases', () => {
  it('no check-ins at all scores 0 (grace never counts in empty weeks)', () => {
    expect(consistencyScore({ activeDates: new Set(), today: '2026-09-20', graceDaysPerWeek: 1, since: '2026-07-01' })).toBe(0);
  });
});
