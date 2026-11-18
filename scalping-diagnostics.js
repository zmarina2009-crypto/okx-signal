/* Read-only diagnostics for OKX Signal Pro scalping. Never changes strategy settings or signals. */
(function () {
  "use strict";
  const CFG_KEY="okx_scalping_trigger_v1", STATE_KEY="okx_scalping_trigger_state_v1";
  const HISTORY_KEY=STATE_KEY+"_history", DIAG_KEY="okx_scalping_diagnostics_v1";
  const MAX_OBSERVATIONS=500, MAX_CANDIDATES=100;
  const DEFAULTS={enabled:true,scope:"chart",volumeRsiEnabled:true,volumePeriod:20,volumeMultiplier:2,rsiLength:14,rsiOversold:30,rsiOverbought:70,bosEnabled:true,bosAlerts:true,swingLength:3,requireBos:false,longEnabled:true,shortEnabled:true,cooldownSeconds:60,rsiClusterAtrMultiplier:1};

  function read(key,fallback){try{const v=JSON.parse(localStorage.getItem(key)||"null");return v&&typeof v==="object"?v:fallback}catch(_){return fallback}}
  function write(key,value){try{localStorage.setItem(key,JSON.stringify(value))}catch(_){}}
  function normalTf(tf){return String(tf||"1m").toLowerCase()}
  function clampInt(value,min,max,fallback){const n=Math.round(Number(value)||fallback);return Math.max(min,Math.min(max,n))}
  function clampNum(value,min,max,fallback){const n=Number(value)||fallback;return Math.max(min,Math.min(max,n))}
  function readConfig(){
    const c=Object.assign({},DEFAULTS,read(CFG_KEY,{}));
    c.volumePeriod=clampInt(c.volumePeriod,2,200,20);
    c.volumeMultiplier=clampNum(c.volumeMultiplier,1,20,2);
    c.rsiLength=clampInt(c.rsiLength,2,100,14);
    c.rsiOversold=clampInt(c.rsiOversold,1,49,30);
    c.rsiOverbought=clampInt(c.rsiOverbought,51,99,70);
    c.swingLength=clampInt(c.swingLength,1,20,3);
    c.cooldownSeconds=clampInt(c.cooldownSeconds,1,86400,60);
    c.rsiClusterAtrMultiplier=clampNum(c.rsiClusterAtrMultiplier,.25,3,1);
    if(!["chart","alerts"].includes(c.scope))c.scope="chart";
    return c;
  }
  function rsiSeries(bars,period){
    const out=new Array(bars.length).fill(null);if(bars.length<=period)return out;
    let gains=0,losses=0;
    for(let i=1;i<=period;i++){const d=Number(bars[i].c)-Number(bars[i-1].c);if(!Number.isFinite(d))return out;if(d>0)gains+=d;else losses-=d}
    let avgGain=gains/period,avgLoss=losses/period;
    const value=()=>avgLoss===0?100:avgGain===0?0:100-100/(1+avgGain/avgLoss);
    out[period]=value();
    for(let i=period+1;i<bars.length;i++){const d=Number(bars[i].c)-Number(bars[i-1].c);if(!Number.isFinite(d))return out;avgGain=(avgGain*(period-1)+Math.max(d,0))/period;avgLoss=(avgLoss*(period-1)+Math.max(-d,0))/period;out[i]=value()}
    return out;
  }
  function averageVolume(bars,period,index){
    if(!Array.isArray(bars)||!Number.isInteger(period)||period<1||index<period)return null;
    let sum=0;for(let i=index-period;i<index;i++){const v=Number(bars[i]&&bars[i].v);if(!Number.isFinite(v)||v<0)return null;sum+=v}
    return sum/period;
  }
  function latestPivot(bars,length,type){
    const field=type==="high"?"h":"l";
    for(let i=bars.length-1-length;i>=length;i--){const candidate=Number(bars[i][field]);if(!Number.isFinite(candidate))continue;let pivot=true;
      for(let j=i-length;j<=i+length;j++){if(j===i)continue;const other=Number(bars[j][field]);if(!Number.isFinite(other)||(type==="high"?other>=candidate:other<=candidate)){pivot=false;break}}
      if(pivot)return{price:candidate,ts:Number(bars[i].ts),index:i}
    }return null
  }
  function detectBos(bars,cfg){
    const n=cfg.swingLength;if(!cfg.bosEnabled||bars.length<n*2+3)return null;
    const prev=Number(bars[bars.length-2].c),close=Number(bars[bars.length-1].c);if(![prev,close].every(Number.isFinite))return null;
    const hi=latestPivot(bars,n,"high"),lo=latestPivot(bars,n,"low");
    if(hi&&prev<=hi.price&&close>hi.price)return{direction:"LONG",level:hi.price,pivotTs:hi.ts,label:"BOS ↑"};
    if(lo&&prev>=lo.price&&close<lo.price)return{direction:"SHORT",level:lo.price,pivotTs:lo.ts,label:"BOS ↓"};
    return null;
  }
  function evaluateAt(bars,index,cfg){
    const required=Math.max(cfg.volumePeriod+1,cfg.rsiLength+1,cfg.swingLength*2+3);
    if(!Array.isArray(bars)||index<required-1)return null;
    const prefix=bars.slice(0,index+1),candle=prefix[prefix.length-1],ts=Number(candle&&candle.ts);if(!Number.isFinite(ts))return null;
    const avg=averageVolume(prefix,cfg.volumePeriod,prefix.length-1),volume=Number(candle.v);
    const volumeSpike=avg!=null&&avg>0&&volume>avg*cfg.volumeMultiplier;
    const values=rsiSeries(prefix,cfg.rsiLength),current=values[values.length-1],previous=values[values.length-2];
    const rsiLong=current!=null&&(current<=cfg.rsiOversold||(previous!=null&&previous<=cfg.rsiOversold&&current>cfg.rsiOversold));
    const rsiShort=current!=null&&(current>=cfg.rsiOverbought||(previous!=null&&previous>=cfg.rsiOverbought&&current<cfg.rsiOverbought));
    return{ts,close:Number(candle.c),volume,averageVolume:avg,volumeRatio:avg>0?volume/avg:null,volumeSpike,currentRsi:current,previousRsi:previous,rsiLong,rsiShort,bos:detectBos(prefix,cfg)};
  }
  function formatMsk(value){const n=Number(value);if(!Number.isFinite(n))return"—";try{return new Date(n).toLocaleString("ru-RU",{timeZone:"Europe/Moscow",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"})}catch(_){return new Date(n).toISOString()}}
  function historyEvent(history,pair,tf,ts){return(Array.isArray(history)?history:[]).find(x=>x&&x.pair===pair&&normalTf(x.tf)===normalTf(tf)&&Number(x.ts)===Number(ts)&&["scalping","rsi-repeat","bos"].includes(x.kind))||null}
  function assessLatest(bars,pair,tf,cfg,state,history,now){
    const item=evaluateAt(bars,bars.length-1,cfg);if(!item)return{pair,tf,error:"Недостаточно свечей для расчёта",observedAt:now};
    const t=normalTf(tf),key=pair+"|"+t,processed=Number(state.processed&&state.processed[key])||0,already=processed===item.ts;
    const actual=historyEvent(history,pair,tf,item.ts),fired=Array.isArray(state.fired)?state.fired:[];
    const last=state.lastAlertAt&&typeof state.lastAlertAt==="object"?state.lastAlertAt:{},cluster=state.rsiClusters&&state.rsiClusters[key];
    const dirs=[];if(item.rsiLong)dirs.push("LONG");if(item.rsiShort)dirs.push("SHORT");
    const decisions=dirs.map(dir=>{
      const reasons=[];
      if(!cfg.enabled)reasons.push("Модуль скальпинга выключен");
      if(!cfg.volumeRsiEnabled)reasons.push("Volume + RSI выключен");
      if(!item.volumeSpike)reasons.push("Объём не превысил средний × множитель");
      if(cfg.requireBos&&(!item.bos||item.bos.direction!==dir))reasons.push("Нет BOS в ту же сторону");
      let merged=false;if(cluster&&cluster.direction===dir){const distance=Math.abs(item.close-Number(cluster.anchorPrice));merged=!(distance>=Number(cluster.radius)&&cluster.neutralSeen)}
      if(merged)reasons.push("Повтор RSI объединяется с текущей ситуацией");
      if(dir==="LONG"&&!cfg.longEnabled)reasons.push("LONG отключён");
      if(dir==="SHORT"&&!cfg.shortEnabled)reasons.push("SHORT отключён");
      const id=["volume-rsi",pair,t,item.ts,dir].join("|"),wasFired=fired.includes(id);
      const cooldownKey=["scalping",pair,t,dir].join("|"),previous=Number(last[cooldownKey])||0;
      const left=Math.max(0,cfg.cooldownSeconds*1000-(now-previous));
      if(wasFired)reasons.push("ID сигнала уже находится в fired");
      else if(previous>0&&left>0)reasons.push("Антиспам-пауза: "+Math.ceil(left/1000)+" сек.");
      if(already)reasons.push("Свеча уже отмечена обработанной");
      return{direction:dir,reasons,mergedIntoCluster:merged,directionEnabled:dir==="LONG"?!!cfg.longEnabled:!!cfg.shortEnabled,fired:wasFired,cooldownRemainingMs:left,actualJournalEvent:actual&&actual.direction===dir?actual.kind:null};
    });
    const reasons=[];if(!cfg.enabled)reasons.push("Модуль выключен");if(!cfg.volumeRsiEnabled)reasons.push("Volume + RSI выключен");
    if(!item.volumeSpike)reasons.push("Нет всплеска объёма");if(!dirs.length)reasons.push("RSI не вошёл в сигнальную зону и не вышел из неё");
    if(cfg.requireBos&&dirs.length&&!dirs.some(d=>item.bos&&item.bos.direction===d))reasons.push("BOS не совпал по направлению");
    if(already)reasons.push("Свеча уже обработана");
    return{pair,tf:t,observedAt:now,candleTs:item.ts,candleTimeMsk:formatMsk(item.ts),processedTs:processed,alreadyProcessed:already,hasHistory:!!actual,historyKind:actual&&actual.kind,close:item.close,volume:item.volume,averageVolume:item.averageVolume,volumeRatio:item.volumeRatio,volumeSpike:item.volumeSpike,rsi:item.currentRsi,previousRsi:item.previousRsi,rsiLong:item.rsiLong,rsiShort:item.rsiShort,bos:item.bos,moduleEnabled:!!cfg.enabled,volumeRsiEnabled:!!cfg.volumeRsiEnabled,requireBos:!!cfg.requireBos,decisions,reasons:reasons.length?reasons:(dirs.length?[]:["RSI не сформировал направление"]),state:{historyCount:Array.isArray(history)?history.length:0,firedCount:fired.length,rsiCluster:cluster?{direction:cluster.direction,anchorPrice:cluster.anchorPrice,radius:cluster.radius,neutralSeen:!!cluster.neutralSeen,suppressedCount:Number(cluster.suppressedCount)||0}:null}};
  }
  function scanCandidates(bars,pair,tf,cfg,history,maxBars){
    if(!Array.isArray(bars)||!bars.length)return[];const start=Math.max(0,bars.length-Math.max(1,maxBars||100)),out=[];
    for(let i=start;i<bars.length;i++){const x=evaluateAt(bars,i,cfg);if(!x||!x.volumeSpike)continue;const dirs=[];if(x.rsiLong)dirs.push("LONG");if(x.rsiShort)dirs.push("SHORT");
      for(const dir of dirs){const passesBos=!cfg.requireBos||!!(x.bos&&x.bos.direction===dir);const logged=historyEvent(history,pair,tf,x.ts);
        out.push({pair,tf:normalTf(tf),ts:x.ts,timeMsk:formatMsk(x.ts),direction:dir,close:x.close,volume:x.volume,averageVolume:x.averageVolume,volumeRatio:x.volumeRatio,rsi:x.currentRsi,previousRsi:x.previousRsi,bos:x.bos,passesBos,mathematicalCandidate:passesBos,journalEvent:logged&&logged.kind||null});
      }
    }return out.slice(-MAX_CANDIDATES);
  }
  function intervalMs(tf){const m=String(tf||"").toLowerCase().match(/^(\d+)(m|h|d)$/);if(!m)return 60000;return Number(m[1])*(m[2]==="m"?60000:m[2]==="h"?3600000:86400000)}
  function readDiag(){const d=read(DIAG_KEY,{});return{version:1,createdAt:Number(d.createdAt)||Date.now(),observations:Array.isArray(d.observations)?d.observations:[],candidatesByScope:d.candidatesByScope&&typeof d.candidatesByScope==="object"?d.candidatesByScope:{},lastObserved:d.lastObserved&&typeof d.lastObserved==="object"?d.lastObserved:{},latestByScope:d.latestByScope&&typeof d.latestByScope==="object"?d.latestByScope:{},errors:Array.isArray(d.errors)?d.errors:[]}}
  function persist(d){d.observations=d.observations.slice(-MAX_OBSERVATIONS);d.errors=d.errors.slice(-100);write(DIAG_KEY,d)}
  function recordSuccess(pair,tf,bars,startedAt){
    const now=Date.now(),cfg=readConfig(),state=read(STATE_KEY,{}),history=read(HISTORY_KEY,[]),d=readDiag(),t=normalTf(tf),key=pair+"|"+t;
    const latest=assessLatest(bars,pair,t,cfg,state,history,now),candidates=scanCandidates(bars,pair,t,cfg,history,100);
    const ts=Number(bars[bars.length-1]&&bars[bars.length-1].ts)||0,prev=Number(d.lastObserved[key])||0,step=intervalMs(t);
    const gap=prev&&ts>prev?Math.max(0,Math.round((ts-prev)/step)-1):null,id=[pair,t,ts].join("|");
    let obs=d.observations.find(x=>x.id===id);
    if(obs){obs.pollCount=(Number(obs.pollCount)||0)+1;obs.lastPollAt=now;obs.gapCandles=gap;obs.latest=latest}
    else d.observations.push({id,pair,tf:t,candleTs:ts,candleTimeMsk:formatMsk(ts),firstSeenAt:now,lastPollAt:now,pollStartedAt:startedAt,pollCount:1,gapCandles:gap,latest});
    d.lastObserved[key]=ts;
    d.latestByScope[key]={capturedAt:now,pollStartedAt:startedAt,requestMs:Math.max(0,now-startedAt),pair,tf:t,candleCount:bars.length,latest,candidates,actualJournalEvent:null};
    d.candidatesByScope[key]=candidates;persist(d);
    setTimeout(()=>updateJournalOutcome(key,pair,t,ts),250);
    renderIfOpen();
  }
  function updateJournalOutcome(key,pair,tf,ts){
    try{const d=readDiag(),scope=d.latestByScope[key];if(!scope||Number(scope.latest&&scope.latest.candleTs)!==ts)return;
      const h=read(HISTORY_KEY,[]),actual=historyEvent(h,pair,tf,ts);
      scope.actualJournalEvent=actual?{kind:actual.kind,direction:actual.direction,message:actual.message||""}:null;
      (scope.candidates||[]).forEach(c=>{if(Number(c.ts)===ts)c.journalEvent=actual&&actual.kind||null});
      d.candidatesByScope[key]=scope.candidates||[];persist(d);renderIfOpen();
    }catch(_){}
  }
  function recordError(pair,tf,error,startedAt){
    const d=readDiag(),now=Date.now();d.errors.push({pair:String(pair||""),tf:normalTf(tf),at:now,atMsk:formatMsk(now),startedAt,message:error&&error.message?error.message:String(error||"Ошибка запроса")});persist(d);renderIfOpen();
  }
  function installObserver(){
    const app=window.OKXSignalApp;if(!app||typeof app.fetchCandles!=="function")return false;
    const original=app.fetchCandles;if(original.__okxScalpingDiagnostics)return true;
    const wrapped=function(pair,tf,limit){const startedAt=Date.now();let result;
      try{result=original.apply(this,arguments)}catch(error){try{recordError(pair,tf,error,startedAt)}catch(_){}throw error}
      return Promise.resolve(result).then(bars=>{try{if(Array.isArray(bars)&&bars.length)recordSuccess(String(pair),String(tf),bars,startedAt);else recordError(pair,tf,new Error("Получен пустой список свечей"),startedAt)}catch(_){}return bars},
        error=>{try{recordError(pair,tf,error,startedAt)}catch(_){}throw error});
    };
    wrapped.__okxScalpingDiagnostics=true;wrapped.__originalFetchCandles=original;app.fetchCandles=wrapped;return true;
  }
  function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=String(text);return n}
  let modal=null;
  function closeModal(){if(!modal)return;modal.hidden=true;document.body.classList.remove("okx-scalp-diag-open")}
  function openModal(){buildModal();modal.hidden=false;document.body.classList.add("okx-scalp-diag-open");render()}
  function buildModal(){
    if(modal)return modal;modal=el("div","okx-scalp-diag-backdrop");modal.hidden=true;
    modal.innerHTML='<section class="okx-scalp-diag-window" role="dialog" aria-modal="true" aria-labelledby="okxScalpDiagTitle"><header class="okx-scalp-diag-head"><div><h2 id="okxScalpDiagTitle">Диагностика скальпинга · только чтение</h2><p>Наблюдение за опросами и расчётными условиями. Стратегия и настройки не изменяются.</p></div><button type="button" id="okxScalpDiagClose">Закрыть</button></header><div class="okx-scalp-diag-body"><div id="okxScalpDiagSummary" class="okx-scalp-diag-summary">Ожидание опроса скальпинга…</div><div class="okx-scalp-diag-actions"><button type="button" id="okxScalpDiagRefresh">Обновить отчёт</button><button type="button" id="okxScalpDiagExport">Скачать JSON</button></div><h3>Кандидаты среди последних 100 закрытых свечей</h3><div class="okx-scalp-diag-table-wrap"><table><thead><tr><th>Свеча (МСК)</th><th>Цена</th><th>RSI</th><th>Объём / средний</th><th>Кандидат</th><th>В журнале</th></tr></thead><tbody id="okxScalpDiagCandidates"></tbody></table></div><h3>Последние опросы</h3><div class="okx-scalp-diag-table-wrap"><table><thead><tr><th>Свеча (МСК)</th><th>Пара / TF</th><th>Опросов</th><th>Разрыв свечей</th><th>Статус</th></tr></thead><tbody id="okxScalpDiagPolls"></tbody></table></div><h3>Ошибки загрузки</h3><div id="okxScalpDiagErrors" class="okx-scalp-diag-errors">Ошибок пока нет.</div><p class="okx-scalp-diag-note">Для прошлых свечей показывается совпадение расчётных условий RSI/объёма с текущими настройками. Историческое состояние группировки RSI и антиспама восстановить нельзя; «В журнале» — фактическая запись приложения.</p></div></section>';
    document.body.appendChild(modal);
    modal.querySelector("#okxScalpDiagClose").onclick=closeModal;modal.querySelector("#okxScalpDiagRefresh").onclick=render;modal.querySelector("#okxScalpDiagExport").onclick=exportReport;
    modal.addEventListener("click",e=>{if(e.target===modal)closeModal()});
    document.addEventListener("keydown",e=>{if(e.key==="Escape"&&modal&&!modal.hidden)closeModal()});
    return modal;
  }
  function mountButton(){const nav=document.getElementById("quickAccessBar");if(!nav||document.getElementById("scalpDiagnosticsButton"))return;
    const b=el("button","scalp-diagnostics-button");b.type="button";b.id="scalpDiagnosticsButton";b.innerHTML="⌕ <span>Диагностика</span>";b.title="Журнал наблюдений скальпинга";b.onclick=openModal;nav.appendChild(b)}
  function cell(row,value){row.appendChild(el("td","",value==null||value===""?"—":value))}
  function render(){
    const d=readDiag(),summary=document.getElementById("okxScalpDiagSummary"),candidateBody=document.getElementById("okxScalpDiagCandidates"),pollBody=document.getElementById("okxScalpDiagPolls"),errors=document.getElementById("okxScalpDiagErrors");
    if(!summary||!candidateBody||!pollBody||!errors)return;
    const scopes=Object.values(d.latestByScope);
    if(!scopes.length)summary.textContent="Опросов пока нет. Запись начнётся при следующем опросе скальпинга.";
    else{const s=scopes.sort((a,b)=>b.capturedAt-a.capturedAt)[0],x=s.latest||{},decisions=x.decisions&&x.decisions.length?x.decisions.map(z=>z.direction+(z.reasons.length?" — "+z.reasons.join("; "):" — расчётные блокировки не найдены")).join("\n"):(x.reasons||["Нет сырого кандидата Volume + RSI"]).join("\n");
      summary.textContent="Последний опрос: "+formatMsk(s.capturedAt)+" МСК\nПара / TF: "+s.pair+" / "+s.tf+"\nПолучено свечей: "+s.candleCount+"\nПоследняя закрытая свеча: "+(x.candleTimeMsk||"—")+"\nRSI: "+metric(x.rsi)+" (предыдущий "+metric(x.previousRsi)+")\nОбъём: "+metric(x.volume)+" / средний "+metric(x.averageVolume)+"\nОбъём / средний: "+(x.volumeRatio==null?"—":Number(x.volumeRatio).toFixed(2)+"×")+"\nVolume spike: "+(x.volumeSpike?"ДА":"нет")+"\nRSI LONG / SHORT: "+(x.rsiLong?"ДА":"нет")+" / "+(x.rsiShort?"ДА":"нет")+"\nBOS: "+(x.bos?x.bos.direction:"—")+"\nСвеча уже обработана: "+(x.alreadyProcessed?"ДА":"нет")+"\nЗапись по последней свече: "+(s.actualJournalEvent?s.actualJournalEvent.kind+" "+s.actualJournalEvent.direction:(x.hasHistory?x.historyKind:"нет"))+"\nРешение по направлению:\n"+decisions}
    candidateBody.replaceChildren();const candidates=scopes.flatMap(s=>s.candidates||[]).sort((a,b)=>b.ts-a.ts).slice(0,40);
    if(!candidates.length){const r=el("tr");cell(r,"Совпадений Volume + RSI в доступной истории не найдено");r.firstChild.colSpan=6;candidateBody.appendChild(r)}
    else candidates.forEach(x=>{const r=el("tr");cell(r,x.timeMsk);cell(r,Number(x.close).toPrecision(8));cell(r,metric(x.rsi));cell(r,Number(x.volumeRatio).toFixed(2)+"×");cell(r,x.direction+(x.passesBos?"":" (BOS не прошёл)"));cell(r,x.journalEvent||"нет");candidateBody.appendChild(r)});
    pollBody.replaceChildren();d.observations.slice().reverse().slice(0,35).forEach(x=>{const r=el("tr");cell(r,x.candleTimeMsk);cell(r,x.pair+" / "+x.tf);cell(r,x.pollCount);cell(r,x.gapCandles==null?"—":x.gapCandles);cell(r,x.latest&&x.latest.hasHistory?"Сигнал записан":"Опрос успешен");pollBody.appendChild(r)});
    errors.textContent=d.errors.length?d.errors.slice(-10).reverse().map(x=>x.atMsk+" · "+x.pair+" / "+x.tf+" · "+x.message).join("\n"):"Ошибок загрузки не зарегистрировано."
  }
  function metric(v){return Number.isFinite(Number(v))?Number(v).toFixed(2):"—"}
  function renderIfOpen(){if(modal&&!modal.hidden)render()}
  function exportReport(){
    const d=readDiag(),s=read(STATE_KEY,{}),h=read(HISTORY_KEY,[]);
    const payload={app:"OKX Signal Pro — first version",reportCreatedAt:new Date().toISOString(),note:"Read-only diagnostics; this module does not change scalping strategy or settings.",config:readConfig(),strategyState:{processed:s.processed||{},historyCount:Array.isArray(h)?h.length:0},diagnostics:d};
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),a=el("a");
    a.href=url;a.download="okx-scalping-diagnostics-"+new Date().toISOString().replace(/[:.]/g,"-")+".json";document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)
  }
  function injectCss(){if(document.getElementById("okxScalpDiagStyle"))return;const s=el("style");s.id="okxScalpDiagStyle";
    s.textContent=".okx-scalp-diag-backdrop{position:fixed;inset:0;z-index:10100;display:flex;align-items:center;justify-content:center;padding:14px;background:rgba(0,0,0,.76)}.okx-scalp-diag-backdrop[hidden]{display:none!important}.okx-scalp-diag-window{display:flex;flex-direction:column;width:min(1120px,100%);max-height:94vh;background:#0b1118;color:#eaf0f6;border:1px solid #304154;border-radius:14px;overflow:hidden}.okx-scalp-diag-head{display:flex;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid #233142}.okx-scalp-diag-head h2{font-size:16px;margin:0 0 5px}.okx-scalp-diag-head p,.okx-scalp-diag-note{color:#91a0b1;font-size:11px;line-height:1.5;margin:0}.okx-scalp-diag-body{padding:14px 16px;overflow:auto}.okx-scalp-diag-summary{white-space:pre-line;padding:11px;background:#101925;border:1px solid #2b4055;border-radius:9px;color:#c5d7e8;font-size:11px;line-height:1.6}.okx-scalp-diag-actions{display:flex;gap:8px;margin:10px 0}.okx-scalp-diag-body h3{font-size:12px;margin:16px 0 7px}.okx-scalp-diag-table-wrap{max-height:220px;overflow:auto;border:1px solid #243244;border-radius:8px}.okx-scalp-diag-table-wrap table{width:100%;border-collapse:collapse;font-size:10px}.okx-scalp-diag-table-wrap th,.okx-scalp-diag-table-wrap td{padding:7px 8px;text-align:left;white-space:nowrap;border-bottom:1px solid #202d3b}.okx-scalp-diag-table-wrap th{position:sticky;top:0;background:#111c29;color:#93a4b6}.okx-scalp-diag-errors{font-size:10px;color:#ffb1b6;white-space:pre-line}.okx-scalp-diag-note{margin-top:12px}.okx-scalp-diag-open{overflow:hidden}@media(max-width:650px){.okx-scalp-diag-backdrop{padding:0}.okx-scalp-diag-window{width:100%;height:100%;max-height:100vh;border-radius:0}.okx-scalp-diag-head,.okx-scalp-diag-body{padding:11px}.okx-scalp-diag-table-wrap{max-height:180px}}";
    document.head.appendChild(s)
  }
  if(window.__OKX_SCALPING_DIAGNOSTICS_TEST__){
    window.__OKXScalpingDiagnosticsTest={evaluateAt,assessLatest,scanCandidates,readConfig,formatMsk,intervalMs};return
  }
  function init(){try{if(!installObserver()){window.setTimeout(init,250);return}mountButton();injectCss()}catch(_){}}
  init()
})();