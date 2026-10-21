/* Independent Telegram rules UI for OKX Signal Pro. API token is intentionally not persisted. */
(function(){
  "use strict";
  const $=id=>document.getElementById(id);
  const endpointKey="okx_telegram_config_endpoint_v1";
  const tfOptions=["1m","3m","5m","15m","30m","1h","2h","4h","6h","12h","1d","1w"];
  let rules=[];
  let serverRules=null;
  function endpoint(){return String($("tgConfigEndpoint").value||"").trim().replace(/\/+$/,"");}
  function setStatus(message,kind="info"){const el=$("tgConfigStatus");if(!el)return;el.textContent=message;el.className="tg-config-status "+kind;}
  function make(tag,attrs={},text){const el=document.createElement(tag);Object.entries(attrs).forEach(([k,v])=>{if(k==="class")el.className=v;else if(k==="type"||k==="placeholder"||k==="aria-label"||k==="list"||k==="value")el.setAttribute(k,v);else el[k]=v});if(text!=null)el.textContent=text;return el;}
  function normalizeRule(r){return {pair:String(r.pair||"BTC-USDT-SWAP").trim().toUpperCase(),tf:String(r.tf||"15m").trim().toLowerCase(),telegram:r.telegram!==false,volume:r.volume===true,rsi:r.rsi===true,sma:r.sma===true,combo:r.combo===true};}
  function renderSavedRules(){
    const root=$("tgSavedRulesList"),meta=$("tgSavedRulesMeta");
    if(!root||!meta)return;
    root.replaceChildren();
    if(serverRules===null){
      meta.textContent="Не загружено";
      root.append(make("div",{class:"tg-saved-empty"},"Нажми «Загрузить», чтобы увидеть пары и таймфреймы, сохранённые на сервере."));
      return;
    }
    const saved=serverRules.map(normalizeRule);
    if(!saved.length){
      meta.textContent="0 правил";
      root.append(make("div",{class:"tg-saved-empty"},"На сервере пока нет сохранённых правил уведомлений."));
      return;
    }
    const grouped=new Map();
    saved.forEach(rule=>{
      if(!grouped.has(rule.pair))grouped.set(rule.pair,[]);
      grouped.get(rule.pair).push(rule);
    });
    meta.textContent=saved.length+" правил · "+grouped.size+" пар";
    [...grouped.entries()].sort(([a],[b])=>a.localeCompare(b)).forEach(([pair,pairRules])=>{
      const card=make("div",{class:"tg-saved-pair"});
      card.append(make("div",{class:"tg-saved-pair-name"},pair));
      const timeframes=make("div",{class:"tg-saved-timeframes"});
      pairRules.sort((a,b)=>{
        const ai=tfOptions.indexOf(a.tf),bi=tfOptions.indexOf(b.tf);
        return (ai<0?999:ai)-(bi<0?999:bi);
      }).forEach(rule=>{
        const item=make("div",{class:"tg-saved-rule"+(rule.telegram?"":" is-off")});
        item.append(make("span",{class:"tg-saved-tf"},rule.tf));
        const enabled=[];
        if(rule.volume)enabled.push("Объём");
        if(rule.rsi)enabled.push("RSI");
        if(rule.sma)enabled.push("SMA");
        if(rule.combo)enabled.push("COMBO");
        const state=rule.telegram?"TG включён":"TG выключен";
        const channels=enabled.length?enabled.join(" · "):"источники не выбраны";
        item.append(make("span",{class:"tg-saved-rule-info"},state+" · "+channels));
        item.title=pair+" · "+rule.tf+" · "+state+" · "+channels;
        timeframes.append(item);
      });
      card.append(timeframes);
      root.append(card);
    });
  }
  function render(){
    const root=$("tgRulesRows");root.replaceChildren();
    rules.forEach((raw,index)=>{
      const rule=normalizeRule(raw),tr=make("tr");
      const pairCell=make("td"),pair=make("input",{type:"text",value:rule.pair,list:"tgPairOptions","aria-label":"Пара"});pair.addEventListener("change",()=>{rules[index].pair=pair.value.trim().toUpperCase()});pairCell.append(pair);tr.append(pairCell);
      const tfCell=make("td"),tf=make("select",{"aria-label":"Таймфрейм"});
      tfOptions.forEach(v=>tf.append(make("option",{value:v},v)));tf.value=rule.tf;
      tf.addEventListener("change",()=>{rules[index].tf=tf.value});tfCell.append(tf);tr.append(tfCell);
      [["telegram","TG"],["volume","VOL"],["rsi","RSI"],["sma","SMA"],["combo","COMBO"]].forEach(([key,label])=>{
        const td=make("td"),wrap=make("label",{class:"tg-check"}),cb=make("input",{type:"checkbox","aria-label":label});cb.checked=rule[key];cb.addEventListener("change",()=>{rules[index][key]=cb.checked});wrap.append(cb,document.createTextNode(label));td.append(wrap);tr.append(td);
      });
      const delCell=make("td"),del=make("button",{type:"button",class:"tg-delete"},"Удалить");del.addEventListener("click",()=>{rules.splice(index,1);render()});delCell.append(del);tr.append(delCell);root.append(tr);
    });
    $("tgRulesCount").textContent=rules.length+" / 100 правил";
  }
  function fillPairOptions(){
    const list=$("tgPairOptions");if(!list)return;
    const api=window.OKXSignalApp;
    const markets=api&&typeof api.getAllMarkets==="function"?api.getAllMarkets():(api&&api.getMarkets?api.getMarkets():[]);
    if(!Array.isArray(markets)||!markets.length)return;
    list.replaceChildren();
    markets.forEach(m=>{if(!m||!m.instId)return;list.append(make("option",{value:m.instId}))});
  }
  async function readConfig(){
    if(!endpoint()){setStatus("Укажи адрес Telegram worker в Railway.","warn");return}
    serverRules=null;renderSavedRules();
    setStatus("Загружаем серверные настройки…");
    try{
      const r=await fetch(endpoint()+"/config",{cache:"no-store"});
      if(!r.ok)throw Error("HTTP "+r.status);
      const data=await r.json();if(!Array.isArray(data.rules))throw Error("Сервер вернул неверный формат");
      rules=data.rules.map(normalizeRule);serverRules=rules.map(normalizeRule);render();renderSavedRules();setStatus("Загружено с сервера: "+rules.length+" правил.","ok");
    }catch(e){serverRules=null;renderSavedRules();setStatus("Не удалось загрузить настройки: "+(e.message||e)+". Проверь адрес, CORS и доступность сервера.","error")}
  }
  async function saveConfig(){
    if(!endpoint()){setStatus("Укажи адрес Telegram worker в Railway.","warn");return}
    const token=$("tgConfigToken").value.trim();
    if(!token){setStatus("Введи CONFIG_API_TOKEN из Railway. Ключ не сохраняется в браузере.","warn");return}
    const normalized=rules.map(normalizeRule);
    if(!normalized.length){setStatus("Добавь хотя бы одно правило.","warn");return}
    if(normalized.length>100||new Set(normalized.map(r=>r.pair)).size>20){setStatus("Лимит: 20 разных пар и 100 правил.","error");return}
    if(normalized.some(r=>!r.pair||!/^([A-Z0-9]+)-USDT-SWAP$/.test(r.pair))){setStatus("Пара должна быть в формате BTC-USDT-SWAP.","error");return}
    const keys=normalized.map(r=>r.pair+":"+r.tf);if(new Set(keys).size!==keys.length){setStatus("Удали дубли одной пары и таймфрейма.","error");return}
    setStatus("Сохраняем правила на сервере…");
    try{
      const r=await fetch(endpoint()+"/config",{method:"PUT",headers:{"content-type":"application/json","authorization":"Bearer "+token},body:JSON.stringify({rules:normalized})});
      const data=await r.json().catch(()=>({}));
      if(!r.ok)throw Error(data.error||("HTTP "+r.status));
      rules=normalized;serverRules=normalized.map(normalizeRule);render();renderSavedRules();setStatus("Сохранено на сервере: "+data.count+" правил, "+data.pairs+" пар. Изменения вступили в силу без перезапуска.","ok");
      $("tgConfigToken").value="";
    }catch(e){setStatus("Не удалось сохранить: "+(e.message||e)+". Проверь CONFIG_API_TOKEN и CORS.","error")}
  }
  async function testTelegram(){
    if(!endpoint()){setStatus("Укажи адрес Telegram worker в Railway.","warn");return}
    const token=$("tgConfigToken").value.trim();
    if(!token){setStatus("Введи CONFIG_API_TOKEN из Railway. Ключ не сохраняется в браузере.","warn");return}
    const button=$("tgConfigTest"),label=button.textContent;
    button.disabled=true;button.textContent="Отправляем…";
    setStatus("Отправляем контрольное сообщение в Telegram…");
    try{
      const r=await fetch(endpoint()+"/test-telegram",{method:"POST",headers:{"authorization":"Bearer "+token}});
      const data=await r.json().catch(()=>({}));
      if(!r.ok||data.ok!==true)throw Error(data.error||("HTTP "+r.status));
      setStatus("Тестовое сообщение отправлено. Проверь чат с ботом в Telegram.","ok");
    }catch(e){
      setStatus("Не удалось отправить тест: "+(e.message||e)+". Проверь CONFIG_API_TOKEN и настройки Telegram.","error");
    }finally{
      $("tgConfigToken").value="";
      button.disabled=false;button.textContent=label;
    }
  }
  function addRule(){
    if(rules.length>=100){setStatus("Достигнут лимит 100 правил.","warn");return}
    const api=window.OKXSignalApp,markets=api&&typeof api.getAllMarkets==="function"?api.getAllMarkets():(api&&api.getMarkets?api.getMarkets():[]);
    const pair=markets?.[0]?.instId||"BTC-USDT-SWAP";
    rules.push({pair,tf:"15m",telegram:true,volume:true,rsi:true,sma:false,combo:true});render();
  }
  function init(){
    const saved=localStorage.getItem(endpointKey)||"";
    $("tgConfigEndpoint").value=saved;
    $("tgConfigEndpoint").addEventListener("change",()=>{localStorage.setItem(endpointKey,endpoint());serverRules=null;renderSavedRules();});
    $("tgConfigLoad").addEventListener("click",readConfig);
    $("tgConfigSave").addEventListener("click",saveConfig);
    $("tgConfigAdd").addEventListener("click",addRule);
    $("tgConfigTest").addEventListener("click",testTelegram);
    fillPairOptions();render();renderSavedRules();
    window.addEventListener("okx-markets-loaded",fillPairOptions);
    // The public OKX markets arrive asynchronously. Retry while waiting, and
    // refresh once the main app announces that its complete market list is ready.
    let attempts=0;
    const retryPairOptions=()=>{
      fillPairOptions();
      const list=$("tgPairOptions");
      if((!list||!list.options.length)&&attempts++<30)setTimeout(retryPairOptions,500);
    };
    retryPairOptions();
    if(saved.trim())readConfig();
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});else init();
})();