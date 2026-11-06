/* OKX Signal Pro — independent Volume + RSI + BOS module */
(function () {
  "use strict";

  const CFG_KEY = "okx_scalping_trigger_v1";
  const STATE_KEY = "okx_scalping_trigger_state_v1";
  const MARKER_KEY = "okx_v2_alert_markers";
  const DEFAULTS = {
    enabled: true,
    scope: "chart",
    volumeRsiEnabled: true,
    volumePeriod: 20,
    volumeMultiplier: 2,
    rsiLength: 14,
    rsiOversold: 30,
    rsiOverbought: 70,
    bosEnabled: true,
    bosAlerts: true,
    swingLength: 3,
    requireBos: false,
    longEnabled: true,
    shortEnabled: true,
    soundEnabled: true,
    cooldownSeconds: 60,
    rsiClusterAtrMultiplier: 1
  };

  const $ = (id) => document.getElementById(id);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const safeParse = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "null");
      return value && typeof value === "object" ? value : fallback;
    } catch (_) { return fallback; }
  };

  let cfg = Object.assign({}, DEFAULTS, safeParse(CFG_KEY, {}));
  let state = Object.assign({
    processed: {}, fired: [], lastAlertAt: {},
    rsiClusters: {}, rsiClusterSuppressed: 0
  }, safeParse(STATE_KEY, {}));
  if (!state.processed || typeof state.processed !== "object") state.processed = {};
  if (!Array.isArray(state.fired)) state.fired = [];
  if (!state.lastAlertAt || typeof state.lastAlertAt !== "object") state.lastAlertAt = {};
  if (!state.rsiClusters || typeof state.rsiClusters !== "object") state.rsiClusters = {};
  state.rsiClusterSuppressed = Math.max(0, Number(state.rsiClusterSuppressed) || 0);
  let audioContext = null;
  let polling = false;
  let lastCheckAt = 0;
  let modal = null;
  let statusNode = null;
  let historyNode = null;
  let history = safeParse(STATE_KEY + "_history", []);
  if (!Array.isArray(history)) history = [];

  cfg.volumePeriod = clamp(Math.round(Number(cfg.volumePeriod) || 20), 2, 200);
  cfg.volumeMultiplier = clamp(Number(cfg.volumeMultiplier) || 2, 1, 20);
  cfg.rsiLength = clamp(Math.round(Number(cfg.rsiLength) || 14), 2, 100);
  cfg.rsiOversold = clamp(Math.round(Number(cfg.rsiOversold) || 30), 1, 49);
  cfg.rsiOverbought = clamp(Math.round(Number(cfg.rsiOverbought) || 70), 51, 99);
  cfg.swingLength = clamp(Math.round(Number(cfg.swingLength) || 3), 1, 20);
  cfg.cooldownSeconds = clamp(Math.round(Number(cfg.cooldownSeconds) || 60), 1, 86400);
  cfg.rsiClusterAtrMultiplier = clamp(Number(cfg.rsiClusterAtrMultiplier) || 1, 0.25, 3);
  if (!["chart", "alerts"].includes(cfg.scope)) cfg.scope = "chart";

  function saveConfig() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (_) {}
    updateStatus();
  }

  function saveState() {
    state.fired = (Array.isArray(state.fired) ? state.fired : []).slice(-500);
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
      localStorage.setItem(STATE_KEY + "_history", JSON.stringify(history.slice(-100)));
    } catch (_) {}
  }

  function normalizeTf(tf) {
    return String(tf || "15m").toLowerCase();
  }

  function appState() {
    return window.OKXSignalApp && typeof window.OKXSignalApp.getState === "function"
      ? window.OKXSignalApp.getState() : null;
  }

  function getTargets() {
    const app = appState();
    if (cfg.scope === "alerts") {
      const alertCfg = window.OKXAlerts && typeof window.OKXAlerts.getConfig === "function"
        ? window.OKXAlerts.getConfig() : null;
      const pairs = alertCfg && Array.isArray(alertCfg.selectedPairs) ? alertCfg.selectedPairs.slice(0, 20) : [];
      const tf = normalizeTf(alertCfg && alertCfg.alertTf || "15m");
      return { pairs, tf, label: "Пары и таймфрейм из раздела «Алерты»" };
    }
    const pair = app && app.currentPair ? String(app.currentPair) : "";
    const tf = normalizeTf(app && app.tf || "15m");
    return { pairs: pair ? [pair] : [], tf, label: "Текущая пара и таймфрейм графика" };
  }

  function rsiSeries(bars, period) {
    const out = new Array(bars.length).fill(null);
    if (bars.length <= period) return out;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const change = Number(bars[i].c) - Number(bars[i - 1].c);
      if (!Number.isFinite(change)) return out;
      if (change > 0) gains += change;
      else losses -= change;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    const value = () => avgLoss === 0 ? 100 : avgGain === 0 ? 0 : 100 - 100 / (1 + avgGain / avgLoss);
    out[period] = value();
    for (let i = period + 1; i < bars.length; i++) {
      const change = Number(bars[i].c) - Number(bars[i - 1].c);
      if (!Number.isFinite(change)) return out;
      const gain = Math.max(change, 0), loss = Math.max(-change, 0);
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = value();
    }
    return out;
  }

  function averageVolume(bars, period) {
    if (bars.length < period) return null;
    let sum = 0;
    for (let i = bars.length - period; i < bars.length; i++) {
      const value = Number(bars[i].v);
      if (!Number.isFinite(value)) return null;
      sum += value;
    }
    return sum / period;
  }

  function latestConfirmedPivot(bars, length, type) {
    const field = type === "high" ? "h" : "l";
    for (let i = bars.length - 1 - length; i >= length; i--) {
      const candidate = Number(bars[i][field]);
      if (!Number.isFinite(candidate)) continue;
      let pivot = true;
      for (let j = i - length; j <= i + length; j++) {
        if (j === i) continue;
        const other = Number(bars[j][field]);
        if (!Number.isFinite(other) || (type === "high" ? other >= candidate : other <= candidate)) {
          pivot = false;
          break;
        }
      }
      if (pivot) return { price: candidate, ts: Number(bars[i].ts), index: i };
    }
    return null;
  }

  function detectBos(bars) {
    const length = cfg.swingLength;
    if (bars.length < length * 2 + 3) return null;
    const previousClose = Number(bars[bars.length - 2].c);
    const close = Number(bars[bars.length - 1].c);
    if (![previousClose, close].every(Number.isFinite)) return null;

    const highPivot = latestConfirmedPivot(bars, length, "high");
    const lowPivot = latestConfirmedPivot(bars, length, "low");

    if (cfg.bosEnabled && highPivot && previousClose <= highPivot.price && close > highPivot.price) {
      return { direction: "LONG", level: highPivot.price, pivotTs: highPivot.ts, label: "BOS ↑" };
    }
    if (cfg.bosEnabled && lowPivot && previousClose >= lowPivot.price && close < lowPivot.price) {
      return { direction: "SHORT", level: lowPivot.price, pivotTs: lowPivot.ts, label: "BOS ↓" };
    }
    return null;
  }

  function ensureAudio() {
    try {
      if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
      if (audioContext.state === "suspended") return audioContext.resume();
      return Promise.resolve();
    } catch (error) { return Promise.reject(error); }
  }

  function tone(direction) {
    if (!cfg.soundEnabled) return;
    ensureAudio().then(() => {
      if (!audioContext) return;
      const now = audioContext.currentTime;
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = "triangle";
      oscillator.frequency.value = direction === "LONG" ? 880 : 420;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.09, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(now);
      oscillator.stop(now + 0.38);
    }).catch(() => {});
  }

  function addChartMarker(meta) {
    if (!meta || !meta.pair || !meta.tf || !["LONG", "SHORT"].includes(meta.direction)) return;
    const price = Number(meta.price), ts = Number(meta.ts);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(ts)) return;
    let marks = safeParse(MARKER_KEY, []);
    if (!Array.isArray(marks)) marks = [];
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    marks = marks.filter((item) => item && Number(item.ts) >= cutoff &&
      item.pair && item.tf && ["LONG", "SHORT"].includes(item.direction));
    const id = ["scalping-trigger", meta.pair, meta.tf, meta.kind, ts, meta.direction, meta.label].join("|");
    if (marks.some((item) => item.id === id)) return;
    const marker = {
      id, pair: meta.pair, tf: normalizeTf(meta.tf), kind: meta.kind,
      direction: meta.direction, price, entryPrice: Number(meta.entryPrice) || price,
      ts, touches: 1, label: meta.label, tolerance: Math.max(price * 0.0008, 0.01)
    };
    marks.push(marker);
    try { localStorage.setItem(MARKER_KEY, JSON.stringify(marks.slice(-500))); } catch (_) {}
    window.dispatchEvent(new CustomEvent("okx-alert-marker", { detail: marker }));
  }

  function addHistory(kind, pair, tf, direction, message, ts, price) {
    const item = {
      kind, pair, tf, direction, message,
      price: Number.isFinite(Number(price)) && Number(price) > 0 ? Number(price) : null,
      ts: Number(ts) || Date.now(),
      signalTs: Date.now()
    };
    history.push(item);
    history = history.slice(-100);
    try { localStorage.setItem(STATE_KEY + "_history", JSON.stringify(history)); } catch (_) {}
    renderHistory();
    const trigger = $("scalpTriggerButton");
    if (trigger) trigger.classList.add("has-signal");
    return item;
  }

  function shouldEmit(key) {
    const now = Date.now();
    const previous = Number(state.lastAlertAt[key]) || 0;
    if (now - previous < cfg.cooldownSeconds * 1000) return false;
    state.lastAlertAt[key] = now;
    return true;
  }

  function emit(kind, pair, tf, candle, direction, price, label, message, uniqueId) {
    if ((direction === "LONG" && !cfg.longEnabled) || (direction === "SHORT" && !cfg.shortEnabled)) return null;
    if (state.fired.includes(uniqueId) || !shouldEmit([kind, pair, tf, direction].join("|"))) return null;
    state.fired.push(uniqueId);
    addChartMarker({
      pair, tf, ts: Number(candle.ts), price,
      entryPrice: Number(candle.c), direction, label, kind
    });
    const historyItem = addHistory(kind, pair, tf, direction, message, candle.ts, price);
    tone(direction);
    saveState();
    return historyItem || null;
  }

  function averageTrueRange(bars, period) {
    if (!Array.isArray(bars) || bars.length < 2) return null;
    const start = Math.max(1, bars.length - Math.max(1, Number(period) || 14));
    let total = 0, count = 0;
    for (let i = start; i < bars.length; i++) {
      const high = Number(bars[i].h);
      const low = Number(bars[i].l);
      const previousClose = Number(bars[i - 1].c);
      if (![high, low, previousClose].every(Number.isFinite)) continue;
      const range = Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
      if (Number.isFinite(range) && range >= 0) { total += range; count++; }
    }
    return count ? total / count : null;
  }

  function rsiClusterKey(pair, tf) {
    return String(pair) + "|" + normalizeTf(tf);
  }

  function updateRsiCluster(pair, tf, candle, currentRsi) {
    const key = rsiClusterKey(pair, tf);
    const cluster = state.rsiClusters[key];
    if (!cluster) return;
    const close = Number(candle && candle.c);
    if (!Number.isFinite(close) || !Number.isFinite(Number(cluster.anchorPrice))) return;

    const rsi = Number(currentRsi);
    if (Number.isFinite(rsi)) {
      if (cluster.direction === "LONG" && rsi >= cluster.resetRsi) cluster.neutralSeen = true;
      if (cluster.direction === "SHORT" && rsi <= cluster.resetRsi) cluster.neutralSeen = true;
    }

    const movedOutsideZone = Math.abs(close - Number(cluster.anchorPrice)) >= Number(cluster.radius);
    if (cluster.neutralSeen && movedOutsideZone) {
      delete state.rsiClusters[key];
      saveState();
    }
  }

  function mergeRsiRepeat(pair, tf, candle, direction) {
    const key = rsiClusterKey(pair, tf);
    const cluster = state.rsiClusters[key];
    if (!cluster) return false;

    const price = Number(candle && candle.c);
    const distance = Number.isFinite(price) ? Math.abs(price - Number(cluster.anchorPrice)) : 0;
    // A cluster stays active until RSI has reset AND price has left its original ATR zone.
    if (distance >= Number(cluster.radius) && cluster.neutralSeen) {
      delete state.rsiClusters[key];
      return false;
    }

    cluster.suppressedCount = (Number(cluster.suppressedCount) || 0) + 1;
    cluster.lastSuppressedTs = Number(candle && candle.ts) || Date.now();
    cluster.lastSuppressedPrice = Number.isFinite(price) ? price : null;
    cluster.lastSuppressedDirection = direction;
    state.rsiClusterSuppressed = (Number(state.rsiClusterSuppressed) || 0) + 1;

    const entry = history.find((item) =>
      item && item.kind === "scalping" &&
      item.pair === pair && normalizeTf(item.tf) === normalizeTf(tf) &&
      Number(item.signalTs) === Number(cluster.historySignalTs));
    if (entry) {
      entry.mergedCount = (Number(entry.mergedCount) || 0) + 1;
      entry.lastMergedTs = Date.now();
      entry.lastMergedPrice = Number.isFinite(price) ? price : null;
      entry.lastMergedDirection = direction;
    }
    renderHistory();
    saveState();
    updateStatus();
    return true;
  }

  function startRsiCluster(pair, tf, candle, direction, price, bars, historyItem) {
    const atr = averageTrueRange(bars, 14);
    const fallbackFloor = Math.max(Math.abs(Number(price)) * 0.00025, 0.01);
    const radius = Math.max((Number(atr) || 0) * cfg.rsiClusterAtrMultiplier, fallbackFloor);
    const resetRsi = direction === "LONG"
      ? Math.min(60, Math.max(cfg.rsiOversold + 10, 40))
      : Math.max(40, Math.min(cfg.rsiOverbought - 10, 60));
    state.rsiClusters[rsiClusterKey(pair, tf)] = {
      direction,
      anchorPrice: Number(price),
      anchorTs: Number(candle && candle.ts) || Date.now(),
      radius,
      atr: Number(atr) || null,
      resetRsi,
      neutralSeen: false,
      historySignalTs: Number(historyItem && historyItem.signalTs) || Date.now(),
      suppressedCount: 0
    };
    saveState();
  }

  function evaluateBars(bars, pair, tf) {
    if (!cfg.enabled || !Array.isArray(bars) || bars.length < 3) return;
    const candle = bars[bars.length - 1];
    const candleTs = Number(candle && candle.ts);
    if (!Number.isFinite(candleTs)) return;
    const scopeKey = pair + "|" + normalizeTf(tf);
    if (Number(state.processed[scopeKey]) === candleTs) return;

    const required = Math.max(cfg.volumePeriod, cfg.rsiLength + 1, cfg.swingLength * 2 + 3);
    if (bars.length < required) {
      state.processed[scopeKey] = candleTs;
      saveState();
      return;
    }

    const volumes = averageVolume(bars, cfg.volumePeriod);
    const volume = Number(candle.v);
    const volumeSpike = volumes != null && volumes > 0 &&
      volume > volumes * cfg.volumeMultiplier;

    const values = rsiSeries(bars, cfg.rsiLength);
    const currentRsi = values[values.length - 1];
    const previousRsi = values[values.length - 2];
    updateRsiCluster(pair, tf, candle, currentRsi);
    const rsiLong = currentRsi != null &&
      (currentRsi <= cfg.rsiOversold || (previousRsi != null &&
        previousRsi <= cfg.rsiOversold && currentRsi > cfg.rsiOversold));
    const rsiShort = currentRsi != null &&
      (currentRsi >= cfg.rsiOverbought || (previousRsi != null &&
        previousRsi >= cfg.rsiOverbought && currentRsi < cfg.rsiOverbought));

    const bos = detectBos(bars);
    if (bos && cfg.bosEnabled && cfg.bosAlerts) {
      const pivotId = ["bos", pair, normalizeTf(tf), bos.direction, bos.pivotTs].join("|");
      emit("bos", pair, tf, candle, bos.direction, bos.level, bos.label,
        (bos.direction === "LONG" ? "🟢 " : "🔴 ") + bos.label + " • пробой " +
        bos.level.toFixed(6) + " • " + pair + " • " + tf, pivotId);
    }

    if (cfg.volumeRsiEnabled && volumeSpike) {
      const candidates = [];
      if (rsiLong) candidates.push("LONG");
      if (rsiShort) candidates.push("SHORT");
      candidates.forEach((direction) => {
        if (cfg.requireBos && (!bos || bos.direction !== direction)) return;
        if (mergeRsiRepeat(pair, tf, candle, direction)) return;
        const id = ["volume-rsi", pair, normalizeTf(tf), candleTs, direction].join("|");
        const text = (direction === "LONG" ? "⚡ LONG" : "⚡ SHORT") +
          " • Volume ×" + (volume / volumes).toFixed(2) +
          " + RSI " + Number(currentRsi).toFixed(1) +
          (cfg.requireBos ? " + BOS" : "") + " • " + pair + " • " + tf;
        const emitted = emit("scalping", pair, tf, candle, direction, Number(candle.c),
          cfg.requireBos ? "VOL+RSI+BOS" : "VOL+RSI", text, id);
        if (emitted) startRsiCluster(pair, tf, candle, direction, Number(candle.c), bars, emitted);
      });
    }

    state.processed[scopeKey] = candleTs;
    saveState();
    updateStatus();
  }

  async function poll() {
    if (polling || !cfg.enabled) return;
    const target = getTargets();
    if (!target.pairs.length || !window.OKXSignalApp ||
        typeof window.OKXSignalApp.fetchCandles !== "function") {
      updateStatus();
      return;
    }
    polling = true;
    try {
      await Promise.allSettled(target.pairs.map(async (pair) => {
        const bars = await window.OKXSignalApp.fetchCandles(pair, target.tf, 100);
        if (Array.isArray(bars) && bars.length) evaluateBars(bars, pair, target.tf);
      }));
      lastCheckAt = Date.now();
      updateStatus();
    } finally {
      polling = false;
    }
  }

  function renderHistory() {
    const countNode = $("stHistoryCount");
    if (countNode) countNode.textContent = "Журнал сигналов · " + history.length + " / 100";
    if (!historyNode) return;
    historyNode.replaceChildren();

    const entries = history.slice().reverse();
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "st-empty";
      empty.textContent = "Сигналов пока нет. Журнал заполнится после закрытия первой подходящей свечи.";
      historyNode.appendChild(empty);
      return;
    }

    const formatDateTime = (value) => Number(value) > 0
      ? new Date(Number(value)).toLocaleString("ru-RU", {
          day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
        })
      : "—";

    entries.forEach((entry) => {
      const row = document.createElement("div");
      row.className = "st-history-row " + (entry.direction === "LONG" ? "is-long" : "is-short");

      const timeCell = document.createElement("div");
      timeCell.className = "st-history-cell st-time";
      const candleTime = document.createElement("time");
      candleTime.textContent = formatDateTime(entry.ts);
      candleTime.title = "Время закрытия сигнальной свечи";
      const capturedTime = document.createElement("small");
      capturedTime.textContent = "Зафиксирован: " + formatDateTime(entry.signalTs);
      capturedTime.title = "Фактическое время обнаружения сигнала приложением";
      timeCell.append(candleTime, capturedTime);

      const pairCell = document.createElement("div");
      pairCell.className = "st-history-cell st-history-pair";
      pairCell.textContent = (entry.pair || "—") + " · " + (entry.tf || "—");

      const sourceCell = document.createElement("div");
      sourceCell.className = "st-history-cell st-history-source";
      sourceCell.textContent = entry.kind === "bos" ? "BOS" :
        entry.kind === "scalping" ? "Volume + RSI" : String(entry.kind || "—");

      const directionCell = document.createElement("div");
      directionCell.className = "st-history-cell st-history-direction " +
        (entry.direction === "LONG" ? "is-long" : "is-short");
      directionCell.textContent = entry.direction || "—";

      const priceCell = document.createElement("div");
      priceCell.className = "st-history-cell st-history-price";
      priceCell.textContent = Number(entry.price) > 0
        ? Number(entry.price).toLocaleString("ru-RU", { maximumFractionDigits: 8 })
        : "—";

      const detail = document.createElement("div");
      detail.className = "st-history-detail";
      const mergedCount = Number(entry.mergedCount) || 0;
      detail.textContent = (entry.message || "") +
        (mergedCount ? " · Объединено повторов в этой ситуации: " + mergedCount : "");

      row.append(timeCell, pairCell, sourceCell, directionCell, priceCell, detail);
      historyNode.appendChild(row);
    });
  }

  function updateStatus() {
    const target = getTargets();
    const baseStatus = !cfg.enabled ? "Выключено" :
      !target.pairs.length ? (cfg.scope === "alerts" ? "Выбери пары в разделе «Алерты»" : "Нет выбранной пары") :
      "Активно • " + target.pairs.length + (target.pairs.length === 1 ? " пара" : " пар") + " • " + target.tf;
    const formatTime = (value) => Number(value) > 0
      ? new Date(Number(value)).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
      : "—";
    const lastSignal = history.length
      ? formatTime(history[history.length - 1].signalTs || history[history.length - 1].ts)
      : "—";
    const status = baseStatus +
      "\nПроверка: " + formatTime(lastCheckAt) +
      " • Сигналов в журнале: " + history.length + " / 100" +
      "\nОбъединено RSI-повторов: " + (Number(state.rsiClusterSuppressed) || 0) +
      "\nПоследний сигнал: " + lastSignal;
    if (statusNode) statusNode.textContent = status;
    const button = $("scalpTriggerButton");
    if (button) {
      button.title = baseStatus + " • Сигналов в журнале: " + history.length + " / 100";
      button.classList.toggle("is-active", !!cfg.enabled);
    }
    const scopeLabel = $("stScopeDescription");
    if (scopeLabel) scopeLabel.textContent = target.label + " · " + (target.pairs.length ? target.pairs.length + " пар · " + target.tf : "пары не выбраны");
  }

  function syncControls() {
    const fields = {
      stEnabled: "enabled", stScope: "scope", stVolumeRsiEnabled: "volumeRsiEnabled",
      stVolumePeriod: "volumePeriod", stVolumeMultiplier: "volumeMultiplier",
      stRsiLength: "rsiLength", stRsiOversold: "rsiOversold", stRsiOverbought: "rsiOverbought",
      stRsiClusterAtr: "rsiClusterAtrMultiplier",
      stBosEnabled: "bosEnabled", stBosAlerts: "bosAlerts", stSwingLength: "swingLength",
      stRequireBos: "requireBos", stLongEnabled: "longEnabled", stShortEnabled: "shortEnabled",
      stSoundEnabled: "soundEnabled", stCooldown: "cooldownSeconds"
    };
    Object.entries(fields).forEach(([id, key]) => {
      const el = $(id);
      if (!el) return;
      if (el.type === "checkbox") el.checked = !!cfg[key];
      else el.value = String(cfg[key]);
    });
    updateStatus();
  }

  function buildModal() {
    if ($("scalpingTriggerModal")) return;
    modal = document.createElement("div");
    modal.id = "scalpingTriggerModal";
    modal.className = "st-backdrop";
    modal.hidden = true;
    modal.innerHTML =
      '<section class="st-window" role="dialog" aria-modal="true" aria-labelledby="stTitle">' +
        '<header class="st-header"><div><h2 id="stTitle">⚡ Scalping Trigger · Volume + RSI + BOS</h2>' +
          '<p>Отдельный модуль. Сигналы рассчитываются только по закрытым свечам.</p></div>' +
          '<button type="button" id="stClose" aria-label="Закрыть окно">✕</button></header>' +
        '<div class="st-body">' +
          '<label class="st-main-toggle"><input id="stEnabled" type="checkbox"> Включить мониторинг и алерты</label>' +
          '<div class="st-scope"><label>Откуда брать пары и таймфрейм<select id="stScope"><option value="chart">Текущая пара и ТФ графика</option><option value="alerts">Список пар и ТФ из раздела «Алерты»</option></select></label>' +
          '<div id="stScopeDescription" class="st-hint"></div></div>' +
          '<div class="st-grid">' +
            '<section class="st-card"><label class="st-check"><input id="stVolumeRsiEnabled" type="checkbox"> <b>Volume + RSI</b></label>' +
              '<div class="st-fields"><label>Период объёма<input id="stVolumePeriod" type="number" min="2" max="200"></label>' +
              '<label>Всплеск, множитель ×<input id="stVolumeMultiplier" type="number" min="1" max="20" step=".1"></label>' +
              '<label>RSI период<input id="stRsiLength" type="number" min="2" max="100"></label>' +
              '<label>Уровни RSI<input id="stRsiOversold" type="number" min="1" max="49"> / <input id="stRsiOverbought" type="number" min="51" max="99"></label>' +
              '<label>Зона объединения повторов, ATR ×<input id="stRsiClusterAtr" type="number" min="0.25" max="3" step="0.25"></label></div>' +
              '<p class="st-hint">Повторные Volume + RSI в одной ценовой области объединяются. Новая ситуация разрешается после возврата RSI в нейтральную зону и выхода цены за границу области. По умолчанию граница — 1 ATR.</p>' +
              '<p class="st-hint">LONG: всплеск объёма + RSI ≤ нижней зоны или выход вверх через неё. SHORT: всплеск объёма + RSI ≥ верхней зоны или выход вниз через неё.</p></section>' +
            '<section class="st-card"><label class="st-check"><input id="stBosEnabled" type="checkbox"> <b>BOS · слом микроструктуры</b></label>' +
              '<div class="st-fields"><label>Размер swing (свечей слева/справа)<input id="stSwingLength" type="number" min="1" max="20"></label>' +
              '<label class="st-check"><input id="stBosAlerts" type="checkbox"> Отдельные алерты BOS</label>' +
              '<label class="st-check st-wide"><input id="stRequireBos" type="checkbox"> Требовать BOS в ту же сторону для сигнала Volume + RSI</label></div>' +
              '<p class="st-hint">BOS LONG — закрытие выше последнего подтверждённого swing high. BOS SHORT — закрытие ниже swing low. Pivot подтверждается после указанного числа свечей справа, без перерисовки.</p></section>' +
          '</div>' +
          '<section class="st-card st-direction"><b>Направления и уведомления</b><div class="st-inline">' +
            '<label class="st-check"><input id="stLongEnabled" type="checkbox"> LONG</label>' +
            '<label class="st-check"><input id="stShortEnabled" type="checkbox"> SHORT</label>' +
            '<label class="st-check"><input id="stSoundEnabled" type="checkbox"> Звук</label>' +
            '<label>Антиспам, сек<input id="stCooldown" type="number" min="1" max="86400"></label>' +
          '</div></section>' +
          '<div id="stStatus" class="st-status">Подготовка…</div>' +
          '<section class="st-history" aria-label="Журнал сигналов"><div class="st-history-head"><b id="stHistoryCount">Журнал сигналов · 0 / 100</b><button type="button" id="stClearHistory">Очистить</button></div>' +
            '<div class="st-history-columns" aria-hidden="true"><span>Свеча / фиксация</span><span>Пара / ТФ</span><span>Источник</span><span>Сигнал</span><span>Цена</span></div>' +
            '<div id="stHistoryList" class="st-history-list" role="log" aria-live="polite"></div></section>' +
          '<p class="st-footnote">Маркеры появятся на основном графике выбранной пары и таймфрейма. Двойной щелчок по маркеру удаляет его, как и другие маркеры алертов. Этот модуль не меняет Telegram-правила, основной COMBO, Live или тестер.</p>' +
        '</div></section>';
    document.body.appendChild(modal);
    statusNode = $("stStatus");
    historyNode = $("stHistoryList");
    syncControls();
    renderHistory();

    $("stClose").onclick = closeModal;
    modal.addEventListener("click", (event) => { if (event.target === modal) closeModal(); });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && modal && !modal.hidden) closeModal();
    });

    const fieldMap = {
      stEnabled: ["enabled", (v) => v],
      stScope: ["scope", (v) => v === "alerts" ? "alerts" : "chart"],
      stVolumeRsiEnabled: ["volumeRsiEnabled", (v) => v],
      stVolumePeriod: ["volumePeriod", (v) => clamp(Math.round(Number(v) || 20), 2, 200)],
      stVolumeMultiplier: ["volumeMultiplier", (v) => clamp(Number(v) || 2, 1, 20)],
      stRsiLength: ["rsiLength", (v) => clamp(Math.round(Number(v) || 14), 2, 100)],
      stRsiOversold: ["rsiOversold", (v) => clamp(Math.round(Number(v) || 30), 1, 49)],
      stRsiOverbought: ["rsiOverbought", (v) => clamp(Math.round(Number(v) || 70), 51, 99)],
      stRsiClusterAtr: ["rsiClusterAtrMultiplier", (v) => clamp(Number(v) || 1, 0.25, 3)],
      stBosEnabled: ["bosEnabled", (v) => v],
      stBosAlerts: ["bosAlerts", (v) => v],
      stSwingLength: ["swingLength", (v) => clamp(Math.round(Number(v) || 3), 1, 20)],
      stRequireBos: ["requireBos", (v) => v],
      stLongEnabled: ["longEnabled", (v) => v],
      stShortEnabled: ["shortEnabled", (v) => v],
      stSoundEnabled: ["soundEnabled", (v) => v],
      stCooldown: ["cooldownSeconds", (v) => clamp(Math.round(Number(v) || 60), 1, 86400)]
    };
    Object.entries(fieldMap).forEach(([id, tuple]) => {
      const el = $(id);
      el.addEventListener("change", () => {
        const value = el.type === "checkbox" ? el.checked : el.value;
        cfg[tuple[0]] = tuple[1](value);
        saveConfig();
        syncControls();
        if (id === "stEnabled" && cfg.enabled) poll();
        if (id === "stScope") poll();
      });
    });
    $("stClearHistory").onclick = () => {
      history = [];
      try { localStorage.setItem(STATE_KEY + "_history", "[]"); } catch (_) {}
      renderHistory();
      updateStatus();
    };
  }

  function addOpenButton() {
    const nav = $("quickAccessBar");
    if (!nav || $("scalpTriggerButton")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.id = "scalpTriggerButton";
    button.innerHTML = "⚡ <span>Скальпинг</span>";
    button.title = "Открыть Volume + RSI + BOS";
    button.onclick = openModal;
    const alertsButton = nav.querySelector('[data-quick-target="alertsPanel"]');
    if (alertsButton) alertsButton.insertAdjacentElement("afterend", button);
    else nav.appendChild(button);
  }

  function openModal() {
    if (!modal) buildModal();
    if (!modal) return;
    modal.hidden = false;
    document.body.classList.add("st-modal-open");
    syncControls();
    renderHistory();
    poll();
  }

  function closeModal() {
    if (!modal) return;
    modal.hidden = true;
    document.body.classList.remove("st-modal-open");
  }

  function injectCss() {
    if ($("scalpingTriggerCss")) return;
    const style = document.createElement("style");
    style.id = "scalpingTriggerCss";
    style.textContent =
      ".st-backdrop{position:fixed;inset:0;z-index:10050;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:16px}.st-backdrop[hidden]{display:none!important}.st-window{width:min(850px,100%);max-height:min(92vh,900px);overflow:hidden;background:#0b1118;border:1px solid #304154;border-radius:14px;box-shadow:0 24px 80px rgba(0,0,0,.55);color:#eaf0f6;display:flex;flex-direction:column}.st-header{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:16px 18px;border-bottom:1px solid #233142}.st-header h2{font-size:17px;margin:0 0 5px}.st-header p,.st-hint,.st-footnote{font-size:11px;color:#91a0b1;line-height:1.5;margin:0}.st-header button,.st-history-head button{padding:6px 10px}.st-body{overflow:auto;padding:14px 18px 18px;display:grid;gap:12px}.st-main-toggle{font-weight:800;display:flex;align-items:center;gap:8px}.st-scope{display:grid;gap:5px;padding:9px 11px;background:#101925;border:1px solid #243244;border-radius:9px}.st-scope label,.st-fields>label{display:grid;gap:4px;color:#9caabd;font-size:11px}.st-scope select,.st-fields input,.st-inline input[type=number]{width:100%;min-width:0;padding:7px;border:1px solid #304154;border-radius:6px;background:#080e15;color:#eaf0f6}.st-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.st-card{padding:11px;border:1px solid #263547;border-radius:10px;background:#0e151e;min-width:0}.st-check{display:flex;gap:7px;align-items:center;font-size:12px}.st-check input,.st-main-toggle input{width:auto;margin:0}.st-fields{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:10px}.st-fields .st-wide{grid-column:1/-1}.st-card .st-hint{margin-top:9px}.st-inline{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-top:9px}.st-inline>label:last-child{display:flex;align-items:center;gap:8px;color:#9caabd;font-size:11px}.st-inline input[type=number]{width:110px}.st-status{padding:9px 11px;border-radius:8px;background:#111d2a;border:1px solid #2c4560;color:#9acbff;font-size:11px;line-height:1.55;white-space:pre-line}.st-history{display:block!important;min-height:72px;border:1px solid #263547;border-radius:10px;overflow:hidden;background:#0b1118}.st-history-head{display:flex;align-items:center;justify-content:space-between;padding:9px 11px;background:#101925;font-size:12px}.st-history-head button{font-size:10px}.st-history-columns,.st-history-row{display:grid;grid-template-columns:minmax(120px,1.35fr) minmax(120px,1.2fr) minmax(105px,1fr) minmax(76px,.65fr) minmax(90px,.8fr);gap:8px;align-items:center}.st-history-columns{padding:7px 10px;background:#0c141e;color:#8998a9;font-size:10px}.st-history-list{display:block;max-height:260px;overflow:auto}.st-history-row{padding:8px 10px;border-top:1px solid #202d3b;font-size:10px;line-height:1.35}.st-history-cell{min-width:0;overflow-wrap:anywhere}.st-history-row .st-time{display:grid;gap:2px}.st-history-row time{color:#d0dbe6;font-variant-numeric:tabular-nums}.st-history-row small{color:#718296;font-size:9px}.st-history-direction{font-weight:800}.st-history-row .st-history-direction.is-long{color:#48d99a}.st-history-row .st-history-direction.is-short{color:#ff7b84}.st-history-price{font-variant-numeric:tabular-nums;font-weight:700}.st-history-detail{grid-column:1/-1;color:#8998a9;font-size:9px;overflow-wrap:anywhere}.st-empty{padding:12px;color:#8998a9;font-size:11px}.st-footnote{padding:0 2px}.st-modal-open{overflow:hidden}#scalpTriggerButton.is-active{border-color:#6e5522;color:#ffd166}#scalpTriggerButton.has-signal{box-shadow:inset 0 -2px #ffd166}@media(max-width:650px){.st-backdrop{padding:0;align-items:stretch}.st-window{width:100%;max-height:100vh;height:100%;border-radius:0}.st-header{padding:13px}.st-header h2{font-size:14px}.st-body{padding:12px}.st-grid{grid-template-columns:1fr}.st-fields{grid-template-columns:1fr 1fr}.st-inline{gap:10px}.st-history-columns{display:none}.st-history-list{max-height:220px}.st-history-row{grid-template-columns:1fr 1fr;gap:6px 10px}.st-history-row .st-time{grid-column:1/-1}}";
    document.head.appendChild(style);
  }

  function start() {
    injectCss();
    addOpenButton();
    buildModal();
    updateStatus();
    poll();
    window.setInterval(poll, 15000);
    window.addEventListener("okx-markets-loaded", updateStatus);
    window.addEventListener("okx-alert-marker", () => {});
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
