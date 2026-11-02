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


/**
 * Returns the nearest selected VP level when price is within a tolerance
 * measured in profile-bin widths. Uses only the supplied (prior, closed) bars.
 */
export function volumeProfileProximity(bars, price, mode = "all", rowCount = 30, toleranceRows = 1) {
  const data = (Array.isArray(bars) ? bars : []).filter(c => c && Number.isFinite(Number(c.h)) && Number.isFinite(Number(c.l)) && Number.isFinite(Number(c.c)));
  const levels = volumeProfileLevels(data, rowCount);
  const current = Number(price);
  if (!levels || !Number.isFinite(current)) return [];
  const lo = Math.min(...data.map(c => Number(c.l)));
  const hi = Math.max(...data.map(c => Number(c.h)));
  const rows = Math.max(10, Math.min(60, Math.floor(Number(rowCount) || 30)));
  const binWidth = (hi - lo) / rows;
  if (!(binWidth > 0)) return [];
  const tolerance = binWidth * Math.max(0, Number(toleranceRows) || 0);
  const selectedMode = String(mode || "all").toLowerCase();
  const candidates = [];
  if (selectedMode === "poc" || selectedMode === "all") candidates.push({ level: "POC", price: levels.poc });
  if (selectedMode === "va" || selectedMode === "all") {
    candidates.push({ level: "VAL", price: levels.val }, { level: "VAH", price: levels.vah });
  }
  return candidates
    .map(item => ({ ...item, distance: Math.abs(current - item.price), tolerance }))
    .filter(item => item.distance <= tolerance)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 1);
}
