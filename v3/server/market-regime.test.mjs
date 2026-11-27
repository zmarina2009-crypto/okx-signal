import test from "node:test";
import assert from "node:assert/strict";
import { classifyMarketRegime, normalizeMarketRegimeConfig } from "./market-regime.mjs";

function makeBars(closes, volumes = []) {
  return closes.map((close, index) => ({
    ts: 1_700_000_000_000 + index * 60_000,
    h: close + 0.15,
    l: close - 0.15,
    c: close,
    v: volumes[index] ?? 100,
    confirm: "1"
  }));
}

test("market regime settings are normalized and bounded", () => {
  const config = normalizeMarketRegimeConfig({ smaPeriod: 999, maxFlatSlopePct: -2 });
  assert.equal(config.smaPeriod, 200);
  assert.equal(config.maxFlatSlopePct, 0.001);
  assert.equal(config.flatFilterEnabled, true);
});

test("insufficient candle history returns WAIT instead of guessing", () => {
  const result = classifyMarketRegime(makeBars([100, 101, 102]), {});
  assert.equal(result.state, "WAIT");
  assert.equal(result.actionable, false);
});

test("flat market is explicitly blocked", () => {
  const closes = Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i * 0.7) * 0.025);
  const result = classifyMarketRegime(makeBars(closes), {
    smaPeriod: 21, slopeLookback: 5, atrPeriod: 14, volumePeriod: 20,
    maxFlatSlopePct: 0.035, maxFlatRangePct: 0.45, minAtrRatio: 0.65
  });
  assert.equal(result.state, "FLAT");
  assert.equal(result.blockSignals, true);
  assert.equal(result.actionable, false);
});

test("a sustained directional move is classified as trend continuation", () => {
  const closes = Array.from({ length: 100 }, (_, i) => 100 + i * 0.25);
  const result = classifyMarketRegime(makeBars(closes), { minVolumeRatio: 0.5 });
  assert.equal(result.state, "TREND");
  assert.equal(result.direction, "LONG");
  assert.equal(result.actionable, true);
});

test("disabled module never blocks signals", () => {
  const closes = Array.from({ length: 100 }, (_, i) => 100 + i * 0.25);
  const result = classifyMarketRegime(makeBars(closes), { enabled: false });
  assert.equal(result.state, "DISABLED");
  assert.equal(result.blockSignals, undefined);
});

test("rejects overlapping reversal RSI thresholds", () => {
  assert.throws(() => normalizeMarketRegimeConfig({ reversalRsiLongMax: 60, reversalRsiShortMin: 55 }), /below SHORT/);
});
