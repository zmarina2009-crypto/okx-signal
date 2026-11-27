const DEFAULTS = Object.freeze({
  enabled: true,
  flatFilterEnabled: true,
  trendEnabled: true,
  reversalEnabled: true,
  smaPeriod: 21,
  slopeLookback: 5,
  atrPeriod: 14,
  volumePeriod: 20,
  maxFlatSlopePct: 0.035,
  maxFlatRangePct: 0.45,
  minAtrRatio: 0.65,
  minVolumeRatio: 1.15,
  reversalRsiLongMax: 45,
  reversalRsiShortMin: 55,
  swingLength: 3
});

const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(number) ? number : fallback));
};

export function normalizeMarketRegimeConfig(input = {}) {
  const cfg = { ...DEFAULTS, ...(input || {}) };
  cfg.enabled = cfg.enabled !== false;
  cfg.flatFilterEnabled = cfg.flatFilterEnabled !== false;
  cfg.trendEnabled = cfg.trendEnabled !== false;
  cfg.reversalEnabled = cfg.reversalEnabled !== false;
  cfg.smaPeriod = Math.round(clamp(cfg.smaPeriod, 5, 200, DEFAULTS.smaPeriod));
  cfg.slopeLookback = Math.round(clamp(cfg.slopeLookback, 2, 30, DEFAULTS.slopeLookback));
  cfg.atrPeriod = Math.round(clamp(cfg.atrPeriod, 5, 100, DEFAULTS.atrPeriod));
  cfg.volumePeriod = Math.round(clamp(cfg.volumePeriod, 5, 200, DEFAULTS.volumePeriod));
  cfg.maxFlatSlopePct = clamp(cfg.maxFlatSlopePct, 0.001, 1, DEFAULTS.maxFlatSlopePct);
  cfg.maxFlatRangePct = clamp(cfg.maxFlatRangePct, 0.05, 5, DEFAULTS.maxFlatRangePct);
  cfg.minAtrRatio = clamp(cfg.minAtrRatio, 0.1, 2, DEFAULTS.minAtrRatio);
  cfg.minVolumeRatio = clamp(cfg.minVolumeRatio, 0.1, 10, DEFAULTS.minVolumeRatio);
  cfg.reversalRsiLongMax = Math.round(clamp(cfg.reversalRsiLongMax, 10, 49, DEFAULTS.reversalRsiLongMax));
  cfg.reversalRsiShortMin = Math.round(clamp(cfg.reversalRsiShortMin, 51, 90, DEFAULTS.reversalRsiShortMin));
  cfg.swingLength = Math.round(clamp(cfg.swingLength, 1, 20, DEFAULTS.swingLength));
  if (cfg.reversalRsiLongMax >= cfg.reversalRsiShortMin) {
    throw new RangeError("Reversal LONG RSI threshold must be below SHORT threshold.");
  }
  return cfg;
}

function sma(values, period, end = values.length - 1) {
  if (end - period + 1 < 0) return null;
  let total = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const value = Number(values[i]);
    if (!Number.isFinite(value)) return null;
    total += value;
  }
  return total / period;
}

function rsi(closes, period) {
  if (closes.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  if (losses === 0) return 100;
  if (gains === 0) return 0;
  return 100 - 100 / (1 + gains / losses);
}

function atr(bars, period) {
  if (bars.length < period + 1) return null;
  const ranges = [];
  for (let i = bars.length - period; i < bars.length; i++) {
    const previous = bars[i - 1].c;
    ranges.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - previous), Math.abs(bars[i].l - previous)));
  }
  return ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
}

function averageVolume(bars, period, end = bars.length - 1) {
  if (end - period < 0) return null;
  let total = 0;
  for (let i = end - period; i < end; i++) total += Number(bars[i].v) || 0;
  return total / period;
}

function normalizeBars(input) {
  if (!Array.isArray(input)) return [];
  return input.filter(bar => bar && bar.confirm !== false && String(bar.confirm ?? "1") !== "0")
    .map(bar => ({ ts: Number(bar.ts), h: Number(bar.h), l: Number(bar.l), c: Number(bar.c), v: Number(bar.v) }))
    .filter(bar => [bar.ts, bar.h, bar.l, bar.c, bar.v].every(Number.isFinite) && bar.c > 0 && bar.h >= bar.l)
    .sort((a, b) => a.ts - b.ts);
}

