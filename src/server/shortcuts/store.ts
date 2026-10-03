// What the shortcuts function reads and writes, behind one interface: PostgREST with the service role key in
// production (plain fetch), an in-memory double in tests.
import type { Goal, LogEntry, Person, Quarter } from '@/domain';

export interface StoredRecord {
  data: Record<string, unknown>;
  deleted: boolean;
  updated_at: string;
}

export interface ShortcutsStore {
  /** The token row for a hash, or null when there is none (wrong or revoked). */
  tokenByHash(hash: string): Promise<{ id: string; userId: string } | null>;
  markTokenUsed(id: string, at: string): Promise<void>;
  /** The synced settings value (kv 'settings'), or undefined. */
  settings(userId: string): Promise<unknown>;
  /** IANA time zone of the device most recently seen by notifications, if any. */
  latestTimeZone(userId: string): Promise<string | null>;
  quarter(userId: string, quarterId: string): Promise<Quarter | undefined>;
  goals(userId: string, quarterId: string): Promise<Goal[]>;
  people(userId: string): Promise<Person[]>;
  logsForGoal(userId: string, goalId: string): Promise<LogEntry[]>;
  /** One record, live or deleted, or null. */
  get(userId: string, collection: 'logs' | 'touchpoints', id: string): Promise<StoredRecord | null>;
  /**
   * Write one record as a sync row (devices pull it on their next sync), with the same newer-wins rule as
   * sync: it only lands if newer than the stored copy, and never brings a deleted record back. True if written.
   */
  put(userId: string, collection: 'logs' | 'touchpoints', record: { id: string; updatedAt: string } & Record<string, unknown>): Promise<boolean>;
}

export class RestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const PAGE = 1000;

export function restShortcutsStore(supabaseUrl: string, key: string, fetchFn: typeof fetch): ShortcutsStore {
  const base = supabaseUrl.replace(/\/+$/, '');
  const auth: Record<string, string> = { apikey: key, ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}) };
  const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetchFn(`${base}${path}`, { ...init, headers: { ...auth, ...(init.headers as Record<string, string>) } });
    if (!res.ok) throw new RestError(res.status, `${init.method ?? 'GET'} ${path.split('?')[0]}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    return res;
  }
  const json = async <T>(path: string, init?: RequestInit) => (await (await call(path, init)).json()) as T;

  async function records<T>(userId: string, collection: string, filters: Record<string, string> = {}): Promise<T[]> {
    const out: T[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await json<{ data: T }[]>(
        `/rest/v1/records?${q({ select: 'data', user_id: `eq.${userId}`, collection: `eq.${collection}`, deleted: 'is.false', ...filters, order: 'id', limit: String(PAGE), offset: String(offset) })}`,
      );
      out.push(...page.map((r) => r.data));
      if (page.length < PAGE) return out;
    }
  }

  return {
    async tokenByHash(hash) {
      const rows = await json<{ id: string; user_id: string }[]>(`/rest/v1/shortcut_tokens?${q({ select: 'id,user_id', token_hash: `eq.${hash}` })}`);
      return rows[0] ? { id: rows[0].id, userId: rows[0].user_id } : null;
    },
    async markTokenUsed(id, at) {
      await call(`/rest/v1/shortcut_tokens?${q({ id: `eq.${id}` })}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ last_used_at: at }),
      });
    },
    async settings(userId) {
      const rows = await json<{ data: { value?: unknown } }[]>(
        `/rest/v1/records?${q({ select: 'data', user_id: `eq.${userId}`, collection: 'eq.kv', id: 'eq.settings', deleted: 'is.false' })}`,
      );
      return rows[0]?.data?.value;
    },
    async latestTimeZone(userId) {
      // Notifications may not be set up (no table yet, or no device): that only means no fallback zone.
      try {
        const rows = await json<{ time_zone: string }[]>(
          `/rest/v1/push_subscriptions?${q({ select: 'time_zone', user_id: `eq.${userId}`, order: 'last_seen_at.desc', limit: '1' })}`,
        );
        return rows[0]?.time_zone ?? null;
      } catch {
        return null;
      }
    },
    async quarter(userId, quarterId) {
      return (await records<Quarter>(userId, 'quarters', { id: `eq.${quarterId}` }))[0];
    },
    goals: (userId, quarterId) => records<Goal>(userId, 'goals', { 'data->>quarterId': `eq.${quarterId}` }),
    people: (userId) => records<Person>(userId, 'people'),
    logsForGoal: (userId, goalId) => records<LogEntry>(userId, 'logs', { 'data->>goalId': `eq.${goalId}` }),
    async get(userId, collection, id) {
      const rows = await json<StoredRecord[]>(
        `/rest/v1/records?${q({ select: 'data,deleted,updated_at', user_id: `eq.${userId}`, collection: `eq.${collection}`, id: `eq.${id}` })}`,
      );
      return rows[0] ?? null;
    },
    async put(userId, collection, record) {
      const ok = await json<unknown>('/rest/v1/rpc/shortcuts_put_record', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_user: userId, p_collection: collection, p_id: record.id, p_data: record, p_updated_at: record.updatedAt }),
      });
      return ok === true;
    },
  };
}
