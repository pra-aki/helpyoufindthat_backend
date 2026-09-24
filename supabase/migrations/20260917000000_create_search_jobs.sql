-- Scheduled searches. A job searches its product's forums once a day, from the day it is
-- created until end_date (inclusive), keeps the threads scoring at least min_score, and
-- emails the user the ones it had not stored before. One row per job, one per run.

create table public.search_jobs (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references public.products (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  email        text not null,
  forums       text[] not null,
  threads      integer not null check (threads between 1 and 50),
  min_score    numeric(4, 3) not null check (min_score between 0 and 1),
  start_date   date not null,
  end_date     date not null,
  status       text not null default 'active' check (status in ('active', 'completed', 'cancelled')),
  next_run_at  timestamptz not null,
  last_run_at  timestamptz,
  last_date_to date,
  last_status  text check (last_status in ('ok', 'error')),
  last_error   text,
  run_count    integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on column public.search_jobs.min_score    is 'Only threads with a relevance score at or above this are stored and emailed';
comment on column public.search_jobs.next_run_at  is 'When the runner should next search; advanced by whole days after each run';
comment on column public.search_jobs.last_date_to is 'Last day covered by a successful run; the next run starts here so no day is skipped';

create index search_jobs_due_idx      on public.search_jobs (next_run_at) where status = 'active';
create index search_jobs_user_id_idx  on public.search_jobs (user_id);
create index search_jobs_product_idx  on public.search_jobs (product_id);

create trigger search_jobs_set_updated_at
  before update on public.search_jobs
  for each row execute function public.set_updated_at();

create table public.search_job_runs (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid not null references public.search_jobs (id) on delete cascade,
  user_id        uuid not null references auth.users (id) on delete cascade,
  product_id     uuid not null references public.products (id) on delete cascade,
  ran_at         timestamptz not null default now(),
  date_from      date not null,
  date_to        date not null,
  status         text not null check (status in ('ok', 'error')),
  found_count    integer,
  lead_count     integer,
  new_lead_count integer,
  email_status   text check (email_status in ('sent', 'skipped', 'failed', 'not_configured')),
  email_error    text,
  error          text,
  error_status   integer,
  duration_ms    integer,
  created_at     timestamptz not null default now()
);

comment on column public.search_job_runs.found_count    is 'Threads the search returned, at any score';
comment on column public.search_job_runs.lead_count     is 'Threads at or above the job''s min_score, all stored under the product';
comment on column public.search_job_runs.new_lead_count is 'Leads not already stored under the product; these are what the email contains';
comment on column public.search_job_runs.email_status   is 'skipped when there was nothing new to send';

create index search_job_runs_job_idx  on public.search_job_runs (job_id, ran_at desc);
create index search_job_runs_user_idx on public.search_job_runs (user_id);

-- Users manage their own jobs and read their own runs. The runner writes with the
-- service role, which bypasses these policies.
alter table public.search_jobs enable row level security;
alter table public.search_job_runs enable row level security;

create policy "search_jobs: owner select" on public.search_jobs
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "search_jobs: owner insert" on public.search_jobs
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.products p where p.id = product_id and p.user_id = (select auth.uid()))
  );
create policy "search_jobs: owner update" on public.search_jobs
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "search_jobs: owner delete" on public.search_jobs
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy "search_job_runs: owner select" on public.search_job_runs
  for select to authenticated using ((select auth.uid()) = user_id);
