/* OKX Signal Pro — collapsible sections with persistent per-user preferences */
(function () {
  "use strict";
  const KEY = "okx_v2_collapsed_blocks";
  const $ = (id) => document.getElementById(id);
  const readState = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
      return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
    } catch (_) { return {}; }
  };
  const state = readState();

  function saveState() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {}
  }

  function injectCss() {
    if ($("collapsiblePanelsCss")) return;
    const style = document.createElement("style");
    style.id = "collapsiblePanelsCss";
    style.textContent = [
      ".collapse-heading{display:flex!important;align-items:center!important;justify-content:space-between!important;gap:10px!important;width:100%}",
      ".collapse-heading>span:first-child{min-width:0;flex:1}",
      ".collapse-toggle{display:inline-flex;align-items:center;justify-content:center;flex:0 0 32px;width:32px;min-width:32px;height:29px;padding:0!important;border:1px solid #263545!important;border-radius:8px!important;background:#101823!important;color:#a6b2c0!important;font-size:17px!important;line-height:1!important}",
      ".collapse-toggle:hover{border-color:#55a8ff!important;color:#eaf0f6!important}",
      ".collapsible-panel.is-collapsed{padding-bottom:8px}",
      ".collapsible-panel.is-collapsed>.collapse-content[hidden]{display:none!important}",
      ".collapse-panel-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}",
      ".collapse-panel-head h2{margin:0;flex:1}",
      "@media(max-width:520px){.collapse-toggle{height:32px;flex-basis:34px;width:34px;min-width:34px}}"
    ].join("");
    document.head.appendChild(style);
  }

  function decorateHeading(heading, key, panel) {
    if (!heading || heading.dataset.collapseReady === "1") return null;
    // Preserve existing heading markup while keeping the toggle accessible.
    const label = document.createElement("span");
    while (heading.firstChild) label.appendChild(heading.firstChild);
    heading.appendChild(label);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "collapse-toggle";
    button.dataset.collapseKey = key;
    button.setAttribute("aria-controls", panel.id || ("collapse-" + key));
    button.addEventListener("click", () => setCollapsed(key, panel, !state[key]));
    heading.appendChild(button);
    heading.classList.add("collapse-heading");
    heading.dataset.collapseReady = "1";
    return button;
  }

  function setButton(button, key) {
    if (!button) return;
    const collapsed = !!state[key];
    button.textContent = collapsed ? "⌄" : "⌃";
    button.setAttribute("aria-expanded", String(!collapsed));
    button.setAttribute("aria-label", (collapsed ? "Развернуть блок: " : "Свернуть блок: ") + (button.dataset.collapseTitle || key));
    button.title = collapsed ? "Развернуть блок" : "Свернуть блок";
  }

  function setCollapsed(key, panel, collapsed, contents, button) {
    state[key] = !!collapsed;
    saveState();
    const body = contents || [];
    body.forEach(node => {
      if (!node) return;
      node.hidden = !!collapsed;
      node.classList.toggle("collapse-content", true);
    });
    panel.classList.toggle("is-collapsed", !!collapsed);
    panel.classList.toggle("collapsible-panel", true);
    setButton(button || panel.querySelector('[data-collapse-key="' + key + '"]'), key);
  }

  function setupPanel(panel, key, title, headerNode) {
    if (!panel || panel.dataset.collapsibleReady === "1") return;
    panel.dataset.collapsibleReady = "1";
    if (!panel.id) panel.id = "collapse-" + key;
    let header = headerNode || panel.querySelector(":scope > h2") || panel.querySelector(":scope > .ci-head");
    if (!header) {
      // Blocks such as the working-list controls do not have a heading yet.
      const titleBar = document.createElement("div");
      titleBar.className = "collapse-panel-head";
      const h = document.createElement("h2");
      h.textContent = title;
      titleBar.appendChild(h);
      panel.insertBefore(titleBar, panel.firstChild);
      header = titleBar;
    }
    const heading = header.matches("h2") ? header : header.querySelector("h2");
    let button = null;
    if (heading) {
      button = decorateHeading(heading, key, panel);
      if (button) button.dataset.collapseTitle = title;
    }
    const contents = Array.from(panel.children).filter(node => node !== header);
    setCollapsed(key, panel, !!state[key], contents, button);
  }
  function setupSignalPanel() {
    const panel = $("signalPanel"), body = $("signalBody"), button = $("signalCollapse");
    if (!panel || !body || !button || panel.dataset.collapsibleReady === "1") return;
    panel.dataset.collapsibleReady = "1";
    panel.classList.add("collapsible-panel");
    button.dataset.collapseKey = "signal-summary";
    button.dataset.collapseTitle = "Сигналы";
    button.classList.add("collapse-toggle");
    button.addEventListener("click", () => setCollapsed("signal-summary", panel, !state["signal-summary"], [body], button));
    // Override the previous non-persistent inline-module handler and restore the saved state.
    button.onclick = null;
    setCollapsed("signal-summary", panel, !!state["signal-summary"], [body], button);
  }

  function setupFilters() {
    const panel = Array.from(document.querySelectorAll(".panel")).find(p =>
      p.querySelector(":scope > .controls") && !p.id
    );
    if (!panel || panel.dataset.collapsibleReady === "1") return;
    setupPanel(panel, "working-list", "Рабочий список и фильтры");
  }

  function setup() {
    injectCss();
    setupFilters();
    const journal = $("journal");
    if (journal) setupPanel(journal.closest(".panel"), "signal-journal", "Журнал сигналов");
    const sr = $("srJournal");
    if (sr) setupPanel(sr.closest(".panel"), "sr-levels", "Уровни S/R");
    setupSignalPanel();
    setupPanel($("alertsPanel"), "alerts", "Алерты");
    setupPanel($("customIndicatorsPanel"), "custom-indicators", "Дополнительные индикаторы");
    setupPanel($("smaTester"), "sma-tester", "Тестировщик стратегии SMA21");
    setupPanel($("paperTradingPanel"), "paper-trading", "Тестовая торговля · Paper Trading");
  }

  function start() {
    setup();
    // Alerts, tester, paper trading and indicator panels are inserted by separate modules.
    // Observe those insertions rather than changing their own logic or polling timers.
    const observer = new MutationObserver(() => setup());
    observer.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();