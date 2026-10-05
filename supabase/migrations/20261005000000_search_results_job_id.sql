-- The scheduled job whose run stored each lead, so a job can list the leads it found.
--
-- A lead is one row per product, so this holds one job: the last job whose run stored the lead,
-- whether that run found it first or found it again. Manual searches never set or clear it. Two
-- jobs on the same product that find the same thread leave it with whichever found it last.

alter table public.search_results
  add column job_id uuid references public.search_jobs (id) on delete set null;

comment on column public.search_results.job_id is 'The scheduled job whose run last stored this lead; null for leads only ever found by manual searches';

-- Serves "this job's leads, latest first". Most leads come from manual searches and have no job,
-- so the index covers only the rows that do.
create index search_results_job_id_idx on public.search_results (job_id, search_date desc) where job_id is not null;

-- Runs before this migration did not set it. A run stamps every lead it stores with the run's time
-- as search_date, so a lead whose search_date still equals a run's time was stored by it. A lead
-- found again since then has a newer search_date and is missed; this is best effort for history.
update public.search_results r
set job_id = run.job_id
from public.search_job_runs run
join public.search_jobs j on j.id = run.job_id
where run.status = 'ok'
  and r.product_id = j.product_id
  and r.search_date = run.ran_at;
