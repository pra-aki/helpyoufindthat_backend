-- Products a user wants to find demand for, and the forum threads found for each.

create table public.products (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  website     text,
  description text not null,
  user_id     uuid not null references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index products_user_id_idx on public.products (user_id);

create table public.search_results (
  id              uuid primary key default gen_random_uuid(),
  product_id      uuid not null references public.products (id) on delete cascade,
  source_site     text not null,                       -- forum id, e.g. 'reddit', 'hackernews'
  link            text not null,
  title           text,
  summary         text,
  why_relevant    text,
  posted_at       timestamptz,
  relevance_score numeric(4, 3) check (relevance_score between 0 and 1),
  created_at      timestamptz not null default now()
);

create index search_results_product_id_idx      on public.search_results (product_id);
create index search_results_source_site_idx     on public.search_results (source_site);
create index search_results_posted_at_idx       on public.search_results (posted_at desc);
create index search_results_relevance_score_idx on public.search_results (relevance_score desc);

-- Keep updated_at current on products.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

-- Row-level security: a user can only see and change their own products and
-- the results attached to them. The service role (used by the backend if it
-- writes rows) bypasses these policies.
alter table public.products enable row level security;
alter table public.search_results enable row level security;

create policy "products: owner select" on public.products
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "products: owner insert" on public.products
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "products: owner update" on public.products
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "products: owner delete" on public.products
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy "search_results: owner select" on public.search_results
  for select to authenticated
  using (exists (select 1 from public.products p where p.id = product_id and p.user_id = (select auth.uid())));
create policy "search_results: owner insert" on public.search_results
  for insert to authenticated
  with check (exists (select 1 from public.products p where p.id = product_id and p.user_id = (select auth.uid())));
create policy "search_results: owner update" on public.search_results
  for update to authenticated
  using (exists (select 1 from public.products p where p.id = product_id and p.user_id = (select auth.uid())))
  with check (exists (select 1 from public.products p where p.id = product_id and p.user_id = (select auth.uid())));
create policy "search_results: owner delete" on public.search_results
  for delete to authenticated
  using (exists (select 1 from public.products p where p.id = product_id and p.user_id = (select auth.uid())));
