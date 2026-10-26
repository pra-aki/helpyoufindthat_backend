-- Posts someone asked us to remove (Privacy Policy, Section 8: "If you wrote a post our users found").
--
-- Deleting a removed post's rows is not enough on its own: the next search or job run could find the
-- post again and store it. Searches check this list before saving and skip any thread whose canonical
-- key is on it, so a removal sticks. The key is the backend's canonicalKey() of the link (for example
-- reddit:abc123), identical for every way of writing the link to the same post.
--
-- Only the key and the date are kept: no URL, no name, no email. That is the least needed to honour
-- the request. Only the backend's service role reads or writes it; users cannot see it.
-- scripts/remove-thread.mjs adds to it and deletes the post's existing rows.

create table public.removed_threads (
  canonical_key text primary key,
  removed_at    timestamptz not null default now()
);

comment on table public.removed_threads is 'Posts removed on request; searches never store a thread whose canonical key is listed here';
comment on column public.removed_threads.canonical_key is 'canonicalKey() of the post link, e.g. reddit:abc123';

revoke all on table public.removed_threads from anon, authenticated, service_role;
grant select, insert, update on table public.removed_threads to service_role;

-- No policies: nobody but the service role (which bypasses row-level security) can touch it.
alter table public.removed_threads enable row level security;
