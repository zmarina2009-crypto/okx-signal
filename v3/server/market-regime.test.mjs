import test from "node:test";
import assert from "node:assert/strict";
import { classifyMarketRegime, normalizeMarketRegimeConfig, resolveProfileTimeframe } from "./market-regime.mjs";

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

test("a directional move without confirmed BOS and retest remains WAIT and blocks signals", () => {
  const closes = Array.from({ length: 100 }, (_, i) => 100 + i * 0.25);
  const result = classifyMarketRegime(makeBars(closes), { minVolumeRatio: 0.5 });
  assert.equal(result.state, "WAIT");
  assert.equal(result.direction, null);
  assert.equal(result.actionable, false);
  assert.equal(result.blockSignals, true);
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

test("automatic profile timeframe selects a higher timeframe for each scalping interval", () => {
  assert.equal(resolveProfileTimeframe("1m", "auto"), "15m");
  assert.equal(resolveProfileTimeframe("5m", "auto"), "1h");
  assert.equal(resolveProfileTimeframe("15m", "auto"), "4h");
  assert.equal(resolveProfileTimeframe("1h", "auto"), "1d");
  assert.equal(resolveProfileTimeframe("5m", "4h"), "4h");
});

test("higher timeframe volume profile uses only closed candles and reports POC/value area", () => {
  const lower = makeBars(Array.from({ length: 100 }, (_, i) => 100 + i * 0.02));
  const lastLowerTs = lower.at(-1).ts;
  const higher = Array.from({ length: 40 }, (_, i) => ({
    ts: lastLowerTs - (40 - i) * 15 * 60_000,
    h: 101 + (i % 5) * 0.1,
    l: 99 - (i % 3) * 0.1,
    c: 100 + (i % 4) * 0.05,
    v: 100 + i,
    confirm: "1"
  }));
  higher.push({
    ts: lastLowerTs + 60_000,
    h: 200, l: 199, c: 199.5, v: 1_000_000, confirm: "1"
  });
  const result = classifyMarketRegime(lower, {
    flatFilterEnabled: false,
    marketStructureEnabled: false,
    volumeProfileEnabled: true,
    profileTimeframe: "15m",
    profileLookback: 100
  }, { higherTimeframeBars: higher, timeframe: "1m" });
  const profile = result.metrics.volumeProfile;
  assert.equal(profile.ready, true);
  assert.equal(profile.candles, 40);
  assert.ok(profile.poc >= profile.val && profile.poc <= profile.vah);
  assert.ok(profile.vah > profile.val);
});

test("market regime settings expose bounded BOS, profile and retest parameters", () => {
  const config = normalizeMarketRegimeConfig({
    profileLookback: 999,
    profileBins: 2,
    valueAreaPct: 99,
    retestLookback: 1,
    retestToleranceAtr: 9
  });
  assert.equal(config.profileLookback, 300);
  assert.equal(config.profileBins, 12);
  assert.equal(config.valueAreaPct, 90);
  assert.equal(config.retestLookback, 2);
  assert.equal(config.retestToleranceAtr, 1.5);
});
