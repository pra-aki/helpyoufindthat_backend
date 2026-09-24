-- Explicit Data API grants for every table, and length limits on products.
--
-- Supabase granted anon and authenticated full access to every new table in public automatically,
-- and stops doing so on 2026-10-30. Rebuilding this database from its migrations after that date
-- (a new project, a preview branch, a local reset) would leave every table unreachable, so the
-- grants are stated here. They also tighten access:
--
--   anon           Nothing. The browser only uses Supabase to sign in. All data goes through the
--                  backend, which always sends a signed-in user's token or the service key.
--   authenticated  Mirrors each table's row-level security policies, since most of the backend acts
--                  as the signed-in user. search_jobs and search_job_runs are read-only: a job has
--                  limits and spends Perplexity credit every day, so only the backend writes jobs,
--                  with the service key, after checking the request.
--   service_role   Full access, for the job runner and the backend-only job writes.
--
-- Revoking first replaces the defaults Supabase granted, including truncate, rather than adding to them.

revoke all on table
  public.products, public.search_results, public.search_requests, public.search_jobs, public.search_job_runs
  from anon, authenticated;

grant select, insert, update, delete on table public.products        to authenticated;
grant select, insert, update, delete on table public.search_results  to authenticated;
grant select, insert                 on table public.search_requests to authenticated;
grant select                         on table public.search_jobs     to authenticated;
grant select                         on table public.search_job_runs to authenticated;

grant select, insert, update, delete on table
  public.products, public.search_results, public.search_requests, public.search_jobs, public.search_job_runs
  to service_role;

-- Users can no longer write jobs, so the policies that let them go too.
drop policy "search_jobs: owner insert" on public.search_jobs;
drop policy "search_jobs: owner update" on public.search_jobs;
drop policy "search_jobs: owner delete" on public.search_jobs;

-- Length limits on products, matching the backend's validation. Signed-in users can still write
-- their own products directly through the Data API, which skips the backend, so the limits have to
-- live here to hold on every path. The description matters most: the job runner sends it to
-- Perplexity every day, so an unbounded one would be a cost paid on the user's behalf. A null
-- website or reply passes, as check constraints do on null.
alter table public.products
  add constraint products_name_length          check (char_length(name) <= 200),
  add constraint products_description_length   check (char_length(description) <= 2000),
  add constraint products_website_length       check (char_length(website) <= 2048),
  add constraint products_general_reply_length check (char_length(general_reply) <= 4000);
