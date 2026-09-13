-- One row per search that reaches Perplexity: what was asked, exactly what was sent,
-- and what happened to the results. Rows older than 30 days are deleted daily.

create table public.search_requests (
  id                 uuid primary key default gen_random_uuid(),
  product_id         uuid not null references public.products (id) on delete cascade,
  user_id            uuid not null references auth.users (id) on delete cascade,
  forums             text[] not null,
  threads_requested  integer not null,
  date_from          date not null,
  date_to            date not null,
  status             text not null check (status in ('ok', 'error')),
  error              text,
  error_status       integer,
  prompt             text,
  settings           jsonb,
  raw_result_count   integer,
  search_result_urls text[],
  model_thread_count integer,
  used_fallback      boolean,
  returned_count     integer,
  dropped            jsonb,
  problem            text,
  usage              jsonb,
  duration_ms        integer,
  created_at         timestamptz not null default now()
);

comment on column public.search_requests.raw_result_count   is 'Sources Perplexity''s web search returned';
comment on column public.search_requests.search_result_urls is 'Links of those sources';
comment on column public.search_requests.model_thread_count is 'Threads the model proposed, before server-side filtering';
comment on column public.search_requests.used_fallback      is 'True when the model output was unusable and raw search results were used instead';
comment on column public.search_requests.returned_count     is 'Threads returned to the caller';
comment on column public.search_requests.dropped            is 'Proposed threads the server discarded, as [{ url, reason }]';

create index search_requests_product_created_idx on public.search_requests (product_id, created_at desc);
create index search_requests_user_id_idx         on public.search_requests (user_id);
create index search_requests_created_at_idx      on public.search_requests (created_at);

alter table public.search_requests enable row level security;

create policy "search_requests: owner select" on public.search_requests
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "search_requests: owner insert" on public.search_requests
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.products p where p.id = product_id and p.user_id = (select auth.uid()))
  );

-- 30-day retention.
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
select cron.schedule(
  'purge-search-requests-older-than-30-days',
  '17 3 * * *',
  $$delete from public.search_requests where created_at < now() - interval '30 days'$$
);
