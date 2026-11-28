import test from "node:test";
import assert from "node:assert/strict";
import {
  averageVolume,
  createInitialState,
  evaluateScalpingBars,
  normalizePair,
  normalizeTimeframe,
  rsiSeries
} from "./scalping-engine.mjs";

function candles(closes, volumes = []) {
  return closes.map((close, index) => ({
    ts: 1_700_000_000_000 + index * 60_000,
    o: index === 0 ? close : closes[index - 1],
    h: Math.max(close, index === 0 ? close : closes[index - 1]) + 0.5,
    l: Math.min(close, index === 0 ? close : closes[index - 1]) - 0.5,
    c: close,
    v: volumes[index] ?? 10,
    confirm: "1"
  }));
}

test("normalizes perpetual pair symbols and supported timeframe strings", () => {
  assert.equal(normalizePair("zec"), "ZEC-USDT-SWAP");
  assert.equal(normalizePair("ETHUSDT"), "ETH-USDT-SWAP");
  assert.equal(normalizePair("SOL-USDT"), "SOL-USDT-SWAP");
  assert.equal(normalizeTimeframe("1M"), "1m");
  assert.equal(normalizeTimeframe("15m"), "15m");
});

test("average volume excludes the current signal candle", () => {
  const bars = candles([10, 11, 12], [100, 200, 9999]);
  assert.equal(averageVolume(bars, 2), 150);
});

test("RSI follows the first-version Wilder smoothing implementation", () => {
  const bars = candles([100, 99, 98, 97, 98]);
  const values = rsiSeries(bars, 2);
  assert.equal(values[2], 0);
  assert.equal(values[3], 0);
  assert.equal(values[4], 50);
});

test("emits a LONG Volume + RSI signal only after a confirmed candle", () => {
  const bars = candles([100, 99, 98, 97, 98], [10, 10, 10, 10, 100]);
  const result = evaluateScalpingBars(bars, "ZEC", "1m", {
    now: 1_700_000_300_000,
    config: {
      volumePeriod: 2,
      volumeMultiplier: 2,
      rsiLength: 2,
      rsiOversold: 40,
      rsiOverbought: 60,
      swingLength: 1,
      bosEnabled: false,
      bosAlerts: false,
      groupSignals: false,
      cooldownSeconds: 60
    }
  });

  assert.equal(result.processed, true);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].kind, "scalping");
  assert.equal(result.events[0].direction, "LONG");
  assert.ok(result.events[0].message.includes("Volume ×10.00 + RSI 50.0"));
});

test("emits a momentum RSI signal for trend continuation without requiring RSI 70/30 extremes", () => {
  const closes = [100, 101, 102, 103, 104, 103, 102, 103, 104, 105, 106];
  const volumes = closes.map((_, index) => index === closes.length - 1 ? 100 : 10);
  const bars = candles(closes, volumes);
  const result = evaluateScalpingBars(bars, "ZEC", "1m", {
    now: bars.at(-1).ts + 60_000,
    config: {
      volumePeriod: 2, volumeMultiplier: 2, rsiLength: 3,
      rsiOversold: 30, rsiOverbought: 70, swingLength: 1,
      bosEnabled: false, bosAlerts: false, groupSignals: false
    }
  });

  assert.ok(result.events.some(event =>
    event.kind === "scalping" && event.label === "VOL+RSI-MOMENTUM" && event.direction === "LONG"
  ));
  assert.ok(result.events.every(event => event.label !== "VOL+RSI" || event.direction !== "SHORT"));
});

test("does not emit the same candle twice after the state is restored", () => {
  const bars = candles([100, 99, 98, 97, 98], [10, 10, 10, 10, 100]);
  const options = {
    now: 1_700_000_300_000,
    config: {
      volumePeriod: 2,
      volumeMultiplier: 2,
      rsiLength: 2,
      rsiOversold: 40,
      rsiOverbought: 60,
      swingLength: 1,
      bosEnabled: false,
      bosAlerts: false,
      groupSignals: false
    }
  };
  const first = evaluateScalpingBars(bars, "ZEC", "1m", options);
  const second = evaluateScalpingBars(bars, "ZEC", "1m", { ...options, state: first.state });

  assert.equal(first.events.length, 1);
  assert.equal(second.events.length, 0);
  assert.equal(second.reason, "duplicate_candle");
});

test("ignores an unfinished current candle and keeps the previous closed candle", () => {
  const bars = candles([100, 99, 98, 97, 98], [10, 10, 10, 10, 100]);
  bars.push({ ...bars.at(-1), ts: bars.at(-1).ts + 60_000, c: 200, h: 201, v: 5000, confirm: "0" });
  const result = evaluateScalpingBars(bars, "ZEC", "1m", {
    now: 1_700_000_300_000,
    config: {
      volumePeriod: 2, volumeMultiplier: 2, rsiLength: 2,
      rsiOversold: 40, rsiOverbought: 60, swingLength: 1,
      bosEnabled: false, bosAlerts: false, groupSignals: false
    }
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].candleTs, bars[4].ts);
});

test("groups repeated RSI triggers in one trading situation into the original journal entry", () => {
  const config = {
    volumePeriod: 2, volumeMultiplier: 2, rsiLength: 2,
    rsiOversold: 40, rsiOverbought: 80, swingLength: 1,
    bosEnabled: false, bosAlerts: false, groupSignals: true,
    cooldownSeconds: 60, rsiClusterAtrMultiplier: 1
  };
  const firstBars = candles([100, 99, 98, 97, 98], [10, 10, 10, 10, 100]);
  const first = evaluateScalpingBars(firstBars, "ZEC", "1m", { config, now: 1_700_000_300_000 });
  assert.equal(first.events.length, 1);
  assert.ok(first.state.rsiClusters["ZEC-USDT-SWAP|1m"]);

  const secondBars = candles([100, 99, 98, 97, 98, 97, 98], [10, 10, 10, 10, 10, 10, 100]);
  const second = evaluateScalpingBars(secondBars, "ZEC", "1m", {
    config, state: first.state, now: 1_700_000_420_000
  });

  assert.equal(second.events.length, 0);
  assert.equal(second.historyEntries.at(-1).kind, "rsi-repeat");
  const original = second.state.history.find(item => item.kind === "scalping");
  assert.equal(original.mergedCount, 1);
  assert.equal(second.state.rsiClusterSuppressed, 1);
});
