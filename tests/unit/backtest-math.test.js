"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {breakevenPrice,stopFill,positionSize,targetPrice}=require("../../backtest-math.js");

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

const {atr,firstExitIndex,intrabarExit,closedCandles}=require("../../backtest-math.js");

test("ATR uses only the selected candle and prior close values",()=>{
  const candles=[
    {h:11,l:9,c:10},
    {h:13,l:9,c:11},
    {h:14,l:10,c:12},
    {h:1000,l:0,c:500}
  ];
  assert.equal(atr(candles,2,2),4);
  assert.ok(Number.isNaN(atr(candles,1,2)));
});

test("a signal candle cannot be used for exit; first check is next candle",()=>{
  assert.equal(firstExitIndex(25),26);
});

test("when stop and target are touched in one candle, stop wins conservatively",()=>{
  assert.equal(intrabarExit({dir:1,low:95,high:110,stop:98,target:110}),"SL");
  assert.equal(intrabarExit({dir:-1,low:90,high:105,stop:102,target:90}),"SL");
  assert.equal(intrabarExit({dir:1,low:99,high:111,stop:98,target:110}),"TP");
  assert.equal(intrabarExit({dir:1,low:99,high:105,stop:98,target:110}),null);
});

test("15m profile input excludes the still-open candle at the minute timestamp",()=>{
  const bars=[{ts:0},{ts:900000},{ts:1800000}];
  assert.deepEqual(closedCandles(bars,1799999,900000),[{ts:0}]);
  assert.deepEqual(closedCandles(bars,1800000,900000),[{ts:0},{ts:900000}]);
});

const {advancePosition,calculateTradePnl}=require("../../backtest-math.js");

function syntheticPosition(overrides={}) {
  return {entry:100,dir:1,risk:2,stop:98,targetR:5,beMoved:false,qty:100,...overrides};
}

test("synthetic long trade: +1R moves stop to cost-adjusted breakeven, next candle exits there",()=>{
  const costRate=.001;
  const afterTrigger=advancePosition(syntheticPosition(),{o:100.5,h:102.2,l:100.5,c:101.8},costRate);
  assert.equal(afterTrigger.exit,null);
  assert.equal(afterTrigger.position.beMoved,true);
  assert.ok(afterTrigger.position.stop>100);
  const afterReturn=advancePosition(afterTrigger.position,{o:101.5,h:101.7,l:100.1,c:100.4},costRate);
  assert.equal(afterReturn.exit.reason,"BE");
  assert.equal(afterReturn.exit.price,afterTrigger.position.stop);
  const pnl=calculateTradePnl({entry:100,exit:afterReturn.exit.price,dir:1,qty:100,feeRate:.0005,slipRate:.0005});
  assert.equal(pnl.net,0,"cost-adjusted BE should be exactly neutral after floating-point normalization");
});

test("synthetic long trade: initial stop and gap through stop use adverse open",()=>{
  const normal=advancePosition(syntheticPosition(),{o:99,h:100,l:97.5,c:98.5},.001);
  assert.deepEqual(normal.exit,{price:98,reason:"SL"});
  const gap=advancePosition(syntheticPosition(),{o:96,h:97,l:94,c:95},.001);
  assert.deepEqual(gap.exit,{price:96,reason:"SL"});
});

test("synthetic long trade: target exits at 5R and costs are deducted",()=>{
  const result=advancePosition(syntheticPosition(),{o:103,h:110.5,l:102.5,c:109.5},.001);
  assert.deepEqual(result.exit,{price:110,reason:"TP"});
  const pnl=calculateTradePnl({entry:100,exit:110,dir:1,qty:100,feeRate:.0005,slipRate:.0005});
  assert.ok(pnl.gross>0&&pnl.fees>0&&pnl.slippage>0&&pnl.net<pnl.gross);
  assert.equal(pnl.gross,10);
});

test("synthetic short trade: +1R BE move and adverse gap are mirrored",()=>{
  const costRate=.001;
  const moved=advancePosition(syntheticPosition({dir:-1,stop:102}),{o:99.5,h:99.5,l:97.8,c:98.2},costRate);
  assert.equal(moved.position.beMoved,true);
  assert.ok(moved.position.stop<100);
  const returned=advancePosition(moved.position,{o:98.5,h:99.9,l:98.3,c:99.5},costRate);
  assert.equal(returned.exit.reason,"BE");
  const gap=advancePosition(syntheticPosition({dir:-1,stop:102}),{o:105,h:107,l:104,c:106},costRate);
  assert.deepEqual(gap.exit,{price:105,reason:"SL"});
});

const {positionSize: sizeForRisk}=require("../../backtest-math.js");

