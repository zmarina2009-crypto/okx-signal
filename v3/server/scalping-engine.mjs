const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  volumeRsiEnabled: true,
  volumePeriod: 20,
  volumeMultiplier: 2,
  rsiLength: 14,
  rsiOversold: 30,
  rsiOverbought: 70,
  bosEnabled: true,
  bosAlerts: true,
  swingLength: 3,
  requireBos: false,
  longEnabled: true,
  shortEnabled: true,
  cooldownSeconds: 60,
  rsiClusterAtrMultiplier: 1,
  groupSignals: true
});

const HISTORY_LIMIT = 500;
const FIRED_LIMIT = 500;

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(number) ? number : fallback));
}

export function normalizePair(value) {
  const pair = String(value || "").trim().toUpperCase();
  if (!pair) return "";
  if (pair.endsWith("-USDT-SWAP")) return pair;
  if (pair.endsWith("-USDT")) return pair + "-SWAP";
  if (pair.endsWith("USDT")) return pair.slice(0, -4) + "-USDT-SWAP";
  return pair.replace(/[^A-Z0-9-]/g, "") + "-USDT-SWAP";
}

export function normalizeTimeframe(value) {
  const tf = String(value || "1m").trim().toLowerCase();
  return /^(\d+)(m|h|d|w)$/.test(tf) ? tf : "1m";
}

export function normalizeConfig(input = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...input };
  cfg.enabled = cfg.enabled !== false;
  cfg.volumeRsiEnabled = cfg.volumeRsiEnabled !== false;
  cfg.volumePeriod = Math.round(clamp(cfg.volumePeriod, 2, 200, DEFAULT_CONFIG.volumePeriod));
  cfg.volumeMultiplier = clamp(cfg.volumeMultiplier, 1, 20, DEFAULT_CONFIG.volumeMultiplier);
  cfg.rsiLength = Math.round(clamp(cfg.rsiLength, 2, 100, DEFAULT_CONFIG.rsiLength));
  cfg.rsiOversold = Math.round(clamp(cfg.rsiOversold, 1, 49, DEFAULT_CONFIG.rsiOversold));
  cfg.rsiOverbought = Math.round(clamp(cfg.rsiOverbought, 51, 99, DEFAULT_CONFIG.rsiOverbought));
  cfg.swingLength = Math.round(clamp(cfg.swingLength, 1, 20, DEFAULT_CONFIG.swingLength));
  cfg.cooldownSeconds = Math.round(clamp(cfg.cooldownSeconds, 1, 86400, DEFAULT_CONFIG.cooldownSeconds));
  cfg.rsiClusterAtrMultiplier = clamp(cfg.rsiClusterAtrMultiplier, 0.25, 3, DEFAULT_CONFIG.rsiClusterAtrMultiplier);
  cfg.bosEnabled = cfg.bosEnabled !== false;
  cfg.bosAlerts = cfg.bosAlerts !== false;
  cfg.requireBos = cfg.requireBos === true;
  cfg.longEnabled = cfg.longEnabled !== false;
  cfg.shortEnabled = cfg.shortEnabled !== false;
  cfg.groupSignals = cfg.groupSignals !== false;
  if (cfg.rsiOversold >= cfg.rsiOverbought) {
    throw new RangeError("RSI oversold must be below RSI overbought.");
  }
  return cfg;
}

export function createInitialState(existing = {}) {
  return {
    processed: { ...(existing.processed || {}) },
    fired: Array.isArray(existing.fired) ? existing.fired.slice(-FIRED_LIMIT) : [],
    lastAlertAt: { ...(existing.lastAlertAt || {}) },
    rsiClusters: Object.fromEntries(
      Object.entries(existing.rsiClusters || {}).map(([key, value]) => [key, { ...value }])
    ),
    rsiClusterSuppressed: Math.max(0, Number(existing.rsiClusterSuppressed) || 0),
    history: Array.isArray(existing.history) ? existing.history.slice(-HISTORY_LIMIT) : []
  };
}

