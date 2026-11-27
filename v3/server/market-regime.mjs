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
  swingLength: 3,
  marketStructureEnabled: true,
  volumeProfileEnabled: true,
  profileTimeframe: "auto",
  profileLookback: 100,
  profileBins: 32,
  valueAreaPct: 70,
  requireRetest: true,
  retestLookback: 8,
  retestToleranceAtr: 0.25
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
  cfg.marketStructureEnabled = cfg.marketStructureEnabled !== false;
  cfg.volumeProfileEnabled = cfg.volumeProfileEnabled !== false;
  cfg.profileTimeframe = ["auto", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d", "1w"].includes(String(cfg.profileTimeframe)) ? String(cfg.profileTimeframe) : "auto";
  cfg.profileLookback = Math.round(clamp(cfg.profileLookback, 20, 300, DEFAULTS.profileLookback));
  cfg.profileBins = Math.round(clamp(cfg.profileBins, 12, 100, DEFAULTS.profileBins));
  cfg.valueAreaPct = clamp(cfg.valueAreaPct, 50, 90, DEFAULTS.valueAreaPct);
  cfg.requireRetest = cfg.requireRetest !== false;
  cfg.retestLookback = Math.round(clamp(cfg.retestLookback, 2, 30, DEFAULTS.retestLookback));
  cfg.retestToleranceAtr = clamp(cfg.retestToleranceAtr, 0.05, 1.5, DEFAULTS.retestToleranceAtr);
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


const TIMEFRAME_MS = Object.freeze({ "1m":60000,"3m":180000,"5m":300000,"15m":900000,"30m":1800000,"1h":3600000,"2h":7200000,"4h":14400000,"6h":21600000,"12h":43200000,"1d":86400000,"1w":604800000 });
const PROFILE_TF = Object.freeze({ "1m":"15m","3m":"15m","5m":"1h","15m":"4h","30m":"4h","1h":"1d","2h":"1d","4h":"1d","6h":"1d","12h":"1w","1d":"1w","1w":"1w" });

export function resolveProfileTimeframe(timeframe, configured = "auto") {
  return configured && configured !== "auto" ? configured : (PROFILE_TF[String(timeframe || "1m")] || "1h");
}

function confirmedPivots(bars, length) {
  const highs = [], lows = [];
  for (let i = length; i < bars.length - length; i++) {
    const high = bars[i].h, low = bars[i].l;
    let isHigh = true, isLow = true;
    for (let j = i - length; j <= i + length; j++) {
      if (j === i) continue;
      if (bars[j].h >= high) isHigh = false;
      if (bars[j].l <= low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ price: high, ts: bars[i].ts, index: i });
    if (isLow) lows.push({ price: low, ts: bars[i].ts, index: i });
  }
  return { highs, lows };
}

function structureBias(highs, lows) {
  if (highs.length < 2 || lows.length < 2) return null;
  const h1 = highs.at(-2).price, h2 = highs.at(-1).price;
  const l1 = lows.at(-2).price, l2 = lows.at(-1).price;
  if (h2 > h1 && l2 > l1) return "LONG";
  if (h2 < h1 && l2 < l1) return "SHORT";
  return null;
}

function detectStructureEvent(bars, config, atrValue) {
  if (!config.marketStructureEnabled || bars.length < config.swingLength * 2 + 8) return null;
  const { highs, lows } = confirmedPivots(bars, config.swingLength);
  if (!highs.length || !lows.length) return null;
  const lastHigh = highs.at(-1), lastLow = lows.at(-1);
  const bias = structureBias(highs, lows);
  const lastIndex = bars.length - 1;
  const start = Math.max(1, lastIndex - config.retestLookback);
  let breakout = null;
  for (let i = start; i <= lastIndex; i++) {
    const previous = bars[i - 1], current = bars[i];
    const validHigh = [...highs].reverse().find(p => p.index <= i - config.swingLength - 1);
    const validLow = [...lows].reverse().find(p => p.index <= i - config.swingLength - 1);
    if (validHigh && previous.c <= validHigh.price && current.c > validHigh.price) {
      const priorHighs = highs.filter(p => p.index < i - config.swingLength);
      const priorLows = lows.filter(p => p.index < i - config.swingLength);
      const priorBias = structureBias(priorHighs, priorLows);
      breakout = { direction:"LONG", level:validHigh.price, pivotTs:validHigh.ts, index:i,
        kind:priorBias === "SHORT" ? "CHOCH" : "BOS", priorBias };
    } else if (validLow && previous.c >= validLow.price && current.c < validLow.price) {
      const priorHighs = highs.filter(p => p.index < i - config.swingLength);
      const priorLows = lows.filter(p => p.index < i - config.swingLength);
      const priorBias = structureBias(priorHighs, priorLows);
      breakout = { direction:"SHORT", level:validLow.price, pivotTs:validLow.ts, index:i,
        kind:priorBias === "LONG" ? "CHOCH" : "BOS", priorBias };
    }
  }
  if (!breakout) return { bias, lastHigh:lastHigh.price, lastLow:lastLow.price, event:null };
  const last = bars.at(-1);
  const tolerance = Math.max((Number(atrValue) || 0) * config.retestToleranceAtr, Math.abs(last.c) * 0.00015);
  const touched = breakout.direction === "LONG"
    ? last.l <= breakout.level + tolerance && last.c > breakout.level
    : last.h >= breakout.level - tolerance && last.c < breakout.level;
  const retest = breakout.index < lastIndex && touched;
  return { ...breakout, bias, retest, tolerance, lastHigh:lastHigh.price, lastLow:lastLow.price };
}

function calculateVolumeProfile(rawBars, config, lowerBars, lowerTimeframe) {
  if (!config.volumeProfileEnabled || !Array.isArray(rawBars) || !rawBars.length) return null;
  const bars = normalizeBars(rawBars);
  const lowerLast = lowerBars.at(-1);
  const lowerMs = TIMEFRAME_MS[lowerTimeframe] || 60000;
  const profileTf = resolveProfileTimeframe(lowerTimeframe, config.profileTimeframe);
  const profileMs = TIMEFRAME_MS[profileTf] || lowerMs;
  // Exclude higher-timeframe candles that had not closed by the last lower-TF close.
  const cutoff = Number(lowerLast?.ts) + lowerMs;
  const closed = bars.filter(bar => bar.ts + profileMs <= cutoff);
  const sample = closed.slice(-config.profileLookback);
  if (sample.length < 20) return { ready:false, reason:"Недостаточно закрытых свечей старшего ТФ", candles:sample.length };
  let min = Math.min(...sample.map(b=>b.l)), max = Math.max(...sample.map(b=>b.h));
  if (!(max > min)) return { ready:false, reason:"Диапазон Volume Profile слишком узкий", candles:sample.length };
  const bins = config.profileBins, step=(max-min)/bins, volumes=new Array(bins).fill(0);
  for (const bar of sample) {
    // OHLCV approximation: allocate each candle's reported volume to its typical price.
    const typical=(bar.h+bar.l+bar.c)/3;
    const index=Math.max(0,Math.min(bins-1,Math.floor((typical-min)/step)));
    volumes[index]+=bar.v;
  }
  const total=volumes.reduce((a,b)=>a+b,0);
  if (!(total>0)) return { ready:false, reason:"Нет объёма для построения профиля", candles:sample.length };
  let poc=0;
  for(let i=1;i<bins;i++) if(volumes[i]>volumes[poc]) poc=i;
  let left=poc,right=poc,covered=volumes[poc],target=total*config.valueAreaPct/100;
  while(covered<target && (left>0 || right<bins-1)) {
    const lv=left>0?volumes[left-1]:-1, rv=right<bins-1?volumes[right+1]:-1;
    if(rv>lv){right++;covered+=volumes[right];}
    else if(left>0){left--;covered+=volumes[left];}
    else break;
  }
  return { ready:true, timeframe:profileTf || "auto", candles:sample.length, poc:min+(poc+0.5)*step,
    vah:min+(right+1)*step, val:min+left*step, valueAreaPct:config.valueAreaPct,
    close:lowerLast?.c, position:lowerLast?.c>min+(right+1)*step?"ABOVE_VA":lowerLast?.c<min+left*step?"BELOW_VA":"IN_VALUE_AREA" };
}

export function classifyMarketRegime(rawBars, inputConfig = {}, context = {}) {
  const config = normalizeMarketRegimeConfig(inputConfig);
  const bars = normalizeBars(rawBars);
  const minimum = Math.max(config.smaPeriod + config.slopeLookback, config.atrPeriod * 2 + 1, config.volumePeriod + 1, config.swingLength * 2 + 8);
  if (!config.enabled) return { state:"DISABLED", direction:null, actionable:false, reasons:["Модуль анализа отключён"] };
  if (bars.length < minimum) return { state:"WAIT", direction:null, actionable:false, reasons:["Недостаточно закрытых свечей"], metrics:{candles:bars.length,required:minimum} };

  const closes=bars.map(bar=>bar.c), last=bars.at(-1), previous=bars.at(-2);
  const currentSma=sma(closes,config.smaPeriod), priorSma=sma(closes,config.smaPeriod,bars.length-1-config.slopeLookback);
  const slopePct=currentSma&&priorSma?((currentSma-priorSma)/priorSma)*100:0;
  const currentAtr=atr(bars,config.atrPeriod), olderAtr=atr(bars.slice(0,-config.atrPeriod),config.atrPeriod);
  const atrRatio=currentAtr&&olderAtr?currentAtr/olderAtr:null;
  const rangeBars=bars.slice(-config.smaPeriod);
  const rangePct=((Math.max(...rangeBars.map(b=>b.h))-Math.min(...rangeBars.map(b=>b.l)))/last.c)*100;
  const baselineVolume=averageVolume(bars,config.volumePeriod), volumeRatio=baselineVolume>0?last.v/baselineVolume:null;
  const currentRsi=rsi(closes,config.smaPeriod>=14?14:config.smaPeriod);
  const crossedUp=previous.c<=(sma(closes,config.smaPeriod,bars.length-2)??currentSma)&&last.c>currentSma;
  const crossedDown=previous.c>=(sma(closes,config.smaPeriod,bars.length-2)??currentSma)&&last.c<currentSma;
  const nearSma=Math.abs((last.c-currentSma)/currentSma)*100<=Math.max(config.maxFlatSlopePct*3,0.08);
  const compressed=atrRatio!=null&&atrRatio<config.minAtrRatio, lowSlope=Math.abs(slopePct)<=config.maxFlatSlopePct;
  const narrowRange=rangePct<=config.maxFlatRangePct;
  const flat=config.flatFilterEnabled&&((lowSlope&&narrowRange)||(compressed&&nearSma));
  const volumeConfirmed=volumeRatio!=null&&volumeRatio>=config.minVolumeRatio;
  const profile=calculateVolumeProfile(context.higherTimeframeBars,config,bars,context.timeframe||"1m");
  const structure=detectStructureEvent(bars,config,currentAtr);
  const metrics={close:last.c,sma:currentSma,slopePct,atr:currentAtr,atrPercent:currentAtr/last.c*100,atrRatio,rangePct,volumeRatio,rsi:currentRsi,
    bos:structure?.kind==="BOS"?structure:null,choch:structure?.kind==="CHOCH"?structure:null,structureBias:structure?.bias||null,
    retest:structure?.retest===true,volumeProfile:profile};
  if(flat) return {state:"FLAT",direction:null,actionable:false,blockSignals:true,reasons:[
    lowSlope?"Наклон SMA недостаточный":null,narrowRange?"Узкий диапазон цены":null,compressed&&nearSma?"ATR сжат и цена около SMA":null
  ].filter(Boolean),metrics};

  const profileLong=!config.volumeProfileEnabled||(profile?.ready===true&&profile.position!=="BELOW_VA");
  const profileShort=!config.volumeProfileEnabled||(profile?.ready===true&&profile.position!=="ABOVE_VA");
  const trendDirection=last.c>currentSma&&slopePct>config.maxFlatSlopePct?"LONG":last.c<currentSma&&slopePct< -config.maxFlatSlopePct?"SHORT":null;
  const structureConfirmed=structure?.kind==="BOS"&&structure.retest===true;
  const reversalConfirmed=structure?.kind==="CHOCH"&&structure.retest===true;
  const canActOnRetest=!config.requireRetest||(structure?.retest===true);
  const reversalDirection=reversalConfirmed&&volumeConfirmed&&
    ((structure.direction==="LONG"&&currentRsi<=config.reversalRsiLongMax&&profileLong)||(structure.direction==="SHORT"&&currentRsi>=config.reversalRsiShortMin&&profileShort))
      ?structure.direction:null;

  if(config.reversalEnabled&&reversalDirection) return {state:"REVERSAL",direction:reversalDirection,actionable:true,blockSignals:false,
    reasons:["CHoCH: подтверждена смена рыночной структуры","Ретест уровня структуры подтверждён","Объём и RSI подтверждают разворот",profile?.ready?"Volume Profile старшего ТФ учтён":"Volume Profile пока недоступен"],metrics};
  if(config.trendEnabled&&trendDirection&&structureConfirmed&&structure.direction===trendDirection&&volumeConfirmed&&canActOnRetest&&
    (trendDirection==="LONG"?profileLong:profileShort)) return {state:"TREND",direction:trendDirection,actionable:true,blockSignals:false,
    reasons:["BOS подтверждает продолжение структуры","Ретест уровня пробоя подтверждён","Цена и SMA21 направлены одинаково","Объём и Volume Profile поддерживают направление"],metrics};

  const waitingReason=structure?.kind==="CHOCH"?"CHoCH обнаружен — ожидаем ретест и подтверждение":
    structure?.kind==="BOS"?"BOS обнаружен — ожидаем ретест и подтверждение":
    !profile?.ready?"Ожидание данных Volume Profile старшего ТФ":"Нет подтверждённого BOS/CHoCH и ретеста";
  return {state:"WAIT",direction:null,actionable:false,blockSignals:false,reasons:[waitingReason],metrics};
}

export const DEFAULT_MARKET_REGIME_CONFIG = DEFAULTS;
