# OKX Signal Pro v3 — scalping-first foundation

## Purpose

Build v3 as a separate application line while keeping v1 and v2 intact. The first delivery is server-side scalping with scheduled Push and Telegram notifications. Auto-trading is explicitly out of scope for this phase.

## Cost constraint

- Do not create a new Railway project or service for the first MVP.
- Keep the v3 static interface separate from v1, for example under `/v3/` on the existing GitHub Pages site.
- Audit and, only after validation, repurpose an existing worker resource in Railway project `natural-integrity`.
- Prefer the existing persistent `/data` volume and existing Telegram credentials; never copy secret values into Git.
- Do not add a managed database or paid notification provider for the MVP.
- Reassess resource use before enabling the worker for continuous production operation.

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
- The v1 worker in `OKX Signal Telegram Alerts` runs from `main/telegram-worker`, has a mounted `/data` volume, and is actively sending Telegram alerts. Its implementation supports basic Volume, RSI, SMA, and event-based Combo; it is not the same as the browser scalping engine.
- The v2 worker resource in `natural-integrity` has a mounted `/data` volume, per-pair/timeframe rules, Volume Profile, COMBO options, CHOP filtering, a runtime config API, signal statistics, and Telegram delivery history.
- The v2 worker's current desired Railway start command is a maintenance-only HTTP process, while its recent runtime logs still show polling activity. Reconcile desired config with the deployed snapshot before repurposing it.
- v2 worker logs include state-persistence rename errors. Do not copy or promote that persistence implementation without a concurrency fix and tests.
- The v1 and v2 app front ends must remain unchanged during v3 foundation work.

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
