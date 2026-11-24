import http from "node:http";
import path from "node:path";
import { createJsonStateStore } from "./json-state-store.mjs";
import { createSupabaseStateStore } from "./supabase-state-store.mjs";
import { evaluateScalpingBars, normalizePair, normalizeTimeframe } from "./scalping-engine.mjs";
import { fetchOkxCandles } from "./okx-market-data.mjs";
import { createDefaultWorkerConfig, getEnabledTargets, normalizeWorkerConfig } from "./worker-config.mjs";
import { validatePushSubscription } from "./notification-delivery.mjs";
import { flushPendingNotifications } from "./notification-outbox.mjs";

const PORT = Math.max(1, Number(process.env.PORT) || 3000);
const POLL_INTERVAL_MS = Math.max(10_000, Math.min(120_000, Number(process.env.POLL_INTERVAL_MS) || 20_000));
const CONFIG_API_TOKEN = process.env.CONFIG_API_TOKEN || "";
const ALLOWED_ORIGINS = new Set([
  "https://zmarina2009-crypto.github.io",
  ...String(process.env.V3_ALLOWED_ORIGINS || "").split(",")
].map(value => value.trim()).filter(Boolean));

const volumeMount = process.env.RAILWAY_VOLUME_MOUNT_PATH || "/data";
const STATE_BACKEND = String(process.env.V3_STATE_BACKEND || "file").trim().toLowerCase();
const STATE_FILE = process.env.V3_STATE_FILE || path.join(volumeMount, "okx-signal-pro-v3.json");
const store = STATE_BACKEND === "supabase"
  ? createSupabaseStateStore({
    supabaseUrl: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
  })
  : STATE_BACKEND === "file"
    ? createJsonStateStore(STATE_FILE)
    : (() => { throw new Error("V3_STATE_BACKEND must be either file or supabase."); })();

const HISTORY_LIMIT = 1000;
let state;
let polling = false;
let stopping = false;
let lastPollAt = null;
let lastPollErrors = [];
let pollTimer = null;
let outboxFlushing = false;

function defaultState() {
  return {
    schemaVersion: 1,
    config: createDefaultWorkerConfig(),
    scalpingStates: {},
    signalJournal: [],
    deliveries: [],
    pushSubscriptions: [],
    lastPollAt: null,
    lastPollErrors: []
  };
}

function boundedAppend(items, item, limit = HISTORY_LIMIT) {
  items.push(item);
  if (items.length > limit) items.splice(0, items.length - limit);
}

function json(res, status, value, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers
  });
  res.end(JSON.stringify(value));
}

function applyCors(req, res) {
  const origin = String(req.headers.origin || "");
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "Origin");
    res.setHeader("access-control-allow-methods", "GET, PUT, POST, DELETE, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type, authorization");
    res.setHeader("access-control-max-age", "600");
  }
}

function authorized(req) {
  if (!CONFIG_API_TOKEN) return false;
  return String(req.headers.authorization || "") === "Bearer " + CONFIG_API_TOKEN;
}

async function readJsonBody(req, maximumBytes = 64 * 1024) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk.toString("utf8");
    if (Buffer.byteLength(raw, "utf8") > maximumBytes) {
      throw Object.assign(new Error("Request body is too large."), { statusCode: 413 });
    }
  }
  if (!raw) return {};
  try {
    const body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("JSON body must be an object.");
    return body;
  } catch (error) {
    throw Object.assign(new Error("Invalid JSON body: " + error.message), { statusCode: 400 });
  }
}

function normalizeLoadedState(loaded) {
  const initial = defaultState();
  const merged = { ...initial, ...(loaded || {}) };
  merged.schemaVersion = 1;
  merged.config = normalizeWorkerConfig(merged.config || {});
  if (!merged.scalpingStates || typeof merged.scalpingStates !== "object") merged.scalpingStates = {};
  if (!Array.isArray(merged.signalJournal)) merged.signalJournal = [];
  if (!Array.isArray(merged.deliveries)) merged.deliveries = [];
  if (!Array.isArray(merged.pushSubscriptions)) merged.pushSubscriptions = [];
  if (!Array.isArray(merged.lastPollErrors)) merged.lastPollErrors = [];
  return merged;
}

function makeSignalKey(signal) {
  return [signal.kind, signal.pair, signal.tf, signal.direction, signal.candleTs].join("|");
}

async function flushNotificationOutbox(now = Date.now()) {
  if (!state || outboxFlushing) return { skipped: true, reason: "already_flushing_or_uninitialized" };
  outboxFlushing = true;
  try {
    return await flushPendingNotifications(state, {
      schedule: state.config.notificationSchedule,
      subscriptions: state.pushSubscriptions,
      env: process.env,
      now,
      saveState: snapshot => store.save(snapshot)
    });
  } finally {
    outboxFlushing = false;
  }
}

