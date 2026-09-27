// In-memory RemoteStore with the same semantics as the Supabase SQL (public.records, push_records,
// pull_records): one row map per account, last-write-wins on updated_at, one server change time per push
// (like a Postgres transaction's now()), and keyset pulls in (server_updated_at, collection, id) order with
// bytewise text comparison. Tests run two devices against one account through it, with a controllable
// server clock, failure injection, late commits (for the pull overlap window), and raw seeding.
import type { PullCursor, PulledRow, RemoteRow, RemoteStore } from './types';

export interface MemoryRemoteOptions {
  /** The account this handle acts as (auth.uid() on the server). Default 'user-1'. */
  userId?: string;
  /** Server clock start (any ISO string). Default 2026-07-01T12:00:00.000Z. */
  startAt?: string;
  /** Microseconds the server clock moves before each commit. Default 1234 (so the 6 digits matter). */
  stepMicros?: number;
}

export interface FailOptions {
  /** Let this many calls succeed first. Default 0 (the very next call fails). */
  skip?: number;
  /** Push only: apply the rows on the server, then throw (the response was lost on the way back). */
  afterApply?: boolean;
  error?: Error;
}

/** A raw row for seed(): any collection string, no last-write-wins. */
export interface SeedRow {
  collection: string;
  id: string;
  data: Record<string, unknown>;
  updated_at: string;
  deleted?: boolean;
  /** Defaults to a fresh commit time. */
  server_updated_at?: string;
}

export interface MemoryRemote extends RemoteStore {
  readonly userId: string;
  /** A handle for another account on the same server (shared rows and clock, separate failure state). */
  forUser(userId: string): MemoryRemote;
  /** The server clock, formatted like server_updated_at. */
  now(): string;
  /** Move the server clock forward. */
  advance(ms: number): void;
  failNextPush(options?: FailOptions): void;
  failNextPull(options?: FailOptions): void;
  /** Awaited at the start of every push (for example to edit a record while the push is in flight). */
  beforePush?: (rows: RemoteRow[]) => void | Promise<void>;
  /** Awaited at the start of every pull. */
  beforePull?: (after: PullCursor | null, limit: number) => void | Promise<void>;
  /**
   * Apply rows (last-write-wins) as a transaction that took its now() `behindMs` ago and commits only now,
   * so its server_updated_at is older than rows other devices may already have pulled. Returns rows applied.
   */
  pushLate(rows: RemoteRow[], behindMs: number): number;
  /** Store rows exactly as given (no last-write-wins, any collection). Rows without server_updated_at share one fresh commit time. */
  seed(rows: SeedRow[]): void;
  /** This account's rows in pull order. */
  rows(): PulledRow[];
  row(collection: string, id: string): PulledRow | undefined;
  /** Every call this handle received, including failed ones. */
  readonly calls: { push: RemoteRow[][]; pull: { after: PullCursor | null; limit: number }[] };
  /** Rows applied by the last push that reached the server (push_records' return value). */
  lastApplied: number;
}

interface StoredRow {
  collection: string;
  id: string;
  data: Record<string, unknown>;
  /** toISOString format, like the SQL's to_char output. */
  updated_at: string;
  deleted: boolean;
  /** Microseconds since the epoch. */
  serverMicros: number;
}

interface ServerState {
  accounts: Map<string, Map<string, StoredRow>>;
  clockMicros: number;
  stepMicros: number;
}

const DEFAULT_START = '2026-07-01T12:00:00.000Z';

export function createMemoryRemote(options: MemoryRemoteOptions = {}): MemoryRemote {
  const startMs = Date.parse(options.startAt ?? DEFAULT_START);
  if (Number.isNaN(startMs)) throw new Error('startAt is not a valid date');
  const server: ServerState = { accounts: new Map(), clockMicros: startMs * 1000, stepMicros: Math.max(1, Math.round(options.stepMicros ?? 1234)) };
  return handle(server, options.userId ?? 'user-1');
}

