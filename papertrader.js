(() => {
  "use strict";
  const CFG_KEY="okx_paper_cfg_v1", TRADES_KEY="okx_paper_trades_v1", MAX_TRADES=500;
  const defaults={enabled:false,pair:"BTC-USDT-SWAP",tf:"1m",source:"sma",notional:100,atrPeriod:14,atrMult:1.5,fee:.05,slip:.02};
  const read=(key,fallback)=>{try{const v=JSON.parse(localStorage.getItem(key)||"null");return v==null?fallback:v}catch{return fallback}};
  let cfg=Object.assign({},defaults,read(CFG_KEY,{}));
  let trades=read(TRADES_KEY,[]);
  if(!Array.isArray(trades))trades=[];
  trades=trades.filter(t=>t&&t.id&&t.status&&Number.isFinite(Number(t.entry))).slice(-MAX_TRADES);
  let polling=false;
  const pendingTrades=new Set();
  const $=id=>document.getElementById(id);
  const esc=s=>String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
  const tfNorm=tf=>String(tf||"1m").toLowerCase();
  const apiTf=tf=>({"1h":"1H","4h":"4H","1d":"1D"}[tfNorm(tf)]||tfNorm(tf));
  const fmt=n=>Number.isFinite(Number(n))?Number(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:4}):"—";
  const stamp=ts=>new Date(Number(ts)||Date.now()).toLocaleString("ru-RU",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"});
  function saveCfg(){try{localStorage.setItem(CFG_KEY,JSON.stringify(cfg))}catch(e){}}
  function saveTrades(){try{trades=trades.slice(-MAX_TRADES);localStorage.setItem(TRADES_KEY,JSON.stringify(trades))}catch(e){setStatus("Не удалось сохранить журнал: возможно, заполнено хранилище браузера.")}}
  function setStatus(text){const el=$("ptStatus");if(el)el.textContent=text}
  function calcAtr(bars,period){
    if(!Array.isArray(bars)||bars.length<period+1)return null;
    const tr=[];
    for(let i=bars.length-period;i<bars.length;i++){
      const b=bars[i],prev=bars[i-1];
      const h=Number(b.h),l=Number(b.l),pc=Number(prev.c);
      if(![h,l,pc].every(Number.isFinite))continue;
      tr.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
    }
    if(tr.length<period)return null;
    const value=tr.reduce((s,v)=>s+v,0)/tr.length;
    return Number.isFinite(value)&&value>0?value:null;
  }
  function kindAllowed(kind){return cfg.source==="any"||String(kind||"").toLowerCase()===cfg.source}
  function fmtKind(kind){return ({sma:"SMA",rsi:"RSI",volume:"Volume",combo:"COMBO"})[kind]||String(kind||"ALERT").toUpperCase()}
  function render(){
    const el=$("ptEnabledBadge");
    if(el){el.textContent=cfg.enabled?"ВХОДЫ АКТИВНЫ":"ВХОДЫ ПРИОСТАНОВЛЕНЫ";el.className="pt-status-badge "+(cfg.enabled?"active":"paused")}
    const open=trades.filter(t=>t.status==="OPEN"),closed=trades.filter(t=>t.status==="CLOSED");
    const wins=closed.filter(t=>Number(t.pnl)>0),losses=closed.filter(t=>Number(t.pnl)<0);
    const net=closed.reduce((s,t)=>s+(Number(t.pnl)||0),0);
    const grossWin=wins.reduce((s,t)=>s+(Number(t.pnl)||0),0),grossLoss=Math.abs(losses.reduce((s,t)=>s+(Number(t.pnl)||0),0));
    const pf=grossLoss>0?grossWin/grossLoss:null,wr=closed.length?wins.length/closed.length*100:null;
    $("ptOpen").textContent=String(open.length);$("ptClosed").textContent=String(closed.length);
    $("ptWinRate").textContent=wr==null?"—":wr.toFixed(1)+"%";
    $("ptNet").textContent=(net>=0?"+":"")+fmt(net)+" USDT";
    $("ptPF").textContent=pf==null?(grossWin>0?"∞":"—"):pf.toFixed(2);
    const body=$("ptTrades");
    const latest=trades.slice().sort((x,y)=>(Number(y.createdAt)||0)-(Number(x.createdAt)||0)).slice(0,60);
    if(body)body.innerHTML=latest.map(t=>{
      const dir=t.direction==="LONG"?"LONG":"SHORT",color=dir==="LONG"?"#27e58a":"#ff5f68";
      let status=t.status==="OPEN"?(t.tp1Done?"Открыта · TP1 ✓":"Открыта"):((t.closeReason||"CLOSED")+" · "+((Number(t.pnl)>=0?"+":"")+fmt(Number(t.pnl))+" USDT"));
      const source=fmtKind(t.kind);
      return '<tr><td>'+esc(stamp(t.createdAt))+'</td><td>'+esc(source)+' / '+esc(tfNorm(t.tf))+'</td><td style="color:'+color+';font-weight:800">'+dir+'</td><td>'+fmt(t.entry)+'</td><td>'+fmt(t.stop)+'</td><td>'+fmt(t.tp1)+' / '+fmt(t.tp2)+'</td><td>'+esc(status)+'</td></tr>';
    }).join("")||'<tr><td colspan="7" class="small">Пока нет виртуальных сделок. Включи тест и дождись выбранного алерта.</td></tr>';
    if(!latest.length&&body)body.innerHTML='<tr><td colspan="7" class="small">Пока нет виртуальных сделок. Включи тест и дождись выбранного алерта.</td></tr>';
  }
  function build(){
    if($("paperTradingPanel"))return;
    const footer=document.querySelector("footer");
    if(!footer)return;
    const panel=document.createElement("section");
    panel.id="paperTradingPanel";panel.className="panel";
    panel.innerHTML=
      '<h2>🧪 Тестовая торговля · Paper Trading</h2>'+
      '<div class="pt-warning"><b>ДЕМО-РЕЖИМ:</b> реальные ордера не отправляются. Тест реагирует на алерты приложения и хранит виртуальные сделки в этом браузере.</div>'+
      '<div class="pt-controls">'+
        '<label>Пара (OKX instId)<input id="ptPair" type="text" value="BTC-USDT-SWAP" autocomplete="off"></label>'+
        '<label>Таймфрейм теста<select id="ptTf"><option value="1m">1m</option><option value="5m">5m</option><option value="15m">15m</option><option value="30m">30m</option><option value="1h">1h</option><option value="4h">4h</option><option value="1d">1d</option></select></label>'+
        '<label>Источник сигнала<select id="ptSource"><option value="sma">SMA Touch</option><option value="combo">COMBO</option><option value="rsi">RSI</option><option value="volume">Volume</option><option value="any">Все источники</option></select></label>'+
        '<label>Размер позиции, USDT<input id="ptNotional" type="number" min="10" step="10" value="100"></label>'+
        '<label>ATR-множитель стопа<input id="ptAtrMult" type="number" min="0.1" step="0.1" value="1.5"></label>'+
        '<label>Комиссия, % на сторону<input id="ptFee" type="number" min="0" step="0.001" value="0.05"></label>'+
        '<label>Проскальзывание, % на сторону<input id="ptSlip" type="number" min="0" step="0.001" value="0.02"></label>'+
      '</div>'+
      '<div class="pt-buttons"><button id="ptStart" class="primary" type="button">▶ Начать тест</button><button id="ptPause" type="button">Ⅱ Приостановить новые входы</button><button id="ptClear" type="button">Очистить журнал</button><span id="ptEnabledBadge" class="pt-status-badge paused">ВХОДЫ ПРИОСТАНОВЛЕНЫ</span></div>'+
      '<div id="ptStatus" class="pt-status">Для старта выбери ту же пару и таймфрейм в панели Alerts. Приостановка запрещает только новые входы; открытые виртуальные позиции продолжают отслеживаться.</div>'+
      '<div class="pt-metrics"><div><small>Открытых позиций</small><b id="ptOpen">0</b></div><div><small>Закрытых сделок</small><b id="ptClosed">0</b></div><div><small>Доля прибыльных</small><b id="ptWinRate">—</b></div><div><small>Сумма PnL после затрат</small><b id="ptNet">0.00 USDT</b></div><div><small>Profit Factor</small><b id="ptPF">—</b></div></div>'+
      '<div class="small" style="margin:10px 0 6px">Правила: ATR(14) × множитель; стоп по ATR; 50% позиции закрывается на 1R, оставшиеся 50% — на 2R; после TP1 стоп не переносится. Если стоп и тейк попали в одну свечу, консервативно считается, что первым сработал стоп. Одна открытая виртуальная позиция на пару и TF.</div>'+
      '<div class="tablewrap"><table class="table"><thead><tr><th>Время</th><th>Источник / TF</th><th>Сторона</th><th>Вход</th><th>Стоп</th><th>TP1 / TP2</th><th>Состояние / PnL</th></tr></thead><tbody id="ptTrades"></tbody></table></div>'+
      '<div class="small" style="margin-top:8px">Журнал хранится локально в браузере, максимум 500 сделок. Для теста выбери в Alerts ту же пару и таймфрейм; источник должен быть включён там же. Эти сделки не являются реальными ордерами и не гарантируют будущую доходность.</div>';
    footer.parentNode.insertBefore(panel,footer);
    const style=document.createElement("style");
    style.textContent="#paperTradingPanel{margin-top:12px}.pt-warning{padding:9px 11px;border:1px solid #6a4d1f;border-radius:8px;background:#20190e;color:#f2d18b;font-size:11px;line-height:1.45}.pt-controls{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:10px}.pt-controls label{display:block;color:#8290a0;font-size:11px}.pt-controls input,.pt-controls select{display:block;width:100%;min-width:0;margin-top:4px;background:#101823;color:#eaf0f6;border:1px solid #1d2835;border-radius:8px;padding:9px}.pt-buttons{display:flex;align-items:center;flex-wrap:wrap;gap:7px;margin-top:10px}.pt-buttons button{padding:8px 10px;font-size:11px}.pt-status-badge{display:inline-block;border-radius:8px;padding:6px 9px;font-size:10px;font-weight:800}.pt-status-badge.active{background:#0c3a28;color:#27e58a}.pt-status-badge.paused{background:#1a222c;color:#b5c0cc}.pt-status{margin-top:8px;color:#8290a0;font-size:11px;line-height:1.5}.pt-metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:7px;margin-top:10px}.pt-metrics>div{background:#0b1118;border:1px solid #17212d;border-radius:9px;padding:8px}.pt-metrics small{display:block;color:#8290a0;font-size:10px}.pt-metrics b{display:block;margin-top:4px;overflow-wrap:anywhere;font-size:12px}.pt-metrics #ptNet{font-variant-numeric:tabular-nums}@media(max-width:850px){.pt-controls{grid-template-columns:repeat(2,minmax(0,1fr))}.pt-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}";
    document.head.appendChild(style);
  }
  function collectConfig(){
    cfg.pair=String($("ptPair").value||"BTC-USDT-SWAP").trim().toUpperCase();
    if(/^[A-Z0-9]+-USDT$/.test(cfg.pair))cfg.pair+="-SWAP";
    cfg.tf=tfNorm($("ptTf").value||"1m");
    cfg.source=$("ptSource").value||"sma";
    cfg.notional=Math.max(10,Number($("ptNotional").value)||100);
    cfg.atrMult=Math.max(.1,Number($("ptAtrMult").value)||1.5);
    cfg.fee=Math.max(0,Number($("ptFee").value)||0);
    cfg.slip=Math.max(0,Number($("ptSlip").value)||0);
    saveCfg();
  }
  function syncConfig(){
    $("ptPair").value=cfg.pair;$("ptTf").value=cfg.tf;$("ptSource").value=cfg.source;
    $("ptNotional").value=cfg.notional;$("ptAtrMult").value=cfg.atrMult;$("ptFee").value=cfg.fee;$("ptSlip").value=cfg.slip;
  }
  async function openTrade(meta){
    const pair=String(meta.pair||"").toUpperCase(),tf=tfNorm(meta.tf),kind=String(meta.kind||"").toLowerCase();
    const key=pair+"|"+tf;
    if(trades.some(t=>t.status==="OPEN"&&t.pair===pair&&tfNorm(t.tf)===tf)){
      setStatus("Сигнал "+fmtKind(kind)+" пропущен: по "+pair+" / "+tf+" уже есть открытая виртуальная позиция (No trade).");return;
    }
    const id=String(meta.id||[pair,tf,kind,meta.ts,meta.direction].join("|"));
    if(trades.some(t=>t.signalId===id)||pendingTrades.has(key)){return}
    pendingTrades.add(key);
    try{
      const signalTs=Number(meta.ts)||Date.now();
      const entry=Number(meta.entryPrice)>0?Number(meta.entryPrice):Number(meta.price);
      if(!Number.isFinite(entry)||entry<=0){setStatus("Сигнал пропущен: цена входа некорректна.");return}
      const api=window.OKXSignalApp;
      if(!api||typeof api.fetchCandles!=="function"){setStatus("Нет доступа к свечам OKX; виртуальная сделка не открыта.");return}
      const candles=await api.fetchCandles(pair,apiTf(tf),80);
      const history=(Array.isArray(candles)?candles:[]).filter(c=>Number(c.ts)<=signalTs).sort((x,y)=>Number(x.ts)-Number(y.ts));
      const atr=calcAtr(history,14);
      if(!atr){setStatus("Сигнал есть, но для "+pair+" / "+tf+" пока недостаточно закрытых свечей ATR(14). Сделка не открыта.");return}
      if(trades.some(t=>t.status==="OPEN"&&t.pair===pair&&tfNorm(t.tf)===tf)){return}
      const dir=meta.direction==="LONG"?1:-1,risk=atr*cfg.atrMult;
      if(!Number.isFinite(risk)||risk<=0){setStatus("Сигнал пропущен: не удалось рассчитать риск.");return}
      const now=Date.now(),entryCost=cfg.notional*(cfg.fee+cfg.slip)/100;
      const trade={
        id:"pt-"+now+"-"+Math.random().toString(36).slice(2,8),signalId:id,pair,tf,kind,direction:meta.direction,
        label:String(meta.label||kind),entry,atr,atrMult:cfg.atrMult,risk,stop:entry-dir*risk,tp1:entry+dir*risk,tp2:entry+dir*risk*2,
        notional:cfg.notional,feePct:cfg.fee,slipPct:cfg.slip,pnl:-entryCost,gross:0,costs:entryCost,remaining:1,tp1Done:false,
        status:"OPEN",createdAt:now,signalTs,lastProcessedTs:signalTs,exits:[]
      };
      trades.push(trade);saveTrades();render();
      setStatus("Виртуальная сделка открыта: "+pair+" / "+tf+" "+trade.direction+" по "+fmt(entry)+". Реальный ордер не отправлялся.");
    }finally{pendingTrades.delete(key)}
  }
  function finishPortion(t,frac,price,reason,barTs){
    const f=Math.max(0,Math.min(Number(frac)||0,t.remaining));
    if(f<=0)return;
    const qty=Number(t.notional)*f,dir=t.direction==="LONG"?1:-1;
    const raw=(Number(price)-Number(t.entry))*dir*qty/Number(t.entry);
    const costs=qty*(Number(t.feePct||0)+Number(t.slipPct||0))/100;
    t.pnl=(Number(t.pnl)||0)+raw-costs;t.gross=(Number(t.gross)||0)+raw;t.costs=(Number(t.costs)||0)+costs;
    t.remaining=Math.max(0,Number(t.remaining)-f);t.exits.push({price:Number(price),reason,ts:Number(barTs)||Date.now(),portion:f,pnl:raw-costs});
    t.lastProcessedTs=Number(barTs)||t.lastProcessedTs;
    if(t.remaining<1e-6){
      t.remaining=0;t.status="CLOSED";t.closeReason=reason;t.finalExit=Number(price);t.closedAt=Date.now();
    }
  }
  function processBar(t,b){
    const hi=Number(b.h),lo=Number(b.l),ts=Number(b.ts);
    if(![hi,lo,ts].every(Number.isFinite)||ts<=Number(t.lastProcessedTs||t.signalTs))return false;
    t.lastProcessedTs=ts;
    const long=t.direction==="LONG",stopHit=long?lo<=t.stop:hi>=t.stop;
    const tp1Hit=long?hi>=t.tp1:lo<=t.tp1,tp2Hit=long?hi>=t.tp2:lo<=t.tp2;
    if(stopHit){finishPortion(t,t.remaining,t.stop,t.tp1Done?"STOP_AFTER_TP1":"STOP",ts);return true}
    if(!t.tp1Done&&tp1Hit){finishPortion(t,Math.min(.5,t.remaining),t.tp1,"TP1",ts);t.tp1Done=true}
    if(t.status==="OPEN"&&tp2Hit){finishPortion(t,t.remaining,t.tp2,"TP2",ts);return true}
    return false;
  }
  async function processOpenTrades(){
    if(polling)return;
    const open=trades.filter(t=>t.status==="OPEN");
    if(!open.length)return;
    polling=true;
    try{
      const groups=new Map();
      open.forEach(t=>{const key=t.pair+"|"+tfNorm(t.tf);if(!groups.has(key))groups.set(key,{pair:t.pair,tf:tfNorm(t.tf),items:[]});groups.get(key).items.push(t)});
      for(const group of groups.values()){
        try{
          const api=window.OKXSignalApp;if(!api||typeof api.fetchCandles!=="function")continue;
          const bars=await api.fetchCandles(group.pair,apiTf(group.tf),100);
          if(!Array.isArray(bars))continue;
          for(const t of group.items){
            for(const b of bars.slice().sort((x,y)=>Number(x.ts)-Number(y.ts))){
              if(t.status!=="OPEN")break;
              processBar(t,b);
            }
          }
        }catch(e){console.warn("Paper Trading candle polling",e)}
      }
      saveTrades();render();
      const stillOpen=trades.filter(t=>t.status==="OPEN").length;
      if(stillOpen)setStatus("Отслеживаю "+stillOpen+" виртуальную(ые) позицию(и). Закрытые свечи проверяются примерно раз в 12 секунд; реальные ордера не отправляются.");
      else if(!cfg.enabled)setStatus("Открытых виртуальных позиций нет. Новые входы приостановлены.");
    }finally{polling=false}
  }
  function handleMarker(meta){
    if(!meta||!cfg.enabled)return;
    const pair=String(meta.pair||"").toUpperCase(),tf=tfNorm(meta.tf);
    if(pair!==String(cfg.pair).toUpperCase()||tf!==tfNorm(cfg.tf)||!kindAllowed(meta.kind))return;
    if(!["LONG","SHORT"].includes(meta.direction)){return}
    openTrade(meta).catch(e=>{console.warn("Paper Trading open",e);setStatus("Не удалось открыть виртуальную сделку: "+String(e&&e.message||e))});
  }
  function wire(){
    $("ptStart").onclick=()=>{collectConfig();cfg.enabled=true;saveCfg();render();setStatus("Тест запущен. Убедись, что в Alerts выбраны "+cfg.pair+" / "+cfg.tf+" и включён источник "+(cfg.source==="any"?"любые":fmtKind(cfg.source))+". Виртуальные позиции, не реальные ордера.")};
    $("ptPause").onclick=()=>{collectConfig();cfg.enabled=false;saveCfg();render();setStatus("Новые виртуальные входы приостановлены. Уже открытые позиции продолжат отслеживаться.")};
    $("ptClear").onclick=()=>{if(!confirm("Удалить весь журнал Paper Trading, включая открытые виртуальные позиции?"))return;trades=[];saveTrades();render();setStatus("Журнал Paper Trading очищен.")};
    ["ptPair","ptTf","ptSource","ptNotional","ptAtrMult","ptFee","ptSlip"].forEach(id=>{const el=$(id);el.addEventListener("change",()=>{collectConfig();render()})});
    window.addEventListener("okx-alert-marker",ev=>handleMarker(ev.detail));
    window.setInterval(()=>{processOpenTrades().catch(e=>console.warn("Paper Trading",e))},12000);
  }
  function init(){
    build();
    if(!$("paperTradingPanel"))return;
    syncConfig();wire();render();
    if(cfg.enabled)setStatus("Paper Trading восстановлен после перезагрузки. Проверь, что настройки Alerts совпадают; реальные ордера отключены.");
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});else init();
})();