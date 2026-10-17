# OKX Signal Pro — Telegram alerts 24/7

This is a separate Node.js worker. It does not change the browser chart, Live connection, existing alerts module, strategy tester, or paper trader.

## What it does

- Polls public OKX market candles from the server, so the phone/browser can be off.
- Sends Telegram messages for SMA touch, Volume spike, and RSI threshold-cross alerts.
- Optionally sends Combo alerts.
- Saves processed candle timestamps, cooldown state, signal history, and signal outcomes to the persistent JSON state file.
- Measures directional price return, maximum favourable excursion (MFE), and maximum adverse excursion (MAE) 1, 4, and 12 hours after each signal.
- Exposes `/health` for a hosting health check and `/stats?days=7` for a JSON performance summary (up to 90 days).

## Important first-stage limitation

The worker currently uses environment variables for its watchlist and alert settings. It does **not yet automatically import the browser's saved watchlists/settings**; browser localStorage is private to that browser. A later integration can add authenticated settings sync if desired.

All three indicator families are evaluated on confirmed candles. SMA touch is detected from the completed candle's high/low range against the SMA, so it does not repaint while a candle is still forming. The direction follows the pre-touch trend (price above SMA => LONG; below SMA => SHORT).

## Deploy on Railway

Create a Railway service from this repository and set the service root directory to `telegram-worker`. Use the start command `npm start`. Add a Railway Volume mounted at `/data` and set `STATE_FILE=/data/state.json` to preserve duplicate-prevention state across redeploys.

### Required variables

- `TELEGRAM_BOT_TOKEN` — token from Telegram's official BotFather. Keep it private; never commit it to GitHub or paste it into a public issue.
- `TELEGRAM_CHAT_ID` — your personal chat ID. Start the bot and send it a message first so Telegram permits delivery.

### Optional variables

- `OKX_PAIRS=BTC-USDT-SWAP,ETH-USDT-SWAP`
- `OKX_TIMEFRAMES=1m,5m,15m,1h,4h`
- `OKX_ALERT_RULES` — optional JSON array for independent pair/timeframe rules (overrides the pair/timeframe matrix above). Each item supports `pair`, `tf`, and booleans `telegram`, `volume`, `rsi`, `sma`, `combo`. Up to 20 distinct perpetual pairs and 100 pair/timeframe rules are accepted.
  Example: `[{"pair":"BTC-USDT-SWAP","tf":"1m","telegram":true,"volume":false,"rsi":true,"sma":true,"combo":true},{"pair":"BTC-USDT-SWAP","tf":"1h","telegram":true,"volume":true,"rsi":false,"sma":false,"combo":false},{"pair":"ETH-USDT-SWAP","tf":"15m","telegram":true,"volume":true,"rsi":true,"sma":false,"combo":true}]`
- `GET /config` — read-only endpoint showing active rules without secrets. `PUT /config` — updates rules at runtime and persists them in `STATE_FILE`; requires `Authorization: Bearer <CONFIG_API_TOKEN>`. Set a long random `CONFIG_API_TOKEN` in Railway before enabling writes. A successful config update is acknowledged only after the state file is written atomically; persistence failures return HTTP 500. `CONFIG_ALLOWED_ORIGIN` defaults to `https://zmarina2009-crypto.github.io` for browser CORS; override only for your trusted frontend origin. `GET /health` reports distinct pair count, rule count, and active timeframes.
- Saved rules in `state.json` take precedence after restart; if none have been saved, the worker uses `OKX_ALERT_RULES` or the legacy `OKX_PAIRS` + `OKX_TIMEFRAMES` matrix. Supported OKX bars are `1m,3m,5m,15m,30m,1h,2h,4h,6h,12h,1d,1w`.
- `POLL_INTERVAL_MS=20000` (minimum 10 seconds; a full cycle can take longer when many rules are enabled or OKX is slow)
- `npm test` runs the worker's Node.js test suite.
- `ALERT_SMA=true`, `SMA_PERIOD=21`, `SMA_TOLERANCE_PCT=0`
- `ALERT_VOLUME=true`, `VOLUME_PERIOD=20`, `VOLUME_MULT=2`
- `ALERT_RSI=true`, `RSI_PERIOD=14`, `RSI_LOW=30`, `RSI_HIGH=70`
- `ALERT_COMBO=false`, `COMBO_COUNT=2`, `COMBO_WINDOW_BARS=1`
- `ALERT_COOLDOWN_SECONDS=180`
- `ALERT_TIMEZONE=Europe/Berlin`

For OKX perpetual swaps, use instrument IDs ending in `-SWAP` (for example, `BTC-USDT-SWAP`). The default is `BTC-USDT-SWAP`; plain `BTC-USDT` refers to spot, not the perpetual market.

The worker does not need OKX API keys: it uses public market data only. It does not place orders. Statistics start accumulating after this version is deployed; earlier alerts cannot be reconstructed automatically. Reported directional returns exclude fees, funding, and slippage. A separate simulated-trade report with defined stop/target rules is a later step.

## Telegram setup

1. In Telegram, open the official `@BotFather`, create a bot with `/newbot`, and copy the token directly into Railway's Variables panel.
2. Open your new bot and press Start, then send it a short message.
3. Obtain the chat ID using a trusted Telegram bot/API method and set it in Railway. Do not share your token in this chat.
4. After deployment, open `https://YOUR-SERVICE-DOMAIN/health`. A healthy response should report `"ok":true`.

This first-stage worker is independent of the public GitHub Pages site. It should be deployed to an always-on worker/service; a sleeping or free instance cannot guarantee 24/7 delivery.