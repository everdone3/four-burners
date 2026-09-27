// Local IndexedDB store. Every write lands here first; sync (Phase 5) reads from here.
import Dexie, { type EntityTable } from 'dexie';
import { SYNCED_COLLECTIONS } from '@/sync/types';
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
    // v4: sync. Every synced table gets a `_dirty` index (1 = changed here, not yet pushed).
    // Everything that existed before sync counts as a local change, so the first sign-in uploads it.
    this.version(4)
      .stores({
        quarters: 'id, status, updatedAt, _dirty',
        goals: 'id, quarterId, burner, updatedAt, _dirty',
        logs: 'id, goalId, localDate, updatedAt, _dirty',
        energy: 'id, localDate, updatedAt, _dirty',
        people: 'id, burner, updatedAt, _dirty',
        touchpoints: 'id, personId, localDate, updatedAt, _dirty',
        crunch: 'id, start, updatedAt, _dirty',
        reviews: 'id, weekStart, updatedAt, _dirty',
        actions: 'id, weekStart, updatedAt, _dirty',
        profiles: 'id, updatedAt, _dirty',
        coachReplies: 'id, kind, scope, updatedAt, _dirty',
        kv: 'key, _dirty',
      })
      .upgrade(async (tx) => {
        await Promise.all(SYNCED_COLLECTIONS.map((t) => tx.table(t).toCollection().modify({ _dirty: 1 })));
      });

    // Change tracking for sync (the offline queue): any write marks the record dirty, unless the write
    // sets `_dirty` itself (the sync engine writes pulled records with _dirty: 0 and marks pushed ones clean).
    for (const t of SYNCED_COLLECTIONS) {
      const table = this.table(t);
      table.hook('creating', (_key, obj: Record<string, unknown>) => {
        if (obj._dirty !== 0) obj._dirty = 1;
      });
      table.hook('updating', (mods) => {
        // A put() of a fresh object (without `_dirty`) over a stored record shows up here as `_dirty: undefined`
        // (the property was removed). That is an app write, so it must still mark the record dirty.
        if ((mods as Record<string, unknown>)._dirty !== undefined) return undefined;
        return { _dirty: 1 };
      });
    }
  }
}

export const db = new FourBurnersDB();

export const SETTINGS_KEY = 'settings';
export type { Settings };
