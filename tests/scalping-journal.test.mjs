import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../scalping-trigger.js", import.meta.url), "utf8");
const alertsSource = fs.readFileSync(new URL("../alerts.js", import.meta.url), "utf8");

function createHarness() {
  const store = new Map();
  const localStorage = {
    getItem: (key) => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => store.set(key, String(value))
  };
  const window = { __OKX_ALERTS_TEST__: true, __OKX_SCALPING_TEST__: true, dispatchEvent() {} };
  const document = {
    readyState: "loading",
    getElementById: () => null,
    addEventListener() {}
  };
  const context = {
    window, document, localStorage, Date, Math, Number, String, Object, Array,
    JSON, Promise, CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    console, setInterval() { return 0; }, setTimeout() { return 0; }
  };
  vm.runInNewContext(alertsSource, context, { filename: "alerts.js" });
  vm.runInNewContext(source, context, { filename: "scalping-trigger.js" });
  assert.ok(window.__OKXAlertsTest, "alert test API should be exposed");
  assert.ok(window.__OKXScalpingTest, "scalping test API should be exposed");
  const api = window.__OKXScalpingTest;
  api.alerts = window.__OKXAlertsTest;
  return api;
}

test("each original scalping event is stored as its own journal row", () => {
  const api = createHarness();
  const first = api.addHistory("scalping", "SUI-USDT-SWAP", "1m", "LONG", "Volume + RSI", 1000, 1, null);
  const second = api.addHistory("scalping", "SUI-USDT-SWAP", "1m", "LONG", "Volume + RSI repeat", 2000, 1.01, null);
  const rows = api.getHistory();
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].signalTs, undefined);
  assert.equal(rows[0].message, "Volume + RSI");
  assert.equal(rows[1].message, "Volume + RSI repeat");
  assert.equal(first.kind, "scalping");
  assert.equal(second.kind, "scalping");
});

test("a suppressed same-direction RSI repeat is linked to its aggregate marker and journal row", () => {
  const api = createHarness();
  const ts = Date.now() - 120000;
  const initialMarker = api.alerts.add({
    pair: "SUI-USDT-SWAP", tf: "1m", kind: "scalping", direction: "LONG",
    price: 100, entryPrice: 100, ts, zoneRadius: 2, label: "VOL+RSI", displayEventCount: 1
  });
  const original = api.addHistory("scalping", "SUI-USDT-SWAP", "1m", "LONG",
    "Initial signal", ts, 100, initialMarker);
  api.setState({
    rsiClusters: {
      "SUI-USDT-SWAP|1m|LONG": {
        direction: "LONG", anchorPrice: 100, anchorTs: ts, radius: 2, neutralSeen: false,
        historySignalTs: original.signalTs, situationId: initialMarker.marker.id, suppressedCount: 0
      }
    }
  });
  const merged = api.mergeRsiRepeat("SUI-USDT-SWAP", "1m", { ts: ts + 60000, c: 100.5 }, "LONG");
  const rows = api.getHistory();
  const markers = api.alerts.read();
  const marker = markers.find(item => item.id === initialMarker.marker.id);
  const visualRepeat = markers.find(item => item.individual === true);
  assert.equal(merged, true);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].kind, "rsi-repeat");
  assert.equal(rows[1].direction, "LONG");
  assert.equal(rows[1].situationId, initialMarker.marker.id);
  assert.equal(rows[1].mergedIntoSituation, true);
  assert.equal(rows[1].situationEventCount, 2);
  assert.equal(marker.eventCount, 2);
  assert.equal(marker.situationSources.rsi, 1);
  assert.equal(marker.ts, ts, "the shared situation marker must stay on its first signal candle");
  assert.equal(marker.displayEventCount, 1, "the group marker represents its first chart event, not all repeats");
  assert.ok(visualRepeat, "the repeated RSI must get its own chart marker");
  assert.equal(visualRepeat.kind, "rsi-repeat");
  assert.equal(visualRepeat.label, "RSI");
  assert.equal(visualRepeat.ts, ts + 60000);
  assert.equal(visualRepeat.eventCount, 1);
  assert.equal(visualRepeat.touches, 1);
  assert.equal(rows[0].mergedCount, 1);
});

