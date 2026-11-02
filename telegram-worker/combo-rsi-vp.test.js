import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRsiVpProximity } from "./combo-rsi-vp.js";

function candlesFor(direction, count = 80) {
  return Array.from({ length: count }, (_, index) => {
    const close = direction === "LONG" ? 200 - index : 100 + index;
    return { ts: index * 900000, o: close, h: close + 1, l: close - 1, c: close, v: 100, confirm: true };
  });
}

const nearProfile = () => ({ poc: 90.5, val: 88, vah: 92 });

test("LONG when RSI is oversold and price is near POC", () => {
  const candles = candlesFor("LONG");
  candles[candles.length - 1].c = 90;
  const result = evaluateRsiVpProximity(candles, { vpPeriod: 60 }, nearProfile);
  assert.equal(result.signal?.direction, "LONG");
  assert.equal(result.signal?.vpLevel, "POC");
});

test("SHORT when RSI is overbought and price is near POC", () => {
  const candles = candlesFor("SHORT");
  candles[candles.length - 1].c = 90;
  const result = evaluateRsiVpProximity(candles, { vpPeriod: 60 }, nearProfile);
  assert.equal(result.signal?.direction, "SHORT");
  assert.equal(result.signal?.vpLevel, "POC");
});

test("does not signal when RSI is outside extreme zones", () => {
  const candles = candlesFor("LONG");
  for (let i = 0; i < candles.length; i++) candles[i].c = 100 + Math.sin(i) * 0.1;
  const result = evaluateRsiVpProximity(candles, { vpPeriod: 60 }, nearProfile);
  assert.equal(result.signal, null);
  assert.equal(result.reason, "RSI вне экстремальной зоны");
});

test("does not signal when price is farther than 0.25 ATR from every VP level", () => {
  const candles = candlesFor("LONG");
  candles[candles.length - 1].c = 90;
  const result = evaluateRsiVpProximity(candles, { vpPeriod: 60 }, () => ({ poc: 100, val: 101, vah: 102 }));
  assert.equal(result.signal, null);
  assert.equal(result.reason, "цена далеко от уровней Volume Profile");
});

test("does not signal with insufficient history", () => {
  const result = evaluateRsiVpProximity(candlesFor("LONG", 20), { vpPeriod: 60 }, nearProfile);
  assert.equal(result.signal, null);
  assert.equal(result.reason, "недостаточно истории");
});
