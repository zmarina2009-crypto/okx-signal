import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeOhlcvRows,
  parseCandleText,
  replayHistoricalCandles
} from "../tools/replay-situations.mjs";

test("normalizes OKX candle payload, sorts timestamps, skips unfinished and duplicate rows", () => {
  const rows = [
    ["1800000060000", "100", "101", "99", "100.5", "12", "0", "0", "1"],
    ["1800000000000", "99", "100", "98", "99.5", "10", "0", "0", "1"],
    ["1800000120000", "100", "101", "99", "100.2", "9", "0", "0", "0"],
    ["1800000060000", "100", "102", "99", "101.5", "13", "0", "0", "1"]
  ];
  const result = normalizeOhlcvRows({ code: "0", data: rows });
  assert.equal(result.candles.length, 2);
  assert.equal(result.incompleteRows, 1);
  assert.equal(result.duplicateTimestamps, 1);
  assert.equal(result.candles[0].ts, 1_800_000_000_000);
  assert.equal(result.candles[1].c, 101.5);
});

test("parses exported OHLCV CSV with common column names", () => {
  const text = [
    "timestamp,open,high,low,close,volume,confirm",
    "1800000000000,99,100,98,99.5,10,1",
    "1800000060000,100,101,99,100.5,12,1",
    "1800000120000,100,101,99,100.2,9,0"
  ].join("\n");
  const result = parseCandleText(text);
  assert.equal(result.candles.length, 2);
  assert.equal(result.incompleteRows, 1);
});

test("replays real alert evaluators over SUI 1m-shaped OHLCV and reports a complete COMBO", () => {
  const start = 1_800_000_000_000;
  const candles = Array.from({ length: 80 }, (_, i) => {
    let close = 100;
    if (i === 65) close = 101.1;
    else if (i >= 66 && i <= 78) close = 101.1 - (i - 65) * 0.09;
    else if (i === 79) close = 100.02;
    const high = Math.max(100.5, close + 0.02);
    const low = Math.min(99.5, close - 0.02);
    return {
      ts: start + i * 60_000,
      o: i === 79 ? 100.03 : close,
      h: high, l: low, c: close,
      v: i >= 65 && i <= 78 ? 1 : i === 79 ? 1000 : 100,
      confirm: "1"
    };
  });

  const vpStart = start - 60 * 15 * 60_000;
  const vpCandles = Array.from({ length: 60 }, (_, i) => ({
    ts: vpStart + i * 15 * 60_000,
    o: 100, h: 100.5, l: 99.5, c: 100, v: 100, confirm: "1"
  }));
  const report = replayHistoricalCandles({
    candles, vpCandles, pair: "SUI-USDT-SWAP", tf: "1m", vpTf: "15m",
    comboOnly: true, includeBos: false
  });
  assert.equal(report.data.candleCount, 80);
  assert.equal(report.result.visibleSituationCount, 1);
  const [situation] = report.result.situations;
  assert.equal(situation.comboConfirmed, true);
  assert.equal(situation.eventCount, 4);
  assert.equal(situation.situationSources.volume, 1);
  assert.equal(situation.situationSources.rsi, 1);
  assert.equal(situation.situationSources.sma, 1);
  assert.equal(situation.situationSources.vpPoc, 1);
  assert.equal(report.data.matchedComponentSignals, 4);
});

test("historical replay never uses a 15m VP candle before its close time", () => {
  const start = 1_800_000_000_000;
  const candles = Array.from({ length: 80 }, (_, i) => ({
    ts: start + i * 60_000,
    o: 100, h: 100.2, l: 99.8, c: 100, v: 10, confirm: "1"
  }));
  // These 15m source bars begin after the end of the 1m test window.
  const futureVpStart = start + 80 * 60_000;
  const vpCandles = Array.from({ length: 60 }, (_, i) => ({
    ts: futureVpStart + i * 15 * 60_000,
    o: 100, h: 101, l: 99, c: 100, v: 100, confirm: "1"
  }));

  const report = replayHistoricalCandles({
    candles, vpCandles, pair: "SUI-USDT-SWAP", tf: "1m", vpTf: "15m",
    comboOnly: true, includeBos: false
  });
  assert.equal(report.data.vpBarsAvailableAtEnd, 0);
  assert.equal(report.result.sourceCounts.vpPoc, 0);
  assert.equal(report.result.visibleSituationCount, 0);
});
