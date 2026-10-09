/* OKX Signal Pro — independent Alerts module */
(function(){
  "use strict";
  const KEY="okx_alerts_v1";
  const defaults={volume:true,volumePeriod:20,volumeMult:2,rsi:true,rsiPeriod:14,rsiLow:30,rsiHigh:70,sma:true,smaPeriod:21,smaTolerance:0,comboEnabled:false,comboCount:2,comboWindow:1,sound:true,volumeLevel:.65,cooldown:30,selectedPairs:[],alertTf:"15m"};
  let cfg=Object.assign({},defaults,(()=>{try{return JSON.parse(localStorage.getItem(KEY)||"{}")}catch{return{}}})());
  if(!Number.isFinite(Number(cfg.smaTolerance))||Number(cfg.smaTolerance)===.15)cfg.smaTolerance=0;
  let audioCtx=null,lastClosedTs=0,lastPair="",lastTf="",lastTouch=false,lastAlertAt={},pairState={},pollBusy=false,comboSignals=[],comboLastAt={};
  const $=id=>document.getElementById(id);
  const esc=s=>String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
  function save(){localStorage.setItem(KEY,JSON.stringify(cfg))}
  function ensureAudio(){
    try{
      if(!audioCtx)audioCtx=new (window.AudioContext||window.webkitAudioContext)();
      if(audioCtx.state==="suspended")return audioCtx.resume();
      return Promise.resolve();
    }catch(e){return Promise.reject(e)}
  }
  function tone(kind){
    if(!cfg.sound)return;
    const run=()=>{
      if(!audioCtx)return;
      const now=audioCtx.currentTime,level=Math.max(.02,cfg.volumeLevel*.12);
      const play=(freq,start,dur,type="triangle",gain=level)=>{
        const o=audioCtx.createOscillator(),g=audioCtx.createGain();
        o.type=type;o.frequency.value=freq;
        g.gain.setValueAtTime(.0001,now+start);
        g.gain.exponentialRampToValueAtTime(gain,now+start+.02);
        g.gain.exponentialRampToValueAtTime(.0001,now+start+dur);
        o.connect(g);g.connect(audioCtx.destination);o.start(now+start);o.stop(now+start+dur+.03);
      };
      // Volume: two rising beeps — energetic signal.
      if(kind==="volume"){play(520,0,.32,"triangle");play(780,.38,.38,"triangle",level*.9);return}
      // RSI: three alternating beeps — clearly different from Volume/SMA.
      if(kind==="rsi"){play(740,0,.24,"square",level*.9);play(560,.30,.24,"square",level*.8);play(740,.60,.24,"square",level*.9);return}
      // SMA: two-note soft alert — clearly different from Volume/RSI.
      if(kind==="sma"){play(330,0,.55,"sine",level*.9);play(440,.62,.32,"sine",level*.65);return}
      // Combo: three quick notes, distinct from single-indicator alerts.
      if(kind==="combo"){play(880,0,.20,"triangle",level);play(660,.24,.20,"triangle",level*.85);play(1040,.48,.36,"triangle",level);return}
      // Test fallback.
      play(660,0,.40,"triangle");
    };
    ensureAudio().then(run).catch(()=>{});
  }
  function now(){return Date.now()}
  function canAlert(key){
    const t=now(),cd=Math.max(1,+cfg.cooldown||30)*1000;
    if(t-(lastAlertAt[key]||0)<cd)return false;
    lastAlertAt[key]=t;return true;
  }
  function sma(a,n,field="c"){if(!a||a.length<n)return null;let s=0;for(let i=a.length-n;i<a.length;i++)s+=Number(a[i][field])||0;return s/n}
  function rsi(a,n){
    if(!a||a.length<n+1)return null;
    let gain=0,loss=0;
    for(let i=a.length-n;i<a.length;i++){const d=(Number(a[i].c)||0)-(Number(a[i-1].c)||0);if(d>0)gain+=d;else loss-=d}
    if(loss===0)return 100;
    if(gain===0)return 0;
    return 100-(100/(1+gain/loss));
  }
  function app(){return window.OKXSignalApp&&window.OKXSignalApp.getState?window.OKXSignalApp.getState():null}
  function markets(){return window.OKXSignalApp&&window.OKXSignalApp.getMarkets?window.OKXSignalApp.getMarkets():[]}
  function fetchCandles(pair,tf){return window.OKXSignalApp&&window.OKXSignalApp.fetchCandles?window.OKXSignalApp.fetchCandles(pair,tf,80):Promise.reject(Error("OKX data unavailable"))}
  const ALERT_LOG_KEY="okx_alert_log_v1";
  const ALERT_RETENTION_MS=7*24*60*60*1000;
  const ALERT_LOG_LIMIT=500;
  function loadAlertLog(){
    const cutoff=Date.now()-ALERT_RETENTION_MS;
    try{
      const saved=JSON.parse(localStorage.getItem(ALERT_LOG_KEY)||"[]");
      return (Array.isArray(saved)?saved:[]).filter(e=>e&&Number(e.ts)>=cutoff&&typeof e.text==="string").slice(-ALERT_LOG_LIMIT);
    }catch{return[]}
  }
  let alertLogEntries=loadAlertLog();
  function saveAlertLog(){try{localStorage.setItem(ALERT_LOG_KEY,JSON.stringify(alertLogEntries.slice(-ALERT_LOG_LIMIT)))}catch(e){}}
  function renderAlertLog(){
    const box=$("alertsLog");if(!box)return;
    box.innerHTML=alertLogEntries.slice().reverse().map(entry=>{
      const kind=["volume","rsi","sma","combo"].includes(entry.kind)?entry.kind:"other";
      const stamp=new Date(Number(entry.ts)).toLocaleString("ru-RU",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"});
      return '<div class="alertlogrow"><span class="alertdot '+kind+'"></span><span title="'+esc(stamp)+'">'+esc(stamp)+'</span><b title="'+esc(entry.text)+'">'+esc(entry.text)+'</b></div>';
    }).join("");
  }
  function log(kind,text){
    const ts=Date.now(),cleanKind=["volume","rsi","sma","combo"].includes(kind)?kind:"other";
    alertLogEntries.push({ts,kind:cleanKind,text:String(text??"")});
    const cutoff=ts-ALERT_RETENTION_MS;
    alertLogEntries=alertLogEntries.filter(e=>Number(e.ts)>=cutoff).slice(-ALERT_LOG_LIMIT);
    saveAlertLog();renderAlertLog();
  }
  const MARKER_KEY="okx_v2_alert_markers";
  const MARKER_RETENTION_MS=7*24*60*60*1000;
  function pruneStoredMarkers(){
    let marks=[];try{marks=JSON.parse(localStorage.getItem(MARKER_KEY)||"[]");if(!Array.isArray(marks))marks=[]}catch{}
    const cutoff=Date.now()-MARKER_RETENTION_MS;
    const clean=marks.filter(m=>m&&Number(m.ts)>=cutoff&&m.pair&&m.tf&&["LONG","SHORT"].includes(m.direction)).slice(-500);
    if(clean.length!==marks.length||clean.some((m,i)=>m!==marks[i]))try{localStorage.setItem(MARKER_KEY,JSON.stringify(clean))}catch{}
  }
  pruneStoredMarkers();
  function recordAlertMarker(meta){
    if(!meta||!meta.pair||!meta.tf||!["LONG","SHORT"].includes(meta.direction))return;
    const price=Number(meta.price),ts=Number(meta.ts)||now();
    if(!Number.isFinite(price)||price<=0)return;
    let marks=[];
    try{marks=JSON.parse(localStorage.getItem(MARKER_KEY)||"[]");if(!Array.isArray(marks))marks=[]}catch{}
    const cutoff=Date.now()-MARKER_RETENTION_MS;
    marks=marks.filter(m=>m&&Number(m.ts)>=cutoff&&m.pair&&m.tf&&["LONG","SHORT"].includes(m.direction)).slice(-500);
    const id=[meta.pair,meta.tf,meta.kind,ts,meta.direction].join("|");
    if(marks.some(m=>m.id===id))return;
    const tolerance=Math.max(price*.0008,.01);
    const same=marks.filter(m=>m.pair===meta.pair&&m.tf===meta.tf&&m.kind===meta.kind&&Math.abs(Number(m.price)-price)<=Math.max(tolerance,Number(m.tolerance)||0));
    const touches=1+same.length;
    const entryPrice=Number(meta.entryPrice)>0?Number(meta.entryPrice):price;
    const marker={id,pair:meta.pair,tf:meta.tf,kind:meta.kind,direction:meta.direction,price,entryPrice,ts,touches,label:meta.label||meta.kind,tolerance};
    marks.push(marker);
    try{localStorage.setItem(MARKER_KEY,JSON.stringify(marks.slice(-500)))}catch{}
    window.dispatchEvent(new CustomEvent("okx-alert-marker",{detail:marker}));
  }
  const COMBO_SOURCES=["volume","rsi","sma"];
  const COMBO_TF_MS={"1m":60000,"5m":300000,"15m":900000,"30m":1800000,"1h":3600000,"4h":14400000,"1d":86400000};
  function observeCombo(kind,marker){
    if(!cfg.comboEnabled||!marker||!COMBO_SOURCES.includes(kind)||!cfg[kind])return;
    const pair=marker.pair,tf=String(marker.tf||cfg.alertTf||"15m").toLowerCase(),direction=marker.direction,ts=Number(marker.ts)||now();
    if(!pair||!["LONG","SHORT"].includes(direction)||!Number.isFinite(ts))return;
    const bars=Math.max(1,Math.min(5,Number(cfg.comboWindow)||1)),windowMs=(COMBO_TF_MS[tf]||900000)*bars;
    const id=[pair,tf,kind,ts,direction].join("|");
    if(!comboSignals.some(s=>s.id===id))comboSignals.push({id,pair,tf,kind,ts,direction,price:Number(marker.price)||0,entryPrice:Number(marker.entryPrice)||Number(marker.price)||0,label:marker.label||kind});
    comboSignals=comboSignals.slice(-300);
    const matching=comboSignals.filter(s=>s.pair===pair&&s.tf===tf&&Math.abs(ts-s.ts)<=windowMs);
    const byKind=new Map();
    matching.forEach(s=>{const old=byKind.get(s.kind);if(!old||Math.abs(ts-s.ts)<Math.abs(ts-old.ts))byKind.set(s.kind,s)});
    const chosen=[...byKind.values()],required=Math.max(2,Math.min(3,Number(cfg.comboCount)||2));
    if(chosen.length<required)return;
    // Volume confirms activity, but candle body colour does not decide combo direction.
    // RSI and SMA are directional; if both are present, their directions must agree.
    const directed=chosen.filter(s=>s.kind!=="volume");
    if(!directed.length)return;
    const comboDirection=directed[0].direction;
    if(directed.some(s=>s.direction!==comboDirection))return;
    const comboTs=Math.max(...chosen.map(s=>Number(s.ts)||0));
    const directionSignal=[...directed].sort((x,y)=>Math.abs(ts-x.ts)-Math.abs(ts-y.ts))[0];
    const alertKey="combo:"+pair+":"+tf+":"+comboDirection,lastAt=comboLastAt[alertKey]||0;
    if(lastAt&&Math.abs(comboTs-lastAt)<=windowMs)return;
    if(!canAlert(alertKey))return;
    comboLastAt[alertKey]=comboTs;
    const kinds=chosen.map(s=>s.kind.toUpperCase());
    const message="✨ COMBO "+chosen.length+"/3 "+comboDirection+" • "+kinds.join(" + ")+" • "+pair+" • "+tf;
    recordAlertMarker({pair,tf,ts:comboTs,price:Number(directionSignal.price)||Number(marker.price)||chosen.at(-1)?.price||0,entryPrice:Number(directionSignal.entryPrice)||Number(marker.entryPrice)||Number(directionSignal.price)||Number(marker.price)||0,direction:comboDirection,label:"COMBO "+kinds.join("+"),kind:"combo"});
    log("combo",message);tone("combo");
    const badge=$("alertsLast");if(badge){badge.textContent=message;badge.className="alerts-last combo"}
  }
  function fire(kind,text,key,marker){
    const source=marker&&COMBO_SOURCES.includes(kind);
    if(!canAlert(key)){
      if(source)observeCombo(kind,marker);
      return;
    }
    if(marker)recordAlertMarker(Object.assign({},marker,{kind}));
    log(kind,text);tone(kind);
    const badge=$("alertsLast");if(badge){badge.textContent=text;badge.className="alerts-last "+kind}
    if(source)observeCombo(kind,marker);
  }
  function evaluate(s){
    const a=s.candles||[],live=s.liveCandle,pair=s.currentPair||"",tf=s.tf||"";
    const selected=new Set(cfg.selectedPairs||[]);
    if(tf!==cfg.alertTf||!selected.has(pair))return;
    if(pair!==lastPair||tf!==lastTf){lastPair=pair;lastTf=tf;lastClosedTs=0;lastTouch=false}
    if(a.length<5)return;
    evaluatePair({a,live,pair,tf,updateUi:true});
  }
  function evaluatePair(o){
    const raw=o.a||[],pair=o.pair,tf=o.tf||"15m",updateUi=o.updateUi;
    if(raw.length<6)return;
    const polled=o.polled===true;
    const hist=polled?raw.slice(0,-1):raw;
    const live=polled?raw[raw.length-1]:o.live;
    if(hist.length<5)return;
    const st=pairState[pair]||(pairState[pair]={lastClosedTs:0,lastTouch:false});
    const closed=hist[hist.length-1];
    if(closed&&closed.ts!==st.lastClosedTs){
      st.lastClosedTs=closed.ts;
      if(cfg.volume&&hist.length>=Math.max(3,+cfg.volumePeriod||20)+1){
        const n=Math.max(2,+cfg.volumePeriod||20),base=hist.slice(0,-1).slice(-n),avg=base.reduce((z,x)=>z+(Number(x.v)||0),0)/base.length,v=Number(closed.v)||0,m=avg>0?v/avg:0;
        if(m>=Math.max(1,+cfg.volumeMult||2)){const isLong=Number(closed.c)>=Number(closed.o),dir=isLong?"🟢 BUY":"🔴 SELL",side=isLong?"LONG":"SHORT";fire("volume","⚡ VOLUME SPIKE "+dir+" • ×"+m.toFixed(1)+" • "+pair+" • "+tf,"volume:"+pair+":"+tf,{pair,tf,ts:closed.ts,price:Number(closed.c),direction:side,label:"VOLUME"});}
      }
      if(cfg.rsi){
        const n=Math.max(2,+cfg.rsiPeriod||14),rv=rsi(hist,n),prev=rsi(hist.slice(0,-1),n);
        if(rv!=null&&prev!=null){
          if(prev>=cfg.rsiLow&&rv<cfg.rsiLow)fire("rsi","📉 RSI OVERSOLD LONG • ниже "+cfg.rsiLow+" → "+rv.toFixed(1)+" • "+pair+" • "+tf,"rsi-low:"+pair+":"+tf,{pair,tf,ts:closed.ts,price:Number(closed.c),direction:"LONG",label:"RSI"});
          if(prev<=cfg.rsiHigh&&rv>cfg.rsiHigh)fire("rsi","📈 RSI OVERBOUGHT SHORT • выше "+cfg.rsiHigh+" → "+rv.toFixed(1)+" • "+pair+" • "+tf,"rsi-high:"+pair+":"+tf,{pair,tf,ts:closed.ts,price:Number(closed.c),direction:"SHORT",label:"RSI"});
        }
      }
    }
    if(cfg.sma){
      const n=Math.max(2,+cfg.smaPeriod||21),m=sma(hist,n);
      if(m){
        const src=live||closed,price=Number(src?.c)||0,high=Number(src?.h)||price,low=Number(src?.l)||price,tol=Math.max(0,+cfg.smaTolerance||0)/100;
        const exactTouch=price>0&&low<=m&&high>=m;
        const nearTouch=tol>0&&price>0&&Math.abs(price-m)/m<=tol;
        const touched=exactTouch||nearTouch;
        if(touched&&!st.lastTouch){
          const prevPrice=Number(hist[hist.length-2]?.c)||price;
          const prevSma=sma(hist.slice(0,-1),n)||m;
          const direction=prevPrice<prevSma?"LONG":prevPrice>prevSma?"SHORT":price>=m?"LONG":"SHORT";
          const icon=direction==="LONG"?"↑":"↓";
          const label=icon+" SMA"+n+" "+direction+" TOUCH";
          fire("sma",label+" • "+pair+" • "+tf+" • Price "+price.toFixed(2)+" / SMA "+m.toFixed(2),"sma:"+pair+":"+tf,{pair,tf,ts:Number(src?.ts)||Number(closed?.ts)||now(),price:m,entryPrice:Number(src?.c)||m,direction,label:"SMA"+n});}
        st.lastTouch=touched;
      }
    }
    if(updateUi)updateStats({pair},hist);
  }
  function updateStats(s,a){
    const m=a.length?Number(a[a.length-1].c):0,sm=cfg.sma?sma(a,Math.max(2,+cfg.smaPeriod||21)):null,rv=cfg.rsi?rsi(a,Math.max(2,+cfg.rsiPeriod||14)):null;
    if($("alertsSmaValue"))$("alertsSmaValue").textContent=sm?sm.toFixed(2):"—";
    if($("alertsRsiValue"))$("alertsRsiValue").textContent=rv!=null?rv.toFixed(1):"—";
    if($("alertsPriceValue"))$("alertsPriceValue").textContent=m?m.toFixed(2):"—";
  }
  function build(){
    if(document.getElementById("alertsPanel"))return;
    const chartPanel=document.querySelector(".grid main > .panel");
    if(!chartPanel)return;
    const layout=document.createElement("div");
    layout.id="chartAlertsLayout";
    const target=document.createElement("div");
    target.id="chartAlertsSide";
    chartPanel.parentNode.insertBefore(layout,chartPanel);
    layout.appendChild(chartPanel);
    layout.appendChild(target);
    const p=document.createElement("div");p.id="alertsPanel";p.className="panel";
    p.innerHTML='<h2>🔔 Alerts</h2>'+
      '<div class="alerts-note">⚡ Volume = всплеск объёма · 📈/📉 RSI = выход в перекупленность/перепроданность · 🟢/🔴 SMA = пересечение или касание SMA. Каждый сигнал показывает направление, пару и таймфрейм.</div>'+
      '<div class="alerts-section"><b>⏱️ Таймфрейм оповещений</b><select id="alertTf" class="alerts-tf"><option value="1m">1m</option><option value="5m">5m</option><option value="15m">15m</option><option value="30m">30m</option><option value="1h">1h</option><option value="4h">4h</option><option value="1d">1d</option></select><div class="alerts-note">Таймфрейм оповещений независим от таймфрейма графика.</div></div><div class="alerts-section"><b>📋 Пары для оповещений</b><div class="alerts-pair-actions"><button id="alertsPairsAll">Все доступные</button><button id="alertsPairsClear">Очистить</button></div><div id="alertsPairs" class="alerts-pairs"></div><div class="alerts-note">Выбери пары. Максимум 20 одновременно.</div></div>'+
      '<div class="alerts-section"><label class="alerts-check"><input id="alertVolume" type="checkbox"><span>Volume Spike</span></label><div class="alerts-grid"><label>Период<input id="alertVolPeriod" type="number" min="2" value="'+cfg.volumePeriod+'"></label><label>Порог ×<input id="alertVolMult" type="number" min="1" step=".1" value="'+cfg.volumeMult+'"></label></div></div>'+
      '<div class="alerts-section"><label class="alerts-check"><input id="alertRsi" type="checkbox"><span>RSI</span></label><div class="alerts-grid"><label>Период<input id="alertRsiPeriod" type="number" min="2" value="'+cfg.rsiPeriod+'"></label><label>Зоны<input id="alertRsiLow" type="number" min="1" max="49" value="'+cfg.rsiLow+'"> / <input id="alertRsiHigh" type="number" min="51" max="99" value="'+cfg.rsiHigh+'"></label></div></div>'+
      '<div class="alerts-section"><label class="alerts-check"><input id="alertSma" type="checkbox"><span>SMA Touch</span></label><div class="alerts-grid"><label>Период<input id="alertSmaPeriod" type="number" min="2" value="'+cfg.smaPeriod+'"></label><label>Допуск %<input id="alertSmaTol" type="number" min="0" step=".05" value="'+cfg.smaTolerance+'"></label></div></div>'+
      '<div class="alerts-section"><label class="alerts-check"><input id="alertCombo" type="checkbox"><span>✨ Комбо-алерт</span></label><div class="alerts-grid"><label>Совпадение<select id="alertComboCount"><option value="2">2 из 3 индикаторов</option><option value="3">3 из 3 индикаторов</option></select></label><label>Окно<select id="alertComboWindow"><option value="1">1 свеча</option><option value="2">2 свечи</option><option value="3">3 свечи</option></select></label></div><div class="alerts-note">Сигналы должны совпасть по паре, таймфрейму и окну. Volume подтверждает активность, а направление LONG/SHORT задают RSI и/или SMA. Если RSI и SMA одновременно сработали, их направления должны совпадать. Самостоятельные алерты Volume, RSI и SMA остаются отдельными.</div></div>'+
      '<div class="alerts-section"><div class="alerts-grid"><label>Громкость<input id="alertVolumeLevel" type="range" min="0" max="1" step=".05" value="'+cfg.volumeLevel+'"></label><label>Антиспам, сек<input id="alertCooldown" type="number" min="1" value="'+cfg.cooldown+'"></label></div><div class="alerts-actions"><button id="alertsSound" class="primary">🔊 Включить звук</button></div><div class="alerts-sound-tests"><button id="testVolume">⚡ Volume</button><button id="testRsi">📈 RSI</button><button id="testSma">〽️ SMA</button><button id="testCombo">✨ Combo</button><button id="testAll">▶ Все 3</button></div><div class="alerts-note">Нажми кнопки, чтобы сравнить реальные звуки каждого сигнала.</div></div>'+
      '<div class="alerts-stats"><div><small>Price</small><b id="alertsPriceValue">—</b></div><div><small>SMA</small><b id="alertsSmaValue">—</b></div><div><small>RSI</small><b id="alertsRsiValue">—</b></div></div>'+
      '<div id="alertsLast" class="alerts-last">Ожидание сигнала…</div><div class="alerts-log-head"><b>📚 Журнал алертов · хранение 7 дней</b><button type="button" id="clearAlertsLog">Очистить</button></div><div id="alertsLog" class="alerts-log"></div>';
    target.appendChild(p);
    renderAlertLog();
    const clearHistory=$("clearAlertsLog");
    if(clearHistory)clearHistory.onclick=()=>{if(!confirm("Очистить сохранённый журнал алертов за последние 7 дней?"))return;alertLogEntries=[];saveAlertLog();renderAlertLog()};
    $("alertTf").value=cfg.alertTf||"15m";
    $("alertTf").onchange=()=>{cfg.alertTf=$("alertTf").value;pairState={};save();log("sma","Таймфрейм Alerts: "+cfg.alertTf)};
    renderPairs();
    $("alertsPairsAll").onclick=()=>{cfg.selectedPairs=markets().slice(0,20).map(x=>x.instId);save();renderPairs()};
    $("alertsPairsClear").onclick=()=>{cfg.selectedPairs=[];save();renderPairs()};
    function renderPairs(){
      const box=$("alertsPairs");if(!box)return;
      const ms=markets(),sel=new Set(cfg.selectedPairs||[]);
      box.innerHTML=ms.slice(0,60).map(m=>{const id=m.instId,short=id.replace("-USDT-SWAP","");return '<label class="alert-pair"><input type="checkbox" data-pair="'+esc(id)+'" '+(sel.has(id)?"checked":"")+'><span>'+esc(short)+'</span></label>'}).join("")||'<span class="small">Список пар появится после загрузки рынка.</span>';
      box.querySelectorAll("input[data-pair]").forEach(el=>el.onchange=()=>{let s=new Set(cfg.selectedPairs||[]);if(el.checked){if(s.size>=20){el.checked=false;return}s.add(el.dataset.pair)}else s.delete(el.dataset.pair);cfg.selectedPairs=[...s];save()});
    }
    ["alertVolume","alertRsi","alertSma"].forEach((id,i)=>{const el=$(id);el.checked=[cfg.volume,cfg.rsi,cfg.sma][i];el.onchange=()=>{if(i===0)cfg.volume=el.checked;if(i===1)cfg.rsi=el.checked;if(i===2)cfg.sma=el.checked;save()}});
    $("alertCombo").checked=!!cfg.comboEnabled;
    $("alertCombo").onchange=()=>{cfg.comboEnabled=$("alertCombo").checked;comboSignals=[];comboLastAt={};save()};
    $("alertComboCount").value=String(cfg.comboCount||2);
    $("alertComboWindow").value=String(cfg.comboWindow||1);
    const bind=(id,key,parse)=>{const el=$(id);el.onchange=()=>{cfg[key]=parse(el.value);comboSignals=[];comboLastAt={};save()}};
    bind("alertVolPeriod","volumePeriod",v=>Math.max(2,+v||20));bind("alertVolMult","volumeMult",v=>Math.max(1,+v||2));bind("alertRsiPeriod","rsiPeriod",v=>Math.max(2,+v||14));bind("alertRsiLow","rsiLow",v=>Math.min(49,Math.max(1,+v||30)));bind("alertRsiHigh","rsiHigh",v=>Math.min(99,Math.max(51,+v||70)));bind("alertSmaPeriod","smaPeriod",v=>Math.max(2,+v||21));bind("alertSmaTol","smaTolerance",v=>Math.max(0,+v||0));bind("alertComboCount","comboCount",v=>Math.max(2,Math.min(3,+v||2)));bind("alertComboWindow","comboWindow",v=>Math.max(1,Math.min(3,+v||1)));bind("alertVolumeLevel","volumeLevel",v=>Math.min(1,Math.max(0,+v||0)));bind("alertCooldown","cooldown",v=>Math.max(1,+v||30));
    $("alertsSound").onclick=async()=>{try{await ensureAudio();cfg.sound=true;save();tone("test");$("alertsSound").textContent="🔊 Звук включён";log("sma","Звук включён")}catch{$("alertsSound").textContent="⚠️ Звук недоступен"}};
    const testSound=async(kind,label)=>{try{await ensureAudio();cfg.sound=true;save();tone(kind);log(kind,"Тест звука: "+label)}catch{}};    $("testVolume").onclick=()=>testSound("volume","Volume");    $("testRsi").onclick=()=>testSound("rsi","RSI");    $("testSma").onclick=()=>testSound("sma","SMA21");    $("testCombo").onclick=()=>testSound("combo","Combo");    $("testAll").onclick=async()=>{try{await ensureAudio();cfg.sound=true;save();tone("volume");setTimeout(()=>tone("rsi"),1100);setTimeout(()=>tone("sma"),2200);log("sma","Тест: Volume → RSI → SMA21")}catch{}};
  }
  function injectCss(){
    if(document.getElementById("alertsCss"))return;
    const st=document.createElement("style");st.id="alertsCss";st.textContent='#chartAlertsLayout{display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:12px;align-items:start}.alerts-tf{width:100%;margin-top:6px;padding:8px}.alerts-note{color:var(--m);font-size:10px;line-height:1.35;margin:-2px 0 9px}.alerts-section{padding:8px 0;border-top:1px solid #1a2530}.alerts-check{display:flex;gap:7px;align-items:center;font-weight:700;font-size:12px}.alerts-check input{width:auto}.alerts-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:7px}.alerts-grid label{color:var(--m);font-size:10px}.alerts-grid input{width:100%;margin-top:3px;padding:7px}.alerts-grid select{width:100%;margin-top:3px;padding:7px}.alerts-grid input[type=range]{padding:0}.alerts-pair-actions{display:flex;gap:6px;margin:7px 0}.alerts-pair-actions button{flex:1;padding:6px;font-size:10px}.alerts-pairs{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;max-height:150px;overflow:auto;padding:2px 0}.alert-pair{display:flex;gap:4px;align-items:center;background:#101823;border:1px solid #17212d;border-radius:6px;padding:5px;font-size:9px}.alert-pair input{width:auto}.alerts-actions{display:flex;gap:7px;margin-top:8px}.alerts-actions button{flex:1;padding:8px;font-size:11px}.alerts-sound-tests{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-top:7px}.alerts-sound-tests button{padding:7px 4px;font-size:10px}.alerts-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:8px}.alerts-stats>div{background:var(--p2);border:1px solid #17212d;border-radius:8px;padding:7px}.alerts-stats small{display:block;color:var(--m);font-size:9px}.alerts-stats b{display:block;margin-top:2px;font-size:11px}.alerts-last{margin-top:8px;padding:8px;border-radius:8px;background:#111923;color:var(--m);font-size:10px}.alerts-last.volume{color:var(--y);border:1px solid #4b3e15}.alerts-last.rsi{color:#55a8ff;border:1px solid #25496c}.alerts-last.sma{color:var(--g);border:1px solid #205f45}.alerts-last.combo{color:#c5a3ff;border:1px solid #4b3b68}.alerts-log{margin-top:6px;max-height:280px;overflow:auto}.alerts-log-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:10px;color:var(--m);font-size:10px}.alerts-log-head button{padding:5px 8px;font-size:10px;color:var(--m)}.alertlogrow{display:grid;grid-template-columns:8px 100px minmax(0,1fr);gap:6px;align-items:start;padding:5px 0;border-bottom:1px solid #17212d;font-size:9px}.alertlogrow b{font-size:9px;overflow-wrap:anywhere;white-space:normal}.alertdot{width:7px;height:7px;border-radius:50%;background:#8290a0}.alertdot.volume{background:#ffd166}.alertdot.rsi{background:#55a8ff}.alertdot.sma{background:#27e58a}.alertdot.combo{background:#c5a3ff}@media(max-width:900px){#chartAlertsLayout{grid-template-columns:1fr}.alerts-grid{grid-template-columns:1fr 1fr}}';
    document.head.appendChild(st);
  }
  injectCss();build();
  setInterval(()=>{try{const s=app();if(s)evaluate(s)}catch(e){console.warn("Alerts",e)}},500);
  async function pollSelected(){
    if(pollBusy)return;
    const sel=(cfg.selectedPairs||[]).slice(0,20),tf=cfg.alertTf||"15m";
    if(!sel.length)return;
    pollBusy=true;
    try{
      const results=await Promise.allSettled(sel.map(async pair=>({pair,a:await fetchCandles(pair,tf)})));
      for(const r of results)if(r.status==="fulfilled"&&r.value.a?.length)evaluatePair({a:r.value.a,live:r.value.a[r.value.a.length-1],pair:r.value.pair,tf,polled:true,updateUi:r.value.pair===app()?.currentPair});
    }finally{pollBusy=false}
  }
  setInterval(()=>{pollSelected().catch(e=>console.warn("Alerts poll",e))},15000);
  setInterval(()=>{try{renderPairs()}catch(e){}},5000);
  window.OKXAlerts={test:()=>tone("test"),getConfig:()=>Object.assign({},cfg)};
})();