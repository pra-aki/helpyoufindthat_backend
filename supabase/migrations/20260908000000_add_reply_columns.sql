-- A reusable reply per product, and a thread-specific draft per stored lead.

alter table public.products      add column general_reply  text;
alter table public.search_results add column suggested_reply text;
