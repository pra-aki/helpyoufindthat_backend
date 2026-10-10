-- Records each user's acceptance of the Terms of Service and Privacy Policy, timed by the database.
--
-- The sign-up form only creates an account once the user ticks the Terms checkbox, and it sends the
-- version they agreed to as termsVersion in the new account's metadata. That metadata alone is a
-- weak record: the user can rewrite it at any time through Supabase Auth, and the time sent beside it
-- comes from the browser's clock. So when the account is created, a trigger copies the version into
-- this table with the database's own time. Users can read their rows and never write them.

create table public.terms_acceptances (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  terms_version text not null check (char_length(terms_version) between 1 and 50),
  accepted_at   timestamptz not null default now(),
  source        text not null default 'signup' check (source in ('signup')),
  unique (user_id, terms_version)
);

comment on column public.terms_acceptances.terms_version is 'The version the user agreed to, as the sign-up form sent it (the Terms page''s Last Updated date)';
comment on column public.terms_acceptances.accepted_at   is 'Database time the acceptance was recorded, not the browser''s';
comment on column public.terms_acceptances.source        is 'Where it was accepted; only signup today, so re-accepting a new version in the app can be added later';

revoke all on table public.terms_acceptances from anon, authenticated;
grant select on table public.terms_acceptances to authenticated;
grant select, insert, update, delete on table public.terms_acceptances to service_role;

alter table public.terms_acceptances enable row level security;
create policy "terms_acceptances: owner select" on public.terms_acceptances
  for select to authenticated using ((select auth.uid()) = user_id);

-- Runs as the definer because Supabase Auth creates users with a role that has no access to public
-- tables. A failure must never block a signup, so it is caught and logged. An account created
-- without a version (an anonymous session, or one added from the dashboard) records nothing.
create function public.record_signup_terms_acceptance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version text := nullif(btrim(new.raw_user_meta_data ->> 'termsVersion'), '');
begin
  if coalesce(new.is_anonymous, false) or v_version is null then
    return new;
  end if;
  begin
    insert into public.terms_acceptances (user_id, terms_version, source)
    values (new.id, v_version, 'signup')
    on conflict (user_id, terms_version) do nothing;
  exception when others then
    raise warning 'record_signup_terms_acceptance: could not record terms % for %: %', v_version, new.id, sqlerrm;
  end;
  return new;
end;
$$;

create trigger on_auth_user_created_record_terms
  after insert on auth.users
  for each row execute function public.record_signup_terms_acceptance();

revoke execute on function public.record_signup_terms_acceptance() from public, anon, authenticated;
grant execute on function public.record_signup_terms_acceptance() to supabase_auth_admin;
