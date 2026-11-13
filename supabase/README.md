# OKX Signal Pro v2 — Cloudflare Pages + Supabase migration

This folder is the isolated migration track. It is **not connected to a production host** and no Railway service is changed by these files.

## Source of truth checked before starting

- Frontend base: fix/v2-search-watchlist-cross-timeframe (the branch currently configured for the second-version Railway frontend).
- Telegram worker source: feature/per-pair-timeframe-telegram-rules (the branch configured on the Railway telegram-worker service).
- Actual Railway worker hostname: telegram-worker-production-2d09.up.railway.app. The second-version UI also has this hostname as its default. Do not use the older ...1f09... hostname.
- Worker service root: /telegram-worker; the service has a persistent Railway volume mounted at /data.
- Variable names present on Railway include TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, CONFIG_API_TOKEN, CONFIG_ALLOWED_ORIGIN, ALERT_TIMEZONE, and STATE_FILE. Secret values were not read or copied.

The current source branch contains the later async HTTP-handler correction. The most recent failed Railway deployment we could inspect was built from an earlier commit and failed at startup with SyntaxError: Unexpected reserved word on an await inside a non-async HTTP callback. The follow-up source commit made the callback async, but the deployment history does not show a currently successful live deployment. The old service has not been changed by this migration.


## Migration checkpoint — 2026-11-13

The Supabase destination is active at project ref `okyrkdkzshycubadfvba` in `eu-central-1`. The database schema and RPC functions are installed. The following Railway data has been imported and verified in the singleton rows:

- **2 active pair/timeframe rules** from the worker's read-only `/config` endpoint.
- **6 Telegram history records** from `/telegram-history?limit=500` (5 combo alerts and 1 test record).
- **A 90-day aggregate statistics snapshot** from `/stats?days=90`: 2,500 signals, 14 groups, 14 pending 12-hour outcomes. This is an aggregate snapshot, not the individual performance records.

The destination runtime currently has empty `lastClosed`, `lastAlertAt`, `lastSmaTouch`, `recentSignals`, and `performanceSignals` collections. The imported statistics are kept separately as `statsSnapshot`; they cannot be expanded back into the individual 2,500 signal records.

The Railway `state.json` file has **not** been downloaded: Railway's volume SFTP connection closed during the export attempt. The running worker previously reported a state file of 1,580,807 bytes. No credentials were read or copied into GitHub.

At the last live check on 2026-11-13, Railway's `telegram-worker` deployment `1b37df29-45a4-48b1-b33c-180a9c11d996` was `SUCCESS`, the service was `Online` with one running replica, and there were no active warnings or recent failures in the inspected 24-hour window. **Do not stop or redeploy it as part of this migration.** There is a configuration/log discrepancy to resolve separately: Railway's service description reports a maintenance-only start command, while that deployment's runtime logs showed `npm start` / `node index.js`.

The initial storage migration has been applied to the Supabase project. The `okx-telegram-worker` Edge Function is deployed as **ACTIVE, version 4**.

Verified through live HTTP requests:
- `GET /health`, `GET /config`, `GET /telegram-history?limit=500`, and `GET /stats?days=90` returned HTTP 200.
- The function reads 2 active rules, all 6 imported Telegram history entries, and the 2,500-signal / 14-group aggregate statistics snapshot. Its CORS allowlist accepts the second-version Railway frontend and rejects the first-version GitHub Pages origin (HTTP 403), keeping the two app versions separate.
- `POST /bootstrap` is token-protected; a request without the Vault token returned HTTP 401.
- `POST /tick` accepts only `{"mode":"dry_run"}`. A request with `{"mode":"live"}` returned HTTP 400, and a dry-run request without the Vault token returned HTTP 401.

The one-time bootstrap completed successfully on 2026-11-13. It initialized `lastClosed` from confirmed OKX candles. A later authenticated dry-run successfully processed both active rules and advanced the cursors:
- `SOL-USDT-SWAP:15m` → `1794599100000`
- `ZEC-USDT-SWAP:1m` → `1794600420000`

The dry-run recorded two raw performance signals for the ZEC candle: `VP LONG` and `SMA SHORT`. Since their directions conflict, no COMBO was produced. The response was HTTP 200 with no processing errors and zero Telegram previews. The imported 2,500-signal aggregate snapshot and 6 historical Telegram entries remained intact. No Telegram message was sent.

The dry-run engine reuses the worker's existing `statistics.js`, `volume-profile.js`, `combo-reversal.js`, and `telegram-history.js` modules. It stores raw signals generated from this point forward separately as `performanceSignals`; historical raw performance records and the original cooldown/SMA-touch runtime data were not exported and cannot be recreated from the aggregate statistics. Dry-run cooldowns are stored separately from real Telegram cooldowns.

The bootstrap token is a randomly generated 96-character value encrypted in Supabase Vault under `okx_v2_worker_cron_token`. A restricted SQL function exposes it only to `service_role`; the token was not output to chat or committed to GitHub.

**Do not create a Cron schedule yet.** The current `/tick` route is dry-run only. Telegram delivery logic, send-mode cooldown handling, and the production cutover procedure still need to be ported and verified. Keep Railway online and unchanged until the full backend is ready and a deliberate cutover is approved.
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
