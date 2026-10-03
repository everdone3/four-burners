-- Four Burners Apple Shortcuts, version 20261003120000 (shortcuts).
--
-- What it is: personal tokens that let a Shortcut on your iPhone log to your account through the shortcuts
-- Edge Function ("Hey Siri, log date night", touchpoints, daily Apple Health numbers).
--   shortcut_tokens  one row per token: only its SHA-256 hash, a label, and when it was made and last used.
--                    The token itself is shown once on your device and never stored anywhere on the server.
--   shortcut_token_create(hash, label)  add a token (at most 10 per account)
--   shortcut_tokens_list()              your tokens, newest first (no hashes)
--   shortcut_token_revoke(id)           delete one of your tokens; Shortcuts using it stop working at once
--   shortcuts_put_record(...)           (service role only) newer-wins write of a log or touchpoint
-- The Edge Function (service role) looks tokens up by hash and writes logs and touchpoints into records.
--
-- How to apply: Supabase Dashboard > SQL Editor > New query > paste this whole file > Run.
-- Safe to run twice: every statement is idempotent and running it again keeps all data.

create table if not exists public.shortcut_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  token_hash text not null unique,
  label text not null default '',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  constraint shortcut_tokens_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint shortcut_tokens_label_check check (char_length(label) <= 60)
);

create index if not exists shortcut_tokens_user_idx on public.shortcut_tokens (user_id);

-- RLS on with no policies: the API roles reach this table only through the RPCs below.
alter table public.shortcut_tokens enable row level security;
revoke all on table public.shortcut_tokens from public, anon, authenticated;
grant all on table public.shortcut_tokens to service_role;

create or replace function public.shortcut_token_create(p_hash text, p_label text default '')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'shortcut_token_create: not signed in' using errcode = '42501';
  end if;
  if (select count(*) from public.shortcut_tokens where user_id = v_uid) >= 10 then
    raise exception 'shortcut_token_create: at most 10 tokens; revoke one first' using errcode = '54000';
  end if;
  insert into public.shortcut_tokens (user_id, token_hash, label)
  values (v_uid, p_hash, coalesce(left(trim(p_label), 60), ''))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.shortcut_tokens_list()
returns table (id uuid, label text, created_at timestamptz, last_used_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, t.label, t.created_at, t.last_used_at
  from public.shortcut_tokens t
  where t.user_id = (select auth.uid())
  order by t.created_at desc;
$$;

create or replace function public.shortcut_token_revoke(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_n integer;
begin
  if v_uid is null then
    raise exception 'shortcut_token_revoke: not signed in' using errcode = '42501';
  end if;
  delete from public.shortcut_tokens where id = p_id and user_id = v_uid;
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

-- shortcuts_put_record ---------------------------------------------------------------------------------------
-- How the Edge Function writes a log or touchpoint: the same newer-wins rule as push_records (a row lands only
-- if its updated_at is strictly newer than the stored copy), and a deleted record is never brought back.
-- Only the service role (the Edge Function) may call it. Returns whether the row was written.

create or replace function public.shortcuts_put_record(
  p_user uuid,
  p_collection text,
  p_id text,
  p_data jsonb,
  p_updated_at timestamptz
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_n integer;
begin
  if p_collection not in ('logs', 'touchpoints') then
    raise exception 'shortcuts_put_record: unsupported collection' using errcode = '22023';
  end if;
  insert into public.records as r (user_id, collection, id, data, updated_at, deleted)
  values (p_user, p_collection, p_id, p_data, p_updated_at, false)
  on conflict (user_id, collection, id) do update
    set data = excluded.data, updated_at = excluded.updated_at, deleted = false
    where r.updated_at < excluded.updated_at and not r.deleted;
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

revoke execute on function public.shortcuts_put_record(uuid, text, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.shortcuts_put_record(uuid, text, text, jsonb, timestamptz) to service_role;

revoke execute on function public.shortcut_token_create(text, text) from public, anon;
grant execute on function public.shortcut_token_create(text, text) to authenticated, service_role;
revoke execute on function public.shortcut_tokens_list() from public, anon;
grant execute on function public.shortcut_tokens_list() to authenticated, service_role;
revoke execute on function public.shortcut_token_revoke(uuid) from public, anon;
grant execute on function public.shortcut_token_revoke(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
