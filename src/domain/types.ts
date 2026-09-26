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

export interface QuarterSummary {
  progressScore: number;
  consistencyScore: number;
  longestStreak: number;
  checkInDays: number;
}

export interface Quarter extends BaseRecord {
  /** Same as QuarterId, e.g. '2026-Q3'. */
  id: QuarterId;
  theme?: string;
  intents: Record<BurnerId, Intent>;
  intentHistory: IntentChange[];
  status: 'active' | 'closed';
  /** When the guided quarter setup was finished. */
  setupAt?: Instant;
  /** When the guided quarter close was finished. */
  closedAt?: Instant;
  /** Final scores, frozen at close for the archive. */
  summary?: QuarterSummary;
}

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';
export type CloseDecision = 'carry' | 'modify' | 'drop';

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
  /** Set during quarter close. */
  grade?: Grade;
  closeDecision?: CloseDecision;
  /** The goal this was carried forward from, and the goal it was carried into. */
  carriedFromId?: string;
  carriedToId?: string;
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

export interface WeeklyReview extends BaseRecord {
  /** Monday of the week being reviewed. Review ids are `review-<weekStart>` so devices never duplicate. */
  weekStart: LocalDate;
  /** Current step index, saved on every move so the review resumes exactly. */
  step: number;
  wins: string[];
  misses: string[];
  focus: string;
  focusBurners: BurnerId[];
  /** Half-typed text, so leaving the app mid-sentence loses nothing. */
  drafts?: { win?: string; miss?: string; action?: string };
  coachSkipped?: boolean;
  completedAt?: Instant;
}

export interface WeeklyAction extends BaseRecord {
  /** Monday of the week this action is for. */
  weekStart: LocalDate;
  text: string;
  burner?: BurnerId;
  order: number;
  /** Set when tapped done. Counts as a check-in. */
  done?: Stamp;
}

export type TravelRhythm = 'rare' | 'monthly' | 'weekly' | 'mostly_away';

export interface BurnerProfile {
  /** Family/Friends: who matters and how often. Health: what it covers. Work: role at altitude, what it must never cost. */
  matters: string;
  /** What a winning quarter looks like for this burner, in the user's words. */
  winning: string;
}

/** The fields of the About me profile (everything the coach may see, after redaction). */
export interface ProfileFields {
  lifeContext: string;
  burners: Record<BurnerId, BurnerProfile>;
  travel: TravelRhythm | null;
  crunch: string;
}

/** The editable "About me" profile built by the onboarding interview. One record, id 'me'. */
export interface Profile extends BaseRecord, ProfileFields {
  id: 'me';
  /** What last shaped the profile. */
  source: 'interview' | 'edited' | 'coach';
  /** One-level snapshot before a coach replace or interview re-run, for "Restore previous version". */
  previous?: ProfileFields;
  onboardedAt?: Instant;
}

export const EMPTY_PROFILE_FIELDS: ProfileFields = {
  lifeContext: '',
  burners: {
    family: { matters: '', winning: '' },
    friends: { matters: '', winning: '' },
    health: { matters: '', winning: '' },
    work: { matters: '', winning: '' },
  },
  travel: null,
  crunch: '',
};

export type PacketKind = 'onboarding' | 'weekly' | 'quarter_setup' | 'checkin';

/** A coach reply pasted back into the app, saved to the week or quarter it belongs to. */
export interface CoachReply extends BaseRecord {
  kind: PacketKind;
  /** weekly: week Monday. quarter_setup: quarter id. checkin: local date. onboarding: 'profile'. */
  scope: string;
  text: string;
  /** Suggested actions parsed from the reply. */
  actions: string[];
  /** Which of those were turned into weekly actions. */
  addedActions?: string[];
  packetChars?: number;
}

export interface Settings {
  dayBoundaryHour: number;
  graceDaysPerWeek: number;
  soundEffects: boolean;
  haptics: boolean;
  /** Weekly review day, 0 = Monday ... 6 = Sunday. */
  reviewDay: number;
  /** Company or client names that are always redacted from coach packets. */
  sensitiveTerms: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  dayBoundaryHour: 3,
  graceDaysPerWeek: 1,
  soundEffects: true,
  haptics: true,
  reviewDay: 6,
  sensitiveTerms: [],
};
