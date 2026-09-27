-- Four Burners sync schema, version 20260926120000 (sync_records).
--
-- What it is: the server side of sync. One table, public.records, holds every synced record of every
-- collection as a jsonb body, one row per (user, collection, id). Two RPCs move data:
--   push_records(p_rows jsonb) -> integer   conditional upsert, last write wins on updated_at
--   pull_records(p_after_ts, p_after_collection, p_after_id, p_limit) -> rows changed after a keyset cursor
-- Row Level Security limits every row to its owner (auth.uid()). Deletes are soft (deleted = true), so
-- there is no delete policy: the app only ever inserts or updates rows. Deleting the user in Supabase
-- Auth removes that user's rows (on delete cascade).
--
-- How to apply: Supabase Dashboard > SQL Editor > New query > paste this whole file > Run.
-- Safe to run twice: every statement is idempotent (if not exists, create or replace, drop ... if exists),
-- and running it again keeps all data. If the editor warns about destructive operations, that is the
-- drop policy / drop trigger lines, which only replace this file's own policies and trigger. Confirm to run.

-- Table ------------------------------------------------------------------------------------------------

create table if not exists public.records (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- Collation "C" makes (collection, id) order bytewise, the same on every server and in every index.
  collection text collate "C" not null,
  id text collate "C" not null,
  data jsonb not null,
  -- The record's own updatedAt (client clock). Drives last write wins.
  updated_at timestamptz not null,
  deleted boolean not null default false,
  -- When the server last applied a change to this row (set by trigger). Drives incremental pulls.
  server_updated_at timestamptz not null default now(),
  primary key (user_id, collection, id),
  constraint records_collection_check check (char_length(collection) between 1 and 200),
  constraint records_id_check check (char_length(id) between 1 and 200),
  constraint records_data_check check (jsonb_typeof(data) = 'object'),
  -- Years 1 to 9999 only, so pull_records' to_char output is always exactly what toISOString would print
  -- (no infinity, no BC years, no 5-digit years). toISOString clients never send anything else.
  constraint records_updated_at_check
    check (updated_at >= '0001-01-01 00:00:00+00' and updated_at < '10000-01-01 00:00:00+00')
);

-- Serves pull_records: one user's rows in (server_updated_at, collection, id) order.
create index if not exists records_pull_idx on public.records (user_id, server_updated_at, collection, id);

-- server_updated_at is always the server's clock, whatever the client sends. now() is the transaction
-- start, so every row applied by one push shares one server_updated_at (pull pages through ties by
-- collection and id). Rows a push skips (not newer) are not updated, so they keep their old value.
create or replace function public.records_set_server_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.server_updated_at := pg_catalog.now();
  return new;
end;
$$;

drop trigger if exists records_set_server_updated_at on public.records;
create trigger records_set_server_updated_at
  before insert or update on public.records
  for each row execute function public.records_set_server_updated_at();

-- Row Level Security --------------------------------------------------------------------------------------

alter table public.records enable row level security;

drop policy if exists "records_select_own" on public.records;
create policy "records_select_own" on public.records
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "records_insert_own" on public.records;
create policy "records_insert_own" on public.records
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "records_update_own" on public.records;
create policy "records_update_own" on public.records
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- No delete policy: records are tombstoned (deleted = true), never removed by the app.

-- Grants. Explicit, so they hold under every Supabase default. Older projects auto-grant ALL on new public
-- tables (and execute on new functions) to anon, authenticated and service_role. The 2026 default (new
-- projects from May 30 2026, all projects from Oct 30 2026) stops auto-granting select, insert, update and
-- delete, but still auto-grants truncate, references and trigger, and execute on functions. So revoke all
-- first: authenticated must never keep delete or truncate (truncate ignores RLS).
revoke all on table public.records from public, anon, authenticated;
grant select, insert, update on table public.records to authenticated;
grant all on table public.records to service_role;

-- push_records -------------------------------------------------------------------------------------------
-- p_rows: JSON array (at most 1000) of {collection, id, data, updated_at, deleted}. Each row applies only if
-- its updated_at is strictly newer than the stored copy (older and equal are skipped silently). Duplicate
-- (collection, id) pairs keep the newest (on a tie, the later one in the array). user_id is always the
-- caller. One statement, so the whole call applies or none of it does. Returns the number of rows applied.

create or replace function public.push_records(p_rows jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_applied integer;
begin
  if v_uid is null then
    raise exception 'push_records: not signed in' using errcode = '42501';
  end if;
  if p_rows is null or pg_catalog.jsonb_typeof(p_rows) <> 'array' then
    raise exception 'push_records: p_rows must be a JSON array' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_rows) > 1000 then
    raise exception 'push_records: at most 1000 rows per call' using errcode = '22023';
  end if;

  insert into public.records (user_id, collection, id, data, updated_at, deleted)
  select distinct on (x.collection, x.id)
    v_uid, x.collection, x.id, x.data, x.updated_at, coalesce(x.deleted, false)
  from rows from (
      pg_catalog.jsonb_to_recordset(p_rows)
        as (collection text, id text, data jsonb, updated_at timestamptz, deleted boolean)
    ) with ordinality as x(collection, id, data, updated_at, deleted, ord)
  order by x.collection, x.id, x.updated_at desc, x.ord desc
  on conflict (user_id, collection, id) do update
    set data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted
    where records.updated_at < excluded.updated_at;

  get diagnostics v_applied = row_count;
  return v_applied;
end;
$$;

-- pull_records -------------------------------------------------------------------------------------------
-- The caller's rows strictly after (p_after_ts, p_after_collection, p_after_id) in (server_updated_at,
-- collection, id) order, oldest first (all rows when p_after_ts is null). p_limit is clamped to 1..1000.
-- updated_at comes back exactly like JS toISOString (YYYY-MM-DDTHH:MM:SS.mmmZ); server_updated_at with
-- exactly 6 fractional digits (YYYY-MM-DDTHH:MM:SS.ffffffZ), both UTC, so the cursor round-trips exactly.
-- Rows are already in keyset order: callers must not re-sort them in the database's default collation.

create or replace function public.pull_records(
  p_after_ts timestamptz default null,
  p_after_collection text default '',
  p_after_id text default '',
  p_limit integer default 200
)
returns table (collection text, id text, data jsonb, updated_at text, deleted boolean, server_updated_at text)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    r.collection,
    r.id,
    r.data,
    pg_catalog.to_char(r.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    r.deleted,
    pg_catalog.to_char(r.server_updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  from public.records r
  where r.user_id = (select auth.uid())
    and (
      p_after_ts is null
      or (r.server_updated_at, r.collection, r.id)
         > (p_after_ts, coalesce(p_after_collection, '') collate "C", coalesce(p_after_id, '') collate "C")
    )
  order by r.server_updated_at, r.collection, r.id
  limit least(greatest(coalesce(p_limit, 200), 1), 1000);
$$;

-- Only signed-in users (and the service role) may call the RPCs.
revoke execute on function public.push_records(jsonb) from public, anon;
grant execute on function public.push_records(jsonb) to authenticated, service_role;
revoke execute on function public.pull_records(timestamptz, text, text, integer) from public, anon;
grant execute on function public.pull_records(timestamptz, text, text, integer) to authenticated, service_role;

-- Tell the Data API (PostgREST) to pick up the new table and functions now.
notify pgrst, 'reload schema';
