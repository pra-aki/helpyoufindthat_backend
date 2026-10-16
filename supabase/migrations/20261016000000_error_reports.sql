-- Problems users report from the app's Report Error action.
--
-- Only the owner reads these, directly in Supabase (the SQL editor or the table view), never
-- through the API. So no user can read or write the table, not even their own reports: the backend
-- validates and rate-limits each report, then stores it with the service key.

create table public.error_reports (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  message    text not null check (char_length(message) between 1 and 2000),
  page       text check (char_length(page) <= 500),
  error      text check (char_length(error) <= 2000),
  details    jsonb,
  user_agent text check (char_length(user_agent) <= 500),
  created_at timestamptz not null default now()
);

comment on column public.error_reports.message    is 'What the user says happened';
comment on column public.error_reports.page       is 'Where in the app it happened, as the front end sent it';
comment on column public.error_reports.error      is 'The error message the app showed, if any';
comment on column public.error_reports.details    is 'Anything else the front end attached, such as the failing request or its status';
comment on column public.error_reports.user_agent is 'The browser, from the request header';

create index error_reports_created_at_idx on public.error_reports (created_at desc);

-- No access for users at all. Row-level security is on with no policies, so even a grant added by
-- mistake later would show nothing; the service role bypasses it to store reports.
revoke all on table public.error_reports from anon, authenticated;
grant select, insert on table public.error_reports to service_role;
alter table public.error_reports enable row level security;
