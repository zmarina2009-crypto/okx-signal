import { volumeProfileLevels } from "./volume-profile.js";

function clamp(n,min,max) { return Math.min(max,Math.max(min,Number.isFinite(n)?n:min)); }
function average(values) { return values.length ? values.reduce((sum,n)=>sum+n,0)/values.length : 0; }
function smaAt(candles,n,end=candles.length) {
  if (end<n) return null;
  return average(candles.slice(end-n,end).map(c=>Number(c.c)||0));
}
function rsiAt(candles,n,end=candles.length) {
  if (end<n+1) return null;
  let gains=0,losses=0;
  for(let i=end-n;i<end;i++) {
    const delta=Number(candles[i].c)-Number(candles[i-1].c);
    if(delta>0) gains+=delta; else losses-=delta;
  }
  if(!losses) return 100;
  if(!gains) return 0;
  return 100-100/(1+gains/losses);
}

/**
 * Evaluate COMBO 4/4 reversal using predicates on one already-closed candle.
 * The signal candle is excluded from Volume Profile construction.
 * SMA and VP are context filters, not separate events/crossings.
 * profileBuilder is injectable only to make edge cases deterministic in tests.
 */
export function evaluateComboReversal(candles, options={}, profileBuilder=volumeProfileLevels) {
  if(!Array.isArray(candles)||!candles.length) return null;
  const volumePeriod=clamp(Math.round(Number(options.volumePeriod)||20),2,100);
  const volumeMult=Math.max(1,Number(options.volumeMult)||2);
  const rsiPeriod=clamp(Math.round(Number(options.rsiPeriod)||14),2,100);
  const rsiLow=clamp(Number(options.rsiLow)||30,1,49);
  const rsiHigh=clamp(Number(options.rsiHigh)||70,51,99);
  const smaPeriod=clamp(Math.round(Number(options.smaPeriod)||21),2,200);
  const vpPeriod=clamp(Math.round(Number(options.vpPeriod)||60),20,300);
  const vpRows=clamp(Math.floor(Number(options.vpRows)||30),10,60);
  const length=candles.length;
  if(length<Math.max(volumePeriod+1,rsiPeriod+2,smaPeriod,vpPeriod+1)) return null;
  const last=candles[length-1];
  if(!last||![Number(last.c),Number(last.v)].every(Number.isFinite)) return null;

  const priorVolumes=candles.slice(length-volumePeriod-1,length-1).map(c=>Math.max(0,Number(c.v)||0));
  if(priorVolumes.length!==volumePeriod) return null;
  const avgVolume=average(priorVolumes);
  const volumeMultiple=avgVolume>0?Number(last.v)/avgVolume:0;
  if(volumeMultiple<volumeMult) return null;

  const currentRsi=rsiAt(candles,rsiPeriod,length);
  const previousRsi=rsiAt(candles,rsiPeriod,length-1);
  if(currentRsi==null||previousRsi==null) return null;
  let direction=null;
  if(previousRsi<=rsiLow&&currentRsi>rsiLow) direction="LONG";
  else if(previousRsi>=rsiHigh&&currentRsi<rsiHigh) direction="SHORT";
  if(!direction) return null;

  const smaValue=smaAt(candles,smaPeriod,length);
  if(smaValue==null||smaValue<=0) return null;
  if(direction==="LONG"&&Number(last.c)>=smaValue) return null;
  if(direction==="SHORT"&&Number(last.c)<=smaValue) return null;

  const profileBars=candles.slice(0,-1).slice(-vpPeriod);
  if(profileBars.length<vpPeriod) return null;
  const levels=profileBuilder(profileBars,vpRows);
  if(!levels) return null;
  const highs=profileBars.map(c=>Number(c.h)).filter(Number.isFinite);
  const lows=profileBars.map(c=>Number(c.l)).filter(Number.isFinite);
  if(!highs.length||!lows.length) return null;
  const range=Math.max(...highs)-Math.min(...lows);
  if(!(range>0)) return null;
  const binWidth=range/vpRows;
  const vpLevel=direction==="LONG"?"VAL":"VAH";
  const vpPrice=Number(levels[vpLevel.toLowerCase()]);
  if(!Number.isFinite(vpPrice)||Math.abs(Number(last.c)-vpPrice)>binWidth*1.5) return null;

  return {
    direction, ts:Number(last.ts)||0, price:Number(last.c),
    volumeMultiple, rsi:currentRsi, previousRsi, sma:smaValue,
    vpLevel, vpPrice, vpDistance:Math.abs(Number(last.c)-vpPrice), vpBinWidth:binWidth
  };
}
