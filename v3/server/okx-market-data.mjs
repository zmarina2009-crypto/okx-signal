import { normalizePair, normalizeTimeframe } from "./scalping-engine.mjs";

const OKX_BASE_URL = "https://www.okx.com/api/v5/market/candles";
const OKX_BARS = Object.freeze({
  "1h": "1H",
  "2h": "2H",
  "4h": "4H",
  "6h": "6H",
  "12h": "12H",
  "1d": "1D",
  "1w": "1W"
});

export function toOkxBar(timeframe) {
  const tf = normalizeTimeframe(timeframe);
  return OKX_BARS[tf] || tf;
}

export function parseOkxCandles(rows) {
  if (!Array.isArray(rows)) throw new TypeError("OKX candle data must be an array.");
  return rows.map(row => ({
    ts: Number(row?.[0]),
    o: Number(row?.[1]),
    h: Number(row?.[2]),
    l: Number(row?.[3]),
    c: Number(row?.[4]),
    v: Number(row?.[5]),
    confirm: String(row?.[8] ?? "0")
  })).filter(candle =>
    [candle.ts, candle.o, candle.h, candle.l, candle.c, candle.v].every(Number.isFinite) &&
    candle.ts > 0 && candle.c > 0 && candle.v >= 0 && candle.h >= candle.l
  ).sort((a, b) => a.ts - b.ts);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function fetchOkxCandles(pairInput, timeframeInput, options = {}) {
  const pair = normalizePair(pairInput);
  const timeframe = normalizeTimeframe(timeframeInput);
  if (!pair.endsWith("-USDT-SWAP")) throw new RangeError("Only USDT perpetual candles are supported.");

  const limit = Math.max(20, Math.min(300, Math.round(Number(options.limit) || 120)));
  const attempts = Math.max(1, Math.min(3, Math.round(Number(options.attempts) || 3)));
  const timeoutMs = Math.max(1000, Math.min(20_000, Number(options.timeoutMs) || 12_000));
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("Fetch API is not available in this Node.js runtime.");

  const url = new URL(OKX_BASE_URL);
  url.searchParams.set("instId", pair);
  url.searchParams.set("bar", toOkxBar(timeframe));
  url.searchParams.set("limit", String(limit));

  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetchImpl(url, {
        headers: { "User-Agent": "OKX-Signal-Pro-v3/1.0" },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) throw new Error("OKX HTTP " + response.status);

      const body = await response.json();
      if (body?.code !== "0" || !Array.isArray(body.data)) {
        throw new Error(body?.msg || "Invalid OKX candle response.");
      }
      return parseOkxCandles(body.data);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await wait(300 * (attempt + 1));
    }
  }

  throw new Error("OKX candle request failed for " + pair + " " + timeframe + ": " +
    String(lastError?.message || lastError || "unknown error"));
}