test("an opposite-direction RSI signal is not suppressed into the existing cluster", () => {
  const api = createHarness();
  api.setState({
    rsiClusters: {
      "SUI-USDT-SWAP|1m": {
        direction: "LONG", anchorPrice: 100, radius: 2, neutralSeen: false,
        historySignalTs: 123, suppressedCount: 0
      }
    }
  });
  assert.equal(api.mergeRsiRepeat("SUI-USDT-SWAP", "1m", { ts: 2000, c: 100.5 }, "SHORT"), false);
  assert.equal(api.getHistory().length, 0);
});

test("journal keeps the newest 500 events without collapsing repeats", () => {
  const api = createHarness();
  for (let i = 0; i < 505; i++) {
    api.addHistory("rsi-repeat", "SUI-USDT-SWAP", "1m", "LONG", "repeat " + i, i + 1, 100, null);
  }
  const rows = api.getHistory();
  assert.equal(rows.length, 500);
  assert.match(rows[0].message, /5$/);
  assert.match(rows[499].message, /504$/);
});

test("journal persists every event, including individual repeats", () => {
  const api = createHarness();
  api.addHistory("scalping", "SUI-USDT-SWAP", "1m", "LONG", "Volume + RSI", 1000, 100, null);
  api.addHistory("rsi-repeat", "SUI-USDT-SWAP", "1m", "LONG", "RSI repeat", 2000, 100.5, null);
  const stored = api.getPersistedHistory();
  assert.equal(stored.length, 2);
  assert.deepEqual(stored.map((item) => item.kind), ["scalping", "rsi-repeat"]);
});

test("journal UI is a separate window with its own quick-access button", () => {
  assert.ok(source.includes("function buildJournalModal()"));
  assert.match(source, /id = "scalpingJournalModal"/);
  assert.match(source, /id = "scalpJournalButton"/);
  assert.ok(source.includes("journalButton.onclick = openJournalModal"));
  const settingsStart = source.indexOf("function buildModal()");
  const journalStart = source.indexOf("function buildJournalModal()");
  const settingsEnd = source.indexOf("function addOpenButton()");
  assert.ok(settingsStart >= 0 && journalStart >= 0 && settingsEnd > journalStart);
  assert.doesNotMatch(source.slice(settingsStart, journalStart), /id="stHistoryList"/);
});

test("Volume + RSI scalp marker receives the ATR-derived situation radius", () => {
  const api = createHarness();
  api.setConfig({
    enabled: true, volumeRsiEnabled: true, volumePeriod: 20, volumeMultiplier: 2,
    rsiLength: 14, rsiOversold: 30, rsiOverbought: 70,
    swingLength: 3, bosEnabled: false, bosAlerts: false, requireBos: false,
    longEnabled: true, shortEnabled: true, cooldownSeconds: 1,
    rsiClusterAtrMultiplier: 1, soundEnabled: false
  });
  const start = Date.now() - 25 * 60000;
  const bars = Array.from({ length: 25 }, (_, i) => {
    const close = 100 - i * 0.05;
    return { ts: start + i * 60000, o: close + 0.02, h: close + 0.1, l: close - 0.1,
      c: close, v: i === 24 ? 100 : 1 };
  });
  api.evaluateBars(bars, "SUI-USDT-SWAP", "1m");
  const [marker] = api.alerts.read();
  const cluster = api.getState().rsiClusters["SUI-USDT-SWAP|1m|LONG"];
  assert.ok(marker, "a qualifying Volume + RSI marker should be emitted");
  assert.equal(marker.kind, "scalping");
  assert.ok(marker.zoneRadius > marker.entryPrice * 0.00025);
  assert.ok(cluster);
  assert.equal(cluster.radius, marker.zoneRadius);
});

