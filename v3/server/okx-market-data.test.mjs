import test from "node:test";
import assert from "node:assert/strict";
import { fetchOkxCandles, parseOkxCandles, toOkxBar } from "./okx-market-data.mjs";

test("maps OKX hour/day bars to exchange API notation", () => {
  assert.equal(toOkxBar("1h"), "1H");
  assert.equal(toOkxBar("4h"), "4H");
  assert.equal(toOkxBar("1d"), "1D");
  assert.equal(toOkxBar("15m"), "15m");
});

test("parses candles in chronological order and retains confirm state", () => {
  const rows = [
    ["2000", "2", "3", "1", "2.5", "20", "0", "0", "0"],
    ["1000", "1", "2", "0.5", "1.5", "10", "0", "0", "1"]
  ];
  assert.deepEqual(parseOkxCandles(rows), [
    { ts: 1000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10, confirm: "1" },
    { ts: 2000, o: 2, h: 3, l: 1, c: 2.5, v: 20, confirm: "0" }
  ]);
});

test("fetches public perpetual candles and uses the expected bar/limit query", async () => {
  let requestedUrl;
  const fakeFetch = async url => {
    requestedUrl = new URL(url);
    return {
      ok: true,
      json: async () => ({
        code: "0",
        data: [["1000", "1", "2", "0.5", "1.5", "10", "0", "0", "1"]]
      })
    };
  };
  const candles = await fetchOkxCandles("BTC", "1h", { fetchImpl: fakeFetch, attempts: 1, limit: 120 });
  assert.equal(requestedUrl.searchParams.get("instId"), "BTC-USDT-SWAP");
  assert.equal(requestedUrl.searchParams.get("bar"), "1H");
  assert.equal(requestedUrl.searchParams.get("limit"), "120");
  assert.equal(candles.length, 1);
});

test("retries temporary HTTP/API failures and rejects invalid instrument types", async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 503 };
    return { ok: true, json: async () => ({ code: "0", data: [] }) };
  };
  await fetchOkxCandles("ETH", "5m", { fetchImpl: fakeFetch, attempts: 2, timeoutMs: 2000 });
  assert.equal(calls, 2);
  await assert.rejects(fetchOkxCandles("BTC-USDT", "1m", { fetchImpl: fakeFetch }), /USDT perpetual/);
});
