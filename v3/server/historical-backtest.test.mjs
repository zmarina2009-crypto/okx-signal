import test from "node:test";
import assert from "node:assert/strict";
import { calculateInitialStop, normalizeBacktestConfig, runHistoricalBacktest } from "./historical-backtest.mjs";

const sampleBars = [
  { ts:1,o:100,h:102,l:99,c:101,v:10 },
  { ts:2,o:101,h:103,l:98,c:102,v:11 },
  { ts:3,o:102,h:104,l:97,c:103,v:12 },
  { ts:4,o:103,h:105,l:96,c:104,v:13 },
  { ts:5,o:104,h:106,l:95,c:105,v:14 },
  { ts:6,o:105,h:107,l:94,c:106,v:15 },
  { ts:7,o:106,h:108,l:93,c:107,v:16 },
  { ts:8,o:107,h:109,l:92,c:108,v:17 },
  { ts:9,o:108,h:110,l:91,c:109,v:18 },
  { ts:10,o:109,h:111,l:90,c:110,v:19 },
  { ts:11,o:110,h:112,l:89,c:111,v:20 },
  { ts:12,o:111,h:113,l:88,c:112,v:21 },
  { ts:13,o:112,h:114,l:87,c:113,v:22 },
  { ts:14,o:113,h:115,l:86,c:114,v:23 },
  { ts:15,o:114,h:116,l:85,c:115,v:24 },
  { ts:16,o:115,h:117,l:84,c:116,v:25 }
];

test("stop mode is configurable between swing structure and ATR", () => {
  assert.equal(normalizeBacktestConfig({ stopMode:"swing" }).stopMode, "swing");
  assert.equal(normalizeBacktestConfig({ stopMode:"atr" }).stopMode, "atr");
  assert.equal(normalizeBacktestConfig({ stopMode:"unknown" }).stopMode, "swing");
});

test("swing stop uses the recent local low for LONG and local high for SHORT", () => {
  const longStop = calculateInitialStop(sampleBars.slice(0, 5), "LONG", 105, {
    stopMode:"swing", swingLookback:4
  });
  const shortStop = calculateInitialStop(sampleBars.slice(0, 5), "SHORT", 90, {
    stopMode:"swing", swingLookback:4
  });
  assert.equal(longStop, 95);
  assert.equal(shortStop, 106);
});

test("ATR stop uses the selected ATR multiplier", () => {
  const bars = Array.from({ length:20 }, (_, i) => ({
    ts:i, o:100, h:102, l:98, c:100, v:10
  }));
  const stop = calculateInitialStop(bars, "LONG", 100, {
    stopMode:"atr", atrPeriod:14, atrMultiplier:1.5
  });
  assert.equal(stop, 94);
});

test("invalid or crossed stops are rejected", () => {
  assert.equal(calculateInitialStop(sampleBars.slice(0, 3), "LONG", 95, {
    stopMode:"swing", swingLookback:2
  }), null);
});

test("historical tester returns a stable empty report when there are no actionable signals", () => {
  const result = runHistoricalBacktest({
    pair:"ZEC-USDT-SWAP",
    timeframe:"1m",
    candles:sampleBars.map(bar => ({ ...bar, confirm:"1" })),
    marketRegimeConfig:{ enabled:false },
    scalpingConfig:{ enabled:false }
  });
  assert.equal(result.pair, "ZEC-USDT-SWAP");
  assert.equal(result.summary.trades, 0);
  assert.equal(result.data.candles, sampleBars.length);
});
