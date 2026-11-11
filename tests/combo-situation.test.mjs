import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../alerts.js", import.meta.url), "utf8");

function createHarness() {
  const store = new Map();
  const localStorage = {
    getItem: key => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key)
  };
  const window = { __OKX_ALERTS_TEST__: true, dispatchEvent() {} };
  const document = { getElementById: () => null };
  const context = {
    window, document, localStorage,
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    Date, Math, Number, String, Object, Array, JSON, Promise, Map, Set,
    console, setInterval() { return 0; }, setTimeout() { return 0; }
  };
  vm.runInNewContext(source, context, { filename: "alerts.js" });
  const api = window.__OKXAlertsTest;
  assert.ok(api, "test API should be exposed");
  api.clear();
  api.setConfig({
    volume: true, rsi: true, sma: true, vp: true,
    comboEnabled: true, comboModeActive: true, comboCount: 4, comboWindow: 1,
    comboComposition: "any", chopEnabled: false, sound: false,
    smaPeriod: 21, smaTolerance: 0, vpMode: "poc"
  });
  api.setComboCandles(Array.from({ length: 16 }, (_, i) => ({
    ts: 1_800_000_000_000 - (15 - i) * 60_000,
    o: 100, h: 100.1, l: 99.9, c: 100, v: 10
  })));
  api.resetCombo();
  return api;
}

function component(kind, overrides = {}) {
  const ts = 1_800_000_000_000;
  const direction = kind === "volume" ? "SHORT" : "LONG";
  const labels = { volume: "VOLUME", rsi: "RSI", sma: "SMA21", vp: "VP POC" };
  return {
    pair: "SUI-USDT-SWAP", tf: "1m", kind, ts,
    price: 100, entryPrice: 100, direction,
    label: labels[kind], ...overrides
  };
}

function sendFour(api, overrides = {}) {
  const items = ["volume", "rsi", "sma", "vp"].map(kind =>
    component(kind, overrides[kind] || {})
  );
  for (const item of items) api.observeCombo(item.kind, item);
  return items;
}

test("COMBO-only creates one aggregate marker with four real source confirmations", () => {
  const api = createHarness();
  const items = sendFour(api);

  const markers = api.read();
  assert.equal(markers.length, 1, "the four components must not create four chart markers");
  const [marker] = markers;
  assert.equal(marker.pair, "SUI-USDT-SWAP");
  assert.equal(marker.tf, "1m");
  assert.equal(marker.direction, "LONG");
  assert.equal(marker.eventCount, 4);
  assert.equal(marker.situationSources.volume, 1);
  assert.equal(marker.situationSources.rsi, 1);
  assert.equal(marker.situationSources.sma, 1);
  assert.equal(marker.situationSources.vpPoc, 1);
  assert.equal(marker.situationSources.vpOther, 0);
  assert.equal(marker.situationSources.combo, 0);
  assert.equal(marker.comboConfirmed, true);
  assert.equal(marker.comboComponents.join(","), "volume,rsi,sma,vp");
  assert.equal(marker.situationEvents.length, 4);
  assert.equal(marker.situationEventIds.length, 4);
  assert.equal(api.isComboSituation(marker), true);
  assert.ok(marker.zoneRadius > marker.entryPrice * 0.00025);

  const logKinds = api.getAlertLog().map(entry => entry.kind);
  assert.equal(logKinds.join(","), "volume,rsi,sma,vp,combo",
    "each component plus the final COMBO must be retained in alert history");
});

test("real SUI 1m candle evaluation detects Volume, RSI, SMA21 and VP POC on one closed candle", () => {
  const api = createHarness();
  const start = 1_800_000_000_000;
  const bars = Array.from({ length: 80 }, (_, i) => {
    let close = 100;
    if (i === 65) close = 101.1;
    else if (i >= 66 && i <= 78) close = 101.1 - (i - 65) * 0.09;
    else if (i === 79) close = 100.02;
    const high = Math.max(100.5, close + 0.02);
    const low = Math.min(99.5, close - 0.02);
    return {
      ts: start + i * 60_000,
      o: i === 79 ? 100.03 : close,
      h: high,
      l: low,
      c: close,
      v: i >= 65 && i <= 78 ? 1 : i === 79 ? 1000 : 100
    };
  });

  api.evaluatePair(bars, "SUI-USDT-SWAP", "1m");

  const markers = api.read();
  assert.equal(markers.length, 1);
  const [marker] = markers;
  assert.equal(marker.direction, "LONG");
  assert.equal(marker.eventCount, 4);
  assert.equal(marker.situationSources.volume, 1);
  assert.equal(marker.situationSources.rsi, 1);
  assert.equal(marker.situationSources.sma, 1);
  assert.equal(marker.situationSources.vpPoc, 1);
  assert.equal(marker.comboConfirmed, true);
  assert.equal(marker.situationEvents.length, 4);
  assert.ok(marker.situationEvents.some(event => event.kind === "volume"));
  assert.ok(marker.situationEvents.some(event => event.kind === "rsi"));
  assert.ok(marker.situationEvents.some(event => event.kind === "sma"));
  assert.ok(marker.situationEvents.some(event => event.kind === "vp" && /POC/.test(event.label)));
});

