# OKX Signal Pro v2 — Cloudflare Pages + Supabase migration

This folder is the isolated migration track. It is **not connected to a production host** and no Railway service is changed by these files.

## Source of truth checked before starting

- Frontend base: fix/v2-search-watchlist-cross-timeframe (the branch currently configured for the second-version Railway frontend).
- Telegram worker source: feature/per-pair-timeframe-telegram-rules (the branch configured on the Railway telegram-worker service).
- Actual Railway worker hostname: telegram-worker-production-2d09.up.railway.app. The second-version UI also has this hostname as its default. Do not use the older ...1f09... hostname.
- Worker service root: /telegram-worker; the service has a persistent Railway volume mounted at /data.
- Variable names present on Railway include TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, CONFIG_API_TOKEN, CONFIG_ALLOWED_ORIGIN, ALERT_TIMEZONE, and STATE_FILE. Secret values were not read or copied.

The current source branch contains the later async HTTP-handler correction. The most recent failed Railway deployment we could inspect was built from an earlier commit and failed at startup with SyntaxError: Unexpected reserved word on an await inside a non-async HTTP callback. The follow-up source commit made the callback async, but the deployment history does not show a currently successful live deployment. The old service has not been changed by this migration.

## Target architecture

- **Cloudflare Pages Free** serves the static v2 UI from this repository, using the migration branch as a preview first.
- **Supabase Free** stores Telegram rules and worker state, runs the Deno Edge Function, and schedules a worker tick with pg_cron + pg_net.
- Telegram delivery uses secrets held by Supabase; no bot token or chat ID is committed to GitHub.
- The first app, its GitHub Pages site, and its separate Telegram worker remain untouched.

The static frontend is already at the repository root. For the Cloudflare Pages Git integration use:
- Production branch: do not select one until the preview has passed.
- Preview branch: migration/v2-cloudflare-supabase.
- Build command: empty (no bundler is required).
- Build output directory: .

Cloudflare Pages Git integration supports automatic deployments and branch preview URLs. Free Pages limits currently include 500 builds/month, one concurrent build, 20,000 files per site, and a 25 MiB maximum individual file size.

## Worker cadence and limits

The planned worker tick is every **20 seconds**. That is about **129,600 Edge Function invocations per 30-day month**, before UI API calls. Supabase Free currently includes 500,000 Edge Function invocations/month. Supabase Cron supports schedules as frequent as one second, including a 20-second interval.

Supabase Edge Functions on Free have a 150-second wall-clock limit and a 2-second CPU-time limit per request. Network waits to OKX/Telegram are wall-clock time, but the worker must still be bounded. The implementation must:
1. use a database-backed lease so overlapping Cron calls cannot process the same state concurrently;
2. persist candle de-duplication/cooldown state before reporting a tick successful;
3. preserve the active per-pair/per-timeframe rules, VP/RSI/SMA/Volume/COMBO/CHOP modes and Telegram delivery history;
4. use a bounded concurrency/batch strategy and report any rules skipped because of a time budget;
5. return a safe busy response when a prior lease is still active.

This is a no-cost target, not an uptime guarantee. Supabase Free projects can be paused after a week with insufficient database activity. The 20-second job will create recurring activity when configured and working, but the platform says a few requests each day are usually enough rather than guaranteeing that a scheduled job exempts a project from pausing. Free hosting does not provide a production SLA.

## Database migration

Apply migrations/20261113000100_okx_v2_worker_storage.sql only after creating the Supabase project and verifying the selected project. It creates:
- a singleton JSONB runtime snapshot for lastClosed, cooldowns, recent signals, performance measurements and Telegram delivery history;
- a singleton active rules document (up to 100 pair/timeframe rules);
- RPC functions for rules updates, worker lease acquisition, state persistence and lease release.

RLS is enabled; anonymous and authenticated browser roles have no table/function access. Only the backend service role can read or write this storage.

Do not add the Cron job until the Edge Function has been deployed and tested. The Cron job will use secrets stored in Supabase Vault and call the function's authenticated /tick route.

## Secrets to configure in Supabase (never commit their values)

- TELEGRAM_BOT_TOKEN — reuse the existing bot token by entering it directly in Supabase Secrets.
- TELEGRAM_CHAT_ID — enter the existing destination chat ID directly in Supabase Secrets.
- CONFIG_API_TOKEN — a new long random key for the UI's protected save and test actions.
- WORKER_CRON_TOKEN — a separate long random key used only by the scheduled worker tick.
- ALERT_TIMEZONE — use Europe/Moscow, matching the v2 configuration.
- CONFIG_ALLOWED_ORIGINS — add the new Cloudflare Pages production/preview origins during cutover. Keep the old Railway frontend origin during the transition if still needed.
- Supabase project URL and service role key — use only in the Edge Function server environment / Vault. Never expose the service role key in browser code.

The exact Railway JSON state file and saved alert rules still need to be exported and verified before cutover. Do not infer current saved rules from old chat notes or recreate them from defaults.

## Cutover safety rules

1. Keep Railway's project, frontend service, worker service, domain and mounted volume intact as a rollback source.
2. Do not run the new Telegram tick in send mode while the old worker could also be active; duplicate sends are possible. Start with dry-run/record-only checks.
3. Import and compare all saved rules before enabling Telegram sends.
4. Check no duplicate notifications, persisted state across function invocations, all history endpoints, test Telegram, and the /health equivalent.
5. Switch the v2 UI to the Supabase Function URL only after the backend tests pass.
6. Do not remove or edit the first-version worker.
