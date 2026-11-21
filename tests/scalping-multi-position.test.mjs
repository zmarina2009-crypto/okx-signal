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
  const document = { readyState: "loading", getElementById: () => null, addEventListener() {} };
  vm.runInNewContext(source, {
    window, document, localStorage, Date, Math, Number, String, Object, Array,
    JSON, Promise, CustomEvent: class {}, console, setInterval() { return 0; }
  }, { filename: "scalping-trigger.js" });
  assert.ok(window.__OKXScalpingTest);
  return window.__OKXScalpingTest;
}

test("multi-position mode tracks up to three independently selected pairs and timeframes", () => {
  const api = createHarness();
  api.setConfig({
    scope: "multi",
    slots: [
      { enabled: true, pair: "ZEC", tf: "1m" },
      { enabled: true, pair: "SOL-USDT", tf: "5m" },
      { enabled: false, pair: "SUI", tf: "15m" }
    ]
  });
  assert.deepEqual(JSON.parse(JSON.stringify(api.getTargets().targets)), [
    { pair: "ZEC-USDT-SWAP", tf: "1m" },
    { pair: "SOL-USDT-SWAP", tf: "5m" }
  ]);
});

test("multi-position mode ignores disabled slots and deduplicates repeated pair/timeframe", () => {
  const api = createHarness();
  api.setConfig({
    scope: "multi",
    slots: [
      { enabled: true, pair: "BTC", tf: "1m" },
      { enabled: true, pair: "BTC-USDT-SWAP", tf: "1m" },
      { enabled: true, pair: "BTC", tf: "5m" }
    ]
  });
  assert.deepEqual(JSON.parse(JSON.stringify(api.getTargets().targets)), [
    { pair: "BTC-USDT-SWAP", tf: "1m" },
    { pair: "BTC-USDT-SWAP", tf: "5m" }
  ]);
});

test("pair normalization accepts ticker, USDT symbol and full OKX instrument", () => {
  const api = createHarness();
  assert.equal(api.normalizePair("ETH"), "ETH-USDT-SWAP");
  assert.equal(api.normalizePair("ETHUSDT"), "ETH-USDT-SWAP");
  assert.equal(api.normalizePair("ETH-USDT"), "ETH-USDT-SWAP");
  assert.equal(api.normalizePair("ETH-USDT-SWAP"), "ETH-USDT-SWAP");
});

test("favorites list is loaded from the active saved watchlist and other saved lists", () => {
  const api = createHarness();
  api.setLocalStorage("okx_v2_watchlists", JSON.stringify({
    "Избранное": ["ZEC", "SOL", "BTC"],
    "Альтернативы": ["SOL", "NEAR"]
  }));
  api.setLocalStorage("okx_v2_active_watchlist", "Избранное");
  assert.deepEqual(JSON.parse(JSON.stringify(api.favoritePairs())), ["ZEC", "SOL", "BTC", "NEAR"]);
});

test("favorites fall back to the custom pair list when no saved lists exist", () => {
  const api = createHarness();
  api.setLocalStorage("okx_v2_custom_coins", JSON.stringify(["ZEC", "SOL-USDT", "BTCUSDT"]));
  assert.deepEqual(JSON.parse(JSON.stringify(api.favoritePairs())), ["ZEC", "SOL", "BTC"]);
});

test("multi-position polling requests each selected pair and reports per-pair status", async () => {
  const api = createHarness();
  const calls = [];
  const bars = Array.from({ length: 120 }, (_, index) => ({
    ts: 1700000000000 + index * 60000,
    o: 100 + index * 0.01,
    h: 101 + index * 0.01,
    l: 99 + index * 0.01,
    c: 100 + index * 0.01,
    v: 100
  }));
  api.setConfig({
    enabled: true,
    scope: "multi",
    volumeRsiEnabled: true,
    slots: [
      { enabled: true, pair: "ZEC", tf: "1m" },
      { enabled: true, pair: "SOL", tf: "1m" },
      { enabled: false, pair: "", tf: "1m" }
    ]
  });
  api.setApp({ fetchCandles: async (pair, tf, limit) => { calls.push(pair + " " + tf); return bars; } });
  await api.poll();
  assert.deepEqual(calls, ["ZEC-USDT-SWAP 1m", "SOL-USDT-SWAP 1m"]);
  assert.match(api.getLastPollSummary(), /ZEC 1m ✓/);
  assert.match(api.getLastPollSummary(), /SOL 1m ✓/);
});


test("signal grouping toggle off records repeats independently without suppressing them", () => {
  const api = createHarness();
  api.setConfig({ groupSignals: false });
  api.setState({ rsiClusters: { "ZEC-USDT-SWAP|1m": {
    direction: "LONG", anchorPrice: 100, radius: 1, neutralSeen: false, suppressedCount: 0
  } } });
  const result = api.mergeRsiRepeat("ZEC-USDT-SWAP", "1m", { ts: 123, c: 100.2 }, "LONG");
  assert.equal(result, false);
  assert.equal(api.getHistory().length, 0);
  assert.equal(api.getState().rsiClusterSuppressed, 0);
});

test("signal grouping toggle on still merges repeated RSI triggers", () => {
  const api = createHarness();
  api.setConfig({ groupSignals: true });
  api.setState({ rsiClusters: { "ZEC-USDT-SWAP|1m": {
    direction: "LONG", anchorPrice: 100, radius: 1, neutralSeen: false, suppressedCount: 0
  } } });
  const result = api.mergeRsiRepeat("ZEC-USDT-SWAP", "1m", { ts: 123, c: 100.2 }, "LONG");
  assert.equal(result, true);
  assert.equal(api.getHistory().length, 1);
  assert.equal(api.getState().rsiClusterSuppressed, 1);
});
