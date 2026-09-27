// The sync engine: pushes local changes (records with _dirty = 1) and pulls remote changes, resolving
// conflicts last-write-wins on updatedAt. Pure orchestration over a Dexie database and a RemoteStore,
// so it is fully testable with two in-memory devices (see memoryRemote.ts and engine.test.ts).
//
// CONTRACT (implement exactly; tests pin every rule):
//
// Accounts and cursors
// - Each engine is bound to one account (`accountId`, the Supabase user id). Device-local kv keys:
//     `syncCursor:<accountId>`       the largest server_updated_at applied so far (a PulledRow string)
//     `syncSchema:<accountId>`       SYNC_SCHEMA of the build that saved the cursor (written with it)
//     `syncJoined:<accountId>`       set (value true) once this device has completed its first full pull
//     `syncJoinStarted:<accountId>`  ISO time this device's join first started (deleted once joined)
//     `syncEpoch`                    a random value for this device's sync state (one per device, not
//                                    per account); an erase removes it (see forget())
//   These keys are not in SYNCED_KV_KEYS, so they never leave the device.
//
// syncNow(): concurrent calls share one in-flight run (the second caller gets the same promise).
//   Each run starts with one kv transaction that reads syncJoined (the mode) and creates syncEpoch, and
//   in JOIN mode syncJoinStarted (set to now), when missing. A resumed join keeps the first run's time.
//   JOIN (this device has not completed a first full pull for this account, i.e. no syncJoined key):
//     1. Pull everything (resuming from the saved cursor if a previous join was interrupted), and for
//        every row whose record also exists locally, REMOTE WINS regardless of timestamps (a fresh
//        device's seeded or accidental records must never overwrite the account's real data).
//        Two exceptions:
//        a. A record this join already brought here and then edited here follows last-write-wins, as in
//           NORMAL mode: the local record is dirty (_dirty = 1), its updatedAt is at or after
//           syncJoinStarted, and the row's server_updated_at is at or before the saved cursor (one that
//           counts, see Pull) as read in the page transaction (so the row was already applied on this
//           device in this join, by this tab or another; rows sharing the cursor's exact time count too).
//           An edit made during a join run, or between an interrupted join and its resume (offline, or
//           signed out and back in), is kept and pushed in step 3 instead of being replaced by the older
//           server copy. A record left from before the join still loses even if edited since: that edit
//           was made to this device's own copy, not the account's.
//        b. The seed promise in ./types: a seeded row (isSeedStamp(updated_at): an untouched or
//           pre-filled auto-created record) never replaces a local record with a newer updatedAt. The
//           local record is kept; if dirty (the usual case on a fresh device), step 3 pushes it and it
//           wins on the server. A clean one (synced to another account) is not pushed.
//     2. Set syncJoined and delete syncJoinStarted (one transaction). 3. Push (normal push rules below).
//   NORMAL (joined): push, then pull with last-write-wins.
//   Result: pushed = rows sent in push calls that succeeded (the server may still ignore older ones);
//   pulled = rows received, including ignored ones and overlap re-reads; applied = rows written locally.
//
// Options: batchSize is kept within 1..1000 (push_records takes at most 1000 rows, and pull_records never
// returns more than 1000, so a larger page size would end paging early). overlapMs is never negative.
//
// Push
// - Every record in a synced table with _dirty = 1 that is not local-only, in batches of `batchSize`,
//   via remote.push(toRemoteRow(...)). Batches are also capped at about 512 KB of JSON. toRemoteRow
//   cleans strings Postgres jsonb refuses (NUL, lone surrogates) and sends an out-of-range updatedAt as
//   SEED_UPDATED_AT. If the server refuses a batch's content (SyncError.rejected), the batch is split
//   until the refused records are found; they stay dirty, everything else syncs, and the run then
//   throws a SyncError saying how many changes could not be saved.
// - After a batch succeeds, mark each record clean (_dirty: 0) ONLY if the stored record is unchanged
//   since it was read (compare the full record minus _dirty, not just updatedAt), inside a rw
//   transaction. A record edited during the push stays dirty and goes next time.
// - If push throws, records stay dirty (that is the offline queue) and the error propagates.
//
// Pull
// - Pages of `batchSize` via remote.pull(after, batchSize). The first page starts `overlapMs` before
//   the saved cursor: after = { ts: new Date(Date.parse(cursor.slice(0, 23) + 'Z') - overlapMs).toISOString(),
//   collection: '', id: '' } (re-applying a row is harmless). With no saved cursor (or one that is not
//   a PulledRow server_updated_at string), after = null.
//   The saved cursor counts only when syncSchema equals this build's SYNC_SCHEMA (SYNCED_COLLECTIONS and
//   SYNCED_KV_KEYS). Otherwise (none saved, or saved by a build that synced other collections or kv
//   keys, whose cursor may have moved past rows it skipped) after = null: one full pull under the run's
//   usual rules (last-write-wins, or the JOIN rules). The page transaction that writes this pull's first
//   cursor also writes syncSchema, so an interrupted full pull resumes from its own cursor.
//   Each later page continues from the last row of the previous page ({ ts: row.server_updated_at,
//   collection: row.collection, id: row.id }). Stop when a page returns fewer than batchSize rows.
// - Apply each page in ONE rw transaction over the synced tables (so an app write cannot interleave
//   between the read of the local record and the write of the remote one):
//     * ignore rows whose collection is not in SYNCED_COLLECTIONS, kv rows whose id is not in
//       SYNCED_KV_KEYS, and rows whose local counterpart (or the record they would write) is
//       local-only (isLocalOnly);
//     * NORMAL mode: write when there is no local record, or Date.parse(row.updated_at) >
//       Date.parse(local.updatedAt) (remote wins even over a dirty local record). Otherwise keep local
//       (if local is dirty, it pushes next time and wins on the server);
//     * JOIN mode: write whenever the row exists (remote wins), except exceptions a and b above;
//     * a written record is exactly row.data (primary key forced to row.id) with _dirty: 0.
//       PITFALL: the Dexie 'updating' hook marks a record dirty unless the modification itself contains
//       `_dirty`, and Dexie computes the modification as a diff against the stored record. So a put()
//       that overwrites an already-clean record with `_dirty: 0` produces a diff WITHOUT `_dirty` and
//       the hook re-dirties it. The engine writes, re-reads, and only then update(key, { _dirty: 0 })
//       when the stored value is not 0 (same transaction). Mark-clean after push follows the same rule.
//       (update() with an unchanged value is skipped by Dexie 4's modify, so it cannot dirty a clean
//       record; the check just saves the write.) A put() WITHOUT `_dirty` over an existing record is
//       the opposite trap: the diff shows `_dirty` removed, the hook treats that as explicit, and the
//       record drops out of the _dirty index. App code must set `_dirty: 1` on whole-record puts.
// - Save the cursor = the largest server_updated_at seen in this pull (lexical max; PulledRow strings
//   sort correctly) as the last write of each page's transaction, so it commits together with the page.
//   (A full pull after a schema change may save a lower cursor than before; it only moves forward again.)
//
// Record <-> row
// - data = the record minus LOCAL_ONLY_FIELDS; id = String(record[primaryKeyOf(collection)]);
//   updated_at = record.updatedAt normalized to toISOString. A record whose updatedAt is not an ISO
//   stamp with a time zone (the backup rule: one that Date.parse and Postgres read the same way) uses
//   SEED_UPDATED_AT, so one malformed record cannot make the server reject every push, and no device
//   reads it differently. Local comparisons use the same value;
//   deleted = !!record.deleted (soft deletes sync like any edit).
//
// Local-only records never leave the device and are never overwritten by a pull: see isLocalOnly in
// ./localOnly (sample data, quarters the sample loader created, device-level kv keys).
//
// pendingCount(): number of dirty, non-local-only records across synced tables.
// forget(): delete this account's sync keys and the device's syncEpoch (syncStateKeys; used after
//   "Erase all data on this device").
//   A run already in flight writes and sends nothing more after forget() (it rejects at its next local
//   write or request; a request already on its way still completes), and the next syncNow() starts a
//   fresh run, which is a JOIN. This holds for runs in every tab: each run re-reads syncEpoch before
//   each request and inside each transaction that writes (page apply, mark clean, joined), and rejects
//   when it changed. So another tab's forget(), or the wipe after it (which clears kv), stops it before
//   it can write rows or a cursor into the erased database.
//
// No timers here: the scheduler decides when to call syncNow().
import type { FourBurnersDB } from '@/data/db';
import { isLocalOnly, loadSampleQuarterIds } from './localOnly';
import { SyncError, isSyncError } from './remote';
import {
  LOCAL_ONLY_FIELDS,
  SEED_UPDATED_AT,
  SYNCED_COLLECTIONS,
  SYNCED_KV_KEYS,
  isSeedStamp,
  primaryKeyOf,
  type Collection,
  type PullCursor,
  type PulledRow,
  type RemoteRow,
  type RemoteStore,
  type SyncResult,
} from './types';

