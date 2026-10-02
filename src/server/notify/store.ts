// What the notify function reads and writes, behind one interface: the Supabase implementation talks to
// PostgREST with the service role key (plain fetch, no dependencies), and tests use an in-memory double.
import type { LocalDate, NotifyData, NotifyState } from '@/domain';

export interface SubscriptionRow {
  endpoint: string;
  user_id: string;
  p256dh: string;
  auth: string;
  device: string;
  time_zone: string;
  last_seen_at: string;
}

export type ClaimField = 'daily_date' | 'weekly_week' | 'nudge_date';

export interface DataRequest {
  quarterId: string;
  /** Logs, energy and actions from this date on (enough for streaks and pace). */
  since: LocalDate;
  /** Also load this review (the weekly reminder skips a finished one). */
  reviewWeek?: LocalDate;
}

export interface NotifyStore {
  /** True when the secret is the one the pg_cron schedule sends. */
  cronSecretOk(secret: string): Promise<boolean>;
  /** The signed-in user behind an access token, or null. */
  userFromToken(token: string): Promise<string | null>;
  /** Every live (not gone) subscription, all accounts. */
  subscriptions(): Promise<SubscriptionRow[]>;
  state(userId: string): Promise<NotifyState>;
  /**
   * Atomically mark `field` = value unless it already is. True if this call made the change: only that
   * caller sends, so two overlapping runs never send the same reminder twice.
   */
  claim(userId: string, field: ClaimField, value: LocalDate): Promise<boolean>;
  saveNudged(userId: string, nudged: Record<string, LocalDate>): Promise<void>;
  /** The synced settings value (kv 'settings'), or undefined. */
  settings(userId: string): Promise<unknown>;
  data(userId: string, req: DataRequest): Promise<NotifyData>;
  markSent(endpoint: string, at: string): Promise<void>;
  markError(endpoint: string, reason: string, at: string): Promise<void>;
  markGone(endpoint: string, at: string): Promise<void>;
  /** Delete subscriptions that have been gone since before `before`. */
  pruneGone(before: string): Promise<void>;
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

/** The Supabase implementation. `key` is the service role key (legacy JWT) or a secret key (sb_secret_...). */
export function restStore(supabaseUrl: string, key: string, fetchFn: typeof fetch): NotifyStore {
  const base = supabaseUrl.replace(/\/+$/, '');
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    apikey: key,
    // Secret keys (sb_secret_...) are not JWTs; the gateway accepts them in apikey alone.
    ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}),
    ...extra,
  });

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetchFn(`${base}${path}`, { ...init, headers: { ...headers(), ...(init.headers as Record<string, string>) } });
    if (!res.ok) throw new RestError(res.status, `${init.method ?? 'GET'} ${path.split('?')[0]}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    return res;
  }
  const json = async <T>(path: string, init?: RequestInit) => (await (await call(path, init)).json()) as T;
  const q = (params: Record<string, string>) => new URLSearchParams(params).toString();
  const patch = (table: string, filter: Record<string, string>, body: unknown) =>
    call(`/rest/v1/${table}?${q(filter)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(body) });

  /** Every live record of one collection for a user matching the filters, paged. */
  async function records<T>(userId: string, collection: string, filters: Record<string, string> = {}): Promise<T[]> {
    const out: T[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await json<{ data: T }[]>(
        `/rest/v1/records?${q({
          select: 'data',
          user_id: `eq.${userId}`,
          collection: `eq.${collection}`,
          deleted: 'is.false',
          ...filters,
          order: 'id',
          limit: String(PAGE),
          offset: String(offset),
        })}`,
      );
      out.push(...page.map((r) => r.data));
      if (page.length < PAGE) return out;
    }
  }

  return {
    async cronSecretOk(secret) {
      const ok = await json<unknown>('/rest/v1/rpc/notify_cron_ok', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_secret: secret }),
      });
      return ok === true;
    },

    async userFromToken(token) {
      const res = await fetchFn(`${base}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
      if (!res.ok) return null;
      const user = (await res.json().catch(() => null)) as { id?: unknown } | null;
      return typeof user?.id === 'string' ? user.id : null;
    },

    subscriptions: () =>
      json<SubscriptionRow[]>(
        `/rest/v1/push_subscriptions?${q({ select: 'endpoint,user_id,p256dh,auth,device,time_zone,last_seen_at', gone_at: 'is.null', order: 'user_id,last_seen_at.desc' })}`,
      ),

    async state(userId) {
      const rows = await json<{ daily_date: string | null; weekly_week: string | null; nudge_date: string | null; nudged: Record<string, string> | null }[]>(
        `/rest/v1/push_state?${q({ select: 'daily_date,weekly_week,nudge_date,nudged', user_id: `eq.${userId}` })}`,
      );
      const r = rows[0];
      return r
        ? { dailyDate: r.daily_date ?? undefined, weeklyWeek: r.weekly_week ?? undefined, nudgeDate: r.nudge_date ?? undefined, nudged: r.nudged ?? {} }
        : {};
    },

    async claim(userId, field, value) {
      // Make sure the row exists (no-op when it does), then a conditional update decides who claims it.
      await call('/rest/v1/push_state?on_conflict=user_id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify({ user_id: userId }),
      });
      const rows = await json<unknown[]>(`/rest/v1/push_state?${q({ user_id: `eq.${userId}`, or: `(${field}.is.null,${field}.neq.${value})` })}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({ [field]: value, updated_at: new Date().toISOString() }),
      });
      return rows.length === 1;
    },

    async saveNudged(userId, nudged) {
      await patch('push_state', { user_id: `eq.${userId}` }, { nudged, updated_at: new Date().toISOString() });
    },

    async settings(userId) {
      const rows = await json<{ data: { value?: unknown } }[]>(
        `/rest/v1/records?${q({ select: 'data', user_id: `eq.${userId}`, collection: 'eq.kv', id: 'eq.settings', deleted: 'is.false' })}`,
      );
      return rows[0]?.data?.value;
    },

    async data(userId, req) {
      const since = { 'data->>localDate': `gte.${req.since}` };
      const [quarters, goals, logs, energy, people, touchpoints, crunch, actions, reviews] = await Promise.all([
        records<NotifyData['quarter']>(userId, 'quarters', { id: `eq.${req.quarterId}` }),
        records<NotifyData['goals'][number]>(userId, 'goals', { 'data->>quarterId': `eq.${req.quarterId}` }),
        records<NotifyData['logs'][number]>(userId, 'logs', since),
        records<NotifyData['energy'][number]>(userId, 'energy', since),
        records<NotifyData['people'][number]>(userId, 'people'),
        records<NotifyData['touchpoints'][number]>(userId, 'touchpoints'),
        records<NotifyData['crunch'][number]>(userId, 'crunch'),
        records<NotifyData['actions'][number]>(userId, 'actions', { 'data->>weekStart': `gte.${req.since}` }),
        req.reviewWeek ? records<NotifyData['reviews'][number]>(userId, 'reviews', { id: `eq.review-${req.reviewWeek}` }) : Promise.resolve([]),
      ]);
      return { quarter: quarters[0], goals, logs, energy, people, touchpoints, crunch, actions, reviews };
    },

    async markSent(endpoint, at) {
      await patch('push_subscriptions', { endpoint: `eq.${endpoint}` }, { last_sent_at: at, last_error: null, last_error_at: null });
    },
    async markError(endpoint, reason, at) {
      await patch('push_subscriptions', { endpoint: `eq.${endpoint}` }, { last_error: reason.slice(0, 300), last_error_at: at });
    },
    async markGone(endpoint, at) {
      await patch('push_subscriptions', { endpoint: `eq.${endpoint}` }, { gone_at: at });
    },
    async pruneGone(before) {
      await call(`/rest/v1/push_subscriptions?${q({ gone_at: `lt.${before}` })}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    },
  };
}
