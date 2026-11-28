import { evaluateScalpingBars, normalizePair, normalizeTimeframe } from "./scalping-engine.mjs";
import { classifyMarketRegime, resolveProfileTimeframe } from "./market-regime.mjs";

const TIMEFRAME_MS = Object.freeze({
  "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000,
  "30m": 1_800_000, "1h": 3_600_000, "2h": 7_200_000,
  "4h": 14_400_000, "6h": 21_600_000, "12h": 43_200_000,
  "1d": 86_400_000, "1w": 604_800_000
});

const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(number) ? number : fallback));
};

export function normalizeBacktestConfig(input = {}) {
  const stopMode = input.stopMode === "atr" ? "atr" : "swing";
  return {
    stopMode,
    swingLookback: Math.round(clamp(input.swingLookback, 2, 100, 12)),
    atrPeriod: Math.round(clamp(input.atrPeriod, 2, 100, 14)),
    atrMultiplier: clamp(input.atrMultiplier, 0.25, 10, 1.5),
    rewardRisk: clamp(input.rewardRisk, 1, 20, 5),
    breakEvenAtR: clamp(input.breakEvenAtR, 0.25, 5, 1),
    riskPercent: clamp(input.riskPercent, 0.01, 5, 0.5),
    initialCapital: clamp(input.initialCapital, 1, 1_000_000_000, 10_000),
    feeRate: clamp(input.feeRate, 0, 0.02, 0.0005),
    slippageRate: clamp(input.slippageRate, 0, 0.02, 0.0002),
    maxBarsInTrade: Math.round(clamp(input.maxBarsInTrade, 1, 10_000, 500))
  };
}

function averageTrueRange(bars, period) {
  if (!Array.isArray(bars) || bars.length < period + 1) return null;
  let total = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    const current = bars[i], previous = bars[i - 1];
    total += Math.max(current.h - current.l, Math.abs(current.h - previous.c), Math.abs(current.l - previous.c));
  }
  return total / period;
}

export function calculateInitialStop(bars, direction, entryPrice, config = {}) {
  const cfg = normalizeBacktestConfig(config);
  if (!Array.isArray(bars) || !bars.length || !Number.isFinite(Number(entryPrice))) return null;
  const entry = Number(entryPrice);
  let stop;
  if (cfg.stopMode === "atr") {
    const value = averageTrueRange(bars, cfg.atrPeriod);
    if (!(value > 0)) return null;
    stop = direction === "LONG" ? entry - value * cfg.atrMultiplier : entry + value * cfg.atrMultiplier;
  } else {
    const window = bars.slice(-cfg.swingLookback);
    if (window.length < 2) return null;
    stop = direction === "LONG"
      ? Math.min(...window.map(bar => Number(bar.l)))
      : Math.max(...window.map(bar => Number(bar.h)));
  }
  if (!Number.isFinite(stop) || (direction === "LONG" ? stop >= entry : stop <= entry)) return null;
  return stop;
}

