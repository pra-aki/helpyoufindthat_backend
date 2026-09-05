-- A thread is stored once per product. Re-running a search upserts on this key,
-- refreshing search_date and the score instead of adding a duplicate row.

create unique index search_results_product_link_key
  on public.search_results (product_id, link);
