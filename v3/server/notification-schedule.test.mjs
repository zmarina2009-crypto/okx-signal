import test from "node:test";
import assert from "node:assert/strict";
import {
  getEligibleNotificationChannels,
  getLocalScheduleParts,
  normalizeNotificationSchedule,
  shouldNotifyForSignal
} from "./notification-schedule.mjs";

const stamp = iso => Date.parse(iso);

test("enables only selected channels inside an active weekday window", () => {
  const schedule = {
    enabled: true,
    timezone: "Europe/Amsterdam",
    weekdays: [1, 2, 3, 4, 5],
    windows: [{ start: "09:00", end: "13:00" }],
    channels: { push: true, telegram: false }
  };
  assert.deepEqual(getEligibleNotificationChannels(stamp("2026-11-24T09:30:00+01:00"), schedule), ["push"]);
  assert.deepEqual(getEligibleNotificationChannels(stamp("2026-11-24T14:00:00+01:00"), schedule), []);
  assert.deepEqual(getEligibleNotificationChannels(stamp("2026-11-28T10:00:00+01:00"), schedule), []);
});

test("supports multiple notification windows on one trading day", () => {
  const schedule = {
    enabled: true,
    timezone: "Europe/Amsterdam",
    weekdays: [2],
    windows: [{ start: "09:00", end: "12:00" }, { start: "18:00", end: "22:00" }],
    channels: { push: true, telegram: true }
  };
  assert.deepEqual(getEligibleNotificationChannels(stamp("2026-11-24T10:00:00+01:00"), schedule), ["push", "telegram"]);
  assert.deepEqual(getEligibleNotificationChannels(stamp("2026-11-24T19:00:00+01:00"), schedule), ["push", "telegram"]);
  assert.deepEqual(getEligibleNotificationChannels(stamp("2026-11-24T15:00:00+01:00"), schedule), []);
});

test("overnight window is attributed to the weekday on which it starts", () => {
  const schedule = {
    enabled: true,
    timezone: "Europe/Amsterdam",
    weekdays: [5],
    windows: [{ start: "22:00", end: "02:00" }],
    channels: { push: true, telegram: true }
  };
  assert.deepEqual(getEligibleNotificationChannels(stamp("2026-11-27T23:30:00+01:00"), schedule), ["push", "telegram"]);
  assert.deepEqual(getEligibleNotificationChannels(stamp("2026-11-28T01:30:00+01:00"), schedule), ["push", "telegram"]);
  assert.deepEqual(getEligibleNotificationChannels(stamp("2026-11-29T01:30:00+01:00"), schedule), []);
});

test("IANA timezone rules apply to summer and winter dates", () => {
  const winter = getLocalScheduleParts(stamp("2026-11-24T08:00:00Z"), "Europe/Amsterdam");
  const summer = getLocalScheduleParts(stamp("2026-07-07T07:00:00Z"), "Europe/Amsterdam");
  assert.equal(winter.minuteOfDay, 9 * 60);
  assert.equal(summer.minuteOfDay, 9 * 60);
});

test("does not queue a missed signal for later delivery", () => {
  const schedule = {
    enabled: true,
    timezone: "Europe/Amsterdam",
    weekdays: [2],
    windows: [{ start: "09:00", end: "13:00" }],
    channels: { push: true, telegram: true }
  };
  const result = shouldNotifyForSignal({
    detectedAt: stamp("2026-11-24T13:01:00+01:00"),
    deliveredAt: stamp("2026-11-24T14:00:00+01:00")
  }, schedule);
  assert.deepEqual(result, {
    allowed: false,
    channels: [],
    reason: "outside_notification_window"
  });
});

test("disabled schedule or empty channels never sends", () => {
  const base = {
    enabled: true,
    timezone: "Europe/Amsterdam",
    weekdays: [2],
    windows: [{ start: "09:00", end: "13:00" }],
    channels: { push: false, telegram: false }
  };
  assert.deepEqual(getEligibleNotificationChannels(stamp("2026-11-24T10:00:00+01:00"), base), []);
  assert.deepEqual(getEligibleNotificationChannels(stamp("2026-11-24T10:00:00+01:00"), { ...base, enabled: false, channels: { push: true, telegram: true } }), []);
});

test("rejects invalid clock times, empty intervals, and invalid IANA zones", () => {
  assert.throws(() => normalizeNotificationSchedule({ timezone: "Mars/Olympus", windows: [] }), /Invalid IANA time zone/);
  assert.throws(() => normalizeNotificationSchedule({ timezone: "UTC", windows: [{ start: "25:00", end: "26:00" }] }), /HH:mm/);
  assert.throws(() => normalizeNotificationSchedule({ timezone: "UTC", windows: [{ start: "09:00", end: "09:00" }] }), /same start and end/);
});
