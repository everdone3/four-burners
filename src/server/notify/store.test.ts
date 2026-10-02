// Pins the PostgREST requests the notify function makes: paths, filters, headers. The SQL behind them is
// proven in src/sync/pushSql.test.ts.
import { describe, expect, it } from 'vitest';
import { RestError, restStore } from './store';

interface Seen {
  method: string;
  path: string;
  params: Record<string, string>;
  headers: Record<string, string>;
  body?: unknown;
}

function fake(respond: (s: Seen) => unknown = () => []) {
  const seen: Seen[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const s: Seen = {
      method: init.method ?? 'GET',
      path: u.pathname,
      params: Object.fromEntries(u.searchParams),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    seen.push(s);
    const out = respond(s);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200 });
  }) as unknown as typeof fetch;
  return { seen, fetchFn };
}

describe('restStore', () => {
  it('authenticates with a legacy service role JWT, or a secret key in apikey alone', async () => {
    const a = fake();
    await restStore('https://p.supabase.co/', 'eyJlegacy', a.fetchFn).subscriptions();
    expect(a.seen[0].headers).toMatchObject({ apikey: 'eyJlegacy', Authorization: 'Bearer eyJlegacy' });
    const b = fake();
    await restStore('https://p.supabase.co', 'sb_secret_x', b.fetchFn).subscriptions();
    expect(b.seen[0].headers.apikey).toBe('sb_secret_x');
    expect(b.seen[0].headers.Authorization).toBeUndefined();
    expect(b.seen[0].path).toBe('/rest/v1/push_subscriptions');
    expect(b.seen[0].params.gone_at).toBe('is.null');
  });

  it('checks the schedule secret through the notify_cron_ok RPC', async () => {
    const f = fake((s) => s.body && (s.body as { p_secret: string }).p_secret === 'right');
    const store = restStore('https://p.supabase.co', 'k', f.fetchFn);
    expect(await store.cronSecretOk('right')).toBe(true);
    expect(await store.cronSecretOk('wrong')).toBe(false);
    expect(f.seen[0]).toMatchObject({ method: 'POST', path: '/rest/v1/rpc/notify_cron_ok' });
  });

  it('claims with an insert-if-missing and a conditional update', async () => {
    const f = fake((s) => (s.method === 'PATCH' ? [{ user_id: 'u' }] : null));
    const ok = await restStore('https://p.supabase.co', 'k', f.fetchFn).claim('u', 'daily_date', '2026-10-02');
    expect(ok).toBe(true);
    expect(f.seen[0]).toMatchObject({ method: 'POST', path: '/rest/v1/push_state', params: { on_conflict: 'user_id' }, body: { user_id: 'u' } });
    expect(f.seen[0].headers.Prefer).toMatch(/ignore-duplicates/);
    expect(f.seen[1]).toMatchObject({
      method: 'PATCH',
      params: { user_id: 'eq.u', or: '(daily_date.is.null,daily_date.neq.2026-10-02)' },
      body: { daily_date: '2026-10-02' },
    });
    const lost = fake((s) => (s.method === 'PATCH' ? [] : null));
    expect(await restStore('https://p.supabase.co', 'k', lost.fetchFn).claim('u', 'nudge_date', '2026-10-02')).toBe(false);
  });

  it('reads settings from the synced kv record', async () => {
    const f = fake(() => [{ data: { key: 'settings', value: { reviewDay: 2 } } }]);
    expect(await restStore('https://p.supabase.co', 'k', f.fetchFn).settings('u')).toEqual({ reviewDay: 2 });
    expect(f.seen[0].params).toMatchObject({ user_id: 'eq.u', collection: 'eq.kv', id: 'eq.settings', deleted: 'is.false' });
  });

  it('loads only live records, filtered by date, paging past 1000 rows', async () => {
    const big = Array.from({ length: 1000 }, (_, i) => ({ data: { id: `l${i}` } }));
    const f = fake((s) => {
      if (s.params.collection === 'eq.logs') return s.params.offset === '0' ? big : [{ data: { id: 'last' } }];
      if (s.params.collection === 'eq.quarters') return [{ data: { id: '2026-Q4' } }];
      return [];
    });
    const d = await restStore('https://p.supabase.co', 'k', f.fetchFn).data('u', { quarterId: '2026-Q4', since: '2025-08-28', reviewWeek: '2026-09-28' });
    expect(d.logs).toHaveLength(1001);
    expect(d.quarter).toEqual({ id: '2026-Q4' });
    const by = (c: string) => f.seen.filter((s) => s.params.collection === `eq.${c}`).map((s) => s.params);
    for (const c of ['quarters', 'goals', 'logs', 'energy', 'people', 'touchpoints', 'crunch', 'actions', 'reviews']) {
      expect(by(c)[0]).toMatchObject({ user_id: 'eq.u', deleted: 'is.false', order: 'id' });
    }
    expect(by('logs')[0]['data->>localDate']).toBe('gte.2025-08-28');
    expect(by('energy')[0]['data->>localDate']).toBe('gte.2025-08-28');
    expect(by('goals')[0]['data->>quarterId']).toBe('eq.2026-Q4');
    expect(by('actions')[0]['data->>weekStart']).toBe('gte.2025-08-28');
    expect(by('reviews')[0].id).toBe('eq.review-2026-09-28');
    expect(by('logs').map((p) => p.offset)).toEqual(['0', '1000']);
  });

  it('turns HTTP failures into errors (with the status, not the key)', async () => {
    const f = fake(() => new Response('denied', { status: 401 }));
    const err = await restStore('https://p.supabase.co', 'sb_secret_x', f.fetchFn).subscriptions().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestError);
    expect((err as RestError).status).toBe(401);
    expect(String(err)).not.toMatch(/sb_secret_x/);
  });

  it('a token the auth server rejects is no user', async () => {
    const f = fake((s) => (s.path === '/auth/v1/user' && s.headers.Authorization === 'Bearer good' ? { id: 'u' } : new Response('', { status: 401 })));
    const store = restStore('https://p.supabase.co', 'k', f.fetchFn);
    expect(await store.userFromToken('good')).toBe('u');
    expect(await store.userFromToken('bad')).toBeNull();
  });
});