export async function runPollingCycle(options = {}) {
  if (polling || stopping) return { skipped: true, reason: "already_running_or_stopping" };
  if (!state) throw new Error("Worker state has not been initialized.");
  if (!state.config.enabled) return { skipped: true, reason: "monitor_disabled" };
  if (!state.config.targets.length) return { skipped: true, reason: "no_targets_configured" };
  const enabledTargets = getEnabledTargets(state.config);
  if (!enabledTargets.length) return { skipped: true, reason: "no_targets_enabled" };

  polling = true;
  const pendingSignals = [];
  const errors = [];
  let processedTargets = 0;
  try {
    for (const target of enabledTargets) {
      if (stopping) break;
      const pair = normalizePair(target.pair);
      const tf = normalizeTimeframe(target.tf);
      const key = pair + "|" + tf;
      try {
        const limit = Math.max(
          100,
          state.config.scalping.volumePeriod + 1,
          state.config.scalping.rsiLength + 1,
          state.config.scalping.swingLength * 2 + 3
        );
        const candles = await fetchOkxCandles(pair, tf, { limit: Math.min(300, limit) });
        const result = evaluateScalpingBars(candles, pair, tf, {
          config: state.config.scalping,
          state: state.scalpingStates[key] || {},
          now: Date.now()
        });
        state.scalpingStates[key] = result.state;
        processedTargets++;

        for (const signal of result.events) {
          if (state.signalJournal.some(item => item && item.id === makeSignalKey(signal))) continue;
          boundedAppend(state.signalJournal, {
            ...signal,
            id: makeSignalKey(signal),
            mergedCount: 0,
            recordedAt: Date.now(),
            notificationStatus: "pending"
          });
          pendingSignals.push(signal);
        }

        // Keep the server journal in sync with the engine's RSI grouping counters.
        // Grouped repeats are not duplicate alerts, but the original signal keeps
        // a visible count of how many later RSI triggers were merged into it.
        const journalBySignal = new Map(
          state.signalJournal
            .filter(item => item?.kind === "scalping" && item.pair === pair && item.tf === tf)
            .map(item => [Number(item.candleTs) + "|" + item.direction, item])
        );
        for (const historyItem of result.state.history) {
          if (historyItem?.kind !== "scalping" || historyItem.pair !== pair || normalizeTimeframe(historyItem.tf) !== tf) continue;
          const journalItem = journalBySignal.get(Number(historyItem.signalTs) + "|" + historyItem.direction);
          if (!journalItem) continue;
          journalItem.mergedCount = Number(historyItem.mergedCount) || 0;
          journalItem.lastMergedTs = historyItem.lastMergedTs || null;
          journalItem.lastMergedPrice = historyItem.lastMergedPrice ?? null;
        }
      } catch (error) {
        errors.push({
          pair,
          tf,
          at: Date.now(),
          error: String(error?.message || error).slice(0, 500)
        });
      }
    }

    lastPollAt = Date.now();
    lastPollErrors = errors.slice(-100);
    state.lastPollAt = lastPollAt;
    state.lastPollErrors = lastPollErrors;

    // Persist processed candle timestamps before sending notifications. A restart
    // must not re-detect the same candle and emit the same signal again.
    await store.save(state);

    const notificationSummary = await flushNotificationOutbox();
    return {
      skipped: false,
      targetsConfigured: state.config.targets.length,
      targetsEnabled: enabledTargets.length,
      targetsProcessed: processedTargets,
      signalsDetected: pendingSignals.length,
      notificationSummary,
      errors
    };
  } finally {
    polling = false;
  }
}

