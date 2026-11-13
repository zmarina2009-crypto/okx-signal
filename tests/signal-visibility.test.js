const test = require("node:test");
const assert = require("node:assert/strict");
const { readSettings, forDisplay } = require("../signal-visibility.js");

function storage(values) {
  return { getItem(key) { return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null; } };
}

const allIndicatorsOff = {
  alerts: { volume: false, rsi: false, sma: false, vp: false, comboEnabled: false },
  scalping: { enabled: true, volumeRsiEnabled: true, bosEnabled: true, bosAlerts: true }
};

test("reads disabled alert checkboxes while keeping the separate scalping module enabled", () => {
  const settings = readSettings(storage({
    okx_alerts_v1: JSON.stringify({ volume: false, rsi: false, sma: false, vp: false, comboEnabled: false }),
    okx_scalping_trigger_v1: JSON.stringify({ enabled: true, volumeRsiEnabled: true, bosEnabled: true, bosAlerts: true })
  }));
  assert.equal(settings.alerts.vp, false);
  assert.equal(settings.scalping.enabled, true);
  assert.equal(settings.scalping.volumeRsiEnabled, true);
});

test("hides a VP marker when Volume Profile is unchecked", () => {
  assert.equal(forDisplay({ kind: "vp", label: "VP 15m POC", direction: "LONG" }, allIndicatorsOff), null);
});

test("still shows a scalping marker when every standalone alert checkbox is off", () => {
  assert.deepEqual(forDisplay({ kind: "scalping", label: "VOL+RSI", eventCount: 1 }, allIndicatorsOff), {
    sources: ["scalping"], label: "Scalping", eventCount: 1
  });
});

test("removes disabled VP from a mixed situation without hiding the enabled scalping event", () => {
  const marker = {
    kind: "scalping",
    situationSources: { vpPoc: 3, vpOther: 1, bos: 2, scalping: 1 },
    eventCount: 7,
    label: "VP POC + VP + BOS + Scalping"
  };
  const view = forDisplay(marker, {
    alerts: { volume: false, rsi: false, sma: false, vp: false, comboEnabled: false },
    scalping: { enabled: true, volumeRsiEnabled: true, bosEnabled: false, bosAlerts: false }
  });
  assert.deepEqual(view, { sources: ["scalping"], label: "Scalping", eventCount: 1 });
});

test("shows BOS only when the scalping BOS alert controls are enabled", () => {
  assert.equal(forDisplay({ kind: "bos", label: "BOS break" }, allIndicatorsOff).label, "BOS");
  assert.equal(forDisplay({ kind: "bos" }, {
    alerts: allIndicatorsOff.alerts,
    scalping: { enabled: true, volumeRsiEnabled: true, bosEnabled: false, bosAlerts: true }
  }), null);
});

test("hides scalping and BOS markers when the scalping module is disabled", () => {
  const settings = {
    alerts: allIndicatorsOff.alerts,
    scalping: { enabled: false, volumeRsiEnabled: true, bosEnabled: true, bosAlerts: true }
  };
  assert.equal(forDisplay({ kind: "scalping" }, settings), null);
  assert.equal(forDisplay({ kind: "bos" }, settings), null);
});

test("keeps active RSI while dropping disabled VP in a grouped marker", () => {
  const view = forDisplay({ situationSources: { vpPoc: 2, rsi: 1 }, eventCount: 3 }, {
    alerts: { volume: false, rsi: true, sma: false, vp: false, comboEnabled: false },
    scalping: { enabled: false, volumeRsiEnabled: false, bosEnabled: false, bosAlerts: false }
  });
  assert.deepEqual(view, { sources: ["rsi"], label: "RSI", eventCount: 1 });
});

test("keeps scalping RSI repeats separate from the standalone RSI checkbox", () => {
  assert.equal(forDisplay({
    kind: "rsi", label: "RSI · повтор", eventCount: 1, individual: true
  }, allIndicatorsOff).label, "Scalping");
});

test("fails closed for unknown marker kinds", () => {
  assert.equal(forDisplay({ kind: "unknown-indicator" }, allIndicatorsOff), null);
});