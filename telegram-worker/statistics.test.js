import test from "node:test";
import assert from "node:assert/strict";
import { updatePerformanceOutcomes, buildPerformanceStats } from "./statistics.js";

test("performance outcomes use the actual 1-minute timeframe", () => {
  const state = {
    performanceSignals: [{
      id: "signal-1", pair: "BTC-USDT-SWAP", tf: "1m", kind: "sma",
      direction: "LONG", detectedAt: 0, entryPrice: 100, outcomes: {}
    }]
  };
  const candles = Array.from({ length: 61 }, (_, i) => ({
    ts: i * 60_000, o: 100 + i, h: 101 + i, l: 99 + i,
    c: 100 + i, v: 1, confirm: true
  }));
  updatePerformanceOutcomes(state, "BTC-USDT-SWAP", "1m", candles);
  assert.equal(state.performanceSignals[0].outcomes["1h"].closePrice, 159);
});

test("unsupported timeframe is rejected instead of silently treated as 15m", () => {
  const state = { performanceSignals: [{
    pair: "BTC-USDT-SWAP", tf: "bad", detectedAt: 0, entryPrice: 100,
    direction: "LONG", outcomes: {}
  }] };
  assert.throws(() => updatePerformanceOutcomes(state, "BTC-USDT-SWAP", "bad", [
    { ts: 0, o: 100, h: 101, l: 99, c: 100, confirm: true }
  ]), /Unsupported timeframe/);
});

test("statistics report signals and performance horizon definitions", () => {
  const stats = buildPerformanceStats({ performanceSignals: [] }, 7);
  assert.equal(stats.signalCount, 0);
  assert.deepEqual(stats.definitions.horizons, ["1h", "4h", "12h"]);
});
