/* OKX Signal Pro — configurable Elder Force Index and Larry Williams A/D */
(function () {
  "use strict";
  const KEY = "okx_v2_custom_indicators";
  const defaults = {
    forceEnabled: false, forcePeriod: 13,
    forcePositive: "#27e58a", forceNegative: "#ff5f68",
    williamsEnabled: false, williamsColor: "#55a8ff"
  };
  const $ = (id) => document.getElementById(id);
  const validColor = (v, fallback) => /^#[0-9a-f]{6}$/i.test(String(v || "")) ? v : fallback;
  function readConfig() {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (_) {}
    const cfg = Object.assign({}, defaults, stored);
    cfg.forceEnabled = !!cfg.forceEnabled;
    cfg.williamsEnabled = !!cfg.williamsEnabled;
    cfg.forcePeriod = Math.max(2, Math.min(200, Math.round(Number(cfg.forcePeriod) || 13)));
    cfg.forcePositive = validColor(cfg.forcePositive, defaults.forcePositive);
    cfg.forceNegative = validColor(cfg.forceNegative, defaults.forceNegative);
    cfg.williamsColor = validColor(cfg.williamsColor, defaults.williamsColor);
    return cfg;
  }
  let cfg = readConfig();
  let root = null;
  function injectCss() {
    if ($("customIndicatorsCss")) return;
    const style = document.createElement("style");
    style.id = "customIndicatorsCss";
    style.textContent = [
      "#customIndicatorsPanel{margin-top:12px;background:#0b1118;border:1px solid #1d2835;border-radius:12px;padding:11px}",
      ".ci-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:9px}",
      ".ci-head h2{margin:0}.ci-hint{color:#8290a0;font-size:10px}",
      ".ci-controls{display:grid;grid-template-columns:minmax(150px,1.6fr) repeat(3,minmax(78px,1fr));gap:7px;align-items:end}",
      ".ci-control{display:block;color:#8290a0;font-size:10px;min-width:0}",
      ".ci-control input[type=number],.ci-control input[type=color]{display:block;width:100%;min-width:0;margin-top:4px;padding:6px;height:32px}",
      ".ci-control input[type=color]{padding:2px}.ci-check{display:flex;align-items:center;gap:7px;min-height:32px;color:#eaf0f6;font-size:11px;font-weight:700}",
      ".ci-check input{width:auto}.ci-pane{margin-top:9px;padding:8px;background:#090e14;border:1px solid #17212d;border-radius:9px}",
      ".ci-pane[hidden]{display:none!important}.ci-pane-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:5px;font-size:11px}",
      ".ci-value{color:#a6b2c0;font-variant-numeric:tabular-nums}.ci-canvas{display:block;width:100%;height:128px;border-radius:7px}",
      "@media(max-width:700px){.ci-controls{grid-template-columns:1fr 1fr}.ci-check{grid-column:1/-1}}"
    ].join("");
    document.head.appendChild(style);
  }
  function mount() {
    const panel = $("chartPanel");
    if (!panel || $("customIndicatorsPanel")) return;
    injectCss();
    root = document.createElement("section");
    root.id = "customIndicatorsPanel";
    root.innerHTML =
      '<div class="ci-head"><h2>Дополнительные индикаторы</h2><span class="ci-hint">Выбранный таймфрейм · настройки сохраняются</span></div>' +
      '<div class="ci-controls">' +
        '<label class="ci-check"><input id="ciForceEnabled" type="checkbox"> Индекс силы Элдера (Force Index)</label>' +
        '<label class="ci-control">Сглаживание EMA<input id="ciForcePeriod" type="number" min="2" max="200" value="13"></label>' +
        '<label class="ci-control">Цвет роста<input id="ciForcePositive" type="color" value="#27e58a"></label>' +
        '<label class="ci-control">Цвет падения<input id="ciForceNegative" type="color" value="#ff5f68"></label>' +
        '<label class="ci-check"><input id="ciWilliamsEnabled" type="checkbox"> Накопление/распределение Ларри Вильямса (Williams A/D)</label>' +
        '<label class="ci-control">Цвет линии<input id="ciWilliamsColor" type="color" value="#55a8ff"></label>' +
      '</div>' +
      '<section id="ciForcePane" class="ci-pane" hidden><div class="ci-pane-head"><b id="ciForceTitle">Force Index · EMA(13)</b><span id="ciForceValue" class="ci-value">—</span></div><canvas id="ciForceCanvas" class="ci-canvas" aria-label="График индекса силы Элдера"></canvas></section>' +
      '<section id="ciWilliamsPane" class="ci-pane" hidden><div class="ci-pane-head"><b>Williams Accumulation/Distribution</b><span id="ciWilliamsValue" class="ci-value">—</span></div><canvas id="ciWilliamsCanvas" class="ci-canvas" aria-label="График накопления и распределения Ларри Вильямса"></canvas></section>';
    panel.appendChild(root);
    $("ciForceEnabled").onchange = () => { cfg.forceEnabled = $("ciForceEnabled").checked; save(); };
    $("ciForcePeriod").onchange = () => { cfg.forcePeriod = Math.max(2, Math.min(200, Math.round(Number($("ciForcePeriod").value) || 13))); save(); };
    $("ciForcePositive").onchange = () => { cfg.forcePositive = validColor($("ciForcePositive").value, defaults.forcePositive); save(); };
    $("ciForceNegative").onchange = () => { cfg.forceNegative = validColor($("ciForceNegative").value, defaults.forceNegative); save(); };
    $("ciWilliamsEnabled").onchange = () => { cfg.williamsEnabled = $("ciWilliamsEnabled").checked; save(); };
    $("ciWilliamsColor").onchange = () => { cfg.williamsColor = validColor($("ciWilliamsColor").value, defaults.williamsColor); save(); };
    syncControls();
    render();
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (_) {}
    syncControls();
    render();
  }
  function syncControls() {
    if (!root) return;
    $("ciForceEnabled").checked = cfg.forceEnabled;
    $("ciForcePeriod").value = String(cfg.forcePeriod);
    $("ciForcePositive").value = cfg.forcePositive;
    $("ciForceNegative").value = cfg.forceNegative;
    $("ciWilliamsEnabled").checked = cfg.williamsEnabled;
    $("ciWilliamsColor").value = cfg.williamsColor;
    $("ciForcePane").hidden = !cfg.forceEnabled;
    $("ciWilliamsPane").hidden = !cfg.williamsEnabled;
    $("ciForceTitle").textContent = "Force Index · EMA(" + cfg.forcePeriod + ")";
  }
  function currentView(state, bars) {
    const cs = window.chartState || {};
    const visible = Math.max(25, Math.min(bars.length, Math.floor(Number(cs.visible) || 80)));
    const rawEnd = Number(cs.end);
    const viewEnd = Math.max(visible, Math.min(bars.length + Math.floor(visible * .8), Number.isFinite(rawEnd) ? rawEnd : bars.length));
    const pad = Math.max(0, viewEnd - state.candles.length);
    const dataVisible = Math.max(1, visible - pad);
    const dataEnd = pad ? bars.length : viewEnd;
    const begin = Math.max(0, dataEnd - dataVisible);
    return { visible, begin, dataEnd };
  }
  function forceIndex(bars, period) {
    const raw = new Array(bars.length).fill(NaN);
    for (let i = 1; i < bars.length; i++) {
      const value = (Number(bars[i].c) - Number(bars[i - 1].c)) * (Number(bars[i].v) || 0);
      if (Number.isFinite(value)) raw[i] = value;
    }
    const out = new Array(bars.length).fill(NaN), alpha = 2 / (period + 1);
    let sum = 0, count = 0, ema = NaN;
    for (let i = 0; i < raw.length; i++) {
      if (!Number.isFinite(raw[i])) continue;
      if (!Number.isFinite(ema)) {
        sum += raw[i]; count++;
        if (count >= period) { ema = sum / period; out[i] = ema; }
      } else {
        ema = alpha * raw[i] + (1 - alpha) * ema;
        out[i] = ema;
      }
    }
    return out;
  }
  function williamsAD(bars) {
    const out = new Array(bars.length).fill(NaN);
    let cumulative = 0;
    for (let i = 0; i < bars.length; i++) {
      if (i === 0) { out[i] = cumulative; continue; }
      const previousClose = Number(bars[i - 1].c), close = Number(bars[i].c);
      const trueHigh = Math.max(Number(bars[i].h), previousClose);
      const trueLow = Math.min(Number(bars[i].l), previousClose);
      if (close > previousClose) cumulative += close - trueLow;
      else if (close < previousClose) cumulative += close - trueHigh;
      out[i] = cumulative;
    }
    return out;
  }
  function formatValue(value) {
    if (!Number.isFinite(value)) return "—";
    const abs = Math.abs(value);
    return abs >= 1e6 ? value.toExponential(2) : value.toLocaleString("en-US", { maximumFractionDigits: abs >= 1000 ? 1 : 3 });
  }
  function prepareCanvas(canvas) {
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return null;
    const dpr = Math.max(1, Number(window.devicePixelRatio) || 1);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.fillStyle = "#090e14";
    ctx.fillRect(0, 0, rect.width, rect.height);
    return { ctx, W: rect.width, H: rect.height };
  }
  function drawForce(bars, visible, begin, dataEnd) {
    const prepared = prepareCanvas($("ciForceCanvas"));
    if (!prepared) return;
    const { ctx: q, W, H } = prepared, left = 58, right = 14, top = 12, bottom = 16;
    const vals = forceIndex(bars, cfg.forcePeriod);
    const shown = vals.slice(begin, dataEnd).filter(Number.isFinite);
    if (!shown.length) { $("ciForceValue").textContent = "Собираются данные…"; return; }
    const maxAbs = Math.max(1, ...shown.map(x => Math.abs(x)));
    const zero = (top + H - bottom) / 2, half = Math.max(1, (H - top - bottom) / 2 - 2);
    const slot = (W - left - right) / visible, barW = Math.max(1, Math.min(8, slot * .62));
    q.strokeStyle = "#263545"; q.lineWidth = 1;
    q.beginPath(); q.moveTo(left, zero); q.lineTo(W - right, zero); q.stroke();
    q.fillStyle = "#687788"; q.font = "9px system-ui"; q.fillText("0", 5, zero + 3);
    for (let i = begin; i < dataEnd; i++) {
      const value = vals[i];
      if (!Number.isFinite(value)) continue;
      const x = left + (i - begin + .5) * slot, height = Math.max(1, Math.abs(value) / maxAbs * half);
      q.fillStyle = value >= 0 ? cfg.forcePositive : cfg.forceNegative;
      q.globalAlpha = .86;
      q.fillRect(x - barW / 2, value >= 0 ? zero - height : zero, barW, height);
    }
    q.globalAlpha = 1;
    $("ciForceValue").textContent = formatValue(shown[shown.length - 1]);
  }
  function drawWilliams(bars, visible, begin, dataEnd) {
    const prepared = prepareCanvas($("ciWilliamsCanvas"));
    if (!prepared) return;
    const { ctx: q, W, H } = prepared, left = 58, right = 14, top = 12, bottom = 18;
    const values = williamsAD(bars), shown = values.slice(begin, dataEnd).filter(Number.isFinite);
    if (!shown.length) return;
    let lo = Math.min(...shown), hi = Math.max(...shown);
    if (hi === lo) { const pad = Math.max(1, Math.abs(hi) * .02); lo -= pad; hi += pad; }
    const plotH = H - top - bottom, slot = (W - left - right) / visible;
    q.strokeStyle = "#17212d"; q.lineWidth = 1; q.font = "9px system-ui"; q.fillStyle = "#687788";
    for (let k = 0; k < 4; k++) {
      const y = top + k * plotH / 3;
      q.beginPath(); q.moveTo(left, y); q.lineTo(W - right, y); q.stroke();
      q.fillText(formatValue(hi - (hi - lo) * k / 3), 4, y + 3);
    }
    const Y = value => top + (hi - value) / (hi - lo) * plotH;
    q.strokeStyle = cfg.williamsColor; q.lineWidth = 1.8; q.beginPath();
    let started = false;
    for (let i = begin; i < dataEnd; i++) {
      const value = values[i];
      if (!Number.isFinite(value)) continue;
      const x = left + (i - begin + .5) * slot, y = Y(value);
      if (started) q.lineTo(x, y); else { q.moveTo(x, y); started = true; }
    }
    q.stroke();
    $("ciWilliamsValue").textContent = formatValue(shown[shown.length - 1]);
  }
  function render() {
    if (!root || (!cfg.forceEnabled && !cfg.williamsEnabled)) return;
    const app = window.OKXSignalApp;
    const state = app && app.getState ? app.getState() : null;
    if (!state || !Array.isArray(state.candles) || state.candles.length < 3) return;
    const bars = state.candles.slice();
    if (state.liveCandle && Number(state.liveCandle.ts) !== Number(bars[bars.length - 1].ts)) bars.push(state.liveCandle);
    const view = currentView(state, bars);
    if (cfg.forceEnabled) drawForce(bars, view.visible, view.begin, view.dataEnd);
    if (cfg.williamsEnabled) drawWilliams(bars, view.visible, view.begin, view.dataEnd);
  }
  function start() {
    mount();
    if (!root) return;
    if (window.ResizeObserver) {
      const observer = new ResizeObserver(render);
      observer.observe(root);
    } else window.addEventListener("resize", render);
    // Also refresh after websocket updates and when a pair or timeframe changes.
    window.setInterval(render, 1000);
    window.OKXCustomIndicators = { render, getValues: (bars) => ({ force: forceIndex(bars, cfg.forcePeriod), williamsAD: williamsAD(bars) }) };
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();