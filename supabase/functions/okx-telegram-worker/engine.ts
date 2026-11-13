import { recordPerformanceSignal, updatePerformanceOutcomes } from "./statistics.js";
import { volumeProfileCrossings, volumeProfileProximity } from "./volume-profile.js";
import { diagnoseComboReversal } from "./combo-reversal.js";

type Candle = {
  ts: number; o: number; h: number; l: number; c: number; v: number; confirm: boolean;
};
type Preview = {
  kind: string; pair: string; tf: string; direction: string; signalTs: number;
  price: number; details: string; createdAt: string;
};

const VOLUME_PERIOD = Math.max(2, Math.min(100, Number(Deno.env.get("VOLUME_PERIOD") || 20)));
const VOLUME_MULT = Math.max(1, Number(Deno.env.get("VOLUME_MULT") || 2));
const RSI_PERIOD = Math.max(2, Math.min(100, Number(Deno.env.get("RSI_PERIOD") || 14)));
const RSI_LOW = Number(Deno.env.get("RSI_LOW") || 30);
const RSI_HIGH = Number(Deno.env.get("RSI_HIGH") || 70);
const SMA_PERIOD = Math.max(2, Math.min(200, Number(Deno.env.get("SMA_PERIOD") || 21)));
const VP_PERIOD = Math.max(20, Math.min(90, Number(Deno.env.get("VP_PERIOD") || 60)));
const VP_ROWS = Math.max(10, Math.min(60, Number(Deno.env.get("VP_ROWS") || 30)));
const VP_MODE_VALUE = String(Deno.env.get("VP_MODE") || "poc").toLowerCase();
const VP_MODE = ["poc", "va", "all"].includes(VP_MODE_VALUE) ? VP_MODE_VALUE : "poc";
const COOLDOWN_MS = Math.max(30_000, Number(Deno.env.get("ALERT_COOLDOWN_SECONDS") || 180) * 1000);
const MAX_RULES_PER_TICK = 20;

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
}
function average(values: number[]) {
  return values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : 0;
}
function sma(candles: Candle[], n: number, end = candles.length) {
  if (end < n) return null;
  return average(candles.slice(end - n, end).map((c) => c.c));
}
function rsi(candles: Candle[], n: number, end = candles.length) {
  if (end < n + 1) return null;
  let gains = 0, losses = 0;
  for (let i = end - n; i < end; i++) {
    const delta = candles[i].c - candles[i - 1].c;
    if (delta > 0) gains += delta;
    else losses -= delta;
  }
  if (!losses) return 100;
  if (!gains) return 0;
  return 100 - 100 / (1 + gains / losses);
}
function choppiness(candles: Candle[], n = 14) {
  const period = clamp(Math.round(Number(n) || 14), 5, 50);
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const window = candles.slice(-period);
  let sumTR = 0, highest = -Infinity, lowest = Infinity;
  for (let i = 0; i < window.length; i++) {
    const candle = window[i];
    const previous = i === 0 ? candles[candles.length - period - 1] : window[i - 1];
    const high = Number(candle.h), low = Number(candle.l), previousClose = Number(previous.c);
    if (![high, low, previousClose].every(Number.isFinite)) return null;
    sumTR += Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
    highest = Math.max(highest, high);
    lowest = Math.min(lowest, low);
  }
  const span = highest - lowest;
  if (span <= 0 || sumTR <= 0) return null;
  return clamp(100 * Math.log10(sumTR / span) / Math.log10(period), 0, 100);
}
function timeframeMs(tf: string) {
  const match = String(tf).toLowerCase().match(/^(\d+)(m|h|d|w)$/);
  if (!match) throw new Error("Unsupported timeframe: " + tf);
  return Number(match[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as Record<string, number>)[match[2]];
}
function barFor(tf: string) {
  return ({ "1h": "1H", "2h": "2H", "4h": "4H", "6h": "6H", "12h": "12H", "1d": "1D", "1w": "1W" } as Record<string,string>)[tf.toLowerCase()] || tf;
}
function price(n: number) {
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: 8 });
}
function previewSend(
  state: Record<string, any>,
  previews: Preview[],
  rule: Record<string, any>,
  kind: string,
  pair: string,
  tf: string,
  direction: string,
  closePrice: number,
  details: string,
  signalTs: number,
) {
  if (rule.telegram !== true) return;
  const key = [kind, pair, tf, direction].join(":");
  const now = Date.now();
  state.dryRunLastAlertAt ||= {};
  if (now - (Number(state.dryRunLastAlertAt[key]) || 0) < COOLDOWN_MS) return;
  state.dryRunLastAlertAt[key] = now;
  previews.push({
    kind, pair, tf, direction, signalTs, price: closePrice, details,
    createdAt: new Date(now).toISOString(),
  });
}

