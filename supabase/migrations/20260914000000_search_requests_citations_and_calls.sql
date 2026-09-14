-- Searches now make one Perplexity call per forum, and a thread is kept only if its link
-- matches a source or citation Perplexity returned. Record both for the search log.

alter table public.search_requests
  add column citation_urls text[],
  add column calls jsonb;

comment on column public.search_requests.search_result_urls is 'Links of the sources Perplexity''s web search returned, across all forum calls';
comment on column public.search_requests.citation_urls      is 'Citation links Perplexity returned, across all forum calls';
comment on column public.search_requests.calls              is 'One entry per forum call: forum, ok, duration, source and citation counts, threads proposed and kept, fallback, usage, or the error and status';
