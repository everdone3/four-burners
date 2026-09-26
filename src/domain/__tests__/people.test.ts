import { describe, expect, it } from 'vitest';
import { lastConnectedLabel, peopleByUrgency, personStatus } from '../people';
import type { Person, Touchpoint } from '../types';

const T = '2026-09-01T12:00:00Z';
const person = (id: string, cadenceDays: number, order = 0): Person => ({ id, name: id, burner: 'friends', cadenceDays, order, createdAt: T, updatedAt: T });
const touch = (personId: string, localDate: string, extra: Partial<Touchpoint> = {}): Touchpoint => ({
  id: `${personId}${localDate}`, personId, type: 'call', localDate, at: `${localDate}T18:00:00Z`, offsetMin: -240, createdAt: T, updatedAt: T, ...extra,
});

describe('connection cadence', () => {
  const jake = person('jake', 14);

  it('never contacted', () => {
    const s = personStatus(jake, [], '2026-09-20');
    expect(s.state).toBe('never');
    expect(lastConnectedLabel(s)).toBe('Not yet');
  });

  it('moves through fresh, approaching, due, overdue', () => {
    const tps = [touch('jake', '2026-09-01')];
    expect(personStatus(jake, tps, '2026-09-05').state).toBe('fresh'); // 4/14
    expect(personStatus(jake, tps, '2026-09-12').state).toBe('approaching'); // 11/14
    expect(personStatus(jake, tps, '2026-09-15').state).toBe('due'); // 14/14
    expect(personStatus(jake, tps, '2026-09-25').state).toBe('overdue'); // 24/14
  });

  it('uses the most recent touchpoint and ignores deleted ones', () => {
    const tps = [touch('jake', '2026-09-01'), touch('jake', '2026-09-18', { deleted: true }), touch('jake', '2026-09-10')];
    const s = personStatus(jake, tps, '2026-09-20');
    expect(s.lastDate).toBe('2026-09-10');
    expect(s.daysSince).toBe(10);
    expect(s.daysUntilDue).toBe(4);
    expect(lastConnectedLabel(s)).toBe('10 days ago');
  });

  it('sorts by urgency', () => {
    const people = [person('fresh', 14, 0), person('overdue', 7, 1), person('never', 7, 2), person('due', 10, 3)];
    const tps = [touch('fresh', '2026-09-19'), touch('overdue', '2026-09-01'), touch('due', '2026-09-10')];
    expect(peopleByUrgency(people, tps, '2026-09-20').map((s) => s.person.id)).toEqual(['overdue', 'due', 'never', 'fresh']);
  });
});
