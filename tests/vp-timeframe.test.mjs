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
  assert.equal(api.getResolvedVpTf("1m"), "5m");
});

test("late 15m VP fetch completes a minute signal already processed by the chart without duplicating base alerts", () => {
  const api = createHarness();
  const vpBars = makeProfileBars({ close: 100 });
  const first = makeTradeBars([99.9, 99.9, 99.9, 99.9, 99.9, 99.9]);

  // Initial profile is loaded and establishes a fixed POC baseline.
  api.evaluatePair(first, PAIR, "1m", vpBars);
  assert.equal(api.read().length, 0);

  const crossingBar = makeTradeBars([100.2], first.at(-1).ts + 60_000)[0];
  const historyWithCross = [...first, crossingBar];

  // The chart evaluator gets this closed 1m candle before the slower VP poll
  // has populated its cache. Base alerts are processed; VP remains pending.
  api.evaluatePair(historyWithCross, PAIR, "1m");
  assert.equal(api.read().length, 0);

  // The VP poll then revisits the same closed 1m candle with the 15m bars.
  // The VP crossing must now be emitted exactly once.
  api.evaluatePair(historyWithCross, PAIR, "1m", vpBars);
  assert.equal(api.read().length, 1);
  assert.equal(api.read()[0].direction, "LONG");
  assert.equal(api.read()[0].situationEvents[0].sourceTf, "15m");

  // A repeated poll of the same candle cannot add a duplicate confirmation.
  api.evaluatePair(historyWithCross, PAIR, "1m", vpBars);
  assert.equal(api.read().length, 1);
  assert.equal(api.read()[0].eventCount, 1);
});

test("Alerts panel exposes an independent VP timeframe selector with a 15m default", () => {
  assert.ok(source.includes('vpTf:"15m"'));
  assert.ok(source.includes('id="alertVPTf"'));
  assert.ok(source.includes('<option value="15m">15m</option>'));
  assert.ok(source.includes('bind("alertVPTf","vpTf"'));
  assert.ok(source.includes("Для торговли 1m рекомендуем VP 15m"));
});
test("alert polling fetches 1m trade and 15m VP candles independently", async () => {
  const api = createHarness({
    alertTf: "1m", vpTf: "15m", selectedPairs: [PAIR],
    volume: true, volumePeriod: 20, volumeMult: 2, vp: true
  });
  const start = 1_800_000_000_000;
  const tradeBars = Array.from({ length: 22 }, (_, i) => ({
    ts: start + i * 60_000,
    o: 100, h: 100.1, l: 99.9, c: 100,
    v: i === 21 ? 1000 : 10, confirm: "1"
  }));
  const vpBars = makeProfileBars({ close: 100, count: 20 });
  const calls = [];
  api.setMarketApi({
    getState: () => ({ currentPair: PAIR }),
    fetchCandles: async (pair, tf, limit) => {
      calls.push({ pair, tf, limit });
      return tf === "1m" ? tradeBars : vpBars;
    }
  });

  await api.pollSelected();
  await api.waitForVpIdle();

  assert.deepEqual(calls.map(call => call.tf), ["1m", "15m"]);
  assert.equal(calls[0].pair, PAIR);
  assert.equal(calls[1].pair, PAIR);
  assert.equal(calls[1].limit, 80);
  assert.ok(api.getVpState(PAIR, "1m", "15m"), "15m profile should be initialized from its own candle stream");
  assert.equal(api.read().length, 1, "base 1m volume signal should still be evaluated");
  assert.equal(api.read()[0].direction, "LONG");
});

test("a delayed VP response replays every intermediate 1m close in order without duplicating base alerts", async () => {
  const api = createHarness({
    alertTf: "1m", vpTf: "15m", selectedPairs: [PAIR],
    volume: true, volumePeriod: 5, volumeMult: 2, rsi: false, sma: false, vp: true
  });
  const start = 1_800_000_000_000;
  let tradeBars = makeTradeBars([99.9, 99.9, 99.9, 99.9, 99.9, 99.9], start);
  const vpBars = makeProfileBars({ close: 100, count: 20 });
  let resolveVp;
  const delayedVp = new Promise(resolve => { resolveVp = resolve; });
  api.setMarketApi({
    getState: () => ({ currentPair: PAIR }),
    fetchCandles: async (pair, tf) => tf === "15m" ? delayedVp : tradeBars
  });

  // The first poll starts VP loading and seeds the initial trade-price baseline.
  await api.pollSelected();
  assert.equal(api.getVpFetchInFlight().length, 1);
  assert.equal(api.getPendingVpReplay()[0].candleTimestamps.length, 1);
  assert.equal(api.getPendingVpReplay()[0].candleTimestamps[0], tradeBars.at(-1).ts);

  // Five closed minutes arrive while the 15m request is still pending.
  for (const close of [99.95, 100.2, 100.25, 100.3, 100.15]) {
    const next = makeTradeBars([close], tradeBars.at(-1).ts + 60_000)[0];
    if (close === 100.2) next.v = 100; // One ordinary Volume alert on the intermediate crossing candle.
    tradeBars = [...tradeBars, next];
    await api.pollSelected();
  }
  const queued = Array.from(api.getPendingVpReplay()[0].candleTimestamps);
  assert.equal(queued.length, 6, "initial baseline plus all five delayed closes must be buffered");
  assert.deepEqual(queued, [...queued].sort((left, right) => left - right));
  assert.equal(api.read().filter(marker => marker.kind === "vp").length, 0,
    "VP cannot be evaluated until its profile response arrives");
  assert.equal(api.read().filter(marker => marker.kind === "volume").length, 1,
    "the regular 1m Volume alert must be delivered while VP is pending");

  resolveVp(vpBars);
  await api.waitForVpIdle();

  const vpMarkers = api.read().filter(marker => marker.kind === "vp");
  assert.equal(vpMarkers.length, 1, "the intermediate POC cross must be detected once");
  assert.equal(vpMarkers[0].direction, "LONG");
  assert.equal(vpMarkers[0].ts, queued[2], "the marker must retain the actual crossing candle, not the latest candle");
  assert.equal(vpMarkers[0].situationEvents[0].sourceTf, "15m");
  assert.equal(api.read().filter(marker => marker.kind === "volume").length, 1,
    "VP-only replay must not duplicate the previously delivered Volume alert");
  assert.equal(api.getPendingVpReplay().length, 0);
  assert.equal(api.getVpFetchInFlight().length, 0);

  // A later normal poll cannot re-send the replayed historical crossing.
  await api.pollSelected();
  assert.equal(api.read().filter(marker => marker.kind === "vp").length, 1);
});

