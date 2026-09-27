// Proves the Supabase sync migration in PGlite (real Postgres compiled to wasm). The migration file runs
// unmodified on top of a small stub of what Supabase provides (roles, auth.users, auth.uid()), then the
// tests act as signed-in users, as anon, and as the service role, exactly like PostgREST would.
import { readFileSync } from 'node:fs';
import { PGlite, type PGliteInterface as Db } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SEED_UPDATED_AT, type PullCursor, type PulledRow } from './types';

const MIGRATION = readFileSync(new URL('../../supabase/migrations/20260926120000_sync_records.sql', import.meta.url), 'utf8');

// What a Supabase project has before any migration runs, reduced to what the migration touches.
// auth.users belongs to the Auth server's own role, which deletes users (see the cascade test).
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
`;

// Older Supabase projects grant everything on new public objects to the API roles by default.
const LEGACY_DEFAULT_PRIVILEGES = `
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;
// The 2026 default (new projects from May 30 2026, every project from Oct 30 2026) is the legacy one minus
// these two statements, verbatim from Supabase's changelog. Truncate, references, trigger and function
// execute are still granted by default, so the migration must revoke them itself.
const SUPABASE_2026_DEFAULT_PRIVILEGES = `
  ${LEGACY_DEFAULT_PRIVILEGES}
  alter default privileges for role postgres in schema public
    revoke select, insert, update, delete on tables from anon, authenticated, service_role;
  alter default privileges for role postgres in schema public
    revoke usage, select on sequences from anon, authenticated, service_role;
`;

/** legacy and 2026 are Supabase's two defaults; none (no default grants at all) is a self-hosted extreme. */
type Regime = 'legacy' | '2026' | 'none';
const DEFAULT_PRIVILEGES: Record<Regime, string> = { legacy: LEGACY_DEFAULT_PRIVILEGES, '2026': SUPABASE_2026_DEFAULT_PRIVILEGES, none: '' };

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const D = '00000000-0000-4000-8000-00000000000d';

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ISO_US = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** A toISOString() time, `ms` milliseconds after a fixed base. */
const at = (ms: number) => new Date(Date.UTC(2026, 8, 26, 12, 0, 0) + ms).toISOString();
const tick = () => new Promise((r) => setTimeout(r, 3));

interface PushRow {
  collection: string;
  id: string;
  data: unknown;
  updated_at: string;
  deleted?: boolean;
}
const row = (collection: string, id: string, updated_at: string, data: Record<string, unknown> = {}, deleted = false): PushRow => ({
  collection,
  id,
  data: { id, ...data },
  updated_at,
  deleted,
});

// Booting PGlite is the slow part (seconds), so boot once with the stub and give each describe a clone.
let stubbed: Promise<PGlite> | undefined;
const freshDb = async (): Promise<Db> =>
  (await (stubbed ??= PGlite.create().then(async (pg) => (await pg.exec(SUPABASE_STUB), pg)))).clone();
afterAll(async () => (await stubbed)?.close());

async function createDb(regime: Regime, migrationRuns = 1): Promise<Db> {
  const pg = await freshDb();
  if (DEFAULT_PRIVILEGES[regime]) await pg.exec(DEFAULT_PRIVILEGES[regime]);
  for (let i = 0; i < migrationRuns; i++) await pg.exec(MIGRATION);
  await pg.query('insert into auth.users (id) values ($1), ($2), ($3), ($4)', [A, B, C, D]);
  return pg;
}

/** Signed-in user, the way PostgREST runs a request with a user JWT. */
async function asUser(pg: Db, userId: string) {
  await pg.exec('set role authenticated');
  await pg.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
}
async function asAnon(pg: Db) {
  await pg.exec('set role anon');
  await pg.query("select set_config('request.jwt.claim.sub', '', false)");
}
async function asServiceRole(pg: Db) {
  await pg.exec('set role service_role');
  await pg.query("select set_config('request.jwt.claim.sub', '', false)");
}
/** Back to the session user (postgres, a superuser in PGlite; it sees every row, like the table owner). */
async function asPostgres(pg: Db) {
  await pg.exec('reset role');
  await pg.query("select set_config('request.jwt.claim.sub', '', false)");
}

