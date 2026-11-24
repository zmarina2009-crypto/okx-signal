-- Dedicated V3 state row. V1/V2 tables and rows are intentionally untouched.
begin;

create table if not exists public.okx_v3_worker_runtime (
  id text primary key not null default 'singleton',
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint okx_v3_worker_runtime_singleton_id check (id = 'singleton'),
  constraint okx_v3_worker_runtime_state_object check (jsonb_typeof(state) = 'object')
);

alter table public.okx_v3_worker_runtime enable row level security;

-- The V3 worker uses a server-only service_role key. Public browser roles receive no access.
revoke all on table public.okx_v3_worker_runtime from public, anon, authenticated;
grant select, insert, update on table public.okx_v3_worker_runtime to service_role;

comment on table public.okx_v3_worker_runtime is
  'OKX Signal Pro V3 scalping worker state; isolated from all V1/V2 runtime tables.';

commit;