function recordSignal(
  state: Record<string, any>,
  previews: Preview[],
  pair: string,
  tf: string,
  kind: string,
  direction: string,
  ts: number,
  closePrice: number,
  rule: Record<string, any>,
  candles: Candle[],
) {
  recordPerformanceSignal(state, { pair, tf, kind, direction, ts, price: closePrice });
  const required = clamp(Number(rule.comboCount ?? 2), 2, 4);
  // Reversal COMBO 4/4 evaluates four predicates directly on one closed candle.
  if (rule.combo && required === 4 && rule.comboMode === "reversal") return;

  const comboWindowBars = clamp(Number(rule.comboWindowBars ?? 1), 1, 5);
  state.recentSignals = (Array.isArray(state.recentSignals) ? state.recentSignals : [])
    .filter((s: any) => Date.now() - s.ts <= timeframeMs(tf) * comboWindowBars * 5);
  const id = [pair, tf, kind, direction, ts].join(":");
  if (!state.recentSignals.some((s: any) => s.id === id)) {
    state.recentSignals.push({ id, pair, tf, kind, direction, ts, price: closePrice });
  }
  state.recentSignals = state.recentSignals.slice(-500);
  if (!rule.combo) return;

  const windowMs = timeframeMs(tf) * comboWindowBars;
  const recent = state.recentSignals.filter((s: any) =>
    s.pair === pair && s.tf === tf &&
    (required === 4 ? s.ts === ts : Math.abs(ts - s.ts) <= windowMs)
  );
  const byKind = new Map<string, any>();
  for (const signal of recent) {
    const old = byKind.get(signal.kind);
    if (!old || Math.abs(ts - signal.ts) < Math.abs(ts - old.ts)) byKind.set(signal.kind, signal);
  }
  const chosen = [...byKind.values()];
  if (chosen.length < required) return;

  const directed = chosen.filter((s: any) => s.kind !== "volume");
  if (!directed.length || directed.some((s: any) => s.direction !== directed[0].direction)) return;

  const comboTs = Math.max(...chosen.map((s: any) => s.ts));
  if (rule.chopFilter) {
    const chop = choppiness(candles, rule.chopPeriod);
    const threshold = clamp(Number(rule.chopThreshold) || 61.8, 20, 100);
    if (chop == null || chop >= threshold) {
      state.recentSignals = state.recentSignals.filter((s: any) =>
        !(s.pair === pair && s.tf === tf && s.ts <= comboTs)
      );
      return;
    }
  }
  const comboPrice = Number(directed[0].price) || closePrice;
  const description = required === 4 ? "одна и та же закрытая свеча" : "окно " + comboWindowBars + " свечи";
  const details = chosen.length + "/4 • " +
    chosen.map((s: any) => String(s.kind).toUpperCase()).join(" + ") + " • " +
    description +
    (rule.chopFilter ? " • CHOP " + (choppiness(candles, rule.chopPeriod) ?? NaN).toFixed(1) : "");
  recordPerformanceSignal(state, {
    pair, tf, kind: "combo", direction: directed[0].direction, ts: comboTs, price: comboPrice,
  });
  previewSend(state, previews, rule, "combo", pair, tf, directed[0].direction, comboPrice, details, comboTs);
  state.recentSignals = state.recentSignals.filter((s: any) =>
    !(s.pair === pair && s.tf === tf && s.ts <= comboTs)
  );
}

