import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../alerts.js", import.meta.url), "utf8");

function createHarness(initialMarkers = []) {
  const store = new Map();
  if (initialMarkers.length) store.set("okx_v2_alert_markers", JSON.stringify(initialMarkers));
  const localStorage = {
    getItem: (key) => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key)
  };
  const window = {
    __OKX_ALERTS_TEST__: true,
    dispatchEvent() {}
  };
  class CustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
  }
  const context = {
    window, localStorage, CustomEvent,
    document: { getElementById: () => null },
    console, Date, Math, Number, String, Object, Array, JSON, Promise,
    setInterval() { return 0; },
    setTimeout() { return 0; }
  };
  vm.runInNewContext(source, context, { filename: "alerts.js" });
  const api = window.__OKXAlertsTest;
  assert.ok(api, "test API should be exposed in test mode");
  if (!initialMarkers.length) api.clear();
  return api;
}

function signal(overrides = {}) {
  return {
    pair: "SUI-USDT-SWAP", tf: "1m", kind: "rsi",
    direction: "LONG", price: 100, entryPrice: 100,
    ts: 1_800_000_000_000, zoneRadius: 1,
    ...overrides
  };
}

test("merges same pair, timeframe, direction and price zone", () => {
  const api = createHarness();
  api.add(signal());
  const result = api.add(signal({ kind: "volume", ts: 1_800_000_060_000, entryPrice: 100.5, price: 100.5 }));
  const marks = api.read();
  assert.equal(result.merged, true);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].eventCount, 2);
  assert.equal(marks[0].situationSources.rsi, 1);
  assert.equal(marks[0].situationSources.volume, 1);
});

test("does not merge opposite directions", () => {
  const api = createHarness();
  api.add(signal());
  api.add(signal({ direction: "SHORT", kind: "sma", ts: 1_800_000_060_000 }));
  assert.equal(api.read().length, 2);
});

test("does not merge different pairs or timeframes", () => {
  const api = createHarness();
  api.add(signal());
  api.add(signal({ pair: "XRP-USDT-SWAP", ts: 1_800_000_060_000 }));
  api.add(signal({ tf: "5m", ts: 1_800_000_120_000 }));
  assert.equal(api.read().length, 3);
});

test("first signal's ATR zone remains fixed when later ATR is larger", () => {
  const api = createHarness();
  api.add(signal({ zoneRadius: 1 }));
  const merged = api.add(signal({
    kind: "volume", ts: 1_800_000_060_000,
    entryPrice: 100.8, price: 100.8, zoneRadius: 50
  }));
  const outside = api.add(signal({
    kind: "sma", ts: 1_800_000_120_000,
    entryPrice: 101.1, price: 101.1, zoneRadius: 50
  }));
  const marks = api.read();
  assert.equal(merged.merged, true);
  assert.equal(outside.merged, false);
  assert.equal(marks.length, 2);
  assert.equal(marks[0].zoneRadius, 1);
});

test("starts a new situation after more than eight timeframe bars", () => {
  const api = createHarness();
  api.add(signal());
  api.add(signal({ kind: "volume", ts: 1_800_000_000_000 + 9 * 60_000 }));
  assert.equal(api.read().length, 2);
});

test("accepts the exact eight-bar boundary", () => {
  const api = createHarness();
  api.add(signal());
  const result = api.add(signal({ kind: "volume", ts: 1_800_000_000_000 + 8 * 60_000 }));
  assert.equal(result.merged, true);
  assert.equal(api.read().length, 1);
});

test("ignores a repeated event id instead of double-counting it", () => {
  const api = createHarness();
  const event = signal();
  api.add(event);
  const duplicate = api.add(event);
  assert.equal(duplicate.duplicate, true);
  assert.equal(api.read().length, 1);
  assert.equal(api.read()[0].eventCount, 1);
});

test("rejects invalid direction and non-positive price", () => {
  const api = createHarness();
  assert.equal(api.add(signal({ direction: "SIDEWAYS" })), null);
  assert.equal(api.add(signal({ price: 0 })), null);
  assert.equal(api.read().length, 0);
});

test("migrates legacy tolerance into zoneRadius without shrinking the price boundary", () => {
  const ts = Date.now();
  const api = createHarness([{
    id: "legacy-vp-poc", pair: "SUI-USDT-SWAP", tf: "1m", kind: "vp",
    label: "VP POC", direction: "LONG", price: 100, entryPrice: 100,
    ts, tolerance: 2, touches: 1, situationSources: { vpPoc: 1 }
  }]);
  const [marker] = api.read();
  assert.equal(marker.zoneRadius, 2);
  assert.equal(marker.tolerance, 2);
  assert.equal(marker.anchorPrice, 100);
});

test("COMBO-only predicate accepts genuine COMBO situations only", () => {
  const api = createHarness();
  assert.equal(api.isComboSituation({ kind: "combo" }), true);
  assert.equal(api.isComboSituation({ kind: "rsi", situationSources: { rsi: 2, combo: 1 } }), true);
  assert.equal(api.isComboSituation({ kind: "rsi", situationEvents: [{ kind: "combo" }] }), true);
  assert.equal(api.isComboSituation({ kind: "rsi", situationSources: { rsi: 1, volume: 1, sma: 1, vpOther: 1 } }), false);
  assert.equal(api.isComboSituation({ kind: "scalping", situationSources: { scalping: 1 } }), false);
  assert.equal(api.isComboSituation({ kind: "bos", situationSources: { bos: 1 } }), false);
});
