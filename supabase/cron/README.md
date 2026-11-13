# Supabase Cron setup — run only after the Edge Function is deployed and tested.

> **Hold — not ready to schedule:** as of 2026-11-13 the deployed `okx-telegram-worker` function has read-only routes, a protected one-time `/bootstrap`, and a protected `/tick` that accepts **only** `mode=dry_run`. A manual dry-run was verified successfully, but it does not send Telegram messages. Live Telegram delivery and the production cutover procedure are not implemented. Do not create a recurring Cron schedule until live delivery is implemented, dry-run and safety checks pass, and the Railway-to-Supabase cutover is explicitly approved.

This is intentionally not part of the initial database migration. Do not create a schedule until:
1. Supabase project exists and the SQL migration has been applied.
2. The okx-telegram-worker Edge Function is deployed.
3. A manual authenticated /health and dry-run /tick both succeed.
4. Secrets below are stored in Supabase Vault (never in GitHub).

The bootstrap token `okx_v2_worker_cron_token` has already been generated and stored encrypted in Vault. Do not create a second token with the same name.

When the future `/tick` implementation is complete and ready for scheduling, store only the remaining values in Vault, replacing placeholders:
- okx_v2_project_url: https://<PROJECT_REF>.supabase.co
- okx_v2_publishable_key: the project's publishable/anon API key (not a secret/service-role key)

Example:
  select vault.create_secret('https://<PROJECT_REF>.supabase.co', 'okx_v2_project_url');
  select vault.create_secret('<PUBLISHABLE_KEY>', 'okx_v2_publishable_key');

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