async function fetchCandles(pair: string, tf: string): Promise<Candle[]> {
  const url = new URL("https://www.okx.com/api/v5/market/candles");
  url.searchParams.set("instId", pair);
  url.searchParams.set("bar", barFor(tf));
  url.searchParams.set("limit", "100");
  const response = await fetch(url, {
    headers: { "user-agent": "OKX-Signal-Pro-Supabase-Worker/1.0" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("OKX HTTP " + response.status);
  const body = await response.json();
  if (body?.code !== "0" || !Array.isArray(body.data)) {
    throw new Error(String(body?.msg || "Invalid OKX response"));
  }
  return body.data.map((row: any[]) => ({
    ts: Number(row[0]), o: Number(row[1]), h: Number(row[2]), l: Number(row[3]),
    c: Number(row[4]), v: Number(row[5]), confirm: String(row[8]) === "1",
  })).filter((c: Candle) => Number.isFinite(c.ts) && c.c > 0).sort((a: Candle,b: Candle) => a.ts - b.ts);
}

async function processRule(
  state: Record<string, any>,
  rule: Record<string, any>,
  previews: Preview[],
) {
  const pair = String(rule.pair);
  const tf = String(rule.tf);
  const candles = await fetchCandles(pair, tf);
  const minimum = Math.max(SMA_PERIOD, VOLUME_PERIOD, RSI_PERIOD, rule.vp ? VP_PERIOD + 2 : 0) + 2;
  if (candles.length < minimum) {
    return { pair, tf, processed: false, reason: "insufficient_candles", candleCount: candles.length };
  }
  const closed = candles.filter((c) => c.confirm);
  if (closed.length < 3) {
    return { pair, tf, processed: false, reason: "insufficient_closed_candles", candleCount: closed.length };
  }

  updatePerformanceOutcomes(state, pair, tf, closed);
  const last = closed[closed.length - 1];
  const candleKey = pair + ":" + tf;
  const lastSeen = Number(state.lastClosed?.[candleKey]) || 0;
  const isNewClosedCandle = last.ts > lastSeen;
  if (!isNewClosedCandle) {
    return { pair, tf, processed: true, newClosedCandle: false, lastClosedTs: last.ts };
  }

  state.lastClosed ||= {};
  state.lastClosed[candleKey] = last.ts;
  const end = closed.length;
  let rsiSignalDirection: string | null = null;

  if (rule.volume && end >= VOLUME_PERIOD + 1) {
    const base = closed.slice(end - VOLUME_PERIOD - 1, end - 1).map((c) => c.v);
    const avg = average(base);
    const multiple = avg > 0 ? last.v / avg : 0;
    if (multiple >= VOLUME_MULT) {
      const direction = last.c >= last.o ? "LONG" : "SHORT";
      if (rule.telegram && rule.comboOnly !== true) {
        previewSend(state, previews, rule, "volume", pair, tf, direction, last.c,
          "Объём: ×" + multiple.toFixed(1) + " от среднего", last.ts);
      }
      recordSignal(state, previews, pair, tf, "volume", direction, last.ts, last.c, rule, closed);
    }
  }

  if (rule.rsi) {
    const value = rsi(closed, RSI_PERIOD, end);
    const previous = rsi(closed, RSI_PERIOD, end - 1);
    if (value != null && previous != null) {
      if (previous >= RSI_LOW && value < RSI_LOW) {
        rsiSignalDirection = "LONG";
        if (rule.telegram && rule.comboOnly !== true) {
          previewSend(state, previews, rule, "rsi", pair, tf, "LONG", last.c,
            "RSI: " + value.toFixed(1) + " — выход ниже " + RSI_LOW, last.ts);
        }
        recordSignal(state, previews, pair, tf, "rsi", "LONG", last.ts, last.c, rule, closed);
      }
      if (previous <= RSI_HIGH && value > RSI_HIGH) {
        rsiSignalDirection = "SHORT";
        if (rule.telegram && rule.comboOnly !== true) {
          previewSend(state, previews, rule, "rsi", pair, tf, "SHORT", last.c,
            "RSI: " + value.toFixed(1) + " — выход выше " + RSI_HIGH, last.ts);
        }
        recordSignal(state, previews, pair, tf, "rsi", "SHORT", last.ts, last.c, rule, closed);
      }
    }
  }

  if (rule.vp && end >= VP_PERIOD + 2) {
    const profileBars = closed.slice(0, -1).slice(-VP_PERIOD);
    const previous = closed[closed.length - 2];
    if (rule.vpNear && rsiSignalDirection) {
      const nearby = volumeProfileProximity(profileBars, last.c, "all", VP_ROWS, 1);
      for (const level of nearby) {
        const details = "Volume Profile " + level.level + ": цена рядом с уровнем " +
          price(level.price) + " (дистанция " + price(level.distance) +
          ", допуск 1 ряд); RSI подтверждает " + rsiSignalDirection;
        if (rule.telegram && rule.comboOnly !== true) {
          previewSend(state, previews, rule, "vp", pair, tf, rsiSignalDirection, last.c, details, last.ts);
        }
        recordSignal(state, previews, pair, tf, "vp", rsiSignalDirection, last.ts, last.c, rule, closed);
      }
    } else if (!rule.vpNear) {
      const crossings = volumeProfileCrossings(profileBars, previous?.c, last.c, VP_MODE, VP_ROWS);
      for (const crossing of crossings) {
        const details = "Volume Profile " + crossing.level + ": пересечение уровня " +
          price(crossing.price) + "; close " + price(last.c);
        if (rule.telegram && rule.comboOnly !== true) {
          previewSend(state, previews, rule, "vp", pair, tf, crossing.direction, last.c, details, last.ts);
        }
        recordSignal(state, previews, pair, tf, "vp", crossing.direction, last.ts, last.c, rule, closed);
      }
    }
  }

  if (rule.sma) {
    const averageLine = sma(closed, SMA_PERIOD);
    if (averageLine && last.l <= averageLine && last.h >= averageLine) {
      const previous = closed[closed.length - 2];
      const previousSma = sma(closed.slice(0, -1), SMA_PERIOD);
      const direction = previous && previousSma != null && previous.c >= previousSma ? "LONG" : "SHORT";
      const details = "SMA" + SMA_PERIOD + ": " + price(averageLine) + " (закрытая свеча)";
      if (rule.telegram && rule.comboOnly !== true) {
        previewSend(state, previews, rule, "sma", pair, tf, direction, last.c, details, last.ts);
      }
      recordSignal(state, previews, pair, tf, "sma", direction, last.ts, last.c, rule, closed);
    }
  }

  if (rule.combo && Number(rule.comboCount) === 4 && rule.comboMode === "reversal") {
    const diagnosis = diagnoseComboReversal(closed, {
      volumePeriod: VOLUME_PERIOD, volumeMult: VOLUME_MULT,
      rsiPeriod: RSI_PERIOD, rsiLow: RSI_LOW, rsiHigh: RSI_HIGH,
      smaPeriod: SMA_PERIOD, vpPeriod: VP_PERIOD, vpRows: VP_ROWS,
    });
    const reversal = diagnosis.signal;
    if (reversal) {
      let blocked = false;
      let chopValue: number | null = null;
      if (rule.chopFilter) {
        chopValue = choppiness(closed, rule.chopPeriod);
        const threshold = clamp(Number(rule.chopThreshold) || 61.8, 20, 100);
        if (chopValue == null || chopValue >= threshold) blocked = true;
      }
      if (!blocked) {
        const vpLabel = reversal.vpLevel === "VAL" ? "VAL" : "VAH";
        const details = "Разворот 4/4 • объём ×" + reversal.volumeMultiple.toFixed(1) +
          " • RSI " + reversal.rsi.toFixed(1) + " • " +
          (reversal.direction === "LONG" ? "цена ниже" : "цена выше") +
          " SMA" + SMA_PERIOD + " " + price(reversal.sma) +
          " • возле " + vpLabel + " " + price(reversal.vpPrice) +
          " • одна закрытая свеча" +
          (rule.chopFilter ? " • CHOP " + (chopValue ?? NaN).toFixed(1) : "");
        recordPerformanceSignal(state, {
          pair, tf, kind: "combo", direction: reversal.direction, ts: last.ts, price: last.c,
        });
        previewSend(state, previews, rule, "combo", pair, tf, reversal.direction, last.c, details, last.ts);
      }
    }
  }

  return { pair, tf, processed: true, newClosedCandle: true, lastClosedTs: last.ts };
}

export async function runDryRunTick(rules: Record<string, any>[], state: Record<string, any>) {
  const previews: Preview[] = [];
  const results: Record<string, any>[] = [];
  const errors: Record<string, string>[] = [];
  const selected = rules.slice(0, MAX_RULES_PER_TICK);

  state.lastClosed ||= {};
  state.lastAlertAt ||= {};
  state.lastSmaTouch ||= {};
  state.recentSignals ||= [];
  state.performanceSignals ||= [];
  state.telegramHistory ||= [];
  state.dryRunLastAlertAt ||= {};

  for (const rule of selected) {
    try {
      results.push(await processRule(state, rule, previews));
    } catch (error) {
      errors.push({
        pair: String(rule?.pair || ""),
        tf: String(rule?.tf || ""),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    ok: errors.length === 0,
    mode: "dry-run-only",
    telegramSendingEnabled: false,
    rulesProcessed: selected.length,
    rulesSkippedByBudget: Math.max(0, rules.length - selected.length),
    results,
    errors,
    previews,
    performanceSignalCount: state.performanceSignals.length,
    historyCount: state.telegramHistory.length,
  };
}
