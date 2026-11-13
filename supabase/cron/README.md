# Supabase Cron setup — run only after the Edge Function is deployed and tested.

> **Hold — not ready to schedule:** as of 2026-11-13 the deployed `okx-telegram-worker` function only supports read-only routes and a protected one-time `/bootstrap`. The recurring `/tick` route and Telegram delivery logic are not implemented. Do not create this Cron job until the full worker has been implemented, tested in dry-run, and explicitly approved for cutover.

This is intentionally not part of the initial database migration. Do not create a schedule until:
1. Supabase project exists and the SQL migration has been applied.
2. The okx-telegram-worker Edge Function is deployed.
3. A manual authenticated /health and dry-run /tick both succeed.
4. Secrets below are stored in Supabase Vault (never in GitHub).

Store these Vault secrets using the Supabase SQL editor, replacing every placeholder first:
- okx_v2_project_url: https://<PROJECT_REF>.supabase.co
- okx_v2_publishable_key: the project's publishable/anon API key (not the service-role key)
- okx_v2_worker_cron_token: the separate WORKER_CRON_TOKEN value

Example:
  select vault.create_secret('https://<PROJECT_REF>.supabase.co', 'okx_v2_project_url');
  select vault.create_secret('<PUBLISHABLE_KEY>', 'okx_v2_publishable_key');
  select vault.create_secret('<WORKER_CRON_TOKEN>', 'okx_v2_worker_cron_token');

After verifying the three Vault secrets, schedule one worker invocation every 20 seconds:
  
  select cron.schedule(
    'okx-v2-telegram-worker-20s',
    '20 seconds',
    $$
    select net.http_post(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'okx_v2_project_url'
      ) || '/functions/v1/okx-telegram-worker/tick',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'okx_v2_publishable_key'
        ),
        'x-worker-cron-token', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'okx_v2_worker_cron_token'
        )
      ),
      body := jsonb_build_object('triggered_at', now()),
      timeout_milliseconds := 10000
    ) as request_id;
    $$
  );

Monitor runs in the Supabase Dashboard under Integrations -> Cron and in cron.job_run_details. To stop the schedule:
  select cron.unschedule('okx-v2-telegram-worker-20s');

The Edge Function must validate x-worker-cron-token with a constant-time comparison and acquire the database lease before processing. A public publishable key is not an authorization boundary; the worker cron token is.
