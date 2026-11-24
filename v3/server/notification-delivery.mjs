import { getEligibleNotificationChannels } from "./notification-schedule.mjs";

const DELIVERY_LIMIT = 500;

function appendBounded(list, item) {
  list.push(item);
  if (list.length > DELIVERY_LIMIT) list.splice(0, list.length - DELIVERY_LIMIT);
}

export function validatePushSubscription(subscription) {
  if (!subscription || typeof subscription !== "object") return false;
  const endpoint = String(subscription.endpoint || "");
  const keys = subscription.keys;
  if (!/^https:\/\//i.test(endpoint) || endpoint.length > 4096) return false;
  if (!keys || typeof keys !== "object") return false;
  return typeof keys.p256dh === "string" && keys.p256dh.length > 10 &&
    typeof keys.auth === "string" && keys.auth.length > 5;
}

export async function sendTelegramMessage({ token, chatId, text, fetchImpl = globalThis.fetch }) {
  if (!token || !chatId) throw new Error("Telegram credentials are not configured.");
  const response = await fetchImpl("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok !== true) {
    throw new Error(body?.description || "Telegram HTTP " + response.status);
  }
  return { messageId: body?.result?.message_id ?? null };
}

export async function sendWebPush({ subscription, payload, publicKey, privateKey, subject, webPushModule }) {
  if (!publicKey || !privateKey) throw new Error("VAPID public/private keys are not configured.");
  const webPush = webPushModule || await import("web-push");
  const api = webPush.default || webPush;
  if (typeof subject !== "string" || !/^(mailto:|https:\/\/)/i.test(subject.trim())) {
    throw new Error("VAPID_SUBJECT must be configured as a mailto: or https:// contact URI.");
  }
  api.setVapidDetails(subject.trim(), publicKey, privateKey);
  return api.sendNotification(subscription, JSON.stringify(payload), { TTL: 60 });
}

export async function deliverSignalNotifications(signal, schedule, subscriptions, options = {}) {
  const records = [];
  const expiredSubscriptionEndpoints = [];
  const detectedAt = Number(signal?.detectedAt);
  const now = Number(options.now ?? Date.now());
  const maxAgeMs = Math.max(1_000, Number(options.maxAgeMs) || 90_000);
  if (!Number.isFinite(detectedAt)) {
    return { records, expiredSubscriptionEndpoints, reason: "missing_detection_time" };
  }
  if (!Number.isFinite(now) || now < detectedAt || now - detectedAt > maxAgeMs) {
    return { records, expiredSubscriptionEndpoints, reason: "expired_signal" };
  }

  const detectedChannels = getEligibleNotificationChannels(detectedAt, schedule);
  if (!detectedChannels.length) {
    return { records, expiredSubscriptionEndpoints, reason: "outside_notification_window" };
  }
  const currentChannels = getEligibleNotificationChannels(now, schedule);
  const channels = detectedChannels.filter(channel => currentChannels.includes(channel));
  if (!channels.length) {
    return { records, expiredSubscriptionEndpoints, reason: "outside_current_notification_window" };
  }

  const skipDeliveryIds = new Set(Array.isArray(options.skipDeliveryIds) ? options.skipDeliveryIds : []);
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const tasks = [];

  if (channels.includes("telegram") && !skipDeliveryIds.has(signal.id + ":telegram")) {
    tasks.push((async () => {
      const record = {
        id: signal.id + ":telegram",
        signalId: signal.id,
        channel: "telegram",
        attemptedAt: Date.now(),
        status: "skipped",
        error: null
      };
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
        record.error = "Telegram credentials are not configured.";
      } else {
        try {
          const text = [
            "OKX SIGNAL PRO V3 • SCALPING",
            (signal.direction === "LONG" ? "🟢 " : "🔴 ") + signal.direction + " • " + signal.pair + " • " + signal.tf,
            "Цена: " + Number(signal.price).toLocaleString("en-US", { maximumFractionDigits: 8 }),
            signal.message,
            "Свеча: " + new Date(signal.candleTs).toISOString()
          ].filter(Boolean).join("\n");
          const result = await sendTelegramMessage({
            token: env.TELEGRAM_BOT_TOKEN,
            chatId: env.TELEGRAM_CHAT_ID,
            text,
            fetchImpl
          });
          record.status = "sent";
          record.telegramMessageId = result.messageId;
        } catch (error) {
          record.status = "failed";
          record.error = String(error?.message || error).slice(0, 500);
        }
      }
      records.push(record);
    })());
  }

  if (channels.includes("push")) {
    tasks.push((async () => {
      if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
        records.push({
          id: signal.id + ":push",
          signalId: signal.id,
          channel: "push",
          attemptedAt: Date.now(),
          status: "skipped",
          error: "No registered Push subscriptions."
        });
        return;
      }

      for (const subscription of subscriptions) {
        const endpoint = String(subscription?.endpoint || "");
        const record = {
          id: signal.id + ":push:" + endpoint.slice(-24),
          signalId: signal.id,
          channel: "push",
          attemptedAt: Date.now(),
          status: "skipped",
          error: null
        };
        if (skipDeliveryIds.has(record.id)) continue;
        try {
          await sendWebPush({
            subscription,
            payload: {
              title: "OKX Signal Pro • " + signal.direction,
              body: signal.pair + " • " + signal.tf + " • " + signal.message,
              tag: signal.id,
              data: { url: "/okx-signal/v3/" }
            },
            publicKey: env.VAPID_PUBLIC_KEY,
            privateKey: env.VAPID_PRIVATE_KEY,
            subject: env.VAPID_SUBJECT,
            webPushModule: options.webPushModule
          });
          record.status = "sent";
        } catch (error) {
          record.status = "failed";
          record.error = String(error?.message || error).slice(0, 500);
          if (Number(error?.statusCode) === 404 || Number(error?.statusCode) === 410) {
            expiredSubscriptionEndpoints.push(endpoint);
          }
        }
        records.push(record);
      }
    })());
  }

  await Promise.all(tasks);
  return { records, expiredSubscriptionEndpoints, reason: records.length ? "delivery_attempted" : "already_delivered" };
}

export function recordDeliveryAttempts(state, result) {
  if (!Array.isArray(state.deliveries)) state.deliveries = [];
  for (const record of result.records || []) appendBounded(state.deliveries, record);
  if (result.expiredSubscriptionEndpoints?.length && Array.isArray(state.pushSubscriptions)) {
    const expired = new Set(result.expiredSubscriptionEndpoints);
    state.pushSubscriptions = state.pushSubscriptions.filter(item => !expired.has(item.endpoint));
  }
}