function normalizeCandles(rawBars) {
  if (!Array.isArray(rawBars)) return [];
  const byTimestamp = new Map();
  for (const raw of rawBars) {
    if (!raw || raw.confirm === false || String(raw.confirm ?? "1") === "0") continue;
    const candle = {
      ts: Number(raw.ts),
      o: Number(raw.o),
      h: Number(raw.h),
      l: Number(raw.l),
      c: Number(raw.c),
      v: Number(raw.v),
      confirm: true
    };
    if (![candle.ts, candle.o, candle.h, candle.l, candle.c, candle.v].every(Number.isFinite)) continue;
    if (candle.ts <= 0 || candle.c <= 0 || candle.v < 0 || candle.h < candle.l) continue;
    byTimestamp.set(candle.ts, candle);
  }
  return [...byTimestamp.values()].sort((a, b) => a.ts - b.ts);
}

export function rsiSeries(bars, period) {
  const out = new Array(bars.length).fill(null);
  if (!Array.isArray(bars) || !Number.isInteger(period) || period < 2 || bars.length <= period) return out;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = Number(bars[i].c) - Number(bars[i - 1].c);
    if (!Number.isFinite(change)) return out;
    if (change > 0) gains += change;
    else losses -= change;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  const value = () => avgLoss === 0 ? 100 : avgGain === 0 ? 0 : 100 - 100 / (1 + avgGain / avgLoss);
  out[period] = value();

  for (let i = period + 1; i < bars.length; i++) {
    const change = Number(bars[i].c) - Number(bars[i - 1].c);
    if (!Number.isFinite(change)) return out;
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = value();
  }
  return out;
}

export function averageVolume(bars, period) {
  // Match v1: compare the current signal candle only with the preceding completed candles.
  if (!Array.isArray(bars) || !Number.isInteger(period) || period < 1 || bars.length <= period) return null;
  let sum = 0;
  const end = bars.length - 1;
  for (let i = end - period; i < end; i++) {
    const value = Number(bars[i]?.v);
    if (!Number.isFinite(value) || value < 0) return null;
    sum += value;
  }
  return sum / period;
}

export function averageTrueRange(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length < 2) return null;
  const length = Math.max(1, Number(period) || 14);
  const start = Math.max(1, bars.length - length);
  let total = 0;
  let count = 0;
  for (let i = start; i < bars.length; i++) {
    const high = Number(bars[i].h);
    const low = Number(bars[i].l);
    const previousClose = Number(bars[i - 1].c);
    if (![high, low, previousClose].every(Number.isFinite)) continue;
    const range = Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
    if (Number.isFinite(range) && range >= 0) {
      total += range;
      count++;
    }
  }
  return count ? total / count : null;
}

export function latestConfirmedPivot(bars, length, type) {
  const field = type === "high" ? "h" : "l";
  if (!Array.isArray(bars) || !Number.isInteger(length) || length < 1 || !["high", "low"].includes(type)) return null;
  for (let i = bars.length - 1 - length; i >= length; i--) {
    const candidate = Number(bars[i]?.[field]);
    if (!Number.isFinite(candidate)) continue;
    let pivot = true;
    for (let j = i - length; j <= i + length; j++) {
      if (j === i) continue;
      const other = Number(bars[j]?.[field]);
      if (!Number.isFinite(other) || (type === "high" ? other >= candidate : other <= candidate)) {
        pivot = false;
        break;
      }
    }
    if (pivot) return { price: candidate, ts: Number(bars[i].ts), index: i };
  }
  return null;
}

export function detectBos(bars, swingLength = DEFAULT_CONFIG.swingLength, enabled = true) {
  const length = Math.round(clamp(swingLength, 1, 20, DEFAULT_CONFIG.swingLength));
  if (!enabled || bars.length < length * 2 + 3) return null;
  const previousClose = Number(bars[bars.length - 2].c);
  const close = Number(bars[bars.length - 1].c);
  if (![previousClose, close].every(Number.isFinite)) return null;

  const highPivot = latestConfirmedPivot(bars, length, "high");
  const lowPivot = latestConfirmedPivot(bars, length, "low");

  if (highPivot && previousClose <= highPivot.price && close > highPivot.price) {
    return { direction: "LONG", level: highPivot.price, pivotTs: highPivot.ts, label: "BOS ↑" };
  }
  if (lowPivot && previousClose >= lowPivot.price && close < lowPivot.price) {
    return { direction: "SHORT", level: lowPivot.price, pivotTs: lowPivot.ts, label: "BOS ↓" };
  }
  return null;
}

