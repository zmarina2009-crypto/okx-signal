import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { recordPerformanceSignal, updatePerformanceOutcomes, buildPerformanceStats } from "./statistics.js";
import { volumeProfileCrossings } from "./volume-profile.js";

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const CONFIG_API_TOKEN = process.env.CONFIG_API_TOKEN || "";
const CONFIG_ALLOWED_ORIGIN = process.env.CONFIG_ALLOWED_ORIGIN || "https://zmarina2009-crypto.github.io";
const PAIRS = csv(process.env.OKX_PAIRS || "BTC-USDT-SWAP");
const TIMEFRAMES = csv(process.env.OKX_TIMEFRAMES || "15m");
const POLL_MS = Math.max(10_000, Number(process.env.POLL_INTERVAL_MS || 20_000));
const VOLUME_PERIOD = clamp(Number(process.env.VOLUME_PERIOD || 20), 2, 100);
const VOLUME_MULT = Math.max(1, Number(process.env.VOLUME_MULT || 2));
const RSI_PERIOD = clamp(Number(process.env.RSI_PERIOD || 14), 2, 100);
const RSI_LOW = Number(process.env.RSI_LOW || 30);
const RSI_HIGH = Number(process.env.RSI_HIGH || 70);
const SMA_PERIOD = clamp(Number(process.env.SMA_PERIOD || 21), 2, 200);
const SMA_TOLERANCE_PCT = Math.max(0, Number(process.env.SMA_TOLERANCE_PCT || 0));
const VP_PERIOD = clamp(Number(process.env.VP_PERIOD || 60), 20, 90);
const VP_ROWS = clamp(Number(process.env.VP_ROWS || 30), 10, 60);
const VP_MODE_VALUE = String(process.env.VP_MODE || "poc").toLowerCase();
const VP_MODE = ["poc", "va", "all"].includes(VP_MODE_VALUE) ? VP_MODE_VALUE : "poc";
const COOLDOWN_MS = Math.max(30_000, Number(process.env.ALERT_COOLDOWN_SECONDS || 180) * 1000);
const ENABLE_VOLUME = enabled(process.env.ALERT_VOLUME, true);
const ENABLE_RSI = enabled(process.env.ALERT_RSI, true);
const ENABLE_SMA = enabled(process.env.ALERT_SMA, true);
const ENABLE_VP = enabled(process.env.ALERT_VP, false);
const ENABLE_COMBO = enabled(process.env.ALERT_COMBO, false);
const COMBO_COUNT = clamp(Number(process.env.COMBO_COUNT || 2), 2, 4);
const COMBO_WINDOW_BARS = clamp(Number(process.env.COMBO_WINDOW_BARS || 1), 1, 5);
const STATE_FILE = process.env.STATE_FILE || (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "state.json") : "./state.json");
let ALERT_RULES = loadAlertRules();
function loadAlertRules(raw = process.env.OKX_ALERT_RULES) {
  if (!raw) {
    return PAIRS.flatMap(pair => TIMEFRAMES.map(tf => ({
      pair, tf, telegram: true,
      volume: COMBO_COUNT===4||ENABLE_VOLUME, rsi: COMBO_COUNT===4||ENABLE_RSI, sma: COMBO_COUNT===4||ENABLE_SMA, vp: COMBO_COUNT===4||ENABLE_VP, combo: ENABLE_COMBO,
      comboCount: COMBO_COUNT, comboWindowBars: COMBO_COUNT===4?Math.max(3,COMBO_WINDOW_BARS):COMBO_WINDOW_BARS,
      chopFilter: tf === "1m", chopPeriod: 14, chopThreshold: 61.8
    })));
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("OKX_ALERT_RULES must be valid JSON."); }
  if (!Array.isArray(parsed) || parsed.length < 1) {
    throw new Error("OKX_ALERT_RULES must be a non-empty JSON array.");
  }
  const validTimeframes = new Set(["1m","3m","5m","15m","30m","1h","2h","4h","6h","12h","1d","1w"]);
  const validTf = /^\d+(m|h|d|w)$/i;
  const unique = new Map();
  for (const item of parsed) {
    const pair = String(item?.pair || "").trim().toUpperCase();
    const tf = String(item?.tf || "").trim().toLowerCase();
    if (!/^[A-Z0-9]+-USDT-SWAP$/.test(pair)) throw new Error("Invalid perpetual pair in OKX_ALERT_RULES: " + pair);
    if (!validTf.test(tf) || !validTimeframes.has(tf)) throw new Error("Unsupported OKX timeframe in alert rules: " + tf);
    const key = pair + ":" + tf;
    const comboCount=clamp(Math.round(Number(item.comboCount ?? COMBO_COUNT)),2,4);
    const comboWindowBars=clamp(Math.round(Number(item.comboWindowBars ?? (comboCount===4?Math.max(3,COMBO_WINDOW_BARS):COMBO_WINDOW_BARS))),1,5);
    const allFour=comboCount===4;
    unique.set(key, {
      pair, tf,
      telegram: item.telegram == null ? true : item.telegram === true,
      volume: allFour || (item.volume == null ? ENABLE_VOLUME : item.volume === true),
      comboCount, comboWindowBars,
      rsi: allFour || (item.rsi == null ? ENABLE_RSI : item.rsi === true),
      sma: allFour || (item.sma == null ? ENABLE_SMA : item.sma === true),
      vp: allFour || (item.vp == null ? ENABLE_VP : item.vp === true),
      combo: item.combo == null ? ENABLE_COMBO : item.combo === true,
      chopFilter: item.chopFilter == null ? tf === "1m" : item.chopFilter === true,
      chopPeriod: clamp(Number(item.chopPeriod || 14), 5, 50),
      chopThreshold: clamp(Number(item.chopThreshold || 61.8), 20, 100)
    });
  }
  const rules = [...unique.values()];
  if (new Set(rules.map(rule => rule.pair)).size > 20) {
    throw new Error("OKX_ALERT_RULES supports at most 20 distinct pairs.");
  }
  if (rules.length > 100) throw new Error("OKX_ALERT_RULES supports at most 100 pair/timeframe rules.");
  return rules;
}

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
function choppiness(candles, n = 14) {
  const period = clamp(Math.round(Number(n) || 14), 5, 50);
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const window = candles.slice(-period);
  let sumTR = 0, highest = -Infinity, lowest = Infinity;
  for (let i = 0; i < window.length; i++) {
    const candle = window[i];
    const previous = i === 0 ? candles[candles.length - period - 1] : window[i - 1];
    const high = Number(candle.h), low = Number(candle.l), previousClose = Number(previous.c);
    if (![high, low, previousClose].every(Number.isFinite)) return null;
    sumTR += Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
    highest = Math.max(highest, high);
    lowest = Math.min(lowest, low);
  }
  const span = highest - lowest;
  if (span <= 0 || sumTR <= 0) return null;
  return clamp(100 * Math.log10(sumTR / span) / Math.log10(period), 0, 100);
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

let state = { lastClosed: {}, lastAlertAt: {}, lastSmaTouch: {}, recentSignals: [], performanceSignals: [] };
let busy = false;
let stopped = false;

async function loadState() {
  try {
    const parsed = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
    if (parsed && typeof parsed === "object") {
      state = { ...state, ...parsed };
      if (Array.isArray(parsed.alertRules) && parsed.alertRules.length) ALERT_RULES = loadAlertRules(JSON.stringify(parsed.alertRules));
    }
  } catch {}
}
async function saveState(snapshot = state) {
  try {
    await fs.mkdir(path.dirname(path.resolve(STATE_FILE)), { recursive: true });
    const tmpFile = STATE_FILE + ".tmp";
    await fs.writeFile(tmpFile, JSON.stringify(snapshot), "utf8");
    await fs.rename(tmpFile, STATE_FILE);
  } catch (err) {
    console.error("Could not persist state:", err.message);
    throw new Error("State persistence failed: " + err.message, { cause: err });
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
function recordSignal(pair, tf, kind, direction, ts, closePrice, rule, candles) {
  recordPerformanceSignal(state, { pair, tf, kind, direction, ts, price: closePrice });
  const comboWindowBars=clamp(Number(rule.comboWindowBars ?? COMBO_WINDOW_BARS),1,5);
  const required=clamp(Number(rule.comboCount ?? COMBO_COUNT),2,4);
  state.recentSignals = state.recentSignals.filter(s => Date.now() - s.ts <= tfMs(tf) * comboWindowBars * 5);
  const id = [pair, tf, kind, direction, ts].join(":");
  if (!state.recentSignals.some(s => s.id === id)) state.recentSignals.push({ id, pair, tf, kind, direction, ts, price: closePrice });
  state.recentSignals = state.recentSignals.slice(-500);
  if (!rule.combo) return;
  const windowMs = tfMs(tf) * comboWindowBars;
  const recent = state.recentSignals.filter(s => s.pair === pair && s.tf === tf && Math.abs(ts - s.ts) <= windowMs);
  const byKind = new Map();
  for (const s of recent) {
    const old = byKind.get(s.kind);
    if (!old || Math.abs(ts - s.ts) < Math.abs(ts - old.ts)) byKind.set(s.kind, s);
  }
  const chosen = [...byKind.values()];
  if (chosen.length < required) {
    if(required===4){
      const missing=["volume","rsi","sma","vp"].filter(source=>!byKind.has(source));
      console.log("COMBO 4/4 waiting:",pair,tf,"received",chosen.length+"/4","missing",missing.join(", ")||"none yet","windowBars",comboWindowBars);
    }
    return;
  }
  // Volume confirms activity; RSI, SMA and Volume Profile contribute direction.
  const directed = chosen.filter(s => s.kind !== "volume");
  if (!directed.length || directed.some(s => s.direction !== directed[0].direction)) {
    if(required===4)console.log("COMBO 4/4 skipped: directional disagreement",pair,tf,chosen.map(x=>x.kind+":"+x.direction).join(", "), "windowBars",comboWindowBars);
    return;
  }
  const comboTs = Math.max(...chosen.map(s => s.ts));
  if (rule.chopFilter) {
    const chop = choppiness(candles, rule.chopPeriod);
    const threshold = clamp(Number(rule.chopThreshold) || 61.8, 20, 100);
    if (chop == null || chop >= threshold) {
      const detail = chop == null ? "недостаточно свечей" : "CHOP " + chop.toFixed(1) + " >= " + threshold.toFixed(1);
      console.log("Combo blocked by CHOP:", pair, tf, detail);
      state.recentSignals = state.recentSignals.filter(s => !(s.pair === pair && s.tf === tf && s.ts <= comboTs));
      return;
    }
  }
  const comboPrice = directed[0].price || closePrice;
  recordPerformanceSignal(state, { pair, tf, kind: "combo", direction: directed[0].direction, ts: comboTs, price: comboPrice });
  if (rule.telegram) void emit("combo", pair, tf, directed[0].direction, comboPrice, chosen.length+"/4 • "+chosen.map(s => s.kind.toUpperCase()).join(" + ")+" • окно "+comboWindowBars+" свечи"+(rule.chopFilter ? " • CHOP " + (choppiness(candles, rule.chopPeriod) ?? NaN).toFixed(1) : ""));
  state.recentSignals = state.recentSignals.filter(s => !(s.pair === pair && s.tf === tf && s.ts <= comboTs));
}
async function processPair(pair, tf, rule) {
  const candles = await fetchCandles(pair, tf);
  if (candles.length < Math.max(SMA_PERIOD, VOLUME_PERIOD, RSI_PERIOD, rule.vp ? VP_PERIOD + 2 : 0) + 2) return;
  const closed = candles.filter(c => c.confirm);
  if (closed.length < 3) return;
  const last = closed.at(-1);
  updatePerformanceOutcomes(state, pair, tf, closed);
  const candleKey = pair + ":" + tf;
  const lastSeen = state.lastClosed[candleKey] || 0;
  const isNewClosedCandle = last.ts > lastSeen;

  if (isNewClosedCandle) {
    state.lastClosed[candleKey] = last.ts;
    const end = closed.length;
    if (rule.volume && end >= VOLUME_PERIOD + 1) {
      const base = closed.slice(end - VOLUME_PERIOD - 1, end - 1).map(c => c.v);
      const avg = average(base);
      const multiple = avg > 0 ? last.v / avg : 0;
      if (multiple >= VOLUME_MULT) {
        const direction = last.c >= last.o ? "LONG" : "SHORT";
        if (rule.telegram) await emit("volume", pair, tf, direction, last.c, `Объём: ×${multiple.toFixed(1)} от среднего`);
        recordSignal(pair, tf, "volume", direction, last.ts, last.c, rule, closed);
      }
    }
    if (rule.rsi) {
      const value = rsi(closed, RSI_PERIOD, end);
      const prev = rsi(closed, RSI_PERIOD, end - 1);
      if (value != null && prev != null) {
        if (prev >= RSI_LOW && value < RSI_LOW) {
          if (rule.telegram) await emit("rsi", pair, tf, "LONG", last.c, `RSI: ${value.toFixed(1)} — выход ниже ${RSI_LOW}`);
          recordSignal(pair, tf, "rsi", "LONG", last.ts, last.c, rule, closed);
        }
        if (prev <= RSI_HIGH && value > RSI_HIGH) {
          if (rule.telegram) await emit("rsi", pair, tf, "SHORT", last.c, `RSI: ${value.toFixed(1)} — выход выше ${RSI_HIGH}`);
          recordSignal(pair, tf, "rsi", "SHORT", last.ts, last.c, rule, closed);
        }
      }
    }
    if (rule.vp && end >= VP_PERIOD + 2) {
      // The signal candle is excluded from its own profile to avoid look-ahead.
      const profileBars = closed.slice(0, -1).slice(-VP_PERIOD);
      const previous = closed.at(-2);
      const crossings = volumeProfileCrossings(profileBars, previous?.c, last.c, VP_MODE, VP_ROWS);
      for (const crossing of crossings) {
        const detail = `Volume Profile ${crossing.level}: пересечение уровня ${price(crossing.price)}; close ${price(last.c)}`;
        if (rule.telegram) await emit("vp", pair, tf, crossing.direction, last.c, detail);
        recordSignal(pair, tf, "vp", crossing.direction, last.ts, last.c, rule, closed);
      }
    }
  }

  // SMA touches are evaluated only after a candle is confirmed, avoiding intrabar/repainting alerts.
  if (rule.sma && isNewClosedCandle) {
    const m = sma(closed, SMA_PERIOD);
    if (m && last.l <= m && last.h >= m) {
      const previous = closed.at(-2);
      const previousSma = sma(closed.slice(0, -1), SMA_PERIOD);
      // Follow the pre-touch trend: above SMA => LONG; below SMA => SHORT.
      const direction = previous && previousSma != null && previous.c >= previousSma ? "LONG" : "SHORT";
      if (rule.telegram) await emit("sma", pair, tf, direction, last.c, `SMA${SMA_PERIOD}: ${price(m)} (закрытая свеча)`);
      recordSignal(pair, tf, "sma", direction, last.ts, last.c, rule, closed);
    }
  }
  await saveState();
}
async function cycle() {
  if (busy || stopped) return;
  busy = true;
  try {
    for (const rule of ALERT_RULES) {
      if (stopped) break;
      try { await processPair(rule.pair, rule.tf, rule); }
      catch (err) { console.error(`Pair poll failed ${rule.pair} ${rule.tf}:`, err.message); }
      await new Promise(resolve => setTimeout(resolve, 180));
    }
  } finally {
    busy = false;
  }
}
const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url || "/", "http://localhost");
  const origin = req.headers.origin || "";
  if (origin === CONFIG_ALLOWED_ORIGIN) {
    res.setHeader("access-control-allow-origin", CONFIG_ALLOWED_ORIGIN);
    res.setHeader("vary", "Origin");
    res.setHeader("access-control-allow-methods", "GET, PUT, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type, authorization");
  }
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (requestUrl.pathname === "/stats") {
    const days = requestUrl.searchParams.get("days") || "7";
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(buildPerformanceStats(state, days), null, 2));
    return;
  }
  if (requestUrl.pathname === "/config" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ rules: ALERT_RULES.map(({ pair, tf, telegram, volume, rsi, sma, vp, combo, chopFilter, chopPeriod, chopThreshold }) => ({ pair, tf, telegram, volume, rsi, sma, vp, combo, chopFilter, chopPeriod, chopThreshold })) }, null, 2));
    return;
  }
  if (requestUrl.pathname === "/config" && req.method === "PUT") {
    if (!CONFIG_API_TOKEN) {
      res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Configuration API is disabled; set CONFIG_API_TOKEN." })); return;
    }
    const auth = String(req.headers.authorization || "");
    if (auth !== "Bearer " + CONFIG_API_TOKEN) {
      res.writeHead(401, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Unauthorized" })); return;
    }
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 100_000) { res.writeHead(413); res.end("Payload too large"); req.destroy(); }
    });
    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body || "{}");
        const rules = loadAlertRules(JSON.stringify(parsed.rules));
        if (!rules.length) throw new Error("At least one rule is required.");
        // Persist first; do not acknowledge or activate a config that cannot survive restart.
        await saveState({ ...state, alertRules: rules });
        ALERT_RULES = rules;
        state.alertRules = rules;
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: true, count: ALERT_RULES.length, pairs: new Set(ALERT_RULES.map(rule => rule.pair)).size }));
      } catch (err) {
        const persistenceFailure = String(err.message || "").startsWith("State persistence failed:");
        res.writeHead(persistenceFailure ? 500 : 400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: err.message || "Invalid configuration" }));
      }
    });
    return;
  }
  if (requestUrl.pathname === "/test-telegram" && req.method === "POST") {
    if (!CONFIG_API_TOKEN) {
      res.writeHead(503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: false, error: "Configuration API is disabled; set CONFIG_API_TOKEN." }));
      return;
    }
    const auth = String(req.headers.authorization || "");
    if (auth !== "Bearer " + CONFIG_API_TOKEN) {
      res.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
      return;
    }
    if (!BOT_TOKEN || !CHAT_ID) {
      res.writeHead(503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: false, error: "Telegram credentials are not configured." }));
      return;
    }
    const testMessage = [
      "✅ Тестовое сообщение OKX Signal Pro",
      "Telegram-воркер работает и может отправлять уведомления.",
      "Время: " + new Date().toLocaleString("ru-RU", { timeZone: process.env.ALERT_TIMEZONE || "Europe/Berlin" })
    ].join("\n");
    void sendTelegram(testMessage).then(() => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, sent: true, message: "Test message sent." }));
    }).catch(err => {
      console.error("Telegram test send failed:", err.message);
      res.writeHead(502, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: false, error: err.message || "Telegram delivery failed." }));
    });
    return;
  }
  if (requestUrl.pathname === "/health") {
    res.writeHead(BOT_TOKEN && CHAT_ID ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: Boolean(BOT_TOKEN && CHAT_ID), service: "okx-signal-telegram-worker", pairs: new Set(ALERT_RULES.map(rule => rule.pair)).size, rules: ALERT_RULES.length, timeframes: [...new Set(ALERT_RULES.map(rule => rule.tf))], intervalMs: POLL_MS }));
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