function handle(server: ServerState, userId: string): MemoryRemote {
  let pushFail: Required<Pick<FailOptions, 'skip'>> & FailOptions | null = null;
  let pullFail: Required<Pick<FailOptions, 'skip'>> & FailOptions | null = null;

  const account = () => {
    let rows = server.accounts.get(userId);
    if (!rows) server.accounts.set(userId, (rows = new Map()));
    return rows;
  };
  const commitTime = () => (server.clockMicros += server.stepMicros);
  const sorted = () => [...account().values()].sort(compareRows);

  /** Returns the failure to throw now (if any) and consumes it. */
  const takeFailure = (which: 'push' | 'pull') => {
    const f = which === 'push' ? pushFail : pullFail;
    if (!f) return null;
    if (f.skip > 0) {
      f.skip--;
      return null;
    }
    if (which === 'push') pushFail = null;
    else pullFail = null;
    return f;
  };

  const remote: MemoryRemote = {
    userId,
    calls: { push: [], pull: [] },
    lastApplied: 0,

    async push(rows) {
      remote.calls.push.push(clone(rows));
      await remote.beforePush?.(rows);
      const failure = takeFailure('push');
      if (failure && !failure.afterApply) throw failure.error ?? new Error('Network request failed');
      remote.lastApplied = apply(account(), rows, commitTime());
      if (failure) throw failure.error ?? new Error('Network request failed');
    },

    async pull(after, limit) {
      remote.calls.pull.push({ after: after && { ...after }, limit });
      await remote.beforePull?.(after, limit);
      const failure = takeFailure('pull');
      if (failure) throw failure.error ?? new Error('Network request failed');
      // least(greatest(coalesce(p_limit, 200), 1), 1000)
      const lim = Number.isFinite(limit) ? Math.min(1000, Math.max(1, Math.trunc(limit))) : 200;
      const from = after && { micros: parseServerTime(after.ts), collection: after.collection, id: after.id };
      return sorted()
        .filter((r) => !from || compareKeys(r.serverMicros, r.collection, r.id, from.micros, from.collection, from.id) > 0)
        .slice(0, lim)
        .map(toPulled);
    },

    forUser: (other) => handle(server, other),
    now: () => formatServerTime(server.clockMicros),
    advance(ms) {
      server.clockMicros += Math.round(ms * 1000);
    },
    failNextPush(opts = {}) {
      pushFail = { ...opts, skip: opts.skip ?? 0 };
    },
    failNextPull(opts = {}) {
      pullFail = { ...opts, skip: opts.skip ?? 0 };
    },
    pushLate(rows, behindMs) {
      return apply(account(), rows, server.clockMicros - Math.round(behindMs * 1000));
    },
    seed(rows) {
      let fresh: number | undefined;
      for (const r of rows) {
        const micros = r.server_updated_at ? parseServerTime(r.server_updated_at) : (fresh ??= commitTime());
        account().set(rowKey(r.collection, r.id), {
          collection: r.collection,
          id: r.id,
          data: jsonb(r.data),
          updated_at: toIso(r.updated_at),
          deleted: !!r.deleted,
          serverMicros: micros,
        });
      }
    },
    rows: () => sorted().map(toPulled),
    row(collection, id) {
      const r = account().get(rowKey(collection, id));
      return r && toPulled(r);
    },
  };
  return remote;
}

/** push_records: dedupe to the newest per (collection, id), then apply only strictly newer rows. One statement. */
function apply(rows: Map<string, StoredRow>, input: RemoteRow[], serverMicros: number): number {
  // Validate everything first so a bad row applies nothing (the SQL call is all or nothing).
  if (input.length > 1000) throw new Error('push_records: at most 1000 rows per call');
  const newest = new Map<string, RemoteRow>();
  for (const r of input) {
    if (typeof r.collection !== 'string' || typeof r.id !== 'string') throw new Error('Row is missing collection or id');
    // records_collection_check / records_id_check: char_length between 1 and 200 (characters, not UTF-16 units).
    for (const s of [r.collection, r.id]) {
      const n = [...s].length;
      if (n < 1 || n > 200) throw new Error(`Collection and id must be 1 to 200 characters: ${s.slice(0, 20)}`);
    }
    if (typeof r.data !== 'object' || r.data === null || Array.isArray(r.data)) throw new Error('Row data must be an object');
    if (Number.isNaN(Date.parse(r.updated_at))) throw new Error(`Invalid updated_at: ${r.updated_at}`);
    const k = rowKey(r.collection, r.id);
    const seen = newest.get(k);
    // Ties keep the later row in the call.
    if (!seen || Date.parse(r.updated_at) >= Date.parse(seen.updated_at)) newest.set(k, r);
  }
  let applied = 0;
  for (const [k, r] of newest) {
    const stored = rows.get(k);
    if (stored && !(Date.parse(r.updated_at) > Date.parse(stored.updated_at))) continue;
    rows.set(k, {
      collection: r.collection,
      id: r.id,
      data: jsonb(r.data),
      updated_at: toIso(r.updated_at),
      deleted: !!r.deleted,
      serverMicros,
    });
    applied++;
  }
  return applied;
}

const rowKey = (collection: string, id: string) => JSON.stringify([collection, id]);

const toPulled = (r: StoredRow): PulledRow => ({
  collection: r.collection,
  id: r.id,
  data: jsonb(r.data),
  updated_at: r.updated_at,
  deleted: r.deleted,
  server_updated_at: formatServerTime(r.serverMicros),
});

const compareRows = (a: StoredRow, b: StoredRow) => compareKeys(a.serverMicros, a.collection, a.id, b.serverMicros, b.collection, b.id);

function compareKeys(ta: number, ca: string, ia: string, tb: number, cb: string, ib: string): number {
  return ta - tb || compareBytes(ca, cb) || compareBytes(ia, ib);
}

const encoder = new TextEncoder();

/** collate "C": compare the UTF-8 bytes. */
export function compareBytes(a: string, b: string): number {
  if (a === b) return 0;
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/** `YYYY-MM-DDTHH:MM:SS.ffffffZ`, UTC, exactly 6 fractional digits (the SQL's server_updated_at format). */
export function formatServerTime(micros: number): string {
  const secs = Math.floor(micros / 1e6);
  const frac = micros - secs * 1e6;
  return `${new Date(secs * 1000).toISOString().slice(0, 19)}.${String(frac).padStart(6, '0')}Z`;
}

/** Parse a timestamptz the way Postgres would, keeping microseconds. Accepts toISOString and 6-digit forms. */
export function parseServerTime(ts: string): number {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(ts);
  if (!m) throw new Error(`Invalid timestamp: ${ts}`);
  return Date.parse(`${m[1]}Z`) * 1000 + Number((m[2] ?? '').padEnd(6, '0'));
}

/** updated_at comes back formatted like toISOString. */
const toIso = (ts: string) => new Date(Date.parse(ts)).toISOString();

/** Round-trip through JSON like a jsonb column (drops undefined, copies deeply). */
const jsonb = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const clone = jsonb;