function appendHistory(state, item) {
  state.history.push(item);
  if (state.history.length > HISTORY_LIMIT) state.history = state.history.slice(-HISTORY_LIMIT);
  return item;
}

function emitSignal({ state, events, cfg, kind, pair, tf, candle, direction, price, label, message, uniqueId, zoneRadius, now }) {
  if ((direction === "LONG" && !cfg.longEnabled) || (direction === "SHORT" && !cfg.shortEnabled)) return null;
  if (state.fired.includes(uniqueId)) return null;

  const alertKey = [kind, pair, tf, direction].join("|");
  const previous = Number(state.lastAlertAt[alertKey]) || 0;
  if (now - previous < cfg.cooldownSeconds * 1000) return null;

  state.lastAlertAt[alertKey] = now;
  state.fired.push(uniqueId);
  if (state.fired.length > FIRED_LIMIT) state.fired = state.fired.slice(-FIRED_LIMIT);

  const item = appendHistory(state, {
    id: uniqueId,
    kind,
    pair,
    tf,
    direction,
    label,
    message,
    signalTs: Number(candle.ts),
    detectedAt: now,
    price: Number(price),
    mergedCount: 0
  });

  events.push({
    id: uniqueId,
    kind,
    pair,
    tf,
    direction,
    label,
    message,
    candleTs: Number(candle.ts),
    detectedAt: now,
    price: Number(price),
    zoneRadius: Number(zoneRadius) || null
  });
  return item;
}

function rsiClusterKey(pair, tf) {
  return pair + "|" + tf;
}

function updateRsiCluster(state, pair, tf, candle, currentRsi) {
  const key = rsiClusterKey(pair, tf);
  const cluster = state.rsiClusters[key];
  if (!cluster) return;

  const close = Number(candle.c);
  if (!Number.isFinite(close) || !Number.isFinite(Number(cluster.anchorPrice))) return;
  const rsi = Number(currentRsi);
  if (Number.isFinite(rsi)) {
    if (cluster.direction === "LONG" && rsi >= cluster.resetRsi) cluster.neutralSeen = true;
    if (cluster.direction === "SHORT" && rsi <= cluster.resetRsi) cluster.neutralSeen = true;
  }

  const movedOutsideZone = Math.abs(close - Number(cluster.anchorPrice)) >= Number(cluster.radius);
  if (cluster.neutralSeen && movedOutsideZone) delete state.rsiClusters[key];
}

function mergeRsiRepeat(state, pair, tf, candle, direction, cfg, now) {
  if (!cfg.groupSignals) return false;
  const key = rsiClusterKey(pair, tf);
  const cluster = state.rsiClusters[key];
  if (!cluster || cluster.direction !== direction) return false;

  const price = Number(candle.c);
  const distance = Number.isFinite(price) ? Math.abs(price - Number(cluster.anchorPrice)) : 0;
  if (distance >= Number(cluster.radius) && cluster.neutralSeen) {
    delete state.rsiClusters[key];
    return false;
  }

  cluster.suppressedCount = (Number(cluster.suppressedCount) || 0) + 1;
  cluster.lastSuppressedTs = Number(candle.ts) || now;
  cluster.lastSuppressedPrice = Number.isFinite(price) ? price : null;
  cluster.lastSuppressedDirection = direction;
  state.rsiClusterSuppressed++;

  appendHistory(state, {
    id: ["rsi-repeat", pair, tf, candle.ts, direction].join("|"),
    kind: "rsi-repeat",
    pair,
    tf,
    direction,
    message: "Повтор RSI в текущей торговой ситуации · маркер объединён · повтор №" + cluster.suppressedCount,
    signalTs: Number(candle.ts),
    detectedAt: now,
    price: Number.isFinite(price) ? price : null,
    mergedIntoSignalTs: Number(cluster.historySignalTs)
  });

  const original = state.history.find(item =>
    item && item.kind === "scalping" &&
    item.pair === pair && normalizeTimeframe(item.tf) === tf &&
    Number(item.signalTs) === Number(cluster.historySignalTs)
  );
  if (original) {
    original.mergedCount = (Number(original.mergedCount) || 0) + 1;
    original.lastMergedTs = now;
    original.lastMergedPrice = Number.isFinite(price) ? price : null;
    original.lastMergedDirection = direction;
  }
  return true;
}

