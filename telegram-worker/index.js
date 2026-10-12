import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const PAIRS = csv(process.env.OKX_PAIRS || "BTC-USDT");
const TIMEFRAMES = csv(process.env.OKX_TIMEFRAMES || "15m");
const POLL_MS = Math.max(10_000, Number(process.env.POLL_INTERVAL_MS || 20_000));
const VOLUME_PERIOD = clamp(Number(process.env.VOLUME_PERIOD || 20), 2, 100);
const VOLUME_MULT = Math.max(1, Number(process.env.VOLUME_MULT || 2));
const RSI_PERIOD = clamp(Number(process.env.RSI_PERIOD || 14), 2, 100);
const RSI_LOW = Number(process.env.RSI_LOW || 30);
const RSI_HIGH = Number(process.env.RSI_HIGH || 70);
const SMA_PERIOD = clamp(Number(process.env.SMA_PERIOD || 21), 2, 200);
const SMA_TOLERANCE_PCT = Math.max(0, Number(process.env.SMA_TOLERANCE_PCT || 0));
const COOLDOWN_MS = Math.max(30_000, Number(process.env.ALERT_COOLDOWN_SECONDS || 180) * 1000);
const ENABLE_VOLUME = enabled(process.env.ALERT_VOLUME, true);
const ENABLE_RSI = enabled(process.env.ALERT_RSI, true);
const ENABLE_SMA = enabled(process.env.ALERT_SMA, true);
const ENABLE_COMBO = enabled(process.env.ALERT_COMBO, false);
const COMBO_COUNT = clamp(Number(process.env.COMBO_COUNT || 2), 2, 3);
const COMBO_WINDOW_BARS = clamp(Number(process.env.COMBO_WINDOW_BARS || 1), 1, 5);
const STATE_FILE = process.env.STATE_FILE || (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "state.json") : "./state.json");

function csv(value) { return [...new Set(String(value).split(",").map(s => s.trim()).filter(Boolean))]; }
function clamp(n, min, max) { return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min)); }
function enabled(value, fallback) { return value == null ? fallback : !["0", "false", "no", "off"].includes(String(value).toLowerCase()); }
function average(values) { return values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : 0; }
function sma(candles, n, end = candles.length) {
  if (end < n) return null;
  return average(candles.slice(end - n, end).map(c => c.c));
}
function rsi(candles, n, end = candles.length) {
  if (end < n + 1) return null;
  let gains = 0, losses = 0;
  for (let i = end - n; i < end; i++) {
    const delta = candles[i].c - candles[i - 1].c;
    if (delta > 0) gains += delta; else losses -= delta;
  }
  if (!losses) return 100;
  if (!gains) return 0;
  return 100 - 100 / (1 + gains / losses);
}
function barFor(tf) {
  return ({ "1h": "1H", "2h": "2H", "4h": "4H", "6h": "6H", "12h": "12H", "1d": "1D", "1w": "1W" })[tf.toLowerCase()] || tf;
}
function tfMs(tf) {
  const m = String(tf).toLowerCase().match(/^(\d+)(m|h|d|w)$/);
  if (!m) return 900_000;
  return Number(m[1]) * ({m:60_000,h:3_600_000,d:86_400_000,w:604_800_000})[m[2]];
}
function price(n) { return Number(n).toLocaleString("en-US", { maximumFractionDigits: 8 }); }

let state = { lastClosed: {}, lastAlertAt: {}, lastSmaTouch: {}, recentSignals: [] };
let busy = false;
let stopped = false;

