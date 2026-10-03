// Proves the shortcuts migration in PGlite on the same Supabase stub as sql.test.ts: tokens are reachable only
// through the RPCs, only as hashes, and each account sees and revokes only its own.
import { readFileSync } from 'node:fs';
import { PGlite, type PGliteInterface as Db } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const SYNC = readFileSync(new URL('../../supabase/migrations/20260926120000_sync_records.sql', import.meta.url), 'utf8');
const SHORTCUTS = readFileSync(new URL('../../supabase/migrations/20261003120000_shortcuts.sql', import.meta.url), 'utf8');

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
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const hash = (n: number) => n.toString(16).padStart(64, '0');

let pg: Db;
beforeAll(async () => {
  const db = await PGlite.create();
  await db.exec(SUPABASE_STUB);
  await db.exec(SYNC);
  await db.exec(SHORTCUTS);
  await db.exec(SHORTCUTS); // safe to run twice
  await db.query('insert into auth.users (id) values ($1), ($2)', [A, B]);
  pg = db;
}, 60_000);
afterAll(() => pg?.close());
afterEach(() => as(null));

async function as(role: 'authenticated' | 'anon' | 'service_role' | null, uid = '') {
  await pg.exec(role ? `set role ${role}` : 'reset role');
  await pg.query("select set_config('request.jwt.claim.sub', $1, false)", [uid]);
}
const create = async (h: string, label = 'iPhone') =>
  (await pg.query<{ id: string }>('select public.shortcut_token_create(p_hash => $1, p_label => $2) as id', [h, label])).rows[0].id;
const list = async () =>
  (await pg.query<{ id: string; label: string; last_used_at: string | null }>('select * from public.shortcut_tokens_list()')).rows;
const revoke = async (id: string) => (await pg.query<{ ok: boolean }>('select public.shortcut_token_revoke(p_id => $1) as ok', [id])).rows[0].ok;

describe('shortcuts migration', () => {
  let aToken: string;

  it('creates and lists your own tokens, without hashes', async () => {
    await as('authenticated', A);
    aToken = await create(hash(1), '  iPhone Shortcuts  ');
    const rows = await list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: aToken, label: 'iPhone Shortcuts', last_used_at: null });
    expect(Object.keys(rows[0])).not.toContain('token_hash');
    await as('authenticated', B);
    expect(await list()).toEqual([]);
  });

  it('only stores real SHA-256 hex hashes, each once', async () => {
    await as('authenticated', A);
    await expect(create('fb_plaintext_token_should_never_be_stored_here_0000000')).rejects.toThrow(/hash_check/);
    await expect(create(hash(1))).rejects.toThrow(/duplicate key/);
  });

  it('only revokes your own', async () => {
    await as('authenticated', B);
    expect(await revoke(aToken)).toBe(false);
    await as('authenticated', A);
    expect(await revoke(aToken)).toBe(true);
    expect(await list()).toEqual([]);
  });

  it('caps an account at 10 tokens', async () => {
    await as('authenticated', A);
    for (let i = 10; i < 20; i++) await create(hash(i));
    await expect(create(hash(99))).rejects.toThrow(/at most 10/);
  });

  it('lets the service role (the Edge Function) look up by hash and mark use', async () => {
    await as('service_role');
    const r = await pg.query<{ user_id: string }>('select user_id from public.shortcut_tokens where token_hash = $1', [hash(10)]);
    expect(r.rows).toEqual([{ user_id: A }]);
    await pg.query('update public.shortcut_tokens set last_used_at = now() where token_hash = $1', [hash(10)]);
  });

  it('gives the API roles no direct access, and needs a sign-in', async () => {
    for (const role of ['authenticated', 'anon'] as const) {
      await as(role, A);
      await expect(pg.query('select * from public.shortcut_tokens')).rejects.toThrow(/permission denied/);
    }
    await as('anon');
    await expect(create(hash(50))).rejects.toThrow(/permission denied/);
    await expect(list()).rejects.toThrow(/permission denied/);
    await as('authenticated', '');
    await expect(create(hash(51))).rejects.toThrow(/not signed in/);
  });

  it('writes logs for the Edge Function only when newer, never reviving a deleted one', async () => {
    const put = (id: string, at: string, value: number) =>
      pg.query<{ ok: boolean }>(
        'select public.shortcuts_put_record(p_user => $1, p_collection => $2, p_id => $3, p_data => $4::jsonb, p_updated_at => $5) as ok',
        [A, 'logs', id, JSON.stringify({ id, value }), at],
      ).then((r) => r.rows[0].ok);
    const stored = async (id: string) => (await pg.query<{ v: number; deleted: boolean }>("select (data->>'value')::int as v, deleted from public.records where id = $1", [id])).rows[0];
    await as('service_role');
    expect(await put('h1', '2026-10-02T10:00:00Z', 1)).toBe(true);
    expect(await put('h1', '2026-10-02T09:00:00Z', 2)).toBe(false); // older
    expect(await put('h1', '2026-10-02T10:00:00Z', 3)).toBe(false); // equal
    expect(await put('h1', '2026-10-02T11:00:00Z', 4)).toBe(true);
    expect(await stored('h1')).toEqual({ v: 4, deleted: false });
    await as(null);
    await pg.query("update public.records set deleted = true, updated_at = '2026-10-02T12:00:00Z' where id = 'h1'");
    await as('service_role');
    expect(await put('h1', '2026-10-03T00:00:00Z', 5)).toBe(false);
    expect(await stored('h1')).toEqual({ v: 4, deleted: true });
    await expect(
      pg.query("select public.shortcuts_put_record(p_user => $1, p_collection => 'goals', p_id => 'g', p_data => '{}'::jsonb, p_updated_at => now())", [A]),
    ).rejects.toThrow(/unsupported collection/);
    for (const role of ['authenticated', 'anon'] as const) {
      await as(role, A);
      await expect(put('h2', '2026-10-02T10:00:00Z', 1)).rejects.toThrow(/permission denied/);
    }
  });

  it('deleting the account removes its tokens', async () => {
    await pg.exec(`set role supabase_auth_admin; delete from auth.users where id = '${A}'; reset role;`);
    expect((await pg.query('select count(*)::int as n from public.shortcut_tokens')).rows).toEqual([{ n: 0 }]);
  });
});
