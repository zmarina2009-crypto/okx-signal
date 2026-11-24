import { normalizePair, normalizeTimeframe, normalizeConfig } from "./scalping-engine.mjs";
import { normalizeNotificationSchedule } from "./notification-schedule.mjs";

const SUPPORTED_TIMEFRAMES = new Set([
  "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d", "1w"
]);

export function createDefaultWorkerConfig() {
  return normalizeWorkerConfig({
    enabled: false,
    targets: [],
    scalping: {},
    notificationSchedule: {
      enabled: false,
      timezone: "Europe/Amsterdam",
      weekdays: [],
      windows: [],
      channels: { push: false, telegram: false }
    }
  });
}

export function getEnabledTargets(config) {
  return Array.isArray(config?.targets)
    ? config.targets.filter(target => target?.enabled !== false)
    : [];
}

export function normalizeWorkerConfig(input = {}) {
  const targetsInput = Array.isArray(input.targets) ? input.targets : [];
  if (targetsInput.length > 100) throw new RangeError("At most 100 pair/timeframe targets are supported.");

  const unique = new Map();
  for (const item of targetsInput) {
    const rawPair = String(item?.pair || "").trim().toUpperCase();
    const supportedInput = /^[A-Z0-9]{1,20}$/.test(rawPair) ||
      /^[A-Z0-9]{1,20}USDT$/.test(rawPair) ||
      /^[A-Z0-9]{1,20}-USDT$/.test(rawPair) ||
      /^[A-Z0-9]{1,20}-USDT-SWAP$/.test(rawPair);
    if (!supportedInput) {
      throw new RangeError("Only OKX USDT perpetual pairs are supported: " + rawPair);
    }
    const pair = normalizePair(rawPair);
    const tf = normalizeTimeframe(item?.tf);
    if (!/^[A-Z0-9]{1,20}-USDT-SWAP$/.test(pair)) {
      throw new RangeError("Invalid OKX perpetual instrument: " + pair);
    }
    if (!SUPPORTED_TIMEFRAMES.has(tf)) {
      throw new RangeError("Unsupported OKX timeframe: " + tf);
    }
    // Each pair/timeframe target has an independent switch. Existing saved
    // configurations remain enabled unless they explicitly set enabled: false.
    unique.set(pair + "|" + tf, { pair, tf, enabled: item?.enabled !== false });
  }
  if (new Set([...unique.values()].map(target => target.pair)).size > 20) {
    throw new RangeError("At most 20 distinct OKX pairs are supported.");
  }

  return {
    enabled: input.enabled === true,
    targets: [...unique.values()],
    scalping: normalizeConfig(input.scalping || {}),
    notificationSchedule: normalizeNotificationSchedule(input.notificationSchedule || {})
  };
}