export function simulatePosition({ bars, entryIndex, direction, entryPrice, stopPrice, config, regime, capital }) {
  const cfg = normalizeBacktestConfig(config);
  const sign = direction === "LONG" ? 1 : -1;
  const riskPerUnit = Math.abs(entryPrice - stopPrice);
  if (!(riskPerUnit > 0)) return null;
  const targetPrice = entryPrice + sign * riskPerUnit * cfg.rewardRisk;
  const riskCapital = capital;
  const quantity = riskCapital * cfg.riskPercent / 100 / riskPerUnit;
  let breakEvenActive = false;
  const lastIndex = Math.min(bars.length - 1, entryIndex + cfg.maxBarsInTrade - 1);

  for (let i = entryIndex; i <= lastIndex; i++) {
    const bar = bars[i];
    const activeStop = breakEvenActive ? entryPrice : stopPrice;
    let exitPrice = null, exitReason = null;

    if (direction === "LONG") {
      if (bar.o <= activeStop) { exitPrice = bar.o; exitReason = breakEvenActive ? "breakeven_gap" : "stop_gap"; }
      else if (bar.l <= activeStop) { exitPrice = activeStop; exitReason = breakEvenActive ? "breakeven" : "stop"; }
      else if (bar.o >= targetPrice) { exitPrice = bar.o; exitReason = "target_gap"; }
      else if (bar.h >= targetPrice) { exitPrice = targetPrice; exitReason = "target"; }
      else if (!breakEvenActive && bar.h >= entryPrice + riskPerUnit * cfg.breakEvenAtR) breakEvenActive = true;
    } else {
      if (bar.o >= activeStop) { exitPrice = bar.o; exitReason = breakEvenActive ? "breakeven_gap" : "stop_gap"; }
      else if (bar.h >= activeStop) { exitPrice = activeStop; exitReason = breakEvenActive ? "breakeven" : "stop"; }
      else if (bar.o <= targetPrice) { exitPrice = bar.o; exitReason = "target_gap"; }
      else if (bar.l <= targetPrice) { exitPrice = targetPrice; exitReason = "target"; }
      else if (!breakEvenActive && bar.l <= entryPrice - riskPerUnit * cfg.breakEvenAtR) breakEvenActive = true;
    }

    if (exitPrice != null) {
      const slippedEntry = entryPrice * (1 + sign * cfg.slippageRate);
      const slippedExit = exitPrice * (1 - sign * cfg.slippageRate);
      const grossPnl = (slippedExit - slippedEntry) * sign * quantity;
      const fees = (Math.abs(slippedEntry * quantity) + Math.abs(slippedExit * quantity)) * cfg.feeRate;
      const netPnl = grossPnl - fees;
      return {
        entryIndex, exitIndex: i, entryPrice, exitPrice, stopPrice, targetPrice,
        direction, regime, exitReason, breakEvenActivated: breakEvenActive,
        quantity, riskCapital, grossPnl, fees, netPnl, netR: netPnl / riskCapital,
        barsHeld: i - entryIndex + 1
      };
    }
  }

  const finalBar = bars[lastIndex];
  const exitPrice = finalBar.c;
  const slippedEntry = entryPrice * (1 + sign * cfg.slippageRate);
  const slippedExit = exitPrice * (1 - sign * cfg.slippageRate);
  const grossPnl = (slippedExit - slippedEntry) * sign * quantity;
  const fees = (Math.abs(slippedEntry * quantity) + Math.abs(slippedExit * quantity)) * cfg.feeRate;
  const netPnl = grossPnl - fees;
  return {
    entryIndex, exitIndex: lastIndex, entryPrice, exitPrice, stopPrice, targetPrice,
    direction, regime, exitReason: "data_end_or_time_limit",
    breakEvenActivated: breakEvenActive, quantity, riskCapital, grossPnl, fees,
    netPnl, netR: netPnl / riskCapital, barsHeld: lastIndex - entryIndex + 1
  };
}

function summarizeTrades(trades, initialCapital) {
  const wins = trades.filter(trade => trade.netPnl > 0);
  const losses = trades.filter(trade => trade.netPnl < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0));
  let equity = initialCapital, peak = initialCapital, maxDrawdownPct = 0;
  for (const trade of trades) {
    equity += trade.netPnl;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? (peak - equity) / peak * 100 : 0);
  }
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length ? wins.length / trades.length * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    netPnl: trades.reduce((sum, trade) => sum + trade.netPnl, 0),
    netR: trades.reduce((sum, trade) => sum + trade.netR, 0),
    expectancyR: trades.length ? trades.reduce((sum, trade) => sum + trade.netR, 0) / trades.length : 0,
    maxDrawdownPct,
    endingEquity: equity,
    averageBarsHeld: trades.length ? trades.reduce((sum, trade) => sum + trade.barsHeld, 0) / trades.length : 0
  };
}

/**
 * Walk-forward simulation: each signal is evaluated using candles available
 * at that close, entered at the next candle open, and exited only on later bars.
 * Higher-timeframe profile candles are admitted only after their own close.
 */
