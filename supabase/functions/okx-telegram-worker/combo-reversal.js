import { volumeProfileLevels } from "./volume-profile.js";

export function shouldSendStandaloneTelegram(rule) { return Boolean(rule?.telegram) && rule?.comboOnly !== true; }

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
export function diagnoseComboReversal(candles, options={}, profileBuilder=volumeProfileLevels) {
  const blocked = reason => ({ signal: null, reason });
  if(!Array.isArray(candles)||!candles.length) return blocked("нет свечей");
  const volumePeriod=clamp(Math.round(Number(options.volumePeriod)||20),2,100);
  const volumeMult=Math.max(1,Number(options.volumeMult)||2);
  const rsiPeriod=clamp(Math.round(Number(options.rsiPeriod)||14),2,100);
  const rsiLow=clamp(Number(options.rsiLow)||30,1,49);
  const rsiHigh=clamp(Number(options.rsiHigh)||70,51,99);
  const smaPeriod=clamp(Math.round(Number(options.smaPeriod)||21),2,200);
  const vpPeriod=clamp(Math.round(Number(options.vpPeriod)||60),20,300);
  const vpRows=clamp(Math.floor(Number(options.vpRows)||30),10,60);
  const length=candles.length;
  const requiredLength=Math.max(volumePeriod+1,rsiPeriod+2,smaPeriod,vpPeriod+1);
  if(length<requiredLength) return blocked("недостаточно истории: "+length+"/"+requiredLength+" свечей");
  const last=candles[length-1];
  if(!last||![Number(last.c),Number(last.v)].every(Number.isFinite)) return blocked("в последней свече нет цены или объёма");

  const priorVolumes=candles.slice(length-volumePeriod-1,length-1).map(c=>Math.max(0,Number(c.v)||0));
  if(priorVolumes.length!==volumePeriod) return blocked("недостаточно свечей для среднего объёма");
  const avgVolume=average(priorVolumes);
  const volumeMultiple=avgVolume>0?Number(last.v)/avgVolume:0;
  if(volumeMultiple<volumeMult) return blocked("объём ×"+volumeMultiple.toFixed(2)+" ниже порога ×"+volumeMult.toFixed(2));

  const currentRsi=rsiAt(candles,rsiPeriod,length);
  const previousRsi=rsiAt(candles,rsiPeriod,length-1);
  if(currentRsi==null||previousRsi==null) return blocked("недостаточно данных для RSI");
  let direction=null;
  if(previousRsi<=rsiLow&&currentRsi>rsiLow) direction="LONG";
  else if(previousRsi>=rsiHigh&&currentRsi<rsiHigh) direction="SHORT";
  if(!direction) return blocked("RSI не пересёк уровень разворота (пред. "+previousRsi.toFixed(1)+", сейчас "+currentRsi.toFixed(1)+")");

  const smaValue=smaAt(candles,smaPeriod,length);
  if(smaValue==null||smaValue<=0) return blocked("недостаточно данных для SMA"+smaPeriod);
  if(direction==="LONG"&&Number(last.c)>=smaValue) return blocked("LONG: цена "+Number(last.c).toFixed(4)+" не ниже SMA"+smaPeriod+" "+smaValue.toFixed(4));
  if(direction==="SHORT"&&Number(last.c)<=smaValue) return blocked("SHORT: цена "+Number(last.c).toFixed(4)+" не выше SMA"+smaPeriod+" "+smaValue.toFixed(4));

  const profileBars=candles.slice(0,-1).slice(-vpPeriod);
  if(profileBars.length<vpPeriod) return blocked("недостаточно свечей для Volume Profile "+profileBars.length+"/"+vpPeriod);
  const levels=profileBuilder(profileBars,vpRows);
  if(!levels) return blocked("Volume Profile не смог рассчитать уровни");
  const highs=profileBars.map(c=>Number(c.h)).filter(Number.isFinite);
  const lows=profileBars.map(c=>Number(c.l)).filter(Number.isFinite);
  if(!highs.length||!lows.length) return blocked("в истории VP отсутствуют high/low");
  const range=Math.max(...highs)-Math.min(...lows);
  if(!(range>0)) return blocked("нулевой диапазон Volume Profile");
  const binWidth=range/vpRows;
  const vpLevel=direction==="LONG"?"VAL":"VAH";
  const vpPrice=Number(levels[vpLevel.toLowerCase()]);
  if(!Number.isFinite(vpPrice)) return blocked("Volume Profile не рассчитал "+vpLevel);
  const vpDistance=Math.abs(Number(last.c)-vpPrice);
  if(vpDistance>binWidth*1.5) return blocked("цена далеко от "+vpLevel+": "+(vpDistance/binWidth).toFixed(2)+" bin, максимум 1.50");

  return {
    signal: {
      direction, ts:Number(last.ts)||0, price:Number(last.c),
      volumeMultiple, rsi:currentRsi, previousRsi, sma:smaValue,
      vpLevel, vpPrice, vpDistance, vpBinWidth:binWidth
    },
    reason: null
  };
}

export function evaluateComboReversal(candles, options={}, profileBuilder=volumeProfileLevels) {
  return diagnoseComboReversal(candles, options, profileBuilder).signal;
}