test("position sizing produces exactly 0.5% net loss at the planned stop for LONG and SHORT",()=>{
  const capital=1000, entry=100, riskPct=.5, feeRate=.0005, slipRate=.0002;
  const costRate=feeRate+slipRate, budget=capital*riskPct/100;
  for(const {dir,stop} of [{dir:1,stop:98},{dir:-1,stop:102}]){
    const notional=sizeForRisk({capital,riskPct,entry,stop,costRate});
    const pnl=calculateTradePnl({entry,exit:stop,dir,qty:notional,feeRate,slipRate});
    assert.ok(notional>0&&notional<=capital);
    assert.ok(Math.abs(pnl.net+budget)<1e-9,
      `${dir===1?"LONG":"SHORT"} planned-stop loss should equal ${budget} USDT, got ${pnl.net}`);
  }
});

test("position sizing never exceeds available equity and may risk less when the notional cap binds",()=>{
  const capital=100, entry=100, stop=99.9;
  const notional=sizeForRisk({capital,riskPct:.5,entry,stop,costRate:0});
  assert.equal(notional,capital);
  const pnl=calculateTradePnl({entry,exit:stop,dir:1,qty:notional,feeRate:0,slipRate:0});
  assert.ok(Math.abs(pnl.net)<capital*.005);
});

test("position sizing rejects non-finite inputs",()=>{
  assert.equal(sizeForRisk({capital:Infinity,riskPct:.5,entry:100,stop:98,costRate:.001}),0);
  assert.equal(sizeForRisk({capital:1000,riskPct:.5,entry:100,stop:98,costRate:NaN}),0);
});

test("a gap through the planned stop can exceed the 0.5% risk budget",()=>{
  const capital=1000, entry=100, stop=98, feeRate=.0005, slipRate=.0002;
  const qty=sizeForRisk({capital,riskPct:.5,entry,stop,costRate:feeRate+slipRate});
  const gapFill=95;
  const pnl=calculateTradePnl({entry,exit:gapFill,dir:1,qty,feeRate,slipRate});
  assert.ok(pnl.net < -(capital*.005),
    "gap loss should be greater than the planned stop-risk budget");
});

const {volumeProfile,buildVolumeProfilesByMinute}=require("../../backtest-math.js");

test("synthetic Volume Profile selects POC and 70% value area from typical-price volume bins",()=>{
  const bars=[
    {l:0,h:3,c:1,v:4},
    {l:10,h:20,c:15,v:3},
    {l:27,h:30,c:29,v:10}
  ];
  const profile=volumeProfile(bars,3);
  assert.deepEqual(profile,{poc:25,val:10,vah:30,binWidth:10});
});

test("Volume Profile excludes a 15m candle until the signal 1m candle has closed",()=>{
  const quarter=15*60*1000, minute=60*1000;
  const bars=Array.from({length:96},(_,i)=>({
    ts:i*quarter,l:99,h:101,c:100,v:1
  }));
  const stillOpen15m={ts:96*quarter,l:10000,h:20000,c:15000,v:1e9};
  // The 1m signal candle opens two minutes before the 15m close;
  // its close is still one minute before that 15m candle finishes.
  const tooEarlyMinute={ts:96*quarter-2*minute};
  const tooEarly=buildVolumeProfilesByMinute([tooEarlyMinute],[...bars,stillOpen15m]);
  assert.equal(tooEarly.has(tooEarlyMinute.ts),false);

  // One minute later, the signal candle closes exactly when the 15m bar closes.
  const exactCloseMinute={ts:96*quarter-minute};
  const withoutFuture=buildVolumeProfilesByMinute([exactCloseMinute],bars);
  const withStillOpen=buildVolumeProfilesByMinute([exactCloseMinute],[...bars,stillOpen15m]);
  assert.equal(withoutFuture.has(exactCloseMinute.ts),true);
  assert.deepEqual(withStillOpen.get(exactCloseMinute.ts),withoutFuture.get(exactCloseMinute.ts));
  assert.ok(withStillOpen.get(exactCloseMinute.ts).poc<1000,
    "the high-volume future candle must not move POC into its price range");
});

test("rolling Volume Profile uses only the latest configured number of fully closed 15m bars",()=>{
  const quarter=15*60*1000, minute=60*1000;
  const bars=Array.from({length:98},(_,i)=>({
    ts:i*quarter,l:99,h:101,c:100,v:i===0?1e6:1
  }));
  const signal={ts:97*quarter-minute};
  const profile=buildVolumeProfilesByMinute([signal],bars,{lookback:96});
  assert.equal(profile.has(signal.ts),true);
  const expected=volumeProfile(bars.slice(2,98),30);
  assert.deepEqual(profile.get(signal.ts),expected);
});

test("Volume Profile returns no profile for zero-range or zero-volume history",()=>{
  assert.equal(volumeProfile([{l:10,h:10,c:10,v:5}],30),null);
  assert.equal(volumeProfile([{l:10,h:20,c:15,v:0}],30),null);
});
