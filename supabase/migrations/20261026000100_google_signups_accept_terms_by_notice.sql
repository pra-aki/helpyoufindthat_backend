-- Let Google sign-ups through, and record the Terms that were live when they signed up.
--
-- Sign-up and sign-in pages say "By signing up or continuing with Google, you agree to our Terms of
-- Service and Privacy Policy". An email sign-up still sends the version it was shown as termsVersion,
-- and the hook still refuses one without it. A Google sign-up cannot send anything: Supabase passes
-- no data from the page through Google's sign-in. So the hook lets Google sign-ups through, and the
-- sign-up trigger records the version that was live at that moment, from terms_versions, with the
-- database's time. app_metadata.provider is set by Supabase Auth, never by the caller, so an email
-- sign-up cannot pass itself off as Google.
--
-- terms_versions holds every version with the time it went live; the latest is the current one. When
-- the Terms change, insert the new version here as well as updating the front end's TERMS_VERSION:
--
--   insert into public.terms_versions (version) values ('2027-01');

create table public.terms_versions (
  version      text primary key check (version ~ '^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$'),
  published_at timestamptz not null default now()
);

comment on table  public.terms_versions              is 'Every Terms of Service version and when it went live; the latest published_at is current';
comment on column public.terms_versions.version      is 'The front end''s TERMS_VERSION, the Terms page''s Last Updated date';
comment on column public.terms_versions.published_at is 'When this version went live; Google sign-ups after it are recorded as accepting it';

-- Read only by the sign-up trigger, which runs as its owner. Nobody else needs it.
revoke all on table public.terms_versions from anon, authenticated;
grant select, insert, update, delete on table public.terms_versions to service_role;
alter table public.terms_versions enable row level security;

-- The version live today, in effect since the Terms were published.
insert into public.terms_versions (version, published_at) values ('2026-10', '2026-10-09T00:00:00Z');

-- A Google sign-up is recorded as accepting by the notice on the page, not by a checkbox.
alter table public.terms_acceptances drop constraint terms_acceptances_source_check;
alter table public.terms_acceptances add constraint terms_acceptances_source_check check (source in ('signup', 'google_signup'));
comment on column public.terms_acceptances.source is 'signup: an email sign-up, with the version the form sent; google_signup: a Google sign-up, with the version live at the time';

create or replace function public.hook_require_terms_acceptance(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_version text := btrim(coalesce(event -> 'user' -> 'user_metadata' ->> 'termsVersion', ''));
begin
  if coalesce((event -> 'user' ->> 'is_anonymous')::boolean, false) then
    return '{}'::jsonb;
  end if;
  if event -> 'user' -> 'app_metadata' ->> 'provider' = 'google' then
    return '{}'::jsonb;
  end if;
  if v_version !~ '^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$' then
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 400,
      'message', 'Please accept the Terms of Service and Privacy Policy to create an account.'
    ));
  end if;
  return '{}'::jsonb;
end;
$$;

-- An email sign-up whose version is not the current one means the front end's TERMS_VERSION and
-- terms_versions have drifted apart. The sign-up is still recorded as sent, with a warning in the
-- Postgres logs.
create or replace function public.record_signup_terms_acceptance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version text := nullif(btrim(new.raw_user_meta_data ->> 'termsVersion'), '');
  v_current text;
  v_source  text := 'signup';
begin
  if coalesce(new.is_anonymous, false) then
    return new;
  end if;
  begin
    select version into v_current from public.terms_versions order by published_at desc limit 1;
    if v_version is null and new.raw_app_meta_data ->> 'provider' = 'google' then
      v_version := v_current;
      v_source := 'google_signup';
      if v_version is null then
        raise warning 'record_signup_terms_acceptance: no Terms version in terms_versions for Google sign-up %', new.id;
        return new;
      end if;
    elsif v_version is null then
      return new;
    elsif v_version is distinct from v_current then
      raise warning 'record_signup_terms_acceptance: sign-up % sent Terms % but terms_versions says % is current', new.id, v_version, v_current;
    end if;
    insert into public.terms_acceptances (user_id, terms_version, source, email)
    values (new.id, v_version, v_source, new.email)
    on conflict (user_id, terms_version) do nothing;
  exception when others then
    raise warning 'record_signup_terms_acceptance: could not record terms % for %: %', v_version, new.id, sqlerrm;
  end;
  return new;
end;
$$;