async function loadState() {
  try {
    const parsed = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
    if (parsed && typeof parsed === "object") state = { ...state, ...parsed };
  } catch {}
}
async function saveState() {
  try {
    await fs.mkdir(path.dirname(path.resolve(STATE_FILE)), { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify(state), "utf8");
  } catch (err) {
    console.error("Could not persist state:", err.message);
  }
}
async function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) throw new Error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in the hosting environment.");
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, disable_web_page_preview: true })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) throw new Error(body.description || `Telegram HTTP ${response.status}`);
}
async function emit(kind, pair, tf, direction, closePrice, details = "") {
  const key = [kind, pair, tf, direction].join(":");
  const now = Date.now();
  if (now - (state.lastAlertAt[key] || 0) < COOLDOWN_MS) return;
  state.lastAlertAt[key] = now;
  const emoji = direction === "LONG" ? "🟢" : "🔴";
  const text = [
    `OKX SIGNAL PRO • ${kind.toUpperCase()}`,
    `${emoji} ${direction}  |  ${pair}  |  ${tf}`,
    `Цена: ${price(closePrice)}`,
    details,
    new Date(now).toLocaleString("ru-RU", { timeZone: process.env.ALERT_TIMEZONE || "Europe/Berlin" })
  ].filter(Boolean).join("\n");
  try {
    await sendTelegram(text);
    console.log("Sent:", key);
  } catch (err) {
    console.error("Telegram send failed:", err.message);
    delete state.lastAlertAt[key];
  }
  await saveState();
}
async function fetchCandles(pair, tf) {
  const url = new URL("https://www.okx.com/api/v5/market/candles");
  url.searchParams.set("instId", pair);
  url.searchParams.set("bar", barFor(tf));
  url.searchParams.set("limit", "100");
  const response = await fetch(url, { headers: { "User-Agent": "OKX-Signal-Pro-Telegram/1.0" }, signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`OKX HTTP ${response.status}`);
  const body = await response.json();
  if (body.code !== "0" || !Array.isArray(body.data)) throw new Error(body.msg || "Invalid OKX response");
  // OKX returns newest first: [ts, open, high, low, close, volume, ..., confirm].
  return body.data.map(row => ({
    ts: Number(row[0]), o: Number(row[1]), h: Number(row[2]), l: Number(row[3]),
    c: Number(row[4]), v: Number(row[5]), confirm: String(row[8]) === "1"
  })).filter(c => Number.isFinite(c.ts) && c.c > 0).sort((a, b) => a.ts - b.ts);
}
function recordSignal(pair, tf, kind, direction, ts, closePrice) {
  state.recentSignals = state.recentSignals.filter(s => Date.now() - s.ts <= tfMs(tf) * COMBO_WINDOW_BARS * 5);
  const id = [pair, tf, kind, direction, ts].join(":");
  if (!state.recentSignals.some(s => s.id === id)) state.recentSignals.push({ id, pair, tf, kind, direction, ts, price: closePrice });
  state.recentSignals = state.recentSignals.slice(-500);
  if (!ENABLE_COMBO) return;
  const windowMs = tfMs(tf) * COMBO_WINDOW_BARS;
  const recent = state.recentSignals.filter(s => s.pair === pair && s.tf === tf && Math.abs(ts - s.ts) <= windowMs);
  const byKind = new Map();
  for (const s of recent) {
    const old = byKind.get(s.kind);
    if (!old || Math.abs(ts - s.ts) < Math.abs(ts - old.ts)) byKind.set(s.kind, s);
  }
  const chosen = [...byKind.values()];
  if (chosen.length < COMBO_COUNT) return;
  const directed = chosen.filter(s => s.kind !== "volume");
  if (!directed.length || directed.some(s => s.direction !== directed[0].direction)) return;
  const comboTs = Math.max(...chosen.map(s => s.ts));
  void emit("combo", pair, tf, directed[0].direction, directed[0].price || closePrice, chosen.map(s => s.kind.toUpperCase()).join(" + "));
  state.recentSignals = state.recentSignals.filter(s => !(s.pair === pair && s.tf === tf && s.ts <= comboTs));
}
async function processPair(pair, tf) {
  const candles = await fetchCandles(pair, tf);
  if (candles.length < Math.max(SMA_PERIOD, VOLUME_PERIOD, RSI_PERIOD) + 2) return;
  const closed = candles.filter(c => c.confirm);
  const live = candles.find(c => !c.confirm) || null;
  if (closed.length < 3) return;
  const last = closed.at(-1);
  const candleKey = pair + ":" + tf;
  const lastSeen = state.lastClosed[candleKey] || 0;

  if (last.ts > lastSeen) {
    state.lastClosed[candleKey] = last.ts;
    const end = closed.length;
    if (ENABLE_VOLUME && end >= VOLUME_PERIOD + 1) {
      const base = closed.slice(end - VOLUME_PERIOD - 1, end - 1).map(c => c.v);
      const avg = average(base);
      const multiple = avg > 0 ? last.v / avg : 0;
      if (multiple >= VOLUME_MULT) {
        const direction = last.c >= last.o ? "LONG" : "SHORT";
        await emit("volume", pair, tf, direction, last.c, `Объём: ×${multiple.toFixed(1)} от среднего`);
        recordSignal(pair, tf, "volume", direction, last.ts, last.c);
      }
    }
    if (ENABLE_RSI) {
      const value = rsi(closed, RSI_PERIOD, end);
      const prev = rsi(closed, RSI_PERIOD, end - 1);
      if (value != null && prev != null) {
        if (prev >= RSI_LOW && value < RSI_LOW) {
          await emit("rsi", pair, tf, "LONG", last.c, `RSI: ${value.toFixed(1)} — выход ниже ${RSI_LOW}`);
          recordSignal(pair, tf, "rsi", "LONG", last.ts, last.c);
        }
        if (prev <= RSI_HIGH && value > RSI_HIGH) {
          await emit("rsi", pair, tf, "SHORT", last.c, `RSI: ${value.toFixed(1)} — выход выше ${RSI_HIGH}`);
          recordSignal(pair, tf, "rsi", "SHORT", last.ts, last.c);
        }
      }
    }
  }

  if (ENABLE_SMA && live) {
    const m = sma(closed, SMA_PERIOD);
    if (m) {
      const tolerance = SMA_TOLERANCE_PCT / 100;
      const touched = live.l <= m && live.h >= m || (tolerance > 0 && Math.abs(live.c - m) / m <= tolerance);
      const touchKey = candleKey + ":touch";
      const wasTouched = Boolean(state.lastSmaTouch[touchKey]);
      if (touched && !wasTouched) {
        const prevClose = closed.at(-1).c;
        const prevSma = sma(closed.slice(0, -1), SMA_PERIOD) || m;
        const direction = prevClose < prevSma ? "LONG" : prevClose > prevSma ? "SHORT" : live.c >= m ? "LONG" : "SHORT";
        await emit("sma", pair, tf, direction, live.c, `SMA${SMA_PERIOD}: ${price(m)}`);
        recordSignal(pair, tf, "sma", direction, live.ts, live.c);
      }
      state.lastSmaTouch[touchKey] = touched;
    }
  }
  await saveState();
}
async function cycle() {
  if (busy || stopped) return;
  busy = true;
  try {
    for (const pair of PAIRS) {
      for (const tf of TIMEFRAMES) {
        if (stopped) break;
        try { await processPair(pair, tf); }
        catch (err) { console.error(`Pair poll failed ${pair} ${tf}:`, err.message); }
        await new Promise(resolve => setTimeout(resolve, 180));
      }
    }
  } finally {
    busy = false;
  }
}
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(BOT_TOKEN && CHAT_ID ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: Boolean(BOT_TOKEN && CHAT_ID), service: "okx-signal-telegram-worker", pairs: PAIRS.length, timeframes: TIMEFRAMES, intervalMs: POLL_MS }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("OKX Signal Pro Telegram worker is running.\n");
});
await loadState();
server.listen(PORT, () => {
  console.log(`Worker listening on ${PORT}; pairs=${PAIRS.join(",")}; timeframes=${TIMEFRAMES.join(",")}; interval=${POLL_MS}ms`);
  if (!BOT_TOKEN || !CHAT_ID) console.warn("Telegram credentials are not configured; set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.");
  void cycle();
  setInterval(() => void cycle(), POLL_MS);
});
process.on("SIGTERM", () => { stopped = true; server.close(); });
process.on("SIGINT", () => { stopped = true; server.close(); });