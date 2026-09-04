-- Index links for lookups/dedup checks, and record when each search was run.

alter table public.search_results
  add column search_date timestamptz not null default now();

create index search_results_link_idx        on public.search_results (link);
create index search_results_search_date_idx on public.search_results (search_date desc);
