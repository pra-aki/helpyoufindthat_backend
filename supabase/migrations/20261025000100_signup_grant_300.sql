-- New accounts start with 300 free credits instead of 100. Existing accounts keep their balances.
-- The same number is in src/services/credits.js (SIGNUP_CREDITS, shown by GET /api/credits), the
-- sign-up confirmation email, and the front end's sign-up and home pages; change them together.
create or replace function public.ensure_user_credits(p_user uuid)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_balance integer;
begin
  insert into public.user_credits (user_id, free_balance) values (p_user, 300)
  on conflict (user_id) do nothing;
  if found then
    insert into public.credit_transactions (user_id, delta, free_delta, paid_delta, balance_after, reason)
    values (p_user, 300, 300, 0, 300, 'signup_grant');
  end if;
  select balance into v_balance from public.user_credits where user_id = p_user;
  return v_balance;
end;
$$;
