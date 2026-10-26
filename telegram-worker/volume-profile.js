// Volume Profile crossing logic shared by the 24/7 Telegram worker and its tests.
// Volume is assigned to one bin using typical price, matching the browser alerts indicator.
export function volumeProfileLevels(bars, rowCount = 30) {
  const data = (Array.isArray(bars) ? bars : []).filter(c => c && Number.isFinite(Number(c.h)) && Number.isFinite(Number(c.l)) && Number.isFinite(Number(c.c)));
  if (data.length < 3) return null;
  const lo = Math.min(...data.map(c => Number(c.l)));
  const hi = Math.max(...data.map(c => Number(c.h)));
  const range = hi - lo || 1;
  const rows = Math.max(10, Math.min(60, Math.floor(Number(rowCount) || 30)));
  const bins = new Array(rows).fill(0);
  for (const candle of data) {
    const typical = (Number(candle.h) + Number(candle.l) + Number(candle.c)) / 3;
    const bin = Math.max(0, Math.min(rows - 1, Math.floor((typical - lo) / range * rows)));
    bins[bin] += Math.max(0, Number(candle.v) || 0);
  }
  const maxVolume = Math.max(...bins, 0);
  const totalVolume = bins.reduce((sum, value) => sum + value, 0);
  if (maxVolume <= 0 || totalVolume <= 0) return null;
  const pocIndex = bins.indexOf(maxVolume);
  const target = totalVolume * 0.70;
  let left = pocIndex, right = pocIndex, accumulated = bins[pocIndex];
  while (accumulated < target && (left > 0 || right < rows - 1)) {
    const leftVolume = left > 0 ? bins[left - 1] : -1;
    const rightVolume = right < rows - 1 ? bins[right + 1] : -1;
    if (rightVolume >= leftVolume) { right++; accumulated += Math.max(0, rightVolume); }
    else { left--; accumulated += Math.max(0, leftVolume); }
  }
  const priceAt = index => lo + (index + 0.5) * range / rows;
  return { poc: priceAt(pocIndex), val: lo + left * range / rows, vah: lo + (right + 1) * range / rows };
}

export function volumeProfileCrossings(bars, previousClose, close, mode = "poc", rowCount = 30) {
  const levels = volumeProfileLevels(bars, rowCount);
  const previous = Number(previousClose), current = Number(close);
  if (!levels || !Number.isFinite(previous) || !Number.isFinite(current)) return [];
  const requestedMode = String(mode).toLowerCase();
  const selectedMode = ["poc", "va", "all"].includes(requestedMode) ? requestedMode : "poc";
  const crossings = [];
  if (selectedMode === "poc" || selectedMode === "all") {
    if (previous < levels.poc && current >= levels.poc) crossings.push({ direction: "LONG", level: "POC", price: levels.poc });
    else if (previous > levels.poc && current <= levels.poc) crossings.push({ direction: "SHORT", level: "POC", price: levels.poc });
  }
  if (selectedMode === "va" || selectedMode === "all") {
    if (previous < levels.vah && current >= levels.vah) crossings.push({ direction: "LONG", level: "VAH", price: levels.vah });
    if (previous > levels.val && current <= levels.val) crossings.push({ direction: "SHORT", level: "VAL", price: levels.val });
  }
  return crossings;
}
