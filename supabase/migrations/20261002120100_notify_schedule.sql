-- Four Burners notification schedule, version 20261002120100 (notify_schedule).
--
-- What it is: every 5 minutes, pg_cron asks the notify Edge Function to send whatever is due (daily check-in,
-- weekly review, one smart nudge a day). The call goes through the project's API gateway, so it also counts
-- as activity: a free project with this schedule running does not pause for inactivity.
--   Vault secret four_burners_notify_url     the Edge Function's URL
--   Vault secret four_burners_notify_secret  a random value pg_cron sends; the function checks it with
--                                            notify_cron_ok() below, so only this schedule can trigger a run
--   cron job four-burners-notify             */5 * * * *
--   cron job four-burners-cron-cleanup       daily, keeps a week of cron run history
--
-- Needs 20261002120000_push.sql first, and the notify Edge Function deployed (README > Notifications).
-- How to apply: Supabase Dashboard > SQL Editor > New query > paste this whole file > Run.
-- Safe to run twice: existing secrets are kept, and the jobs are replaced by name.
-- Moved to a different Supabase project? Update the URL:
--   select vault.update_secret((select id from vault.secrets where name = 'four_burners_notify_url'),
--     'https://<project-ref>.supabase.co/functions/v1/notify');
-- Pause notifications for everyone: select cron.unschedule('four-burners-notify');

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'four_burners_notify_url') then
    perform vault.create_secret(
      'https://zkgdagxnrkqshulwnmya.supabase.co/functions/v1/notify',
      'four_burners_notify_url',
      'Four Burners: URL of the notify Edge Function, called by pg_cron'
    );
  end if;
  if not exists (select 1 from vault.secrets where name = 'four_burners_notify_secret') then
    -- 244 random bits from two v4 UUIDs (built in, no extension needed).
    perform vault.create_secret(
      replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
      'four_burners_notify_secret',
      'Four Burners: shared secret pg_cron sends to the notify Edge Function'
    );
  end if;
end;
$$;

-- notify_cron_ok ---------------------------------------------------------------------------------------------
-- True when p_secret is the schedule's secret. Only the service role (the Edge Function) may ask.

create or replace function public.notify_cron_ok(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select s.decrypted_secret = p_secret
       from vault.decrypted_secrets s
      where s.name = 'four_burners_notify_secret'
        and p_secret is not null
        and char_length(p_secret) >= 32),
    false
  );
$$;

revoke execute on function public.notify_cron_ok(text) from public, anon, authenticated;
grant execute on function public.notify_cron_ok(text) to service_role;

-- The schedule ---------------------------------------------------------------------------------------------

select cron.schedule(
  'four-burners-notify',
  '*/5 * * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'four_burners_notify_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-notify-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'four_burners_notify_secret')
    ),
    body := '{"source":"cron"}'::jsonb,
    timeout_milliseconds := 30000
  );
  $job$
);

select cron.schedule(
  'four-burners-cron-cleanup',
  '17 4 * * *',
  $job$ delete from cron.job_run_details where end_time < now() - interval '7 days' $job$
);

notify pgrst, 'reload schema';
