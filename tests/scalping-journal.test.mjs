import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../scalping-trigger.js", import.meta.url), "utf8");

function createHarness() {
  const store = new Map();
  const localStorage = {
    getItem: (key) => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => store.set(key, String(value))
  };
  const window = { __OKX_SCALPING_TEST__: true };
  const document = {
    readyState: "loading",
    getElementById: () => null,
    addEventListener() {}
  };
  vm.runInNewContext(source, {
    window, document, localStorage, Date, Math, Number, String, Object, Array,
    JSON, Promise, CustomEvent: class {}, console,
    setInterval() { return 0; }
  }, { filename: "scalping-trigger.js" });
  assert.ok(window.__OKXScalpingTest, "test API should be exposed in test mode");
  return window.__OKXScalpingTest;
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

test("a suppressed same-direction RSI repeat is still added to the journal", () => {
  const api = createHarness();
  const original = api.addHistory("scalping", "SUI-USDT-SWAP", "1m", "LONG", "Initial signal", 1000, 100, null);
  api.setState({
    rsiClusters: {
      "SUI-USDT-SWAP|1m": {
        direction: "LONG", anchorPrice: 100, radius: 2, neutralSeen: false,
        historySignalTs: original.signalTs, suppressedCount: 0
      }
    }
  });
  const merged = api.mergeRsiRepeat("SUI-USDT-SWAP", "1m", { ts: 2000, c: 100.5 }, "LONG");
  const rows = api.getHistory();
  assert.equal(merged, true);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].kind, "rsi-repeat");
  assert.equal(rows[1].direction, "LONG");
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


test("scalping status exposes BOS evaluation and OKX polling failures", () => {
  assert.match(source, /lastBosState = bos \?/);
  assert.match(source, /lastBarsCount = bars\.length/);
  assert.match(source, /results\.filter\(\(result\) => result\.status === "rejected"\)/);
  assert.match(source, /Ошибка получения данных:/);
  assert.match(source, /Свечей OKX:/);
});
