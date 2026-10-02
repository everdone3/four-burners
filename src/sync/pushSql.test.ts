// Proves the push migration (subscriptions and notify state) in PGlite, on the same Supabase stub as
// sql.test.ts: the API roles can only go through the RPCs, and each account only touches its own devices.
// The schedule migration (pg_cron, pg_net, Vault) needs real Supabase and is not run here.
import { readFileSync } from 'node:fs';
import { PGlite, type PGliteInterface as Db } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const SYNC = readFileSync(new URL('../../supabase/migrations/20260926120000_sync_records.sql', import.meta.url), 'utf8');
const PUSH = readFileSync(new URL('../../supabase/migrations/20261002120000_push.sql', import.meta.url), 'utf8');

const SUPABASE_STUB = `
  create role anon nologin noinherit;
  create role authenticated nologin noinherit;
  create role service_role nologin noinherit bypassrls;
  create role supabase_auth_admin nologin noinherit;
  create schema auth authorization supabase_auth_admin;
  create table auth.users (id uuid primary key);
  alter table auth.users owner to supabase_auth_admin;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema public, auth to anon, authenticated, service_role;
  -- Older projects' default: everything granted to the API roles. The migration must take it back.
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

const P256 = 'B' + 'x'.repeat(86); // 87 base64url characters, like a real 65-byte key
const AUTH = 'a'.repeat(22);
const ep = (n: string | number) => `https://web.push.apple.com/${n}`;

let pg: Db;
beforeAll(async () => {
  const db = await PGlite.create();
  await db.exec(SUPABASE_STUB);
  await db.exec(SYNC);
  await db.exec(PUSH);
  await db.exec(PUSH); // safe to run twice
  await db.query('insert into auth.users (id) values ($1), ($2)', [A, B]);
  pg = db;
}, 60_000);
afterAll(() => pg?.close());
afterEach(() => as(null));

async function as(role: 'authenticated' | 'anon' | 'service_role' | null, uid = '') {
  await pg.exec(role ? `set role ${role}` : 'reset role');
  await pg.query("select set_config('request.jwt.claim.sub', $1, false)", [uid]);
}

interface Status {
  last_sent_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  gone: boolean;
}

async function subscribe(endpoint: string, opts: { p256dh?: string; auth?: string; device?: string; tz?: string } = {}): Promise<Status> {
  const res = await pg.query<{ s: Status }>(
    'select public.push_subscribe(p_endpoint => $1, p_p256dh => $2, p_auth => $3, p_device => $4, p_time_zone => $5) as s',
    [endpoint, opts.p256dh ?? P256, opts.auth ?? AUTH, opts.device ?? 'iPhone', opts.tz ?? 'America/Chicago'],
  );
  return res.rows[0].s;
}
const unsubscribe = async (endpoint: string) =>
  (await pg.query<{ ok: boolean }>('select public.push_unsubscribe(p_endpoint => $1) as ok', [endpoint])).rows[0].ok;
const rows = async () =>
  (await pg.query<{ endpoint: string; user_id: string; time_zone: string; device: string; last_sent_at: string | null }>(
    'select endpoint, user_id, time_zone, device, last_sent_at from public.push_subscriptions order by endpoint',
  )).rows;

