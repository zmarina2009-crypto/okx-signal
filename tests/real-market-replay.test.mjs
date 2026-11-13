import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {
  parseCandleText,
  replayHistoricalCandles
} from "../tools/replay-situations.mjs";

const PAIR = "SUI-USDT-SWAP";
const tradeFile = new URL("./fixtures/market-replay/SUI-USDT-SWAP-1m-2026-11-12.json", import.meta.url);
const vpFile = new URL("./fixtures/market-replay/SUI-USDT-SWAP-15m-2026-11-12.json", import.meta.url);
const tradeInput = parseCandleText(fs.readFileSync(tradeFile, "utf8"));
const vpInput = parseCandleText(fs.readFileSync(vpFile, "utf8"));

function replayScalping(candles) {
  let clock = Number(candles[0]?.ts) || Date.now();
  class ReplayDate extends Date {
    static now() { return clock; }
  }
  const storage = new Map();
  const localStorage = {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key)
  };
  const window = {
    __OKX_ALERTS_TEST__: true,
    __OKX_SCALPING_TEST__: true,
    dispatchEvent() {}
  };
  const document = {
    readyState: "loading",
    getElementById: () => null,
    addEventListener() {}
  };
  const context = {
    window, document, localStorage, Date: ReplayDate,
    Math, Number, String, Object, Array, JSON, Promise, Map, Set,
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    console, setInterval() { return 0; }, setTimeout() { return 0; }
  };

  const alertsSource = fs.readFileSync(new URL("../alerts.js", import.meta.url), "utf8");
  const scalpingSource = fs.readFileSync(new URL("../scalping-trigger.js", import.meta.url), "utf8");
  vm.runInNewContext(alertsSource, context, { filename: "alerts.js" });
  const alerts = window.__OKXAlertsTest;
  assert.ok(alerts, "the real Alerts module should expose its test API");
  // The browser app uses this shared marker adapter to route scalping events
  // through the same situation aggregator as indicator alerts.
  window.OKXSignalMarkers = { add: meta => alerts.add(meta) };
  vm.runInNewContext(scalpingSource, context, { filename: "scalping-trigger.js" });
  const scalping = window.__OKXScalpingTest;
  assert.ok(scalping, "the real Scalping Trigger module should expose its test API");
  scalping.setConfig({
    enabled: true,
    volumeRsiEnabled: true,
    volumePeriod: 20,
    volumeMultiplier: 2,
    rsiLength: 14,
    rsiOversold: 30,
    rsiOverbought: 70,
    bosEnabled: false,
    bosAlerts: false,
    swingLength: 3,
    requireBos: false,
    longEnabled: true,
    shortEnabled: true,
    soundEnabled: false,
    cooldownSeconds: 60,
    rsiClusterAtrMultiplier: 1
  });

  for (let i = 0; i < candles.length; i++) {
    clock = Number(candles[i].ts) + 60_000;
    scalping.evaluateBars(candles.slice(0, i + 1), PAIR, "1m");
  }

  const markers = alerts.read();
  const rows = scalping.getHistory();
  const situations = markers.filter(marker => marker.individual !== true && marker.situationSources);
  const individualRsiMarkers = markers.filter(marker => marker.individual === true && marker.kind === "rsi-repeat");
  return {
    totalMarkers: markers.length,
    situationMarkers: situations,
    individualRsiMarkers,
    primaryRows: rows.filter(row => row.kind === "scalping"),
    repeatRows: rows.filter(row => row.kind === "rsi-repeat"),
    journalRows: rows.length
  };
}

test("replays the uploaded SUI 1m/15m OKX sample against the current PR code", () => {
  assert.equal(tradeInput.inputRows, 300);
  assert.equal(tradeInput.candles.length, 299);
  assert.equal(tradeInput.incompleteRows, 1);
  assert.equal(tradeInput.invalidRows, 0);
  assert.equal(tradeInput.duplicateTimestamps, 0);

  assert.equal(vpInput.inputRows, 300);
  assert.equal(vpInput.candles.length, 299);
  assert.equal(vpInput.incompleteRows, 1);
  assert.equal(vpInput.invalidRows, 0);
  assert.equal(vpInput.duplicateTimestamps, 0);

  const normal = replayHistoricalCandles({
    candles: tradeInput.candles,
    vpCandles: vpInput.candles,
    pair: PAIR, tf: "1m", vpTf: "15m",
    comboOnly: false, includeBos: true
  });
  const strictCombo = replayHistoricalCandles({
    candles: tradeInput.candles,
    vpCandles: vpInput.candles,
    pair: PAIR, tf: "1m", vpTf: "15m",
    comboOnly: true, includeBos: true
  });
  const scalping = replayScalping(tradeInput.candles);

  const summary = {
    pair: PAIR,
    interval: {
      startUtc: new Date(tradeInput.candles[0].ts).toISOString(),
      endUtc: new Date(tradeInput.candles.at(-1).ts + 60_000).toISOString()
    },
    input: {
      tradeClosed: tradeInput.candles.length,
      vpClosed: vpInput.candles.length,
      tradeIncomplete: tradeInput.incompleteRows,
      vpIncomplete: vpInput.incompleteRows,
      gaps: normal.data.gaps.length
    },
    normalAlerts: {
      situations: normal.result.visibleSituationCount,
      long: normal.result.byDirection.LONG,
      short: normal.result.byDirection.SHORT,
      sources: normal.result.sourceCounts,
      componentSignals: normal.data.candidateComponentSignals,
      matchedComponents: normal.data.matchedComponentSignals,
      unmatchedComponents: normal.data.unmatchedComponentSignals
    },
    strictCombo: {
      confirmed: strictCombo.result.visibleSituationCount,
      storedMarkers: strictCombo.result.storedMarkerCount
    },
    volumeRsiScalping: {
      primarySignals: scalping.primaryRows.length,
      repeatJournalRows: scalping.repeatRows.length,
      totalJournalRows: scalping.journalRows,
      chartMarkers: scalping.totalMarkers,
      situationMarkers: scalping.situationMarkers.length,
      individualRsiMarkers: scalping.individualRsiMarkers.length,
      individualRsiTimesUtc: scalping.individualRsiMarkers.map(marker => new Date(marker.ts).toISOString())
    }
  };
  console.log("SUI_REAL_MARKET_REPLAY " + JSON.stringify(summary));

  assert.equal(normal.data.candleCount, 299);
  assert.equal(normal.data.vpCandleCount, 299);
  assert.equal(normal.data.gaps.length, 0);
  assert.equal(scalping.primaryRows.length, 3);
  assert.equal(scalping.repeatRows.length, 2);
  assert.equal(scalping.journalRows, 5);
  assert.equal(scalping.situationMarkers.length, 3);
  assert.equal(scalping.individualRsiMarkers.length, 2);
  assert.equal(scalping.totalMarkers, 5);
  assert.ok(scalping.individualRsiMarkers.every(marker => marker.eventCount === 1));
  assert.equal(scalping.situationMarkers[0].eventCount, 3);
});
