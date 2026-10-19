-- Second step: no running code reads or writes search_jobs.email any more (runs email the account's
-- current address), so the unused column goes.
alter table public.search_jobs drop column email;