test("LONG and SHORT RSI clusters coexist and repeats link to their own direction", () => {
  const api = createHarness();
  const ts = Date.now() - 180000;
  const longMarker = api.alerts.add({
    pair: "SUI-USDT-SWAP", tf: "1m", kind: "scalping", direction: "LONG",
    price: 100, entryPrice: 100, ts, zoneRadius: 2
  });
  const shortMarker = api.alerts.add({
    pair: "SUI-USDT-SWAP", tf: "1m", kind: "scalping", direction: "SHORT",
    price: 100, entryPrice: 100, ts, zoneRadius: 2
  });
  const longRow = api.addHistory("scalping", "SUI-USDT-SWAP", "1m", "LONG", "Long setup", ts, 100, longMarker);
  const shortRow = api.addHistory("scalping", "SUI-USDT-SWAP", "1m", "SHORT", "Short setup", ts, 100, shortMarker);
  api.setState({
    rsiClusters: {
      "SUI-USDT-SWAP|1m|LONG": { direction: "LONG", anchorPrice: 100, anchorTs: ts, radius: 2,
        historySignalTs: longRow.signalTs, situationId: longMarker.marker.id, suppressedCount: 0 },
      "SUI-USDT-SWAP|1m|SHORT": { direction: "SHORT", anchorPrice: 100, anchorTs: ts, radius: 2,
        historySignalTs: shortRow.signalTs, situationId: shortMarker.marker.id, suppressedCount: 0 }
    }
  });
  assert.equal(api.mergeRsiRepeat("SUI-USDT-SWAP", "1m", { ts: ts + 60000, c: 100.5 }, "LONG"), true);
  assert.equal(api.mergeRsiRepeat("SUI-USDT-SWAP", "1m", { ts: ts + 60000, c: 100.5 }, "SHORT"), true);
  const markers = api.alerts.read();
  const situations = markers.filter(marker => marker.situationSources && marker.individual !== true);
  const individualRepeats = markers.filter(marker => marker.individual === true);
  const repeats = api.getHistory().filter(row => row.kind === "rsi-repeat");
  assert.equal(situations.length, 2);
  assert.equal(individualRepeats.length, 2);
  assert.notEqual(repeats[0].situationId, repeats[1].situationId);
  assert.ok(situations.every(marker => marker.eventCount === 2));
  assert.ok(individualRepeats.every(marker => marker.kind === "rsi-repeat" && marker.eventCount === 1));
});

test("SUI 1m repeated Volume + RSI triggers produce one situation and three journal events", () => {
  const api = createHarness();
  api.setConfig({
    enabled: true, volumeRsiEnabled: true, volumePeriod: 20, volumeMultiplier: 2,
    rsiLength: 14, rsiOversold: 30, rsiOverbought: 70,
    swingLength: 3, bosEnabled: false, bosAlerts: false, requireBos: false,
    longEnabled: true, shortEnabled: true, cooldownSeconds: 60,
    rsiClusterAtrMultiplier: 1, soundEnabled: false
  });

  const start = Date.now() - 30 * 60000;
  const bars = Array.from({ length: 24 }, (_, i) => {
    const close = 101 - i * 0.02;
    return {
      ts: start + i * 60000, o: close + 0.01,
      h: close + 0.06, l: close - 0.06, c: close, v: 1
    };
  });

  // Three consecutive closed 1m candles have a volume spike and remain in the
  // original LONG ATR zone. The first creates a situation; next two are RSI repeats.
  for (let i = 24; i < 27; i++) {
    const close = 101 - i * 0.02;
    bars.push({
      ts: start + i * 60000, o: close + 0.01,
      h: close + 0.06, l: close - 0.06, c: close, v: 100
    });
    api.evaluateBars(bars.slice(), "SUI-USDT-SWAP", "1m");
  }

  const markers = api.alerts.read();
  const situation = markers.find(marker => marker.situationSources && marker.individual !== true);
  const individualRepeats = markers.filter(marker => marker.individual === true);
  const rows = api.getHistory();
  assert.equal(markers.length, 3, "one grouped situation plus two standalone RSI repeat markers should be stored");
  assert.ok(situation);
  assert.equal(situation.pair, "SUI-USDT-SWAP");
  assert.equal(situation.tf, "1m");
  assert.equal(situation.direction, "LONG");
  assert.equal(situation.eventCount, 3);
  assert.equal(situation.displayEventCount, 1);
  assert.equal(individualRepeats.length, 2);
  assert.ok(individualRepeats.every(marker => marker.kind === "rsi-repeat" && marker.direction === "LONG"));
  assert.ok(individualRepeats.every(marker => marker.eventCount === 1));
  assert.deepEqual(individualRepeats.map(marker => marker.ts), [start + 25 * 60000, start + 26 * 60000]);
  assert.equal(rows.length, 3, "every original trigger must remain in the journal");
  assert.equal(rows[0].kind, "scalping");
  assert.equal(rows.slice(1).map(row => row.kind).join(","), "rsi-repeat,rsi-repeat");
  assert.ok(rows.every(row => row.situationId === situation.id));
  assert.equal(rows.map(row => row.situationEventCount).join(","), "1,2,3");
  assert.equal(rows[0].mergedCount, 2);
  assert.ok(situation.zoneRadius > situation.entryPrice * 0.00025);
});

