import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../scalping-diagnostics.js", import.meta.url), "utf8");

function createApi() {
  const store = new Map();
  const localStorage = {
    getItem: (key) => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => store.set(key, String(value))
  };
  const window = { __OKX_SCALPING_DIAGNOSTICS_TEST__: true };
  vm.runInNewContext(source, {
    window, localStorage, Date, Math, Number, String, Object, Array, Map,
    JSON, Promise, Blob, setTimeout, console
  }, { filename: "scalping-diagnostics.js" });
  assert.ok(window.__OKXScalpingDiagnosticsTest);
  return window.__OKXScalpingDiagnosticsTest;
}

function makeBars() {
  const base = 1794988800000;
  const bars = [];
  for (let i = 0; i < 40; i++) {
    const close = i < 39 ? 100 - i : 62.1;
    const open = i < 39 ? close + 0.1 : 62.0;
    bars.push({
      ts: base + i * 60000,
      o: open,
      h: Math.max(open, close) + 0.2,
      l: Math.min(open, close) - 0.2,
      c: close,
      v: i === 39 ? 1000 : 100
    });
  }
  return bars;
}

const cfg = {
  enabled: true, volumeRsiEnabled: true, volumePeriod: 3, volumeMultiplier: 2,
  rsiLength: 14, rsiOversold: 30, rsiOverbought: 70,
  bosEnabled: false, swingLength: 3, requireBos: false,
  longEnabled: true, shortEnabled: true, cooldownSeconds: 60
};

test("detects a closed candle meeting Volume + RSI LONG conditions", () => {
  const api = createApi();
  const bars = makeBars();
  const result = api.evaluateAt(bars, bars.length - 1, cfg);
  assert.equal(result.volumeSpike, true);
  assert.equal(result.rsiLong, true);
  assert.equal(result.rsiShort, false);
  const candidates = api.scanCandidates(bars, "SUI-USDT-SWAP", "1m", cfg, [], 100);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].direction, "LONG");
  assert.equal(candidates[0].journalEvent, null);
});

test("matches a mathematical candidate to its actual journal event by candle timestamp", () => {
  const api = createApi();
  const bars = makeBars();
  const history = [{ kind: "scalping", pair: "SUI-USDT-SWAP", tf: "1m", direction: "LONG", ts: bars[39].ts }];
  const candidates = api.scanCandidates(bars, "SUI-USDT-SWAP", "1m", cfg, history, 100);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].journalEvent, "scalping");
});

test("reports strategy gates without mutating strategy state", () => {
  const api = createApi();
  const bars = makeBars();
  const state = { processed: {}, fired: [], lastAlertAt: {}, rsiClusters: {}, rsiClusterSuppressed: 0 };
  const before = JSON.stringify(state);
  const report = api.assessLatest(bars, "SUI-USDT-SWAP", "1m", cfg, state, [], Date.now());
  assert.equal(report.volumeSpike, true);
  assert.equal(report.rsiLong, true);
  assert.equal(report.decisions[0].direction, "LONG");
  assert.equal(report.decisions[0].reasons.length, 0);
  assert.equal(JSON.stringify(state), before);
});

test("detects an already processed candle and an RSI repeat merged into the open cluster", () => {
  const api = createApi();
  const bars = makeBars();
  const ts = bars[39].ts;
  const state = {
    processed: { "SUI-USDT-SWAP|1m": ts }, fired: [], lastAlertAt: {},
    rsiClusters: { "SUI-USDT-SWAP|1m": { direction: "LONG", anchorPrice: 62.1, radius: 2, neutralSeen: false, suppressedCount: 2 } }
  };
  const report = api.assessLatest(bars, "SUI-USDT-SWAP", "1m", cfg, state, [], Date.now());
  assert.equal(report.alreadyProcessed, true);
  assert.equal(report.decisions[0].mergedIntoCluster, true);
  assert.ok(report.decisions[0].reasons.some((reason) => reason.includes("объединяется")));
});

test("uses Moscow display time and understands candle interval sizes", () => {
  const api = createApi();
  assert.equal(api.intervalMs("1m"), 60000);
  assert.equal(api.intervalMs("1h"), 3600000);
  assert.match(api.formatMsk(1794988800000), /\d{2}\.\d{2}/);
});