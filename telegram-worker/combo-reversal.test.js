import test from "node:test";
import assert from "node:assert/strict";
import { evaluateComboReversal } from "./combo-reversal.js";

const options={volumePeriod:20,volumeMult:2,rsiPeriod:14,rsiLow:30,rsiHigh:70,smaPeriod:21,vpPeriod:20,vpRows:30};

function candlesFor(direction) {
  const base=Array.from({length:30},(_,i)=>direction==="LONG"?200-i:100+i);
  const closes=[...base,direction==="LONG"?179:121];
  return closes.map((c,i)=>({
    ts:i*60_000,o:i===30?base.at(-1):c,
    h:c+0.4,l:c-0.4,c,v:i===30?400:100,confirm:true
  }));
}
const longProfile=()=>({poc:184,val:178.5,vah:190});
const shortProfile=()=>({poc:116,val:110,vah:121.5});

test("reversal LONG uses same candle volume, RSI crossback, below-SMA context and VAL proximity",()=>{
  const result=evaluateComboReversal(candlesFor("LONG"),options,longProfile);
  assert.ok(result);
  assert.equal(result.direction,"LONG");
  assert.ok(result.previousRsi<=30);
  assert.ok(result.rsi>30);
  assert.ok(result.price<result.sma);
  assert.equal(result.vpLevel,"VAL");
  assert.ok(result.vpDistance<=result.vpBinWidth*1.5);
  assert.equal(result.ts,30*60_000);
});

test("reversal SHORT uses same candle volume, RSI crossback, above-SMA context and VAH proximity",()=>{
  const result=evaluateComboReversal(candlesFor("SHORT"),options,shortProfile);
  assert.ok(result);
  assert.equal(result.direction,"SHORT");
  assert.ok(result.previousRsi>=70);
  assert.ok(result.rsi<70);
  assert.ok(result.price>result.sma);
  assert.equal(result.vpLevel,"VAH");
  assert.ok(result.vpDistance<=result.vpBinWidth*1.5);
});

test("no reversal COMBO is returned without a same-candle volume spike",()=>{
  const candles=candlesFor("LONG");
  candles.at(-1).v=100;
  assert.equal(evaluateComboReversal(candles,options,longProfile),null);
});

test("no reversal COMBO is returned when RSI has not exited the extreme zone",()=>{
  const candles=candlesFor("LONG");
  candles.at(-1).c=170;
  candles.at(-1).h=170.4;
  candles.at(-1).l=169.6;
  assert.equal(evaluateComboReversal(candles,options,()=>({poc:180,val:170,vah:190})),null);
});

test("no reversal COMBO is returned if price context contradicts the RSI direction",()=>{
  const candles=candlesFor("LONG");
  candles.at(-1).c=199;
  candles.at(-1).h=199.4;
  candles.at(-1).l=198.6;
  assert.equal(evaluateComboReversal(candles,options,()=>({poc:195,val:199,vah:200})),null);
});
