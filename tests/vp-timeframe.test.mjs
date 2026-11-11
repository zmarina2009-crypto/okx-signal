import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../alerts.js", import.meta.url), "utf8");

function createHarness(config = {}) {
  const store = new Map();
  const localStorage = {
    getItem: key => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key)
  };
  const window = { __OKX_ALERTS_TEST__: true, dispatchEvent() {} };
  const context = {
    window, localStorage,
    document: { getElementById: () => null },
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    Date, Math, Number, String, Object, Array, JSON, Promise, Map, Set,
    console, setInterval() { return 0; }, setTimeout() { return 0; }
  };
  vm.runInNewContext(source, context, { filename: "alerts.js" });
  const api = window.__OKXAlertsTest;
  assert.ok(api, "alert test API should be exposed");
  api.clear();
  api.setConfig({
    alertTf: "1m", vpTf: "15m", vp: true, vpPeriod: 20, vpRows: 10, vpMode: "poc",
    volume: false, rsi: false, sma: false,
    comboEnabled: false, comboModeActive: false, comboCount: 2, comboWindow: 1,
    comboComposition: "any", chopEnabled: false, cooldown: 1, sound: false,
    ...config
  });
  api.resetCombo();
  return api;
}

function makeProfileBars({ close = 100, count = 20, start = 1_799_000_000_000 } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    ts: start + i * 15 * 60_000,
    o: close, h: 101, l: 99, c: close, v: 10, confirm: "1"
  }));
}

function makeTradeBars(closes, start = 1_800_000_000_000) {
  return closes.map((close, i) => ({
    ts: start + i * 60_000,
    o: close, h: close + 0.2, l: close - 0.2, c: close,
    v: 10, confirm: "1"
  }));
}

const PAIR = "SUI-USDT-SWAP";

test("1m price crossing uses a stable 15m POC and stores VP source timeframe", () => {
  const api = createHarness();
  const vpBars = makeProfileBars({ close: 100 });
  const first = makeTradeBars([99.9, 99.9, 99.9, 99.9, 99.9, 99.9]);

  api.evaluatePair(first, PAIR, "1m", vpBars);
  assert.equal(api.read().length, 0, "initial profile load only establishes a price baseline");
  const state = api.getVpState(PAIR, "1m", "15m");
  assert.ok(state);
  assert.equal(state.profileTs, vpBars.at(-1).ts);
  assert.ok(state.levels.poc > 100 && state.levels.poc < 100.2);

  const next = [...first, makeTradeBars([100.2], first.at(-1).ts + 60_000)[0]];
  api.evaluatePair(next, PAIR, "1m", vpBars);

  const markers = api.read();
  assert.equal(markers.length, 1);
  assert.equal(markers[0].direction, "LONG");
  assert.equal(markers[0].eventCount, 1);
  assert.equal(markers[0].situationEvents[0].sourceTf, "15m");
  assert.equal(markers[0].situationEvents[0].sourceBarTs, vpBars.at(-1).ts);
  assert.equal(markers[0].situationEvents[0].profileLevel, "POC");
  assert.equal(markers[0].situationEvents[0].profilePrice, state.levels.poc);
});

test("15m VP levels remain unchanged across several 1m candles", () => {
  const api = createHarness();
  const vpBars = makeProfileBars({ close: 100 });
  const first = makeTradeBars([99.9, 99.9, 99.9, 99.9, 99.9, 99.9]);
  api.evaluatePair(first, PAIR, "1m", vpBars);
  const initial = api.getVpState(PAIR, "1m", "15m");

  let bars = first;
  for (const close of [99.95, 100.0, 99.98, 100.02]) {
    bars = [...bars, makeTradeBars([close], bars.at(-1).ts + 60_000)[0]];
    api.evaluatePair(bars, PAIR, "1m", vpBars);
    const current = api.getVpState(PAIR, "1m", "15m");
    assert.equal(current.profileTs, initial.profileTs);
    assert.equal(current.levels.poc, initial.levels.poc);
    assert.equal(current.levels.vah, initial.levels.vah);
    assert.equal(current.levels.val, initial.levels.val);
  }
  assert.equal(api.read().length, 0);
});

