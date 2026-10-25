-- Track free and paid credits separately.
--
-- Until now every credit was free (the 100 granted at sign-up), so one balance was enough. Paid
-- credits will behave differently: they are money a user may expect back, so an account holding
-- any cannot be deleted from the app. So each account now has a free and a paid balance, and the
-- total is computed from them.
--
-- Free credits are spent first, so paid ones last longer. Free credits do not expire. Every
-- ledger row records how much of its change was free and how much paid, and a refund returns
-- credits to the balances they came from, paid first.

-- Balances: existing credits are all free.
alter table public.user_credits
  add column free_balance integer not null default 0 check (free_balance >= 0),
  add column paid_balance integer not null default 0 check (paid_balance >= 0);
update public.user_credits set free_balance = balance;
alter table public.user_credits drop column balance;
alter table public.user_credits add column balance integer generated always as (free_balance + paid_balance) stored;

comment on column public.user_credits.free_balance is 'Credits given away, such as the sign-up grant; spent first; never expire';
comment on column public.user_credits.paid_balance is 'Credits the user paid for; spent after free ones';
comment on column public.user_credits.balance      is 'free_balance + paid_balance';

-- Ledger: existing rows were all free.
alter table public.credit_transactions
  add column free_delta integer not null default 0,
  add column paid_delta integer not null default 0;
update public.credit_transactions set free_delta = delta;
alter table public.credit_transactions add constraint credit_transactions_split_adds_up check (free_delta + paid_delta = delta);
alter table public.credit_transactions drop constraint credit_transactions_reason_check;
alter table public.credit_transactions add constraint credit_transactions_reason_check
  check (reason in ('signup_grant', 'search', 'job_run', 'refund', 'purchase', 'admin_grant'));

comment on column public.credit_transactions.free_delta is 'The part of delta in free credits';
comment on column public.credit_transactions.paid_delta is 'The part of delta in paid credits';

-- Opens a credit account with the 100 free sign-up credits if there is none, and returns the total.
create or replace function public.ensure_user_credits(p_user uuid)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_balance integer;
begin
  insert into public.user_credits (user_id, free_balance) values (p_user, 100)
  on conflict (user_id) do nothing;
  if found then
    insert into public.credit_transactions (user_id, delta, free_delta, paid_delta, balance_after, reason)
    values (p_user, 100, 100, 0, 100, 'signup_grant');
  end if;
  select balance into v_balance from public.user_credits where user_id = p_user;
  return v_balance;
end;
$$;

-- The account's balances, opening it if needed: {"balance", "free", "paid"}.
create function public.credit_balances(p_user uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_free integer;
  v_paid integer;
begin
  perform public.ensure_user_credits(p_user);
  select free_balance, paid_balance into v_free, v_paid from public.user_credits where user_id = p_user;
  return jsonb_build_object('balance', v_free + v_paid, 'free', v_free, 'paid', v_paid);
end;
$$;

-- Spends credits, free ones first, if the total covers them. The row is locked for the spend, so
-- two spends at once cannot overdraw. Returns {"charged", "balance", "free", "paid", "freeSpent",
-- "paidSpent"}, so a refund can return credits to where they came from.
create or replace function public.spend_credits(p_user uuid, p_amount integer, p_reason text, p_details jsonb default null)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_free integer;
  v_paid integer;
  v_take_free integer;
  v_take_paid integer;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'spend_credits: amount must be positive, got %', p_amount;
  end if;
  perform public.ensure_user_credits(p_user);
  select free_balance, paid_balance into v_free, v_paid from public.user_credits where user_id = p_user for update;
  if v_free + v_paid < p_amount then
    return jsonb_build_object('charged', false, 'balance', v_free + v_paid, 'free', v_free, 'paid', v_paid);
  end if;
  v_take_free := least(v_free, p_amount);
  v_take_paid := p_amount - v_take_free;
  update public.user_credits
     set free_balance = free_balance - v_take_free, paid_balance = paid_balance - v_take_paid
   where user_id = p_user
  returning free_balance, paid_balance into v_free, v_paid;
  insert into public.credit_transactions (user_id, delta, free_delta, paid_delta, balance_after, reason, details)
  values (p_user, -p_amount, -v_take_free, -v_take_paid, v_free + v_paid, p_reason, p_details);
  return jsonb_build_object('charged', true, 'balance', v_free + v_paid, 'free', v_free, 'paid', v_paid,
                            'freeSpent', v_take_free, 'paidSpent', v_take_paid);
end;
$$;

-- Returns credits for a search or run that failed, to the balances they were spent from; the
-- backend says how many of each. Returns {"balance", "free", "paid"}.
drop function public.refund_credits(uuid, integer, jsonb);
create function public.refund_credits(p_user uuid, p_free integer, p_paid integer, p_details jsonb default null)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_free integer;
  v_paid integer;
begin
  if p_free is null or p_paid is null or p_free < 0 or p_paid < 0 or p_free + p_paid = 0 then
    raise exception 'refund_credits: give a positive amount, got % free and % paid', p_free, p_paid;
  end if;
  update public.user_credits
     set free_balance = free_balance + p_free, paid_balance = paid_balance + p_paid
   where user_id = p_user
  returning free_balance, paid_balance into v_free, v_paid;
  if v_free is null then
    raise exception 'refund_credits: no credit account for %', p_user;
  end if;
  insert into public.credit_transactions (user_id, delta, free_delta, paid_delta, balance_after, reason, details)
  values (p_user, p_free + p_paid, p_free, p_paid, v_free + v_paid, 'refund', p_details);
  return jsonb_build_object('balance', v_free + v_paid, 'free', v_free, 'paid', v_paid);
end;
$$;

-- Adds credits to an account: a purchase (always paid) or a manual grant (free or paid). Called by
-- the backend only, for now by hand; the purchase flow will call it later.
create function public.add_credits(p_user uuid, p_amount integer, p_kind text, p_reason text, p_details jsonb default null)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_free integer;
  v_paid integer;
  v_add_free integer := case when p_kind = 'free' then p_amount else 0 end;
  v_add_paid integer := case when p_kind = 'paid' then p_amount else 0 end;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'add_credits: amount must be positive, got %', p_amount;
  end if;
  if p_kind is null or p_kind not in ('free', 'paid') then
    raise exception 'add_credits: kind must be free or paid, got %', p_kind;
  end if;
  if p_reason is null or p_reason not in ('purchase', 'admin_grant') then
    raise exception 'add_credits: reason must be purchase or admin_grant, got %', p_reason;
  end if;
  if p_reason = 'purchase' and p_kind <> 'paid' then
    raise exception 'add_credits: a purchase adds paid credits';
  end if;
  perform public.ensure_user_credits(p_user);
  update public.user_credits
     set free_balance = free_balance + v_add_free, paid_balance = paid_balance + v_add_paid
   where user_id = p_user
  returning free_balance, paid_balance into v_free, v_paid;
  insert into public.credit_transactions (user_id, delta, free_delta, paid_delta, balance_after, reason, details)
  values (p_user, p_amount, v_add_free, v_add_paid, v_free + v_paid, p_reason, p_details);
  return jsonb_build_object('balance', v_free + v_paid, 'free', v_free, 'paid', v_paid);
end;
$$;

-- Only the service role may change or open credit accounts.
revoke execute on function
  public.credit_balances(uuid),
  public.refund_credits(uuid, integer, integer, jsonb),
  public.add_credits(uuid, integer, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function
  public.credit_balances(uuid),
  public.refund_credits(uuid, integer, integer, jsonb),
  public.add_credits(uuid, integer, text, text, jsonb)
  to service_role;
