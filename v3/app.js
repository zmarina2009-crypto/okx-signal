(() => {
  "use strict";

  const TIMEFRAMES = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d", "1w"];
  const $ = id => document.getElementById(id);
  const state = {
    config: null,
    connected: false,
    dirty: false
  };

  function apiBase() {
    return $("server-url").value.trim().replace(/\/+$/, "");
  }

  function apiHeaders() {
    return {
      "authorization": "Bearer " + $("api-token").value,
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
      state.connected = true;
      state.dirty = false;
      $("monitor-enabled").disabled = false;
      $("monitor-enabled").checked = state.config.enabled === true;
      $("add-target").disabled = false;
      $("save-button").disabled = false;
      renderTargets();
      setConnectionStatus("Подключён", "ok");
      setSaveStatus("Настройки загружены. Изменения ещё не вносились.");
    } catch (error) {
      state.connected = false;
      setConnectionStatus("Ошибка подключения", "error");
      setSaveStatus(error.message);
      $("monitor-enabled").disabled = true;
      $("add-target").disabled = true;
      $("save-button").disabled = true;
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

  async function save() {
    if (!state.connected || !state.config) return;
    $("save-button").disabled = true;
    setSaveStatus("Сохраняю настройки…");
    try {
      state.config.enabled = $("monitor-enabled").checked;
      const payload = await request("/config", {
        method: "PUT",
        body: JSON.stringify({ config: state.config })
      });
      state.config = payload.config;
      state.dirty = false;
      renderTargets();
      setSaveStatus("Сохранено. Монитор будет обрабатывать только включённые комбинации.");
      setConnectionStatus("Подключён", "ok");
    } catch (error) {
      setSaveStatus("Не удалось сохранить: " + error.message);
    } finally {
      $("save-button").disabled = false;
    }
  }

  $("connect-button").addEventListener("click", connect);
  $("add-target").addEventListener("click", addTarget);
  $("save-button").addEventListener("click", save);
  $("monitor-enabled").addEventListener("change", markDirty);
  $("new-pair").addEventListener("keydown", event => {
    if (event.key === "Enter") addTarget();
  });
})();