function startRsiCluster(state, pair, tf, candle, direction, price, bars, cfg, historyItem) {
  if (!cfg.groupSignals) return;
  const atr = averageTrueRange(bars, 14);
  const fallbackFloor = Math.max(Math.abs(Number(price)) * 0.00025, 0.01);
  const radius = Math.max((Number(atr) || 0) * cfg.rsiClusterAtrMultiplier, fallbackFloor);
  const resetRsi = direction === "LONG"
    ? Math.min(60, Math.max(cfg.rsiOversold + 10, 40))
    : Math.max(40, Math.min(cfg.rsiOverbought - 10, 60));
  state.rsiClusters[rsiClusterKey(pair, tf)] = {
    direction,
    anchorPrice: Number(price),
    anchorTs: Number(candle.ts) || Date.now(),
    radius,
    atr: Number(atr) || null,
    resetRsi,
    neutralSeen: false,
    historySignalTs: Number(historyItem?.signalTs) || Number(candle.ts),
    suppressedCount: 0
  };
}

export function evaluateScalpingBars(rawBars, rawPair, rawTf, options = {}) {
  const cfg = normalizeConfig(options.config || {});
  const state = createInitialState(options.state || {});
  const pair = normalizePair(rawPair);
  const tf = normalizeTimeframe(rawTf);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const events = [];
  const originalHistoryLength = state.history.length;

  if (!pair) return { events, historyEntries: [], state, processed: false, reason: "invalid_pair" };
  if (!cfg.enabled) return { events, historyEntries: [], state, processed: false, reason: "disabled" };

  const bars = normalizeCandles(rawBars);
  if (bars.length < 3) return { events, historyEntries: [], state, processed: false, reason: "no_confirmed_candles" };

  const candle = bars[bars.length - 1];
  const candleTs = Number(candle.ts);
  const scopeKey = pair + "|" + tf;
  if (Number(state.processed[scopeKey]) === candleTs) {
    return { events, historyEntries: [], state, processed: false, reason: "duplicate_candle" };
  }

  const required = Math.max(cfg.volumePeriod + 1, cfg.rsiLength + 1, cfg.swingLength * 2 + 3);
  if (bars.length < required) {
    return { events, historyEntries: [], state, processed: false, reason: "insufficient_history", required, received: bars.length };
  }

  const baseVolume = averageVolume(bars, cfg.volumePeriod);
  const volume = Number(candle.v);
  const volumeSpike = baseVolume != null && baseVolume > 0 && volume > baseVolume * cfg.volumeMultiplier;

  const values = rsiSeries(bars, cfg.rsiLength);
  const currentRsi = values[values.length - 1];
  const previousRsi = values[values.length - 2];
  updateRsiCluster(state, pair, tf, candle, currentRsi);

  // Reversal RSI must actually turn away from the extreme zone.
  // Merely remaining overbought/oversold is not a reversal confirmation.
  const rsiLong = currentRsi != null && previousRsi != null &&
    currentRsi > previousRsi &&
    (previousRsi <= cfg.rsiOversold || currentRsi <= cfg.rsiOversold);
  const rsiShort = currentRsi != null && previousRsi != null &&
    currentRsi < previousRsi &&
    (previousRsi >= cfg.rsiOverbought || currentRsi >= cfg.rsiOverbought);

  const bos = detectBos(bars, cfg.swingLength, cfg.bosEnabled);
  if (bos && cfg.bosEnabled && cfg.bosAlerts) {
    const pivotId = ["bos", pair, tf, bos.direction, bos.pivotTs].join("|");
    const bosZoneRadius = Math.max((averageTrueRange(bars, 14) || 0) * 1.25, Math.abs(Number(candle.c) || 0) * 0.00025);
    emitSignal({
      state, events, cfg, kind: "bos", pair, tf, candle,
      direction: bos.direction, price: bos.level, label: bos.label,
      message: (bos.direction === "LONG" ? "🟢 " : "🔴 ") + bos.label + " • пробой " +
        bos.level.toFixed(6) + " • " + pair + " • " + tf,
      uniqueId: pivotId, zoneRadius: bosZoneRadius, now
    });
  }

  if (cfg.volumeRsiEnabled && volumeSpike) {
    const candidates = [];
    if (rsiLong) candidates.push("LONG");
    if (rsiShort) candidates.push("SHORT");

    for (const direction of candidates) {
      if (cfg.requireBos && (!bos || bos.direction !== direction)) continue;
      if (mergeRsiRepeat(state, pair, tf, candle, direction, cfg, now)) continue;

      const id = ["volume-rsi", pair, tf, candleTs, direction].join("|");
      const label = cfg.requireBos ? "VOL+RSI+BOS" : "VOL+RSI";
      const message = (direction === "LONG" ? "⚡ LONG" : "⚡ SHORT") +
        " • Volume ×" + (volume / baseVolume).toFixed(2) +
        " + RSI " + Number(currentRsi).toFixed(1) +
        (cfg.requireBos ? " + BOS" : "") + " • " + pair + " • " + tf;
      const historyItem = emitSignal({
        state, events, cfg, kind: "scalping", pair, tf, candle,
        direction, price: Number(candle.c), label, message,
        uniqueId: id, now
      });
      if (historyItem) startRsiCluster(state, pair, tf, candle, direction, Number(candle.c), bars, cfg, historyItem);
    }
  }

  // Trend continuation uses RSI momentum around the 50 line, not the
  // oversold/overbought reversal thresholds. Reversal signals above remain
  // unchanged and keep their existing RSI-cluster behavior.
  if (cfg.volumeRsiEnabled && volumeSpike && currentRsi != null && previousRsi != null) {
    const momentumCandidates = [];
    if (currentRsi > 50 && currentRsi > previousRsi) momentumCandidates.push("LONG");
    if (currentRsi < 50 && currentRsi < previousRsi) momentumCandidates.push("SHORT");

    for (const direction of momentumCandidates) {
      if (cfg.requireBos && (!bos || bos.direction !== direction)) continue;
      // Momentum and reversal triggers in the same direction belong to one
      // active price situation and should share the existing journal cluster.
      if (mergeRsiRepeat(state, pair, tf, candle, direction, cfg, now)) continue;
      const id = ["volume-rsi-momentum", pair, tf, candleTs, direction].join("|");
      const label = "VOL+RSI-MOMENTUM";
      const message = (direction === "LONG" ? "⚡ LONG" : "⚡ SHORT") +
        " • Volume ×" + (volume / baseVolume).toFixed(2) +
        " + RSI momentum " + Number(currentRsi).toFixed(1) +
        " • " + pair + " • " + tf;
      const historyItem = emitSignal({
        state, events, cfg, kind: "scalping", pair, tf, candle,
        direction, price: Number(candle.c), label, message,
        uniqueId: id, now
      });
      if (historyItem) startRsiCluster(state, pair, tf, candle, direction, Number(candle.c), bars, cfg, historyItem);
    }
  }

  state.processed[scopeKey] = candleTs;
  return {
    events,
    historyEntries: state.history.slice(originalHistoryLength),
    state,
    processed: true,
    reason: "processed",
    metrics: { volume, averageVolume: baseVolume, volumeMultiple: baseVolume > 0 ? volume / baseVolume : null, rsi: currentRsi, previousRsi, bos }
  };
}