test("new 15m profile refresh re-baselines price and does not create a moving-POC false cross", () => {
  const api = createHarness();
  const olderProfile = makeProfileBars({ close: 100.9, start: 1_798_000_000_000 });
  const first = makeTradeBars([100, 100, 100, 100, 100, 100]);
  api.evaluatePair(first, PAIR, "1m", olderProfile);
  const oldState = api.getVpState(PAIR, "1m", "15m");
  assert.ok(oldState.levels.poc > 100.2);

  // The 15m profile changes to a lower POC exactly as a new 1m close moves
  // from below the new POC to above it. This is not a real crossing of the
  // previously fixed POC, so the profile-refresh candle must only re-baseline.
  const refreshedProfile = makeProfileBars({ close: 100, start: 1_798_000_900_000 });
  let bars = [...first, makeTradeBars([100.2], first.at(-1).ts + 60_000)[0]];
  api.evaluatePair(bars, PAIR, "1m", refreshedProfile);
  const newState = api.getVpState(PAIR, "1m", "15m");
  assert.notEqual(newState.profileTs, oldState.profileTs);
  assert.ok(newState.levels.poc < oldState.levels.poc);
  assert.equal(api.read().length, 0, "profile update itself must not synthesize a price crossing");

  // After the new profile is fixed, a genuine price crossing is recognized.
  bars = [...bars, makeTradeBars([99.9], bars.at(-1).ts + 60_000)[0]];
  api.evaluatePair(bars, PAIR, "1m", refreshedProfile);
  assert.equal(api.read().length, 1);
  assert.equal(api.read()[0].direction, "SHORT");
  assert.equal(api.read()[0].situationEvents[0].sourceTf, "15m");
});

test("COMBO 4/4 keeps 1m trade timeframe while VP confirmation records 15m source timeframe", () => {
  const api = createHarness({
    volume: true, rsi: true, sma: true, vp: true,
    comboEnabled: true, comboModeActive: true, comboCount: 4, comboWindow: 1
  });
  const vpBars = makeProfileBars({ close: 100 });
  const first = makeTradeBars([99.9, 99.9, 99.9, 99.9, 99.9, 99.9]);
  api.evaluatePair(first, PAIR, "1m", vpBars);
  const nextBar = makeTradeBars([100.2], first.at(-1).ts + 60_000)[0];

  for (const kind of ["volume", "rsi", "sma"]) {
    api.observeCombo(kind, {
      pair: PAIR, tf: "1m", ts: nextBar.ts, price: nextBar.c,
      entryPrice: nextBar.c, direction: "LONG", label: kind.toUpperCase(),
      sourceTf: "1m"
    });
  }
  api.evaluatePair([...first, nextBar], PAIR, "1m", vpBars);

  const markers = api.read();
  assert.equal(markers.length, 1);
  const [marker] = markers;
  assert.equal(marker.tf, "1m", "situation remains on the trade timeframe");
  assert.equal(marker.direction, "LONG");
  assert.equal(marker.comboConfirmed, true);
  assert.equal(marker.eventCount, 4);
  assert.equal(marker.situationSources.volume, 1);
  assert.equal(marker.situationSources.rsi, 1);
  assert.equal(marker.situationSources.sma, 1);
  assert.equal(marker.situationSources.vpPoc, 1);
  assert.equal(marker.comboComponentDetails.find(item => item.kind === "vp").sourceTf, "15m");
  assert.equal(marker.situationEvents.find(item => item.kind === "vp").sourceTf, "15m");
  assert.equal(marker.situationEvents.find(item => item.kind === "vp").profileLevel, "POC");
});

test("VP timeframe is clamped so it cannot be lower than the trade timeframe", () => {
  const api = createHarness({ alertTf: "15m", vpTf: "5m" });
  const vpBars = makeProfileBars({ close: 100 });
  const tradeBars = makeTradeBars([99.9, 99.9, 99.9, 99.9, 99.9, 99.9]);
  api.evaluatePair(tradeBars, PAIR, "15m", vpBars);
  assert.equal(api.getResolvedVpTf("15m"), "15m");
  assert.equal(api.getResolvedVpTf("1m"), "15m");
});
