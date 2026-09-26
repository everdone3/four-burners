// Local IndexedDB store. Every write lands here first; sync (Phase 5) reads from here.
import Dexie, { type EntityTable } from 'dexie';
import type {
  CrunchPeriod,
  EnergyEntry,
  Goal,
  LogEntry,
  Person,
  Quarter,
  Settings,
  Touchpoint,
  WeeklyAction,
  WeeklyReview,
  Profile,
  CoachReply,
} from "@/domain";

export interface KV {
  key: string;
  value: unknown;
  updatedAt: string;
}

export class FourBurnersDB extends Dexie {
  quarters!: EntityTable<Quarter, 'id'>;
  goals!: EntityTable<Goal, 'id'>;
  logs!: EntityTable<LogEntry, 'id'>;
  energy!: EntityTable<EnergyEntry, 'id'>;
  people!: EntityTable<Person, 'id'>;
  touchpoints!: EntityTable<Touchpoint, 'id'>;
  crunch!: EntityTable<CrunchPeriod, "id">;
  reviews!: EntityTable<WeeklyReview, "id">;
  actions!: EntityTable<WeeklyAction, "id">;
  profiles!: EntityTable<Profile, "id">;
  coachReplies!: EntityTable<CoachReply, "id">;
  kv!: EntityTable<KV, 'key'>;

  constructor(name = 'four-burners') {
    super(name);
    // Versioned local schema. Add a new version() block for every change; never edit old ones.
    this.version(1).stores({
      quarters: 'id, status, updatedAt',
      goals: 'id, quarterId, burner, updatedAt',
      logs: 'id, goalId, localDate, updatedAt',
      energy: 'id, localDate, updatedAt',
      people: 'id, burner, updatedAt',
      touchpoints: 'id, personId, localDate, updatedAt',
      crunch: 'id, start, updatedAt',
      kv: 'key',
    });
    // v2: weekly reviews and the actions they create.
    this.version(2).stores({
      reviews: 'id, weekStart, updatedAt',
      actions: 'id, weekStart, updatedAt',
    });
    // v3: the About me profile and saved coach replies.
    this.version(3).stores({
      profiles: "id, updatedAt",
      coachReplies: "id, kind, scope, updatedAt",
    });
  }
}

export const db = new FourBurnersDB();

export const SETTINGS_KEY = 'settings';
export type { Settings };