export const cursorKey = (accountId: string) => `syncCursor:${accountId}`;
export const joinedKey = (accountId: string) => `syncJoined:${accountId}`;
export const joinStartedKey = (accountId: string) => `syncJoinStarted:${accountId}`;
export const schemaKey = (accountId: string) => `syncSchema:${accountId}`;
/** Device-wide: a random value per sync state; an erase (forget() or the wipe) removes it. */
export const EPOCH_KEY = 'syncEpoch';

/** What this build syncs. A cursor saved under another signature may have moved past rows this build reads. */
export const SYNC_SCHEMA = `${[...SYNCED_COLLECTIONS].sort().join(',')};${[...SYNCED_KV_KEYS].sort().join(',')}`;

/** Every device-local kv key sync keeps for this account, plus the device's syncEpoch. forget() deletes them all. */
export const syncStateKeys = (accountId: string) => [
  cursorKey(accountId),
  joinedKey(accountId),
  joinStartedKey(accountId),
  schemaKey(accountId),
  EPOCH_KEY,
];

export interface SyncEngineOptions {
  db: FourBurnersDB;
  remote: RemoteStore;
  /** Supabase user id; scopes the cursor and join state on this device. */
  accountId: string;
  /** Rows per push batch and per pull page. Default 200. */
  batchSize?: number;
  /** How far before the saved cursor the first pull page starts. Default 5 minutes (300000 ms). */
  overlapMs?: number;
}

