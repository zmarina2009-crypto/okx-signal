import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultWorkerConfig, getEnabledTargets, normalizeWorkerConfig } from "./worker-config.mjs";

test("new worker config is safely disabled and sends no notifications by default", () => {
  const config = createDefaultWorkerConfig();
  assert.equal(config.enabled, false);
  assert.deepEqual(config.targets, []);
  assert.equal(config.notificationSchedule.enabled, false);
  assert.deepEqual(config.notificationSchedule.channels, { push: false, telegram: false });
});

test("normalizes and deduplicates pair/timeframe targets", () => {
  const config = normalizeWorkerConfig({
    enabled: true,
    targets: [
      { pair: "zec", tf: "1M" },
      { pair: "ZEC-USDT-SWAP", tf: "1m" },
      { pair: "SOL-USDT", tf: "15m" }
    ]
  });
  assert.deepEqual(config.targets, [
    { pair: "ZEC-USDT-SWAP", tf: "1m", enabled: true },
    { pair: "SOL-USDT-SWAP", tf: "15m", enabled: true }
  ]);
});

test("rejects non-perpetual pairs, unsupported timeframes, and too many distinct pairs", () => {
  assert.throws(() => normalizeWorkerConfig({ targets: [{ pair: "BTC-USDC-SWAP", tf: "1m" }] }), /USDT perpetual/);
  assert.throws(() => normalizeWorkerConfig({ targets: [{ pair: "BTC", tf: "2m" }] }), /Unsupported OKX timeframe/);
  const targets = Array.from({ length: 21 }, (_, index) => ({ pair: "COIN" + index, tf: "1m" }));
  assert.throws(() => normalizeWorkerConfig({ targets }), /At most 20 distinct/);
});


test("each pair/timeframe target can be enabled or disabled independently", () => {
  const config = normalizeWorkerConfig({
    enabled: true,
    targets: [
      { pair: "XRP", tf: "1m", enabled: true },
      { pair: "XRP", tf: "5m", enabled: false },
      { pair: "SUI", tf: "1m", enabled: true },
      { pair: "ZEC", tf: "15m", enabled: false }
    ]
  });

  assert.deepEqual(config.targets, [
    { pair: "XRP-USDT-SWAP", tf: "1m", enabled: true },
    { pair: "XRP-USDT-SWAP", tf: "5m", enabled: false },
    { pair: "SUI-USDT-SWAP", tf: "1m", enabled: true },
    { pair: "ZEC-USDT-SWAP", tf: "15m", enabled: false }
  ]);
  assert.deepEqual(getEnabledTargets(config).map(target => target.pair + "|" + target.tf), [
    "XRP-USDT-SWAP|1m",
    "SUI-USDT-SWAP|1m"
  ]);
});

test("legacy target configurations default to enabled and disabled targets can be re-enabled", () => {
  const legacy = normalizeWorkerConfig({
    enabled: true,
    targets: [{ pair: "BTC", tf: "1m" }, { pair: "BTC", tf: "5m", enabled: false }]
  });
  assert.equal(legacy.targets[0].enabled, true);
  assert.equal(legacy.targets[1].enabled, false);

  const reEnabled = normalizeWorkerConfig({
    ...legacy,
    targets: legacy.targets.map(target => ({
      ...target,
      enabled: target.pair === "BTC-USDT-SWAP" && target.tf === "5m" ? true : target.enabled
    }))
  });
  assert.equal(getEnabledTargets(reEnabled).length, 2);
});

test("market regime settings are saved with independent flat/trend/reversal switches", () => {
  const config = normalizeWorkerConfig({
    marketRegime: { enabled: true, flatFilterEnabled: false, trendEnabled: true, reversalEnabled: false, smaPeriod: 34 }
  });
  assert.equal(config.marketRegime.enabled, true);
  assert.equal(config.marketRegime.flatFilterEnabled, false);
  assert.equal(config.marketRegime.trendEnabled, true);
  assert.equal(config.marketRegime.reversalEnabled, false);
  assert.equal(config.marketRegime.smaPeriod, 34);
});

test("market regime flat filter is enabled by default for V3", () => {
  const config = createDefaultWorkerConfig();
  assert.equal(config.marketRegime.enabled, true);
  assert.equal(config.marketRegime.flatFilterEnabled, true);
  assert.equal(config.marketRegime.trendEnabled, true);
  assert.equal(config.marketRegime.reversalEnabled, true);
});
