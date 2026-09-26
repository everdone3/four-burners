// Key people and connection cadence.
import { diffDays } from './dates';
import type { LocalDate, Person, Touchpoint } from './types';

export type ConnectionState = 'fresh' | 'approaching' | 'due' | 'overdue' | 'never';

export interface PersonStatus {
  person: Person;
  lastDate?: LocalDate;
  daysSince: number | null;
  /** Days until the cadence is reached; negative when past it. */
  daysUntilDue: number | null;
  /** daysSince / cadence. 0 = just connected, 1 = due today. */
  ratio: number | null;
  state: ConnectionState;
}

/** Thresholds as a fraction of the person's cadence. */
export const CADENCE_THRESHOLDS = { approaching: 0.7, due: 1, overdue: 1.35 } as const;

export const CADENCE_OPTIONS: { days: number; label: string }[] = [
  { days: 3, label: 'Every few days' },
  { days: 7, label: 'Every week' },
  { days: 14, label: 'Every 2 weeks' },
  { days: 30, label: 'Monthly' },
  { days: 60, label: 'Every 2 months' },
  { days: 90, label: 'Quarterly' },
];

export function cadenceLabel(days: number): string {
  return CADENCE_OPTIONS.find((o) => o.days === days)?.label ?? `Every ${days} days`;
}

export function personStatus(person: Person, touchpoints: readonly Touchpoint[], today: LocalDate): PersonStatus {
  let lastDate: LocalDate | undefined;
  for (const t of touchpoints) {
    if (t.deleted || t.personId !== person.id || t.localDate > today) continue;
    if (!lastDate || t.localDate > lastDate) lastDate = t.localDate;
  }
  if (!lastDate) return { person, daysSince: null, daysUntilDue: null, ratio: null, state: 'never' };
  const daysSince = diffDays(lastDate, today);
  const ratio = daysSince / Math.max(1, person.cadenceDays);
  const state: ConnectionState =
    ratio < CADENCE_THRESHOLDS.approaching
      ? 'fresh'
      : ratio < CADENCE_THRESHOLDS.due
        ? 'approaching'
        : ratio < CADENCE_THRESHOLDS.overdue
          ? 'due'
          : 'overdue';
  return { person, lastDate, daysSince, daysUntilDue: person.cadenceDays - daysSince, ratio, state };
}

/** People sorted by who most needs attention: overdue first, then due, never, approaching, fresh. */
export function peopleByUrgency(people: readonly Person[], touchpoints: readonly Touchpoint[], today: LocalDate): PersonStatus[] {
  const rank: Record<ConnectionState, number> = { overdue: 0, due: 1, never: 2, approaching: 3, fresh: 4 };
  return people
    .filter((p) => !p.deleted)
    .map((p) => personStatus(p, touchpoints, today))
    .sort((a, b) => rank[a.state] - rank[b.state] || (b.ratio ?? 0) - (a.ratio ?? 0) || a.person.order - b.person.order);
}

/** "Today", "Yesterday", "5 days ago", "Never" */
export function lastConnectedLabel(s: PersonStatus): string {
  if (s.daysSince === null) return 'Not yet';
  if (s.daysSince === 0) return 'Today';
  if (s.daysSince === 1) return 'Yesterday';
  return `${s.daysSince} days ago`;
}
