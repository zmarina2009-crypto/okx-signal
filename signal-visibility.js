(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.OKXSignalVisibility = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  const ALERT_DEFAULTS = { volume: true, rsi: true, sma: true, vp: true, comboEnabled: false };
  const SCALPING_DEFAULTS = { enabled: true, volumeRsiEnabled: true, bosEnabled: true, bosAlerts: true };
  const SOURCES = ["volume", "rsi", "sma", "vpPoc", "vpOther", "bos", "combo", "scalping"];
  const SOURCE_LABELS = {
    volume: "Volume", rsi: "RSI", sma: "SMA21", vpPoc: "VP POC",
    vpOther: "VP", bos: "BOS", combo: "COMBO", scalping: "Scalping"
  };

  function readStored(storage, key, defaults) {
    let saved = {};
    try {
      const raw = storage && storage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) saved = parsed;
    } catch (_) {}
    return Object.assign({}, defaults, saved);
  }

  function asEnabled(config, key, fallback) {
    if (!config || !Object.prototype.hasOwnProperty.call(config, key)) return fallback;
    const value = config[key];
    return value === true || value === 1 || value === "true";
  }

  function readSettings(storage) {
    const alerts = readStored(storage, "okx_alerts_v1", ALERT_DEFAULTS);
    const scalping = readStored(storage, "okx_scalping_trigger_v1", SCALPING_DEFAULTS);
    return {
      alerts: {
        volume: asEnabled(alerts, "volume", ALERT_DEFAULTS.volume),
        rsi: asEnabled(alerts, "rsi", ALERT_DEFAULTS.rsi),
        sma: asEnabled(alerts, "sma", ALERT_DEFAULTS.sma),
        vp: asEnabled(alerts, "vp", ALERT_DEFAULTS.vp),
        comboEnabled: asEnabled(alerts, "comboEnabled", ALERT_DEFAULTS.comboEnabled)
      },
      scalping: {
        enabled: asEnabled(scalping, "enabled", SCALPING_DEFAULTS.enabled),
        volumeRsiEnabled: asEnabled(scalping, "volumeRsiEnabled", SCALPING_DEFAULTS.volumeRsiEnabled),
        bosEnabled: asEnabled(scalping, "bosEnabled", SCALPING_DEFAULTS.bosEnabled),
        bosAlerts: asEnabled(scalping, "bosAlerts", SCALPING_DEFAULTS.bosAlerts)
      }
    };
  }

  function sourceFor(meta) {
    const kind = String(meta && meta.kind || "").toLowerCase();
    const label = String(meta && meta.label || "").toLowerCase();
    if (kind === "vp") return /\bpoc\b/.test(label) ? "vpPoc" : "vpOther";
    if (kind === "rsi-repeat" || (kind === "rsi" && /(повтор|repeat)/.test(label))) return "scalping";
    return SOURCES.includes(kind) ? kind : null;
  }

  function sourceCounts(marker) {
    const counts = Object.fromEntries(SOURCES.map(source => [source, 0]));
    if (!marker || typeof marker !== "object") return counts;

    if (marker.individual === true) {
      const source = sourceFor(marker);
      if (source) counts[source] = Math.max(1, Number(marker.eventCount) || Number(marker.touches) || 1);
      return counts;
    }

    const saved = marker.situationSources;
    if (saved && typeof saved === "object") {
      SOURCES.forEach(source => {
        counts[source] = Math.max(0, Math.round(Number(saved[source]) || 0));
      });
      // RSI repeats from the separate scalping module are not standalone RSI alerts.
      const repeatedRsi = Array.isArray(marker.situationEvents)
        ? marker.situationEvents.filter(event =>
            sourceFor(event) === "scalping" &&
            String(event && event.kind || "").toLowerCase() === "rsi"
          ).length
        : 0;
      const moved = Math.min(counts.rsi, repeatedRsi);
      counts.rsi -= moved;
      counts.scalping += moved;
      if (SOURCES.some(source => counts[source] > 0)) return counts;
    }

    if (Array.isArray(marker.situationEvents) && marker.situationEvents.length) {
      marker.situationEvents.forEach(event => {
        const source = sourceFor(event);
        if (source) counts[source] += 1;
      });
      if (SOURCES.some(source => counts[source] > 0)) return counts;
    }

    const source = sourceFor(marker);
    if (source) counts[source] = Math.max(1, Number(marker.eventCount) || Number(marker.touches) || 1);
    return counts;
  }

  function sourceEnabled(source, settings) {
    const alerts = settings && settings.alerts || {};
    const scalping = settings && settings.scalping || {};
    switch (source) {
      case "volume": return !!alerts.volume;
      case "rsi": return !!alerts.rsi;
      case "sma": return !!alerts.sma;
      case "vpPoc":
      case "vpOther": return !!alerts.vp;
      case "combo": return !!alerts.comboEnabled;
      case "bos": return !!(scalping.enabled && scalping.bosEnabled && scalping.bosAlerts);
      case "scalping": return !!(scalping.enabled && scalping.volumeRsiEnabled);
      default: return false;
    }
  }

  function forDisplay(marker, settings) {
    const counts = sourceCounts(marker);
    const enabledSources = SOURCES.filter(source => counts[source] > 0 && sourceEnabled(source, settings));
    if (!enabledSources.length) return null;
    return {
      sources: enabledSources,
      label: enabledSources.map(source => SOURCE_LABELS[source]).join(" + "),
      eventCount: enabledSources.reduce((total, source) => total + counts[source], 0)
    };
  }

  return { readSettings, sourceCounts, forDisplay };
});