export interface SyncEngine {
  syncNow(): Promise<SyncResult>;
  pendingCount(): Promise<number>;
  forget(): Promise<void>;
}

type LocalRecord = Record<string, unknown>;
/** JOIN carries the time (ms) the join first started: local edits since then follow last-write-wins. */
type Mode = { kind: 'join'; since: number } | { kind: 'normal' };
type QueueItem = { collection: Collection; record: LocalRecord };
/** Rejects when this run must stop: forget() in this tab, or an erase in any tab. */
type Check = () => Promise<void>;

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const { db, remote, accountId } = options;
  const batchSize = Number.isFinite(options.batchSize) ? Math.min(MAX_BATCH, Math.max(1, Math.floor(options.batchSize!))) : 200;
  const overlapMs = Number.isFinite(options.overlapMs) ? Math.max(0, options.overlapMs!) : 300_000;
  const tableOf = (c: Collection) => db.table<LocalRecord, string>(c);
  const syncedTables = () => SYNCED_COLLECTIONS.map(tableOf);

  let inflight: Promise<SyncResult> | null = null;
  // Bumped by forget(); a run started under an older generation must not write anything more.
  let generation = 0;

  async function run(): Promise<SyncResult> {
    const gen = generation;
    const reset = () => new Error('Sync was reset on this device.');
    const ensureCurrent = () => {
      if (gen !== generation) throw reset();
    };
    // One transaction, so a join another tab has just finished is seen together with its keys.
    const start = await db.transaction('rw', db.kv, async (): Promise<{ epoch: string; mode: Mode }> => {
      ensureCurrent();
      const at = new Date().toISOString();
      const savedEpoch = (await db.kv.get(EPOCH_KEY))?.value;
      let epoch = typeof savedEpoch === 'string' ? savedEpoch : '';
      if (!epoch) {
        epoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        await db.kv.put({ key: EPOCH_KEY, value: epoch, updatedAt: at });
      }
      if ((await db.kv.get(joinedKey(accountId)))?.value) return { epoch, mode: { kind: 'normal' } };
      const started = (await db.kv.get(joinStartedKey(accountId)))?.value;
      let since = typeof started === 'string' ? Date.parse(started) : NaN;
      if (Number.isNaN(since)) {
        await db.kv.put({ key: joinStartedKey(accountId), value: at, updatedAt: at });
        since = Date.parse(at);
      }
      return { epoch, mode: { kind: 'join', since } };
    });
    // Another tab's erase deletes the epoch (forget()) and then clears kv (the wipe). Inside a transaction
    // that includes kv, this check commits together with the writes, so nothing lands after an erase.
    const check: Check = async () => {
      ensureCurrent();
      if ((await db.kv.get(EPOCH_KEY))?.value !== start.epoch) throw reset();
    };
    let result: SyncResult;
    let refused: number;
    if (start.mode.kind === 'normal') {
      const p = await push(check);
      const { pulled, applied } = await pull(start.mode, check);
      result = { pushed: p.pushed, pulled, applied };
      refused = p.refused;
    } else {
      const { pulled, applied } = await pull(start.mode, check);
      await db.transaction('rw', db.kv, async () => {
        await check();
        await db.kv.put({ key: joinedKey(accountId), value: true, updatedAt: new Date().toISOString() });
        await db.kv.delete(joinStartedKey(accountId));
      });
      const p = await push(check);
      result = { pushed: p.pushed, pulled, applied };
      refused = p.refused;
    }
    // Everything else synced. Report the refused records so the status can say so.
    if (refused) {
      throw new SyncError('server', {
        message:
          refused === 1
            ? "1 change couldn't be saved to your account. Editing it again may fix it."
            : `${refused} changes couldn't be saved to your account. Editing them again may fix it.`,
        rejected: true,
      });
    }
    return result;
  }

  async function push(check: Check): Promise<{ pushed: number; refused: number }> {
    const sampleQuarters = await loadSampleQuarterIds(db);
    const queue: QueueItem[] = [];
    for (const collection of SYNCED_COLLECTIONS) {
      for (const record of await tableOf(collection).where('_dirty').equals(1).toArray()) {
        if (!isLocalOnly(collection, record, sampleQuarters)) queue.push({ collection, record });
      }
    }
    let pushed = 0;
    let refused = 0;
    for (const batch of batches(queue, batchSize)) {
      await check();
      const { sent, rejected } = await pushIsolating(batch, check);
      pushed += sent.length;
      refused += rejected.length;
      if (!sent.length) continue;
      await db.transaction('rw', syncedTables(), async () => {
        await check();
        for (const { collection, record } of sent) {
          const table = tableOf(collection);
          const key = record[primaryKeyOf(collection)] as string;
          const stored = await table.get(key);
          if (stored && stored._dirty !== 0 && sameRecord(stored, record)) await table.update(key, { _dirty: 0 });
        }
      });
    }
    return { pushed, refused };
  }

  /**
   * Push a batch. If the server refuses the rows' content (SyncError.rejected), split the batch until the
   * refused records are found, so one bad record can never block every other change on this device.
   * Refused records stay dirty (they retry on later runs and may succeed once edited).
   */
  async function pushIsolating(batch: QueueItem[], check: Check): Promise<{ sent: QueueItem[]; rejected: QueueItem[] }> {
    try {
      await remote.push(batch.map(({ collection, record }) => toRemoteRow(collection, record)));
      return { sent: batch, rejected: [] };
    } catch (e) {
      if (!(isSyncError(e) && e.rejected)) throw e;
      if (batch.length === 1) return { sent: [], rejected: batch };
      await check();
      const mid = Math.ceil(batch.length / 2);
      const a = await pushIsolating(batch.slice(0, mid), check);
      const b = await pushIsolating(batch.slice(mid), check);
      return { sent: [...a.sent, ...b.sent], rejected: [...a.rejected, ...b.rejected] };
    }
  }

  async function pull(mode: Mode, check: Check): Promise<{ pulled: number; applied: number }> {
    const [saved, savedSchema] = await db.kv.bulkGet([cursorKey(accountId), schemaKey(accountId)]);
    // A cursor saved by a build that synced other collections or kv keys may be past rows it skipped
    // and this build reads: pull everything once. The first cursor written saves this build's signature.
    let schemaSaved = savedSchema?.value === SYNC_SCHEMA;
    // A damaged cursor means one full pull (re-applying rows is harmless); the first page replaces it.
    let cursor = schemaSaved && typeof saved?.value === 'string' && SERVER_TIME.test(saved.value) ? saved.value : undefined;
    let after: PullCursor | null = cursor ? overlapStart(cursor, overlapMs) : null;
    let pulled = 0;
    let applied = 0;
    for (;;) {
      await check();
      const page = await remote.pull(after, batchSize);
      pulled += page.length;
      if (page.length === 0) break;
      let next = cursor;
      for (const row of page) if (next === undefined || row.server_updated_at > next) next = row.server_updated_at;
      applied += await db.transaction('rw', syncedTables(), async () => {
        await check();
        const sampleQuarters = await loadSampleQuarterIds(db);
        // Read here, not kept from the start of the run: another tab joining at the same time saves it too.
        const joinedUpTo = mode.kind === 'join' ? await savedCursor() : undefined;
        let written = 0;
        for (const row of page) if (await applyRow(row, mode, sampleQuarters, joinedUpTo)) written++;
        if (next !== cursor) {
          const at = new Date().toISOString();
          if (!schemaSaved) await db.kv.put({ key: schemaKey(accountId), value: SYNC_SCHEMA, updatedAt: at });
          await db.kv.put({ key: cursorKey(accountId), value: next, updatedAt: at });
        }
        return written;
      });
      if (next !== cursor) schemaSaved = true;
      cursor = next;
      if (page.length < batchSize) break;
      const last = page[page.length - 1];
      const prev = after;
      after = { ts: last.server_updated_at, collection: last.collection, id: last.id };
      // A remote that ignores the cursor would page forever.
      if (prev && prev.ts === after.ts && prev.collection === after.collection && prev.id === after.id) {
        throw new Error('Sync paging did not advance.');
      }
    }
    return { pulled, applied };
  }

  /** The saved cursor, if this build saved it. In JOIN mode, rows at or before it were already applied here in this join. */
  async function savedCursor(): Promise<string | undefined> {
    const [saved, savedSchema] = await db.kv.bulkGet([cursorKey(accountId), schemaKey(accountId)]);
    const value = saved?.value;
    return savedSchema?.value === SYNC_SCHEMA && typeof value === 'string' && SERVER_TIME.test(value) ? value : undefined;
  }

  /**
   * Runs inside the page transaction. True when the row was written. `joinedUpTo` (JOIN only): the saved
   * cursor when the page was applied.
   */
  async function applyRow(row: PulledRow, mode: Mode, sampleQuarters: ReadonlySet<string>, joinedUpTo?: string): Promise<boolean> {
    if (!isSyncedCollection(row.collection)) return false;
    const collection = row.collection;
    if (collection === 'kv' && !SYNCED_KV_KEYS.includes(row.id)) return false;
    if (typeof row.data !== 'object' || row.data === null || Array.isArray(row.data)) return false;
    const next: LocalRecord = { ...withoutLocalFields(row.data), [primaryKeyOf(collection)]: row.id, _dirty: 0 };
    if (isLocalOnly(collection, next, sampleQuarters)) return false;
    const table = tableOf(collection);
    const local = await table.get(row.id);
    if (local) {
      if (isLocalOnly(collection, local, sampleQuarters)) return false;
      const remoteMs = Date.parse(row.updated_at);
      const localMs = Date.parse(updatedAtOf(local));
      // JOIN: a record this join already brought here (the row is at or before the saved cursor), then edited
      // here since the join started, is a real edit. An edited leftover from before the join is not.
      const lastWriteWins =
        mode.kind === 'normal' ||
        (local._dirty === 1 && localMs >= mode.since && joinedUpTo !== undefined && row.server_updated_at <= joinedUpTo);
      if (lastWriteWins) {
        if (!(remoteMs > localMs)) return false;
      } else if (isSeedStamp(row.updated_at) && localMs > remoteMs) {
        // JOIN: an untouched (or pre-filled) auto-created record on the server never replaces a real local edit.
        return false;
      }
    }
    await table.put(next);
    if (local) {
      // See PITFALL: overwriting a clean record re-dirties it through the updating hook.
      const stored = await table.get(row.id);
      if (stored && stored._dirty !== 0) await table.update(row.id, { _dirty: 0 });
    }
    return true;
  }

  return {
    syncNow() {
      if (!inflight) {
        const p: Promise<SyncResult> = run().finally(() => {
          if (inflight === p) inflight = null;
        });
        inflight = p;
      }
      return inflight;
    },

    async pendingCount() {
      const sampleQuarters = await loadSampleQuarterIds(db);
      let n = 0;
      for (const collection of SYNCED_COLLECTIONS) {
        n += await tableOf(collection)
          .where('_dirty')
          .equals(1)
          .filter((r) => !isLocalOnly(collection, r, sampleQuarters))
          .count();
      }
      return n;
    },

    async forget() {
      generation++;
      inflight = null;
      await db.kv.bulkDelete(syncStateKeys(accountId));
    },
  };
}