// Named arguments, the way PostgREST calls an RPC, so the parameter names the Supabase remote sends are pinned.
async function push(pg: Db, rows: unknown): Promise<number> {
  const res = await pg.query<{ n: number }>('select public.push_records(p_rows => $1::jsonb) as n', [JSON.stringify(rows)]);
  return res.rows[0].n;
}
async function pull(pg: Db, after: PullCursor | null, limit: number | null = 200): Promise<PulledRow[]> {
  const sql =
    'select * from public.pull_records(p_after_ts => $1::timestamptz, p_after_collection => $2::text, p_after_id => $3::text, p_limit => $4::integer)';
  const res = await pg.query<PulledRow>(sql, [
    after?.ts ?? null,
    after?.collection ?? '',
    after?.id ?? '',
    limit,
  ]);
  return res.rows;
}
/** The cursor the engine continues from after a page. */
const cursorAfter = (r: PulledRow): PullCursor => ({ ts: r.server_updated_at, collection: r.collection, id: r.id });
/** Server time as epoch ms, parsed the way the engine does (first 23 characters). */
const serverMs = (ts: string) => Date.parse(ts.slice(0, 23) + 'Z');

async function pullAll(pg: Db, pageSize: number): Promise<PulledRow[]> {
  const out: PulledRow[] = [];
  const seen = new Set<string>();
  let cursor: PullCursor | null = null;
  for (;;) {
    const page = await pull(pg, cursor, pageSize);
    for (const r of page) {
      // Fail fast: a cursor that does not advance would otherwise page forever and hang the suite.
      if (seen.has(key(r))) throw new Error(`Paging returned ${key(r)} twice`);
      seen.add(key(r));
    }
    out.push(...page);
    if (page.length < pageSize) return out;
    cursor = cursorAfter(page[page.length - 1]);
  }
}

/** Pull order: server_updated_at (fixed-width text sorts chronologically), then collection and id bytewise. */
const bytes = (a: string, b: string) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
const pullOrder = (x: PulledRow, y: PulledRow) =>
  (x.server_updated_at < y.server_updated_at ? -1 : x.server_updated_at > y.server_updated_at ? 1 : 0) ||
  bytes(x.collection, y.collection) ||
  bytes(x.id, y.id);

const key = (r: { collection: string; id: string }) => `${r.collection}/${r.id}`;

