-- Four Burners push notifications, version 20261002120000 (push).
--
-- What it is: where each device's Web Push subscription lives, and what the notify Edge Function remembers
-- so nothing is sent twice.
--   push_subscriptions  one row per device (keyed by its push endpoint). Written only through the RPCs below.
--   push_state          per account: which daily, weekly and nudge notifications were already handled.
--                       Only the Edge Function (service role) reads or writes it.
--   push_subscribe(...)    save or refresh this device's subscription and current time zone. Returns its status.
--   push_unsubscribe(...)  forget this device's subscription.
-- The schedule that runs the Edge Function is the next migration (20261002120100_notify_schedule.sql).
--
-- How to apply: Supabase Dashboard > SQL Editor > New query > paste this whole file > Run.
-- Safe to run twice: every statement is idempotent and running it again keeps all data.

-- push_subscriptions -------------------------------------------------------------------------------------

create table if not exists public.push_subscriptions (
  -- The push service URL for one browser on one device. Globally unique, so it is the key.
  endpoint text collate "C" primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The browser's encryption keys (base64url): P-256 public key and auth secret.
  p256dh text not null,
  auth text not null,
  -- 'iPhone', 'iPad', 'Mac': shown in Settings only.
  device text not null default '',
  -- IANA time zone the device was last in (e.g. 'America/Chicago'). Reminders follow the latest one seen.
  time_zone text not null default 'UTC',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_sent_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  -- Set when the push service says the subscription no longer exists (404/410). Nothing is sent to it again;
  -- the device sees this on its next open and subscribes afresh.
  gone_at timestamptz,
  constraint push_subscriptions_endpoint_check check (endpoint like 'https://%' and char_length(endpoint) <= 1000),
  constraint push_subscriptions_p256dh_check check (p256dh ~ '^[A-Za-z0-9_-]{80,100}$'),
  constraint push_subscriptions_auth_check check (auth ~ '^[A-Za-z0-9_-]{16,44}$'),
  constraint push_subscriptions_device_check check (char_length(device) <= 40),
  constraint push_subscriptions_time_zone_check check (char_length(time_zone) between 1 and 64)
);

create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

-- push_state ------------------------------------------------------------------------------------------------

create table if not exists public.push_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- Lived date the daily reminder was last handled (sent, or skipped because you already checked in).
  daily_date date,
  -- Monday of the review week whose reminder was last handled.
  weekly_week date,
  -- Lived date smart nudges were last considered.
  nudge_date date,
  -- Nudge subject ('burner:health', 'person:<id>') to the lived date it last nudged, for cooldowns.
  nudged jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint push_state_nudged_check check (jsonb_typeof(nudged) = 'object')
);

-- Access ------------------------------------------------------------------------------------------------------
-- RLS on with no policies: the API roles cannot touch either table directly (the RPCs below are the only
-- way in for a signed-in user). The service role bypasses RLS.

alter table public.push_subscriptions enable row level security;
alter table public.push_state enable row level security;

revoke all on table public.push_subscriptions from public, anon, authenticated;
revoke all on table public.push_state from public, anon, authenticated;
grant all on table public.push_subscriptions to service_role;
grant all on table public.push_state to service_role;

-- push_subscribe ------------------------------------------------------------------------------------------
-- Save this device's subscription, or refresh it (time zone, last seen) on every app open. An endpoint that
-- moved to another account (same device, different sign-in) moves with it. Returns the subscription's
-- status: {last_sent_at, last_error, last_error_at, gone}. gone = the push service dropped it.

create or replace function public.push_subscribe(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_device text default '',
  p_time_zone text default 'UTC'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.push_subscriptions;
begin
  if v_uid is null then
    raise exception 'push_subscribe: not signed in' using errcode = '42501';
  end if;

  insert into public.push_subscriptions as s (endpoint, user_id, p256dh, auth, device, time_zone)
  values (p_endpoint, v_uid, p_p256dh, p_auth, coalesce(left(p_device, 40), ''), coalesce(nullif(left(p_time_zone, 64), ''), 'UTC'))
  on conflict (endpoint) do update
    set user_id = excluded.user_id,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        device = excluded.device,
        time_zone = excluded.time_zone,
        last_seen_at = pg_catalog.now(),
        -- A different account (or new keys) starts with a clean status.
        last_error = case when s.user_id = excluded.user_id and s.p256dh = excluded.p256dh then s.last_error end,
        last_error_at = case when s.user_id = excluded.user_id and s.p256dh = excluded.p256dh then s.last_error_at end,
        last_sent_at = case when s.user_id = excluded.user_id then s.last_sent_at end
  returning * into v_row;

  -- At most 20 devices per account: the least recently seen go first.
  delete from public.push_subscriptions
  where user_id = v_uid
    and endpoint in (
      select endpoint from public.push_subscriptions
      where user_id = v_uid
      order by last_seen_at desc, endpoint
      offset 20
    );

  return pg_catalog.jsonb_build_object(
    'last_sent_at', v_row.last_sent_at,
    'last_error', v_row.last_error,
    'last_error_at', v_row.last_error_at,
    'gone', v_row.gone_at is not null
  );
end;
$$;

-- push_unsubscribe ----------------------------------------------------------------------------------------
-- Forget one of your own subscriptions (someone else's endpoint is left alone). Returns whether one was removed.

create or replace function public.push_unsubscribe(p_endpoint text)
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
    raise exception 'push_unsubscribe: not signed in' using errcode = '42501';
  end if;
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = v_uid;
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

revoke execute on function public.push_subscribe(text, text, text, text, text) from public, anon;
grant execute on function public.push_subscribe(text, text, text, text, text) to authenticated, service_role;
revoke execute on function public.push_unsubscribe(text) from public, anon;
grant execute on function public.push_unsubscribe(text) to authenticated, service_role;

notify pgrst, 'reload schema';
