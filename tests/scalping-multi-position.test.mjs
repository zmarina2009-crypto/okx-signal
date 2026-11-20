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