/** True when a record must never be pushed (and must never be overwritten by a pull). Implemented in ./localOnly. */
export { isLocalOnly, loadSampleQuarterIds };

/** The server row for a local record. */
export function toRemoteRow(collection: Collection, record: Record<string, unknown>): RemoteRow {
  return {
    collection,
    id: String(record[primaryKeyOf(collection)]),
    // Postgres jsonb refuses NUL characters and lone surrogates (an emoji cut in half by .slice()).
    data: cleanValue(withoutLocalFields(record)) as LocalRecord,
    updated_at: updatedAtOf(record),
    deleted: !!record.deleted,
  };
}

/** Push requests are also capped by size, so a few long coach replies cannot make one request too large. */
const MAX_BATCH_CHARS = 512 * 1024;

/** Split the push queue into batches of at most `size` records and about MAX_BATCH_CHARS of JSON. */
function batches(queue: QueueItem[], size: number): QueueItem[][] {
  const out: QueueItem[][] = [];
  let cur: QueueItem[] = [];
  let chars = 0;
  for (const item of queue) {
    const n = JSON.stringify(item.record).length;
    if (cur.length && (cur.length >= size || chars + n > MAX_BATCH_CHARS)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(item);
    chars += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** A string Postgres jsonb can store: no NUL, and every surrogate paired (a lone one becomes U+FFFD). */
export function cleanString(s: string): string {
  if (!/[\u0000\uD800-\uDFFF]/.test(s)) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) continue;
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) {
        out += s[i] + s[i + 1];
        i++;
      } else out += '�';
    } else if (c >= 0xdc00 && c <= 0xdfff) out += '�';
    else out += s[i];
  }
  return out;
}

