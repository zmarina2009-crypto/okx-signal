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
    </div>
    <div class="btrow" style="margin-top:10px"><button id="btRun" class="primary" type="button">Запустить тест</button><span class="small">ATR(14) • TP1 50% на 1R • TP2 50% на 2R • стоп не переносится</span></div>
    <div id="btStatus" class="btstatus">Нажми «Запустить тест», чтобы загрузить исторические минутные свечи OKX.</div>
    <div id="btResults" class="btresults"></div>
    <div class="tablewrap" style="margin-top:12px"><table class="table"><thead><tr><th>Время входа</th><th>Направление</th><th>Вход</th><th>Стоп</th><th>Выход</th><th>Результат, USDT*</th></tr></thead><tbody id="btTrades"></tbody></table></div>
    <div class="small" style="margin-top:8px">*Расчёт для условной позиции 100 USDT. Для минут, где внутри одной свечи могли сработать и стоп, и тейк, используется консервативное допущение: стоп считается первым. Это исследовательский тест, не прогноз доходности.</div>`;
  const anchor = document.querySelector("footer");
  if (anchor) anchor.parentNode.insertBefore(panel, anchor);
  const $ = id => document.getElementById(id);
  const fmt = n => Number(n).toLocaleString("ru-RU",{maximumFractionDigits:2});
  const BASE = "https://www.okx.com/api/v5/market/candles";
  async function getCandles(days) {
    const target = Math.min(days * 1440, 10000), all = new Map();
    let after = "";
    for (let page=0; page<Math.ceil(target/300); page++) {
      const url = BASE+"?instId=BTC-USDT-SWAP&bar=1m&limit=300"+(after?"&after="+after:"");
      const res = await fetch(url,{cache:"no-store"});
      if(!res.ok) throw Error("HTTP "+res.status);
      const j = await res.json();
      if(j.code!=="0") throw Error(j.msg||"Ошибка OKX");
      const rows = (j.data||[]).map(x=>({ts:+x[0],o:+x[1],h:+x[2],l:+x[3],c:+x[4],confirm:String(x[8]??"1")}))
        .filter(x=>Number.isFinite(x.ts)&&Number.isFinite(x.c)&&x.confirm==="1");
      if(!rows.length) break;
      rows.forEach(x=>all.set(x.ts,x));
      const oldest = Math.min(...rows.map(x=>x.ts));
      if(after && oldest>=Number(after)) break;
      after=String(oldest);
      if(all.size>=target) break;
    }
    return [...all.values()].sort((a,b)=>a.ts-b.ts).slice(-target);
  }
  function sma(a,i,n){if(i+1<n)return NaN;let s=0;for(let k=i-n+1;k<=i;k++)s+=a[k].c;return s/n}
  function atr(a,i,n=14){if(i<n)return NaN;let sum=0;for(let k=i-n+1;k<=i;k++){const p=a[k-1]?.c;if(!Number.isFinite(p))return NaN;sum+=Math.max(a[k].h-a[k].l,Math.abs(a[k].h-p),Math.abs(a[k].l-p))}return sum/n}
  function run(a, mult, feePct, slipPct) {
    const trades=[]; let pos=null, equity=0, peak=0,maxDD=0, wins=0, grossWin=0,grossLoss=0;
    const costPct=(feePct+slipPct)/100;
    function closePart(price, fraction, why, bar) {
      const qty=pos.qty*fraction, dir=pos.dir;
      const raw=(price-pos.entry)*dir*qty/pos.entry*100;
      const costs=(pos.entry+price)*qty/pos.entry*100*costPct;
      const pnl=raw-costs; pos.pnl=(pos.pnl||0)+pnl; equity+=pnl;
      if(pnl>=0)grossWin+=pnl;else grossLoss+=Math.abs(pnl);
      pos.qty-=qty; pos.exit=price;pos.why=why;pos.lastBar=bar;
      if(Math.abs(pos.qty)<1e-8){trades.push(pos);pos=null}
      return pnl;
    }
    for(let i=30;i<a.length;i++){
      const x=a[i], prev=a[i-1], m=sma(a,i,21), mPrev=sma(a,i-1,21), av=atr(a,i,14);
      if(pos){
        const stopHit=pos.dir===1?x.l<=pos.stop:x.h>=pos.stop;
        const tp1Hit=!pos.tp1&&(pos.dir===1?x.h>=pos.entry+pos.risk:x.l<=pos.entry-pos.risk);
        const tp2Hit=pos.tp1&&(pos.dir===1?x.h>=pos.entry+2*pos.risk:x.l<=pos.entry-2*pos.risk);
        if(stopHit){closePart(pos.stop,1,"SL",x.ts);continue}
        if(tp1Hit){closePart(pos.entry+pos.dir*pos.risk,.5,"TP1",x.ts);if(pos){pos.tp1=true;pos.qty=pos.initialQty*.5}}
        if(pos&&tp2Hit){closePart(pos.entry+pos.dir*2*pos.risk,1,"TP2",x.ts);continue}
        peak=Math.max(peak,equity);maxDD=Math.max(maxDD,peak-equity);continue;
      }
      if(!Number.isFinite(av)||!Number.isFinite(m)||!Number.isFinite(mPrev)||av<=0)continue;
      // Pullback to SMA21, then closed-candle directional confirmation.
      const long=prev.l<=mPrev&&prev.c>mPrev&&x.c> x.o&&x.c>m;
      const short=prev.h>=mPrev&&prev.c<mPrev&&x.c<x.o&&x.c<m;
      if(!long&&!short)continue;
      const dir=long?1:-1, entry=x.c*(1+dir*costPct), risk=av*mult;
      pos={ts:x.ts,dir:dir===1?"LONG":"SHORT",entry,stop:entry-dir*risk,risk,qty:1,initialQty:1,tp1:false,pnl:0};
    }
    if(pos){closePart(a.at(-1).c,1,"END",a.at(-1).ts)}
    const net=equity;
    return {trades,net,maxDD,wins:trades.filter(t=>t.pnl>0).length,grossWin,grossLoss};
  }
  $("btRun").addEventListener("click",async()=>{
    const btn=$("btRun");btn.disabled=true;$("btStatus").textContent="Загружаю закрытые свечи BTC-USDT…";$("btResults").innerHTML="";$("btTrades").innerHTML="";
    try{
      const days=+$("btDays").value, mult=Math.max(.1,+$("btAtr").value||1.5), fee=Math.max(0,+$("btFee").value||0), slip=Math.max(0,+$("btSlip").value||0);
      const candles=await getCandles(days);
      if(candles.length<50)throw Error("Недостаточно исторических свечей");
      const r=run(candles,mult,fee,slip), trades=r.trades;
      const metrics=[["Закрытых сделок",trades.length],["Чистый результат",fmt(r.net)+" USDT"],["Win rate",fmt(trades.length?100*r.wins/trades.length:0)+"%"],["Макс. просадка",fmt(r.maxDD)+" USDT"],["Profit Factor",r.grossLoss?fmt(r.grossWin/r.grossLoss):"—"],["Свечей",candles.length]];
      $("btResults").innerHTML=metrics.map(([k,v])=>'<div class="btmetric"><small>'+k+'</small><b>'+v+'</b></div>').join("");
      $("btTrades").innerHTML=trades.slice(-100).reverse().map(t=>'<tr><td>'+new Date(t.ts).toLocaleString("ru-RU")+'</td><td>'+t.dir+'</td><td>'+fmt(t.entry)+'</td><td>'+fmt(t.stop)+'</td><td>'+fmt(t.exit||0)+' ('+t.why+')</td><td>'+fmt(t.pnl||0)+'</td></tr>').join("");
      $("btStatus").textContent="Готово. Загружено "+candles.length+" закрытых свечей. Последние 100 сделок показаны ниже.";
    }catch(e){$("btStatus").textContent="Ошибка теста: "+(e.message||e)}
    finally{btn.disabled=false}
  });
})();