test("BOS in the same direction and price/time zone becomes the fifth confirmation", () => {
  const api = createHarness();
  sendFour(api);
  const [comboMarker] = api.read();

  api.add({
    pair: "SUI-USDT-SWAP", tf: "1m", kind: "bos",
    ts: 1_800_000_060_000, price: 100.03, entryPrice: 100.03,
    direction: "LONG", label: "BOS ↑", zoneRadius: 0.25
  });

  const markers = api.read();
  assert.equal(markers.length, 1);
  assert.equal(markers[0].id, comboMarker.id);
  assert.equal(markers[0].eventCount, 5);
  assert.equal(markers[0].situationSources.bos, 1);
  assert.equal(markers[0].comboConfirmed, true);
  assert.match(markers[0].label, /BOS/);
});

test("opposite-direction BOS remains a separate situation and does not contaminate COMBO", () => {
  const api = createHarness();
  sendFour(api);

  api.add({
    pair: "SUI-USDT-SWAP", tf: "1m", kind: "bos",
    ts: 1_800_000_060_000, price: 100.03, entryPrice: 100.03,
    direction: "SHORT", label: "BOS ↓", zoneRadius: 0.25
  });

  const markers = api.read();
  assert.equal(markers.length, 2);
  const combo = markers.find(marker => marker.comboConfirmed);
  const other = markers.find(marker => !marker.comboConfirmed);
  assert.ok(combo);
  assert.ok(other);
  assert.equal(combo.direction, "LONG");
  assert.equal(combo.eventCount, 4);
  assert.equal(combo.situationSources.bos, 0);
  assert.equal(other.direction, "SHORT");
  assert.equal(other.situationSources.bos, 1);
});

test("normal alert mode moves a non-directional Volume event into the confirmed COMBO direction", () => {
  const api = createHarness();
  api.setConfig({ comboModeActive: false });
  const items = ["volume", "rsi", "sma", "vp"].map(kind => component(kind));
  for (const item of items) api.add(item);

  // The volume candle body was SHORT, but all directional confirmations agree LONG.
  for (const item of items) api.observeCombo(item.kind, item);

  const markers = api.read();
  assert.equal(markers.length, 1,
    "the old standalone SHORT-volume marker must not remain as a duplicate after confirmation");
  assert.equal(markers[0].direction, "LONG");
  assert.equal(markers[0].eventCount, 4);
  assert.equal(markers[0].situationSources.volume, 1);
  assert.equal(markers[0].situationSources.rsi, 1);
  assert.equal(markers[0].situationSources.sma, 1);
  assert.equal(markers[0].situationSources.vpPoc, 1);
  assert.equal(markers[0].comboConfirmed, true);
});

test("COMBO 4/4 rejects disagreeing RSI, SMA and VP directions", () => {
  const api = createHarness();
  const items = [
    component("volume", { direction: "SHORT" }),
    component("rsi", { direction: "LONG" }),
    component("sma", { direction: "SHORT" }),
    component("vp", { direction: "LONG" })
  ];
  for (const item of items) api.observeCombo(item.kind, item);
  assert.equal(api.read().length, 0);
  assert.equal(api.getAlertLog().some(entry => entry.kind === "combo"), false);
});

test("COMBO 4/4 never combines components from different pairs, timeframes or candles", () => {
  const api = createHarness();
  const ts = 1_800_000_000_000;
  api.observeCombo("volume", component("volume", { ts }));
  api.observeCombo("rsi", component("rsi", { ts }));
  api.observeCombo("sma", component("sma", { ts }));
  api.observeCombo("vp", component("vp", { pair: "XRP-USDT-SWAP", ts }));
  api.observeCombo("vp", component("vp", { tf: "5m", ts }));
  api.observeCombo("vp", component("vp", { ts: ts + 60_000 }));
  assert.equal(api.read().length, 0);
});