function cleanValue(v: unknown): unknown {
  if (typeof v === 'string') return cleanString(v);
  if (Array.isArray(v)) return v.map(cleanValue);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out: LocalRecord = {};
    for (const [k, x] of Object.entries(v)) out[cleanString(k)] = cleanValue(x);
    return out;
  }
  return v;
}

/** push_records accepts at most this many rows, and pull_records never returns more. */
const MAX_BATCH = 1000;
/** PulledRow.server_updated_at: YYYY-MM-DDTHH:MM:SS.ffffffZ. */
const SERVER_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
/** An ISO 8601 stamp with a zone, which Date.parse and Postgres read the same way (same rule as backups). */
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

function overlapStart(cursor: string, overlapMs: number): PullCursor | null {
  const ms = Date.parse(cursor.slice(0, 23) + 'Z');
  // A corrupt cursor falls back to a full pull (re-applying rows is harmless).
  if (Number.isNaN(ms)) return null;
  return { ts: new Date(ms - overlapMs).toISOString(), collection: '', id: '' };
}

const isSyncedCollection = (c: string): c is Collection => (SYNCED_COLLECTIONS as readonly string[]).includes(c);

/** Years 1 to 9999: what both toISOString's plain format and Postgres accept. */
const MIN_MS = Date.parse('0001-01-01T00:00:00.000Z');
const MAX_MS = Date.parse('9999-12-31T23:59:59.999Z');

/** The record's updatedAt as the server will see it: toISOString format, or SEED_UPDATED_AT when unreadable or out of range. */
function updatedAtOf(record: LocalRecord): string {
  const t = record.updatedAt;
  const ms = typeof t === 'string' && ISO_STAMP.test(t) ? Date.parse(t) : NaN;
  return Number.isNaN(ms) || ms < MIN_MS || ms > MAX_MS ? SEED_UPDATED_AT : new Date(ms).toISOString();
}

function withoutLocalFields(record: LocalRecord): LocalRecord {
  const data = { ...record };
  for (const f of LOCAL_ONLY_FIELDS) delete data[f];
  return data;
}

/** Same record, ignoring local-only fields. Missing and undefined properties count as equal. */
function sameRecord(a: LocalRecord, b: LocalRecord): boolean {
  return sameValue(withoutLocalFields(a), withoutLocalFields(b));
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const kx = Object.keys(x).filter((k) => x[k] !== undefined);
  const ky = Object.keys(y).filter((k) => y[k] !== undefined);
  return kx.length === ky.length && kx.every((k) => Object.hasOwn(y, k) && sameValue(x[k], y[k]));
}
