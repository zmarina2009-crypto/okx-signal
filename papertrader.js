(() => {
  "use strict";
  const CFG_KEY="okx_paper_cfg_v1", TRADES_KEY="okx_paper_trades_v1", SYNC_KEY="okx_paper_sync_v1", MAX_TRADES=500;
  const TF_MS={"1m":60000,"5m":300000,"15m":900000,"30m":1800000,"1h":3600000,"4h":14400000,"1d":86400000};
  const defaults={enabled:false,pair:"BTC-USDT-SWAP",tf:"1m",source:"sma",notional:100,atrPeriod:14,atrMult:1.5,fee:.05,slip:.02};
  const read=(key,fallback)=>{try{const v=JSON.parse(localStorage.getItem(key)||"null");return v==null?fallback:v}catch{return fallback}};
  let cfg=Object.assign({},defaults,read(CFG_KEY,{}));
  let trades=read(TRADES_KEY,[]);
  if(!Array.isArray(trades))trades=[];
  trades=trades.filter(t=>t&&t.id&&t.status&&Number.isFinite(Number(t.entry))).slice(-MAX_TRADES);
  let syncState=read(SYNC_KEY,null);
  if(!syncState||typeof syncState!=="object")syncState=null;
  let catchingUp=false;
  let deferredMarkers=[];
  const pendingTrades=new Set();
  const $=id=>document.getElementById(id);
  const esc=s=>String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
  const tfNorm=tf=>String(tf||"1m").toLowerCase();
  const apiTf=tf=>({"1h":"1H","4h":"4H","1d":"1D"}[tfNorm(tf)]||tfNorm(tf));
  const fmt=n=>Number.isFinite(Number(n))?Number(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:4}):"—";
  const stamp=ts=>new Date(Number(ts)||Date.now()).toLocaleString("ru-RU",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"});
  function saveCfg(){try{localStorage.setItem(CFG_KEY,JSON.stringify(cfg))}catch(e){}}
  function saveTrades(){try{trades=trades.slice(-MAX_TRADES);localStorage.setItem(TRADES_KEY,JSON.stringify(trades))}catch(e){setStatus("Не удалось сохранить журнал: возможно, заполнено хранилище браузера.")}}
  function saveSync(){try{localStorage.setItem(SYNC_KEY,JSON.stringify(syncState))}catch(e){setStatus("Не удалось сохранить точку восстановления теста.")}}
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
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  function readAlertCfg(){return read("okx_alerts_v1",{})||{}}
  function configMatchesSync(){return !!syncState&&syncState.pair===cfg.pair&&tfNorm(syncState.tf)===tfNorm(cfg.tf)&&syncState.source===cfg.source&&Number.isFinite(Number(syncState.lastTs))}
  async function seedSync(){
    if(configMatchesSync())return;
    const matchingOpen=trades.filter(t=>t.status==="OPEN"&&String(t.pair).toUpperCase()===String(cfg.pair).toUpperCase()&&tfNorm(t.tf)===tfNorm(cfg.tf));
    let lastTs=0;
    if(matchingOpen.length){
      lastTs=Math.min(...matchingOpen.map(t=>Number(t.lastProcessedTs)||Number(t.signalTs)||Date.now()));
    }else{
      const api=window.OKXSignalApp;
      if(!api||typeof api.fetchCandles!=="function")throw Error("Свечи OKX пока недоступны");
      const bars=await api.fetchCandles(cfg.pair,apiTf(cfg.tf),5);
      const closed=(Array.isArray(bars)?bars:[]).filter(b=>Number.isFinite(Number(b.ts))).sort((x,y)=>Number(x.ts)-Number(y.ts));
      if(!closed.length)throw Error("Не удалось получить последнюю закрытую свечу");
      lastTs=Number(closed.at(-1).ts);
    }
    syncState={pair:cfg.pair,tf:tfNorm(cfg.tf),source:cfg.source,lastTs,updatedAt:Date.now()};
    saveSync();
  }
  async function advanceSyncToLatest(){
    const api=window.OKXSignalApp;
    if(!api||typeof api.fetchCandles!=="function")throw Error("Свечи OKX пока недоступны");
    const bars=await api.fetchCandles(cfg.pair,apiTf(cfg.tf),5);
    const closed=(Array.isArray(bars)?bars:[]).filter(b=>Number.isFinite(Number(b.ts))).sort((x,y)=>Number(x.ts)-Number(y.ts));
    if(!closed.length)throw Error("Не удалось получить последнюю закрытую свечу");
    syncState={pair:cfg.pair,tf:tfNorm(cfg.tf),source:cfg.source,lastTs:Number(closed.at(-1).ts),updatedAt:Date.now()};
    saveSync();
  }
  async function fetchHistory(pair,tf,sinceTs){
    const urlBase="https://www.okx.com/api/v5/market/history-candles";
    const from=Number(sinceTs)||0,found=new Map();let after="",complete=false,lastOldest=Infinity;
    const maxPages=120;
    for(let page=0;page<maxPages;page++){
      const url=urlBase+"?instId="+encodeURIComponent(pair)+"&bar="+encodeURIComponent(apiTf(tf))+"&limit=300"+(after?"&after="+encodeURIComponent(after):"");
      let payload=null,lastErr=null;
      for(let attempt=0;attempt<3;attempt++){
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),18000);
        try{
          const res=await fetch(url,{cache:"no-store",signal:controller.signal});
          if(!res.ok)throw Error("HTTP "+res.status);
          payload=await res.json();
          if(payload.code!=="0")throw Error(payload.msg||"OKX code "+payload.code);
          break;
        }catch(e){lastErr=e;if(attempt<2)await delay(500*(attempt+1))}
        finally{clearTimeout(timer)}
      }
      if(!payload)throw Error("Не удалось загрузить историю OKX: "+String(lastErr&&lastErr.message||"ошибка сети"));
      const rows=Array.isArray(payload.data)?payload.data:[];
      if(!rows.length){complete=lastOldest<=from;break}
      const pageBars=rows.map(x=>({ts:Number(x[0]),o:Number(x[1]),h:Number(x[2]),l:Number(x[3]),c:Number(x[4]),v:Number(x[5]),confirm:String(x[8]??"1")}))
        .filter(b=>Number.isFinite(b.ts)&&Number.isFinite(b.o)&&Number.isFinite(b.h)&&Number.isFinite(b.l)&&Number.isFinite(b.c));
      pageBars.filter(b=>b.confirm==="1").forEach(b=>found.set(b.ts,b));
      const oldest=Math.min(...pageBars.map(b=>b.ts));
      lastOldest=oldest;
      if(oldest<=from){complete=true;break}
      if(after&&oldest>=Number(after))break;
      after=String(oldest);
      if(rows.length<300)break;
      await delay(110);
    }
    const bars=[...found.values()].filter(b=>b.ts>=from).sort((x,y)=>x.ts-y.ts);
    return {bars,complete,oldest:lastOldest};
  }
  function meanClose(bars,n){
    if(!Array.isArray(bars)||bars.length<n)return null;
    let sum=0;for(let i=bars.length-n;i<bars.length;i++)sum+=Number(bars[i].c)||0;
    return sum/n;
  }
  function calcRsi(bars,n){
    if(!Array.isArray(bars)||bars.length<n+1)return null;
    let gain=0,loss=0;
    for(let i=bars.length-n;i<bars.length;i++){
      const d=(Number(bars[i].c)||0)-(Number(bars[i-1].c)||0);
      if(d>0)gain+=d;else loss-=d;
    }
    if(loss===0)return 100;
    if(gain===0)return 0;
    return 100-(100/(1+gain/loss));
  }
  function historicalSignals(bars,pair,tf,ac){
    const result=[],volN=Math.max(2,Number(ac.volumePeriod)||20),rsiN=Math.max(2,Number(ac.rsiPeriod)||14),smaN=Math.max(2,Number(ac.smaPeriod)||21);
    const low=Math.min(49,Math.max(1,Number(ac.rsiLow)||30)),high=Math.min(99,Math.max(51,Number(ac.rsiHigh)||70));
    const tolerance=Math.max(0,Number(ac.smaTolerance)||0)/100;
    let lastSmaTouch=false;
    const add=(kind,ts,direction,price,entryPrice,label,atr)=>{
      if(!["LONG","SHORT"].includes(direction)||!(Number(entryPrice)>0))return;
      result.push({id:[pair,tf,kind,ts,direction].join("|"),pair,tf,kind,ts,direction,price:Number(price)||Number(entryPrice),entryPrice:Number(entryPrice),label,atr:Number(atr)||0});
    };
    for(let i=1;i<bars.length;i++){
      const bar=bars[i],prev=bars[i-1];
      if(ac.volume&&i>=volN){
        const base=bars.slice(i-volN,i),avg=base.reduce((s,b)=>s+(Number(b.v)||0),0)/base.length,mult=avg>0?(Number(bar.v)||0)/avg:0;
        if(mult>=Math.max(1,Number(ac.volumeMult)||2))add("volume",bar.ts,Number(bar.c)>=Number(bar.o)?"LONG":"SHORT",bar.c,bar.c,"VOLUME",calcAtr(bars.slice(0,i),14));
      }
      if(ac.rsi){
        const oldRsi=calcRsi(bars.slice(0,i),rsiN),newRsi=calcRsi(bars.slice(0,i+1),rsiN);
        if(oldRsi!=null&&newRsi!=null){
          if(oldRsi>=low&&newRsi<low)add("rsi",bar.ts,"LONG",bar.c,bar.c,"RSI",calcAtr(bars.slice(0,i),14));
          if(oldRsi<=high&&newRsi>high)add("rsi",bar.ts,"SHORT",bar.c,bar.c,"RSI",calcAtr(bars.slice(0,i),14));
        }
      }
      if(ac.sma){
        const m=meanClose(bars.slice(0,i),smaN);
        let touched=false;
        if(m!=null&&m>0){
          const price=Number(bar.c)||0,hi=Number(bar.h)||price,lo=Number(bar.l)||price;
          touched=(price>0&&lo<=m&&hi>=m)||(tolerance>0&&price>0&&Math.abs(price-m)/m<=tolerance);
          if(touched&&!lastSmaTouch){
            const prevPrice=Number(prev.c)||price,prevSma=meanClose(bars.slice(0,i-1),smaN)||m;
            const direction=prevPrice<prevSma?"LONG":prevPrice>prevSma?"SHORT":price>=m?"LONG":"SHORT";
            add("sma",bar.ts,direction,m,price,"SMA"+smaN,calcAtr(bars.slice(0,i),14));
          }
        }
        lastSmaTouch=touched;
      }
    }
    result.sort((x,y)=>x.ts-y.ts||({volume:0,rsi:1,sma:2}[x.kind]??3)-({volume:0,rsi:1,sma:2}[y.kind]??3));
    if(!ac.comboEnabled)return result;
    const windowMs=(TF_MS[tfNorm(tf)]||900000)*Math.max(1,Math.min(5,Number(ac.comboWindow)||1));
    const required=Math.max(2,Math.min(3,Number(ac.comboCount)||2)),seen=[],combos=[],lastAt={};
    for(const current of result.slice()){
      if(!["volume","rsi","sma"].includes(current.kind)||!ac[current.kind])continue;
      seen.push(current);
      const matching=seen.filter(x=>x.pair===pair&&x.tf===tf&&Math.abs(current.ts-x.ts)<=windowMs);
      const byKind=new Map();
      matching.forEach(s=>{const old=byKind.get(s.kind);if(!old||Math.abs(current.ts-s.ts)<Math.abs(current.ts-old.ts))byKind.set(s.kind,s)});
      const chosen=[...byKind.values()];
      if(chosen.length<required)continue;
      const directional=chosen.filter(x=>x.kind!=="volume");
      if(!directional.length)continue;
      const direction=directional[0].direction;
      if(directional.some(x=>x.direction!==direction))continue;
      const comboTs=Math.max(...chosen.map(x=>Number(x.ts)||0)),key=pair+"|"+tf+"|"+direction;
      if(lastAt[key]&&Math.abs(comboTs-lastAt[key])<=windowMs)continue;
      lastAt[key]=comboTs;
      const source=directional.slice().sort((x,y)=>Math.abs(current.ts-x.ts)-Math.abs(current.ts-y.ts))[0];
      const label="COMBO "+chosen.map(x=>x.kind.toUpperCase()).join("+");
      const item={id:[pair,tf,"combo",comboTs,direction].join("|"),pair,tf,kind:"combo",ts:comboTs,direction,price:source.price,entryPrice:source.entryPrice,label,atr:source.atr};
      if(!combos.some(x=>x.id===item.id))combos.push(item);
    }
    return result.concat(combos).sort((x,y)=>x.ts-y.ts||({volume:0,rsi:1,sma:2,combo:3}[x.kind]??4)-({volume:0,rsi:1,sma:2,combo:3}[y.kind]??4));
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
      '<div class="pt-warning"><b>ДЕМО-РЕЖИМ:</b> реальные ордера не отправляются. Журнал и точка восстановления хранятся в браузере. Когда приложение закрыто, расчёты не выполняются; при возвращении тест догоняет пропущенный период по закрытым историческим свечам OKX (до доступной глубины истории).</div>'+
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
      '<div class="small" style="margin-top:8px">Журнал хранится локально в браузере, максимум 500 сделок. После открытия приложения тест восстанавливает новые сигналы и проверяет пропущенные стопы/тейки по закрытым историческим свечам. Для теста выбери в Alerts ту же пару, таймфрейм и источник. Эти сделки не являются реальными ордерами и не гарантируют будущую доходность.</div>';
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
    const id=String(meta.id||[pair,tf,kind,meta.ts,meta.direction].join("|"));
    if(trades.some(t=>t.signalId===id)||pendingTrades.has(key)){return}
    if(trades.some(t=>t.status==="OPEN"&&t.pair===pair&&tfNorm(t.tf)===tf)){
      setStatus("Сигнал "+fmtKind(kind)+" пропущен: по "+pair+" / "+tf+" уже есть открытая виртуальная позиция (No trade).");return;
    }
    pendingTrades.add(key);
    try{
      const signalTs=Number(meta.ts)||Date.now();
      const entry=Number(meta.entryPrice)>0?Number(meta.entryPrice):Number(meta.price);
      if(!Number.isFinite(entry)||entry<=0){setStatus("Сигнал пропущен: цена входа некорректна.");return}
      let atr=Number(meta.atr)>0?Number(meta.atr):null;
      if(!atr){
        const api=window.OKXSignalApp;
        if(!api||typeof api.fetchCandles!=="function"){setStatus("Нет доступа к свечам OKX; виртуальная сделка не открыта.");return}
        const candles=await api.fetchCandles(pair,apiTf(tf),80);
        const history=(Array.isArray(candles)?candles:[]).filter(c=>Number(c.ts)<=signalTs).sort((x,y)=>Number(x.ts)-Number(y.ts));
        atr=calcAtr(history,14);
      }
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
  async function catchUpHistory(reason="periodic"){
    if(catchingUp)return;
    catchingUp=true;
    let created=0,closedBefore=trades.filter(t=>t.status==="CLOSED").length,barCount=0;
    try{
      await seedSync();
      const pair=String(cfg.pair||"BTC-USDT-SWAP").toUpperCase(),tf=tfNorm(cfg.tf||"1m");
      const step=TF_MS[tf]||60000,alertCfg=readAlertCfg();
      const matchingAlerts=String(alertCfg.alertTf||"15m").toLowerCase()===tf&&(alertCfg.selectedPairs||[]).includes(pair);
      const openMatching=trades.filter(t=>t.status==="OPEN"&&String(t.pair).toUpperCase()===pair&&tfNorm(t.tf)===tf);
      const cursor=Number(syncState.lastTs)||Date.now();
      const indicatorLookback=Math.max(120,Number(alertCfg.volumePeriod)||20,(Number(alertCfg.rsiPeriod)||14)+5,(Number(alertCfg.smaPeriod)||21)+10);
      const tradeStarts=openMatching.map(t=>Number(t.lastProcessedTs)||Number(t.signalTs)||cursor);
      const replayFrom=Math.min(cursor,...tradeStarts);
      const startTs=Math.max(0,replayFrom-indicatorLookback*step);
      setStatus("Восстанавливаю историю после перерыва… Загружаю закрытые свечи OKX.");
      const result=await fetchHistory(pair,tf,startTs);
      if(!result.complete){
        setStatus("Не удалось загрузить всю историю после перерыва. Точка восстановления сохранена; открой приложение с устойчивым соединением и повтори попытку. Реальные ордера не отправляются.");
        return;
      }
      const bars=result.bars;
      if(!bars.length){
        const latest=Number(syncState.lastTs)||0;
        setStatus("Нет новых закрытых свечей для синхронизации. Последняя точка: "+stamp(latest)+".");
        return;
      }
      const events=matchingAlerts?historicalSignals(bars,pair,tf,alertCfg).filter(x=>x.ts>cursor&&kindAllowed(x.kind)).reduce((map,x)=>{
        if(!map.has(x.ts))map.set(x.ts,[]);
        map.get(x.ts).push(x);return map;
      },new Map()):new Map();
      const startReplay=Math.min(cursor,...tradeStarts);
      const replayBars=bars.filter(b=>b.ts>startReplay&&b.ts<=bars.at(-1).ts);
      for(const bar of replayBars){
        const blockedAtBar=new Set();
        for(const trade of trades.filter(t=>t.status==="OPEN"&&String(t.pair).toUpperCase()===pair&&tfNorm(t.tf)===tf)){
          if(Number(bar.ts)>Number(trade.lastProcessedTs||trade.signalTs||0)){
            blockedAtBar.add(pair+"|"+tf);
            processBar(trade,bar);
          }
        }
        if(Number(bar.ts)<=cursor)continue;
        barCount++;
        if(!cfg.enabled||!matchingAlerts||blockedAtBar.has(pair+"|"+tf))continue;
        const list=events.get(Number(bar.ts))||[];
        for(const sig of list){
          if(!cfg.enabled)break;
          if(!kindAllowed(sig.kind))continue;
          if(trades.some(t=>t.status==="OPEN"&&String(t.pair).toUpperCase()===pair&&tfNorm(t.tf)===tf))break;
          const before=trades.length;
          await openTrade(sig);
          if(trades.length>before)created++;
        }
      }
      // Also recover any open positions on a different pair/timeframe retained in the journal.
      const otherGroups=new Map();
      trades.filter(t=>t.status==="OPEN"&&(String(t.pair).toUpperCase()!==pair||tfNorm(t.tf)!==tf)).forEach(t=>{
        const key=String(t.pair).toUpperCase()+"|"+tfNorm(t.tf);
        if(!otherGroups.has(key))otherGroups.set(key,{pair:String(t.pair).toUpperCase(),tf:tfNorm(t.tf),items:[]});
        otherGroups.get(key).items.push(t);
      });
      for(const group of otherGroups.values()){
        const fromTs=Math.min(...group.items.map(t=>Number(t.lastProcessedTs)||Number(t.signalTs)||Date.now()));
        const extra=await fetchHistory(group.pair,group.tf,Math.max(0,fromTs-(TF_MS[group.tf]||60000)));
        if(!extra.complete)continue;
        for(const trade of group.items){
          for(const bar of extra.bars.slice().sort((x,y)=>x.ts-y.ts)){
            if(trade.status!=="OPEN")break;
            if(Number(bar.ts)>Number(trade.lastProcessedTs||trade.signalTs||0))processBar(trade,bar);
          }
        }
      }
      const latestTs=Number(bars.at(-1).ts)||cursor;
      syncState={pair,tf,source:cfg.source,lastTs:Math.max(cursor,latestTs),updatedAt:Date.now()};
      // Persist trades before advancing the cursor; on a crash we can safely replay and deduplicate.
      saveTrades();saveSync();render();
      const closedAfter=trades.filter(t=>t.status==="CLOSED").length;
      const resultText="Синхронизация завершена: проверено "+barCount+" новых свечей; новых сделок "+created+"; закрыто за восстановление "+Math.max(0,closedAfter-closedBefore)+". Последняя свеча "+stamp(latestTs)+".";
      setStatus(resultText+(cfg.enabled?" Тест активен; новые сигналы восстановлены по истории.":" Новые входы приостановлены."));
    }catch(e){
      console.warn("Paper Trading history replay",e);
      setStatus("Не удалось восстановить тест по истории: "+String(e&&e.message||e)+". Попробую снова автоматически.");
    }finally{
      catchingUp=false;
      const queue=deferredMarkers.splice(0);
      queue.forEach(meta=>handleMarker(meta));
    }
  }
  function handleMarker(meta){
    if(!meta||!cfg.enabled)return;
    if(catchingUp){deferredMarkers.push(meta);return}
    const pair=String(meta.pair||"").toUpperCase(),tf=tfNorm(meta.tf);
    if(pair!==String(cfg.pair).toUpperCase()||tf!==tfNorm(cfg.tf)||!kindAllowed(meta.kind))return;
    if(!["LONG","SHORT"].includes(meta.direction)){return}
    openTrade(meta).catch(e=>{console.warn("Paper Trading open",e);setStatus("Не удалось открыть виртуальную сделку: "+String(e&&e.message||e))});
  }
  function wire(){
    $("ptStart").onclick=async()=>{
      const wasEnabled=cfg.enabled;
      collectConfig();
      try{
        await seedSync();
        // When resuming a paused test, skip signals from the paused interval,
        // while still replaying bars for any positions that were already open.
        if(!wasEnabled)await advanceSyncToLatest();
      }catch(e){setStatus("Не удалось запустить тест: "+String(e&&e.message||e));return}
      cfg.enabled=true;saveCfg();render();
      const ac=readAlertCfg(),selected=(ac.selectedPairs||[]).includes(cfg.pair),tfMatch=tfNorm(ac.alertTf||"15m")===tfNorm(cfg.tf);
      setStatus("Тест включён. "+(selected&&tfMatch?"Пары и таймфрейм Alerts совпадают.":"Проверь Alerts: нужны та же пара, таймфрейм и выбранный источник.")+" Виртуальные позиции; реальные ордера не отправляются.");
      catchUpHistory("start").catch(()=>{});
    };
    $("ptPause").onclick=async()=>{
      collectConfig();cfg.enabled=false;saveCfg();render();
      try{await advanceSyncToLatest();setStatus("Новые виртуальные входы приостановлены. Уже открытые позиции продолжат отслеживаться и восстановятся при следующем открытии; сигналы во время паузы пропускаются.")}
      catch(e){setStatus("Пауза включена, но не удалось обновить точку восстановления: "+String(e&&e.message||e))}
    };
    $("ptClear").onclick=()=>{if(!confirm("Удалить весь журнал Paper Trading, включая открытые виртуальные позиции?"))return;trades=[];saveTrades();render();setStatus("Журнал Paper Trading очищен.")};
    ["ptPair","ptTf","ptSource","ptNotional","ptAtrMult","ptFee","ptSlip"].forEach(id=>{const el=$(id);el.addEventListener("change",()=>{collectConfig();render()})});
    window.addEventListener("okx-alert-marker",ev=>handleMarker(ev.detail));
    document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")catchUpHistory("visible").catch(()=>{})});
    window.setInterval(()=>{if(cfg.enabled||trades.some(t=>t.status==="OPEN"))catchUpHistory("periodic").catch(()=>{})},15000);
  }
  function init(){
    build();
    if(!$("paperTradingPanel"))return;
    syncConfig();wire();render();
    if(cfg.enabled||trades.some(t=>t.status==="OPEN"))catchUpHistory("startup").catch(()=>{});
    else seedSync().catch(()=>{});
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});else init();
})();