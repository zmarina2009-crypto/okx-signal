import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../scalping-trigger.js", import.meta.url), "utf8");

function createHarness() {
  const store = new Map();
  const localStorage = {
    getItem: (key) => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => store.set(key, String(value))
  };
  const window = { __OKX_SCALPING_TEST__: true };
  const document = {
    readyState: "loading",
    getElementById: () => null,
    addEventListener() {}
  };
  vm.runInNewContext(source, {
    window, document, localStorage, Date, Math, Number, String, Object, Array,
    JSON, Promise, CustomEvent: class {}, console,
    setInterval() { return 0; },
    setTimeout() { return 0; }
  }, { filename: "scalping-trigger.js" });
  assert.ok(window.__OKXScalpingTest, "test API should be exposed in test mode");
  return window.__OKXScalpingTest;
}

function fallingBars(count, lastTs = 1_800_000_000_000) {
  const bars = [];
  for (let i = 0; i < count; i++) {
    const close = 500 - i;
    const previous = i ? bars[i - 1].c : close + 1;
    const isLast = i === count - 1;
    const o = isLast ? close - 0.1 : close + 0.1;
    const c = isLast ? close + 0.1 : close;
    bars.push({
      ts: lastTs + i * 60_000,
      o, h: Math.max(o, c) + 0.2, l: Math.min(o, c) - 0.2,
      c, v: isLast ? 1000 : 100
    });
  }
  return bars;
}

function enableVolumeRsi(api, overrides = {}) {
  api.setConfig({
    enabled: true, volumeRsiEnabled: true, volumePeriod: 20,
    volumeMultiplier: 2, rsiLength: 14, rsiOversold: 30,
    rsiOverbought: 70, bosEnabled: false, bosAlerts: false,
    requireBos: false, longEnabled: true, shortEnabled: true,
    soundEnabled: false, cooldownSeconds: 1,
    ...overrides
  });
}

test("closed-candle Volume + RSI event reaches both journal and chart-marker pipeline", () => {
  const api = createHarness();
  enableVolumeRsi(api);
  api.evaluateBars(fallingBars(100), "SUI-USDT-SWAP", "1m");

  const history = api.getHistory();
  const markers = api.getMarkers();
  assert.equal(history.length, 1);
  assert.equal(history[0].kind, "scalping");
  assert.equal(history[0].direction, "LONG");
  assert.equal(markers.length, 1);
  assert.equal(markers[0].pair, "SUI-USDT-SWAP");
  assert.equal(markers[0].tf, "1m");
});

test("the same closed candle is processed only once", () => {
  const api = createHarness();
  enableVolumeRsi(api);
  const bars = fallingBars(100);
  api.evaluateBars(bars, "SUI-USDT-SWAP", "1m");
  api.evaluateBars(bars, "SUI-USDT-SWAP", "1m");

  assert.equal(api.getHistory().length, 1);
  assert.equal(api.getMarkers().length, 1);
});

test("a 200-candle volume period can be evaluated when enough candles are supplied", () => {
  const api = createHarness();
  enableVolumeRsi(api, { volumePeriod: 200 });
  api.evaluateBars(fallingBars(220), "SUI-USDT-SWAP", "1m");

  assert.equal(api.getHistory().length, 1);
  assert.equal(api.getMarkers().length, 1);
});

test("volume baseline excludes the signal candle", () => {
  const api = createHarness();
  const bars = fallingBars(21);
  for (const bar of bars) bar.v = 10;
  bars[bars.length - 1].v = 1000;

  assert.equal(api.averageVolume(bars, 20), 10);
  assert.equal(api.averageVolume(bars.slice(0, 20), 20), null);
});

test("insufficient candle history is not marked processed and can be retried", () => {
  const api = createHarness();
  enableVolumeRsi(api, { volumePeriod: 20 });
  const bars = fallingBars(20);
  api.evaluateBars(bars, "SUI-USDT-SWAP", "1m");
  assert.equal(api.getHistory().length, 0);

  api.evaluateBars(fallingBars(21), "SUI-USDT-SWAP", "1m");
  assert.equal(api.getHistory().length, 1);
});

test("poll requests enough candles for the configured 200-candle volume period", async () => {
  const api = createHarness();
  enableVolumeRsi(api, { volumePeriod: 200 });
  let requestedLimit = 0;
  api.setApp({
    getState: () => ({ currentPair: "SUI-USDT-SWAP", tf: "1m" }),
    fetchCandles: async (_pair, _tf, limit) => {
      requestedLimit = limit;
      return fallingBars(220);
    }
  });

  await api.poll();
  assert.equal(requestedLimit, 201);
  assert.ok(api.getLastCheckAt() > 0);
  assert.equal(api.getLastPollSummary(), "1/1 пар");
  assert.equal(api.getLastPollError(), "");
});

test("a failed candle request is surfaced and does not advance successful-check time", async () => {
  const api = createHarness();
  enableVolumeRsi(api);
  api.setApp({
    getState: () => ({ currentPair: "SUI-USDT-SWAP", tf: "1m" }),
    fetchCandles: async () => { throw new Error("OKX timeout"); }
  });

  await api.poll();
  assert.equal(api.getLastCheckAt(), 0);
  assert.match(api.getLastPollError(), /OKX timeout/);
  assert.equal(api.getLastPollSummary(), "0/1 пар");
});
