-- Refuse any sign-up that does not accept the Terms of Service.
--
-- The sign-up form requires the Terms checkbox and sends the accepted version as termsVersion in the
-- new account's metadata. But the form only runs in the browser: the project URL and public key ship
-- with the front end, so anyone can call Supabase's sign-up directly and skip it. This function is
-- Supabase Auth's "before user created" hook, run before any account is created, so the rule holds
-- however the sign-up arrives. Returning an error object refuses the sign-up and shows the user its
-- message; returning an empty object lets it through.
--
-- Creating the function does not enable it: it is switched on in the dashboard under
-- Authentication > Hooks > Before User Created, choosing this Postgres function.
--
-- The version must look like the front end's TERMS_VERSION, a year and month (2026-10) or a full
-- date (2026-10-09), so a direct sign-up cannot pass with any string. Anonymous sessions are let
-- through, since the API refuses them anyway. Every other account needs a version, including ones
-- added from the Supabase dashboard or through a future social sign-in, which send none.

create function public.hook_require_terms_acceptance(event jsonb)
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
  if v_version !~ '^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$' then
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 400,
      'message', 'Please accept the Terms of Service and Privacy Policy to create an account.'
    ));
  end if;
  return '{}'::jsonb;
end;
$$;

grant execute on function public.hook_require_terms_acceptance(jsonb) to supabase_auth_admin;
revoke execute on function public.hook_require_terms_acceptance(jsonb) from public, anon, authenticated;
