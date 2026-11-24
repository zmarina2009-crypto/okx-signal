import test from "node:test";
import assert from "node:assert/strict";
import { flushPendingNotifications } from "./notification-outbox.mjs";

const detectedAt = Date.parse("2026-11-24T10:00:00+01:00");

function stateWith(signal = {}) {
  return {
    signalJournal: [{
      id: "signal-1",
      detectedAt,
      notificationStatus: "pending",
      notificationChannels: [],
      ...signal
    }],
    deliveries: [],
    pushSubscriptions: []
  };
}

test("flushes a pending notification and persists the sent status", async () => {
  const state = stateWith();
  let saves = 0;
  const result = await flushPendingNotifications(state, {
    now: detectedAt + 1_000,
    deliverSignalNotifications: async () => ({
      reason: "delivery_attempted",
      records: [{ id: "signal-1:telegram", signalId: "signal-1", channel: "telegram", status: "sent" }]
    }),
    saveState: async () => { saves++; }
  });

  assert.equal(result.sent, 1);
  assert.equal(state.signalJournal[0].notificationStatus, "sent");
  assert.equal(state.deliveries.length, 1);
  assert.equal(saves, 1);
});

test("retries only failed destinations and skips channels already delivered", async () => {
  const state = stateWith({
    notificationChannels: [
      { id: "signal-1:telegram", channel: "telegram", status: "sent" },
      { id: "signal-1:push:device-a", channel: "push", status: "failed" }
    ]
  });
  let skippedIds = [];
  const result = await flushPendingNotifications(state, {
    now: detectedAt + 1_000,
    deliverSignalNotifications: async (_signal, _schedule, _subscriptions, options) => {
      skippedIds = options.skipDeliveryIds;
      return {
        reason: "delivery_attempted",
        records: [{ id: "signal-1:push:device-a", signalId: "signal-1", channel: "push", status: "sent" }]
      };
    }
  });

  assert.deepEqual(skippedIds, ["signal-1:telegram"]);
  assert.equal(result.sent, 1);
  assert.equal(state.signalJournal[0].notificationStatus, "sent");
  assert.equal(state.signalJournal[0].notificationChannels.filter(item => item.status === "sent").length, 2);
});

test("expires stale pending signals without attempting delivery", async () => {
  const state = stateWith();
  let attempts = 0;
  const result = await flushPendingNotifications(state, {
    now: detectedAt + 120_000,
    maxAgeMs: 90_000,
    deliverSignalNotifications: async () => {
      attempts++;
      throw new Error("must not deliver");
    }
  });

  assert.equal(attempts, 0);
  assert.equal(result.expired, 1);
  assert.equal(state.signalJournal[0].notificationStatus, "expired");
});

test("retries transient failures with bounded attempts and backoff", async () => {
  const state = stateWith();
  const deliver = async () => ({
    reason: "delivery_attempted",
    records: [{ id: "signal-1:telegram", signalId: "signal-1", channel: "telegram", status: "failed", error: "temporary" }]
  });

  const first = await flushPendingNotifications(state, {
    now: detectedAt + 1_000,
    deliverSignalNotifications: deliver
  });
  assert.equal(first.retrying, 1);
  assert.equal(state.signalJournal[0].notificationAttempts, 1);
  assert.equal(state.signalJournal[0].nextNotificationAttemptAt, detectedAt + 11_000);

  const second = await flushPendingNotifications(state, {
    now: detectedAt + 11_000,
    deliverSignalNotifications: deliver
  });
  assert.equal(second.retrying, 1);
  assert.equal(state.signalJournal[0].notificationAttempts, 2);

  const third = await flushPendingNotifications(state, {
    now: detectedAt + 31_000,
    deliverSignalNotifications: deliver
  });
  assert.equal(third.failed, 1);
  assert.equal(state.signalJournal[0].notificationAttempts, 3);
  assert.equal(state.signalJournal[0].notificationStatus, "failed");
  assert.equal(state.signalJournal[0].nextNotificationAttemptAt, null);
});

test("does not retry before the next attempt time", async () => {
  const state = stateWith({ nextNotificationAttemptAt: detectedAt + 10_000 });
  let attempts = 0;
  const result = await flushPendingNotifications(state, {
    now: detectedAt + 5_000,
    deliverSignalNotifications: async () => {
      attempts++;
      return { reason: "delivery_attempted", records: [] };
    }
  });

  assert.equal(attempts, 0);
  assert.equal(result.examined, 1);
  assert.equal(state.signalJournal[0].notificationStatus, "pending");
});
