-- Whether the user has replied to a lead's thread. Null means they have not;
-- a timestamp records when they marked it, so "replied" and "when" are one column.
-- Searches never write it: results.save upserts only the columns it fetches, so a
-- repeat find of the same link refreshes the score and date and leaves this alone.

alter table public.search_results add column responded_at timestamptz;

comment on column public.search_results.responded_at is 'When the user marked this lead as responded to; null when they have not';

-- Reading a product's unanswered leads is the common filter.
create index search_results_unanswered_idx on public.search_results (product_id) where responded_at is null;