test("SUI 1m repeated SHORT Volume + RSI triggers remain one separate SHORT situation", () => {
  const api = createHarness();
  api.setConfig({
    enabled: true, volumeRsiEnabled: true, volumePeriod: 20, volumeMultiplier: 2,
    rsiLength: 14, rsiOversold: 30, rsiOverbought: 70,
    swingLength: 3, bosEnabled: false, bosAlerts: false, requireBos: false,
    longEnabled: true, shortEnabled: true, cooldownSeconds: 60,
    rsiClusterAtrMultiplier: 1, soundEnabled: false
  });

  const start = Date.now() - 30 * 60000;
  const bars = Array.from({ length: 24 }, (_, i) => {
    const close = 100 + i * 0.02;
    return {
      ts: start + i * 60000, o: close - 0.01,
      h: close + 0.06, l: close - 0.06, c: close, v: 1
    };
  });

  for (let i = 24; i < 27; i++) {
    const close = 100 + i * 0.02;
    bars.push({
      ts: start + i * 60000, o: close - 0.01,
      h: close + 0.06, l: close - 0.06, c: close, v: 100
    });
    api.evaluateBars(bars.slice(), "SUI-USDT-SWAP", "1m");
  }

  const markers = api.alerts.read();
  const situation = markers.find(marker => marker.situationSources && marker.individual !== true);
  const individualRepeats = markers.filter(marker => marker.individual === true);
  const rows = api.getHistory();
  assert.equal(markers.length, 3);
  assert.ok(situation);
  assert.equal(situation.pair, "SUI-USDT-SWAP");
  assert.equal(situation.tf, "1m");
  assert.equal(situation.direction, "SHORT");
  assert.equal(situation.eventCount, 3);
  assert.equal(situation.displayEventCount, 1);
  assert.equal(individualRepeats.length, 2);
  assert.ok(individualRepeats.every(marker => marker.kind === "rsi-repeat" && marker.direction === "SHORT"));
  assert.ok(individualRepeats.every(marker => marker.eventCount === 1));
  assert.equal(rows.length, 3);
  assert.equal(rows.map(row => row.kind).join(","), "scalping,rsi-repeat,rsi-repeat");
  assert.ok(rows.every(row => row.direction === "SHORT"));
  assert.ok(rows.every(row => row.situationId === situation.id));
  assert.equal(rows.map(row => row.situationEventCount).join(","), "1,2,3");
  assert.equal(rows[0].mergedCount, 2);
  assert.ok(situation.zoneRadius > situation.entryPrice * 0.00025);
});

test("RSI repeat suppression expires after the shared eight-bar time boundary", () => {
  const api = createHarness();
  const ts = Date.now() - 600000;
  api.setState({
    rsiClusters: {
      "SUI-USDT-SWAP|1m|LONG": { direction: "LONG", anchorPrice: 100, anchorTs: ts,
        radius: 2, historySignalTs: ts, suppressedCount: 0 }
    }
  });
  assert.equal(api.mergeRsiRepeat("SUI-USDT-SWAP", "1m", { ts: ts + 9 * 60000, c: 100.5 }, "LONG"), false);
  assert.equal(api.getState().rsiClusters["SUI-USDT-SWAP|1m|LONG"], undefined);
});
