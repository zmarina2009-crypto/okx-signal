import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultWorkerConfig, normalizeWorkerConfig } from "./worker-config.mjs";

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
    { pair: "ZEC-USDT-SWAP", tf: "1m" },
    { pair: "SOL-USDT-SWAP", tf: "15m" }
  ]);
});

test("rejects non-perpetual pairs, unsupported timeframes, and too many distinct pairs", () => {
  assert.throws(() => normalizeWorkerConfig({ targets: [{ pair: "BTC-USDC-SWAP", tf: "1m" }] }), /USDT perpetual/);
  assert.throws(() => normalizeWorkerConfig({ targets: [{ pair: "BTC", tf: "2m" }] }), /Unsupported OKX timeframe/);
  const targets = Array.from({ length: 21 }, (_, index) => ({ pair: "COIN" + index, tf: "1m" }));
  assert.throws(() => normalizeWorkerConfig({ targets }), /At most 20 distinct/);
});
