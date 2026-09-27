// The Supabase side of sync: a RemoteStore over the push_records / pull_records RPCs
// (supabase/migrations), plus one error type the scheduler and UI understand.
import type { PullCursor, PulledRow, RemoteRow, RemoteStore } from './types';

export type SyncErrorKind = 'offline' | 'auth' | 'paused' | 'server';

export const OFFLINE_MESSAGE = "You're offline. Changes sync when you're back online.";
export const AUTH_MESSAGE = 'Your sign-in needs a refresh. Sign in again if this keeps happening.';
export const PAUSED_MESSAGE = "Can't reach the sync server. If this keeps happening, the Supabase project may be paused.";
export const SERVER_MESSAGE = 'Sync hit a problem on the server. It will try again soon.';
export const GENERIC_MESSAGE = 'Sync hit a problem. It will try again soon.';
/** The project has no push_records / pull_records (or no records table): retrying alone never fixes it. */
export const SETUP_MESSAGE = "Sync isn't set up on the server yet. Run the SQL migration in Supabase.";

const MESSAGES: Record<SyncErrorKind, string> = {
  offline: OFFLINE_MESSAGE,
  auth: AUTH_MESSAGE,
  paused: PAUSED_MESSAGE,
  server: SERVER_MESSAGE,
};

/** A failed sync call, classified. `message` is short, plain language, safe to show. */
export class SyncError extends Error {
  readonly kind: SyncErrorKind;
  /** HTTP status when there was a response (0 when the request never got one). */
  readonly status?: number;
  /** The raw error, for debugging. */
  readonly detail?: unknown;
  /** The server refused the content of the rows sent (a bad value, or a request too large), not the request itself. */
  readonly rejected: boolean;
  constructor(kind: SyncErrorKind, opts: { message?: string; status?: number; detail?: unknown; rejected?: boolean } = {}) {
    super(opts.message ?? MESSAGES[kind]);
    this.name = 'SyncError';
    this.kind = kind;
    this.status = opts.status;
    this.detail = opts.detail;
    this.rejected = opts.rejected ?? false;
  }
}

export function isSyncError(e: unknown): e is SyncError {
  return e instanceof SyncError;
}

/** navigator.onLine, treating "unknown" (no navigator) as online. */
export function browserOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/** The error part of a PostgREST response. */
export interface RpcError {
  message?: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}

export interface RpcResponse {
  data: unknown;
  error: RpcError | null;
  status?: number;
}

/** The slice of SupabaseClient this module needs (a fake in tests). */
export interface RpcClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<RpcResponse>;
}

// Postgres/PostgREST codes that mean the request had no valid signed-in user.
const AUTH_CODES = new Set(['PGRST301', 'PGRST302', 'PGRST303', '42501']);
// Function or table missing (the migration was never run on this project).
const SETUP_CODES = new Set(['PGRST202', '42883', '42P01']);
// Data exceptions (22xxx), constraint violations (23xxx) and an unreadable JSON body: the rows themselves were refused.
const REJECTED_CODE = /^(22|23)|^PGRST102$/;
// Node-style causes (surfaced in `details`) that mean the host refused or does not resolve while online.
const UNREACHABLE = /\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b/;
// What fetch's network TypeError says in Chrome, Safari (including its NSURLError texts), Firefox and Node.
// Any other TypeError is a bug, and must not hide behind "offline".
const NETWORK_FAILURE =
  /failed to fetch|fetch failed|load failed|networkerror|network request failed|network connection was lost|internet connection appears to be offline|could not connect to the server|hostname could not be found|timed out/i;

/** Classify a failed RPC response. */
export function classifyRpcFailure(res: { error: RpcError | null; status?: number }, online = browserOnline()): SyncError {
  const status = res.status ?? 0;
  const err = res.error ?? {};
  const text = `${err.message ?? ''} ${err.details ?? ''}`;
  const detail = res.error;
  if (!online) return new SyncError('offline', { status, detail });
  if (status === 0) {
    // No response at all: a network failure (or a refused connection, which only Node can tell apart).
    return UNREACHABLE.test(text) ? new SyncError('paused', { status, detail }) : new SyncError('offline', { status, detail });
  }
  if (status === 401 || (err.code && AUTH_CODES.has(err.code) && status !== 403) || /\bJWT\b/i.test(err.message ?? '')) {
    return new SyncError('auth', { status, detail });
  }
  // 5xx: gateway or database down, including Supabase's 540 "project paused".
  if (status >= 500) return new SyncError('paused', { status, detail });
  if (err.code && SETUP_CODES.has(err.code)) return new SyncError('server', { status, detail, message: SETUP_MESSAGE });
  const rejected = status === 413 || (status >= 400 && !!err.code && REJECTED_CODE.test(err.code));
  return new SyncError('server', { status, detail, rejected });
}

/** Classify anything thrown (fetch TypeErrors, aborted requests, unexpected bugs). */
export function toSyncError(e: unknown, online = browserOnline()): SyncError {
  if (e instanceof SyncError) return e;
  if (!online) return new SyncError('offline', { detail: e });
  const name = (e as { name?: unknown } | null)?.name;
  const message = String((e as { message?: unknown } | null)?.message ?? '');
  if (name === 'AbortError' || name === 'TimeoutError' || NETWORK_FAILURE.test(message)) {
    return new SyncError('offline', { detail: e });
  }
  // Not from the server at all (a local database error, a bug): keep the message general.
  return new SyncError('server', { message: GENERIC_MESSAGE, detail: e });
}

function toPulledRows(data: unknown): PulledRow[] {
  if (!Array.isArray(data)) throw new SyncError('server', { message: 'Sync got an unexpected reply from the server. It will try again soon.', detail: data });
  const rows: PulledRow[] = [];
  for (const r of data as Record<string, unknown>[]) {
    if (!r || typeof r.collection !== 'string' || typeof r.id !== 'string' || typeof r.updated_at !== 'string' || typeof r.server_updated_at !== 'string') {
      throw new SyncError('server', { message: 'Sync got an unexpected reply from the server. It will try again soon.', detail: r });
    }
    rows.push({
      collection: r.collection,
      id: r.id,
      // Passed through as is: the engine skips a row whose body is not an object. Turning it into {} would
      // overwrite the local record with an empty one, and dropping it would cut the page (and paging) short.
      data: r.data as Record<string, unknown>,
      updated_at: r.updated_at,
      deleted: r.deleted === true,
      server_updated_at: r.server_updated_at,
    });
  }
  return rows;
}

async function call(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  let res: RpcResponse;
  try {
    res = await client.rpc(fn, args);
  } catch (e) {
    throw toSyncError(e);
  }
  if (res.error) throw classifyRpcFailure(res);
  return res.data;
}

/** RemoteStore over Supabase. Throws SyncError on any failure. */
export function createSupabaseRemote(client: RpcClient): RemoteStore {
  return {
    async push(rows: RemoteRow[]): Promise<void> {
      if (!rows.length) return;
      const p_rows = rows.map((r) => ({ collection: r.collection, id: r.id, data: r.data, updated_at: r.updated_at, deleted: r.deleted }));
      await call(client, 'push_records', { p_rows });
    },
    async pull(after: PullCursor | null, limit: number): Promise<PulledRow[]> {
      const data = await call(client, 'pull_records', {
        p_after_ts: after ? after.ts : null,
        p_after_collection: after?.collection ?? '',
        p_after_id: after?.id ?? '',
        p_limit: limit,
      });
      return toPulledRows(data);
    },
  };
}
