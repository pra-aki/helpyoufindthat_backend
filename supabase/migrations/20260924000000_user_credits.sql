-- User credits. Every account starts with 100. A search costs one credit per 10 leads requested,
-- per forum; a scheduled job costs one credit per forum each day it runs. Buying credits comes later.
--
-- user_credits holds each balance, which can never go below zero. credit_transactions is the ledger:
-- one row per change, so any balance can be explained, and purchases will be one more reason.
--
-- Users can read their own rows and nothing else. Every change goes through the functions below,
-- which only the service role may execute; the backend calls them after verifying the user.

create table public.user_credits (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  balance    integer not null check (balance >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger user_credits_set_updated_at
  before update on public.user_credits
  for each row execute function public.set_updated_at();

create table public.credit_transactions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  delta         integer not null check (delta <> 0),
  balance_after integer not null check (balance_after >= 0),
  reason        text not null check (reason in ('signup_grant', 'search', 'job_run', 'refund')),
  details       jsonb,
  created_at    timestamptz not null default now()
);

comment on column public.credit_transactions.delta   is 'Credits added (positive) or spent (negative)';
comment on column public.credit_transactions.details is 'What the change was for: product, forums, leads requested, job, or what a refund refers to';

create index credit_transactions_user_created_idx on public.credit_transactions (user_id, created_at desc);

-- What each scheduled run cost, net of refunds.
alter table public.search_job_runs add column credits_spent integer;

-- Grants: read-only for signed-in users, nothing for anon, everything for the service role.
revoke all on table public.user_credits, public.credit_transactions from anon, authenticated;
grant select on table public.user_credits, public.credit_transactions to authenticated;
grant select, insert, update, delete on table public.user_credits, public.credit_transactions to service_role;

alter table public.user_credits enable row level security;
alter table public.credit_transactions enable row level security;

create policy "user_credits: owner select" on public.user_credits
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "credit_transactions: owner select" on public.credit_transactions
  for select to authenticated using ((select auth.uid()) = user_id);

-- Opens a user's credit account with the 100-credit signup grant if they have none yet, and
-- returns the balance. Idempotent, so it is safe to call before any read or spend.
create function public.ensure_user_credits(p_user uuid)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_balance integer;
begin
  insert into public.user_credits (user_id, balance) values (p_user, 100)
  on conflict (user_id) do nothing;
  if found then
    insert into public.credit_transactions (user_id, delta, balance_after, reason)
    values (p_user, 100, 100, 'signup_grant');
  end if;
  select balance into v_balance from public.user_credits where user_id = p_user;
  return v_balance;
end;
$$;

-- Spends credits if the balance covers them. The conditional update is a single statement, so two
-- spends at once cannot overdraw. Returns {"charged": bool, "balance": int}.
create function public.spend_credits(p_user uuid, p_amount integer, p_reason text, p_details jsonb default null)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_balance integer;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'spend_credits: amount must be positive, got %', p_amount;
  end if;
  perform public.ensure_user_credits(p_user);
  update public.user_credits set balance = balance - p_amount
   where user_id = p_user and balance >= p_amount
  returning balance into v_balance;
  if v_balance is null then
    select balance into v_balance from public.user_credits where user_id = p_user;
    return jsonb_build_object('charged', false, 'balance', v_balance);
  end if;
  insert into public.credit_transactions (user_id, delta, balance_after, reason, details)
  values (p_user, -p_amount, v_balance, p_reason, p_details);
  return jsonb_build_object('charged', true, 'balance', v_balance);
end;
$$;

-- Returns credits for a search or run that failed. Returns the new balance.
create function public.refund_credits(p_user uuid, p_amount integer, p_details jsonb default null)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_balance integer;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'refund_credits: amount must be positive, got %', p_amount;
  end if;
  update public.user_credits set balance = balance + p_amount where user_id = p_user
  returning balance into v_balance;
  if v_balance is null then
    raise exception 'refund_credits: no credit account for %', p_user;
  end if;
  insert into public.credit_transactions (user_id, delta, balance_after, reason, details)
  values (p_user, p_amount, v_balance, 'refund', p_details);
  return v_balance;
end;
$$;

-- Grants the signup credits when an account is created. It runs as the definer because Supabase
-- Auth inserts users with a role that has no access to public tables. A failure here must never
-- block a signup, so it is caught and logged; the first spend or balance read grants them instead.
-- Anonymous sessions get nothing, since the API refuses them anyway.
create function public.grant_signup_credits()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(new.is_anonymous, false) then
    return new;
  end if;
  begin
    perform public.ensure_user_credits(new.id);
  exception when others then
    raise warning 'grant_signup_credits: could not open a credit account for %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

create trigger on_auth_user_created_grant_credits
  after insert on auth.users
  for each row execute function public.grant_signup_credits();

-- Only the service role may change credits. Functions are executable by everyone by default, and
-- Supabase also grants them to anon and authenticated, so all of that is revoked.
revoke execute on function
  public.ensure_user_credits(uuid),
  public.spend_credits(uuid, integer, text, jsonb),
  public.refund_credits(uuid, integer, jsonb),
  public.grant_signup_credits()
  from public, anon, authenticated;
grant execute on function
  public.ensure_user_credits(uuid),
  public.spend_credits(uuid, integer, text, jsonb),
  public.refund_credits(uuid, integer, jsonb)
  to service_role;
grant execute on function public.grant_signup_credits() to supabase_auth_admin;

-- Existing accounts get the same 100 credits, or they could not search at all.
select public.ensure_user_credits(id) from auth.users where not coalesce(is_anonymous, false);
