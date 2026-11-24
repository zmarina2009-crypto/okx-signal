import test from "node:test";
import assert from "node:assert/strict";
import {
  deliverSignalNotifications,
  recordDeliveryAttempts,
  validatePushSubscription
} from "./notification-delivery.mjs";

const timestamp = Date.parse("2026-11-24T10:00:00+01:00");
const signal = {
  id: "signal-1",
  detectedAt: timestamp,
  candleTs: timestamp,
  direction: "LONG",
  pair: "BTC-USDT-SWAP",
  tf: "1m",
  price: 100000,
  message: "Volume + RSI"
};
const schedule = {
  enabled: true,
  timezone: "Europe/Amsterdam",
  weekdays: [2],
  windows: [{ start: "09:00", end: "13:00" }],
  channels: { push: true, telegram: true }
};

test("validates browser Push subscription shape", () => {
  assert.equal(validatePushSubscription(null), false);
  assert.equal(validatePushSubscription({ endpoint: "https://push.example/sub", keys: { p256dh: "abcdefghijkl", auth: "abcdef" } }), true);
  assert.equal(validatePushSubscription({ endpoint: "http://push.example/sub", keys: { p256dh: "abcdefghijkl", auth: "abcdef" } }), false);
});

test("does not attempt any channel outside the signal's allowed time window", async () => {
  const result = await deliverSignalNotifications({
    ...signal,
    detectedAt: Date.parse("2026-11-24T14:00:00+01:00")
  }, schedule, [], {
    env: {},
    sendTelegramMessage: async () => { throw new Error("must not send"); }
  });
  assert.deepEqual(result.records, []);
  assert.equal(result.reason, "outside_notification_window");
});

test("sends Telegram only when enabled by schedule and configured", async () => {
  let sentText = "";
  const result = await deliverSignalNotifications(signal, {
    ...schedule,
    channels: { push: false, telegram: true }
  }, [], {
    env: { TELEGRAM_BOT_TOKEN: "test-token", TELEGRAM_CHAT_ID: "test-chat" },
    fetchImpl: async (url, options) => {
      sentText = JSON.parse(options.body).text;
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 42 } }) };
    }
  });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].status, "sent");
  assert.equal(result.records[0].telegramMessageId, 42);
  assert.match(sentText, /BTC-USDT-SWAP/);
});

test("sends Push using a VAPID-backed adapter for each subscription", async () => {
  let pushCount = 0;
  const webPushModule = {
    setVapidDetails() {},
    async sendNotification() { pushCount++; }
  };
  const subscriptions = [
    { endpoint: "https://push.example/one", keys: { p256dh: "abcdefghijkl", auth: "abcdef" } },
    { endpoint: "https://push.example/two", keys: { p256dh: "abcdefghijkl", auth: "abcdef" } }
  ];
  const result = await deliverSignalNotifications(signal, {
    ...schedule,
    channels: { push: true, telegram: false }
  }, subscriptions, {
    env: { VAPID_PUBLIC_KEY: "public", VAPID_PRIVATE_KEY: "private" },
    webPushModule
  });
  assert.equal(pushCount, 2);
  assert.equal(result.records.length, 2);
  assert.ok(result.records.every(record => record.status === "sent"));
});

test("records channel delivery outcomes and removes expired Push subscriptions", () => {
  const state = {
    deliveries: [],
    pushSubscriptions: [
      { endpoint: "https://push.example/gone" },
      { endpoint: "https://push.example/active" }
    ]
  };
  recordDeliveryAttempts(state, {
    records: [{ id: "d1", status: "sent" }],
    expiredSubscriptionEndpoints: ["https://push.example/gone"]
  });
  assert.equal(state.deliveries.length, 1);
  assert.deepEqual(state.pushSubscriptions.map(item => item.endpoint), ["https://push.example/active"]);
});
