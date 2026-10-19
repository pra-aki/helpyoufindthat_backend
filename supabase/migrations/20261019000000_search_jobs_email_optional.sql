-- Jobs no longer take an email address: every run emails the account's current address, looked up
-- when it sends, so a changed address is followed and a job can never be pointed at someone else.
-- The stored address is unused. This first step only stops requiring it, so the code that no
-- longer writes it can deploy while the old code is still running; a later migration drops it.
alter table public.search_jobs alter column email drop not null;
comment on column public.search_jobs.email is 'Unused: runs email the account''s current address. Dropped once no running code reads it.';
