#!/usr/bin/env node
/**
 * Offline historical-candle replay for adaptive signal situations.
 *
 * Usage:
 *   node tools/replay-situations.mjs ./SUI-USDT-SWAP-1m.json --pair SUI-USDT-SWAP --tf 1m
 *   node tools/replay-situations.mjs ./candles.csv --pair XRP-USDT-SWAP --tf 1m --no-bos
 *
 * Accepts OKX REST JSON ({ data: [...] }), a raw array of OKX candle rows,
 * or CSV with columns ts,o,h,l,c,v,confirm (or timestamp/open/high/low/close/volume).
 * Rows with confirm=0 are skipped. No network requests are made.
 *
 * This replays the checked-out PR code. It is not a live browser test.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALERTS_SOURCE = fs.readFileSync(path.join(ROOT, "alerts.js"), "utf8");
const SCALPING_SOURCE = fs.readFileSync(path.join(ROOT, "scalping-trigger.js"), "utf8");

const TF_MS = {
  "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000,
  "30m": 1_800_000, "1h": 3_600_000, "2h": 7_200_000,
  "4h": 14_400_000, "1d": 86_400_000
};

function parseCsvLine(line) {
  const cells = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      cells.push(value.trim());
      value = "";
    } else value += ch;
  }
  cells.push(value.trim());
  return cells;
}

function asCandle(row) {
  if (Array.isArray(row)) {
    return {
      ts: Number(row[0]), o: Number(row[1]), h: Number(row[2]),
      l: Number(row[3]), c: Number(row[4]), v: Number(row[5]),
      confirm: row[8] == null ? "1" : String(row[8])
    };
  }
  if (!row || typeof row !== "object") return null;
  return {
    ts: Number(row.ts ?? row.timestamp ?? row.time),
    o: Number(row.o ?? row.open), h: Number(row.h ?? row.high),
    l: Number(row.l ?? row.low), c: Number(row.c ?? row.close),
    v: Number(row.v ?? row.vol ?? row.volume),
    confirm: row.confirm == null && row.confirmed == null
      ? "1" : String(row.confirm ?? (row.confirmed ? "1" : "0"))
  };
}

export function normalizeOhlcvRows(payload) {
  let input = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data) ? payload.data
      : Array.isArray(payload?.rows) ? payload.rows : [];
  const byTimestamp = new Map();
  let invalid = 0, incomplete = 0, duplicates = 0;
  for (const raw of input) {
    const candle = asCandle(raw);
    if (!candle || candle.confirm === "0") { incomplete++; continue; }
    if (![candle.ts, candle.o, candle.h, candle.l, candle.c, candle.v].every(Number.isFinite)
      || candle.ts <= 0 || candle.o <= 0 || candle.h <= 0 || candle.l <= 0
      || candle.c <= 0 || candle.v < 0
      || candle.h < Math.max(candle.o, candle.c)
      || candle.l > Math.min(candle.o, candle.c)
      || candle.h < candle.l) {
      invalid++;
      continue;
    }
    if (byTimestamp.has(candle.ts)) duplicates++;
    byTimestamp.set(candle.ts, {
      ts: candle.ts, o: candle.o, h: candle.h, l: candle.l,
      c: candle.c, v: candle.v, confirm: "1"
    });
  }
  const candles = [...byTimestamp.values()].sort((a, b) => a.ts - b.ts);
  return { candles, inputRows: input.length, invalidRows: invalid, incompleteRows: incomplete, duplicateTimestamps: duplicates };
}

export function parseCandleText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("Файл пустой");
  try {
    return normalizeOhlcvRows(JSON.parse(trimmed));
  } catch (error) {
    if (error instanceof SyntaxError) {
      const lines = trimmed.split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) throw new Error("Нужен JSON OKX или CSV с заголовком и строками свечей");
      const header = parseCsvLine(lines[0]).map(x => x.toLowerCase().replace(/[^a-z0-9]/g, ""));
      const aliases = {
        ts: ["ts", "timestamp", "time", "opentime"],
        o: ["o", "open"], h: ["h", "high"], l: ["l", "low"],
        c: ["c", "close"], v: ["v", "vol", "volume", "contracts"],
        confirm: ["confirm", "confirmed"]
      };
      const positions = {};
      for (const [key, names] of Object.entries(aliases)) {
        positions[key] = header.findIndex(name => names.includes(name));
      }
      if (["ts", "o", "h", "l", "c", "v"].some(key => positions[key] < 0)) {
        throw new Error("CSV должен содержать столбцы ts/timestamp, o/open, h/high, l/low, c/close и v/volume");
      }
      const rows = lines.slice(1).map(line => {
        const cells = parseCsvLine(line);
        return {
          ts: cells[positions.ts], o: cells[positions.o], h: cells[positions.h],
          l: cells[positions.l], c: cells[positions.c], v: cells[positions.v],
          confirm: positions.confirm >= 0 ? cells[positions.confirm] : "1"
        };
      });
      return normalizeOhlcvRows(rows);
    }
    throw error;
  }
}

function createReplayHarness({ comboOnly, includeBos, settings }) {
  let simulatedNow = Date.now();
  class ReplayDate extends Date {
    static now() { return simulatedNow; }
  }
  const storage = new Map();
  const localStorage = {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key)
  };
  const window = {
    __OKX_ALERTS_TEST__: true,
    __OKX_SCALPING_TEST__: true,
    dispatchEvent() {},
    setInterval() { return 0; },
    setTimeout() { return 0; }
  };
  const document = {
    readyState: "loading",
    getElementById: () => null,
    addEventListener() {}
  };
  const context = {
    window, document, localStorage, Date: ReplayDate,
    Math, Number, String, Object, Array, JSON, Promise, Map, Set,
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    console, setInterval() { return 0; }, setTimeout() { return 0; }
  };
  vm.runInNewContext(ALERTS_SOURCE, context, { filename: "alerts.js" });
  vm.runInNewContext(SCALPING_SOURCE, context, { filename: "scalping-trigger.js" });
  const alerts = window.__OKXAlertsTest;
  const scalping = window.__OKXScalpingTest;
  if (!alerts || !scalping) throw new Error("Не удалось включить тестовый интерфейс модулей");

  alerts.setConfig({
    volume: true, volumePeriod: 20, volumeMult: 2,
    rsi: true, rsiPeriod: 14, rsiLow: 30, rsiHigh: 70,
    sma: true, smaPeriod: 21, smaTolerance: 0,
    vp: true, vpPeriod: 60, vpRows: 30, vpMode: "poc",
    comboEnabled: true, comboModeActive: !!comboOnly,
    comboComposition: "any", comboCount: 4, comboWindow: 1,
    chopEnabled: false, cooldown: 1, sound: false,
    ...settings
  });
  scalping.setConfig({
    enabled: !!includeBos,
    volumeRsiEnabled: false,
    bosEnabled: !!includeBos,
    bosAlerts: !!includeBos,
    requireBos: false,
    swingLength: 3,
    cooldownSeconds: 1,
    soundEnabled: false
  });
  alerts.resetCombo();
  return {
    alerts, scalping,
    setClock(ts) { simulatedNow = Number(ts) || simulatedNow; }
  };
}

export function replayHistoricalCandles({
  candles, pair, tf = "1m", comboOnly = true, includeBos = true, settings = {}
}) {
  if (!Array.isArray(candles) || candles.length < 80) {
    throw new Error("Для надёжной проверки нужно не менее 80 закрытых свечей (VP lookback + индикаторы)");
  }
  if (!pair) throw new Error("Не задана торговая пара");
  const normalizedTf = String(tf).toLowerCase();
  const tfMs = TF_MS[normalizedTf];
  if (!tfMs) throw new Error("Неподдерживаемый таймфрейм: " + tf);

  const harness = createReplayHarness({ comboOnly, includeBos, settings });
  const candidateSignals = new Map();
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    harness.setClock(candle.ts);
    const history = candles.slice(Math.max(0, i - 299), i + 1);
    if (history.length < 6) continue;
    harness.alerts.evaluatePair(history, pair, normalizedTf);
    if (includeBos) harness.scalping.evaluateBars(history, pair, normalizedTf);
    harness.alerts.getComboSignals().forEach(signal => candidateSignals.set(signal.id, signal));
  }

  const allMarkers = harness.alerts.read();
  const visibleMarkers = comboOnly
    ? allMarkers.filter(marker => marker.comboConfirmed === true)
    : allMarkers;
  const matchedKeys = new Set();
  visibleMarkers.forEach(marker => {
    // situationEvents is intentionally capped at 20 for UI/storage size, while
    // situationEventIds retains up to 250 source IDs. Use IDs for replay accounting.
    (marker.situationEventIds || []).forEach(id => {
      const parts = String(id).split("|");
      if (parts.length >= 4) matchedKeys.add(parts.slice(0, 4).join("|"));
    });
    (marker.situationEvents || []).forEach(event => {
      matchedKeys.add([marker.pair, marker.tf, event.kind, Number(event.ts)].join("|"));
    });
  });
  const signals = [...candidateSignals.values()];
  const matchedComponents = signals.filter(signal =>
    matchedKeys.has([signal.pair, signal.tf, signal.kind, Number(signal.ts)].join("|"))
  );
  const byDirection = {
    LONG: visibleMarkers.filter(marker => marker.direction === "LONG").length,
    SHORT: visibleMarkers.filter(marker => marker.direction === "SHORT").length
  };
  const sourceCounts = Object.fromEntries(["volume", "rsi", "sma", "vpPoc", "vpOther", "bos", "combo", "scalping"]
    .map(key => [key, visibleMarkers.reduce((sum, marker) =>
      sum + Math.max(0, Number(marker.situationSources?.[key]) || 0), 0)]));
  const gaps = [];
  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i].ts - candles[i - 1].ts;
    if (delta > tfMs * 1.5) gaps.push({ from: candles[i - 1].ts, to: candles[i].ts, missingBarsApprox: Math.max(1, Math.round(delta / tfMs) - 1) });
  }

  return {
    pair, tf: normalizedTf, comboOnly, includeBos,
    data: {
      candleCount: candles.length,
      startTs: candles[0].ts,
      endTs: candles[candles.length - 1].ts,
      gaps,
      candidateComponentSignals: signals.length,
      matchedComponentSignals: matchedComponents.length,
      unmatchedComponentSignals: signals.length - matchedComponents.length
    },
    result: {
      storedMarkerCount: allMarkers.length,
      markerStorageLimitReached: allMarkers.length >= 500,
      visibleSituationCount: visibleMarkers.length,
      byDirection,
      averageEventsPerSituation: visibleMarkers.length
        ? visibleMarkers.reduce((sum, marker) => sum + (Number(marker.eventCount) || 1), 0) / visibleMarkers.length : 0,
      sourceCounts,
      situations: visibleMarkers.map(marker => ({
        id: marker.id, direction: marker.direction,
        firstTs: Number(marker.firstTs) || Number(marker.ts),
        lastEventTs: Number(marker.lastEventTs) || Number(marker.ts),
        anchorPrice: Number(marker.anchorPrice) || Number(marker.entryPrice),
        zoneRadius: Number(marker.zoneRadius) || Number(marker.tolerance),
        eventCount: Number(marker.eventCount) || 1,
        label: marker.label,
        comboConfirmed: marker.comboConfirmed === true,
        comboComponents: marker.comboComponents || [],
        situationSources: marker.situationSources || {},
        sourceEventIds: marker.situationEventIds || [],
        sourceIdsTruncated: (Number(marker.eventCount) || 1) > (marker.situationEventIds || []).length,
        sourceEvents: marker.situationEvents || [],
        displayedEventsTruncated: (Number(marker.eventCount) || 1) > (marker.situationEvents || []).length
      }))
    },
    alertLog: harness.alerts.getAlertLog()
  };
}

function parseArgs(argv) {
  const args = { file: null, pair: "", tf: "1m", comboOnly: true, includeBos: true, json: false };
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith("--") && !args.file) args.file = item;
    else if (item === "--pair") args.pair = argv[++i] || "";
    else if (item === "--tf") args.tf = argv[++i] || "1m";
    else if (item === "--normal-mode") args.comboOnly = false;
    else if (item === "--no-bos") args.includeBos = false;
    else if (item === "--json") args.json = true;
    else if (item === "--help" || item === "-h") args.help = true;
    else throw new Error("Неизвестный аргумент: " + item);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.file || !args.pair) {
    process.stdout.write([
      "Offline replay группировки OKX Signal Pro",
      "Использование:",
      "  node tools/replay-situations.mjs <candles.json|csv> --pair SUI-USDT-SWAP --tf 1m [--normal-mode] [--no-bos] [--json]",
      "JSON: OKX response {data:[...]} или массив строк [ts,o,h,l,c,vol,...,confirm].",
      "CSV: заголовок ts/o/h/l/c/v/confirm (допускаются timestamp/open/high/low/close/volume).",
      "Только закрытые свечи; сеть и торговые API не вызываются."
    ].join("\n") + "\n");
    process.exitCode = args.help ? 0 : 2;
    return;
  }
  const fullPath = path.resolve(args.file);
  const parsed = parseCandleText(fs.readFileSync(fullPath, "utf8"));
  if (parsed.candles.length < 80) throw new Error("После проверки данных осталось меньше 80 закрытых свечей");
  const report = replayHistoricalCandles({
    candles: parsed.candles, pair: args.pair, tf: args.tf,
    comboOnly: args.comboOnly, includeBos: args.includeBos
  });
  report.input = {
    file: fullPath, inputRows: parsed.inputRows,
    invalidRows: parsed.invalidRows, incompleteRows: parsed.incompleteRows,
    duplicateTimestamps: parsed.duplicateTimestamps
  };
  process.stdout.write(args.json
    ? JSON.stringify(report, null, 2) + "\n"
    : [
      "OKX Signal Pro · Historical Situation Replay",
      "Pair / TF: " + report.pair + " / " + report.tf,
      "Closed candles: " + report.data.candleCount,
      "Range: " + new Date(report.data.startTs).toISOString() + " — " + new Date(report.data.endTs).toISOString(),
      "Input rows: " + parsed.inputRows + " · invalid: " + parsed.invalidRows + " · unfinished: " + parsed.incompleteRows + " · duplicates: " + parsed.duplicateTimestamps,
      "Candidate component signals: " + report.data.candidateComponentSignals,
      "Matched component signals: " + report.data.matchedComponentSignals,
      "Unmatched component signals: " + report.data.unmatchedComponentSignals,
      "Visible situations: " + report.result.visibleSituationCount + " (LONG " + report.result.byDirection.LONG + " / SHORT " + report.result.byDirection.SHORT + ")",
      "Stored markers including non-COMBO: " + report.result.storedMarkerCount,
      "Average events per visible situation: " + report.result.averageEventsPerSituation.toFixed(2),
      "Source counts: " + Object.entries(report.result.sourceCounts).filter(([, count]) => count > 0).map(([key, count]) => key + "=" + count).join(", "),
      "Time gaps: " + report.data.gaps.length,
      ...report.result.situations.map(marker => "- " + marker.direction + " · " + marker.label + " · " + marker.eventCount + " events · anchor " + marker.anchorPrice + " ± " + marker.zoneRadius)
    ].join("\n") + "\n"
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write("Replay failed: " + (error?.message || String(error)) + "\n");
    process.exitCode = 1;
  });
}
