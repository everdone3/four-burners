// Sync contracts shared by the sync engine, the Supabase remote, the scheduler, and the UI.
//
// Model: every local record carries `updatedAt` (ISO UTC, `Date.prototype.toISOString()` format) and a
// local-only `_dirty` flag (1 = changed here and not yet pushed). The server keeps one row per record in a
// single `records` table keyed by (user_id, collection, id), with the record body as jsonb. Conflicts
// resolve last-write-wins on updated_at, both on the server (conditional upsert) and on the client (when
// applying pulled rows).

/** Dexie tables that sync. `kv` syncs only the keys in SYNCED_KV_KEYS. */
export const SYNCED_COLLECTIONS = [
  'quarters',
  'goals',
  'logs',
  'energy',
  'people',
  'touchpoints',
  'crunch',
  'reviews',
  'actions',
  'profiles',
  'coachReplies',
  'kv',
] as const;
export type Collection = (typeof SYNCED_COLLECTIONS)[number];

/** Device-level kv keys (sync cursors, time zone memory, sample bookkeeping, backup reminders...) never leave the device. */
export const SYNCED_KV_KEYS: readonly string[] = ['settings', 'onboarding'];

/** Primary key field per collection (kv uses `key`, everything else `id`). */
export function primaryKeyOf(collection: Collection): 'id' | 'key' {
  return collection === 'kv' ? 'key' : 'id';
}

/**
 * The updatedAt given to records the app creates on its own (for example the current quarter, created
 * with default intents the first time a device opens in that quarter). Any real edit, on any device,
 * is newer, so an untouched auto-created record can never overwrite real data during sync.
 */
export const SEED_UPDATED_AT = '1970-01-01T00:00:00.000Z';

/**
 * For an auto-created record the app has filled in on its own (for example next quarter's intents copied
 * from the quarter close). One millisecond above a plain seed: it beats an untouched seed from another
 * device (so the filled-in content spreads), but still loses to any real edit. Stamps at or below this
 * count as seeds everywhere (see isSeedStamp).
 */
export const PREFILLED_UPDATED_AT = '1970-01-01T00:00:00.001Z';

/** True for SEED_UPDATED_AT, PREFILLED_UPDATED_AT, or anything older (unreadable stamps count as seeds too). */
export function isSeedStamp(updatedAt: unknown): boolean {
  const ms = typeof updatedAt === 'string' ? Date.parse(updatedAt) : NaN;
  return !(ms > Date.parse(PREFILLED_UPDATED_AT));
}

/** A row as sent to the server. `data` is the local record minus local-only fields. */
export interface RemoteRow {
  collection: Collection;
  id: string;
  data: Record<string, unknown>;
  /** The record's own updatedAt (client clock, toISOString format). Drives last-write-wins. */
  updated_at: string;
  deleted: boolean;
}

/** A pulled row also carries the server's own change time, used as the incremental pull cursor. */
export interface PulledRow extends Omit<RemoteRow, 'collection'> {
  /** Any string: rows for collections this build does not know are skipped by the engine. */
  collection: string;
  /**
   * Server change time, always formatted `YYYY-MM-DDTHH:MM:SS.ffffffZ` (UTC, exactly 6 fractional
   * digits) so it sorts lexically and round-trips to Postgres without losing microseconds.
   * Treat as opaque except for the overlap computation (see engine.ts).
   */
  server_updated_at: string;
}

/**
 * Keyset position in the pull order (server_updated_at, collection, id), all compared as text/timestamps.
 * `ts` may also be a plain toISOString() lower bound (the overlap start), with collection = id = ''.
 */
export interface PullCursor {
  ts: string;
  collection: string;
  id: string;
}

/** The server side of sync. The Supabase implementation and an in-memory test double both satisfy it. */
export interface RemoteStore {
  /**
   * Apply rows with last-write-wins: a row whose updated_at is not strictly newer than the server's
   * copy is ignored (silently). Duplicate (collection, id) pairs in one call keep the newest.
   * Throws on failure (offline, auth, server). Either the whole call applies or none of it does.
   */
  push(rows: RemoteRow[]): Promise<void>;
  /**
   * Up to `limit` rows strictly after `after` in (server_updated_at, collection, id) order, oldest first.
   * `after = null` means from the beginning. Only the signed-in user's rows.
   */
  pull(after: PullCursor | null, limit: number): Promise<PulledRow[]>;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  applied: number;
}

/**
 * unconfigured: this build has no Supabase URL/key. signedOut: configured, nobody signed in.
 * idle: signed in and up to date as of lastSyncedAt. syncing: a run is in flight.
 * offline: signed in, no network (changes wait in the offline queue). error: last run failed (see error).
 */
export type SyncState = 'unconfigured' | 'signedOut' | 'idle' | 'syncing' | 'offline' | 'error';

export interface SyncStatus {
  state: SyncState;
  /** Signed-in email, when signed in. */
  email?: string;
  /** ISO time of the last successful sync on this device. */
  lastSyncedAt?: string;
  /** Local changes waiting to be pushed. */
  pending: number;
  /** Short, plain-language message for the UI (no em dashes). */
  error?: string;
}

/** Local-only fields stripped before a record leaves the device. */
export const LOCAL_ONLY_FIELDS = ['_dirty'] as const;
