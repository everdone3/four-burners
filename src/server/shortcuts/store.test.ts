// Pins the PostgREST requests the shortcuts function makes.
import { describe, expect, it } from 'vitest';
import { restShortcutsStore } from './store';

function fake(respond: (method: string, params: Record<string, string>, path: string) => unknown = () => []) {
  const seen: { method: string; path: string; params: Record<string, string>; headers: Record<string, string>; body?: unknown }[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const s = { method: init.method ?? 'GET', path: u.pathname, params: Object.fromEntries(u.searchParams), headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined };
    seen.push(s);
    const out = respond(s.method, s.params, s.path);
    return out instanceof Response ? out : new Response(JSON.stringify(out ?? null), { status: 200 });
  }) as unknown as typeof fetch;
  return { seen, fetchFn };
}

describe('restShortcutsStore', () => {
  it('writes a record through the newer-wins RPC and reports whether it landed', async () => {
    const f = fake(() => true);
    const s = restShortcutsStore('https://p.supabase.co', 'sb_secret_x', f.fetchFn);
    expect(await s.put('u', 'logs', { id: 'l1', updatedAt: '2026-10-02T00:00:00.000Z', value: 1 })).toBe(true);
    expect(f.seen[0]).toMatchObject({
      method: 'POST',
      path: '/rest/v1/rpc/shortcuts_put_record',
      body: { p_user: 'u', p_collection: 'logs', p_id: 'l1', p_data: { id: 'l1', updatedAt: '2026-10-02T00:00:00.000Z', value: 1 }, p_updated_at: '2026-10-02T00:00:00.000Z' },
    });
    expect(f.seen[0].headers.apikey).toBe('sb_secret_x');
    const no = fake(() => false);
    expect(await restShortcutsStore('https://p.supabase.co', 'k', no.fetchFn).put('u', 'logs', { id: 'l1', updatedAt: 'x' })).toBe(false);
  });

  it('reads goals of a quarter, a goal’s logs, and a single record including deleted ones', async () => {
    const f = fake();
    const s = restShortcutsStore('https://p.supabase.co', 'k', f.fetchFn);
    await s.goals('u', '2026-Q4');
    await s.logsForGoal('u', 'g1');
    await s.get('u', 'logs', 'health-g1-2026-10-02');
    expect(f.seen[0].params).toMatchObject({ collection: 'eq.goals', 'data->>quarterId': 'eq.2026-Q4', deleted: 'is.false' });
    expect(f.seen[1].params).toMatchObject({ collection: 'eq.logs', 'data->>goalId': 'eq.g1', deleted: 'is.false' });
    expect(f.seen[2].params).toEqual({ select: 'data,deleted,updated_at', user_id: 'eq.u', collection: 'eq.logs', id: 'eq.health-g1-2026-10-02' });
  });

  it('has no fallback zone when notifications are not set up', async () => {
    const f = fake(() => new Response('relation does not exist', { status: 404 }));
    expect(await restShortcutsStore('https://p.supabase.co', 'k', f.fetchFn).latestTimeZone('u')).toBeNull();
  });
});
