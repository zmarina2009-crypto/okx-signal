import { volumeProfileLevels } from "./volume-profile.js";

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function calculateRsi(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const delta = Number(candles[i].c) - Number(candles[i - 1].c);
    if (delta > 0) gains += delta;
    else losses -= delta;
  }
  if (losses === 0) return 100;
  if (gains === 0) return 0;
  return 100 - 100 / (1 + gains / losses);
}

export function calculateAtr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const ranges = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const candle = candles[i];
    const previousClose = Number(candles[i - 1]?.c);
    const high = Number(candle.h);
    const low = Number(candle.l);
    if (![high, low, previousClose].every(Number.isFinite)) return null;
    ranges.push(Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose)));
  }
  return average(ranges);
}

/**
 * Flexible RSI + Volume Profile setup:
 * RSI must be in an extreme zone; close must be within maxDistanceAtr * ATR
 * of the nearest POC, VAL, or VAH. The signal candle is excluded from VP.
 */
export function evaluateRsiVpProximity(candles, options = {}, profileBuilder = volumeProfileLevels) {
  const rsiPeriod = clamp(Math.round(Number(options.rsiPeriod) || 14), 2, 100);
  const rsiLow = clamp(Number(options.rsiLow) || 30, 1, 49);
  const rsiHigh = clamp(Number(options.rsiHigh) || 70, 51, 99);
  const atrPeriod = clamp(Math.round(Number(options.atrPeriod) || 14), 2, 100);
  const vpPeriod = clamp(Math.round(Number(options.vpPeriod) || 60), 20, 300);
  const vpRows = clamp(Math.round(Number(options.vpRows) || 30), 10, 60);
  const maxDistanceAtr = clamp(Number(options.maxDistanceAtr ?? 0.25), 0.01, 2);

  if (!Array.isArray(candles) || candles.length < Math.max(rsiPeriod + 1, atrPeriod + 1, vpPeriod + 1)) {
    return { signal: null, reason: "недостаточно истории" };
  }

  const last = candles.at(-1);
  const value = calculateRsi(candles, rsiPeriod);
  const atr = calculateAtr(candles, atrPeriod);
  if (value == null || atr == null || !Number.isFinite(Number(last.c)) || atr <= 0) {
    return { signal: null, reason: "не удалось рассчитать RSI или ATR" };
  }

  const direction = value <= rsiLow ? "LONG" : value >= rsiHigh ? "SHORT" : null;
  if (!direction) return { signal: null, reason: "RSI вне экстремальной зоны", rsi: value };

  const profileBars = candles.slice(0, -1).slice(-vpPeriod);
  const levels = profileBuilder(profileBars, vpRows);
  if (!levels) return { signal: null, reason: "не удалось рассчитать Volume Profile", rsi: value, atr };

  const candidates = ["POC", "VAL", "VAH"]
    .map(name => ({ name, price: Number(levels[name.toLowerCase()]) }))
    .filter(level => Number.isFinite(level.price))
    .map(level => ({ ...level, distance: Math.abs(Number(last.c) - level.price) }))
    .sort((a, b) => a.distance - b.distance);

  const nearest = candidates[0];
  if (!nearest) return { signal: null, reason: "нет уровней Volume Profile", rsi: value, atr };
  const maxDistance = atr * maxDistanceAtr;
  if (nearest.distance > maxDistance) {
    return { signal: null, reason: "цена далеко от уровней Volume Profile", rsi: value, atr, nearestLevel: nearest.name, distance: nearest.distance, maxDistance };
  }

  return {
    signal: {
      direction, rsi: value, atr, vpLevel: nearest.name, vpPrice: nearest.price,
      vpDistance: nearest.distance, maxDistanceAtr, price: Number(last.c),
      ts: Number(last.ts) || 0
    },
    reason: null
  };
}
