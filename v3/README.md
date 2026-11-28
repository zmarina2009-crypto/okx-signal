# OKX Signal Pro v3 — scalping-first foundation

## Purpose

Build v3 as a separate application line while keeping v1 and v2 intact. The first delivery is server-side scalping with scheduled Push and Telegram notifications. Auto-trading is explicitly out of scope for this phase.

## Cost constraint

- Do not create a new Railway project or service for the first MVP.
- Keep the v3 static interface separate from v1, for example under `/v3/` on the existing GitHub Pages site.
- Do not create a third Railway project or service for the MVP.
- Prefer an existing paused worker resource only after checking what APIs and app features depend on it; do not replace the live v2 worker without a dependency audit.
- Reuse a persistent `/data` volume only with a v3-specific state filename; never overwrite v1/v2 state.
- Reuse existing Telegram credentials only through Railway variables; never copy secret values into Git.
- Do not create a new database or pay for a notification provider for the MVP; use the existing free Supabase project only through a dedicated V3 table.
- Prefer a dedicated Supabase Secret key in the Railway server-only variable `SUPABASE_SECRET_KEY`. Never place it in Git, the browser, HTML, or JavaScript. The legacy `SUPABASE_SERVICE_ROLE_KEY` is supported temporarily while Supabase phases out legacy keys at the end of 2026.
- The existing free Supabase plan can pause projects after a period of low activity; it is suitable for a cost-conscious MVP/QA path, not a guaranteed always-on production database.
- Measure the additional runtime usage before enabling continuous monitoring; reusing a service avoids a new service, but does not make active compute free.

## Implementation status (2026-11-24)

- Server-side Volume + RSI / BOS engine and OKX public candle adapter are implemented.
- Notification schedule supports weekdays, multiple windows, and IANA time zones.
- Telegram and Web Push server adapters are implemented; Push requires VAPID public/private keys and an explicit valid `VAPID_SUBJECT`.
- A persistent notification outbox retries failed destinations with a bounded number of attempts, skips destinations already confirmed, and expires stale signals after 90 seconds or when the active time window ends.
- Runtime state can be stored either in the isolated JSON file (`V3_STATE_BACKEND=file`, local tests/volume) or in the existing Supabase project using the dedicated `public.okx_v3_worker_runtime` row (`V3_STATE_BACKEND=supabase`). The Supabase adapter uses the REST Data API with `SUPABASE_SECRET_KEY` (preferred) or the legacy `SUPABASE_SERVICE_ROLE_KEY`; modern `sb_secret_...` keys are sent only in the `apikey` header, while legacy JWT keys also use `Authorization: Bearer`. Database errors fail startup/load rather than silently resetting the journal.
- The V3-only Supabase migration was applied to the existing Free project on 2026-11-24. The new table is empty, has RLS enabled, grants no access to `anon` or `authenticated`, and allows only the server-side `service_role`/secret-key path to perform the required operations.
- CI currently validates deterministic engine, schedule, market-data, persistence, delivery, and outbox behavior. The current PR remains draft and is not merged or deployed.
- The v3 settings page under `v3/` supports connecting to the worker with an HTTPS URL and API token, editing pair/timeframe targets, independent target switches, and the global monitor switch.
- The page also exposes the supported scalping parameters (Volume + RSI, BOS, LONG/SHORT, RSI grouping, cooldown), IANA timezone, weekdays, up to 10 notification windows, and independent Push/Telegram channel toggles.
- The signal journal UI reads `/history`, shows the latest 100 signals, filters by delivery status, displays per-channel outcomes, and can be refreshed manually.
- A v3-scoped service worker (`v3/sw.js`) displays Push notifications and opens the v3 page when clicked. An installable web-app manifest, SVG app icon, and PNG Apple Home Screen icon are included.
- The service worker is prepared without asking notification permission. Permission and subscription are requested only from the explicit per-device button; the subscription is saved through the authenticated `/push-subscriptions` endpoint. Unsubscribing removes only the current browser/device endpoint from the server and browser.
- Safe `/health` fields show whether complete VAPID configuration (including `VAPID_SUBJECT`) is present and how many device subscriptions are registered. The API token remains only in current page memory, never browser storage.
- Each computer/phone browser must be registered separately. On iPhone/iPad, add the web app to the Home Screen and open it from its icon before enabling Push. The page and service worker remain in the draft PR and are not published; Push cannot work until the worker is deployed and VAPID variables are configured.

