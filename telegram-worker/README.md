# OKX Signal Pro — Telegram alerts 24/7

This is a separate Node.js worker. It does not change the browser chart, Live connection, existing alerts module, strategy tester, or paper trader.

## What it does

- Polls public OKX market candles from the server, so the phone/browser can be off.
- Sends Telegram messages for SMA touch, Volume spike, and RSI threshold-cross alerts.
- Optionally sends Combo alerts.
- Saves processed candle timestamps and cooldown state to a JSON file to reduce duplicate messages after restarts.
- Exposes `/health` for a hosting health check.

## Important first-stage limitation

The worker currently uses environment variables for its watchlist and alert settings. It does **not yet automatically import the browser's saved watchlists/settings**; browser localStorage is private to that browser. A later integration can add authenticated settings sync if desired.

SMA touch uses the current unfinished candle, like the existing app's touch-style alert. Volume and RSI are evaluated on confirmed candles.

## Deploy on Railway

Create a Railway service from this repository and set the service root directory to `telegram-worker`. Use the start command `npm start`. Add a Railway Volume mounted at `/data` and set `STATE_FILE=/data/state.json` to preserve duplicate-prevention state across redeploys.

### Required variables

- `TELEGRAM_BOT_TOKEN` — token from Telegram's official BotFather. Keep it private; never commit it to GitHub or paste it into a public issue.
- `TELEGRAM_CHAT_ID` — your personal chat ID. Start the bot and send it a message first so Telegram permits delivery.

### Optional variables

- `OKX_PAIRS=BTC-USDT-SWAP,ETH-USDT-SWAP`
- `OKX_TIMEFRAMES=1m,5m,15m,1h,4h`
- `POLL_INTERVAL_MS=20000` (minimum 10 seconds)
- `ALERT_SMA=true`, `SMA_PERIOD=21`, `SMA_TOLERANCE_PCT=0`
- `ALERT_VOLUME=true`, `VOLUME_PERIOD=20`, `VOLUME_MULT=2`
- `ALERT_RSI=true`, `RSI_PERIOD=14`, `RSI_LOW=30`, `RSI_HIGH=70`
- `ALERT_COMBO=false`, `COMBO_COUNT=2`, `COMBO_WINDOW_BARS=1`
- `ALERT_COOLDOWN_SECONDS=180`
- `ALERT_TIMEZONE=Europe/Berlin`

For OKX perpetual swaps, use instrument IDs ending in `-SWAP` (for example, `BTC-USDT-SWAP`). The default is `BTC-USDT-SWAP`; plain `BTC-USDT` refers to spot, not the perpetual market.

The worker does not need OKX API keys: it uses public market data only. It does not place orders.

## Telegram setup

1. In Telegram, open the official `@BotFather`, create a bot with `/newbot`, and copy the token directly into Railway's Variables panel.
2. Open your new bot and press Start, then send it a short message.
3. Obtain the chat ID using a trusted Telegram bot/API method and set it in Railway. Do not share your token in this chat.
4. After deployment, open `https://YOUR-SERVICE-DOMAIN/health`. A healthy response should report `"ok":true`.

This first-stage worker is independent of the public GitHub Pages site. It should be deployed to an always-on worker/service; a sleeping or free instance cannot guarantee 24/7 delivery.