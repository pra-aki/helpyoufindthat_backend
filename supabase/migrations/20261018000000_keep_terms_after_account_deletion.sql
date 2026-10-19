-- Keep Terms of Service acceptances after an account is deleted.
--
-- Deleting an account removes everything the user owned, because every table cascades from
-- auth.users. Terms acceptances are the exception: they are the record that the user agreed to the
-- Terms, which the owner keeps after the account is gone. So the table no longer references
-- auth.users at all, and each row keeps the email the account had when it accepted, since a bare
-- user id points at nothing once the account is deleted. account_deleted_at marks the rows whose
-- account no longer exists.

alter table public.terms_acceptances drop constraint terms_acceptances_user_id_fkey;
alter table public.terms_acceptances add column email text check (char_length(email) <= 320);
alter table public.terms_acceptances add column account_deleted_at timestamptz;

comment on column public.terms_acceptances.user_id            is 'The account that accepted; kept after the account is deleted, so it may no longer exist';
comment on column public.terms_acceptances.email              is 'The account''s email when it accepted';
comment on column public.terms_acceptances.account_deleted_at is 'When the account was deleted; null while it exists';

update public.terms_acceptances t set email = u.email
from auth.users u where u.id = t.user_id and t.email is null;

-- The sign-up trigger now records the email too.
create or replace function public.record_signup_terms_acceptance()
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
    insert into public.terms_acceptances (user_id, terms_version, source, email)
    values (new.id, v_version, 'signup', new.email)
    on conflict (user_id, terms_version) do nothing;
  exception when others then
    raise warning 'record_signup_terms_acceptance: could not record terms % for %: %', v_version, new.id, sqlerrm;
  end;
  return new;
end;
$$;

-- Marks a deleted account's acceptances. A trigger rather than backend code, so an account deleted
-- from the Supabase dashboard is marked too. It must never block a deletion, so failures are logged.
create function public.mark_terms_on_account_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    update public.terms_acceptances set account_deleted_at = now()
    where user_id = old.id and account_deleted_at is null;
  exception when others then
    raise warning 'mark_terms_on_account_delete: could not mark terms for %: %', old.id, sqlerrm;
  end;
  return old;
end;
$$;

create trigger on_auth_user_deleted_mark_terms
  before delete on auth.users
  for each row execute function public.mark_terms_on_account_delete();

revoke execute on function public.mark_terms_on_account_delete() from public, anon, authenticated;
grant execute on function public.mark_terms_on_account_delete() to supabase_auth_admin;
