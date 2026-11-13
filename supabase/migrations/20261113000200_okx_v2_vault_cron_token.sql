-- Keep the bootstrap authorization token encrypted in Supabase Vault.
-- The Edge Function reads it only through a service_role-only SQL function.
select vault.create_secret(
  replace(gen_random_uuid()::text || gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  'okx_v2_worker_cron_token',
  'Private token for the one-time OKX worker runtime bootstrap endpoint'
);

create or replace function public.get_okx_v2_worker_cron_token()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select ds.decrypted_secret
  from vault.decrypted_secrets as ds
  where ds.name = 'okx_v2_worker_cron_token'
  order by ds.created_at desc
  limit 1;
$$;

revoke all on function public.get_okx_v2_worker_cron_token() from public, anon, authenticated;
grant execute on function public.get_okx_v2_worker_cron_token() to service_role;

comment on function public.get_okx_v2_worker_cron_token() is
  'Returns the private OKX worker bootstrap token to service_role only; secret value is stored encrypted in Supabase Vault.';
