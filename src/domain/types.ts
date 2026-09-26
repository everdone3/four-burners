// Core domain types. Pure data, no UI or storage concerns.
// Mirrors cleanly to Swift structs/enums for a future native version.

export type BurnerId = 'family' | 'friends' | 'health' | 'work';
export const BURNERS: readonly BurnerId[] = ['family', 'friends', 'health', 'work'] as const;
export const BURNER_LABELS: Record<BurnerId, string> = {
  family: 'Family',
  friends: 'Friends',
  health: 'Health',
  work: 'Work',
};

export type Intent = 'high' | 'steady' | 'low';
export const INTENTS: readonly Intent[] = ['high', 'steady', 'low'] as const;
export const INTENT_LABELS: Record<Intent, string> = { high: 'High', steady: 'Steady', low: 'Low' };

export type GoalType = 'number' | 'habit' | 'yesno' | 'milestone';
export type HabitPeriod = 'week' | 'month';

/** Calendar date in the user's lived day, 'YYYY-MM-DD'. */
export type LocalDate = string;
/** '2026-Q3' */
export type QuarterId = string;
/** ISO 8601 UTC timestamp. */
export type Instant = string;

/** Every stored record carries these so sync can do last-write-wins. */
export interface BaseRecord {
  id: string;
  createdAt: Instant;
  updatedAt: Instant;
  deleted?: boolean;
}

/** When an entry happened: UTC instant plus the local context it was recorded in. */
export interface Stamp {
  at: Instant;
  /** Minutes east of UTC at the time of recording (e.g. -300 for EST). */
  offsetMin: number;
  /** The lived local date this entry belongs to (after day-boundary shift). */
  localDate: LocalDate;
}

export interface IntentChange {
  burner: BurnerId;
  from: Intent;
  to: Intent;
  reason: string;
  at: Instant;
  localDate: LocalDate;
}

export interface Quarter extends BaseRecord {
  /** Same as QuarterId, e.g. '2026-Q3'. */
  id: QuarterId;
  theme?: string;
  intents: Record<BurnerId, Intent>;
  intentHistory: IntentChange[];
  status: 'active' | 'closed';
}

export interface Milestone {
  id: string;
  title: string;
  doneAt?: Instant;
}

export interface Goal extends BaseRecord {
  quarterId: QuarterId;
  burner: BurnerId;
  title: string;
  type: GoalType;
  why?: string;
  whenWhere?: string;
  /** First lived day the goal counts toward (proration start). */
  startDate: LocalDate;
  /** Last day of the goal, inclusive. Defaults to quarter end. */
  deadline: LocalDate;
  /** number: total target. habit: occurrences per period. */
  target?: number;
  unit?: string;
  habitPeriod?: HabitPeriod;
  milestones?: Milestone[];
  personIds?: string[];
  order: number;
}

export interface LogEdit {
  at: Instant;
  prevValue: number;
  prevNote?: string;
}

export interface LogEntry extends BaseRecord, Stamp {
  goalId: string;
  /** number: amount. habit: occurrences (usually 1). yesno: 1. milestone: 1 */
  value: number;
  milestoneId?: string;
  note?: string;
  notePrivate?: boolean;
  edits?: LogEdit[];
}

export interface EnergyEntry extends BaseRecord, Stamp {
  rating: 1 | 2 | 3 | 4 | 5;
}

export type Cadence = 7 | 14 | 30 | 60 | 90;

export interface Person extends BaseRecord {
  name: string;
  burner: 'family' | 'friends';
  cadenceDays: number;
  order: number;
}

export type TouchpointType = 'call' | 'text' | 'in_person' | 'other';

export interface Touchpoint extends BaseRecord, Stamp {
  personId: string;
  type: TouchpointType;
  note?: string;
  notePrivate?: boolean;
}

export interface CrunchPeriod extends BaseRecord {
  start: LocalDate;
  /** Inclusive. Undefined while open-ended. */
  end?: LocalDate;
  label?: string;
}

export interface Settings {
  dayBoundaryHour: number;
  graceDaysPerWeek: number;
  soundEffects: boolean;
  haptics: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  dayBoundaryHour: 3,
  graceDaysPerWeek: 1,
  soundEffects: true,
  haptics: true,
};
