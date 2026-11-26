/* First-version trend context: EMA20/EMA50 on closed OKX candles only. */
(() => {
  "use strict";

  const API = "https://www.okx.com/api/v5/market/candles";
  const FRAMES = [
    { key: "15m", bar: "15m", label: "15 минут" },
    { key: "1h", bar: "1H", label: "1 час" },
    { key: "1d", bar: "1D", label: "1 день" }
  ];
  const $ = (id) => document.getElementById(id);
  let activePair = "";
  let requestId = 0;
  let timer = null;

  function addStyles() {
    if ($("emaTrendStyles")) return;
    const style = document.createElement("style");
    style.id = "emaTrendStyles";
    style.textContent = [
      "#emaTrendPanel{margin:0 0 10px;padding:10px;background:#0b1118;border:1px solid #1d2835;border-radius:10px}",
      ".ema-trend-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px}",
      ".ema-trend-title{font-size:12px;font-weight:800;color:#eaf0f6}",
      ".ema-trend-note{font-size:10px;color:#8290a0}",
      ".ema-trend-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}",
      ".ema-trend-card{min-width:0;padding:9px;background:#090e14;border:1px solid #17212d;border-radius:8px}",
      ".ema-trend-frame{font-size:10px;color:#8290a0}",
      ".ema-trend-state{font-size:15px;font-weight:900;margin:4px 0}",
      ".ema-trend-state.up{color:#27e58a}.ema-trend-state.down{color:#ff5f68}.ema-trend-state.flat{color:#ffd166}",
      ".ema-trend-values{font-size:10px;line-height:1.55;color:#a6b2c0;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}",
      ".ema-trend-foot{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-top:7px;font-size:10px;color:#8290a0}",
      "@media(max-width:520px){.ema-trend-grid{gap:5px}.ema-trend-card{padding:7px 5px}.ema-trend-state{font-size:13px}.ema-trend-values{font-size:9px}}"
    ].join("");
    document.head.appendChild(style);
  }

  function mount() {
    const chartPanel = $("chartPanel");
    const instrumentHead = chartPanel && chartPanel.querySelector(".instrument-head");
    if (!chartPanel || !instrumentHead || $("emaTrendPanel")) return false;
    addStyles();
    const section = document.createElement("section");
    section.id = "emaTrendPanel";
    section.setAttribute("aria-label", "Направление тренда на старших таймфреймах");
    section.innerHTML =
      '<div class="ema-trend-head"><span class="ema-trend-title">Тренд старших таймфреймов · EMA 20/50</span><span class="ema-trend-note">по закрытым свечам</span></div>' +
      '<div class="ema-trend-grid">' +
        FRAMES.map((frame) =>
          '<div class="ema-trend-card" data-ema-frame="' + frame.key + '">' +
            '<div class="ema-trend-frame">' + frame.label + ' · ' + frame.key + '</div>' +
            '<div class="ema-trend-state flat" data-ema-state>Загрузка…</div>' +
            '<div class="ema-trend-values" data-ema-values>EMA20: —<br>EMA50: —</div>' +
          '</div>'
        ).join("") +
      '</div>' +
      '<div class="ema-trend-foot"><span id="emaTrendPair">Пара: —</span><span id="emaTrendUpdated">Ожидание данных OKX…</span></div>';
    instrumentHead.insertAdjacentElement("afterend", section);
    return true;
  }

  function ema(values, period) {
    if (!Array.isArray(values) || values.length < period) return NaN;
    const alpha = 2 / (period + 1);
    let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
    for (let i = period; i < values.length; i++) {
      value = values[i] * alpha + value * (1 - alpha);
    }
    return value;
  }

  function formatPrice(value) {
    if (!Number.isFinite(value)) return "—";
    return value.toLocaleString("en-US", { maximumFractionDigits: value >= 1000 ? 2 : 6 });
  }

  function getCurrentPair() {
    const node = $("chartPair");
    const symbol = node ? node.textContent.trim().toUpperCase() : "";
    if (!symbol || symbol === "—") return "";
    return symbol.endsWith("-USDT-SWAP") ? symbol : symbol.replace(/-USDT$/, "") + "-USDT-SWAP";
  }

  async function loadFrame(pair, frame) {
    const response = await fetch(
      API + "?instId=" + encodeURIComponent(pair) + "&bar=" + encodeURIComponent(frame.bar) + "&limit=100",
      { cache: "no-store" }
    );
    if (!response.ok) throw new Error("HTTP " + response.status);
    const payload = await response.json();
    if (payload.code !== "0" || !Array.isArray(payload.data)) {
      throw new Error(payload.msg || "Ответ OKX недоступен");
    }
    const bars = payload.data
      .map((row) => ({
        ts: Number(row[0]),
        close: Number(row[4]),
        confirm: String(row[8] == null ? "1" : row[8])
      }))
      .filter((row) => Number.isFinite(row.ts) && Number.isFinite(row.close) && row.confirm !== "0")
      .sort((a, b) => a.ts - b.ts);
    if (bars.length < 50) throw new Error("Недостаточно закрытых свечей");
    const closes = bars.map((bar) => bar.close);
    return {
      close: closes[closes.length - 1],
      ema20: ema(closes, 20),
      ema50: ema(closes, 50)
    };
  }

  function renderFrame(frame, result) {
    const card = document.querySelector('[data-ema-frame="' + frame.key + '"]');
    if (!card) return;
    const state = card.querySelector("[data-ema-state]");
    const values = card.querySelector("[data-ema-values]");
    let direction = "FLAT";
    if (result.ema20 > result.ema50 && result.close >= result.ema20) direction = "UP";
    else if (result.ema20 < result.ema50 && result.close <= result.ema20) direction = "DOWN";
    state.textContent = direction;
    state.className = "ema-trend-state " + direction.toLowerCase();
    values.innerHTML = "EMA20: " + formatPrice(result.ema20) +
      "<br>EMA50: " + formatPrice(result.ema50) +
      "<br>Цена: " + formatPrice(result.close);
  }

  function renderError(frame, message) {
    const card = document.querySelector('[data-ema-frame="' + frame.key + '"]');
    if (!card) return;
    const state = card.querySelector("[data-ema-state]");
    state.textContent = "НЕТ ДАННЫХ";
    state.className = "ema-trend-state flat";
    card.querySelector("[data-ema-values]").textContent = message;
  }

  async function update() {
    if (!$("emaTrendPanel") && !mount()) return;
    const pair = getCurrentPair();
    if (!pair) return;
    activePair = pair;
    const currentRequest = ++requestId;
    $("emaTrendPair").textContent = "Пара: " + pair.replace("-USDT-SWAP", "");
    $("emaTrendUpdated").textContent = "Обновление…";
    const results = await Promise.all(FRAMES.map(async (frame) => {
      try {
        const result = await loadFrame(pair, frame);
        if (currentRequest === requestId && activePair === pair) renderFrame(frame, result);
      } catch (error) {
        if (currentRequest === requestId && activePair === pair) {
          renderError(frame, error && error.message ? error.message : "Ошибка загрузки");
        }
      }
    }));
    if (currentRequest === requestId && activePair === pair) {
      $("emaTrendUpdated").textContent = "Обновлено: " +
        new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }
  }

  function scheduleUpdate() {
    const pair = getCurrentPair();
    if (pair && pair !== activePair) update();
  }

  function start() {
    if (!mount()) {
      window.setTimeout(start, 250);
      return;
    }
    update();
    const pairNode = $("chartPair");
    if (pairNode && window.MutationObserver) {
      const observer = new MutationObserver(scheduleUpdate);
      observer.observe(pairNode, { childList: true, characterData: true, subtree: true });
    }
    ["refresh", "chartRefresh"].forEach((id) => {
      const button = $(id);
      if (button) button.addEventListener("click", () => window.setTimeout(update, 500));
    });
    if (timer) window.clearInterval(timer);
    timer = window.setInterval(update, 60000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
