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
    if(!(capital>0&&entry>0&&stop>0&&riskPct>0)||!Number.isFinite(costRate)||costRate<0||costRate>=1) return 0;
    const distance=Math.abs(entry-stop);
    const lossPerNotional=distance/entry+(1+stop/entry)*costRate;
    if(!(lossPerNotional>0)) return 0;
    const budget=capital*Math.min(5,Math.max(.01,riskPct))/100;
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
  function closedCandles(candles,atTimestamp,durationMs){
    if(!Array.isArray(candles)||!Number.isFinite(atTimestamp)||!(durationMs>0))return [];
    return candles.filter(c=>Number.isFinite(c?.ts)&&c.ts+durationMs<=atTimestamp);
  }
  const api={breakevenPrice,stopFill,positionSize,targetPrice,atr,firstExitIndex,intrabarExit,closedCandles};
  if(typeof module!=="undefined"&&module.exports) module.exports=api;
  root.BacktestMath=api;
})(typeof globalThis!=="undefined"?globalThis:this);
