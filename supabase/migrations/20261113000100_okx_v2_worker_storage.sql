-- OKX Signal Pro v2: durable state and rules for the Cloudflare Pages + Supabase migration.
-- This migration creates storage only. It does NOT schedule the worker or change Railway.

create table if not exists public.okx_v2_worker_runtime (
  id text primary key check (id = 'singleton'),
  state jsonb not null default jsonb_build_object(
    'lastClosed', '{}'::jsonb,
    'lastAlertAt', '{}'::jsonb,
    'lastSmaTouch', '{}'::jsonb,
    'recentSignals', '[]'::jsonb,
    'performanceSignals', '[]'::jsonb,
    'telegramHistory', '[]'::jsonb
  ),
  lease_token uuid,
  lease_until timestamptz,
  last_tick_at timestamptz,
  last_tick_status text,
  last_tick_error text,
  updated_at timestamptz not null default now()
);

insert into public.okx_v2_worker_runtime (id)
values ('singleton')
on conflict (id) do nothing;

create table if not exists public.okx_v2_alert_rules (
  id text primary key check (id = 'singleton'),
  rules jsonb not null default '[]'::jsonb check (jsonb_typeof(rules) = 'array'),
  revision bigint not null default 1,
  updated_at timestamptz not null default now()
);

insert into public.okx_v2_alert_rules (id)
values ('singleton')
on conflict (id) do nothing;

-- Atomic update: the config endpoint must not acknowledge a rule change until it is stored.
create or replace function public.save_okx_v2_alert_rules(p_rules jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  new_revision bigint;
begin
  if jsonb_typeof(p_rules) <> 'array' then
    raise exception 'rules must be a JSON array';
  end if;
  if jsonb_array_length(p_rules) < 1 or jsonb_array_length(p_rules) > 100 then
    raise exception 'rules must contain between 1 and 100 items';
  end if;

  update public.okx_v2_alert_rules
     set rules = p_rules,
         revision = revision + 1,
         updated_at = clock_timestamp()
   where id = 'singleton'
   returning revision into new_revision;

  return new_revision;
end;
$$;

-- A lease prevents overlapping 20-second Cron invocations from processing the
-- same candle / sending duplicate Telegram alerts.
create or replace function public.claim_okx_v2_worker_tick(
  p_lease_token uuid,
  p_lease_seconds integer default 180
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  update public.okx_v2_worker_runtime
     set lease_token = p_lease_token,
         lease_until = clock_timestamp()
           + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 180), 180))),
         updated_at = clock_timestamp()
   where id = 'singleton'
     and (
       lease_token is null
       or lease_until is null
       or lease_until <= clock_timestamp()
     );

  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

-- Save only while holding the lease; stale/overlapping invocations cannot overwrite
-- a newer worker state after their lease expires.
create or replace function public.save_okx_v2_worker_state(
  p_lease_token uuid,
  p_state jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  if jsonb_typeof(p_state) <> 'object' then
    raise exception 'worker state must be a JSON object';
  end if;

  update public.okx_v2_worker_runtime
     set state = p_state,
         updated_at = clock_timestamp()
   where id = 'singleton'
     and lease_token = p_lease_token
     and lease_until > clock_timestamp();

  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

create or replace function public.release_okx_v2_worker_tick(
  p_lease_token uuid,
  p_status text default 'ok',
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  update public.okx_v2_worker_runtime
     set lease_token = null,
         lease_until = null,
         last_tick_at = clock_timestamp(),
         last_tick_status = case when p_status in ('ok', 'failed', 'busy') then p_status else 'failed' end,
         last_tick_error = case when p_error is null then null else left(p_error, 1000) end,
         updated_at = clock_timestamp()
   where id = 'singleton'
     and lease_token = p_lease_token;

  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

alter table public.okx_v2_worker_runtime enable row level security;
alter table public.okx_v2_alert_rules enable row level security;

revoke all on table public.okx_v2_worker_runtime from anon, authenticated;
revoke all on table public.okx_v2_alert_rules from anon, authenticated;
grant all on table public.okx_v2_worker_runtime to service_role;
grant all on table public.okx_v2_alert_rules to service_role;

revoke all on function public.save_okx_v2_alert_rules(jsonb) from public, anon, authenticated;
revoke all on function public.claim_okx_v2_worker_tick(uuid, integer) from public, anon, authenticated;
revoke all on function public.save_okx_v2_worker_state(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.release_okx_v2_worker_tick(uuid, text, text) from public, anon, authenticated;

grant execute on function public.save_okx_v2_alert_rules(jsonb) to service_role;
grant execute on function public.claim_okx_v2_worker_tick(uuid, integer) to service_role;
grant execute on function public.save_okx_v2_worker_state(uuid, jsonb) to service_role;
grant execute on function public.release_okx_v2_worker_tick(uuid, text, text) to service_role;

comment on table public.okx_v2_worker_runtime is
  'Singleton JSONB runtime snapshot preserving OKX worker dedupe, cooldown, recent signal, performance, and Telegram history state.';
comment on table public.okx_v2_alert_rules is
  'Singleton active pair/timeframe rules used by OKX Signal Pro v2 Telegram worker.';
