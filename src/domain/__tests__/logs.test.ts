import { describe, expect, it } from 'vitest';
import { applyLogEdit, energyOn, energyTrend } from '../logs';
import type { EnergyEntry, LogEntry } from '../types';

const log: LogEntry = {
  id: 'l', goalId: 'g', value: 3, localDate: '2026-09-20', at: '2026-09-20T15:00:00Z', offsetMin: -240,
  createdAt: '2026-09-20T15:00:00Z', updatedAt: '2026-09-20T15:00:00Z',
};

describe('log edits', () => {
  it('records the previous value and note', () => {
    const a = applyLogEdit(log, { value: 4, note: 'Hill loop' }, '2026-09-20T16:00:00Z');
    expect(a.value).toBe(4);
    expect(a.note).toBe('Hill loop');
    expect(a.edits).toEqual([{ at: '2026-09-20T16:00:00Z', prevValue: 3 }]);
    const b = applyLogEdit(a, { note: 'Hill loop, felt great', notePrivate: true }, '2026-09-20T17:00:00Z');
    expect(b.edits).toHaveLength(2);
    expect(b.edits![1]).toEqual({ at: '2026-09-20T17:00:00Z', prevValue: 4, prevNote: 'Hill loop' });
    expect(b.notePrivate).toBe(true);
    expect(b.updatedAt).toBe('2026-09-20T17:00:00Z');
  });

  it('adding a first note is not recorded as an edit', () => {
    const a = applyLogEdit(log, { note: 'Easy pace', notePrivate: true }, 'x');
    expect(a.note).toBe('Easy pace');
    expect(a.notePrivate).toBe(true);
    expect(a.edits).toBeUndefined();
  });

  it('no-op edits leave the log untouched', () => {
    expect(applyLogEdit(log, { value: 3 }, 'x')).toBe(log);
  });

  it('clearing a note also clears its private flag', () => {
    const a = applyLogEdit({ ...log, note: 'secret', notePrivate: true }, { note: '  ' }, 'x');
    expect(a.note).toBeUndefined();
    expect(a.notePrivate).toBeUndefined();
  });
});

describe('energy', () => {
  const e = (localDate: string, rating: EnergyEntry['rating'], updatedAt = `${localDate}T21:00:00Z`): EnergyEntry => ({
    id: localDate + rating, rating, localDate, at: updatedAt, offsetMin: -240, createdAt: updatedAt, updatedAt,
  });

  it('latest rating for a day wins', () => {
    const entries = [e('2026-09-20', 2, '2026-09-20T10:00:00Z'), e('2026-09-20', 4, '2026-09-20T22:00:00Z')];
    expect(energyOn(entries, '2026-09-20')?.rating).toBe(4);
  });

  it('computes a week-over-week trend', () => {
    const entries = [
      ...['07', '08', '09', '10', '11', '12', '13'].map((d) => e(`2026-09-${d}`, 2)),
      ...['14', '15', '16', '17', '18', '19', '20'].map((d) => e(`2026-09-${d}`, 4)),
    ];
    const t = energyTrend(entries, '2026-09-20');
    expect(t.recent).toBe(4);
    expect(t.prior).toBe(2);
    expect(t.direction).toBe('up');
    expect(t.ratedDays).toBe(7);
  });

  it('unknown without data', () => {
    expect(energyTrend([], '2026-09-20').direction).toBe('unknown');
  });
});
