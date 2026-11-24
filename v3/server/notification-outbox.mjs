import {
  deliverSignalNotifications as defaultDeliver,
  recordDeliveryAttempts as defaultRecord
} from "./notification-delivery.mjs";

const DEFAULT_MAX_AGE_MS = 90_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 10_000;

export async function flushPendingNotifications(state, options = {}) {
  if (!state || !Array.isArray(state.signalJournal)) {
    throw new TypeError("A state object with signalJournal is required.");
  }

  const now = Number(options.now ?? Date.now());
  if (!Number.isFinite(now)) throw new TypeError("A finite current timestamp is required.");

  const maxAgeMs = Math.max(1_000, Number(options.maxAgeMs) || DEFAULT_MAX_AGE_MS);
  const maxAttempts = Math.max(1, Math.round(Number(options.maxAttempts) || DEFAULT_MAX_ATTEMPTS));
  const retryDelayMs = Math.max(1_000, Number(options.retryDelayMs) || DEFAULT_RETRY_DELAY_MS);
  const deliver = options.deliverSignalNotifications || defaultDeliver;
  const record = options.recordDeliveryAttempts || defaultRecord;
  const saveState = options.saveState || (async () => {});
  const schedule = options.schedule || {};
  const subscriptions = options.subscriptions || state.pushSubscriptions || [];
  const env = options.env || process.env;

  const pending = state.signalJournal.filter(item => item?.notificationStatus === "pending");
  const summary = { examined: pending.length, sent: 0, retrying: 0, failed: 0, expired: 0, skipped: 0 };

  for (const signal of pending) {
    const detectedAt = Number(signal.detectedAt);
    if (!Number.isFinite(detectedAt) || now < detectedAt || now - detectedAt > maxAgeMs) {
      signal.notificationStatus = "expired";
      signal.notificationReason = "signal_too_old_or_missing_detection_time";
      signal.notificationUpdatedAt = now;
      signal.nextNotificationAttemptAt = null;
      summary.expired++;
      await saveState(state);
      continue;
    }

    const nextAttemptAt = Number(signal.nextNotificationAttemptAt || 0);
    if (nextAttemptAt > now) continue;

    const previousRecords = Array.isArray(signal.notificationChannels) ? signal.notificationChannels : [];
    const skipDeliveryIds = previousRecords
      .filter(item => item && (item.status === "sent" || item.status === "skipped") && item.id)
      .map(item => item.id);

    let result;
    try {
      result = await deliver(signal, schedule, subscriptions, {
        env,
        now,
        maxAgeMs,
        skipDeliveryIds
      });
    } catch (error) {
      result = {
        reason: "delivery_exception",
        records: [{
          id: signal.id + ":delivery",
          signalId: signal.id,
          channel: "unknown",
          attemptedAt: now,
          status: "failed",
          error: String(error?.message || error).slice(0, 500)
        }],
        expiredSubscriptionEndpoints: []
      };
    }

    record(state, result);

    const merged = new Map(previousRecords.filter(item => item?.id).map(item => [item.id, item]));
    for (const item of result.records || []) {
      if (item?.id) merged.set(item.id, item);
    }
    signal.notificationChannels = [...merged.values()];
    signal.notificationAttempts = Number(signal.notificationAttempts || 0) + ((result.records || []).length ? 1 : 0);
    signal.notificationUpdatedAt = now;

    if (["outside_notification_window", "outside_current_notification_window", "expired_signal", "missing_detection_time"].includes(result.reason)) {
      signal.notificationStatus = result.reason;
      signal.notificationReason = result.reason;
      signal.nextNotificationAttemptAt = null;
      summary.expired++;
    } else {
      const failedRecords = (result.records || []).filter(item => item.status === "failed");
      if (failedRecords.length) {
        if (signal.notificationAttempts >= maxAttempts) {
          signal.notificationStatus = "failed";
          signal.notificationReason = "max_delivery_attempts_reached";
          signal.nextNotificationAttemptAt = null;
          summary.failed++;
        } else {
          signal.notificationStatus = "pending";
          signal.notificationReason = "temporary_delivery_failure";
          signal.nextNotificationAttemptAt = now + retryDelayMs * signal.notificationAttempts;
          summary.retrying++;
        }
      } else {
        const hasSent = signal.notificationChannels.some(item => item.status === "sent");
        signal.notificationStatus = hasSent ? "sent" : "skipped";
        signal.notificationReason = result.reason || "delivery_completed";
        signal.nextNotificationAttemptAt = null;
        if (hasSent) summary.sent++;
        else summary.skipped++;
      }
    }

    await saveState(state);
  }

  return summary;
}
