export const TELEGRAM_HISTORY_LIMIT = 500;

function boundedLimit(value, fallback, maximum = TELEGRAM_HISTORY_LIMIT) {
  const parsed = Number(value);
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  return Math.min(maximum, Math.max(1, limit));
}

export function appendTelegramHistory(state, entry, maxEntries = TELEGRAM_HISTORY_LIMIT) {
  if (!state || typeof state !== "object") {
    throw new TypeError("A worker state object is required.");
  }
  const limit = boundedLimit(maxEntries, TELEGRAM_HISTORY_LIMIT);
  const history = Array.isArray(state.telegramHistory) ? state.telegramHistory : [];
  history.push(entry);
  state.telegramHistory = history.slice(-limit);
  return entry;
}

export function listTelegramHistory(state, requestedLimit = 100) {
  const history = Array.isArray(state?.telegramHistory) ? state.telegramHistory : [];
  const limit = boundedLimit(requestedLimit, 100);
  return {
    items: history.slice(-limit).reverse(),
    total: history.length,
    limit
  };
}

export function markInterruptedTelegramAttempts(state, now = Date.now()) {
  if (!state || !Array.isArray(state.telegramHistory)) return 0;
  let marked = 0;
  const finishedAt = new Date(now).toISOString();
  for (const entry of state.telegramHistory) {
    if (entry && entry.status === "attempting") {
      entry.status = "unknown";
      entry.finishedAt = finishedAt;
      entry.error = "Worker restarted before the Telegram delivery result was saved; check the Telegram chat.";
      marked += 1;
    }
  }
  return marked;
}
