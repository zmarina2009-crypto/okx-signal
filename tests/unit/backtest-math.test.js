"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {breakevenPrice,stopFill,positionSize,targetPrice}=require("../backtest-math.js");

test("position sizing risks 0.5% including round-trip costs and caps notional",()=>{
  const capital=1000, entry=100, stop=98, costRate=.001;
  const qty=positionSize({capital,riskPct:.5,entry,stop,costRate});
  const expectedBudget=5;
  const lossPerNotional=.02+(1+.98)*costRate;
  assert.ok(Math.abs(qty*lossPerNotional-expectedBudget)<1e-10);
  assert.ok(qty<=capital);
  assert.equal(positionSize({capital:100,riskPct:.5,entry:100,stop:99.9,costRate:0}),100);
});

test("cost-adjusted breakeven offsets round-trip proportional costs for long and short",()=>{
  const entry=100, cost=.001;
  const long=breakevenPrice(entry,1,cost);
  const short=breakevenPrice(entry,-1,cost);
  assert.ok(Math.abs((long-entry)-(long+entry)*cost)<1e-10);
  assert.ok(Math.abs((entry-short)-(short+entry)*cost)<1e-10);
});

test("gap-aware stop fills use the worse opening price",()=>{
  assert.equal(stopFill(98,95,1),95);
  assert.equal(stopFill(98,99,1),98);
  assert.equal(stopFill(102,105,-1),105);
  assert.equal(stopFill(102,101,-1),102);
});

test("5R target is exactly five initial stop distances from entry",()=>{
  assert.equal(targetPrice(100,1,2,5),110);
  assert.equal(targetPrice(100,-1,2,5),90);
});

test("invalid inputs are rejected or produce zero size",()=>{
  assert.throws(()=>breakevenPrice(100,0,.001),RangeError);
  assert.throws(()=>stopFill(100,101,0),RangeError);
  assert.equal(positionSize({capital:0,riskPct:.5,entry:100,stop:98,costRate:.001}),0);
});
