/* OKX Signal Pro — configurable EMA overlays on the main price chart */
(function () {
  "use strict";
  const KEY = "okx_v2_chart_ema_settings";
  const DEFAULTS = [{ id: "ema-1", enabled: true, period: 20, color: "#b58cff" }];
  const $ = (id) => document.getElementById(id);
  const validColor = (value, fallback) => /^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : fallback;
  const clone = (items) => items.map((item) => ({ ...item }));
  function readSettings() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || "null");
      if (Array.isArray(raw)) {
        return raw.filter((x) => x && typeof x === "object").map((x, i) => ({
          id: String(x.id || ("ema-" + (i + 1))),
          enabled: x.enabled !== false,
          period: Math.max(2, Math.min(500, Math.round(Number(x.period) || 20))),
          color: validColor(x.color, DEFAULTS[0].color)
        }));
      }
    } catch (_) {}
    return clone(DEFAULTS);
  }
  let settings = readSettings();
  let draft = null;
  let baseDraw = null;
  let root = null;

  function injectCss() {
    if ($("chartEmaCss")) return;
    const style = document.createElement("style");
    style.id = "chartEmaCss";
    style.textContent = [
      ".ema-settings-overlay{position:fixed;inset:0;z-index:130;display:flex;align-items:center;justify-content:center;padding:14px;background:rgba(0,0,0,.72)}",
      ".ema-settings-overlay[hidden]{display:none!important}.ema-settings-dialog{width:min(560px,100%);max-height:min(82vh,760px);overflow:auto;padding:15px;background:#0e141c;border:1px solid #304255;border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.5)}",
      ".ema-settings-dialog h2{margin:0 0 7px;font-size:16px}.ema-settings-dialog p{margin:0 0 12px;color:#8290a0;font-size:11px;line-height:1.45}",
      ".ema-setting-row{display:grid;grid-template-columns: minmax(0,1fr) 92px 74px 34px;gap:8px;align-items:end;padding:9px 0;border-top:1px solid #1a2530}",
      ".ema-setting-row label{display:block;color:#8290a0;font-size:10px}.ema-setting-row input[type=number]{width:100%;min-width:0;margin-top:4px;padding:7px}.ema-setting-row input[type=color]{width:100%;height:34px;margin-top:4px;padding:2px}",
      ".ema-setting-row .ema-enabled{display:flex;align-items:center;gap:6px;min-height:34px;color:#eaf0f6;font-size:12px}.ema-setting-row .ema-enabled input{width:auto}",
      ".ema-remove{height:34px;padding:4px;color:#ff8c92}.ema-settings-actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end;margin-top:13px}.ema-settings-actions button{padding:8px 10px}",
      ".ema-legend{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:5px 10px;background:#090e14;border:1px solid #17212d;border-top:0;border-bottom:0;min-height:26px}",
      ".ema-legend-item{display:inline-flex;align-items:center;gap:5px;color:#a6b2c0;font-size:10px}.ema-legend-swatch{width:13px;height:3px;border-radius:2px}",
      "@media(max-width:520px){.ema-settings-dialog{padding:11px}.ema-setting-row{grid-template-columns:minmax(0,1fr) 70px 58px 32px;gap:5px}.ema-setting-row label{font-size:9px}.ema-setting-row .ema-enabled{font-size:11px}}"
    ].join("");
    document.head.appendChild(style);
  }
  function mount() {
    const chartTools = document.querySelector("#chartPanel .charttools");
    const smaLegend = $("chartSmaLegend");
    if (!chartTools || !smaLegend || $("chartEmaTool")) return false;
    injectCss();
    const toggle = document.createElement("button");
    toggle.type = "button"; toggle.className = "toolbtn active"; toggle.id = "chartEmaTool";
    toggle.title = "Показать/скрыть линии EMA"; toggle.textContent = "EMA";
    const config = document.createElement("button");
    config.type = "button"; config.className = "toolbtn"; config.id = "chartEmaSettingsTool";
    config.title = "Настройки EMA на графике"; config.textContent = "⚙ EMA";
    const smaSettingsButton = $("smaSettingsTool");
    if (smaSettingsButton && smaSettingsButton.nextSibling) {
      chartTools.insertBefore(toggle, smaSettingsButton.nextSibling);
      chartTools.insertBefore(config, toggle.nextSibling);
    } else {
      chartTools.append(toggle, config);
    }
    const legend = document.createElement("div");
    legend.id = "chartEmaLegend"; legend.className = "ema-legend";
    legend.setAttribute("aria-label", "Линии EMA на графике");
    smaLegend.insertAdjacentElement("afterend", legend);
    const overlay = document.createElement("div");
    overlay.id = "chartEmaSettingsModal"; overlay.className = "ema-settings-overlay"; overlay.hidden = true;
    overlay.innerHTML =
      '<section class="ema-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="chartEmaTitle">' +
      '<h2 id="chartEmaTitle">EMA на графике</h2><p>Добавляй любое количество линий. Для каждой можно отдельно задать период, цвет и видимость. Настройки сохраняются на этом устройстве.</p>' +
      '<div id="chartEmaRows"></div>' +
      '<div class="ema-settings-actions"><button type="button" id="chartEmaAdd" class="primary">＋ Добавить EMA</button><button type="button" id="chartEmaCancel">Отмена</button><button type="button" id="chartEmaSave" class="primary">Сохранить</button></div>' +
      '</section>';
    document.body.appendChild(overlay);
    root = overlay;
    toggle.onclick = () => {
      const enabled = toggle.classList.toggle("active");
      toggle.setAttribute("aria-pressed", String(enabled));
      renderLegend(); redraw();
    };
    config.onclick = openSettings;
    $("chartEmaAdd").onclick = () => {
      draft.push({ id: "ema-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7), enabled: true, period: 20, color: "#55a8ff" });
      renderEditor();
    };
    $("chartEmaCancel").onclick = closeSettings;
    $("chartEmaSave").onclick = saveSettings;
    overlay.addEventListener("click", (event) => { if (event.target === overlay) closeSettings(); });
    renderLegend();
    return true;
  }
  function renderEditor() {
    const host = $("chartEmaRows");
    if (!host || !draft) return;
    host.innerHTML = "";
    draft.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "ema-setting-row";
      row.innerHTML =
        '<label class="ema-enabled"><input type="checkbox" data-field="enabled"> EMA</label>' +
        '<label>Период<input type="number" min="2" max="500" step="1" data-field="period"></label>' +
        '<label>Цвет<input type="color" data-field="color"></label>' +
        '<button type="button" class="ema-remove" title="Удалить EMA" aria-label="Удалить EMA">✕</button>';
      row.querySelector('[data-field="enabled"]').checked = item.enabled;
      row.querySelector('[data-field="period"]').value = String(item.period);
      row.querySelector('[data-field="color"]').value = item.color;
      row.querySelectorAll("[data-field]").forEach((input) => {
        input.addEventListener("change", () => {
          const field = input.dataset.field;
          item[field] = field === "enabled" ? input.checked : field === "period"
            ? Math.max(2, Math.min(500, Math.round(Number(input.value) || 20)))
            : validColor(input.value, "#55a8ff");
          if (field === "period") input.value = String(item.period);
        });
      });
      row.querySelector(".ema-remove").onclick = () => { draft.splice(index, 1); renderEditor(); };
      host.appendChild(row);
    });
    if (!draft.length) {
      const empty = document.createElement("div");
      empty.className = "small"; empty.style.padding = "12px 0";
      empty.textContent = "Линий EMA пока нет. Нажми «Добавить EMA».";
      host.appendChild(empty);
    }
  }
  function openSettings() { draft = clone(settings); renderEditor(); $("chartEmaSettingsModal").hidden = false; }
  function closeSettings() { $("chartEmaSettingsModal").hidden = true; draft = null; }
  function saveSettings() {
    settings = clone(draft || []);
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (_) {}
    closeSettings(); renderLegend(); redraw();
  }
  function renderLegend() {
    const host = $("chartEmaLegend"), toggle = $("chartEmaTool");
    if (!host || !toggle) return;
    const visible = toggle.classList.contains("active");
    host.innerHTML = "";
    settings.filter((item) => item.enabled).forEach((item) => {
      const label = document.createElement("span"); label.className = "ema-legend-item";
      const swatch = document.createElement("i"); swatch.className = "ema-legend-swatch"; swatch.style.backgroundColor = item.color;
      const name = document.createElement("span"); name.textContent = "EMA " + item.period;
      label.append(swatch, name); host.appendChild(label);
    });
    host.style.opacity = visible ? "1" : ".45";
  }
  function emaValues(series, period) {
    const values = new Array(series.length).fill(NaN), alpha = 2 / (period + 1);
    let sum = 0, count = 0, ema = NaN;
    for (let i = 0; i < series.length; i++) {
      const close = Number(series[i] && series[i].c);
      if (!Number.isFinite(close)) continue;
      if (!Number.isFinite(ema)) {
        sum += close; count++;
        if (count >= period) { ema = sum / period; values[i] = ema; }
      } else {
        ema = alpha * close + (1 - alpha) * ema;
        values[i] = ema;
      }
    }
    return values;
  }
  function drawOverlays() {
    const toggle = $("chartEmaTool"), canvas = $("chart");
    const app = window.OKXSignalApp, state = app && app.getState ? app.getState() : null;
    if (!toggle || !toggle.classList.contains("active") || !state || !Array.isArray(state.candles) || !canvas) return;
    const series = state.candles.slice();
    if (state.liveCandle && Number(state.liveCandle.ts) !== Number(series[series.length - 1]?.ts)) series.push(state.liveCandle);
    const cs = window.chartState || {};
    if (!series.length) return;
    const visible = Math.max(25, Math.min(series.length, Number(cs.visible) || 80));
    const viewEnd = Math.max(visible, Math.min(series.length + Math.floor(visible * .8), Number(cs.end) || series.length));
    const pad = Math.max(0, viewEnd - state.candles.length);
    const dataVisible = Math.max(1, visible - pad);
    const dataEnd = pad ? series.length : viewEnd;
    const begin = Math.max(0, dataEnd - dataVisible);
    const rect = canvas.getBoundingClientRect(), W = rect.width, H = rect.height;
    const left = 58, right = 14, top = 14, mainH = H - 78 - 18;
    const visibleBars = series.slice(begin, dataEnd);
    if (!visibleBars.length || W <= left + right || mainH <= 10) return;
    const lows = visibleBars.map((bar) => Number(bar.l)).filter(Number.isFinite);
    const highs = visibleBars.map((bar) => Number(bar.h)).filter(Number.isFinite);
    const min = Number.isFinite(cs.priceMin) ? cs.priceMin : Math.min(...lows);
    const max = Number.isFinite(cs.priceMax) ? cs.priceMax : Math.max(...highs);
    const range = max - min || 1, slot = (W - left - right) / visible;
    const x = (index) => left + (index - begin + .5) * slot;
    const y = (price) => top + (max - price) / range * mainH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.save();
    ctx.beginPath(); ctx.rect(left, top, W - left - right, mainH); ctx.clip();
    settings.forEach((item) => {
      if (!item.enabled || item.period < 2) return;
      const values = emaValues(series, item.period);
      ctx.beginPath(); ctx.strokeStyle = item.color; ctx.lineWidth = 1.8; ctx.lineJoin = "round"; ctx.lineCap = "round";
      let started = false;
      for (let i = begin; i < dataEnd; i++) {
        const value = values[i];
        if (!Number.isFinite(value)) continue;
        const px = x(i), py = y(value);
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      }
      if (started) ctx.stroke();
    });
    ctx.restore();
  }
  function redraw() {
    const app = window.OKXSignalApp, state = app && app.getState ? app.getState() : null;
    if (state && state.last && typeof window.draw === "function") window.draw(state.last);
  }
  function start() {
    if (!mount()) return;
    baseDraw = window.draw;
    if (typeof baseDraw === "function") {
      window.draw = function (event) {
        baseDraw(event);
        drawOverlays();
      };
    }
    window.addEventListener("resize", redraw);
    window.OKXChartEMA = { getSettings: () => clone(settings), render: drawOverlays };
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();