## Initial architecture

1. **Market data adapter**
   - OKX public market candles only; no trading credentials and no order placement.
   - Normalize instruments and supported timeframes.
   - Handle rate limits, timeouts, incomplete candles, retries, and per-symbol failures independently.

2. **Scalping engine**
   - Each `pair + timeframe` target has its own `enabled` switch. Legacy targets default to enabled; disabled targets remain saved but are skipped by the poller. Re-enabling a target retains its per-target processed-candle/cooldown state.
   - The v3 page provides a target manager for adding/removing pairs and timeframes, toggling individual targets, and enabling/disabling the overall monitor.
   - Port the first-version `scalping-trigger.js` rules into a server-side, testable module.
   - Preserve Volume + RSI logic, optional BOS confirmation/alerts, LONG/SHORT switches, per-pair/timeframe cooldowns, and RSI situation grouping.
   - Keep signal evaluation deterministic and independent from HTTP, storage, and notification delivery.
   - Add fixture tests to check parity with known first-version candles before enabling live notifications.
   - Do not substitute the second-version Volume/RSI/SMA/VP COMBO rules for the first-version scalping rules.

3. **Schedule and notification policy**
   - Store timezone, weekdays, and multiple daily time windows as editable settings.
   - Monitor and journal signals continuously in the initial design; send user notifications only inside enabled windows.
   - Do not send delayed catch-up notifications for signals detected outside a notification window.
   - Apply the same schedule policy to Push and Telegram, while allowing each channel to be switched independently.

4. **Notification channels**
   - Telegram: reuse the existing bot/chat configuration from Railway if suitable.
   - Web Push: use the browser Push API and a v3-scoped service worker; send through standard Web Push/VAPID from the existing worker.
   - Store Push subscriptions and delivery outcomes in persistent state. A browser/OS may still suppress notifications according to its own settings.

5. **Persistence**
   - The existing v1 and v2 Railway volumes are already attached to their workers and must not be detached, shared, or reused for V3.
   - The user approved repurposing the idle `okx-signal-drawings-test` Railway service for V3. Its V3 branch, `/v3/server` root, `npm start`, and `/health` check are staged in Railway but not committed or deployed; the service remains sleeping and has no volume.
   - Use the existing free Supabase project for V3 only through the separate `public.okx_v3_worker_runtime` table. This avoids adding a paid DB or a new Railway volume, but the free project may pause after prolonged low activity.
   - Keep config, processed candle timestamps, cooldowns, signal journal, Push subscriptions, and delivery status in the single V3 JSONB snapshot. Never read or write the V2 singleton tables from V3.
   - The existing file store remains available for local tests or a separately provisioned V3-only volume; it serializes writes and uses unique temporary filenames for atomic replacement.

## Existing infrastructure audit (2026-11-24)

- Railway workspace currently has two projects: `natural-integrity` and `OKX Signal Telegram Alerts`.
- The v1 worker in `OKX Signal Telegram Alerts` is now `Sleeping` with the `telegram-paused-v1` start command. Its mounted `/data` volume is retained; the v1 app front end is not changed.
- The v2 worker in `natural-integrity` remains `Online` so its existing runtime API and monitoring are not removed. A Railway variable `TELEGRAM_NOTIFICATIONS_ENABLED=false` and a code guard were added on its existing feature branch; the new deployment completed successfully on 2026-11-24. Telegram delivery is paused while the v2 worker remains available.
- The v2 worker keeps its mounted `/data` volume and its existing per-pair/timeframe rules, Volume Profile, COMBO, CHOP, runtime config API, statistics, and delivery history. No Telegram credential values were read or changed.
- Previous v2 logs showed state-file rename errors. The v3 state store instead serializes writes and uses a unique temporary filename, with concurrent-write regression tests. This is a v3-specific fix; v2 persistence has not been rewritten.
- No new Railway project, service, volume, or database was created. The v1 and v2 front ends, charts, and Live features remain unchanged.
- Read-only audit found `okx-signal-drawings-test` had no HTTP requests and zero reported CPU/memory usage during the last 7 days. Its V3 settings are staged but not live; the service remains sleeping. The v1/v2 volumes remain attached to their current workers.
- The existing Supabase project `okx-signal-pro-v2` is on the Free plan and now contains the two existing V2 application tables plus the isolated V3 table. Verification confirmed the V3 table is empty, RLS is enabled, browser roles have no table grants, server role access is present, and both V2 tables and their existing rows remain intact.
- The v3 worker is not deployed. Its monitor defaults to disabled and has no selected targets until configured. Pair/timeframe, strategy, schedule, channel, journal, and explicit Push registration controls exist in the draft static page but are not published. Railway VAPID environment configuration and a safe existing worker resource selection are still pending.