export function classifyMarketRegime(rawBars, inputConfig = {}) {
  const config = normalizeMarketRegimeConfig(inputConfig);
  const bars = normalizeBars(rawBars);
  const minimum = Math.max(config.smaPeriod + config.slopeLookback, config.atrPeriod * 2 + 1, config.volumePeriod + 1, config.swingLength * 2 + 5);
  if (!config.enabled) return { state: "DISABLED", direction: null, actionable: false, reasons: ["Модуль анализа отключён"] };
  if (bars.length < minimum) {
    return { state: "WAIT", direction: null, actionable: false, reasons: ["Недостаточно закрытых свечей"], metrics: { candles: bars.length, required: minimum } };
  }

  const closes = bars.map(bar => bar.c);
  const last = bars.at(-1), previous = bars.at(-2);
  const currentSma = sma(closes, config.smaPeriod);
  const priorSma = sma(closes, config.smaPeriod, bars.length - 1 - config.slopeLookback);
  const slopePct = currentSma && priorSma ? ((currentSma - priorSma) / priorSma) * 100 : 0;
  const currentAtr = atr(bars, config.atrPeriod);
  const olderAtr = atr(bars.slice(0, -config.atrPeriod), config.atrPeriod);
  const atrRatio = currentAtr && olderAtr ? currentAtr / olderAtr : null;
  const rangeBars = bars.slice(-config.smaPeriod);
  const rangePct = ((Math.max(...rangeBars.map(bar => bar.h)) - Math.min(...rangeBars.map(bar => bar.l))) / last.c) * 100;
  const baselineVolume = averageVolume(bars, config.volumePeriod);
  const volumeRatio = baselineVolume > 0 ? last.v / baselineVolume : null;
  const currentRsi = rsi(closes, config.smaPeriod >= 14 ? 14 : config.smaPeriod);
  const crossedUp = previous.c <= (sma(closes, config.smaPeriod, bars.length - 2) ?? currentSma) && last.c > currentSma;
  const crossedDown = previous.c >= (sma(closes, config.smaPeriod, bars.length - 2) ?? currentSma) && last.c < currentSma;
  const nearSma = Math.abs((last.c - currentSma) / currentSma) * 100 <= Math.max(config.maxFlatSlopePct * 3, 0.08);
  const compressed = atrRatio != null && atrRatio < config.minAtrRatio;
  const lowSlope = Math.abs(slopePct) <= config.maxFlatSlopePct;
  const narrowRange = rangePct <= config.maxFlatRangePct;
  const flat = config.flatFilterEnabled && ((lowSlope && narrowRange) || (compressed && nearSma));

  const metrics = {
    close: last.c, sma: currentSma, slopePct, atr: currentAtr,
    atrPercent: currentAtr / last.c * 100, atrRatio, rangePct,
    volumeRatio, rsi: currentRsi
  };
  if (flat) {
    return { state: "FLAT", direction: null, actionable: false, blockSignals: true, reasons: [
      lowSlope ? "Наклон SMA недостаточный" : null,
      narrowRange ? "Узкий диапазон цены" : null,
      compressed && nearSma ? "ATR сжат и цена около SMA" : null
    ].filter(Boolean), metrics };
  }

  const volumeConfirmed = volumeRatio == null || volumeRatio >= config.minVolumeRatio;
  const trendDirection = last.c > currentSma && slopePct > config.maxFlatSlopePct
    ? "LONG" : last.c < currentSma && slopePct < -config.maxFlatSlopePct ? "SHORT" : null;
  const reversalDirection = crossedUp && currentRsi != null && currentRsi <= config.reversalRsiLongMax && volumeConfirmed
    ? "LONG" : crossedDown && currentRsi != null && currentRsi >= config.reversalRsiShortMin && volumeConfirmed ? "SHORT" : null;

  if (config.reversalEnabled && reversalDirection) {
    return { state: "REVERSAL", direction: reversalDirection, actionable: true, blockSignals: false,
      reasons: ["Цена пересекла SMA21", "RSI подтверждает потенциальный разворот", volumeConfirmed ? "Объём подтверждает движение" : "Объём ниже порога"],
      metrics };
  }
  if (config.trendEnabled && trendDirection) {
    return { state: "TREND", direction: trendDirection, actionable: true, blockSignals: false,
      reasons: ["Цена и наклон SMA21 направлены одинаково", volumeConfirmed ? "Объём достаточен" : "Объём ниже порога — ожидание подтверждения"],
      metrics };
  }
  return { state: "WAIT", direction: null, actionable: false, blockSignals: false,
    reasons: ["Нет подтверждённого продолжения тренда или разворота"], metrics };
}

export const DEFAULT_MARKET_REGIME_CONFIG = DEFAULTS;
