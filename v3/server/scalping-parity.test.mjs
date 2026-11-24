import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { evaluateScalpingBars } from "./scalping-engine.mjs";

const v1Source = fs.readFileSync(new URL("../../scalping-trigger.js", import.meta.url), "utf8");

function createV1Harness() {
  const storage = new Map();
  const localStorage = {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value))
  };
  const window = { __OKX_SCALPING_TEST__: true };
  const document = {
    readyState: "loading",
    getElementById: () => null,
    addEventListener() {}
  };

  vm.runInNewContext(v1Source, {
    window, document, localStorage, Date, Math, Number, String, Object, Array,
    JSON, Promise, CustomEvent: class {}, console,
    setInterval() { return 0; }
  }, { filename: "scalping-trigger.js" });

  assert.ok(window.__OKXScalpingTest, "v1 test API should be available");
  const api = window.__OKXScalpingTest;
  api.setConfig({ soundEnabled: false });
  return api;
}

function candles(closes, volumes = []) {
  return closes.map((close, index) => {
    const previous = index === 0 ? close : closes[index - 1];
    return {
      ts: 1_700_000_000_000 + index * 60_000,
      o: previous,
      h: Math.max(close, previous) + 0.5,
      l: Math.min(close, previous) - 0.5,
      c: close,
      v: volumes[index] ?? 10,
      confirm: "1"
    };
  });
}

function fieldsFromV1(history) {
  return JSON.parse(JSON.stringify(history.map(item => ({
    kind: item.kind,
    pair: item.pair,
    tf: item.tf,
    direction: item.direction,
    message: item.message,
    price: item.price,
    candleTs: item.ts
  }))));
}

function fieldsFromV3(events) {
  return JSON.parse(JSON.stringify(events.map(item => ({
    kind: item.kind,
    pair: item.pair,
    tf: item.tf,
    direction: item.direction,
    message: item.message,
    price: item.price,
    candleTs: item.candleTs
  }))));
}

const baseConfig = {
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
};

test("v3 Volume + RSI LONG and SHORT match the first-version signal output", () => {
  for (const [pair, closes, direction] of [
    ["ZEC", [100, 99, 98, 97, 98], "LONG"],
    ["SOL", [100, 101, 102, 103, 102], "SHORT"]
  ]) {
    const bars = candles(closes, [10, 10, 10, 10, 100]);
    const v1 = createV1Harness();
    v1.setConfig({ ...baseConfig, soundEnabled: false });
    v1.evaluateBars(bars, pair + "-USDT-SWAP", "1m");

    const v3 = evaluateScalpingBars(bars, pair, "1m", {
      config: baseConfig,
      now: 1_700_000_300_000
    });

    assert.deepEqual(fieldsFromV3(v3.events), fieldsFromV1(v1.getHistory()));
    assert.equal(v3.events[0]?.direction, direction);
  }
});

test("v3 BOS alert matches the first-version BOS direction, level, and message", () => {
  const bars = [
    { ts: 1, o: 100, h: 100.5, l: 99, c: 100, v: 10, confirm: "1" },
    { ts: 2, o: 100, h: 103, l: 100, c: 102, v: 10, confirm: "1" },
    { ts: 3, o: 102, h: 104, l: 101, c: 103, v: 10, confirm: "1" },
    { ts: 4, o: 103, h: 106, l: 102, c: 104, v: 10, confirm: "1" },
    { ts: 5, o: 104, h: 105, l: 103, c: 104, v: 10, confirm: "1" },
    { ts: 6, o: 104, h: 105, l: 103, c: 104, v: 10, confirm: "1" },
    { ts: 7, o: 104, h: 108, l: 104, c: 107, v: 10, confirm: "1" }
  ];
  const config = {
    ...baseConfig,
    volumeRsiEnabled: false,
    bosEnabled: true,
    bosAlerts: true
  };
  const v1 = createV1Harness();
  v1.setConfig({ ...config, soundEnabled: false });
  v1.evaluateBars(bars, "BTC-USDT-SWAP", "1m");

  const v3 = evaluateScalpingBars(bars, "BTC", "1m", {
    config,
    now: 1_700_000_300_000
  });

  assert.deepEqual(fieldsFromV3(v3.events), fieldsFromV1(v1.getHistory()));
  assert.equal(v3.events[0]?.direction, "LONG");
  assert.equal(v3.events[0]?.price, 106);
});

test("v3 RSI grouping matches first-version repeat suppression and journal entries", () => {
  const config = { ...baseConfig, groupSignals: true, rsiOverbought: 80 };
  const firstBars = candles([100, 99, 98, 97, 98], [10, 10, 10, 10, 100]);
  const secondBars = candles([100, 99, 98, 97, 98, 97, 98], [10, 10, 10, 10, 100, 10, 200]);

  const v1 = createV1Harness();
  v1.setConfig({ ...config, soundEnabled: false });
  v1.evaluateBars(firstBars, "ZEC-USDT-SWAP", "1m");
  const firstV1Count = v1.getHistory().length;
  v1.evaluateBars(secondBars, "ZEC-USDT-SWAP", "1m");

  const firstV3 = evaluateScalpingBars(firstBars, "ZEC", "1m", {
    config,
    now: 1_700_000_300_000
  });
  const secondV3 = evaluateScalpingBars(secondBars, "ZEC", "1m", {
    config,
    state: firstV3.state,
    now: 1_700_000_420_000
  });

  assert.equal(firstV1Count, 1);
  assert.equal(v1.getHistory().length, 2);
  assert.equal(v1.getHistory()[1]?.kind, "rsi-repeat");
  assert.equal(secondV3.events.length, 0);
  assert.equal(secondV3.historyEntries.at(-1)?.kind, "rsi-repeat");
  assert.equal(secondV3.state.rsiClusterSuppressed, v1.getState().rsiClusterSuppressed);
});
