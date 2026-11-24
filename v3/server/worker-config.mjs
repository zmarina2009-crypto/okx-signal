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

export function normalizeWorkerConfig(input = {}) {
  const targetsInput = Array.isArray(input.targets) ? input.targets : [];
  if (targetsInput.length > 100) throw new RangeError("At most 100 pair/timeframe targets are supported.");

  const unique = new Map();
  for (const item of targetsInput) {
    const pair = normalizePair(item?.pair);
    const tf = normalizeTimeframe(item?.tf);
    if (!pair.endsWith("-USDT-SWAP")) {
      throw new RangeError("Only OKX USDT perpetual pairs are supported: " + pair);
    }
    if (!SUPPORTED_TIMEFRAMES.has(tf)) {
      throw new RangeError("Unsupported OKX timeframe: " + tf);
    }
    unique.set(pair + "|" + tf, { pair, tf });
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
