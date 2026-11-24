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
- Do not add a managed database or paid notification provider for the MVP.
- Measure the additional runtime usage before enabling continuous monitoring; reusing a service avoids a new service, but does not make active compute free.

## Implementation status (2026-11-24)

- Server-side Volume + RSI / BOS engine and OKX public candle adapter are implemented.
- Notification schedule supports weekdays, multiple windows, and IANA time zones.
- Telegram and Web Push server adapters are implemented; Push requires VAPID public/private keys and an explicit valid `VAPID_SUBJECT`.
- A persistent notification outbox retries failed destinations with a bounded number of attempts, skips destinations already confirmed, and expires stale signals after 90 seconds or when the active time window ends.
- CI currently validates deterministic engine, schedule, market-data, persistence, delivery, and outbox behavior. The current PR remains draft and is not merged or deployed.
- No v3 browser UI or service worker has been published yet; no Push subscription can be registered from the app until that work is complete.

## Initial architecture

1. **Market data adapter**
   - OKX public market candles only; no trading credentials and no order placement.
   - Normalize instruments and supported timeframes.
   - Handle rate limits, timeouts, incomplete candles, retries, and per-symbol failures independently.

2. **Scalping engine**
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
   - For the MVP, reuse an existing mounted Railway volume rather than adding a database service.
   - Before reuse, repair and test atomic/concurrent state writes. Current v2 worker logs contain `ENOENT` while renaming `/data/state.json.tmp` to `/data/state.json`; concurrent saves sharing one temporary filename are a likely cause and must be confirmed with a regression test.
   - Keep state writes serialized or use unique temporary filenames and atomic replacement.
   - Keep config, processed candle timestamps, cooldowns, signal journal, Push subscriptions, and delivery status separate by schema/version.

## Existing infrastructure audit (2026-11-24)

- Railway workspace currently has two projects: `natural-integrity` and `OKX Signal Telegram Alerts`.
- The v1 worker in `OKX Signal Telegram Alerts` is now `Sleeping` with the `telegram-paused-v1` start command. Its mounted `/data` volume is retained; the v1 app front end is not changed.
- The v2 worker in `natural-integrity` remains `Online` so its existing runtime API and monitoring are not removed. A Railway variable `TELEGRAM_NOTIFICATIONS_ENABLED=false` and a code guard were added on its existing feature branch; the new deployment completed successfully on 2026-11-24. Telegram delivery is paused while the v2 worker remains available.
- The v2 worker keeps its mounted `/data` volume and its existing per-pair/timeframe rules, Volume Profile, COMBO, CHOP, runtime config API, statistics, and delivery history. No Telegram credential values were read or changed.
- Previous v2 logs showed state-file rename errors. The v3 state store instead serializes writes and uses a unique temporary filename, with concurrent-write regression tests. This is a v3-specific fix; v2 persistence has not been rewritten.
- No new Railway project, service, or database was created. The v1 and v2 front ends, charts, and Live features remain unchanged.
- The v3 worker is not deployed. Its monitor defaults to disabled and has no selected targets until configured. The server-side Push/Telegram adapters exist, but the browser settings UI, service worker registration, and VAPID environment configuration are still pending.

## Delivery phases

1. Finish the infrastructure and persistence audit; record the exact worker resource that can be safely reused.
2. Extract the v1 scalping calculations into pure server-side functions and add deterministic tests.
3. Add OKX polling, duplicate prevention, per-position state, and a persistent signal journal.
4. Add notification schedule settings (timezone, weekdays, multiple windows).
5. Add Telegram and Web Push adapters behind independent toggles.
6. Compare server detections with the first-version app on the same candle fixtures and observation period.
7. Only after successful checks, connect the existing Railway worker resource and publish the v3 UI.

## Non-goals for the first delivery

- No auto-trading or order execution.
- No changes to v1/v2 charts, Live, indicators, strategies, or Telegram rules.
- No new Railway project/service, paid database, or third-party Push SaaS.
- No migration of the existing v1/v2 user data.