## Delivery phases

1. Configure the staged V3 Railway service with server-only `CONFIG_API_TOKEN`, `V3_STATE_BACKEND=supabase`, `SUPABASE_URL`, and `SUPABASE_SECRET_KEY` (or temporary legacy key); do not expose secrets in Git or the browser.
2. Commit the staged service configuration and deploy only after secrets are present; keep sleep mode enabled and monitoring disabled for initial smoke checks.
3. Publish the static v3 page and verify desktop/mobile Push separately; Push and Telegram remain off by default.
4. Compare V3 detections with the first-version app on identical candle fixtures before enabling live monitoring or delivery.
5. Migrate the backend to the modern Supabase secret-key variable before legacy `service_role` keys are retired at the end of 2026.

## Non-goals for the first delivery

- No auto-trading or order execution.
- No changes to v1/v2 charts, Live, indicators, strategies, or Telegram rules.
- No new Railway project/service, paid database, or third-party Push SaaS.
- No migration of the existing v1/v2 user data.


## RSI confirmation by setup type

- Trend continuation uses a separate volume + RSI momentum event: LONG requires RSI above 50 and rising; SHORT requires RSI below 50 and falling. It does not require an RSI 70/30 extreme.
- Reversal continues to use the extreme/recovery Volume + RSI event and additionally requires a confirmed RSI turn away from the relevant zone: rising for LONG, falling for SHORT.
- The historical tester matches momentum events only to TREND regimes and reversal events only to REVERSAL regimes. Opposite-direction signals are never combined.
- Diagnostic MTF fields are read from the market-regime result, not from the scalping engine result.

## Multi-timeframe market structure (QA change)

- The default V3 scalping structure filter uses confirmed 15m and 1h market structure while the configured lower timeframe (initially 1m) remains responsible for the actual scalping trigger.
- Trend continuation requires BOS + retest on both 15m and 1h in the same direction, plus the lower-timeframe trend, volume, and Volume Profile filters.
- Reversal uses a confirmed 15m CHoCH + retest, and is blocked if the 1h structure has a confirmed BOS in the opposite direction. RSI and volume remain separate confirmation filters.
- Higher-timeframe candles are filtered by their close timestamp relative to each lower-timeframe candle. An unfinished 15m/1h candle must never influence a historical decision.
- The live worker fetches 15m/1h public candles; the historical runner fetches and audits both structure timeframes separately.
- This is a test-branch strategy change only. It must pass the server test workflow and a fresh walk-forward comparison before any production deployment. V1/V2 and Railway are unchanged.

## Historical backtesting (QA only)

The separate walk-forward tester downloads confirmed OKX perpetual candles and evaluates the existing V3 regime + scalping engines one candle at a time. Signals are entered at the next candle open; higher-timeframe Volume Profile bars are admitted only after they close. The tester does not place orders.

Run from `v3/server`:

```bash
npm run backtest -- --pairs=ZEC,NEAR --timeframe=1m --max-candles=5000 --stop-mode=swing
npm run backtest -- --pairs=ZEC,NEAR --timeframe=1m --max-candles=5000 --stop-mode=atr
```

Stop modes:
- `swing`: stop beyond the recent local high/low over the configured swing lookback.
- `atr`: stop at 1.5 ATR by default; set `--atr-multiplier=2` to change it. For the swing stop, set `--swing-lookback=16` to change the number of candles used.

Defaults preserve the agreed test assumptions: 0.5% risk per trade, 1:5 reward/risk, break-even after +1R, fees and slippage included, no partial exits or trailing stop. If stop and target are both touched in one candle, the simulator conservatively assumes the stop was hit first.

The first QA pass should use ZEC and NEAR. Add SOL and XRP only after reviewing the initial data quality and results. Historical output is research data, not a promise of future performance.
