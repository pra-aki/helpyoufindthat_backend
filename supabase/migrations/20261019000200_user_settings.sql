-- Account-level settings, starting with whether scheduled jobs email their new leads.
--
-- A user with no row has every setting at its default, so existing accounts need no backfill:
-- job_lead_emails defaults to on. Users read and change their own row through the backend, acting
-- as themselves; a preference costs nothing and limits nothing, so it does not need the backend-only
-- treatment jobs and credits get. The job runner reads it with the service key before sending.

create table public.user_settings (
  user_id         uuid primary key references auth.users (id) on delete cascade,
  job_lead_emails boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on column public.user_settings.job_lead_emails is 'Whether scheduled jobs email new leads. Off still runs the jobs and stores the leads; it only stops the email.';

create trigger user_settings_set_updated_at
  before update on public.user_settings
  for each row execute function public.set_updated_at();

revoke all on table public.user_settings from anon, authenticated, service_role;
grant select, insert, update on table public.user_settings to authenticated;
grant select on table public.user_settings to service_role;

alter table public.user_settings enable row level security;
create policy "user_settings: owner select" on public.user_settings
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "user_settings: owner insert" on public.user_settings
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "user_settings: owner update" on public.user_settings
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- A run whose owner turned job emails off records that, rather than looking like nothing was new.
alter table public.search_job_runs drop constraint search_job_runs_email_status_check;
alter table public.search_job_runs add constraint search_job_runs_email_status_check
  check (email_status in ('sent', 'skipped', 'failed', 'not_configured', 'opted_out'));
comment on column public.search_job_runs.email_status is 'skipped when there was nothing new to send; opted_out when the owner turned job emails off';
