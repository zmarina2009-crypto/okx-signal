/* OKX Signal Pro — independent Alerts module */
(function(){
  "use strict";
  const KEY="okx_alerts_v1";
  const defaults={volume:true,volumePeriod:20,volumeMult:2,rsi:true,rsiPeriod:14,rsiLow:30,rsiHigh:70,sma:true,smaPeriod:21,smaTolerance:.15,sound:true,volumeLevel:.65,cooldown:30};
  let cfg=Object.assign({},defaults,(()=>{try{return JSON.parse(localStorage.getItem(KEY)||"{}")}catch{return{}}})());
  let audioCtx=null,lastClosedTs=0,lastPair="",lastTf="",lastTouch=false,lastAlertAt={};
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
      const now=audioCtx.currentTime;
      const map={volume:[520,.13],rsi:[740,.16],sma:[390,.12],test:[660,.18]};
      const [freq,dur]=map[kind]||map.test;
      const o=audioCtx.createOscillator(),g=audioCtx.createGain();
      o.type=kind==="sma"?"sine":"triangle";o.frequency.value=freq;
      g.gain.setValueAtTime(0.0001,now);
      g.gain.exponentialRampToValueAtTime(Math.max(.02,cfg.volumeLevel*.12),now+.015);
      g.gain.exponentialRampToValueAtTime(.0001,now+dur);
      o.connect(g);g.connect(audioCtx.destination);o.start(now);o.stop(now+dur+.02);
      if(kind==="volume"){const o2=audioCtx.createOscillator();const g2=audioCtx.createGain();o2.frequency.value=780;o2.type="triangle";g2.gain.setValueAtTime(.0001,now+.14);g2.gain.exponentialRampToValueAtTime(Math.max(.02,cfg.volumeLevel*.1),now+.16);g2.gain.exponentialRampToValueAtTime(.0001,now+.29);o2.connect(g2);g2.connect(audioCtx.destination);o2.start(now+.14);o2.stop(now+.31)}
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
  function log(kind,text){
    const box=$("alertsLog");if(!box)return;
    const row=document.createElement("div");row.className="alertlogrow";
    row.innerHTML='<span class="alertdot '+kind+'"></span><span>'+esc(new Date().toLocaleTimeString("ru-RU"))+'</span><b>'+esc(text)+'</b>';
    box.prepend(row);while(box.children.length>8)box.lastElementChild.remove();
  }
  function fire(kind,text,key){
    if(!canAlert(key))return;
    log(kind,text);tone(kind);
    const badge=$("alertsLast");if(badge){badge.textContent=text;badge.className="alerts-last "+kind}
  }
  function evaluate(s){
    const a=s.candles||[], live=s.liveCandle, pair=s.currentPair||"",tf=s.tf||"";
    if(pair!==lastPair||tf!==lastTf){lastPair=pair;lastTf=tf;lastClosedTs=0;lastTouch=false}
    if(a.length<5)return;
    const closed=a[a.length-1];
    if(closed&&closed.ts!==lastClosedTs){
      lastClosedTs=closed.ts;
      if(cfg.volume&&a.length>=Math.max(3,+cfg.volumePeriod||20)+1){
        const n=Math.max(2,+cfg.volumePeriod||20),base=a.slice(0,-1).slice(-n),avg=base.reduce((z,x)=>z+(Number(x.v)||0),0)/base.length,v=Number(closed.v)||0,m=avg>0?v/avg:0;
        if(m>=Math.max(1,+cfg.volumeMult||2))fire("volume","Volume ×"+m.toFixed(1)+" • "+pair,"volume");
      }
      if(cfg.rsi){
        const rv=rsi(a,Math.max(2,+cfg.rsiPeriod||14));
        const prev=rsi(a.slice(0,-1),Math.max(2,+cfg.rsiPeriod||14));
        if(rv!=null&&prev!=null){
          if(prev>=cfg.rsiLow&&rv<cfg.rsiLow)fire("rsi","RSI ниже "+cfg.rsiLow+" • "+rv.toFixed(1),"rsi-low");
          if(prev<=cfg.rsiHigh&&rv>cfg.rsiHigh)fire("rsi","RSI выше "+cfg.rsiHigh+" • "+rv.toFixed(1),"rsi-high");
        }
      }
    }
    if(cfg.sma&&live){
      const n=Math.max(2,+cfg.smaPeriod||21),m=sma(a,n);
      const price=Number(live.c)||0,high=Number(live.h)||price,low=Number(live.l)||price;
      if(m&&price){
        const tol=Math.max(0,+cfg.smaTolerance||0)/100,near=Math.abs(price-m)/m<=tol,wick=low<=m*(1+tol)&&high>=m*(1-tol);
        const touched=near||wick;
        if(touched&&!lastTouch)fire("sma","SMA"+n+" touch • "+pair,"sma");
        lastTouch=touched;
      }
    }
    updateStats(s,a);
  }
  function updateStats(s,a){
    const m=a.length?Number(a[a.length-1].c):0,sm=cfg.sma?sma(a,Math.max(2,+cfg.smaPeriod||21)):null,rv=cfg.rsi?rsi(a,Math.max(2,+cfg.rsiPeriod||14)):null;
    if($("alertsSmaValue"))$("alertsSmaValue").textContent=sm?sm.toFixed(2):"—";
    if($("alertsRsiValue"))$("alertsRsiValue").textContent=rv!=null?rv.toFixed(1):"—";
    if($("alertsPriceValue"))$("alertsPriceValue").textContent=m?m.toFixed(2):"—";
  }
  function build(){
    if(document.getElementById("alertsPanel"))return;
    const aside=document.querySelector(".grid aside");
    if(!aside)return;
    const p=document.createElement("div");p.id="alertsPanel";p.className="panel";p.style.marginTop="12px";
    p.innerHTML='<h2>🔔 Alerts</h2>'+
      '<div class="alerts-note">Независимый модуль Volume + RSI + SMA Touch. Сигналы работают по текущему выбранному инструменту и таймфрейму.</div>'+
      '<div class="alerts-section"><label class="alerts-check"><input id="alertVolume" type="checkbox"><span>Volume Spike</span></label><div class="alerts-grid"><label>Период<input id="alertVolPeriod" type="number" min="2" value="'+cfg.volumePeriod+'"></label><label>Порог ×<input id="alertVolMult" type="number" min="1" step=".1" value="'+cfg.volumeMult+'"></label></div></div>'+
      '<div class="alerts-section"><label class="alerts-check"><input id="alertRsi" type="checkbox"><span>RSI</span></label><div class="alerts-grid"><label>Период<input id="alertRsiPeriod" type="number" min="2" value="'+cfg.rsiPeriod+'"></label><label>Зоны<input id="alertRsiLow" type="number" min="1" max="49" value="'+cfg.rsiLow+'"> / <input id="alertRsiHigh" type="number" min="51" max="99" value="'+cfg.rsiHigh+'"></label></div></div>'+
      '<div class="alerts-section"><label class="alerts-check"><input id="alertSma" type="checkbox"><span>SMA Touch</span></label><div class="alerts-grid"><label>Период<input id="alertSmaPeriod" type="number" min="2" value="'+cfg.smaPeriod+'"></label><label>Допуск %<input id="alertSmaTol" type="number" min="0" step=".05" value="'+cfg.smaTolerance+'"></label></div></div>'+
      '<div class="alerts-section"><div class="alerts-grid"><label>Громкость<input id="alertVolumeLevel" type="range" min="0" max="1" step=".05" value="'+cfg.volumeLevel+'"></label><label>Антиспам, сек<input id="alertCooldown" type="number" min="1" value="'+cfg.cooldown+'"></label></div><div class="alerts-actions"><button id="alertsSound" class="primary">🔊 Включить звук</button><button id="alertsTest">TEST SOUND</button></div></div>'+
      '<div class="alerts-stats"><div><small>Price</small><b id="alertsPriceValue">—</b></div><div><small>SMA</small><b id="alertsSmaValue">—</b></div><div><small>RSI</small><b id="alertsRsiValue">—</b></div></div>'+
      '<div id="alertsLast" class="alerts-last">Ожидание сигнала…</div><div id="alertsLog" class="alerts-log"></div>';
    aside.appendChild(p);
    ["alertVolume","alertRsi","alertSma"].forEach((id,i)=>{const el=$(id);el.checked=[cfg.volume,cfg.rsi,cfg.sma][i];el.onchange=()=>{if(i===0)cfg.volume=el.checked;if(i===1)cfg.rsi=el.checked;if(i===2)cfg.sma=el.checked;save()}});
    const bind=(id,key,parse)=>{const el=$(id);el.onchange=()=>{cfg[key]=parse(el.value);save()}};
    bind("alertVolPeriod","volumePeriod",v=>Math.max(2,+v||20));bind("alertVolMult","volumeMult",v=>Math.max(1,+v||2));bind("alertRsiPeriod","rsiPeriod",v=>Math.max(2,+v||14));bind("alertRsiLow","rsiLow",v=>Math.min(49,Math.max(1,+v||30)));bind("alertRsiHigh","rsiHigh",v=>Math.min(99,Math.max(51,+v||70)));bind("alertSmaPeriod","smaPeriod",v=>Math.max(2,+v||21));bind("alertSmaTol","smaTolerance",v=>Math.max(0,+v||0));bind("alertVolumeLevel","volumeLevel",v=>Math.min(1,Math.max(0,+v||0)));bind("alertCooldown","cooldown",v=>Math.max(1,+v||30));
    $("alertsSound").onclick=async()=>{try{await ensureAudio();cfg.sound=true;save();tone("test");$("alertsSound").textContent="🔊 Звук включён";log("sma","Звук включён")}catch{$("alertsSound").textContent="⚠️ Звук недоступен"}};
    $("alertsTest").onclick=async()=>{try{await ensureAudio();tone("test")}catch{}};
  }
  function injectCss(){
    if(document.getElementById("alertsCss"))return;
    const st=document.createElement("style");st.id="alertsCss";st.textContent='.alerts-note{color:var(--m);font-size:10px;line-height:1.35;margin:-2px 0 9px}.alerts-section{padding:8px 0;border-top:1px solid #1a2530}.alerts-check{display:flex;gap:7px;align-items:center;font-weight:700;font-size:12px}.alerts-check input{width:auto}.alerts-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:7px}.alerts-grid label{color:var(--m);font-size:10px}.alerts-grid input{width:100%;margin-top:3px;padding:7px}.alerts-grid input[type=range]{padding:0}.alerts-actions{display:flex;gap:7px;margin-top:8px}.alerts-actions button{flex:1;padding:8px;font-size:11px}.alerts-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:8px}.alerts-stats>div{background:var(--p2);border:1px solid #17212d;border-radius:8px;padding:7px}.alerts-stats small{display:block;color:var(--m);font-size:9px}.alerts-stats b{display:block;margin-top:2px;font-size:11px}.alerts-last{margin-top:8px;padding:8px;border-radius:8px;background:#111923;color:var(--m);font-size:10px}.alerts-last.volume{color:var(--y);border:1px solid #4b3e15}.alerts-last.rsi{color:#55a8ff;border:1px solid #25496c}.alerts-last.sma{color:var(--g);border:1px solid #205f45}.alerts-log{margin-top:6px;max-height:150px;overflow:auto}.alertlogrow{display:grid;grid-template-columns:8px 55px 1fr;gap:6px;align-items:center;padding:4px 0;border-bottom:1px solid #17212d;font-size:9px}.alertlogrow b{font-size:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.alertdot{width:7px;height:7px;border-radius:50%;background:#8290a0}.alertdot.volume{background:#ffd166}.alertdot.rsi{background:#55a8ff}.alertdot.sma{background:#27e58a}@media(max-width:900px){.alerts-grid{grid-template-columns:1fr 1fr}}';
    document.head.appendChild(st);
  }
  injectCss();build();
  setInterval(()=>{try{const s=app();if(s)evaluate(s)}catch(e){console.warn("Alerts",e)}},500);
  window.OKXAlerts={test:()=>tone("test"),getConfig:()=>Object.assign({},cfg)};
})();