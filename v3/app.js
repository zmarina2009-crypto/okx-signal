(() => {
  "use strict";

  const TIMEFRAMES = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d", "1w"];
  const $ = id => document.getElementById(id);
  const state = {
    config: null,
    connected: false,
    dirty: false,
    health: null,
    vapidPublicKey: null,
    serviceWorkerRegistration: null,
    history: { signals: [], deliveries: [], totalSignals: 0, totalDeliveries: 0 },
    regimes: []
  };

  const SCALPING_DEFAULTS = {
    enabled: true,
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
    cooldownSeconds: 60,
    rsiClusterAtrMultiplier: 1,
    groupSignals: true
  };


  const MARKET_REGIME_DEFAULTS = {
    enabled: true, flatFilterEnabled: true, trendEnabled: true, reversalEnabled: true,
    smaPeriod: 21, slopeLookback: 5, atrPeriod: 14, volumePeriod: 20,
    maxFlatSlopePct: 0.035, maxFlatRangePct: 0.45, minAtrRatio: 0.65,
    minVolumeRatio: 1.15, reversalRsiLongMax: 45, reversalRsiShortMin: 55, swingLength: 3,
    marketStructureEnabled: true, volumeProfileEnabled: true, profileTimeframe: "auto",
    profileLookback: 100, profileBins: 32, valueAreaPct: 70, requireRetest: true,
    retestLookback: 8, retestToleranceAtr: 0.25
  };

  const SCHEDULE_DEFAULTS = {
    enabled: false,
    timezone: "Europe/Amsterdam",
    weekdays: [],
    windows: [],
    channels: { push: false, telegram: false }
  };

  function apiBase() {
    return $("server-url").value.trim().replace(/\/+$/, "");
  }

  function apiHeaders() {
    return {
      authorization: "Bearer " + $("api-token").value,
      "content-type": "application/json"
    };
  }

  function setConnectionStatus(text, kind = "idle") {
    const el = $("connection-state");
    el.textContent = text;
    el.className = "status status-" + kind;
  }

  function setSaveStatus(text) {
    $("save-status").textContent = text;
  }

  function markDirty() {
    state.dirty = true;
    setSaveStatus("Есть несохранённые изменения.");
    $("save-button").disabled = !state.connected;
  }

  function normalizePairInput(value) {
    let pair = String(value || "").trim().toUpperCase();
    if (!pair) throw new Error("Укажи торговую пару.");
    if (/^[A-Z0-9]{1,20}$/.test(pair)) pair += "-USDT-SWAP";
    else if (/^[A-Z0-9]{1,20}USDT$/.test(pair)) pair = pair.slice(0, -4) + "-USDT-SWAP";
    else if (/^[A-Z0-9]{1,20}-USDT$/.test(pair)) pair += "-SWAP";
    if (!/^[A-Z0-9]{1,20}-USDT-SWAP$/.test(pair)) {
      throw new Error("Поддерживаются только бессрочные контракты OKX с USDT, например BTC или BTC-USDT-SWAP.");
    }
    return pair;
  }

  function createElement(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function formatJournalDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "Время неизвестно";
    return date.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "medium" });
  }

  function notificationStatusLabel(status) {
    const labels = {
      sent: "Отправлено",
      failed: "Ошибка",
      pending: "Ожидает",
      skipped: "Не отправлялось",
      expired: "Истёк срок",
      outside_notification_window: "Вне расписания",
      outside_current_notification_window: "Окно закрыто",
      expired_signal: "Сигнал устарел",
      max_delivery_attempts_reached: "Лимит попыток"
    };
    return labels[status] || status || "Нет статуса";
  }

  function renderHistory() {
    const list = $("signal-journal");
    const filter = $("history-filter").value;
    const signals = Array.isArray(state.history.signals) ? state.history.signals : [];
    $("journal-counts").textContent =
      "Сигналов: " + state.history.totalSignals +
      " · Попыток доставки: " + state.history.totalDeliveries;

    const filtered = signals.filter(signal => {
      const channels = Array.isArray(signal.notificationChannels) ? signal.notificationChannels : [];
      if (filter === "sent") return signal.notificationStatus === "sent" || channels.some(item => item.status === "sent");
      if (filter === "failed") return signal.notificationStatus === "failed" || channels.some(item => item.status === "failed");
      if (filter === "pending") return signal.notificationStatus === "pending";
      if (filter === "skipped") return ["skipped", "expired", "outside_notification_window", "outside_current_notification_window", "expired_signal"].includes(signal.notificationStatus);
      return true;
    });

    list.replaceChildren();
    if (!filtered.length) {
      list.append(createElement("div", "empty-state", signals.length
        ? "По выбранному фильтру сигналов нет."
        : "Сигналов пока нет. Они появятся после включения монитора и выбора пар."));
      return;
    }

    filtered.forEach(signal => {
      const card = createElement("article", "journal-card");
      const top = createElement("div", "journal-card-top");
      const identity = createElement("div", "journal-identity");
      identity.append(
        createElement("strong", "journal-pair", signal.pair || "—"),
        createElement("span", "tf-chip", signal.tf || "—")
      );
      const direction = createElement("span",
        "direction-chip " + (signal.direction === "LONG" ? "direction-long" : "direction-short"),
        signal.direction || "—"
      );
      top.append(identity, direction);

      const details = createElement("div", "journal-details");
      details.append(
        createElement("span", "", formatJournalDate(signal.detectedAt || signal.recordedAt || signal.candleTs)),
        createElement("span", "", "Цена: " + (Number.isFinite(Number(signal.price))
          ? Number(signal.price).toLocaleString("en-US", { maximumFractionDigits: 8 })
          : "—")),
        createElement("span", "", signal.label || signal.kind || "Сигнал")
      );

      const message = createElement("p", "journal-message", signal.message || "Детали сигнала не указаны.");
      const status = createElement("div", "journal-status-row");
      const overall = createElement("span", "delivery-status delivery-" + (signal.notificationStatus || "unknown"),
        "Доставка: " + notificationStatusLabel(signal.notificationStatus));
      status.append(overall);

      const channels = Array.isArray(signal.notificationChannels) ? signal.notificationChannels : [];
      channels.forEach(channel => {
        const label = (channel.channel === "push" ? "Push" : channel.channel === "telegram" ? "Telegram" : channel.channel || "Канал");
        const chip = createElement("span", "delivery-status delivery-" + (channel.status || "unknown"),
          label + ": " + notificationStatusLabel(channel.status));
        if (channel.error) chip.title = channel.error;
        status.append(chip);
      });

      if (Number(signal.mergedCount) > 0) {
        status.append(createElement("span", "delivery-status delivery-merged", "Объединено повторов: " + signal.mergedCount));
      }
      card.append(top, details, message, status);
      list.append(card);
    });
  }

  async function refreshHistory() {
    if (!state.connected) return;
    const button = $("refresh-history");
    button.disabled = true;
    try {
      const result = await request("/history?limit=100", { method: "GET" });
      state.history = {
        signals: Array.isArray(result.signals) ? result.signals : [],
        deliveries: Array.isArray(result.deliveries) ? result.deliveries : [],
        totalSignals: Number(result.totalSignals) || 0,
        totalDeliveries: Number(result.totalDeliveries) || 0
      };
      renderHistory();
      $("history-updated").textContent = "Обновлено: " + new Date().toLocaleTimeString("ru-RU");
    } catch (error) {
      $("history-updated").textContent = "Ошибка загрузки: " + error.message;
    } finally {
      button.disabled = !state.connected;
    }
  }


  function renderRegimes() {
    const list = $("regime-list");
    const items = Array.isArray(state.regimes) ? state.regimes : [];
    $("regime-count").textContent = items.length ? items.length + " оценок" : "Нет данных";
    list.replaceChildren();
    if (!items.length) {
      list.append(createElement("div", "empty-state", "Состояния ещё не получены. Включи монитор и дождись цикла опроса."));
      return;
    }
    const labels = { TREND: "Продолжение тренда", REVERSAL: "Возможный разворот", FLAT: "Флет · вход запрещён", WAIT: "Ожидание · вход запрещён", DISABLED: "Анализ отключён" };
    items.forEach(item => {
      const card = createElement("article", "journal-card");
      const top = createElement("div", "journal-card-top");
      const identity = createElement("div", "journal-identity");
      identity.append(createElement("strong", "journal-pair", item.pair || "—"), createElement("span", "tf-chip", item.tf || "—"));
      const status = createElement("span", "delivery-status " + (item.state === "FLAT" ? "delivery-failed" : item.state === "TREND" || item.state === "REVERSAL" ? "delivery-sent" : "delivery-pending"), labels[item.state] || item.state);
      top.append(identity, status);
      const metrics = item.metrics || {};
      const details = createElement("div", "journal-details");
      const structure = metrics.choch || metrics.bos;
      const profile = metrics.volumeProfile || {};
      details.append(
        createElement("span", "", "Направление: " + (item.direction || "—")),
        createElement("span", "", "SMA: " + (Number.isFinite(Number(metrics.sma)) ? Number(metrics.sma).toPrecision(7) : "—")),
        createElement("span", "", "ATR: " + (Number.isFinite(Number(metrics.atrPercent)) ? Number(metrics.atrPercent).toFixed(3) + "%" : "—")),
        createElement("span", "", "Объём: " + (Number.isFinite(Number(metrics.volumeRatio)) ? Number(metrics.volumeRatio).toFixed(2) + "×" : "—")),
        createElement("span", "", "Структура: " + (structure ? structure.kind + " " + structure.direction : "нет подтверждения")),
        createElement("span", "", "Ретест: " + (metrics.retest ? "да" : "нет")),
        createElement("span", "", "VP POC: " + (profile.ready ? Number(profile.poc).toPrecision(7) : "нет данных")),
        createElement("span", "", "VP Value Area: " + (profile.ready ? Number(profile.val).toPrecision(7) + " – " + Number(profile.vah).toPrecision(7) : "—"))
      );
      const reasons = createElement("p", "journal-message", (item.reasons || []).join(" · ") || "Ожидается подтверждение.");
      card.append(top, details, reasons);
      list.append(card);
    });
  }

  async function refreshRegimes() {
    if (!state.connected) return;
    const button = $("refresh-regimes");
    button.disabled = true;
    try {
      const result = await request("/regimes", { method: "GET" });
      state.regimes = Array.isArray(result.regimes) ? result.regimes : [];
      renderRegimes();
    } catch (error) {
      $("regime-list").replaceChildren(createElement("div", "empty-state", "Не удалось загрузить состояния: " + error.message));
    } finally {
      button.disabled = !state.connected;
    }
  }

  function base64UrlToUint8Array(base64Url) {
    const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
    const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    return Uint8Array.from(raw, char => char.charCodeAt(0));
  }

  function pushScopePath() {
    return new URL("./", window.location.href).pathname;
  }

  async function preparePushServiceWorker() {
    if (!window.isSecureContext || !("serviceWorker" in navigator)) return null;
    const registration = await navigator.serviceWorker.register(new URL("./sw.js", window.location.href), {
      scope: pushScopePath()
    });
    await navigator.serviceWorker.ready;
    state.serviceWorkerRegistration = registration;
    return registration;
  }

  async function refreshPushDeviceStatus() {
    const subscribe = $("push-subscribe");
    const unsubscribe = $("push-unsubscribe");
    if (!state.connected) {
      subscribe.disabled = true;
      unsubscribe.disabled = true;
      return;
    }
    if (!window.isSecureContext || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      const isAppleMobile = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      $("push-device-status").textContent = isAppleMobile
        ? "На iPhone/iPad добавь приложение на экран «Домой» и открой его с этого значка. Если Push всё ещё недоступен, проверь обновление iOS/iPadOS."
        : "Этот браузер или контекст не поддерживает Web Push. Открой приложение по HTTPS в актуальном браузере.";
      subscribe.disabled = true;
      unsubscribe.disabled = true;
      return;
    }
    if (!state.vapidPublicKey) {
      $("push-device-status").textContent = "Сервер пока не настроен для Push: отсутствует VAPID public key.";
      subscribe.disabled = true;
      unsubscribe.disabled = true;
      return;
    }
    try {
      const registration = state.serviceWorkerRegistration ||
        await navigator.serviceWorker.getRegistration(pushScopePath());
      const subscription = await registration?.pushManager?.getSubscription();
      if (subscription) {
        $("push-device-status").textContent = "Это устройство уже подписано на Push. Разрешение браузера: " + Notification.permission + ".";
        subscribe.disabled = true;
        unsubscribe.disabled = false;
      } else {
        const permissionText = Notification.permission === "denied"
          ? "Разрешение заблокировано в настройках браузера."
          : Notification.permission === "granted"
            ? "Разрешение браузера выдано, подписка ещё не создана."
            : "После нажатия браузер запросит разрешение на уведомления.";
        $("push-device-status").textContent = permissionText + " Подписка оформляется отдельно для каждого устройства.";
        subscribe.disabled = Notification.permission === "denied";
        unsubscribe.disabled = true;
      }
    } catch (error) {
      $("push-device-status").textContent = "Не удалось проверить Push-подписку: " + error.message;
      subscribe.disabled = false;
      unsubscribe.disabled = true;
    }
  }

  async function subscribePushOnThisDevice() {
    const button = $("push-subscribe");
    button.disabled = true;
    $("push-device-status").textContent = "Регистрирую Push для этого устройства…";
    try {
      if (!state.connected || !state.vapidPublicKey) throw new Error("Сначала подключись к настроенному Push-серверу.");
      if (!window.isSecureContext || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        throw new Error("Web Push недоступен в этом браузере или соединение не защищено HTTPS.");
      }
      const isAppleMobile = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      const isInstalledApp = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
      if (isAppleMobile && !isInstalledApp) {
        throw new Error("На iPhone/iPad сначала нажми «Поделиться» → «На экран Домой», открой приложение с появившегося значка и повтори подключение Push.");
      }

      // The scoped service worker is prepared when the user connects to the server.
      // Keep the permission prompt and subscribe operation in this explicit button flow.
      const registration = state.serviceWorkerRegistration ||
        await navigator.serviceWorker.getRegistration(pushScopePath());
      if (!registration) throw new Error("Service Worker ещё не готов. Перезагрузи страницу и повтори подключение.");

      let permission = Notification.permission;
      if (permission === "default") permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Разрешение на уведомления не выдано. Проверь настройки сайта в браузере.");

      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToUint8Array(state.vapidPublicKey)
        });
      }

      const saved = await request("/push-subscriptions", {
        method: "POST",
        body: JSON.stringify({ subscription: subscription.toJSON() })
      });
      state.health = { ...(state.health || {}), registeredPushDevices: saved.subscriptions };
      updateChannelReadiness();
      $("push-device-status").textContent = "Готово: это устройство зарегистрировано. Для телефона повтори подключение в браузере телефона.";
      await refreshPushDeviceStatus();
    } catch (error) {
      $("push-device-status").textContent = "Не удалось подключить Push: " + error.message;
      button.disabled = false;
    }
  }

  async function unsubscribePushOnThisDevice() {
    const button = $("push-unsubscribe");
    button.disabled = true;
    $("push-device-status").textContent = "Отключаю Push на этом устройстве…";
    try {
      const registration = state.serviceWorkerRegistration ||
        await navigator.serviceWorker.getRegistration(pushScopePath());
      const subscription = await registration?.pushManager?.getSubscription();
      if (!subscription) {
        $("push-device-status").textContent = "На этом устройстве активной Push-подписки нет.";
        await refreshPushDeviceStatus();
        return;
      }
      const deleted = await request("/push-subscriptions", {
        method: "DELETE",
        body: JSON.stringify({ endpoint: subscription.endpoint })
      });
      await subscription.unsubscribe();
      state.health = { ...(state.health || {}), registeredPushDevices: deleted.subscriptions };
      updateChannelReadiness();
      $("push-device-status").textContent = "Push отключён на этом устройстве. Остальные зарегистрированные устройства не затронуты.";
      await refreshPushDeviceStatus();
    } catch (error) {
      $("push-device-status").textContent = "Не удалось отключить Push: " + error.message;
      button.disabled = false;
    }
  }

  function renderTargets() {
    const list = $("targets-list");
    list.replaceChildren();
    const targets = state.config?.targets || [];
    $("target-count").textContent = targets.length + (targets.length === 1 ? " позиция" : " позиций");
    if (!targets.length) {
      list.append(createElement("div", "empty-state", "Пока нет выбранных пар. Добавь первую комбинацию ниже."));
      return;
    }

    targets.forEach((target, index) => {
      const row = createElement("div", "target-row" + (target.enabled === false ? " is-disabled" : ""));
      const pair = createElement("div", "target-pair", target.pair);
      pair.append(createElement("span", "target-market", "OKX · USDT Perpetual"));
      const timeframe = createElement("span", "tf-chip", target.tf);

      const toggleLabel = createElement("label", "target-switch");
      const checkbox = createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = target.enabled !== false;
      checkbox.setAttribute("aria-label", "Включить " + target.pair + " " + target.tf);
      const track = createElement("span", "switch-track");
      const toggleText = createElement("span", "", checkbox.checked ? "Включено" : "Пауза");
      checkbox.addEventListener("change", () => {
        target.enabled = checkbox.checked;
        toggleText.textContent = checkbox.checked ? "Включено" : "Пауза";
        row.classList.toggle("is-disabled", !checkbox.checked);
        markDirty();
      });
      toggleLabel.append(checkbox, track, toggleText);

      const remove = createElement("button", "remove-button", "×");
      remove.type = "button";
      remove.title = "Удалить комбинацию";
      remove.setAttribute("aria-label", "Удалить " + target.pair + " " + target.tf);
      remove.addEventListener("click", () => {
        state.config.targets.splice(index, 1);
        renderTargets();
        markDirty();
      });

      row.append(pair, timeframe, toggleLabel, remove);
      list.append(row);
    });
  }

  function renderScheduleWindows(windows = []) {
    const list = $("schedule-windows");
    list.replaceChildren();
    if (!windows.length) {
      list.append(createElement("div", "empty-state", "Временные окна пока не добавлены. Добавь, например, 09:00–17:00."));
      return;
    }

    windows.forEach((window, index) => {
      const row = createElement("div", "time-window-row");
      const startLabel = createElement("label", "field window-time-field");
      startLabel.append(createElement("span", "", "Начало"));
      const start = createElement("input");
      start.type = "time";
      start.required = true;
      start.value = window.start || "09:00";
      start.dataset.windowPart = "start";
      startLabel.append(start);

      const separator = createElement("span", "window-separator", "—");

      const endLabel = createElement("label", "field window-time-field");
      endLabel.append(createElement("span", "", "Окончание"));
      const end = createElement("input");
      end.type = "time";
      end.required = true;
      end.value = window.end || "17:00";
      end.dataset.windowPart = "end";
      endLabel.append(end);

      const remove = createElement("button", "remove-button window-remove", "×");
      remove.type = "button";
      remove.title = "Удалить временное окно";
      remove.setAttribute("aria-label", "Удалить временное окно " + (index + 1));
      remove.addEventListener("click", () => {
        const next = collectWindows().filter((_, i) => i !== index);
        renderScheduleWindows(next);
        markDirty();
      });

      row.append(startLabel, separator, endLabel, remove);
      list.append(row);
    });
  }

  function collectWindows() {
    return [...$("schedule-windows").querySelectorAll(".time-window-row")].map(row => ({
      start: row.querySelector('[data-window-part="start"]').value,
      end: row.querySelector('[data-window-part="end"]').value
    }));
  }

  function setChecked(id, value) {
    $(id).checked = value === true;
  }

  function setValue(id, value) {
    $(id).value = String(value ?? "");
  }

  function syncBosControlAvailability() {
    const enabled = $("bos-enabled").checked;
    $("bos-alerts").disabled = !enabled;
    $("require-bos").disabled = !enabled;
    if (!enabled) $("require-bos").checked = false;
  }

  function syncUiFromConfig() {
    const scalping = { ...SCALPING_DEFAULTS, ...(state.config.scalping || {}) };
    const schedule = {
      ...SCHEDULE_DEFAULTS,
      ...(state.config.notificationSchedule || {}),
      channels: {
        ...SCHEDULE_DEFAULTS.channels,
        ...(state.config.notificationSchedule?.channels || {})
      }
    };

    $("monitor-enabled").checked = state.config.enabled === true;

    setChecked("volume-rsi-enabled", scalping.volumeRsiEnabled);
    setChecked("bos-enabled", scalping.bosEnabled);
    setChecked("bos-alerts", scalping.bosAlerts);
    setChecked("require-bos", scalping.requireBos && scalping.bosEnabled);
    syncBosControlAvailability();
    setChecked("long-enabled", scalping.longEnabled);
    setChecked("short-enabled", scalping.shortEnabled);
    setChecked("group-signals", scalping.groupSignals);
    setValue("volume-period", scalping.volumePeriod);
    setValue("volume-multiplier", scalping.volumeMultiplier);
    setValue("rsi-length", scalping.rsiLength);
    setValue("rsi-oversold", scalping.rsiOversold);
    setValue("rsi-overbought", scalping.rsiOverbought);
    setValue("swing-length", scalping.swingLength);
    setValue("cooldown-seconds", scalping.cooldownSeconds);
    setValue("rsi-cluster-atr", scalping.rsiClusterAtrMultiplier);


    const regime = { ...MARKET_REGIME_DEFAULTS, ...(state.config.marketRegime || {}) };
    setChecked("regime-enabled", regime.enabled);
    setChecked("regime-flat-filter", regime.flatFilterEnabled);
    setChecked("regime-trend-enabled", regime.trendEnabled);
    setChecked("regime-reversal-enabled", regime.reversalEnabled);
    setChecked("regime-structure-enabled", regime.marketStructureEnabled);
    setChecked("regime-profile-enabled", regime.volumeProfileEnabled);
    setChecked("regime-retest-required", regime.requireRetest);
    setValue("regime-sma-period", regime.smaPeriod);
    setValue("regime-flat-slope", regime.maxFlatSlopePct);
    setValue("regime-flat-range", regime.maxFlatRangePct);
    setValue("regime-min-atr", regime.minAtrRatio);
    setValue("regime-volume-ratio", regime.minVolumeRatio);
    setValue("regime-rsi-long", regime.reversalRsiLongMax);
    setValue("regime-rsi-short", regime.reversalRsiShortMin);
    setValue("regime-profile-timeframe", regime.profileTimeframe);
    setValue("regime-profile-lookback", regime.profileLookback);
    setValue("regime-profile-bins", regime.profileBins);
    setValue("regime-value-area", regime.valueAreaPct);
    setValue("regime-retest-lookback", regime.retestLookback);
    setValue("regime-retest-tolerance", regime.retestToleranceAtr);
    renderRegimes();

    setChecked("schedule-enabled", schedule.enabled);
    setValue("schedule-timezone", schedule.timezone);
    document.querySelectorAll("[data-weekday]").forEach(input => {
      input.checked = schedule.weekdays.includes(Number(input.dataset.weekday));
    });
    renderScheduleWindows(schedule.windows);
    setChecked("push-enabled", schedule.channels.push);
    setChecked("telegram-enabled", schedule.channels.telegram);
    updateChannelReadiness();
  }

  function updateChannelReadiness() {
    const configured = state.health?.channelsConfigured || {};
    const deviceCount = Number(state.health?.registeredPushDevices) || 0;
    $("push-readiness").textContent = configured.push
      ? "VAPID настроен · устройств подключено: " + deviceCount
      : "На сервере пока не настроены VAPID-ключи и VAPID contact";
    $("telegram-readiness").textContent = configured.telegram
      ? "Настройки Telegram обнаружены на сервере"
      : "На сервере нужны TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID";
  }

  async function request(path, options = {}) {
    const base = apiBase();
    if (!/^https:\/\//i.test(base)) throw new Error("Укажи полный HTTPS-адрес сервера Railway.");
    const response = await fetch(base + path, {
      ...options,
      headers: { ...apiHeaders(), ...(options.headers || {}) }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Ошибка сервера: HTTP " + response.status);
    return payload;
  }

  async function connect() {
    $("connect-button").disabled = true;
    setConnectionStatus("Подключаемся…");
    try {
      const result = await request("/config", { method: "GET" });
      if (!result.config || !Array.isArray(result.config.targets)) throw new Error("Сервер вернул неизвестный формат настроек.");
      state.config = result.config;
      state.vapidPublicKey = result.vapidPublicKey || null;
      state.config.targets = state.config.targets.map(target => ({ ...target, enabled: target.enabled !== false }));
      state.config.scalping = { ...SCALPING_DEFAULTS, ...(state.config.scalping || {}) };
      state.config.marketRegime = { ...MARKET_REGIME_DEFAULTS, ...(state.config.marketRegime || {}) };
      state.config.notificationSchedule = {
        ...SCHEDULE_DEFAULTS,
        ...(state.config.notificationSchedule || {}),
        channels: {
          ...SCHEDULE_DEFAULTS.channels,
          ...(state.config.notificationSchedule?.channels || {})
        }
      };
      try {
        state.health = await request("/health", { method: "GET" });
      } catch {
        state.health = null;
      }
      state.connected = true;
      state.dirty = false;
      ["monitor-enabled", "add-target", "save-button"].forEach(id => { $(id).disabled = false; });
      try {
        await preparePushServiceWorker();
      } catch (serviceWorkerError) {
        state.serviceWorkerRegistration = null;
        $("push-device-status").textContent = "Не удалось подготовить Push Service Worker: " + serviceWorkerError.message;
      }
      syncUiFromConfig();
      renderTargets();
      setConnectionStatus("Подключён", "ok");
      setSaveStatus("Настройки загружены. Изменения ещё не вносились.");
      $("refresh-history").disabled = false;
      await Promise.all([refreshHistory(), refreshPushDeviceStatus(), refreshRegimes()]);
    } catch (error) {
      state.connected = false;
      setConnectionStatus("Ошибка подключения", "error");
      setSaveStatus(error.message);
      ["monitor-enabled", "add-target", "save-button"].forEach(id => { $(id).disabled = true; });
    } finally {
      $("connect-button").disabled = false;
    }
  }

  function addTarget() {
    if (!state.connected || !state.config) return;
    try {
      const pair = normalizePairInput($("new-pair").value);
      const tf = $("new-timeframe").value;
      if (!TIMEFRAMES.includes(tf)) throw new Error("Выбран неподдерживаемый таймфрейм.");
      const duplicate = state.config.targets.some(target => target.pair === pair && target.tf === tf);
      if (duplicate) throw new Error("Такая комбинация пары и таймфрейма уже есть в списке.");
      if (state.config.targets.length >= 100) throw new Error("Можно добавить не более 100 комбинаций.");
      const distinctPairs = new Set(state.config.targets.map(target => target.pair));
      distinctPairs.add(pair);
      if (distinctPairs.size > 20) throw new Error("Можно использовать не более 20 разных пар.");
      state.config.targets.push({ pair, tf, enabled: true });
      $("new-pair").value = pair;
      renderTargets();
      markDirty();
    } catch (error) {
      setSaveStatus(error.message);
    }
  }

  function readNumber(id) {
    const input = $(id);
    if (!input.checkValidity()) {
      input.reportValidity();
      throw new Error("Проверь значение параметра: " + input.parentElement.querySelector("span").textContent);
    }
    return Number(input.value);
  }

  function collectScalpingSettings() {
    return {
      ...state.config.scalping,
      volumeRsiEnabled: $("volume-rsi-enabled").checked,
      bosEnabled: $("bos-enabled").checked,
      bosAlerts: $("bos-alerts").checked,
      requireBos: $("require-bos").checked,
      longEnabled: $("long-enabled").checked,
      shortEnabled: $("short-enabled").checked,
      groupSignals: $("group-signals").checked,
      volumePeriod: readNumber("volume-period"),
      volumeMultiplier: readNumber("volume-multiplier"),
      rsiLength: readNumber("rsi-length"),
      rsiOversold: readNumber("rsi-oversold"),
      rsiOverbought: readNumber("rsi-overbought"),
      swingLength: readNumber("swing-length"),
      cooldownSeconds: readNumber("cooldown-seconds"),
      rsiClusterAtrMultiplier: readNumber("rsi-cluster-atr")
    };
  }


  function collectMarketRegimeSettings() {
    return {
      ...state.config.marketRegime,
      enabled: $("regime-enabled").checked,
      flatFilterEnabled: $("regime-flat-filter").checked,
      trendEnabled: $("regime-trend-enabled").checked,
      reversalEnabled: $("regime-reversal-enabled").checked,
      marketStructureEnabled: $("regime-structure-enabled").checked,
      volumeProfileEnabled: $("regime-profile-enabled").checked,
      requireRetest: $("regime-retest-required").checked,
      smaPeriod: readNumber("regime-sma-period"),
      maxFlatSlopePct: readNumber("regime-flat-slope"),
      maxFlatRangePct: readNumber("regime-flat-range"),
      minAtrRatio: readNumber("regime-min-atr"),
      minVolumeRatio: readNumber("regime-volume-ratio"),
      reversalRsiLongMax: readNumber("regime-rsi-long"),
      reversalRsiShortMin: readNumber("regime-rsi-short"),
      profileTimeframe: $("regime-profile-timeframe").value,
      profileLookback: readNumber("regime-profile-lookback"),
      profileBins: readNumber("regime-profile-bins"),
      valueAreaPct: readNumber("regime-value-area"),
      retestLookback: readNumber("regime-retest-lookback"),
      retestToleranceAtr: readNumber("regime-retest-tolerance")
    };
  }

  function collectScheduleSettings() {
    const timezone = $("schedule-timezone").value.trim();
    if (!timezone) throw new Error("Укажи часовой пояс расписания, например Europe/Amsterdam.");
    const weekdays = [...document.querySelectorAll("[data-weekday]:checked")]
      .map(input => Number(input.dataset.weekday));
    const windows = collectWindows();
    if (windows.some(window => !window.start || !window.end)) {
      throw new Error("Заполни время начала и окончания во всех временных окнах.");
    }
    return {
      enabled: $("schedule-enabled").checked,
      timezone,
      weekdays,
      windows,
      channels: {
        push: $("push-enabled").checked,
        telegram: $("telegram-enabled").checked
      }
    };
  }

  async function save() {
    if (!state.connected || !state.config) return;
    $("save-button").disabled = true;
    setSaveStatus("Проверяю и сохраняю настройки…");
    try {
      state.config.enabled = $("monitor-enabled").checked;
      state.config.scalping = collectScalpingSettings();
      state.config.marketRegime = collectMarketRegimeSettings();
      state.config.notificationSchedule = collectScheduleSettings();
      const payload = await request("/config", {
        method: "PUT",
        body: JSON.stringify({ config: state.config })
      });
      state.config = payload.config;
      state.dirty = false;
      syncUiFromConfig();
      renderTargets();
      const schedule = state.config.notificationSchedule;
      if (schedule.enabled && (!schedule.weekdays.length || !schedule.windows.length)) {
        setSaveStatus("Сохранено, но отправка не начнётся: выбери хотя бы один день и временное окно.");
      } else if (!schedule.channels.push && !schedule.channels.telegram) {
        setSaveStatus("Сохранено. Каналы уведомлений выключены — сигналы будут записываться в журнал без отправки.");
      } else {
        setSaveStatus("Настройки сохранены. Отправка возможна только в выбранные дни и временные окна.");
      }
      setConnectionStatus("Подключён", "ok");
    } catch (error) {
      setSaveStatus("Не удалось сохранить: " + error.message);
    } finally {
      $("save-button").disabled = false;
    }
  }

  function setWeekdays(days) {
    document.querySelectorAll("[data-weekday]").forEach(input => {
      input.checked = days.includes(Number(input.dataset.weekday));
    });
    markDirty();
  }

  $("connect-button").addEventListener("click", connect);
  $("add-target").addEventListener("click", addTarget);
  $("save-button").addEventListener("click", save);
  $("refresh-history").addEventListener("click", refreshHistory);
  $("refresh-regimes").addEventListener("click", refreshRegimes);
  $("history-filter").addEventListener("change", renderHistory);
  $("push-subscribe").addEventListener("click", subscribePushOnThisDevice);
  $("push-unsubscribe").addEventListener("click", unsubscribePushOnThisDevice);
  $("monitor-enabled").addEventListener("change", markDirty);
  $("new-pair").addEventListener("keydown", event => {
    if (event.key === "Enter") addTarget();
  });

  const settingInputs = [
    "volume-rsi-enabled", "bos-enabled", "bos-alerts", "require-bos",
    "long-enabled", "short-enabled", "group-signals", "volume-period",
    "volume-multiplier", "rsi-length", "rsi-oversold", "rsi-overbought",
    "swing-length", "cooldown-seconds", "rsi-cluster-atr", "regime-enabled", "regime-flat-filter",
    "regime-trend-enabled", "regime-reversal-enabled", "regime-structure-enabled", "regime-profile-enabled", "regime-retest-required", "regime-sma-period", "regime-flat-slope",
    "regime-flat-range", "regime-min-atr", "regime-volume-ratio", "regime-rsi-long", "regime-rsi-short", "regime-profile-timeframe", "regime-profile-lookback", "regime-profile-bins", "regime-value-area", "regime-retest-lookback", "regime-retest-tolerance", "schedule-enabled",
    "schedule-timezone", "push-enabled", "telegram-enabled"
  ];
  $("bos-enabled").addEventListener("change", () => {
    syncBosControlAvailability();
    markDirty();
  });
  settingInputs.filter(id => id !== "bos-enabled").forEach(id => {
    $(id).addEventListener("change", markDirty);
    if ($(id).tagName === "INPUT" && $(id).type === "text") $(id).addEventListener("input", markDirty);
  });
  document.querySelectorAll("[data-weekday]").forEach(input => input.addEventListener("change", markDirty));
  $("schedule-windows").addEventListener("change", markDirty);
  $("schedule-windows").addEventListener("input", markDirty);

  $("add-window").addEventListener("click", () => {
    const windows = collectWindows();
    if (windows.length >= 10) {
      setSaveStatus("Можно добавить не более 10 временных окон.");
      return;
    }
    windows.push({ start: "09:00", end: "17:00" });
    renderScheduleWindows(windows);
    markDirty();
  });
  $("weekdays-preset").addEventListener("click", () => setWeekdays([1, 2, 3, 4, 5]));
  $("all-days-preset").addEventListener("click", () => setWeekdays([1, 2, 3, 4, 5, 6, 7]));
  $("clear-days-preset").addEventListener("click", () => setWeekdays([]));
})();