async function handleRequest(req, res) {
  applyCors(req, res);
  const requestUrl = new URL(req.url || "/", "http://localhost");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (requestUrl.pathname === "/health" && req.method === "GET") {
    json(res, 200, {
      ok: true,
      service: "okx-signal-pro-v3-scalping",
      monitorEnabled: Boolean(state?.config?.enabled),
      targets: state?.config?.targets?.length || 0,
      enabledTargets: state ? getEnabledTargets(state.config).length : 0,
      lastPollAt,
      lastPollErrors,
      stateBackend: STATE_BACKEND,
      stateFile: STATE_BACKEND === "file" ? path.basename(STATE_FILE) : null,
      channelsConfigured: {
        telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
        push: Boolean(
          process.env.VAPID_PUBLIC_KEY &&
          process.env.VAPID_PRIVATE_KEY &&
          process.env.VAPID_SUBJECT &&
          /^(mailto:|https:\/\/)/i.test(String(process.env.VAPID_SUBJECT).trim())
        )
      },
      registeredPushDevices: state?.pushSubscriptions?.length || 0
    });
    return;
  }

  if (!authorized(req)) {
    json(res, CONFIG_API_TOKEN ? 401 : 503, {
      error: CONFIG_API_TOKEN ? "Unauthorized." : "Configuration API is disabled; set CONFIG_API_TOKEN."
    });
    return;
  }

  if (requestUrl.pathname === "/config" && req.method === "GET") {
    json(res, 200, {
      config: state.config,
      vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null
    });
    return;
  }

  if (requestUrl.pathname === "/config" && req.method === "PUT") {
    try {
      const body = await readJsonBody(req);
      const nextConfig = normalizeWorkerConfig(body.config || body);
      state.config = nextConfig;
      await store.save(state);
      json(res, 200, { saved: true, config: state.config });
    } catch (error) {
      json(res, Number(error.statusCode) || 400, { error: String(error.message || error) });
    }
    return;
  }

  if (requestUrl.pathname === "/history" && req.method === "GET") {
    const limit = Math.max(1, Math.min(200, Math.round(Number(requestUrl.searchParams.get("limit")) || 100)));
    json(res, 200, {
      signals: state.signalJournal.slice(-limit).reverse(),
      deliveries: state.deliveries.slice(-limit).reverse(),
      totalSignals: state.signalJournal.length,
      totalDeliveries: state.deliveries.length
    });
    return;
  }

  if (requestUrl.pathname === "/push-subscriptions" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const subscription = body.subscription;
      if (!validatePushSubscription(subscription)) {
        json(res, 400, { error: "Invalid Web Push subscription." });
        return;
      }
      const existing = state.pushSubscriptions.findIndex(item => item.endpoint === subscription.endpoint);
      if (existing >= 0) state.pushSubscriptions[existing] = subscription;
      else boundedAppend(state.pushSubscriptions, subscription, 100);
      await store.save(state);
      json(res, 200, { saved: true, subscriptions: state.pushSubscriptions.length });
    } catch (error) {
      json(res, Number(error.statusCode) || 400, { error: String(error.message || error) });
    }
    return;
  }

  if (requestUrl.pathname === "/push-subscriptions" && req.method === "DELETE") {
    try {
      const body = await readJsonBody(req);
      const endpoint = String(body.endpoint || "");
      state.pushSubscriptions = state.pushSubscriptions.filter(item => item.endpoint !== endpoint);
      await store.save(state);
      json(res, 200, { deleted: true, subscriptions: state.pushSubscriptions.length });
    } catch (error) {
      json(res, Number(error.statusCode) || 400, { error: String(error.message || error) });
    }
    return;
  }

  json(res, 404, { error: "Not found." });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(error => {
    console.error("V3 HTTP handler failed:", error);
    if (!res.headersSent) json(res, 500, { error: "Internal server error." });
    else res.destroy();
  });
});

async function start() {
  state = normalizeLoadedState(await store.load(defaultState()));
  lastPollAt = state.lastPollAt || null;
  lastPollErrors = state.lastPollErrors || [];

  server.listen(PORT, () => {
    console.log("OKX Signal Pro v3 worker listening on", PORT);
    console.log("V3 state backend:", STATE_BACKEND);
    if (STATE_BACKEND === "file") console.log("V3 state file:", path.basename(STATE_FILE));
    console.log("Monitor enabled:", state.config.enabled, "targets:", state.config.targets.length);
    console.log("Telegram configured:", Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID));
    console.log("Push configured:", Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY));
  });

  void flushNotificationOutbox().catch(error => console.error("Initial notification outbox flush failed:", error));
  if (state.config.enabled && getEnabledTargets(state.config).length) {
    void runPollingCycle().catch(error => console.error("Initial v3 poll failed:", error));
  }
  pollTimer = setInterval(() => {
    if (state.config.enabled && getEnabledTargets(state.config).length) {
      void runPollingCycle().catch(error => console.error("V3 poll failed:", error));
    } else {
      void flushNotificationOutbox().catch(error => console.error("V3 notification outbox flush failed:", error));
    }
  }, POLL_INTERVAL_MS);
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (pollTimer) clearInterval(pollTimer);
  await new Promise(resolve => server.close(resolve));
  await store.save(state).catch(error => console.error("Final v3 state save failed:", error));
}

process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });

if (process.env.NODE_ENV !== "test") {
  await start();
}