test("higher-timeframe VP profile excludes a source candle until its close is available", () => {
  const api = createHarness();
  const tradeStart = 1_800_000_000_000;
  const oldProfile = makeProfileBars({ close: 100, start: tradeStart - 20 * 15 * 60_000 });
  const formingAtTradeStart = {
    ts: tradeStart, o: 105, h: 106, l: 104, c: 105, v: 1000, confirm: "1"
  };
  const vpBars = [...oldProfile, formingAtTradeStart];
  let tradeBars = makeTradeBars([99.9, 99.9, 99.9, 99.9, 99.9, 99.9], tradeStart);

  api.evaluatePair(tradeBars, PAIR, "1m", vpBars);
  const beforeSourceClose = api.getVpState(PAIR, "1m", "15m");
  assert.equal(beforeSourceClose.profileTs, oldProfile.at(-1).ts,
    "the 15m candle that has not closed must not enter the profile");

  for (let i = 0; i < 9; i++) {
    const close = 99.9 + (i % 2 ? 0.01 : 0);
    tradeBars = [...tradeBars, makeTradeBars([close], tradeBars.at(-1).ts + 60_000)[0]];
  }
  api.evaluatePair(tradeBars, PAIR, "1m", vpBars);
  const afterSourceClose = api.getVpState(PAIR, "1m", "15m");
  assert.equal(afterSourceClose.profileTs, formingAtTradeStart.ts,
    "the 15m source candle becomes eligible only when its 15-minute close is reached");
});

test("a failed 15m VP request does not stop base 1m alerts", async () => {
  const api = createHarness({
    alertTf: "1m", vpTf: "15m", selectedPairs: [PAIR],
    volume: true, volumePeriod: 20, volumeMult: 2, vp: true
  });
  const start = 1_800_000_000_000;
  const tradeBars = Array.from({ length: 22 }, (_, i) => ({
    ts: start + i * 60_000,
    o: 100, h: 100.1, l: 99.9, c: 100,
    v: i === 21 ? 1000 : 10, confirm: "1"
  }));
  const calls = [];
  api.setMarketApi({
    getState: () => ({ currentPair: PAIR }),
    fetchCandles: async (pair, tf, limit) => {
      calls.push({ pair, tf, limit });
      if (tf === "15m") throw new Error("simulated VP timeout");
      return tradeBars;
    }
  });

  await api.pollSelected();
  await api.waitForVpIdle();

  assert.deepEqual(calls.map(call => call.tf), ["1m", "15m"]);
  assert.equal(api.read().length, 1);
  assert.equal(api.read()[0].direction, "LONG");
  assert.ok(api.getAlertLog().some(entry => entry.text.includes("VP 15m недоступен")));
});

test("slow 15m VP response does not delay 1m signals and completes only VP once", async () => {
  const api = createHarness({
    alertTf: "1m", vpTf: "15m", selectedPairs: [PAIR],
    volume: true, volumePeriod: 20, volumeMult: 2, vp: true
  });
  const start = 1_800_000_000_000;
  const tradeBars = Array.from({ length: 22 }, (_, i) => ({
    ts: start + i * 60_000,
    o: 100, h: 100.1, l: 99.9, c: 100,
    v: i === 21 ? 1000 : 10, confirm: "1"
  }));
  const vpBars = makeProfileBars({ close: 100, count: 20 });
  const calls = [];
  let resolveVp;
  const delayedVp = new Promise(resolve => { resolveVp = resolve; });
  api.setMarketApi({
    getState: () => ({ currentPair: PAIR }),
    fetchCandles: async (pair, tf, limit) => {
      calls.push({ pair, tf, limit });
      if (tf === "15m") return delayedVp;
      return tradeBars;
    }
  });

  // This must finish while the 15m request is still unresolved.
  await api.pollSelected();
  assert.deepEqual(calls.map(call => call.tf), ["1m", "15m"]);
  assert.equal(api.getVpFetchInFlight().length, 1);
  assert.equal(api.read().length, 1, "base 1m Volume alert must not wait for VP");
  assert.equal(api.read()[0].kind, "volume");

  resolveVp(vpBars);
  await api.waitForVpIdle();

  assert.ok(api.getVpState(PAIR, "1m", "15m"), "15m profile is processed after the delayed response");
  assert.equal(api.read().length, 1, "late VP processing must not duplicate the already delivered 1m signal");
  assert.equal(api.read()[0].eventCount, 1);
  assert.equal(api.getVpFetchInFlight().length, 0);
});
