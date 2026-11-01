(function(root){
  "use strict";
  function breakevenPrice(entry,dir,costRate){
    if(!(entry>0)||![1,-1].includes(dir)||!(costRate>=0&&costRate<1)) throw new RangeError("Invalid breakeven inputs");
    return dir===1 ? entry*(1+costRate)/(1-costRate) : entry*(1-costRate)/(1+costRate);
  }
  function stopFill(stop,open,dir){
    if(![1,-1].includes(dir)||!Number.isFinite(stop)||!Number.isFinite(open)) throw new RangeError("Invalid stop-fill inputs");
    return dir===1 ? Math.min(stop,open) : Math.max(stop,open);
  }
  function positionSize({capital,riskPct,entry,stop,costRate}){
    // All rates are decimal fractions except riskPct, which is entered in percent.
    // Reject non-finite inputs before deriving notional or risk.
    if(![capital,riskPct,entry,stop,costRate].every(Number.isFinite) ||
       !(capital>0&&entry>0&&stop>0&&riskPct>0) || costRate<0 || costRate>=1) return 0;
    const distance=Math.abs(entry-stop);
    // Loss per 1 USDT of entry notional at the planned stop, including both
    // entry/exit fees and slippage. This mirrors calculateTradePnl().
    const lossPerNotional=distance/entry+(1+stop/entry)*costRate;
    if(!(lossPerNotional>0)||!Number.isFinite(lossPerNotional)) return 0;
    const budget=capital*Math.min(5,Math.max(.01,riskPct))/100;
    // No leverage in this tester: entry notional cannot exceed current equity.
    return Math.min(capital,budget/lossPerNotional);
  }
  function targetPrice(entry,dir,risk,targetR){
    if(!(entry>0&&risk>0&&targetR>0)||![1,-1].includes(dir)) throw new RangeError("Invalid target inputs");
    return entry+dir*risk*targetR;
  }
  function atr(candles,index,period=14){
    if(!Array.isArray(candles)||!Number.isInteger(index)||!Number.isInteger(period)||period<1||index<period)return NaN;
    let sum=0;
    for(let i=index-period+1;i<=index;i++){
      const prev=candles[i-1]?.c, cur=candles[i];
      if(!Number.isFinite(prev)||!Number.isFinite(cur?.h)||!Number.isFinite(cur?.l))return NaN;
      sum+=Math.max(cur.h-cur.l,Math.abs(cur.h-prev),Math.abs(cur.l-prev));
    }
    return sum/period;
  }
  function firstExitIndex(signalIndex){return signalIndex+1;}
  function intrabarExit({dir,low,high,stop,target}){
    if(![1,-1].includes(dir))throw new RangeError("Invalid direction");
    const stopHit=dir===1?low<=stop:high>=stop;
    if(stopHit)return "SL";
    const targetHit=dir===1?high>=target:low<=target;
    return targetHit?"TP":null;
  }
  function advancePosition(pos,candle,costRate){
    if(!pos||!candle)throw new TypeError("Position and candle are required");
    const target=targetPrice(pos.entry,pos.dir,pos.risk,pos.targetR);
    const exitType=intrabarExit({dir:pos.dir,low:candle.l,high:candle.h,stop:pos.stop,target});
    if(exitType==="SL")return {position:null,exit:{price:stopFill(pos.stop,candle.o,pos.dir),reason:pos.beMoved?"BE":"SL"}};
    if(exitType==="TP")return {position:null,exit:{price:target,reason:"TP"}};
    const trigger=pos.entry+pos.dir*pos.risk;
    const beHit=pos.dir===1?candle.h>=trigger:candle.l<=trigger;
    if(!pos.beMoved&&beHit){
      const next={...pos,stop:breakevenPrice(pos.entry,pos.dir,costRate),beMoved:true};
      const beStopHit=pos.dir===1?candle.l<=next.stop:candle.h>=next.stop;
      if(beStopHit)return {position:null,exit:{price:next.stop,reason:"BE"}};
      return {position:next,exit:null};
    }
    return {position:pos,exit:null};
  }
  function calculateTradePnl({entry,exit,dir,qty,feeRate,slipRate}){
    if(!(entry>0&&exit>0&&qty>=0)||![1,-1].includes(dir)||feeRate<0||slipRate<0)throw new RangeError("Invalid trade PnL inputs");
    const gross=(exit-entry)*dir*qty/entry;
    const exitNotional=exit*qty/entry;
    const fees=(qty+exitNotional)*feeRate;
    const slippage=(qty+exitNotional)*slipRate;
    const rawNet=gross-fees-slippage;
    // Round-trip BE prices are algebraically neutral; suppress floating-point
    // residue so a zero-result trade is never misclassified as a tiny win/loss.
    const net=Math.abs(rawNet)<1e-8?0:rawNet;
    return {gross,fees,slippage,net};
  }
  function closedCandles(candles,atTimestamp,durationMs){
    if(!Array.isArray(candles)||!Number.isFinite(atTimestamp)||!Number.isFinite(durationMs)||!(durationMs>0))return [];
    return candles.filter(c=>Number.isFinite(c?.ts)&&c.ts+durationMs<=atTimestamp);
  }
  function volumeProfile(candles,rows=30){
    if(!Array.isArray(candles)||!Number.isInteger(rows)||rows<2)return null;
    const bars=candles.filter(c=>Number.isFinite(c?.l)&&Number.isFinite(c?.h)&&Number.isFinite(c?.c)&&
      Number.isFinite(c?.v)&&c.h>=c.l&&c.v>=0);
    if(!bars.length)return null;
    const lo=Math.min(...bars.map(c=>c.l)), hi=Math.max(...bars.map(c=>c.h)), range=hi-lo;
    if(!(range>0))return null;
    const bins=new Array(rows).fill(0);
    for(const c of bars){
      const typical=(c.h+c.l+c.c)/3;
      const k=Math.max(0,Math.min(rows-1,Math.floor((typical-lo)/range*rows)));
      bins[k]+=c.v;
    }
    const total=bins.reduce((a,b)=>a+b,0), maxV=Math.max(...bins);
    if(!(total>0&&maxV>0))return null;
    const poc=bins.indexOf(maxV), target=total*.70;
    let left=poc,right=poc,covered=bins[poc];
    while(covered<target&&(left>0||right<rows-1)){
      const lv=left>0?bins[left-1]:-1, rv=right<rows-1?bins[right+1]:-1;
      if(rv>=lv){right++;covered+=Math.max(0,rv);}else{left--;covered+=Math.max(0,lv);}
    }
    const binWidth=range/rows;
    return {poc:lo+(poc+.5)*binWidth,val:lo+left*binWidth,vah:lo+(right+1)*binWidth,binWidth};
  }
  function buildVolumeProfilesByMinute(minuteCandles,fifteenCandles,options={}){
    if(!Array.isArray(minuteCandles)||!Array.isArray(fifteenCandles))return new Map();
    const rows=Number.isInteger(options.rows)?options.rows:30;
    const lookback=Number.isInteger(options.lookback)?options.lookback:96;
    const barDurationMs=Number.isFinite(options.barDurationMs)?options.barDurationMs:15*60*1000;
    const signalDurationMs=Number.isFinite(options.signalDurationMs)?options.signalDurationMs:60*1000;
    if(rows<2||lookback<1||barDurationMs<=0||signalDurationMs<=0)throw new RangeError("Invalid Volume Profile options");
    const out=new Map(); let j=0;
    for(const minute of minuteCandles){
      if(!Number.isFinite(minute?.ts))continue;
      // OKX candle timestamps mark candle OPEN. The 1m signal is known only
      // at its close, so include 15m bars ending at or before that close.
      const decisionTime=minute.ts+signalDurationMs;
      while(j<fifteenCandles.length&&Number.isFinite(fifteenCandles[j]?.ts)&&
            fifteenCandles[j].ts+barDurationMs<=decisionTime)j++;
      const end=j,start=Math.max(0,end-lookback),history=fifteenCandles.slice(start,end);
      if(history.length<lookback)continue;
      const profile=volumeProfile(history,rows);
      if(profile)out.set(minute.ts,profile);
    }
    return out;
  }

  function smaClose(candles,index,period=21){
    if(!Array.isArray(candles)||!Number.isInteger(index)||!Number.isInteger(period)||period<1||index+1<period)return NaN;
    let sum=0;
    for(let i=index-period+1;i<=index;i++){
      const close=candles[i]?.c;
      if(!Number.isFinite(close))return NaN;
      sum+=close;
    }
    return sum/period;
  }
  function buildMtfContextsByMinute(minuteCandles,fifteenCandles,options={}){
    if(!Array.isArray(minuteCandles)||!Array.isArray(fifteenCandles))return new Map();
    const rows=Number.isInteger(options.rows)?options.rows:30;
    const lookback=Number.isInteger(options.lookback)?options.lookback:96;
    const minuteDurationMs=Number.isFinite(options.minuteDurationMs)?options.minuteDurationMs:60*1000;
    const fifteenDurationMs=Number.isFinite(options.fifteenDurationMs)?options.fifteenDurationMs:15*60*1000;
    if(rows<2||lookback<1||minuteDurationMs<=0||fifteenDurationMs<=0)throw new RangeError("Invalid MTF context options");
    const out=new Map();let j=-1;
    for(const minute of minuteCandles){
      if(!Number.isFinite(minute?.ts))continue;
      const decisionTime=minute.ts+minuteDurationMs;
      // Only a 15m candle whose close is at or before the completed 1m
      // decision time may define the higher-timeframe context.
      while(j+1<fifteenCandles.length&&Number.isFinite(fifteenCandles[j+1]?.ts)&&
            fifteenCandles[j+1].ts+fifteenDurationMs<=decisionTime)j++;
      if(j<lookback||j<23)continue;
      const bar=fifteenCandles[j];
      // The profile is frozen before the current 15m context candle opens.
      // That candle may test/reject VAL or VAH but cannot move its own levels.
      const profile=volumeProfile(fifteenCandles.slice(j-lookback,j),rows);
      const htfSma21=smaClose(fifteenCandles,j,21);
      const htfSma21Past3=smaClose(fifteenCandles,j-3,21);
      if(!profile||![bar.o,bar.h,bar.l,bar.c,htfSma21,htfSma21Past3].every(Number.isFinite))continue;
      const slopeUp=htfSma21>htfSma21Past3;
      const slopeDown=htfSma21<htfSma21Past3;
      const continuationDir=bar.c>htfSma21&&slopeUp&&bar.c>profile.poc+profile.binWidth?1:
        bar.c<htfSma21&&slopeDown&&bar.c<profile.poc-profile.binWidth?-1:0;
      const reversalLong=bar.c<htfSma21&&bar.l<=profile.val+profile.binWidth&&bar.c>profile.val&&bar.c>bar.o;
      const reversalShort=bar.c>htfSma21&&bar.h>=profile.vah-profile.binWidth&&bar.c<profile.vah&&bar.c<bar.o;
      out.set(minute.ts,{
        higherTimeframeTs:bar.ts,htfOpen:bar.o,htfHigh:bar.h,htfLow:bar.l,htfClose:bar.c,
        htfSma21,htfSma21Past3,htfSmaSlope:htfSma21-htfSma21Past3,profile,
        continuationDir,reversalLong,reversalShort
      });
    }
    return out;
  }
  function getMtfEntrySignal(minuteCandles,index,context,scenario){
    if(!Array.isArray(minuteCandles)||!Number.isInteger(index)||index<21||!context||
       !["continuation","reversal"].includes(scenario))return null;
    const current=minuteCandles[index],previous=minuteCandles[index-1];
    if(!current||!previous||![current.o,current.h,current.l,current.c,previous.h,previous.l,previous.c].every(Number.isFinite))return null;
    const currentSma=smaClose(minuteCandles,index,21),previousSma=smaClose(minuteCandles,index-1,21);
    if(!Number.isFinite(currentSma)||!Number.isFinite(previousSma))return null;
    if(scenario==="continuation"){
      if(context.continuationDir===1&&current.l<=currentSma&&current.c>currentSma&&
         current.c>current.o&&current.c>previous.h)return {dir:1,reason:"continuation"};
      if(context.continuationDir===-1&&current.h>=currentSma&&current.c<currentSma&&
         current.c<current.o&&current.c<previous.l)return {dir:-1,reason:"continuation"};
      return null;
    }
    if(context.reversalLong&&previous.c<=previousSma&&current.c>currentSma&&
       current.c>current.o&&current.c>previous.h)return {dir:1,reason:"reversal"};
    if(context.reversalShort&&previous.c>=previousSma&&current.c<currentSma&&
       current.c<current.o&&current.c<previous.l)return {dir:-1,reason:"reversal"};
    return null;
  }

  const api={breakevenPrice,stopFill,positionSize,targetPrice,atr,firstExitIndex,intrabarExit,advancePosition,calculateTradePnl,closedCandles,volumeProfile,buildVolumeProfilesByMinute,smaClose,buildMtfContextsByMinute,getMtfEntrySignal};
  if(typeof module!=="undefined"&&module.exports) module.exports=api;
  root.BacktestMath=api;
})(typeof globalThis!=="undefined"?globalThis:this);