export function runHistoricalBacktest({
  pair,
  timeframe = "1m",
  candles = [],
  higherTimeframeCandles = [],
  scalpingConfig = {},
  marketRegimeConfig = {},
  backtestConfig = {}
}) {
  const normalizedPair = normalizePair(pair);
  const tf = normalizeTimeframe(timeframe);
  const tfMs = TIMEFRAME_MS[tf];
  if (!normalizedPair || !tfMs) throw new RangeError("A valid USDT perpetual pair and timeframe are required.");

  const cfg = normalizeBacktestConfig(backtestConfig);
  const bars = candles
    .filter(bar => bar && bar.confirm !== false && String(bar.confirm ?? "1") !== "0")
    .map(bar => ({ ts:Number(bar.ts), o:Number(bar.o), h:Number(bar.h), l:Number(bar.l), c:Number(bar.c), v:Number(bar.v), confirm:"1" }))
    .filter(bar => [bar.ts,bar.o,bar.h,bar.l,bar.c,bar.v].every(Number.isFinite) && bar.c > 0 && bar.h >= bar.l)
    .sort((a,b) => a.ts-b.ts);
  const higher = higherTimeframeCandles
    .filter(bar => bar && bar.confirm !== false && String(bar.confirm ?? "1") !== "0")
    .map(bar => ({ ts:Number(bar.ts), o:Number(bar.o), h:Number(bar.h), l:Number(bar.l), c:Number(bar.c), v:Number(bar.v), confirm:"1" }))
    .filter(bar => [bar.ts,bar.o,bar.h,bar.l,bar.c,bar.v].every(Number.isFinite) && bar.c > 0 && bar.h >= bar.l)
    .sort((a,b) => a.ts-b.ts);

  const engineState = {};
  const trades = [];
  const rejected = { noNextCandle:0, invalidStop:0, signalDuringOpenTrade:0 };
  const regimeCounts = { TREND:0, REVERSAL:0, FLAT:0, WAIT:0 };
  const diagnostics = {
    actionableRegimeBars: 0,
    scalpingEvents: 0,
    matchingSignals: 0,
    noMatchingSignal: 0,
    waitReasons: {},
    byRegime: {
      TREND: { bars:0, matchingSignals:0, noMatchingSignal:0, volumeNotConfirmed:0, rsiNotExtreme:0, directionMismatch:0, otherSuppression:0 },
      REVERSAL: { bars:0, matchingSignals:0, noMatchingSignal:0, volumeNotConfirmed:0, rsiNotExtreme:0, directionMismatch:0, otherSuppression:0 }
    },
    samples: []
  };
  let blockedUntilIndex = -1;
  const profileTf = resolveProfileTimeframe(tf, marketRegimeConfig.profileTimeframe || "auto");
  const profileMs = TIMEFRAME_MS[profileTf] || tfMs;

  for (let i = 0; i < bars.length - 1; i++) {
    if (i <= blockedUntilIndex) continue;
    const history = bars.slice(0, i + 1);
    const candleCloseTs = bars[i].ts + tfMs;
    const closedProfileBars = higher.filter(bar => bar.ts + profileMs <= candleCloseTs);
    const regime = classifyMarketRegime(history, marketRegimeConfig, {
      higherTimeframeBars: closedProfileBars,
      timeframe: tf
    });
    if (Object.hasOwn(regimeCounts, regime.state)) regimeCounts[regime.state]++;
    for (const reason of regime.reasons || []) {
      diagnostics.waitReasons[reason] = (diagnostics.waitReasons[reason] || 0) + 1;
    }

    if (regime.blockSignals === true || !regime.actionable || !regime.direction) {
      continue;
    }

    diagnostics.actionableRegimeBars++;
    const regimeDiagnostic = diagnostics.byRegime[regime.state];
    if (regimeDiagnostic) regimeDiagnostic.bars++;
    const result = evaluateScalpingBars(history, normalizedPair, tf, {
      config: scalpingConfig,
      state: engineState,
      now: candleCloseTs
    });
    Object.assign(engineState, result.state);
    const scalpingEvents = result.events.filter(event => event.kind === "scalping");
    diagnostics.scalpingEvents += scalpingEvents.length;
    const signal = scalpingEvents.find(event => event.direction === regime.direction);
    if (!signal) {
      diagnostics.noMatchingSignal++;
      if (regimeDiagnostic) regimeDiagnostic.noMatchingSignal++;
      const metrics = result.metrics || {};
      const volumeMultiple = Number(metrics.volumeMultiple);
      const volumePass = Number.isFinite(volumeMultiple) && volumeMultiple > Number(scalpingConfig.volumeMultiplier ?? 2);
      const rsiValue = Number(metrics.rsi);
      const rsiLong = Number.isFinite(rsiValue) && rsiValue <= Number(scalpingConfig.rsiOversold ?? 30);
      const rsiShort = Number.isFinite(rsiValue) && rsiValue >= Number(scalpingConfig.rsiOverbought ?? 70);
      const directionCandidate = regime.direction === "LONG" ? rsiLong : rsiShort;
      const oppositeCandidate = regime.direction === "LONG" ? rsiShort : rsiLong;
      let reason = "otherSuppression";
      if (!volumePass) reason = "volumeNotConfirmed";
      else if (!directionCandidate && oppositeCandidate) reason = "directionMismatch";
      else if (!directionCandidate) reason = "rsiNotExtreme";
      if (regimeDiagnostic) regimeDiagnostic[reason]++;
      if (diagnostics.samples.length < 20) diagnostics.samples.push({
        timestamp: bars[i].ts,
        regime: regime.state,
        direction: regime.direction,
        volumeMultiple: Number.isFinite(volumeMultiple) ? Number(volumeMultiple.toFixed(3)) : null,
        requiredVolumeMultiple: Number(scalpingConfig.volumeMultiplier ?? 2),
        rsi: Number.isFinite(rsiValue) ? Number(rsiValue.toFixed(2)) : null,
        rsiLongThreshold: Number(scalpingConfig.rsiOversold ?? 30),
        rsiShortThreshold: Number(scalpingConfig.rsiOverbought ?? 70),
        bos: metrics.bos || null,
        choch: metrics.choch || null,
        reasons: regime.reasons || [],
        scalpingEvents: scalpingEvents.map(event => ({ direction:event.direction, label:event.label }))
      });
      continue;
    }
    diagnostics.matchingSignals++;
    if (regimeDiagnostic) regimeDiagnostic.matchingSignals++;

    const entryIndex = i + 1;
    const entryPrice = bars[entryIndex].o;
    const stopPrice = calculateInitialStop(history, regime.direction, entryPrice, cfg);
    if (stopPrice == null) { rejected.invalidStop++; continue; }

    const capital = cfg.initialCapital + trades.reduce((sum, item) => sum + item.netPnl, 0);
    const trade = simulatePosition({
      bars,
      entryIndex,
      direction: regime.direction,
      entryPrice,
      stopPrice,
      config: cfg,
      regime: regime.state,
      capital
    });
    if (!trade) continue;
    trade.signalTs = bars[i].ts;
    trade.entryTs = bars[entryIndex].ts;
    trade.exitTs = bars[trade.exitIndex]?.ts ?? null;
    trade.pair = normalizedPair;
    trade.timeframe = tf;
    trade.signalLabel = signal.label || signal.kind;
    trade.stopMode = cfg.stopMode;
    trades.push(trade);
    blockedUntilIndex = trade.exitIndex;
    i = blockedUntilIndex;
  }

  return {
    pair: normalizedPair,
    timeframe: tf,
    data: {
      candles: bars.length,
      start: bars[0]?.ts ?? null,
      end: bars.at(-1)?.ts ?? null,
      higherTimeframeCandles: higher.length
    },
    config: cfg,
    summary: summarizeTrades(trades, cfg.initialCapital),
    byRegime: {
      TREND: trades.filter(trade => trade.regime === "TREND").length,
      REVERSAL: trades.filter(trade => trade.regime === "REVERSAL").length
    },
    regimeCounts,
    diagnostics,
    rejected,
    trades
  };
}
