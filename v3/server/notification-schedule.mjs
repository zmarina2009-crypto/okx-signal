const WEEKDAY_TO_ISO = Object.freeze({
  Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7
});

function parseClock(value, fieldName) {
  const match = /^(?:([01]\d|2[0-3])):([0-5]\d)$/.exec(String(value || ""));
  if (!match) throw new RangeError(fieldName + " must use HH:mm in 24-hour format.");
  return Number(match[1]) * 60 + Number(match[2]);
}

function isoWeekday(shortName) {
  const day = WEEKDAY_TO_ISO[shortName];
  if (!day) throw new RangeError("Could not resolve local weekday from time zone.");
  return day;
}

function previousWeekday(day) {
  return day === 1 ? 7 : day - 1;
}

export function normalizeNotificationSchedule(input = {}) {
  const timezone = String(input.timezone || "Europe/Amsterdam").trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
  } catch {
    throw new RangeError("Invalid IANA time zone: " + timezone);
  }

  const weekdays = [...new Set((Array.isArray(input.weekdays) ? input.weekdays : [])
    .map(Number)
    .filter(day => Number.isInteger(day) && day >= 1 && day <= 7))]
    .sort((a, b) => a - b);

  const rawWindows = Array.isArray(input.windows) ? input.windows : [];
  if (rawWindows.length > 10) throw new RangeError("At most 10 notification windows are supported.");

  const windows = rawWindows.map((window, index) => {
    const startMinute = parseClock(window?.start, "windows[" + index + "].start");
    const endMinute = parseClock(window?.end, "windows[" + index + "].end");
    if (startMinute === endMinute) {
      throw new RangeError("A notification window cannot have the same start and end time.");
    }
    return {
      start: String(window.start),
      end: String(window.end),
      startMinute,
      endMinute
    };
  });

  return {
    enabled: input.enabled === true,
    timezone,
    weekdays,
    windows,
    channels: {
      push: input.channels?.push === true,
      telegram: input.channels?.telegram === true
    }
  };
}

export function getLocalScheduleParts(timestamp, timezone) {
  const ms = Number(timestamp);
  if (!Number.isFinite(ms)) throw new TypeError("A finite Unix timestamp in milliseconds is required.");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(ms));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    weekday: isoWeekday(values.weekday),
    minuteOfDay: Number(values.hour) * 60 + Number(values.minute)
  };
}

function isWindowActive(local, weekdays, window) {
  const { startMinute, endMinute } = window;
  if (startMinute < endMinute) {
    return weekdays.includes(local.weekday) &&
      local.minuteOfDay >= startMinute && local.minuteOfDay < endMinute;
  }

  // Overnight windows belong to the day on which they start.
  if (local.minuteOfDay >= startMinute) return weekdays.includes(local.weekday);
  if (local.minuteOfDay < endMinute) return weekdays.includes(previousWeekday(local.weekday));
  return false;
}

export function getEligibleNotificationChannels(timestamp, rawSchedule) {
  const schedule = normalizeNotificationSchedule(rawSchedule);
  if (!schedule.enabled || schedule.weekdays.length === 0 || schedule.windows.length === 0) return [];

  const local = getLocalScheduleParts(timestamp, schedule.timezone);
  const active = schedule.windows.some(window => isWindowActive(local, schedule.weekdays, window));
  if (!active) return [];

  const channels = [];
  if (schedule.channels.push) channels.push("push");
  if (schedule.channels.telegram) channels.push("telegram");
  return channels;
}

export function shouldNotifyForSignal(signal, schedule) {
  // Gate delivery by detection time, not by retry time: never send stale catch-up alerts.
  const detectedAt = Number(signal?.detectedAt);
  if (!Number.isFinite(detectedAt)) return { allowed: false, channels: [], reason: "missing_detection_time" };
  const channels = getEligibleNotificationChannels(detectedAt, schedule);
  return channels.length
    ? { allowed: true, channels, reason: "inside_notification_window" }
    : { allowed: false, channels: [], reason: "outside_notification_window" };
}
