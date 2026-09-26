import { describe, expect, it } from 'vitest';
import {
  addDays,
  daysLeftInQuarter,
  diffDays,
  localDateFor,
  nextQuarterId,
  prevQuarterId,
  quarterOf,
  quarterSpan,
  startOfWeek,
  weekday,
} from '../dates';

describe('local date math', () => {
  it('adds and diffs across month, year, and leap boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(diffDays('2026-03-07', '2026-03-09')).toBe(2); // spans US DST start
    expect(diffDays('2026-11-01', '2026-10-31')).toBe(-1);
  });

  it('weeks run Monday to Sunday', () => {
    expect(weekday('2026-09-21')).toBe(0); // Monday
    expect(weekday('2026-09-27')).toBe(6); // Sunday
    expect(startOfWeek('2026-09-27')).toBe('2026-09-21');
    expect(startOfWeek('2026-09-21')).toBe('2026-09-21');
  });
});

describe('day boundary', () => {
  const NY = -240; // EDT
  it('a 1:30 AM log counts toward the previous day with a 3 AM boundary', () => {
    const t = new Date('2026-09-25T05:30:00Z'); // 1:30 AM EDT on the 25th
    expect(localDateFor(t, NY, 3)).toBe('2026-09-24');
    expect(localDateFor(t, NY, 0)).toBe('2026-09-25');
  });

  it('3:00 AM exactly starts the new day', () => {
    const t = new Date('2026-09-25T07:00:00Z'); // 3:00 AM EDT
    expect(localDateFor(t, NY, 3)).toBe('2026-09-25');
  });

  it('the same instant maps to different lived dates in different zones', () => {
    const t = new Date('2026-09-25T20:00:00Z');
    expect(localDateFor(t, -420, 3)).toBe('2026-09-25'); // 1 PM LA
    expect(localDateFor(t, 540, 3)).toBe('2026-09-26'); // 5 AM Tokyo next day
    expect(localDateFor(t, 330, 3)).toBe('2026-09-25'); // 1:30 AM India, still the night of the 25th
  });

  it('half-hour and 45-minute offsets work', () => {
    const t = new Date('2026-09-25T21:00:00Z');
    expect(localDateFor(t, 345, 3)).toBe('2026-09-25'); // Nepal 2:45 AM, before boundary
    expect(localDateFor(t, 345, 2)).toBe('2026-09-26'); // with a 2 AM boundary it is the 26th
  });
});

describe('quarters', () => {
  it('uses calendar quarters', () => {
    expect(quarterOf('2026-09-25')).toEqual({ id: '2026-Q3', start: '2026-07-01', end: '2026-09-30' });
    expect(quarterSpan('2026-Q4')).toEqual({ id: '2026-Q4', start: '2026-10-01', end: '2026-12-31' });
    expect(quarterSpan('2028-Q1').end).toBe('2028-03-31');
  });

  it('steps between quarters across years', () => {
    expect(nextQuarterId('2026-Q4')).toBe('2027-Q1');
    expect(prevQuarterId('2027-Q1')).toBe('2026-Q4');
  });

  it('days left includes today', () => {
    expect(daysLeftInQuarter('2026-09-30')).toBe(1);
    expect(daysLeftInQuarter('2026-09-25')).toBe(6);
    expect(daysLeftInQuarter('2026-07-01')).toBe(92);
  });
});
