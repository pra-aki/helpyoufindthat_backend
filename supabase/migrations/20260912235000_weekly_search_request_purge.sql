-- Run the 30-day purge of search_requests weekly (Sundays 03:17 UTC) instead of daily.
-- A row can now remain for up to about 37 days before it is removed.
select cron.schedule(
  'purge-search-requests-older-than-30-days',
  '17 3 * * 0',
  $$delete from public.search_requests where created_at < now() - interval '30 days'$$
);
