const HORIZONS = [
  { key: "1h", ms: 60 * 60 * 1000 },
  { key: "4h", ms: 4 * 60 * 60 * 1000 },
  { key: "12h", ms: 12 * 60 * 60 * 1000 }
];

function signedReturn(direction, entry, exit) {
  if (!(entry > 0) || !(exit > 0)) return null;
  const raw = (exit - entry) / entry * 100;
  return direction === "SHORT" ? -raw : raw;
}

export function recordPerformanceSignal(state, { pair, tf, kind, direction, ts, price }) {
  if (!(price > 0) || !Number.isFinite(ts)) return;
  state.performanceSignals ||= [];
  const detectedAt = Date.now();
  const id = [pair, tf, kind, direction, ts, Math.round(price * 1e8)].join(":");
  if (state.performanceSignals.some(signal => signal.id === id)) return;
  state.performanceSignals.push({
    id, pair, tf, kind, direction, candleTs: ts, detectedAt,
    entryPrice: price, outcomes: {}
  });
  // Keep a bounded history; the persistent Railway volume survives restarts.
  state.performanceSignals = state.performanceSignals.slice(-2500);
}

export function updatePerformanceOutcomes(state, pair, tf, candles) {
  const signals = state.performanceSignals || [];
  const closed = candles.filter(c => c.confirm);
  if (!closed.length) return;
  const tfMs = timeframeMs(tf);
  for (const signal of signals) {
    if (signal.pair !== pair || signal.tf !== tf) continue;
    for (const horizon of HORIZONS) {
      if (signal.outcomes?.[horizon.key]) continue;
      const targetTime = signal.detectedAt + horizon.ms;
      // Use the first confirmed candle that closes at or after the target horizon.
      const target = closed.find(c => c.ts + tfMs >= targetTime);
      if (!target || target.ts + tfMs < targetTime) continue;
      const window = closed.filter(c => c.ts + tfMs > signal.detectedAt && c.ts <= target.ts);
      if (!window.length) continue;
      const adverse = signal.direction === "LONG"
        ? Math.max(0, signal.entryPrice - Math.min(...window.map(c => c.l)))
        : Math.max(...window.map(c => c.h)) - signal.entryPrice;
      const mfePct = signal.direction === "LONG"
        ? Math.max(0, (Math.max(...window.map(c => c.h)) - signal.entryPrice) / signal.entryPrice * 100)
        : Math.max(0, (signal.entryPrice - Math.min(...window.map(c => c.l))) / signal.entryPrice * 100);
      const maePct = adverse / signal.entryPrice * 100;
      signal.outcomes[horizon.key] = {
        evaluatedAt: Date.now(),
        closePrice: target.c,
        directionalReturnPct: signedReturn(signal.direction, signal.entryPrice, target.c),
        mfePct, maePct
      };
    }
  }
}

function timeframeMs(tf) {
  const match = String(tf).toLowerCase().match(/^(\\d+)(m|h|d|w)$/);
  if (!match) return 15 * 60 * 1000;
  return Number(match[1]) * ({ m: 60000, h: 3600000, d: 86400000, w: 604800000 })[match[2]];
}

export function buildPerformanceStats(state, days = 7) {
  const cutoff = Date.now() - Math.max(1, Math.min(90, Number(days) || 7)) * 86400000;
  const signals = (state.performanceSignals || []).filter(s => s.detectedAt >= cutoff);
  const groups = new Map();
  for (const signal of signals) {
    const key = [signal.pair, signal.kind, signal.direction].join(" | ");
    if (!groups.has(key)) groups.set(key, { pair: signal.pair, kind: signal.kind, direction: signal.direction, signals: 0, horizons: {} });
    const group = groups.get(key);
    group.signals += 1;
    for (const horizon of HORIZONS) {
      const outcome = signal.outcomes?.[horizon.key];
      group.horizons[horizon.key] ||= { evaluated: 0, wins: 0, avgReturnPct: null, avgMfePct: null, avgMaePct: null, _returns: [], _mfe: [], _mae: [] };
      if (!outcome) continue;
      const h = group.horizons[horizon.key];
      h.evaluated += 1;
      if (outcome.directionalReturnPct > 0) h.wins += 1;
      h._returns.push(outcome.directionalReturnPct);
      h._mfe.push(outcome.mfePct);
      h._mae.push(outcome.maePct);
    }
  }
  const result = [...groups.values()].map(group => {
    for (const horizon of HORIZONS) {
      const h = group.horizons[horizon.key];
      for (const [field, source] of [["avgReturnPct", "_returns"], ["avgMfePct", "_mfe"], ["avgMaePct", "_mae"]]) {
        h[field] = h[source].length ? Number((h[source].reduce((a, b) => a + b, 0) / h[source].length).toFixed(4)) : null;
        delete h[source];
      }
      h.winRatePct = h.evaluated ? Number((h.wins / h.evaluated * 100).toFixed(2)) : null;
    }
    return group;
  });
  return {
    generatedAt: new Date().toISOString(),
    periodDays: Math.max(1, Math.min(90, Number(days) || 7)),
    signalCount: signals.length,
    pending12h: signals.filter(s => !s.outcomes?.["12h"]).length,
    definitions: {
      directionalReturnPct: "Price change in signal direction; excludes fees, funding and slippage.",
      mfePct: "Maximum favourable intrahorizon price excursion.",
      maePct: "Maximum adverse intrahorizon price excursion.",
      horizons: ["1h", "4h", "12h"]
    },
    groups: result
  };
}