describe.each<Regime>(['legacy', '2026', 'none'])('sync migration access control (%s default privileges)', (regime) => {
  let pg: Db;

  beforeAll(async () => {
    // The legacy project also gets the migration twice, so every access rule below is proven after a re-run.
    pg = await createDb(regime, regime === 'legacy' ? 2 : 1);
    await asUser(pg, A);
    await push(pg, [row('goals', 'g1', at(0), { title: 'A goal' }), row('kv', 'settings', at(0), { value: { theme: 'dark' } })]);
    await asUser(pg, B);
    await push(pg, [row('goals', 'b1', at(0), { title: 'B goal' })]);
    await asPostgres(pg);
  }, 60_000);

  afterEach(() => asPostgres(pg));
  afterAll(() => pg.close());

  it('turns on RLS, and the API roles are ordinary roles that RLS applies to', async () => {
    const rls = await pg.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where oid = 'public.records'::regclass");
    expect(rls.rows[0].relrowsecurity).toBe(true);
    const roles = await pg.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "select rolname, rolsuper, rolbypassrls from pg_roles where rolname in ('anon', 'authenticated') order by rolname",
    );
    expect(roles.rows).toEqual([
      { rolname: 'anon', rolsuper: false, rolbypassrls: false },
      { rolname: 'authenticated', rolsuper: false, rolbypassrls: false },
    ]);
    const policies = await pg.query<{ policyname: string; cmd: string; roles: string }>(
      "select policyname, cmd, roles::text as roles from pg_policies where schemaname = 'public' and tablename = 'records' order by policyname",
    );
    expect(policies.rows).toEqual([
      { policyname: 'records_insert_own', cmd: 'INSERT', roles: '{authenticated}' },
      { policyname: 'records_select_own', cmd: 'SELECT', roles: '{authenticated}' },
      { policyname: 'records_update_own', cmd: 'UPDATE', roles: '{authenticated}' },
    ]);
  });

  it('grants the API roles exactly what sync needs, whatever the project defaults', async () => {
    // Every privilege on the table and the RPCs, by grantee ('PUBLIC' for grantee 0).
    const acl = async (sql: string) => {
      const res = await pg.query<{ grantee: string; privs: string }>(`
        select case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee,
          string_agg(a.privilege_type, ',' order by a.privilege_type) as privs
        from (${sql}) o, aclexplode(o.acl) a group by 1
      `);
      return Object.fromEntries(res.rows.map((r) => [r.grantee, r.privs]));
    };
    const table = await acl("select relacl as acl from pg_class where oid = 'public.records'::regclass");
    expect(table.authenticated).toBe('INSERT,SELECT,UPDATE');
    expect(table.anon).toBeUndefined();
    expect(table.PUBLIC).toBeUndefined();
    expect(table.service_role?.split(',')).toEqual(expect.arrayContaining(['DELETE', 'INSERT', 'SELECT', 'TRUNCATE', 'UPDATE']));
    for (const fn of ['public.push_records(jsonb)', 'public.pull_records(timestamptz, text, text, integer)']) {
      const grants = await acl(`select proacl as acl from pg_proc where oid = '${fn}'::regprocedure`);
      expect({ fn, authenticated: grants.authenticated, service_role: grants.service_role, anon: grants.anon, PUBLIC: grants.PUBLIC }).toEqual({
        fn,
        authenticated: 'EXECUTE',
        service_role: 'EXECUTE',
        anon: undefined,
        PUBLIC: undefined,
      });
    }
  });

  it('shows each user only their own rows, through the table and through pull_records', async () => {
    // Both users' rows exist (postgres bypasses RLS), so an empty result below can only come from RLS.
    const all = await pg.query<{ user_id: string; id: string }>('select user_id, id from public.records order by id');
    expect(all.rows).toEqual([
      { user_id: B, id: 'b1' },
      { user_id: A, id: 'g1' },
      { user_id: A, id: 'settings' },
    ]);

    await asUser(pg, B);
    const table = await pg.query<{ id: string }>('select id from public.records order by id');
    expect(table.rows.map((r) => r.id)).toEqual(['b1']);
    const byA = await pg.query('select id from public.records where user_id = $1', [A]);
    expect(byA.rows).toEqual([]);
    expect((await pull(pg, null)).map(key)).toEqual(['goals/b1']);

    await asUser(pg, A);
    expect((await pull(pg, null)).map(key)).toEqual(['goals/g1', 'kv/settings']);
  });

  it("does not let a user update another user's rows (0 rows) or move their own rows to someone else", async () => {
    await asUser(pg, B);
    const upd = await pg.query("update public.records set data = '{\"hacked\":true}', updated_at = now() where user_id = $1", [A]);
    expect(upd.affectedRows).toBe(0);
    const updAll = await pg.query("update public.records set deleted = deleted where collection = 'goals'");
    expect(updAll.affectedRows).toBe(1); // only B's own row
    await expect(pg.query('update public.records set user_id = $1 where id = $2', [A, 'b1'])).rejects.toMatchObject({ code: '42501' });

    await asPostgres(pg);
    const a = await pg.query<{ data: unknown }>("select data from public.records where user_id = $1 and id = 'g1'", [A]);
    expect(a.rows[0].data).toEqual({ id: 'g1', title: 'A goal' });
  });

  it('does not let a user insert rows as another user, directly or through push_records', async () => {
    await asUser(pg, B);
    await expect(
      pg.query("insert into public.records (user_id, collection, id, data, updated_at) values ($1, 'goals', 'x', '{}', now())", [A]),
    ).rejects.toMatchObject({ code: '42501' });

    // push_records always writes as the caller: a newer copy of A's record, even naming A, lands in B's account.
    expect(await push(pg, [{ ...row('goals', 'g1', at(60_000), { title: 'from B' }), user_id: A }])).toBe(1);
    await asUser(pg, A);
    const mine = await pull(pg, null);
    expect(mine.find((r) => r.id === 'g1')!.data).toEqual({ id: 'g1', title: 'A goal' });
    await asUser(pg, B);
    expect((await pull(pg, null)).map(key)).toEqual(['goals/b1', 'goals/g1']);
  });

  it('fills user_id and server_updated_at on direct inserts, whatever the client sends', async () => {
    await asUser(pg, A);
    await pg.query(
      "insert into public.records (collection, id, data, updated_at, server_updated_at) values ('goals', 'direct', '{}', $1, '2000-01-01T00:00:00Z')",
      [at(0)],
    );
    const r = await pg.query<{ user_id: string; recent: boolean }>(
      "select user_id, server_updated_at > now() - interval '1 minute' as recent from public.records where id = 'direct'",
    );
    expect(r.rows).toEqual([{ user_id: A, recent: true }]);
  });

  it('never lets the app delete or truncate (tombstones only)', async () => {
    await asUser(pg, A);
    await expect(pg.query("delete from public.records where id = 'g1'")).rejects.toMatchObject({ code: '42501' });
    await expect(pg.exec('truncate public.records')).rejects.toMatchObject({ code: '42501' });
    await asPostgres(pg);
    expect((await pg.query("select 1 from public.records where user_id = $1 and id = 'g1'", [A])).rows).toHaveLength(1);
  });

  it('gives anon no access to the table or either RPC', async () => {
    await asAnon(pg);
    await expect(pg.query('select * from public.records')).rejects.toMatchObject({ code: '42501' });
    await expect(
      pg.query("insert into public.records (user_id, collection, id, data, updated_at) values ($1, 'goals', 'x', '{}', now())", [A]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(pg.query('update public.records set deleted = true')).rejects.toMatchObject({ code: '42501' });
    await expect(pg.query('delete from public.records')).rejects.toMatchObject({ code: '42501' });
    await expect(pg.exec('truncate public.records')).rejects.toMatchObject({ code: '42501' });
    await expect(push(pg, [row('goals', 'x', at(0))])).rejects.toMatchObject({ code: '42501' });
    await expect(pull(pg, null)).rejects.toMatchObject({ code: '42501' });
    await expect(pg.query('select * from public.pull_records()')).rejects.toMatchObject({ code: '42501' });
  });

  it('lets the service role read everything, but push_records still needs a signed-in user', async () => {
    await asServiceRole(pg);
    const n = await pg.query<{ n: number }>('select count(*)::int as n from public.records');
    expect(n.rows[0].n).toBeGreaterThanOrEqual(4);
    await expect(push(pg, [row('goals', 'x', at(0))])).rejects.toMatchObject({ code: '42501' });
    expect(await pull(pg, null)).toEqual([]);
  });

  it("removes an account's rows when Supabase deletes the user, with no delete grant", async () => {
    await asUser(pg, D);
    expect(await push(pg, [row('goals', 'd1', at(0)), row('logs', 'd2', at(0))])).toBe(2);
    // The Auth server deletes users as its own role, which has no privileges on public.records.
    await pg.exec('set role supabase_auth_admin');
    expect((await pg.query('delete from auth.users where id = $1', [D])).affectedRows).toBe(1);
    await asPostgres(pg);
    expect((await pg.query('select 1 from public.records where user_id = $1', [D])).rows).toEqual([]);
    expect((await pg.query('select 1 from public.records where user_id = $1', [A])).rows.length).toBeGreaterThan(0);
  });
});

describe('sync migration run as a non-superuser owner', () => {
  it("applies twice as the SQL Editor's postgres role would (not a superuser on Supabase)", async () => {
    const pg = await freshDb();
    try {
      await pg.exec(`
        create role editor nologin nosuperuser bypassrls;
        grant usage on schema auth to editor;
        grant create on schema public to editor;
        grant references on auth.users to editor;
        set role editor;
      `);
      await pg.exec(MIGRATION);
      await pg.exec(MIGRATION);
      await asPostgres(pg);
      const owner = await pg.query<{ owner: string }>("select relowner::regrole::text as owner from pg_class where oid = 'public.records'::regclass");
      expect(owner.rows).toEqual([{ owner: 'editor' }]);
      await pg.query('insert into auth.users (id) values ($1)', [A]);
      await asUser(pg, A);
      expect(await push(pg, [row('goals', 'g1', at(0), { title: 'Hi' })])).toBe(1);
      expect((await pull(pg, null)).map(key)).toEqual(['goals/g1']);
      await asAnon(pg);
      await expect(pull(pg, null)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await pg.close();
    }
  }, 60_000);
});

describe('sync migration push and pull', () => {
  let pg: Db;

  beforeAll(async () => {
    pg = await createDb('2026');
    // A session time zone far from UTC (and not on a whole hour) must not leak into the output formats.
    await pg.exec("set timezone to 'Pacific/Chatham'");
  }, 60_000);

  afterEach(() => asPostgres(pg));
  afterAll(() => pg.close());

  it('declares bytewise keys and the pull index', async () => {
    // PGlite's database default is already "C", so the paging tests alone cannot tell; Supabase's is not.
    const cols = await pg.query<{ attname: string; collname: string }>(`
      select a.attname, c.collname from pg_attribute a join pg_collation c on c.oid = a.attcollation
      where a.attrelid = 'public.records'::regclass and a.attname in ('collection', 'id') order by a.attname
    `);
    expect(cols.rows).toEqual([
      { attname: 'collection', collname: 'C' },
      { attname: 'id', collname: 'C' },
    ]);
    const idx = await pg.query<{ def: string }>("select pg_get_indexdef('public.records_pull_idx'::regclass) as def");
    expect(idx.rows[0].def).toContain('(user_id, server_updated_at, collection, id)');
  });

  it('declares every function security invoker (RLS applies inside) with an empty search_path', async () => {
    // Behavior alone cannot tell: both RPCs filter by auth.uid() themselves, so security definer would pass
    // every other test while silently bypassing RLS.
    const fns = await pg.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null; provolatile: string }>(
      "select proname, prosecdef, proconfig, provolatile from pg_proc where pronamespace = 'public'::regnamespace order by proname",
    );
    expect(fns.rows).toEqual([
      { proname: 'pull_records', prosecdef: false, proconfig: ['search_path=""'], provolatile: 's' },
      { proname: 'push_records', prosecdef: false, proconfig: ['search_path=""'], provolatile: 'v' },
      { proname: 'records_set_server_updated_at', prosecdef: false, proconfig: ['search_path=""'], provolatile: 'v' },
    ]);
  });

  describe('push_records', () => {
    it('round-trips a record with the exact output formats', async () => {
      await asUser(pg, A);
      const data = { id: 'rt', title: 'Ship it ✓', nested: { list: [1, 2.5, 'x', null, true] }, emoji: '🔥' };
      expect(await push(pg, [{ collection: 'goals', id: 'rt', data, updated_at: '2026-09-26T08:07:06.005Z', deleted: false }])).toBe(1);
      expect(await push(pg, [row('quarters', 'seed', SEED_UPDATED_AT)])).toBe(1);
      // The first and last instants the table accepts print exactly like toISOString too.
      const edges = ['0001-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z'];
      expect(await push(pg, edges.map((t, i) => row('quarters', `edge${i}`, t)))).toBe(2);

      const rows = await pull(pg, null);
      expect(edges.map((_, i) => rows.find((r) => r.id === `edge${i}`)!.updated_at)).toEqual(edges);
      expect(edges.map((t) => new Date(t).toISOString())).toEqual(edges);
      const rt = rows.find((r) => r.id === 'rt')!;
      expect(rt).toEqual({
        collection: 'goals',
        id: 'rt',
        data,
        updated_at: '2026-09-26T08:07:06.005Z',
        deleted: false,
        server_updated_at: expect.stringMatching(ISO_US),
      });
      expect(rows.find((r) => r.id === 'seed')!.updated_at).toBe(SEED_UPDATED_AT);
      for (const r of rows) {
        expect(r.updated_at).toMatch(ISO_MS);
        expect(r.server_updated_at).toMatch(ISO_US);
        // The server time is UTC and recent, not shifted by the Chatham session time zone.
        expect(Math.abs(serverMs(r.server_updated_at) - Date.now())).toBeLessThan(60_000);
      }
    });

    it('round-trips the deleted flag (soft delete and restore)', async () => {
      await asUser(pg, A);
      expect(await push(pg, [row('people', 'p1', at(0), { name: 'Sam' })])).toBe(1);
      expect(await push(pg, [row('people', 'p1', at(1), { name: 'Sam', deleted: true }, true)])).toBe(1);
      let p1 = (await pull(pg, null)).find((r) => r.id === 'p1')!;
      expect(p1.deleted).toBe(true);
      expect(p1.data).toEqual({ id: 'p1', name: 'Sam', deleted: true });
      expect(await push(pg, [row('people', 'p1', at(2), { name: 'Sam' })])).toBe(1);
      p1 = (await pull(pg, null)).find((r) => r.id === 'p1')!;
      expect(p1.deleted).toBe(false);
      // An omitted deleted flag means not deleted.
      expect(await push(pg, [{ collection: 'people', id: 'p2', data: { id: 'p2' }, updated_at: at(0) }])).toBe(1);
      expect((await pull(pg, null)).find((r) => r.id === 'p2')!.deleted).toBe(false);
    });

    it('applies last write wins: older and equal are ignored, newer applies, counts match', async () => {
      await asUser(pg, A);
      expect(await push(pg, [row('logs', 'l1', at(1000), { v: 'first' })])).toBe(1);
      expect(await push(pg, [row('logs', 'l1', at(999), { v: 'older' })])).toBe(0);
      expect(await push(pg, [row('logs', 'l1', at(1000), { v: 'equal' })])).toBe(0);
      expect((await pull(pg, null)).find((r) => r.id === 'l1')!.data).toEqual({ id: 'l1', v: 'first' });

      expect(await push(pg, [row('logs', 'l1', at(1001), { v: 'newer' })])).toBe(1);
      let l1 = (await pull(pg, null)).find((r) => r.id === 'l1')!;
      expect(l1.data).toEqual({ id: 'l1', v: 'newer' });
      expect(l1.updated_at).toBe(at(1001));

      // A mixed batch: one stale, one newer, one brand new.
      expect(await push(pg, [row('logs', 'l1', at(5), { v: 'stale' }), row('logs', 'l2', at(0)), row('logs', 'l3', at(0))])).toBe(2);
      expect(await push(pg, [row('logs', 'l2', at(0)), row('logs', 'l3', at(1), { v: 'edit' })])).toBe(1);
      l1 = (await pull(pg, null)).find((r) => r.id === 'l1')!;
      expect(l1.data).toEqual({ id: 'l1', v: 'newer' });
      expect(await push(pg, [])).toBe(0);
    });

    it('keeps the newest of duplicate ids in one batch, without an error', async () => {
      await asUser(pg, A);
      const n = await push(pg, [
        row('crunch', 'd1', at(10), { v: 'b' }),
        row('crunch', 'd1', at(30), { v: 'newest' }),
        row('crunch', 'd1', at(20), { v: 'c' }),
        // A tie on updated_at: the later entry in the batch wins.
        row('crunch', 'd2', at(10), { v: 'first' }),
        row('crunch', 'd2', at(10), { v: 'second' }),
      ]);
      expect(n).toBe(2);
      const rows = await pull(pg, null);
      expect(rows.find((r) => r.id === 'd1')!.data).toEqual({ id: 'd1', v: 'newest' });
      expect(rows.find((r) => r.id === 'd1')!.updated_at).toBe(at(30));
      expect(rows.find((r) => r.id === 'd2')!.data).toEqual({ id: 'd2', v: 'second' });

      // Duplicates of an existing row: only a strictly newer copy counts.
      expect(await push(pg, [row('crunch', 'd1', at(25)), row('crunch', 'd1', at(30), { v: 'tie' })])).toBe(0);
      expect(await push(pg, [row('crunch', 'd1', at(25)), row('crunch', 'd1', at(31), { v: 'won' })])).toBe(1);
      expect((await pull(pg, null)).find((r) => r.id === 'd1')!.data).toEqual({ id: 'd1', v: 'won' });
    });

    it('changes server_updated_at only when a row is actually applied', async () => {
      await asUser(pg, A);
      const get = async (id: string) => (await pull(pg, null)).find((r) => r.id === id)!;
      await push(pg, [row('energy', 'e1', at(100)), row('energy', 'e2', at(100))]);
      const e1 = await get('e1');
      const e2 = await get('e2');
      expect(e1.server_updated_at).toBe(e2.server_updated_at); // one push, one server time

      await tick();
      expect(await push(pg, [row('energy', 'e1', at(99)), row('energy', 'e2', at(100))])).toBe(0);
      expect((await get('e1')).server_updated_at).toBe(e1.server_updated_at);
      expect((await get('e2')).server_updated_at).toBe(e2.server_updated_at);

      await tick();
      expect(await push(pg, [row('energy', 'e1', at(101)), row('energy', 'e2', at(100))])).toBe(1);
      expect((await get('e1')).server_updated_at > e1.server_updated_at).toBe(true);
      expect((await get('e2')).server_updated_at).toBe(e2.server_updated_at);
    });

    it('applies all of a batch or none of it', async () => {
      await asUser(pg, A);
      const good = row('reviews', 'ok', at(0));
      const bad: Array<[unknown, string]> = [
        [{ ...row('reviews', 'x', at(0)), data: [1, 2] }, '23514'],
        [{ ...row('reviews', 'x', at(0)), data: 'text' }, '23514'],
        [row('', 'x', at(0)), '23514'],
        [row('reviews', '', at(0)), '23514'],
        [row('reviews', 'x'.repeat(201), at(0)), '23514'],
        [row('c'.repeat(201), 'x', at(0)), '23514'],
        [{ collection: 'reviews', id: 'x', data: { id: 'x' } }, '23502'],
        [{ collection: 'reviews', data: {}, updated_at: at(0) }, '23502'],
        [{ ...row('reviews', 'x', at(0)), updated_at: 'infinity' }, '23514'],
        // Times toISOString cannot print as YYYY-MM-DD (to_char would drop the BC or print 5 digits).
        [{ ...row('reviews', 'x', at(0)), updated_at: '0044-03-15 00:00:00+00 BC' }, '23514'],
        [{ ...row('reviews', 'x', at(0)), updated_at: '10000-01-01T00:00:00Z' }, '23514'],
        [{ ...row('reviews', 'x', at(0)), updated_at: 'not a date' }, '22007'],
      ];
      for (const [b, code] of bad) await expect(push(pg, [good, b])).rejects.toMatchObject({ code });
      expect((await pull(pg, null)).some((r) => r.collection === 'reviews')).toBe(false);
      // The longest allowed key is fine.
      expect(await push(pg, [good, row('reviews', 'x'.repeat(200), at(0))])).toBe(2);
    });

    it('rejects the whole call when any string holds a NUL or half an emoji (the client must clean these)', async () => {
      // jsonb cannot store U+0000 or a lone surrogate, and JSON.stringify sends both as \u escapes, so one such
      // string anywhere in a batch fails the call before push_records even runs.
      await asUser(pg, A);
      const good = row('coachReplies', 'clean', at(0));
      await expect(push(pg, [good, row('coachReplies', 'nul', at(0), { text: 'a\u0000b' })])).rejects.toMatchObject({ code: '22P05' });
      await expect(push(pg, [good, row('coachReplies', 'half', at(0), { text: 'Nice work 🔥'.slice(0, -1) })])).rejects.toMatchObject({
        code: '22P02',
      });
      expect((await pull(pg, null)).some((r) => r.collection === 'coachReplies')).toBe(false);
    });

    it('rejects a push that is not an array, or has more than 1000 rows (exactly 1000 is fine)', async () => {
      await asUser(pg, B);
      await expect(push(pg, { collection: 'goals' })).rejects.toMatchObject({ code: '22023' });
      await expect(pg.query('select public.push_records(null)')).rejects.toMatchObject({ code: '22023' });

      const many = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => row('touchpoints', `${prefix}${i}`, at(i)));
      await expect(push(pg, many(1001, 'over'))).rejects.toMatchObject({ code: '22023' });
      expect(await pull(pg, null)).toEqual([]);
      expect(await push(pg, many(1000, 'max'))).toBe(1000);
      expect(await pull(pg, null, 1000)).toHaveLength(1000);
    });

    it('rejects a push with no signed-in user', async () => {
      await asUser(pg, '');
      await expect(push(pg, [row('goals', 'nobody', at(0))])).rejects.toMatchObject({ code: '42501' });
      await asPostgres(pg);
      await expect(push(pg, [row('goals', 'nobody', at(0))])).rejects.toMatchObject({ code: '42501' });
      expect((await pg.query("select 1 from public.records where id = 'nobody'")).rows).toEqual([]);
    });
  });

  describe('pull_records paging', () => {
    // Keys chosen so bytewise order differs from dictionary order (uppercase before lowercase, punctuation,
    // digits, a space, multibyte characters).
    const IDS = ['a', 'B', 'b', 'Z', '_x', '0', '10', '9', 'a b', 'ab', 'é', 'e', 'z', '~', 'Ω', 'A-1', 'a-1', 'aa'];
    const COLLECTIONS = ['goals', 'Goals', 'kv', 'logs'];
    let first: PulledRow[] = [];
    let second: PulledRow[] = [];
    let all: PulledRow[] = [];

    beforeAll(async () => {
      // One big push for C shares one server_updated_at. B writes in between (never visible to C), then
      // a second, later push for C that also moves one row from the first group.
      await asUser(pg, C);
      await push(pg, COLLECTIONS.flatMap((c) => IDS.map((id) => row(c, id, at(0)))));
      await tick();
      await asUser(pg, B);
      await push(pg, [row('goals', 'from-b', at(0)), row('Goals', 'a', at(0))]);
      await tick();
      await asUser(pg, C);
      await push(pg, [row('goals', 'late-1', at(0)), row('goals', 'a', at(1), { v: 'edited' }), row('actions', 'late-2', at(0))]);
      all = await pull(pg, null, 1000);
      await asPostgres(pg);
      const ts = [...new Set(all.map((r) => r.server_updated_at))].sort();
      expect(ts).toHaveLength(2);
      first = all.filter((r) => r.server_updated_at === ts[0]);
      second = all.filter((r) => r.server_updated_at === ts[1]);
    });

    it('returns rows in (server_updated_at, collection, id) order, bytewise', () => {
      expect(first).toHaveLength(COLLECTIONS.length * IDS.length - 1); // goals/a moved to the second push
      expect(second.map(key)).toEqual(['actions/late-2', 'goals/a', 'goals/late-1']);
      expect(all).toEqual([...all].sort(pullOrder));
      expect(all.map(key)).not.toContain('goals/from-b');
    });

    it.each([1, 2, 7])('pages with page size %i return every row exactly once, in order', async (size) => {
      await asUser(pg, C);
      const paged = await pullAll(pg, size);
      expect(paged).toEqual(all);
      expect(new Set(paged.map(key)).size).toBe(all.length);
    });

    it('accepts a millisecond toISOString lower bound as the cursor', async () => {
      await asUser(pg, C);
      const bound = (ms: number): PullCursor => ({ ts: new Date(ms).toISOString(), collection: '', id: '' });
      const firstMs = serverMs(first[0].server_updated_at);
      const secondMs = serverMs(second[0].server_updated_at);
      expect(secondMs).toBeGreaterThan(firstMs + 1);

      // The overlap start the engine uses (5 minutes before the cursor), and the cursor itself cut to ms.
      expect(await pull(pg, bound(firstMs - 300_000), 1000)).toEqual(all);
      expect(await pull(pg, bound(firstMs), 1000)).toEqual(all);
      // Just past the first push: only the second push.
      expect(await pull(pg, bound(firstMs + 1), 1000)).toEqual(second);
      expect(await pull(pg, bound(secondMs + 1), 1000)).toEqual([]);
      // Paging continues normally from a lower-bound start.
      const page = await pull(pg, bound(firstMs), 2);
      expect(page).toEqual(all.slice(0, 2));
      expect(await pull(pg, cursorAfter(page[1]), 3)).toEqual(all.slice(2, 5));
    });

    it('clamps the page size to 1..1000 (default 200)', async () => {
      await asUser(pg, D);
      await push(pg, Array.from({ length: 1000 }, (_, i) => row('logs', `n${i}`, at(i))));
      await push(pg, Array.from({ length: 5 }, (_, i) => row('logs', `m${i}`, at(i))));
      const total = (await pg.query<{ n: number }>('select count(*)::int as n from public.records')).rows[0].n;
      expect(total).toBe(1005);
      expect(await pull(pg, null, 0)).toHaveLength(1);
      expect(await pull(pg, null, -5)).toHaveLength(1);
      expect(await pull(pg, null, 1)).toHaveLength(1);
      expect(await pull(pg, null, null)).toHaveLength(200);
      expect((await pg.query('select * from public.pull_records()')).rows).toHaveLength(200);
      expect(await pull(pg, null, 1000)).toHaveLength(1000);
      expect(await pull(pg, null, 5000)).toHaveLength(1000);
      expect(await pull(pg, null, 2147483647)).toHaveLength(1000);
    });
  });

  it('runs again over existing data without losing rows or security', async () => {
    await asPostgres(pg);
    const before = (await pg.query('select user_id, collection, id, data, updated_at, deleted, server_updated_at from public.records order by 1, 2, 3')).rows;
    expect(before.length).toBeGreaterThan(1000);
    await pg.exec(MIGRATION);
    await pg.exec(MIGRATION);
    const afterRerun = (await pg.query('select user_id, collection, id, data, updated_at, deleted, server_updated_at from public.records order by 1, 2, 3')).rows;
    expect(afterRerun).toEqual(before);

    const counts = await pg.query<{ policies: number; triggers: number; rls: boolean }>(`
      select
        (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'records') as policies,
        (select count(*)::int from pg_trigger where tgrelid = 'public.records'::regclass and not tgisinternal) as triggers,
        (select relrowsecurity from pg_class where oid = 'public.records'::regclass) as rls
    `);
    expect(counts.rows[0]).toEqual({ policies: 3, triggers: 1, rls: true });

    await asUser(pg, A);
    expect(await push(pg, [row('goals', 'after-rerun', at(0))])).toBe(1);
    const mine = await pull(pg, null, 1000);
    expect(mine.map((r) => r.id)).toContain('after-rerun');
    expect(mine.every((r) => r.id !== 'max0')).toBe(true); // B's rows stay hidden
    await asAnon(pg);
    await expect(pull(pg, null)).rejects.toMatchObject({ code: '42501' });
  });
});
