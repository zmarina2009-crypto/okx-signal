import test from "node:test";
import assert from "node:assert/strict";
import { fetchOkxHistoricalCandles, auditCandleSeries } from "./okx-market-data.mjs";

test("historical OKX loader pages backward and returns chronological confirmed candles", async () => {
  const first = Array.from({length:100}, (_, i) => {
    const ts = 200 - i;
    return [String(ts), "1", "2", "0.5", "1.5", "10", "0", "0", "1"];
  });
  const second = Array.from({length:100}, (_, i) => {
    const ts = 100 - i;
    return [String(ts), "1", "2", "0.5", "1.5", "10", "0", "0", "1"];
  });
  const urls = [];
  const fakeFetch = async url => {
    urls.push(new URL(url));
    const data = urls.length === 1 ? first : second;
    return { ok:true, json:async () => ({ code:"0", data }) };
  };
  const candles = await fetchOkxHistoricalCandles("ZEC", "1m", {
    fetchImpl:fakeFetch, maxCandles:200, pageSize:100, attempts:1, endTime:250
  });
  assert.equal(urls.length, 2);
  assert.equal(urls[0].searchParams.get("after"), "251");
  assert.equal(urls[1].searchParams.get("after"), "101");
  assert.equal(candles.length, 200);
  assert.equal(candles[0].ts, 1);
  assert.equal(candles.at(-1).ts, 200);
});


test("historical loader continues when a full OKX page has one unconfirmed candle", async () => {
  const first = Array.from({length:100}, (_, i) => {
    const ts = 200 - i;
    return [String(ts), "1", "2", "0.5", "1.5", "10", "0", "0", ts === 200 ? "0" : "1"];
  });
  const second = Array.from({length:100}, (_, i) => {
    const ts = 100 - i;
    return [String(ts), "1", "2", "0.5", "1.5", "10", "0", "0", "1"];
  });
  const urls = [];
  const fakeFetch = async url => {
    urls.push(new URL(url));
    const data = urls.length === 1 ? first : second;
    return { ok:true, json:async () => ({ code:"0", data }) };
  };
  const candles = await fetchOkxHistoricalCandles("ZEC", "1m", {
    fetchImpl:fakeFetch, maxCandles:199, pageSize:100, attempts:1, endTime:250
  });
  assert.equal(urls.length, 2);
  assert.equal(urls[0].searchParams.get("after"), "251");
  assert.equal(urls[1].searchParams.get("after"), "101");
  assert.equal(candles.length, 199);
  assert.equal(candles[0].ts, 1);
  assert.equal(candles.at(-1).ts, 199);
});

test("historical loader respects a custom endTime on the first page", async () => {
  let requestedUrl;
  const fakeFetch = async url => {
    requestedUrl = new URL(url);
    const data = [300, 240, 180].map(ts =>
      [String(ts), "1", "2", "0.5", "1.5", "10", "0", "0", "1"]
    );
    return { ok:true, json:async () => ({ code:"0", data }) };
  };
  const candles = await fetchOkxHistoricalCandles("NEAR", "1m", {
    fetchImpl:fakeFetch, maxCandles:20, pageSize:20, attempts:1, endTime:250
  });
  assert.equal(requestedUrl.searchParams.get("after"), "251");
  assert.deepEqual(candles.map(candle => candle.ts), [180, 240]);
});

test("candle audit reports count, duplicates and missing intervals", () => {
  const audit = auditCandleSeries(
    [{ts:0},{ts:60_000},{ts:60_000},{ts:240_000}],
    "1m",
    5
  );
  assert.deepEqual(audit, {
    loadedCandles:4,
    requestedCandles:5,
    countReached:false,
    duplicateTimestamps:1,
    missingIntervals:1,
    missingCandles:2,
    isContinuous:false
  });
});

test("candle audit accepts a complete continuous series", () => {
  const audit = auditCandleSeries([{ts:60_000},{ts:120_000},{ts:180_000}], "1m", 3);
  assert.equal(audit.countReached, true);
  assert.equal(audit.isContinuous, true);
  assert.equal(audit.missingCandles, 0);
});
