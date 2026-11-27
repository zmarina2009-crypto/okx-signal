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
  const rawPair = String(pairInput || "").trim().toUpperCase();
  const supportedInput = /^[A-Z0-9]{1,20}$/.test(rawPair) ||
    /^[A-Z0-9]{1,20}USDT$/.test(rawPair) ||
    /^[A-Z0-9]{1,20}-USDT$/.test(rawPair) ||
    /^[A-Z0-9]{1,20}-USDT-SWAP$/.test(rawPair);
  if (!supportedInput) throw new RangeError("Only USDT perpetual candles are supported: " + rawPair);
  const pair = normalizePair(rawPair);
  const timeframe = normalizeTimeframe(timeframeInput);

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


const OKX_HISTORY_URL = "https://www.okx.com/api/v5/market/history-candles";

/**
 * Downloads confirmed historical candles backwards from endTime. OKX returns
 * newest-first pages; the adapter deduplicates and returns ascending timestamps.
 */
export async function fetchOkxHistoricalCandles(pairInput, timeframeInput, options = {}) {
  const rawPair = String(pairInput || "").trim().toUpperCase();
  const supportedInput = /^[A-Z0-9]{1,20}$/.test(rawPair) ||
    /^[A-Z0-9]{1,20}USDT$/.test(rawPair) ||
    /^[A-Z0-9]{1,20}-USDT$/.test(rawPair) ||
    /^[A-Z0-9]{1,20}-USDT-SWAP$/.test(rawPair);
  if (!supportedInput) throw new RangeError("Only USDT perpetual candles are supported: " + rawPair);
  const pair = normalizePair(rawPair);
  const timeframe = normalizeTimeframe(timeframeInput);
  const limit = Math.max(1, Math.min(20_000, Math.round(Number(options.maxCandles) || 5_000)));
  const pageSize = Math.max(20, Math.min(100, Math.round(Number(options.pageSize) || 100)));
  const attempts = Math.max(1, Math.min(3, Math.round(Number(options.attempts) || 3)));
  const timeoutMs = Math.max(1000, Math.min(20_000, Number(options.timeoutMs) || 12_000));
  const startTime = Number.isFinite(Number(options.startTime)) ? Number(options.startTime) : 0;
  const endTime = Number.isFinite(Number(options.endTime)) ? Number(options.endTime) : Date.now();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("Fetch API is not available in this Node.js runtime.");

  const collected = new Map();
  // OKX `after` is exclusive. Add 1 ms on the first page so a candle
  // whose timestamp equals the requested endTime remains inside the range.
  let cursor = endTime + 1;
  let pages = 0;
  let lastOldest = Infinity;

  while (collected.size < limit) {
    const url = new URL(OKX_HISTORY_URL);
    url.searchParams.set("instId", pair);
    url.searchParams.set("bar", toOkxBar(timeframe));
    const requestedPageSize = Math.min(pageSize, limit - collected.size);
    url.searchParams.set("limit", String(requestedPageSize));
    // OKX "after" requests candles strictly older than this timestamp.
    // Apply it on the first page too, so custom endTime really bounds the dataset.
    url.searchParams.set("after", String(cursor));

    let page = null;
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
          throw new Error(body?.msg || "Invalid OKX historical candle response.");
        }
        page = parseOkxCandles(body.data).filter(candle =>
          candle.confirm === "1" && candle.ts <= endTime && (!startTime || candle.ts >= startTime)
        );
        break;
      } catch (error) {
        lastError = error;
        if (attempt + 1 < attempts) await wait(300 * (attempt + 1));
      }
    }
    if (page == null) {
      throw new Error("OKX historical candle request failed for " + pair + " " + timeframe + ": " +
        String(lastError?.message || lastError || "unknown error"));
    }
    if (!page.length) break;

    for (const candle of page) collected.set(candle.ts, candle);
    const oldest = Math.min(...page.map(candle => candle.ts));
    if (oldest >= lastOldest || (startTime && oldest <= startTime) || page.length < 1) break;
    lastOldest = oldest;
    cursor = oldest;
    pages++;
    if (page.length < requestedPageSize) break;
    await wait(120);
  }

  return [...collected.values()].sort((a, b) => a.ts - b.ts).slice(-limit);
}


const AUDIT_TIMEFRAME_MS = Object.freeze({
  "1m":60_000,"3m":180_000,"5m":300_000,"15m":900_000,"30m":1_800_000,
  "1h":3_600_000,"2h":7_200_000,"4h":14_400_000,"6h":21_600_000,
  "12h":43_200_000,"1d":86_400_000,"1w":604_800_000
});

/**
 * Audits a candle series for duplicate timestamps, missing intervals and
 * whether the requested candle count was reached.
 */
export function auditCandleSeries(candles, timeframe, expectedCount = null) {
  const tf = normalizeTimeframe(timeframe);
  const intervalMs = AUDIT_TIMEFRAME_MS[tf];
  if (!intervalMs) throw new RangeError("Unsupported audit timeframe: " + timeframe);
  const timestamps = (Array.isArray(candles) ? candles : [])
    .map(candle => Number(candle?.ts))
    .filter(Number.isFinite)
    .sort((a,b) => a-b);
  let duplicateTimestamps = 0;
  let missingCandles = 0;
  let missingIntervals = 0;
  for (let i=1;i<timestamps.length;i++) {
    const delta = timestamps[i] - timestamps[i-1];
    if (delta === 0) duplicateTimestamps++;
    else if (delta > intervalMs) {
      missingIntervals++;
      missingCandles += Math.max(0, Math.round(delta / intervalMs) - 1);
    }
  }
  const requestedCount = Number.isFinite(Number(expectedCount)) && Number(expectedCount) > 0
    ? Math.floor(Number(expectedCount)) : null;
  return {
    loadedCandles:timestamps.length,
    requestedCandles:requestedCount,
    countReached:requestedCount == null ? null : timestamps.length >= requestedCount,
    duplicateTimestamps,
    missingIntervals,
    missingCandles,
    isContinuous:duplicateTimestamps === 0 && missingCandles === 0
  };
}
