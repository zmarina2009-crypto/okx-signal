(() => {
  "use strict";

  const TIMEFRAMES = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d", "1w"];
  const $ = id => document.getElementById(id);
  const state = {
    config: null,
    connected: false,
    dirty: false,
    health: null
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
    setChecked("require-bos", scalping.requireBos);
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
    $("push-readiness").textContent = configured.push
      ? "VAPID-ключи обнаружены; ещё потребуется разрешение браузера и подписка"
      : "На сервере пока не настроены VAPID-ключи и подписка";
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
      state.config.targets = state.config.targets.map(target => ({ ...target, enabled: target.enabled !== false }));
      state.config.scalping = { ...SCALPING_DEFAULTS, ...(state.config.scalping || {}) };
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
      syncUiFromConfig();
      renderTargets();
      setConnectionStatus("Подключён", "ok");
      setSaveStatus("Настройки загружены. Изменения ещё не вносились.");
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
  $("monitor-enabled").addEventListener("change", markDirty);
  $("new-pair").addEventListener("keydown", event => {
    if (event.key === "Enter") addTarget();
  });

  const settingInputs = [
    "volume-rsi-enabled", "bos-enabled", "bos-alerts", "require-bos",
    "long-enabled", "short-enabled", "group-signals", "volume-period",
    "volume-multiplier", "rsi-length", "rsi-oversold", "rsi-overbought",
    "swing-length", "cooldown-seconds", "rsi-cluster-atr", "schedule-enabled",
    "schedule-timezone", "push-enabled", "telegram-enabled"
  ];
  settingInputs.forEach(id => {
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
