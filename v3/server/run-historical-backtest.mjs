import { fetchOkxHistoricalCandles } from "./okx-market-data.mjs";
import { runHistoricalBacktest, normalizeBacktestConfig } from "./historical-backtest.mjs";
import { normalizeConfig } from "./scalping-engine.mjs";
import { normalizeMarketRegimeConfig, resolveProfileTimeframe } from "./market-regime.mjs";

function readArgs(argv) {
  const values = Object.fromEntries(argv.filter(value => value.startsWith("--")).map(value => {
    const index = value.indexOf("=");
    return index < 0 ? [value.slice(2), "true"] : [value.slice(2, index), value.slice(index + 1)];
  }));
  return {
    pairs: String(values.pairs || "ZEC,NEAR").split(",").map(value => value.trim()).filter(Boolean),
    timeframe: values.timeframe || "1m",
    maxCandles: Math.max(300, Math.min(20_000, Number(values["max-candles"]) || 5_000)),
    stopMode: values["stop-mode"] === "atr" ? "atr" : "swing",
    startTime: values.start ? Date.parse(values.start) : undefined,
    endTime: values.end ? Date.parse(values.end) : Date.now()
  };
}

const args = readArgs(process.argv.slice(2));
const regimeConfig = normalizeMarketRegimeConfig({
  enabled:true,
  flatFilterEnabled:true,
  trendEnabled:true,
  reversalEnabled:true,
  volumeProfileEnabled:true,
  profileTimeframe:"auto",
  requireRetest:true
});
const scalpingConfig = normalizeConfig({ enabled:true, volumeRsiEnabled:true });
const backtestConfig = normalizeBacktestConfig({
  stopMode:args.stopMode,
  riskPercent:0.5,
  rewardRisk:5,
  breakEvenAtR:1,
  feeRate:0.0005,
  slippageRate:0.0002
});

const TF_MS = { "1m":60000,"3m":180000,"5m":300000,"15m":900000,"30m":1800000,"1h":3600000,"2h":7200000,"4h":14400000,"6h":21600000,"12h":43200000,"1d":86400000,"1w":604800000 };
const profileTimeframe = resolveProfileTimeframe(args.timeframe, regimeConfig.profileTimeframe);
const profileBarsNeeded = Math.max(300, Math.ceil(args.maxCandles * (TF_MS[args.timeframe] || 60000) / (TF_MS[profileTimeframe] || 900000)) + 300);

const reports = [];
for (const pair of args.pairs) {
  const candles = await fetchOkxHistoricalCandles(pair, args.timeframe, {
    maxCandles:args.maxCandles,
    startTime:args.startTime,
    endTime:args.endTime
  });
  const higherTimeframeCandles = await fetchOkxHistoricalCandles(pair, profileTimeframe, {
    maxCandles:Math.min(20_000, profileBarsNeeded),
    startTime:args.startTime,
    endTime:args.endTime
  });
  const report = runHistoricalBacktest({
    pair,
    timeframe:args.timeframe,
    candles,
    higherTimeframeCandles,
    scalpingConfig,
    marketRegimeConfig:regimeConfig,
    backtestConfig
  });
  reports.push(report);
  console.log(JSON.stringify(report, null, 2));
}
if (!reports.length) throw new Error("No pairs selected for historical backtest.");
