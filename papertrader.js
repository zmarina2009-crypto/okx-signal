(() => {
  "use strict";
  const CFG_KEY="okx_paper_cfg_v1", TRADES_KEY="okx_paper_trades_v1", SYNC_KEY="okx_paper_sync_v1", PENDING_KEY="okx_paper_pending_v1", MAX_TRADES=500;
  const TF_MS={"1m":60000,"5m":300000,"15m":900000,"30m":1800000,"1h":3600000,"4h":14400000,"1d":86400000};
  const defaults={enabled:false,pair:"BTC-USDT-SWAP",tf:"1m",source:"sma",notional:100,atrPeriod:14,atrMult:1.5,targetR:5,breakevenR:1,fee:.05,slip:.02};
  const MANAGEMENT_MODE="full-position-be-then-5r", LEGACY_MODE="legacy-half-close-at-1r";
  const read=(key,fallback)=>{try{const v=JSON.parse(localStorage.getItem(key)||"null");return v==null?fallback:v}catch{return fallback}};
  let cfg=Object.assign({},defaults,read(CFG_KEY,{}));
  let trades=read(TRADES_KEY,[]);
  if(!Array.isArray(trades))trades=[];
  trades=trades.filter(t=>t&&t.id&&t.status&&Number.isFinite(Number(t.entry))).slice(-MAX_TRADES);
  let syncState=read(SYNC_KEY,null);
  if(!syncState||typeof syncState!=="object")syncState=null;
  let pendingSignals=read(PENDING_KEY,[]);
  if(!Array.isArray(pendingSignals))pendingSignals=[];
  pendingSignals=pendingSignals.filter(x=>x&&x.id&&x.meta&&x.meta.pair&&x.meta.tf&&["LONG","SHORT"].includes(x.meta.direction)).slice(-100);
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
  function savePending(){try{pendingSignals=pendingSignals.slice(-100);localStorage.setItem(PENDING_KEY,JSON.stringify(pendingSignals))}catch(e){setStatus("Не удалось сохранить очередь подтверждения: возможно, заполнено хранилище браузера.")}}

  function applyManagementToOpenTrades(){
    const targetR=Math.max(1,Math.min(50,Number(cfg.targetR)||5));
    const breakevenR=Math.max(.1,Math.min(50,Number(cfg.breakevenR)||1));
    let changed=false;
    for(const t of trades){
      if(!t.managementMode){t.managementMode=LEGACY_MODE;changed=true}
      if(t.status!=="OPEN")continue;
      const entry=Number(t.entry),dir=t.direction==="LONG"?1:-1;
      const risk=Number(t.risk)>0?Number(t.risk):Math.abs(entry-Number(t.stop));
      if(!(entry>0&&risk>0))continue;
      if(t.managementMode!==MANAGEMENT_MODE&&t.tp1Done&&Number(t.remaining)<1){
        const exitIndex=Array.isArray(t.exits)?t.exits.findIndex(e=>e&&e.reason==="TP1"):-1;
        const e=exitIndex>=0?t.exits[exitIndex]:null;
        const portion=Math.min(1-Number(t.remaining),Math.max(0,Number(e&&e.portion)||.5));
        const price=Number(e&&e.price)>0?Number(e.price):Number(t.tp1);
        if(portion>0&&price>0){
          const gross=(price-entry)*dir*(Number(t.notional)*portion)/entry;
          const exitNotional=Number(t.notional)*portion*price/entry;
          const costs=exitNotional*(Number(t.feePct||0)+Number(t.slipPct||0))/100;
          const exitPnl=e&&Number.isFinite(Number(e.pnl))?Number(e.pnl):gross-costs;
          t.pnl=(Number(t.pnl)||0)-exitPnl;
          t.gross=(Number(t.gross)||0)-gross;
          t.costs=(Number(t.costs)||0)-costs;
          t.remaining=Math.min(1,Math.max(0,Number(t.remaining)||0)+portion);
          if(exitIndex>=0)t.exits.splice(exitIndex,1);
          t.tp1Done=false;changed=true;
        }
      }
      if(t.managementMode!==MANAGEMENT_MODE){t.managementMode=MANAGEMENT_MODE;changed=true}
      const beTrigger=entry+dir*risk*breakevenR,target=entry+dir*risk*targetR;
      if(Number(t.targetR)!==targetR){t.targetR=targetR;changed=true}
      if(Number(t.breakevenR)!==breakevenR){t.breakevenR=breakevenR;changed=true}
      if(Math.abs(Number(t.tp1)-beTrigger)>Math.max(1,Math.abs(beTrigger))*1e-10){t.tp1=beTrigger;changed=true}
      if(Math.abs(Number(t.tp2)-target)>Math.max(1,Math.abs(target))*1e-10){t.tp2=target;changed=true}
      if(t.breakevenMoved){if(Number(t.stop)!==entry){t.stop=entry;changed=true}}
      else if(t.breakevenMoved!==false){t.breakevenMoved=false;changed=true}
    }
    if(changed)saveTrades();
  }
  // Upgrade already-open demo positions too: the new target and breakeven rules apply immediately.
  applyManagementToOpenTrades();
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
  function reconcileStartupConfig(){
    if(!cfg.enabled)return "";
    const ac=readAlertCfg();
    const selectedPairs=Array.isArray(ac.selectedPairs)?ac.selectedPairs.map(p=>String(p).toUpperCase()):[];
    if(!selectedPairs.includes(String(cfg.pair).toUpperCase())){
      cfg.enabled=false;saveCfg();
      return "Paper Trading приостановлен: пара "+cfg.pair+" не выбрана в Alerts. Выбери эту пару и снова запусти тест.";
    }
    if(cfg.source==="combo"&&!ac.comboEnabled){
      cfg.enabled=false;saveCfg();
      return "Paper Trading приостановлен: в Alerts выключено формирование сигналов COMBO.";
    }
    const alertTf=tfNorm(ac.alertTf||"15m");
    if(TF_MS[alertTf]&&cfg.tf!==alertTf){
      cfg.tf=alertTf;saveCfg();
      return "Таймфрейм Paper Trading автоматически синхронизирован с Alerts: "+alertTf+".";
    }
    return "";
  }
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
      const pageBars=rows.map(x=>({ts:Number(x[0]),o:Number(x[1]),h:Number(x[2]),l:Number(x[3]),c:Number(x[4]),v:Number(x[5]),vpv:Number(x[7]??x[6]??x[5]??0),confirm:String(x[8]??"1")}))
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

  function renderPending(){
    const root=$("ptPending");if(!root)return;
    const now=Date.now();
    root.innerHTML=pendingSignals.slice().sort((a,b)=>(Number(b.queuedAt)||0)-(Number(a.queuedAt)||0)).map(item=>{
      const m=item.meta||{},pair=String(m.pair||"").toUpperCase(),tf=tfNorm(m.tf),dir=m.direction==="LONG"?"LONG":"SHORT";
      const signalEntry=Number(m.entryPrice)>0?Number(m.entryPrice):Number(m.price);
      const draft=Number(item.entryDraft)>0?Number(item.entryDraft):signalEntry;
      const stale=now-(Number(m.ts)||0)>2*(TF_MS[tf]||60000);
      const enabled=cfg.enabled&&pair===String(cfg.pair).toUpperCase()&&tf===tfNorm(cfg.tf)&&!stale;
      const reason=stale?"Сигнал устарел":pair!==String(cfg.pair).toUpperCase()||tf!==tfNorm(cfg.tf)?"Не совпадает текущая пара/TF":!cfg.enabled?"Тест на паузе":"Проверь цену входа и подтверди";
      const improved=dir==="LONG"?draft<signalEntry:draft>signalEntry;
      return '<div class="pt-pending-item"><div class="pt-pending-meta"><b>'+esc(pair)+' · '+esc(tf)+' · '+dir+'</b><br>'+esc(fmtKind(m.kind))+' · цена сигнала '+fmt(signalEntry)+' · '+esc(stamp(m.ts))+'<br><label>Твоя цена входа <input type="number" min="0" step="any" inputmode="decimal" data-pending-entry="true" data-pending-id="'+esc(item.id)+'" value="'+esc(draft)+'" '+(stale?'disabled':'')+'></label><br><span class="small">'+reason+(improved?' · цена улучшена':draft===signalEntry?' · исходная цена':' · цена хуже исходной; проверь риск')+'</span></div><div class="pt-pending-actions"><button type="button" class="confirm" data-pending-action="confirm" data-pending-id="'+esc(item.id)+'" '+(enabled?'':'disabled')+'>Подтвердить</button><button type="button" data-pending-action="skip" data-pending-id="'+esc(item.id)+'">Пропустить</button></div></div>';
    }).join("")||'<div class="small">Пока нет сигналов на подтверждение.</div>';
  }
  async function volumeProfileAllows(meta){
    const pair=String(meta.pair||"").toUpperCase(),signalTs=Number(meta.ts)||Date.now(),tf=tfNorm(meta.tf);
    const from=Math.max(0,signalTs-120*15*60*1000);
    const result=await fetchHistory(pair,"15m",from);
    const bars=(result.bars||[]).filter(b=>Number(b.ts)+15*60*1000<=signalTs).sort((a,b)=>a.ts-b.ts).slice(-96);
    if(bars.length<96)return {allowed:false,reason:"Недостаточно закрытых 15m свечей для VP (нужно 96)."};
    const rows=30,lo=Math.min(...bars.map(b=>b.l)),hi=Math.max(...bars.map(b=>b.h)),range=hi-lo;
    if(!(range>0))return {allowed:false,reason:"Не удалось построить VP: нулевой диапазон цены."};
    const bins=new Array(rows).fill(0);
    for(const b of bars){
      const typical=(b.h+b.l+b.c)/3,k=Math.max(0,Math.min(rows-1,Math.floor((typical-lo)/range*rows)));
      bins[k]+=Math.max(0,Number(b.vpv??b.v)||0);
    }
    const total=bins.reduce((sum,v)=>sum+v,0),maxV=Math.max(...bins);
    if(!(total>0&&maxV>0))return {allowed:false,reason:"Нет достаточного объёма для VP."};
    const pocIndex=bins.indexOf(maxV),binWidth=range/rows,poc=lo+(pocIndex+.5)*binWidth;
    const entry=Number(meta.entryPrice)>0?Number(meta.entryPrice):Number(meta.price);
    if(!(entry>0))return {allowed:false,reason:"В сигнале отсутствует корректная цена."};
    const nearPOC=Math.abs(entry-poc)<=binWidth;
    const allowed=meta.direction==="LONG"?entry>poc&&!nearPOC:entry<poc&&!nearPOC;
    return {allowed,reason:allowed?"VP подтверждает направление относительно POC.":"VP не подтверждает направление: цена не на нужной стороне POC или находится рядом с POC.",poc,binWidth};
  }
  async function queueSignal(meta){
    if(!meta||!cfg.enabled)return false;
    const pair=String(meta.pair||"").toUpperCase(),tf=tfNorm(meta.tf),kind=String(meta.kind||"").toLowerCase();
    if(pair!==String(cfg.pair).toUpperCase()||tf!==tfNorm(cfg.tf)||!kindAllowed(kind)||!["LONG","SHORT"].includes(meta.direction))return false;
    const signalId=String(meta.id||[pair,tf,kind,meta.ts,meta.direction].join("|"));
    if(trades.some(t=>t.signalId===signalId)||pendingSignals.some(x=>x.id===signalId))return false;
    if(trades.some(t=>t.status==="OPEN"&&String(t.pair).toUpperCase()===pair&&tfNorm(t.tf)===tf)){
      setStatus("Сигнал "+fmtKind(kind)+" пропущен: по "+pair+" / "+tf+" уже есть открытая виртуальная позиция (No trade).");return false;
    }
    if(pendingSignals.some(x=>String(x.meta.pair).toUpperCase()===pair&&tfNorm(x.meta.tf)===tf))return false;
    const age=Date.now()-(Number(meta.ts)||0);
    if(age>2*(TF_MS[tf]||60000)){return false}
    let vp;
    try{vp=await volumeProfileAllows(meta)}catch(e){
      setStatus("Не удалось проверить VP для "+pair+" / "+tf+": "+String(e&&e.message||e)+". Сигнал не поставлен в очередь.");
      return false;
    }
    if(!vp.allowed){
      setStatus("Сигнал "+pair+" / "+tf+" "+meta.direction+" отфильтрован Volume Profile. "+vp.reason);
      return false;
    }
    pendingSignals.push({id:signalId,meta,queuedAt:Date.now(),vp:{poc:vp.poc,binWidth:vp.binWidth}});savePending();renderPending();
    setStatus("SMA-сигнал "+pair+" / "+tf+" "+meta.direction+" прошёл VP-фильтр (POC "+fmt(vp.poc)+"). Виртуальная сделка не открыта: ожидается твоё подтверждение.");
    return true;
  }
  function render(){
    const el=$("ptEnabledBadge");
    if(el){el.textContent=cfg.enabled?"ВХОДЫ АКТИВНЫ":"ВХОДЫ ПРИОСТАНОВЛЕНЫ";el.className="pt-status-badge "+(cfg.enabled?"active":"paused")}
    const open=trades.filter(t=>t.status==="OPEN"),closed=trades.filter(t=>t.status==="CLOSED");
    const strategyClosed=closed.filter(t=>t.managementMode===MANAGEMENT_MODE);
    const wins=strategyClosed.filter(t=>Number(t.pnl)>0),losses=strategyClosed.filter(t=>Number(t.pnl)<0);
    const net=strategyClosed.reduce((s,t)=>s+(Number(t.pnl)||0),0);
    const grossPnl=strategyClosed.reduce((s,t)=>s+(Number(t.gross)||0),0);
    const totalCosts=strategyClosed.reduce((s,t)=>s+(Number(t.costs)||0),0);
    const expectancy=strategyClosed.length?net/strategyClosed.length:null;
    const grossWin=wins.reduce((s,t)=>s+(Number(t.pnl)||0),0),grossLoss=Math.abs(losses.reduce((s,t)=>s+(Number(t.pnl)||0),0));
    const pf=grossLoss>0?grossWin/grossLoss:null,wr=strategyClosed.length?wins.length/strategyClosed.length*100:null;
    $("ptOpen").textContent=String(open.length);$("ptClosed").textContent=String(strategyClosed.length);
    $("ptWinRate").textContent=wr==null?"—":wr.toFixed(1)+"%";
    $("ptNet").textContent=(net>=0?"+":"")+fmt(net)+" USDT";
    if($("ptGross"))$("ptGross").textContent=(grossPnl>=0?"+":"")+fmt(grossPnl)+" USDT";
    if($("ptCosts"))$("ptCosts").textContent="-"+fmt(totalCosts)+" USDT";
    if($("ptExpectancy"))$("ptExpectancy").textContent=expectancy==null?"—":(expectancy>=0?"+":"")+fmt(expectancy)+" USDT";
    $("ptPF").textContent=pf==null?(grossWin>0?"∞":"—"):pf.toFixed(2);
    renderPending();
    const body=$("ptTrades");
    const latest=trades.slice().sort((x,y)=>(Number(y.createdAt)||0)-(Number(x.createdAt)||0)).slice(0,60);
    if(body)body.innerHTML=latest.map(t=>{
      const dir=t.direction==="LONG"?"LONG":"SHORT",color=dir==="LONG"?"#27e58a":"#ff5f68";
      let status=t.status==="OPEN"?([ "Открыта",t.breakevenMoved?"Стоп БУ":"" ].filter(Boolean).join(" · ")):((t.managementMode!==MANAGEMENT_MODE?"ИСТОРИЯ 50% TP1 · ":"")+(t.closeReason||"CLOSED")+" · "+((Number(t.pnl)>=0?"+":"")+fmt(Number(t.pnl))+" USDT"));
      const source=fmtKind(t.kind)+(t.managementMode!==MANAGEMENT_MODE?" · старая модель":"");
      return '<tr><td>'+esc(stamp(t.signalTs||t.createdAt))+'</td><td>'+esc(source)+' / '+esc(tfNorm(t.tf))+'</td><td style="color:'+color+';font-weight:800">'+dir+'</td><td>'+fmt(t.entry)+'</td><td>'+fmt(t.stop)+'</td><td>'+fmt(t.tp1)+' / '+fmt(t.tp2)+'</td><td>'+esc(status)+'</td></tr>';
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
        '<label>Финальный тейк, R<input id="ptTargetR" type="number" min="1" max="50" step="0.5" value="5"></label>'+
        '<label>Перенос стопа в БУ, R<input id="ptBreakevenR" type="number" min="0.1" max="50" step="0.1" value="1"></label>'+
        '<label>Комиссия, % на сторону<input id="ptFee" type="number" min="0" step="0.001" value="0.05"></label>'+
        '<label>Проскальзывание, % на сторону<input id="ptSlip" type="number" min="0" step="0.001" value="0.02"></label>'+
      '</div>'+
      '<div class="pt-buttons"><button id="ptStart" class="primary" type="button">▶ Начать тест</button><button id="ptPause" type="button">Ⅱ Приостановить новые входы</button><button id="ptClear" type="button">Очистить журнал</button><span id="ptEnabledBadge" class="pt-status-badge paused">ВХОДЫ ПРИОСТАНОВЛЕНЫ</span></div>'+
      '<div class="pt-pending-wrap"><h3>Ожидают твоего подтверждения</h3><div id="ptPending" class="pt-pending"><div class="small">Пока нет сигналов на подтверждение.</div></div></div>'+
      '<div id="ptStatus" class="pt-status">Для старта выбери ту же пару и таймфрейм в панели Alerts. Каждый новый сигнал будет ждать отдельного подтверждения; без него виртуальная позиция не откроется.</div>'+
      '<div class="pt-metrics"><div><small>Открытых позиций</small><b id="ptOpen">0</b></div><div><small>Закрытых сделок</small><b id="ptClosed">0</b></div><div><small>Доля прибыльных</small><b id="ptWinRate">—</b></div><div><small>Сумма PnL после затрат</small><b id="ptNet">0.00 USDT</b></div><div><small>Profit Factor</small><b id="ptPF">—</b></div><div><small>Валовой PnL</small><b id="ptGross">0.00 USDT</b></div><div><small>Комиссии + проскальзывание</small><b id="ptCosts">0.00 USDT</b></div><div><small>Матожидание / сделку</small><b id="ptExpectancy">—</b></div></div>'+
      '<div class="small" style="margin:10px 0 6px">Правила: начальный стоп = ATR(14) × множитель; вся позиция остаётся открытой до финального тейка (по умолчанию +5R) или стопа. При достижении заданного уровня (по умолчанию +1R) стоп всей позиции переносится на цену входа (БУ); на +1R часть позиции не закрывается. Стоп БУ стоит на цене входа, поэтому комиссии и проскальзывание могут дать небольшой чистый убыток. Если стоп и тейк попали в одну свечу, консервативно первым считается стоп; если в одной свече достигнут триггер БУ и цена вернулась к входу, консервативно фиксируется БУ. Метрики учитывают только сделки новой модели; старые сделки сохранены в журнале как история. Одна открытая виртуальная позиция на пару и TF.</div>'+
      '<div class="tablewrap"><table class="table"><thead><tr><th>Время</th><th>Источник / TF</th><th>Сторона</th><th>Вход</th><th>Стоп</th><th>Триггер БУ / TP</th><th>Состояние / PnL</th></tr></thead><tbody id="ptTrades"></tbody></table></div>'+
      '<div class="small" style="margin-top:8px">Журнал хранится локально в браузере, максимум 500 сделок. После открытия приложения тест восстанавливает новые сигналы и проверяет пропущенные стопы/тейки по закрытым историческим свечам. Для теста выбери в Alerts ту же пару, таймфрейм и источник. Эти сделки не являются реальными ордерами и не гарантируют будущую доходность.</div>';
    footer.parentNode.insertBefore(panel,footer);
    const style=document.createElement("style");
    style.textContent="#paperTradingPanel{margin-top:12px}.pt-pending-wrap{margin-top:12px;padding:10px;border:1px solid #1d2835;border-radius:10px;background:#0b1118}.pt-pending-wrap h3{font-size:13px;margin:0 0 8px}.pt-pending{display:grid;gap:7px}.pt-pending-item{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;padding:9px;border:1px solid #263342;border-radius:8px;background:#101823}.pt-pending-meta{font-size:11px;line-height:1.5}.pt-pending-actions{display:flex;gap:6px}.pt-pending-actions button{font-size:11px;padding:7px 9px}.pt-pending-actions .confirm{border-color:#245f47;background:#10251d;color:#27e58a}.pt-warning{padding:9px 11px;border:1px solid #6a4d1f;border-radius:8px;background:#20190e;color:#f2d18b;font-size:11px;line-height:1.45}.pt-controls{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:10px}.pt-controls label{display:block;color:#8290a0;font-size:11px}.pt-controls input,.pt-controls select{display:block;width:100%;min-width:0;margin-top:4px;background:#101823;color:#eaf0f6;border:1px solid #1d2835;border-radius:8px;padding:9px}.pt-buttons{display:flex;align-items:center;flex-wrap:wrap;gap:7px;margin-top:10px}.pt-buttons button{padding:8px 10px;font-size:11px}.pt-status-badge{display:inline-block;border-radius:8px;padding:6px 9px;font-size:10px;font-weight:800}.pt-status-badge.active{background:#0c3a28;color:#27e58a}.pt-status-badge.paused{background:#1a222c;color:#b5c0cc}.pt-status{margin-top:8px;color:#8290a0;font-size:11px;line-height:1.5}.pt-metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:7px;margin-top:10px}.pt-metrics>div{background:#0b1118;border:1px solid #17212d;border-radius:9px;padding:8px}.pt-metrics small{display:block;color:#8290a0;font-size:10px}.pt-metrics b{display:block;margin-top:4px;overflow-wrap:anywhere;font-size:12px}.pt-metrics #ptNet{font-variant-numeric:tabular-nums}@media(max-width:850px){.pt-controls{grid-template-columns:repeat(2,minmax(0,1fr))}.pt-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}";
    document.head.appendChild(style);
  }
  function collectConfig(){
    cfg.pair=String($("ptPair").value||"BTC-USDT-SWAP").trim().toUpperCase();
    if(/^[A-Z0-9]+-USDT$/.test(cfg.pair))cfg.pair+="-SWAP";
    cfg.tf=tfNorm($("ptTf").value||"1m");
    cfg.source=$("ptSource").value||"sma";
    cfg.notional=Math.max(10,Number($("ptNotional").value)||100);
    cfg.atrMult=Math.max(.1,Number($("ptAtrMult").value)||1.5);
    cfg.targetR=Math.max(1,Math.min(50,Number($("ptTargetR").value)||5));
    cfg.breakevenR=Math.max(.1,Math.min(50,Number($("ptBreakevenR").value)||1));
    cfg.fee=Math.max(0,Number($("ptFee").value)||0);
    cfg.slip=Math.max(0,Number($("ptSlip").value)||0);
    saveCfg();
  }
  function syncConfig(){
    $("ptPair").value=cfg.pair;$("ptTf").value=cfg.tf;$("ptSource").value=cfg.source;
    $("ptNotional").value=cfg.notional;$("ptAtrMult").value=cfg.atrMult;$("ptTargetR").value=cfg.targetR;$("ptBreakevenR").value=cfg.breakevenR;$("ptFee").value=cfg.fee;$("ptSlip").value=cfg.slip;
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
        label:String(meta.label||kind),entry,atr,atrMult:cfg.atrMult,risk,stop:entry-dir*risk,tp1:entry+dir*risk*cfg.breakevenR,tp2:entry+dir*risk*cfg.targetR,targetR:cfg.targetR,breakevenR:cfg.breakevenR,breakevenMoved:false,managementMode:MANAGEMENT_MODE,
        notional:cfg.notional,feePct:cfg.fee,slipPct:cfg.slip,pnl:-entryCost,gross:0,costs:entryCost,remaining:1,tp1Done:false,
        status:"OPEN",createdAt:now,signalTs,lastProcessedTs:signalTs,exits:[]
      };
      trades.push(trade);saveTrades();render();
      setStatus("Виртуальная сделка подтверждена и открыта: "+pair+" / "+tf+" "+trade.direction+" по "+fmt(entry)+". Реальный ордер не отправлялся.");
      return trade;
    }finally{pendingTrades.delete(key)}
  }
  function finishPortion(t,frac,price,reason,barTs){
    const f=Math.max(0,Math.min(Number(frac)||0,t.remaining));
    if(f<=0)return;
    const qty=Number(t.notional)*f,dir=t.direction==="LONG"?1:-1;
    const raw=(Number(price)-Number(t.entry))*dir*qty/Number(t.entry);
    const exitNotional=qty*Number(price)/Number(t.entry);
    const costs=exitNotional*(Number(t.feePct||0)+Number(t.slipPct||0))/100;
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
    const long=t.direction==="LONG",dir=long?1:-1,entry=Number(t.entry);
    const stopHit=long?lo<=Number(t.stop):hi>=Number(t.stop);
    const targetHit=long?hi>=Number(t.tp2):lo<=Number(t.tp2);
    if(stopHit){
      const reason=t.breakevenMoved?"STOP_BREAKEVEN":"STOP";
      finishPortion(t,t.remaining,t.stop,reason,ts);
      return true;
    }
    const risk=Number(t.risk)>0?Number(t.risk):Math.abs(entry-Number(t.stop));
    const beR=Math.max(.1,Math.min(50,Number(t.breakevenR)||1));
    const bePrice=entry+dir*risk*beR;
    const beHit=long?hi>=bePrice:lo<=bePrice;
    if(!t.breakevenMoved&&beHit){
      t.stop=entry;t.breakevenMoved=true;t.breakevenMovedAt=ts;
      const returnedToEntry=long?lo<=entry:hi>=entry;
      if(returnedToEntry){
        finishPortion(t,t.remaining,entry,"STOP_BREAKEVEN",ts);
        return true;
      }
      if(targetHit){
        finishPortion(t,t.remaining,t.tp2,"TP"+(Number(t.targetR)||5)+"R",ts);
        return true;
      }
      return false;
    }
    if(targetHit){
      finishPortion(t,t.remaining,t.tp2,"TP"+(Number(t.targetR)||5)+"R",ts);
      return true;
    }
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
      const alertTf=tfNorm(alertCfg.alertTf||"15m");
      const selectedAlertPairs=Array.isArray(alertCfg.selectedPairs)?alertCfg.selectedPairs.map(x=>String(x).toUpperCase()):[];
      const pairSelected=selectedAlertPairs.includes(pair),timeframeMatches=alertTf===tf;
      const comboReady=cfg.source!=="combo"||!!alertCfg.comboEnabled;
      const matchingAlerts=pairSelected&&timeframeMatches&&comboReady;
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
      const candidateSignals=matchingAlerts?historicalSignals(bars,pair,tf,alertCfg).filter(x=>x.ts>cursor&&kindAllowed(x.kind)):[];
      const candidateComboCount=candidateSignals.filter(x=>x.kind==="combo").length;
      const events=candidateSignals.reduce((map,x)=>{
        if(!map.has(x.ts))map.set(x.ts,[]);
        map.get(x.ts).push(x);return map;
      },new Map());
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
          const before=pendingSignals.length;
          if(await queueSignal(sig)&&pendingSignals.length>before)created++;
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
      const resultText="Синхронизация завершена: проверено "+barCount+" новых свечей; найдено подходящих сигналов "+candidateSignals.length+(cfg.source==="combo"?" (COMBO: "+candidateComboCount+")":"")+"; ожидают подтверждения "+created+"; закрыто за восстановление "+Math.max(0,closedAfter-closedBefore)+". Последняя свеча "+stamp(latestTs)+".";
      let blocker="";
      if(cfg.enabled&&!pairSelected)blocker="ВХОДЫ ЗАБЛОКИРОВАНЫ: пара "+pair+" не выбрана в Alerts.";
      else if(cfg.enabled&&!timeframeMatches)blocker="ВХОДЫ ЗАБЛОКИРОВАНЫ: таймфрейм Paper Trading "+tf+" не совпадает с Alerts "+alertTf+".";
      else if(cfg.enabled&&!comboReady)blocker="ВХОДЫ ЗАБЛОКИРОВАНЫ: в Alerts выключено формирование COMBO.";
      else if(cfg.enabled&&candidateSignals.length===0)blocker=cfg.source==="combo"?"На новых свечах после точки запуска не найдено подходящих COMBO-сигналов. Старые сигналы до запуска не открываются.":"На новых свечах после точки запуска не найдено сигналов выбранного источника.";
      else if(cfg.enabled&&candidateSignals.length>0&&created===0)blocker="Сигналы найдены, но новые подтверждения не добавлены: возможно, сигнал устарел, уже обработан или по паре/TF есть открытая позиция.";
      setStatus(resultText+(blocker?" "+blocker:cfg.enabled?" Тест активен.":" Новые входы приостановлены."));
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
    queueSignal(meta).catch(e=>{console.warn("Paper Trading VP filter",e);setStatus("Не удалось проверить VP перед подтверждением: "+String(e&&e.message||e))});
  }
  function wire(){
    $("ptPending").addEventListener("input",ev=>{
      const input=ev.target.closest('input[data-pending-entry="true"]');
      if(!input)return;
      const item=pendingSignals.find(x=>x.id===input.dataset.pendingId);
      if(!item)return;
      item.entryDraft=input.value;
      savePending();
    });
    $("ptPending").addEventListener("click",async ev=>{
      const btn=ev.target.closest("button[data-pending-action]");
      if(!btn)return;
      const item=pendingSignals.find(x=>x.id===btn.dataset.pendingId);
      if(!item)return;
      if(btn.dataset.pendingAction==="skip"){
        pendingSignals=pendingSignals.filter(x=>x.id!==item.id);savePending();render();
        setStatus("Сигнал пропущен. Виртуальная позиция не открыта.");return;
      }
      if(!cfg.enabled){setStatus("Сначала возобнови тест, чтобы подтвердить новую виртуальную сделку.");return}
      const meta=item.meta||{},pair=String(meta.pair||"").toUpperCase(),tf=tfNorm(meta.tf);
      if(pair!==String(cfg.pair).toUpperCase()||tf!==tfNorm(cfg.tf)){setStatus("Подтверждение заблокировано: сигнал относится к другой паре или таймфрейму.");return}
      if(Date.now()-(Number(meta.ts)||0)>2*(TF_MS[tf]||60000)){
        pendingSignals=pendingSignals.filter(x=>x.id!==item.id);savePending();render();
        setStatus("Сигнал устарел и удалён из очереди. Дождись нового сигнала, чтобы не открывать виртуальную позицию по старой цене.");return;
      }
      if(trades.some(t=>t.status==="OPEN"&&String(t.pair).toUpperCase()===pair&&tfNorm(t.tf)===tf)){
        pendingSignals=pendingSignals.filter(x=>x.id!==item.id);savePending();render();
        setStatus("Подтверждение отменено: по этой паре и таймфрейму уже открыта виртуальная позиция.");return;
      }
      const entryInput=Array.from($("ptPending").querySelectorAll('input[data-pending-entry="true"]')).find(el=>el.dataset.pendingId===item.id);
      const chosenEntry=Number(entryInput&&entryInput.value);
      if(!Number.isFinite(chosenEntry)||chosenEntry<=0){setStatus("Укажи корректную положительную цену входа.");entryInput&&entryInput.focus();return}
      const adjustedMeta=Object.assign({},meta,{entryPrice:chosenEntry,price:chosenEntry});
      item.entryDraft=chosenEntry;savePending();
      btn.disabled=true;
      if(entryInput)entryInput.disabled=true;
      try{
        const vp=await volumeProfileAllows(adjustedMeta);
        if(!vp.allowed){
          setStatus("Цена входа не проходит VP-фильтр: "+vp.reason+" Скорректируй цену или пропусти сигнал.");
          renderPending();return;
        }
        item.meta=Object.assign({},meta,{entryPrice:chosenEntry});
        savePending();
        const trade=await openTrade(adjustedMeta);
        if(trade||trades.some(t=>t.signalId===item.id)){
          pendingSignals=pendingSignals.filter(x=>x.id!==item.id);savePending();render();
        }else{renderPending()}
      }catch(e){console.warn("Paper Trading confirm",e);setStatus("Не удалось проверить VP или открыть виртуальную сделку: "+String(e&&e.message||e));renderPending()}
    });
    $("ptStart").onclick=async()=>{
      const wasEnabled=cfg.enabled;
      collectConfig();
      const ac=readAlertCfg();
      const alertTf=tfNorm(ac.alertTf||"15m");
      const selectedPairs=Array.isArray(ac.selectedPairs)?ac.selectedPairs.map(p=>String(p).toUpperCase()):[];
      if(!selectedPairs.length||!selectedPairs.includes(cfg.pair)){
        cfg.enabled=false;saveCfg();render();
        setStatus("Тест не запущен: в Alerts нужно выбрать пару "+cfg.pair+". Пока пара не выбрана, сигналы не поступают и сделки не открываются.");
        return;
      }
      if(cfg.source==="combo"&&!ac.comboEnabled){
        cfg.enabled=false;saveCfg();render();
        setStatus("Тест не запущен: источник COMBO выбран, но в Alerts выключено формирование комбо-сигналов. Включи COMBO в Alerts и снова нажми «Начать тест».");
        return;
      }
      if(cfg.tf!==alertTf){
        cfg.tf=alertTf;
        saveCfg();
        syncConfig();
      }
      try{
        await seedSync();
        // When resuming a paused test, skip signals from the paused interval,
        // while still replaying bars for any positions that were already open.
        if(!wasEnabled)await advanceSyncToLatest();
      }catch(e){setStatus("Не удалось запустить тест: "+String(e&&e.message||e));return}
      cfg.enabled=true;saveCfg();render();
      setStatus("Тест включён: "+cfg.pair+" / "+cfg.tf+" / источник "+fmtKind(cfg.source)+". Пара и таймфрейм синхронизированы с Alerts. Виртуальные позиции; реальные ордера не отправляются.");
      catchUpHistory("start").catch(()=>{});
    };
    $("ptPause").onclick=async()=>{
      collectConfig();cfg.enabled=false;saveCfg();render();
      try{await advanceSyncToLatest();setStatus("Новые виртуальные входы приостановлены. Уже открытые позиции продолжат отслеживаться и восстановятся при следующем открытии; сигналы во время паузы пропускаются.")}
      catch(e){setStatus("Пауза включена, но не удалось обновить точку восстановления: "+String(e&&e.message||e))}
    };
    $("ptClear").onclick=()=>{if(!confirm("Удалить весь журнал Paper Trading, включая открытые виртуальные позиции?"))return;trades=[];saveTrades();render();setStatus("Журнал Paper Trading очищен.")};
    ["ptPair","ptTf","ptSource","ptNotional","ptAtrMult","ptTargetR","ptBreakevenR","ptFee","ptSlip"].forEach(id=>{const el=$(id);el.addEventListener("change",()=>{collectConfig();if(id==="ptTargetR"||id==="ptBreakevenR")applyManagementToOpenTrades();render()})});
    window.addEventListener("okx-alert-marker",ev=>handleMarker(ev.detail));
    document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")catchUpHistory("visible").catch(()=>{})});
    window.setInterval(()=>{if(cfg.enabled||trades.some(t=>t.status==="OPEN"))catchUpHistory("periodic").catch(()=>{})},15000);
  }
  function init(){
    build();
    if(!$("paperTradingPanel"))return;
    const startupStatus=reconcileStartupConfig();
    syncConfig();wire();render();
    if(startupStatus)setStatus(startupStatus);
    if(cfg.enabled||trades.some(t=>t.status==="OPEN"))catchUpHistory("startup").catch(()=>{});
    else seedSync().catch(()=>{});
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});else init();
})();