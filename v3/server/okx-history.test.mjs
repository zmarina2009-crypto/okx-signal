import test from "node:test";
import assert from "node:assert/strict";
import { fetchOkxHistoricalCandles } from "./okx-market-data.mjs";

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
    fetchImpl:fakeFetch, maxCandles:200, pageSize:100, attempts:1
  });
  assert.equal(urls.length, 2);
  assert.equal(urls[0].searchParams.has("after"), false);
  assert.equal(urls[1].searchParams.get("after"), "101");
  assert.equal(candles.length, 200);
  assert.equal(candles[0].ts, 1);
  assert.equal(candles.at(-1).ts, 200);
});
