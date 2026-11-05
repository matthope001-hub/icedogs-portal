-- Availability window scheduling
-- Applied to project fcehtovermlilpvwcksl. Safe to re-run.

-- 1. New columns on month_windows
alter table month_windows
  add column if not exists opens_at timestamptz,
  add column if not exists closes_at timestamptz,
  add column if not exists open_email_sent_at timestamptz,
  add column if not exists reminder_sent_at timestamptz,
  add column if not exists close_email_sent_at timestamptz;

-- 2. Private config table for the cron secret.
--    RLS on with no policies = no access from the browser (anon key);
--    only the service role (edge functions) and postgres (cron) can read it.
create table if not exists scheduler_config (
  key text primary key,
  value text not null
);
alter table scheduler_config enable row level security;

insert into scheduler_config (key, value)
values ('cron_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;

-- 3. Extensions for the 15-minute check
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 4. Run window-scheduler every 15 minutes
select cron.unschedule('window-scheduler')
where exists (select 1 from cron.job where jobname = 'window-scheduler');

select cron.schedule(
  'window-scheduler',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://fcehtovermlilpvwcksl.supabase.co/functions/v1/window-scheduler',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZjZWh0b3Zlcm1saWxwdndja3NsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4NTQzMDQsImV4cCI6MjEwMTQzMDMwNH0.Gllg9p2j3Bxrv1bpyNFBQMQtYQfWXDcxF9H7njyBksU',
      'x-cron-secret', (select value from scheduler_config where key = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

-- To check runs:   select * from cron.job_run_details order by start_time desc limit 10;
-- To remove later: select cron.unschedule('window-scheduler');
