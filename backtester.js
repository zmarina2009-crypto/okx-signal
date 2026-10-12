(() => {
  "use strict";
  const style = document.createElement("style");
  style.textContent = `
    #smaTester{margin-top:12px}#smaTester .btgrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
    #smaTester label{display:block;color:#8290a0;font-size:11px;margin-bottom:4px}
    #smaTester input,#smaTester select{width:100%;min-width:0;background:#101823;color:#eaf0f6;border:1px solid #1d2835;border-radius:8px;padding:9px}
    #smaTester .btresults{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:12px}
    #smaTester .btmetric{background:#0b1118;border:1px solid #17212d;border-radius:9px;padding:9px}
    #smaTester .btmetric small{display:block;color:#8290a0;font-size:10px}#smaTester .btmetric b{display:block;margin-top:4px;overflow-wrap:anywhere}
    #smaTester .btstatus{color:#8290a0;font-size:11px;margin-top:8px}#smaTester .btrow{display:flex;gap:8px;align-items:end;flex-wrap:wrap}
    @media(max-width:600px){#smaTester .btgrid{grid-template-columns:repeat(2,minmax(0,1fr))}#smaTester .btresults{grid-template-columns:repeat(2,minmax(0,1fr))}}
  `;
  document.head.appendChild(style);
  const panel = document.createElement("section");
  panel.id = "smaTester";
  panel.className = "panel";
  panel.innerHTML = `
    <h2>Тестировщик стратегии SMA21</h2>
    <div class="small">BTC-USDT perpetual • 1m • историческая симуляция, без реальных ордеров</div>
    <div class="btgrid" style="margin-top:10px">
      <div><label for="btDays">История, дней</label><select id="btDays"><option value="1">1 день</option><option value="3" selected>3 дня</option><option value="7">7 дней</option><option value="14">14 дней</option></select></div>
      <div><label for="btFee">Комиссия, % на сторону</label><input id="btFee" type="number" min="0" step="0.001" value="0.05"></div>
      <div><label for="btSlip">Проскальзывание, % на сторону</label><input id="btSlip" type="number" min="0" step="0.001" value="0.02"></div>
      <div><label for="btAtr">ATR-множитель</label><input id="btAtr" type="number" min="0.1" step="0.1" value="1.5"></div>
      <div><label for="btFilter">Фильтр направления</label><select id="btFilter"><option value="none" selected>Без фильтра</option><option value="slope">Наклон SMA21 за 5 свечей</option></select></div>
    </div>
    <div class="btrow" style="margin-top:10px"><button id="btRun" class="primary" type="button">Запустить тест</button><button id="btCompareEntry" type="button">Сравнить оба входа</button><button id="btCompareExit" type="button">Сравнить выходы</button><button id="btCompareTrail" type="button">Сравнить трейлинг 5R</button><button id="btComparePhase" type="button">Сравнить фазы рынка</button><button id="btCompareAdaptive" type="button">Адаптивный выход</button><button id="btCompare" type="button">Сравнить VP-фильтры 15m</button><span class="small">ATR(14) × заданный множитель • базовый выход TP 5R; отдельное сравнение: BE после +1R и ATR-трейлинг</span></div>
    <div id="btStatus" class="btstatus">Нажми «Запустить тест», чтобы загрузить исторические минутные свечи OKX.</div>
    <div id="btResults" class="btresults"></div><div id="btCompareEntryResults" class="tablewrap" style="margin-top:12px"></div><div id="btCompareExitResults" class="tablewrap" style="margin-top:12px"></div><div id="btCompareTrailResults" class="tablewrap" style="margin-top:12px"></div><div id="btComparePhaseResults" class="tablewrap" style="margin-top:12px"></div><div id="btCompareAdaptiveResults" class="tablewrap" style="margin-top:12px"></div><div id="btCompareResults" class="tablewrap" style="margin-top:12px"></div>
    <div class="tablewrap" style="margin-top:12px"><table class="table"><thead><tr><th>Время входа</th><th>Фаза</th><th>Направление</th><th>Вход</th><th>Стоп</th><th>Выход</th><th>Результат, USDT*</th></thead><tbody id="btTrades"></tbody></table></div>
    <div class="small" style="margin-top:8px">*Расчёт для условной позиции 100 USDT. Для минут, где внутри одной свечи могли сработать и стоп, и тейк, используется консервативное допущение: стоп считается первым. Это исследовательский тест, не прогноз доходности.</div>`;
  const anchor = document.querySelector("footer");
  if (anchor) anchor.parentNode.insertBefore(panel, anchor);
  const $ = id => document.getElementById(id);
  const fmt = n => Number(n).toLocaleString("ru-RU",{maximumFractionDigits:2});
  const BASE = "https://www.okx.com/api/v5/market/history-candles";
  async function getCandles(days, bar="1m") {
    const perDay=bar==="15m"?96:1440;
    const target = days * perDay, pages = Math.ceil(target / 300), all = new Map();
    let after = "";
    for (let page=0; page<pages; page++) {
      $("btStatus").textContent = "Загружаю закрытые свечи BTC-USDT "+bar+"… " + Math.min(all.size, target) + " / " + target + " (запрос " + (page+1) + "/" + pages + ")";
      let j = null, lastErr = null;
      for (let attempt=0; attempt<3; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(()=>controller.abort(), 20000);
        try {
          const url = BASE+"?instId=BTC-USDT-SWAP&bar="+bar+"&limit=300"+(after?"&after="+after:"");
          const res = await fetch(url,{cache:"no-store",signal:controller.signal});
          if(!res.ok) throw Error("HTTP "+res.status);
          j = await res.json();
          if(j.code!=="0") throw Error(j.msg||"Ошибка OKX");
          break;
        } catch(e) {
          lastErr=e;
          if(attempt<2) await new Promise(r=>setTimeout(r,1000*(attempt+1)));
        } finally { clearTimeout(timer); }
      }
      if(!j) throw Error("Не удалось загрузить свечи "+bar+": "+(lastErr?.message||"ошибка сети"));
      const rows = (j.data||[]).map(x=>({ts:+x[0],o:+x[1],h:+x[2],l:+x[3],c:+x[4],
        v:Number(x[7]??x[6]??x[5]??0),confirm:String(x[8]??"1")}))
        .filter(x=>Number.isFinite(x.ts)&&Number.isFinite(x.c)&&x.confirm==="1");
      if(!rows.length) break;
      rows.forEach(x=>all.set(x.ts,x));
      const oldest = Math.min(...rows.map(x=>x.ts));
      if(after && oldest>=Number(after)) break;
      after=String(oldest);
      if(all.size>=target) break;
      await new Promise(r=>setTimeout(r,80));
    }
    return [...all.values()].sort((a,b)=>a.ts-b.ts).slice(-target);
  }
  function sma(a,i,n){if(i+1<n)return NaN;let s=0;for(let k=i-n+1;k<=i;k++)s+=a[k].c;return s/n}
  function atr(a,i,n=14){if(i<n)return NaN;let sum=0;for(let k=i-n+1;k<=i;k++){const p=a[k-1]?.c;if(!Number.isFinite(p))return NaN;sum+=Math.max(a[k].h-a[k].l,Math.abs(a[k].h-p),Math.abs(a[k].l-p))}return sum/n}
  const PHASE_LABELS={up:"Тренд ↑",down:"Тренд ↓",range:"Боковик"};
  // Build a causal 15m Volume Profile for each 1m candle timestamp.
  // Profile uses the last 96 fully closed 15m candles (rolling 24h), 30 bins,
  // typical-price volume allocation, and a 70% value area.
  function buildVPByMinute(minuteCandles, fifteenCandles) {
    const out=new Map(); let j=0;
    const rows=30, lookback=96, quarterHour=15*60*1000;
    for(const m of minuteCandles){
      while(j<fifteenCandles.length && fifteenCandles[j].ts+quarterHour<=m.ts) j++;
      const end=j, start=Math.max(0,end-lookback), history=fifteenCandles.slice(start,end);
      if(history.length<lookback) continue;
      const lo=Math.min(...history.map(x=>x.l)), hi=Math.max(...history.map(x=>x.h)), range=hi-lo;
      if(!(range>0)) continue;
      const bins=new Array(rows).fill(0);
      for(const c of history){
        const typical=(c.h+c.l+c.c)/3;
        const k=Math.max(0,Math.min(rows-1,Math.floor((typical-lo)/range*rows)));
        bins[k]+=Math.max(0,Number(c.v)||0);
      }
      const total=bins.reduce((a,b)=>a+b,0), maxV=Math.max(...bins);
      if(!(total>0&&maxV>0)) continue;
      const poc=bins.indexOf(maxV), target=total*.70;
      let left=poc,right=poc,covered=bins[poc];
      while(covered<target&&(left>0||right<rows-1)){
        const lv=left>0?bins[left-1]:-1, rv=right<rows-1?bins[right+1]:-1;
        if(rv>=lv){right++;covered+=Math.max(0,rv);}else{left--;covered+=Math.max(0,lv);}
      }
      const binWidth=range/rows;
      out.set(m.ts,{poc:lo+(poc+.5)*binWidth,val:lo+left*binWidth,vah:lo+(right+1)*binWidth,binWidth});
    }
    return out;
  }
  function marketPhase(a,i){
    const m=sma(a,i,21), m10=sma(a,i-10,21), av=atr(a,i,14);
    if(!Number.isFinite(m)||!Number.isFinite(m10)||!Number.isFinite(av)||av<=0)return "range";
    const slope=(m-m10)/av;
    const dist=Math.abs(a[i].c-m)/av;
    // Uses only candles up to i: no future information.
    if(slope>=0.35 && dist>=0.25)return "up";
    if(slope<=-0.35 && dist>=0.25)return "down";
    return "range";
  }
  // Shared fixed-target backtest engine. Default exit is 5R; optional comparisons
  // may override the target R or choose a target by the market phase at entry.
  function run(a, mult, feePct, slipPct, filterMode, entryMode="current", exitR=null, phaseExit=null, vpFilter=null, vpByMinute=null) {
    const trades=[];
    let pos=null, equity=0, peak=0, maxDD=0, grossTotal=0, feesTotal=0, slippageTotal=0;
    const feeRate=feePct/100, slipRate=slipPct/100, costRate=feeRate+slipRate;

    function close(price, why, bar) {
      const qty=pos.qty, dir=pos.dir;
      const raw=(price-pos.entry)*dir*qty/pos.entry;
      const entryNotional=qty, exitNotional=price*qty/pos.entry;
      const fees=(entryNotional+exitNotional)*feeRate;
      const slippage=(entryNotional+exitNotional)*slipRate;
      const pnl=raw-fees-slippage;
      pos.pnl=pnl; pos.gross=raw; pos.fees=fees; pos.slippage=slippage;
      pos.exit=price; pos.why=why; pos.lastBar=bar;
      grossTotal+=raw; feesTotal+=fees; slippageTotal+=slippage;
      equity+=pnl; peak=Math.max(peak,equity); maxDD=Math.max(maxDD,peak-equity);
      trades.push(pos); pos=null;
    }

    for(let i=30;i<a.length;i++) {
      const x=a[i], prev=a[i-1], mPrev=sma(a,i-1,21), avPrev=atr(a,i-1,14);
      if(pos) {
        // Both levels can be crossed in one OHLC candle; resolve conservatively:
        // stop first, then target.
        const stopHit=pos.dir===1?x.l<=pos.stop:x.h>=pos.stop;
        if(stopHit) { close(pos.stop,"SL",x.ts); continue; }
        const target=pos.entry+pos.dir*pos.targetR*pos.risk;
        const targetHit=pos.dir===1?x.h>=target:x.l<=target;
        if(targetHit) { close(target,"TP"+pos.targetR+"R",x.ts); continue; }

        const mark=pos.dir===1?x.l:x.h;
        const unrealized=(mark-pos.entry)*pos.dir*pos.qty/pos.entry;
        const exitNotional=mark*pos.qty/pos.entry;
        const exitCost=(pos.qty+exitNotional)*costRate;
        const markedEquity=equity+unrealized-exitCost;
        peak=Math.max(peak,markedEquity);
        maxDD=Math.max(maxDD,peak-markedEquity);
        continue;
      }

      if(!Number.isFinite(avPrev)||!Number.isFinite(mPrev)||avPrev<=0) continue;
      // Falling from above into SMA21 => SHORT; rising from below => LONG.
      // Entry price, SMA and ATR use only information available before the
      // touch candle closes. The touch candle's colour is not confirmation.
      const slopeBase=sma(a,i-5,21);
      const slopeUp=Number.isFinite(slopeBase)&&mPrev>slopeBase;
      const slopeDown=Number.isFinite(slopeBase)&&mPrev<slopeBase;
      const touchedFromAbove=prev.c>mPrev&&x.l<=mPrev;
      const touchedFromBelow=prev.c<mPrev&&x.h>=mPrev;
      const threeLong=i>=3&&a[i-3].c<a[i-2].c&&a[i-2].c<a[i-1].c;
      const threeShort=i>=3&&a[i-3].c>a[i-2].c&&a[i-2].c>a[i-1].c;
      let short=touchedFromAbove&&(entryMode!=="3c"||threeShort)&&(filterMode!=="slope"||slopeDown);
      let long=touchedFromBelow&&(entryMode!=="3c"||threeLong)&&(filterMode!=="slope"||slopeUp);
      if(!long&&!short) continue;

      const entry=mPrev;
      if(vpFilter){
        const profile=vpByMinute?.get(x.ts);
        // No profile means no trade: never silently bypass an enabled filter.
        if(!profile){continue;}
        const nearPOC=Math.abs(entry-profile.poc)<=profile.binWidth;
        const nearVAL=Math.abs(entry-profile.val)<=profile.binWidth;
        const nearVAH=Math.abs(entry-profile.vah)<=profile.binWidth;
        if(vpFilter==="poc"){
          if(nearPOC || (long&&entry<=profile.poc) || (short&&entry>=profile.poc)){continue;}
        }else if(vpFilter==="value-area"){
          if((long&&!nearVAL)||(short&&!nearVAH)){continue;}
        }
      }
      const dir=long?1:-1, risk=avPrev*mult, phase=marketPhase(a,i-1);
      const configuredR=phaseExit?(phaseExit[phase]??exitR):exitR;
      const targetR=Number.isFinite(configuredR)&&configuredR>0?configuredR:5;
      pos={ts:x.ts,dir,entry,stop:entry-dir*risk,risk,targetR,qty:100,phase,pnl:0};

      // Entry and exit levels can both be crossed during the touch candle.
      // OHLC does not reveal sequence, so an initial stop takes precedence.
      const initialStopHit=dir===1?x.l<=pos.stop:x.h>=pos.stop;
      if(initialStopHit) { close(pos.stop,"SL",x.ts); continue; }
      const initialTarget=entry+dir*targetR*risk;
      const initialTargetHit=dir===1?x.h>=initialTarget:x.l<=initialTarget;
      if(initialTargetHit) { close(initialTarget,"TP"+targetR+"R",x.ts); continue; }
    }

    if(pos) close(a[a.length-1].c,"END",a[a.length-1].ts);
    const grossWin=trades.reduce((sum,t)=>sum+(t.gross>0?t.gross:0),0);
    const grossLoss=trades.reduce((sum,t)=>sum+(t.gross<0?Math.abs(t.gross):0),0);
    const phaseStats={up:{trades:[],net:0},down:{trades:[],net:0},range:{trades:[],net:0}};
    trades.forEach(t=>{const p=phaseStats[t.phase]||phaseStats.range;p.trades.push(t);p.net+=t.pnl||0;});
    return {trades,net:equity,maxDD,wins:trades.filter(t=>t.pnl>0).length,
      grossWin,grossLoss,grossTotal,feesTotal,slippageTotal,phaseStats};
  }
  $("btCompareEntry").addEventListener("click",async()=>{
    const btn=$("btCompareEntry");btn.disabled=true;
    $("btCompareEntryResults").innerHTML="";
    $("btStatus").textContent="Сравниваю два варианта входа на одном наборе свечей…";
    try{
      const days=+$("btDays").value, mult=Math.max(.1,+$("btAtr").value||1.5), fee=Math.max(0,+$("btFee").value||0), slip=Math.max(0,+$("btSlip").value||0);
      const candles=await getCandles(days);
      if(candles.length<50)throw Error("Недостаточно исторических свечей");
      const filter=$("btFilter").value;
      const a=run(candles,mult,fee,slip,filter,"current");
      const b=run(candles,mult,fee,slip,filter,"3c");
      const pf=r=>r.grossLoss>0?r.grossWin/r.grossLoss:(r.grossWin>0?Infinity:0);
      const wr=r=>r.trades.length?100*r.wins/r.trades.length:0;
      const rows=[
        ["Сделок",a.trades.length,b.trades.length],
        ["Чистый результат, USDT",a.net,b.net],
        ["Win rate",wr(a),wr(b)],
        ["Profit Factor",pf(a),pf(b)],
        ["Макс. просадка, USDT",a.maxDD,b.maxDD],
        ["Комиссии, USDT",a.feesTotal,b.feesTotal],
        ["Проскальзывание, USDT",a.slippageTotal,b.slippageTotal]
      ];
      const show=(v,i)=>i===0?String(Math.round(v)):i===2?fmt(v)+"%":i===3?(v===Infinity?"∞":fmt(v)):fmt(v);
      $("btCompareEntryResults").innerHTML='<table class="table"><thead><tr><th>Показатель</th><th>Текущий вход</th><th>3 свечи</th></tr></thead><tbody>'+rows.map((r,i)=>'<tr><td>'+r[0]+'</td><td>'+show(r[1],i)+'</td><td>'+show(r[2],i)+'</td></tr>').join("")+'</tbody></table>';
      $("btStatus").textContent="Сравнение входов завершено (первое касание SMA21 по направлению подхода) на одном наборе из "+candles.length+" закрытых свечей.";
    }catch(e){$("btStatus").textContent="Ошибка сравнения входов: "+(e.message||e)}
    finally{btn.disabled=false}
  });
  $("btCompareAdaptive").addEventListener("click",async()=>{
    const btn=$("btCompareAdaptive");btn.disabled=true;$("btCompareAdaptiveResults").innerHTML="";
    $("btStatus").textContent="Сравниваю адаптивные выходы по фазам рынка…";
    try{
      const days=+$("btDays").value,mult=Math.max(.1,+$("btAtr").value||1.5),fee=Math.max(0,+$("btFee").value||0),slip=Math.max(0,+$("btSlip").value||0),filter=$("btFilter").value;
      const candles=await getCandles(days); if(candles.length<50)throw Error("Недостаточно исторических свечей");
      const configs=[
        {name:"A: 1:2 / 1:2",up:2,down:2,range:2},
        {name:"B: 1:3 / 1:2",up:3,down:3,range:2},
        {name:"C: 1:5 / 1:2",up:5,down:5,range:2},
        {name:"D: 1:5 / 1:1",up:5,down:5,range:1}
      ];
      const pf=r=>r.grossLoss>0?r.grossWin/r.grossLoss:(r.grossWin>0?Infinity:0);
      const wr=r=>r.trades.length?100*r.wins/r.trades.length:0;
      const rows=[];
      for(const c of configs){
        const a=run(candles,mult,fee,slip,filter,"current",null,c);
        const b=run(candles,mult,fee,slip,filter,"3c",null,c);
        rows.push({name:c.name,a,b});
      }
      let html='<div class="small" style="margin-bottom:6px">Тренд ↑/↓ получает одинаковый TP, боковик — отдельный TP. Все варианты используют один и тот же набор свечей, ATR(14), комиссию и проскальзывание. Выход целиком на TP; частичная фиксация 50%/50% не меняется.</div>';
      html+='<table class="table"><thead><tr><th>Схема</th><th colspan="4">Текущий вход</th><th colspan="4">3 свечи</th></tr><tr><th></th><th>Сделок</th><th>Net</th><th>Win rate</th><th>PF</th><th>Сделок</th><th>Net</th><th>Win rate</th><th>PF</th></tr></thead><tbody>';
      rows.forEach(r=>{
        const x=r.a,y=r.b;
        html+='<tr><td>'+r.name+'</td><td>'+x.trades.length+'</td><td>'+fmt(x.net)+'</td><td>'+fmt(wr(x))+'%</td><td>'+(pf(x)===Infinity?'∞':fmt(pf(x)))+'</td><td>'+y.trades.length+'</td><td>'+fmt(y.net)+'</td><td>'+fmt(wr(y))+'%</td><td>'+(pf(y)===Infinity?'∞':fmt(pf(y)))+'</td></tr>';
      });
      html+='</tbody></table>';
      $("btCompareAdaptiveResults").innerHTML=html;
      $("btStatus").textContent="Адаптивное сравнение завершено на одном наборе из "+candles.length+" закрытых свечей.";
    }catch(e){$("btStatus").textContent="Ошибка адаптивного сравнения: "+(e.message||e)}
    finally{btn.disabled=false}
  });
  $("btComparePhase").addEventListener("click",async()=>{
    const btn=$("btComparePhase");btn.disabled=true;$("btComparePhaseResults").innerHTML="";
    $("btStatus").textContent="Определяю фазу рынка и сравниваю результаты…";
    try{
      const days=+$("btDays").value,mult=Math.max(.1,+$("btAtr").value||1.5),fee=Math.max(0,+$("btFee").value||0),slip=Math.max(0,+$("btSlip").value||0),filter=$("btFilter").value;
      const candles=await getCandles(days); if(candles.length<50)throw Error("Недостаточно исторических свечей");
      const a=run(candles,mult,fee,slip,filter,"current"),b=run(candles,mult,fee,slip,filter,"3c");
      const phases=["up","down","range"];
      const stats=p=>{const t=p.trades,w=t.filter(x=>x.pnl>0).length,g=t.reduce((s,x)=>s+(x.pnl>0?x.pnl:0),0),l=t.reduce((s,x)=>s+(x.pnl<0?Math.abs(x.pnl):0),0);return{n:t.length,net:p.net,wr:t.length?100*w/t.length:0,pf:l?g/l:(g?Infinity:0),dd:calcPhaseDD(t)}};
      function calcPhaseDD(t){
        let e=0,peak=0,dd=0;
        t.forEach(x=>{e+=x.pnl||0;peak=Math.max(peak,e);dd=Math.max(dd,peak-e)});return dd;
      }
      let html='<div class="small" style="margin-bottom:6px">Фаза определяется на момент входа только по прошлым/текущей закрытой свече: наклон SMA21 за 10 свечей нормирован на ATR(14). Сильный наклон → тренд, иначе → боковик. Порог: 0,35 ATR; близость цены к SMA учитывается. Это исследовательская классификация, не готовый торговый фильтр.</div>';
      html+='<table class="table"><thead><tr><th>Фаза</th><th colspan="5">Текущий вход</th><th colspan="5">3 свечи</th></tr><tr><th></th><th>Сделок</th><th>Net</th><th>Win rate</th><th>PF</th><th>DD</th><th>Сделок</th><th>Net</th><th>Win rate</th><th>PF</th><th>DD</th></tr></thead><tbody>';
      phases.forEach(k=>{const x=stats(a.phaseStats[k]),y=stats(b.phaseStats[k]);html+='<tr><td>'+PHASE_LABELS[k]+'</td><td>'+x.n+'</td><td>'+fmt(x.net)+'</td><td>'+fmt(x.wr)+'%</td><td>'+(x.pf===Infinity?'∞':fmt(x.pf))+'</td><td>'+fmt(x.dd)+'</td><td>'+y.n+'</td><td>'+fmt(y.net)+'</td><td>'+fmt(y.wr)+'%</td><td>'+(y.pf===Infinity?'∞':fmt(y.pf))+'</td><td>'+fmt(y.dd)+'</td></tr>'});
      html+='</tbody></table>';
      $("btComparePhaseResults").innerHTML=html;
      $("btStatus").textContent="Фазы рынка определены. Сравнение завершено на одном наборе из "+candles.length+" закрытых свечей.";
    }catch(e){$("btStatus").textContent="Ошибка анализа фаз: "+(e.message||e)}
    finally{btn.disabled=false}
  });
  $("btCompareExit").addEventListener("click",async()=>{
    const btn=$("btCompareExit");btn.disabled=true;
    $("btCompareExitResults").innerHTML="";
    $("btStatus").textContent="Сравниваю варианты выхода 1:1, 1:2, 1:3 и 1:5 на одном наборе свечей…";
    try{
      const days=+$("btDays").value, mult=Math.max(.1,+$("btAtr").value||1.5), fee=Math.max(0,+$("btFee").value||0), slip=Math.max(0,+$("btSlip").value||0);
      const candles=await getCandles(days);
      if(candles.length<50)throw Error("Недостаточно исторических свечей");
      const ratios=[1,2,3,5], filter=$("btFilter").value;
      const results=ratios.map(ratio=>({ratio,current:run(candles,mult,fee,slip,filter,"current",ratio),three:run(candles,mult,fee,slip,filter,"3c",ratio)}));
      const stats=r=>({trades:r.trades.length,net:r.net,wr:r.trades.length?100*r.wins/r.trades.length:0,pf:r.grossLoss>0?r.grossWin/r.grossLoss:(r.grossWin>0?Infinity:0),dd:r.maxDD});
      const rows=[];
      results.forEach(x=>{const a=stats(x.current),b=stats(x.three);rows.push(["1:"+x.ratio,a,b]);});
      const show=(v,type)=>type==="trades"?String(Math.round(v)):type==="wr"?fmt(v)+"%":type==="pf"?(v===Infinity?"∞":fmt(v)):fmt(v);
      let html='<div class="small" style="margin-bottom:6px">Все варианты используют одинаковые свечи, ATR(14) × '+fmt(mult)+', комиссию и проскальзывание. Для каждого варианта позиция закрывается целиком на указанном R. Базовый тест использует TP 5R.</div>';
      html+='<table class="table"><thead><tr><th>Выход</th><th colspan="5">Текущий вход</th><th colspan="5">Вход по 3 свечам</th></tr><tr><th></th><th>Сделок</th><th>Net, USDT</th><th>Win rate</th><th>PF</th><th>DD, USDT</th><th>Сделок</th><th>Net, USDT</th><th>Win rate</th><th>PF</th><th>DD, USDT</th></tr></thead><tbody>';
      rows.forEach(([label,a,b])=>html+='<tr><td>'+label+'</td><td>'+show(a.trades,"trades")+'</td><td>'+show(a.net,"net")+'</td><td>'+show(a.wr,"wr")+'</td><td>'+show(a.pf,"pf")+'</td><td>'+show(a.dd,"dd")+'</td><td>'+show(b.trades,"trades")+'</td><td>'+show(b.net,"net")+'</td><td>'+show(b.wr,"wr")+'</td><td>'+show(b.pf,"pf")+'</td><td>'+show(b.dd,"dd")+'</td></tr>');
      html+='</tbody></table>';
      $("btCompareExitResults").innerHTML=html;
      $("btStatus").textContent="Сравнение выходов завершено на одном наборе из "+candles.length+" закрытых свечей.";
    }catch(e){$("btStatus").textContent="Ошибка сравнения выходов: "+(e.message||e)}
    finally{btn.disabled=false}
  });

  // Separate TP 5R exit comparison. The chart and Live modules are not touched.
  function runTrail5R(a, mult, feePct, slipPct, filterMode, useTrail) {
    const trades=[]; let pos=null, equity=0, peak=0, maxDD=0, grossTotal=0, feesTotal=0, slippageTotal=0;
    let missedTP5R=0, protectedExits=0;
    const feeRate=feePct/100, slipRate=slipPct/100, costRate=feeRate+slipRate;
    function close(price, why, barIndex) {
      const qty=pos.qty, dir=pos.dir;
      const raw=(price-pos.entry)*dir*qty/pos.entry;
      const entryNotional=qty, exitNotional=price*qty/pos.entry;
      const fees=(entryNotional+exitNotional)*feeRate;
      const slippage=(entryNotional+exitNotional)*slipRate;
      const pnl=raw-fees-slippage;
      pos.pnl=pnl; pos.gross=raw; pos.fees=fees; pos.slippage=slippage;
      pos.exit=price; pos.why=why; pos.exitIndex=barIndex;
      grossTotal+=raw; feesTotal+=fees; slippageTotal+=slippage;
      equity+=pnl; peak=Math.max(peak,equity); maxDD=Math.max(maxDD,peak-equity);
      if(useTrail && (why==="TRAIL" || why==="BE")) {
        protectedExits++;
        const target=pos.entry+dir*5*pos.risk;
        const originalStop=pos.entry-dir*pos.risk;
        let outcome="";
        for(let j=barIndex+1;j<a.length;j++){
          const b=a[j];
          const stopHit=dir===1?b.l<=originalStop:b.h>=originalStop;
          const targetHit=dir===1?b.h>=target:b.l<=target;
          if(stopHit){outcome="SL";break}
          if(targetHit){outcome="TP";break}
        }
        if(outcome==="TP")missedTP5R++;
      }
      trades.push(pos); pos=null;
    }
    for(let i=30;i<a.length;i++){
      const x=a[i], prev=a[i-1], mPrev=sma(a,i-1,21), avPrev=atr(a,i-1,14);
      if(pos){
        const target=pos.entry+pos.dir*5*pos.risk;
        // First check levels that were already active before this candle.
        // If both are crossed in one OHLC candle, the stop is counted first.
        const stopHit=pos.dir===1?x.l<=pos.stop:x.h>=pos.stop;
        const targetHit=pos.dir===1?x.h>=target:x.l<=target;
        if(stopHit){close(pos.stop,pos.activated?(pos.stopIsBE?"BE":"TRAIL"):"SL",i);continue}
        if(targetHit){close(target,"TP5R",i);continue}
        if(useTrail && Number.isFinite(avPrev) && avPrev>0){
          const trigger=pos.entry+pos.dir*pos.risk;
          const triggerHit=pos.dir===1?x.h>=trigger:x.l<=trigger;
          if(!pos.activated && triggerHit){
            pos.activated=true;
            pos.stopIsBE=true;
            // Price adjusted so estimated round-trip fees and slippage are covered.
            pos.stop=pos.dir===1
              ? pos.entry*(1+costRate)/(1-costRate)
              : pos.entry*(1-costRate)/(1+costRate);
            // If +1R and the cost-adjusted BE level are both crossed in this
            // candle, OHLC cannot reveal order; conservatively count BE exit.
            const beTouched=pos.dir===1?x.l<=pos.stop:x.h>=pos.stop;
            if(beTouched){close(pos.stop,"BE",i);continue}
          }
          // Use this candle's favorable extreme only to calculate the stop for
          // the NEXT candle. Never test a stop derived from this candle's high/low
          // against the same candle's opposite extreme (look-ahead bias).
          if(pos && pos.activated){
            if(pos.dir===1)pos.best=Math.max(pos.best,x.h);
            else pos.best=Math.min(pos.best,x.l);
            const trail=pos.dir===1?pos.best-avPrev*mult:pos.best+avPrev*mult;
            const tighter=pos.dir===1?Math.max(pos.stop,trail):Math.min(pos.stop,trail);
            if((pos.dir===1 && tighter>pos.stop) || (pos.dir===-1 && tighter<pos.stop)){
              pos.stop=tighter;
              pos.stopIsBE=false;
            }
          }
        }
        const mark=pos.dir===1?x.l:x.h;
        const unrealized=(mark-pos.entry)*pos.dir*pos.qty/pos.entry;
        const exitNotional=mark*pos.qty/pos.entry;
        const exitCost=(pos.qty+exitNotional)*costRate;
        const markedEquity=equity+unrealized-exitCost;
        peak=Math.max(peak,markedEquity);maxDD=Math.max(maxDD,peak-markedEquity);
        continue;
      }
      if(!Number.isFinite(avPrev)||!Number.isFinite(mPrev)||avPrev<=0)continue;
      // First SMA21 touch, direction follows price momentum into the average:
      // falling from above => SHORT; rising from below => LONG.
      // SMA/ATR values come from the previous fully closed candle.
      const approachedFromAbove=prev.c>mPrev && x.l<=mPrev;
      const approachedFromBelow=prev.c<mPrev && x.h>=mPrev;
      const slopeBase=sma(a,i-5,21);
      const slopeUp=Number.isFinite(slopeBase)&&mPrev>slopeBase;
      const slopeDown=Number.isFinite(slopeBase)&&mPrev<slopeBase;
      const short=approachedFromAbove&&(filterMode!=="slope"||slopeDown);
      const long=approachedFromBelow&&(filterMode!=="slope"||slopeUp);
      if(!long&&!short)continue;
      // Signal candle is closed now. Enter at its close and size the stop
      // from ATR(14) including this closed candle. Earlier extremes occurred
      // before entry and must not trigger this position.
      const avSignal=atr(a,i,14);
      if(!Number.isFinite(avSignal)||avSignal<=0)continue;
      const dir=long?1:-1, entry=x.c, risk=avSignal*mult;
      pos={ts:x.ts,dir,entry,stop:entry-dir*risk,risk,qty:100,pnl:0,activated:false,best:entry,entryIndex:i,stopIsBE:false};
    }
    if(pos)close(a[a.length-1].c,"END",a.length-1);
    const grossWin=trades.reduce((s,t)=>s+(t.gross>0?t.gross:0),0);
    const grossLoss=trades.reduce((s,t)=>s+(t.gross<0?Math.abs(t.gross):0),0);
    return {trades,net:equity,maxDD,grossWin,grossLoss,grossTotal,feesTotal,slippageTotal,missedTP5R,protectedExits,
      wins:trades.filter(t=>t.pnl>0).length};
  }
  $("btCompareTrail").addEventListener("click",async()=>{
    const btn=$("btCompareTrail");btn.disabled=true;$("btCompareTrailResults").innerHTML="";
    $("btStatus").textContent="Сравниваю фиксированный TP 5R и безубыток +1R с ATR-трейлингом…";
    try{
      const days=+$("btDays").value,mult=Math.max(.1,+$("btAtr").value||1.5),
        fee=Math.max(0,+$("btFee").value||0),slip=Math.max(0,+$("btSlip").value||0),filter=$("btFilter").value;
      const candles=await getCandles(days);
      if(candles.length<50)throw Error("Недостаточно исторических свечей");
      const a=runTrail5R(candles,mult,fee,slip,filter,false);
      const b=runTrail5R(candles,mult,fee,slip,filter,true);
      const pf=r=>r.grossLoss>0?r.grossWin/r.grossLoss:(r.grossWin>0?Infinity:0);
      const wr=r=>r.trades.length?100*r.wins/r.trades.length:0;
      const rows=[
        ["Закрытые сделки",a.trades.length,b.trades.length],
        ["Чистый результат, USDT",a.net,b.net],
        ["Win rate",wr(a),wr(b)],
        ["Profit Factor",pf(a),pf(b)],
        ["Макс. просадка, USDT",a.maxDD,b.maxDD],
        ["Комиссии, USDT",a.feesTotal,b.feesTotal],
        ["Проскальзывание, USDT",a.slippageTotal,b.slippageTotal],
        ["Сделки с выходом до 5R",0,b.protectedExits],
        ["Упущенные TP 5R после защитного выхода",0,b.missedTP5R]
      ];
      const show=(v,i)=>i===0||i===7||i===8?String(Math.round(v)):i===2?fmt(v)+"%":i===3?(v===Infinity?"∞":fmt(v)):fmt(v);
      let html='<div class="small" style="margin-bottom:7px">Один набор закрытых свечей; вход — первое касание SMA21 без подтверждающей свечи, направление определяется стороной подхода. ATR(14) × '+fmt(mult)+', комиссия '+fmt(fee)+'% и проскальзывание '+fmt(slip)+'% на сторону. Безубыток активируется после +1R; стоп учитывает оценку расходов, затем подтягивается по ATR. Если после защитного выхода цена достигает 5R раньше исходного стопа, сделка учитывается как упущенный TP 5R.</div>';
      html+='<table class="table"><thead><tr><th>Показатель</th><th>База: фиксированный SL / TP 5R</th><th>BE +1R и ATR-трейлинг</th></tr></thead><tbody>';
      html+=rows.map((r,i)=>'<tr><td>'+r[0]+'</td><td>'+show(r[1],i)+'</td><td>'+show(r[2],i)+'</td></tr>').join('');
      html+='</tbody></table><div class="small" style="margin-top:7px">Ограничение данных: минутные OHLC не раскрывают точный порядок тиков внутри свечи. При неоднозначности применяется консервативное правило «стоп раньше тейка»; новые стопы, которые могли быть задеты в той же свече, также считаются сработавшими. Это снижает риск завышения результата, но не заменяет тест по тиковым данным.</div>';
      $("btCompareTrailResults").innerHTML=html;
      $("btStatus").textContent="Сравнение 5R и ATR-трейлинга завершено на "+candles.length+" закрытых минутных свечах.";
    }catch(e){$("btStatus").textContent="Ошибка сравнения трейлинга: "+(e.message||e)}
    finally{btn.disabled=false}
  });

  $("btCompare").addEventListener("click",async()=>{
    const btn=$("btCompare");btn.disabled=true;
    $("btCompareResults").innerHTML="";
    $("btStatus").textContent="Загружаю 1m и 15m историю для сравнения Volume Profile…";
    try{
      const days=+$("btDays").value, mult=Math.max(.1,+$("btAtr").value||1.5),
        fee=Math.max(0,+$("btFee").value||0), slip=Math.max(0,+$("btSlip").value||0);
      const candles=await getCandles(days,"1m");
      // One extra day provides a complete 24h profile before the first tested minute.
      const vpCandles=await getCandles(Math.min(15,days+1),"15m");
      if(candles.length<50)throw Error("Недостаточно минутных свечей");
      if(vpCandles.length<100)throw Error("Недостаточно 15m свечей для построения Volume Profile");
      const vpByMinute=buildVPByMinute(candles,vpCandles);
      const a=run(candles,mult,fee,slip,"none","current",null,null,"poc",vpByMinute);
      const b=run(candles,mult,fee,slip,"none","current",null,null,"value-area",vpByMinute);
      const pf=r=>r.grossLoss>0?r.grossWin/r.grossLoss:(r.grossWin>0?Infinity:0);
      const wr=r=>r.trades.length?100*r.wins/r.trades.length:0;
      const rows=[
        ["Закрытые сделки",a.trades.length,b.trades.length],
        ["Чистый результат, USDT",a.net,b.net],
        ["Win rate",wr(a),wr(b)],
        ["Profit Factor",pf(a),pf(b)],
        ["Макс. просадка, USDT",a.maxDD,b.maxDD],
        ["Валовый результат, USDT",a.grossTotal,b.grossTotal],
        ["Комиссии, USDT",a.feesTotal,b.feesTotal],
        ["Проскальзывание, USDT",a.slippageTotal,b.slippageTotal]
      ];
      const show=(v,i)=>i===0?String(Math.round(v)):i===2?fmt(v)+"%":i===3?(v===Infinity?"∞":fmt(v)):fmt(v);
      let html='<div class="small" style="margin-bottom:7px">Одинаковые закрытые свечи 1m, вход SMA21 по направлению подхода, ATR(14) × '+fmt(mult)+', TP 5R, комиссия '+fmt(fee)+'% и проскальзывание '+fmt(slip)+'% на сторону. VP: последние 96 полностью закрытых свечей 15m (24 часа), 30 ценовых bins, Value Area 70%. «Рядом» = не дальше одного bin. Вариант 1: LONG выше POC / SHORT ниже POC, но входы в пределах одного bin от POC блокируются. Вариант 2: LONG только в пределах одного bin от VAL; SHORT только в пределах одного bin от VAH.</div>';
      html+='<table class="table"><thead><tr><th>Показатель</th><th>1. POC-направление</th><th>2. Отскок от VA</th></tr></thead><tbody>';
      html+=rows.map((r,i)=>'<tr><td>'+r[0]+'</td><td>'+show(r[1],i)+'</td><td>'+show(r[2],i)+'</td></tr>').join("");
      html+='</tbody></table><div class="small" style="margin-top:7px">Для каждого 1m сигнала профиль включает только 15m свечи, закрывшиеся к началу этой минуты; если полного профиля нет, вход блокируется. Объём распределяется по типичной цене свечи (H+L+C)/3 — это приближение, не биржевой tick-level Volume Profile. Если стоп и TP затронуты одной минутной свечой, первым считается стоп.</div>';
      $("btCompareResults").innerHTML=html;
      $("btStatus").textContent="Сравнение VP завершено: "+candles.length+" свечей 1m, "+vpCandles.length+" свечей 15m. Для обоих фильтров использованы одинаковые данные и издержки.";
    }catch(e){$("btStatus").textContent="Ошибка сравнения VP: "+(e.message||e)}
    finally{btn.disabled=false}
  });
  $("btRun").addEventListener("click",async()=>{
    const btn=$("btRun");btn.disabled=true;$("btStatus").textContent="Загружаю закрытые свечи BTC-USDT…";$("btResults").innerHTML="";$("btTrades").innerHTML="";
    try{
      const days=+$("btDays").value, mult=Math.max(.1,+$("btAtr").value||1.5), fee=Math.max(0,+$("btFee").value||0), slip=Math.max(0,+$("btSlip").value||0);
      const candles=await getCandles(days);
      if(candles.length<50)throw Error("Недостаточно исторических свечей");
      const filterMode=$("btFilter").value; const r=run(candles,mult,fee,slip,filterMode), trades=r.trades;
      const count=(fn)=>trades.filter(fn).length; const sum=(fn)=>trades.filter(fn).reduce((v,t)=>v+(t.pnl||0),0); const metrics=[["Закрытых сделок",trades.length],["Валовый результат",fmt(r.grossTotal)+" USDT"],["Комиссии",fmt(r.feesTotal)+" USDT"],["Проскальзывание",fmt(r.slippageTotal)+" USDT"],["Чистый результат",fmt(r.net)+" USDT"],["Win rate",fmt(trades.length?100*r.wins/trades.length:0)+"%"],["Макс. просадка",fmt(r.maxDD)+" USDT"],["Profit Factor (валовый)",r.grossLoss>0?fmt(r.grossWin/r.grossLoss):(r.grossWin>0?"∞":"—")],["TP 5R",count(t=>String(t.why).startsWith("TP"))],["Стоп-лосс",count(t=>t.why==="SL")],["Закрыты по последней свече",count(t=>t.why==="END")],["Результат LONG",fmt(sum(t=>t.dir===1))+" USDT"],["Результат SHORT",fmt(sum(t=>t.dir===-1))+" USDT"],["Свечей",candles.length]];
      $("btResults").innerHTML=metrics.map(([k,v])=>'<div class="btmetric"><small>'+k+'</small><b>'+v+'</b></div>').join("");
      $("btTrades").innerHTML=trades.slice(-100).reverse().map(t=>'<tr><td>'+new Date(t.ts).toLocaleString("ru-RU")+'</td><td>'+((PHASE_LABELS[t.phase])||"Боковик")+'</td><td>'+(t.dir===1?"LONG":"SHORT")+'</td><td>'+fmt(t.entry)+'</td><td>'+fmt(t.stop)+'</td><td>'+fmt(t.exit||0)+' ('+t.why+')</td><td>'+fmt(t.pnl||0)+'</td></tr>').join("");
      $("btStatus").textContent="Готово. Загружено "+candles.length+" закрытых свечей (цель: "+days*1440+"). Фильтр: "+(filterMode==="slope"?"наклон SMA21 за 5 свечей":"без фильтра")+". Последние 100 сделок показаны ниже.";
    }catch(e){$("btStatus").textContent="Ошибка теста: "+(e.message||e)}
    finally{btn.disabled=false}
  });
})();