describe('push migration', () => {
  it('saves and refreshes a device subscription', async () => {
    await as('authenticated', A);
    expect(await subscribe(ep('a1'), { tz: 'America/Chicago' })).toEqual({ last_sent_at: null, last_error: null, last_error_at: null, gone: false });
    await subscribe(ep('a1'), { tz: 'Asia/Tokyo', device: 'iPad' });
    await as(null);
    expect(await rows()).toEqual([{ endpoint: ep('a1'), user_id: A, time_zone: 'Asia/Tokyo', device: 'iPad', last_sent_at: null }]);
  });

  it('reports what the server recorded: last sent, last error, gone', async () => {
    await as(null);
    await pg.query(
      "update public.push_subscriptions set last_sent_at = '2026-10-02T01:00:00Z', last_error = '403: BadJwtToken', last_error_at = now(), gone_at = now() where endpoint = $1",
      [ep('a1')],
    );
    await as('authenticated', A);
    const s = await subscribe(ep('a1'));
    expect(s.last_error).toBe('403: BadJwtToken');
    // jsonb timestamps carry the session's offset; the app parses them with Date.parse.
    expect(Date.parse(s.last_sent_at!)).toBe(Date.parse('2026-10-02T01:00:00Z'));
    expect(s.gone).toBe(true);
  });

  it('an endpoint that moves to another account starts clean', async () => {
    await as('authenticated', B);
    const s = await subscribe(ep('a1'));
    expect(s).toMatchObject({ last_sent_at: null, last_error: null });
    await as(null);
    expect((await rows()).find((r) => r.endpoint === ep('a1'))?.user_id).toBe(B);
  });

  it('only removes your own subscriptions', async () => {
    await as('authenticated', A);
    expect(await unsubscribe(ep('a1'))).toBe(false); // B owns it now
    await as('authenticated', B);
    expect(await unsubscribe(ep('a1'))).toBe(true);
    await as(null);
    expect(await rows()).toEqual([]);
  });

  it('rejects malformed subscriptions', async () => {
    await as('authenticated', A);
    await expect(subscribe('http://insecure.example/x')).rejects.toThrow(/endpoint_check/);
    await expect(subscribe(ep('k'), { p256dh: 'short' })).rejects.toThrow(/p256dh_check/);
    await expect(subscribe(ep('k'), { auth: 'has spaces in it!!!!!!' })).rejects.toThrow(/auth_check/);
    await expect(subscribe(`https://x/${'a'.repeat(1000)}`)).rejects.toThrow(/endpoint_check/);
  });

  it('keeps at most 20 devices per account, dropping the least recently seen', async () => {
    await as(null);
    await pg.exec('delete from public.push_subscriptions');
    await as('authenticated', A);
    for (let i = 0; i < 21; i++) {
      await subscribe(ep(`d${String(i).padStart(2, '0')}`));
      await as(null);
      await pg.query("update public.push_subscriptions set last_seen_at = now() - make_interval(mins => 100 - $1::int) where endpoint = $2", [i, ep(`d${String(i).padStart(2, '0')}`)]);
      await as('authenticated', A);
    }
    await as(null);
    const left = await rows();
    expect(left).toHaveLength(20);
    expect(left.map((r) => r.endpoint)).not.toContain(ep('d00'));
  });

  it('needs a signed-in user', async () => {
    await as('anon');
    await expect(subscribe(ep('x'))).rejects.toThrow(/permission denied/);
    await expect(unsubscribe(ep('x'))).rejects.toThrow(/permission denied/);
    await as('authenticated', '');
    await expect(subscribe(ep('x'))).rejects.toThrow(/not signed in/);
  });

  it('gives the API roles no direct access to either table', async () => {
    for (const role of ['authenticated', 'anon'] as const) {
      await as(role, A);
      for (const sql of [
        'select * from public.push_subscriptions',
        'select * from public.push_state',
        `insert into public.push_state (user_id) values ('${A}')`,
        'delete from public.push_subscriptions',
      ]) {
        await expect(pg.query(sql)).rejects.toThrow(/permission denied/);
      }
    }
  });

  it('lets the service role (the Edge Function) read and claim state', async () => {
    await as('service_role');
    await pg.query('insert into public.push_state (user_id) values ($1) on conflict (user_id) do nothing', [A]);
    const claim = (d: string) =>
      pg.query('update public.push_state set daily_date = $2 where user_id = $1 and (daily_date is null or daily_date <> $2) returning user_id', [A, d]);
    expect((await claim('2026-10-02')).rows).toHaveLength(1);
    expect((await claim('2026-10-02')).rows).toHaveLength(0);
    expect((await claim('2026-10-03')).rows).toHaveLength(1);
    expect((await pg.query('select count(*)::int as n from public.push_subscriptions')).rows).toEqual([{ n: 20 }]);
  });

  it('deleting the account removes its devices and state', async () => {
    await as(null);
    await pg.exec(`set role supabase_auth_admin; delete from auth.users where id = '${A}'; reset role;`);
    expect((await pg.query('select count(*)::int as n from public.push_subscriptions')).rows).toEqual([{ n: 0 }]);
    expect((await pg.query('select count(*)::int as n from public.push_state')).rows).toEqual([{ n: 0 }]);
  });
});
