import { createClient } from "npm:@supabase/supabase-js@2.119.0";

type JsonObject = Record<string, unknown>;

const DEFAULT_ALLOWED_ORIGINS = [
  "https://zmarina2009-crypto.github.io",
  "https://okx-signal-production-14d9.up.railway.app",
];

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function getAdminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const secretMapRaw = Deno.env.get("SUPABASE_SECRET_KEYS") || "{}";
  let secretMap: Record<string, string> = {};
  try {
    secretMap = JSON.parse(secretMapRaw);
  } catch {
    throw new Error("Supabase secret-key environment is not valid JSON.");
  }
  // Supabase exposes the current secret API key to Edge Functions by default.
  // The legacy service-role env remains as a compatibility fallback.
  const key =
    secretMap.default ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    "";
  if (!url || !key) {
    throw new Error("Supabase server credentials are not available in this Edge Function.");
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function safeEquals(left: string, right: string) {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return mismatch === 0;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseLimit(value: string | null, fallback = 100) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(500, Math.floor(parsed));
}

function barFor(timeframe: string) {
  const tf = timeframe.toLowerCase();
  const mapped: Record<string, string> = {
    "1h": "1H", "2h": "2H", "4h": "4H", "6h": "6H",
    "12h": "12H", "1d": "1D", "1w": "1W",
  };
  return mapped[tf] || tf;
}

async function latestClosedCandle(pair: string, timeframe: string) {
  const url = new URL("https://www.okx.com/api/v5/market/candles");
  url.searchParams.set("instId", pair);
  url.searchParams.set("bar", barFor(timeframe));
  url.searchParams.set("limit", "5");

  const response = await fetch(url, {
    headers: { "user-agent": "OKX-Signal-Pro-Supabase-Worker/1.0" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`OKX HTTP ${response.status} for ${pair} ${timeframe}`);

  const body = await response.json();
  if (body?.code !== "0" || !Array.isArray(body?.data)) {
    throw new Error(String(body?.msg || "Invalid OKX candles response"));
  }

  const closed = body.data
    .filter((row: unknown) => Array.isArray(row) && String(row[8]) === "1")
    .map((row: unknown[]) => Number(row[0]))
    .filter((timestamp: number) => Number.isFinite(timestamp) && timestamp > 0)
    .sort((a: number, b: number) => b - a);

  if (!closed.length) throw new Error(`No confirmed candle returned for ${pair} ${timeframe}`);
  return closed[0] as number;
}

function getAllowedOrigins() {
  const configured = String(Deno.env.get("CONFIG_ALLOWED_ORIGINS") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...configured]);
}

function corsHeaders(origin: string) {
  const headers: Record<string, string> = {
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, x-worker-cron-token",
    "access-control-max-age": "86400",
    "vary": "Origin",
  };
  if (origin && getAllowedOrigins().has(origin)) {
    headers["access-control-allow-origin"] = origin;
  }
  return headers;
}

async function loadRuntime(client: ReturnType<typeof getAdminClient>) {
  const { data, error } = await client
    .from("okx_v2_worker_runtime")
    .select("state, updated_at, last_tick_at, last_tick_status, last_tick_error")
    .eq("id", "singleton")
    .single();
  if (error) throw new Error("Could not read worker runtime state: " + error.message);
  return data;
}

async function loadRules(client: ReturnType<typeof getAdminClient>) {
  const { data, error } = await client
    .from("okx_v2_alert_rules")
    .select("rules, revision, updated_at")
    .eq("id", "singleton")
    .single();
  if (error) throw new Error("Could not read active alert rules: " + error.message);
  if (!Array.isArray(data?.rules) || data.rules.length === 0) {
    throw new Error("No active pair/timeframe rules are stored in Supabase.");
  }
  return data;
}

async function handleBootstrap(req: Request, client: ReturnType<typeof getAdminClient>) {
  const expectedToken = Deno.env.get("WORKER_CRON_TOKEN") || "";
  const suppliedToken = req.headers.get("x-worker-cron-token") || "";
  if (!expectedToken || !safeEquals(suppliedToken, expectedToken)) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  const leaseToken = crypto.randomUUID();
  const { data: claimed, error: claimError } = await client.rpc(
    "claim_okx_v2_worker_tick",
    { p_lease_token: leaseToken, p_lease_seconds: 120 },
  );
  if (claimError) return json({ ok: false, error: "Could not acquire worker lease: " + claimError.message }, 500);
  if (claimed !== true) return json({ ok: false, busy: true, error: "Another worker operation currently holds the lease." }, 409);

  let releaseStatus = "ok";
  let releaseError: string | null = null;
  try {
    const [runtime, rulesRow] = await Promise.all([
      loadRuntime(client),
      loadRules(client),
    ]);
    const state: JsonObject = isObject(runtime.state) ? { ...runtime.state } : {};
    const migrationSnapshot: JsonObject = isObject(state.migrationSnapshot)
      ? { ...state.migrationSnapshot }
      : {};
    const previousBootstrap = isObject(migrationSnapshot.runtimeBootstrap)
      ? migrationSnapshot.runtimeBootstrap
      : null;

    if (previousBootstrap?.status === "seeded") {
      return json({
        ok: true,
        alreadyBootstrapped: true,
        bootstrap: previousBootstrap,
        telegramSendingEnabled: false,
      });
    }

    const rules = rulesRow.rules as Array<{ pair?: string; tf?: string }>;
    const entries: Array<{ pair: string; tf: string; lastClosedTs: number }> = [];
    // Fetch every active rule before writing anything. One failed pair aborts the
    // bootstrap so that the runtime state cannot be only partially initialized.
    for (const rule of rules) {
      const pair = String(rule?.pair || "").trim().toUpperCase();
      const tf = String(rule?.tf || "").trim().toLowerCase();
      if (!/^[A-Z0-9]+-USDT-SWAP$/.test(pair) || !/^\d+(m|h|d|w)$/.test(tf)) {
        throw new Error("Invalid stored rule encountered during bootstrap.");
      }
      const lastClosedTs = await latestClosedCandle(pair, tf);
      entries.push({ pair, tf, lastClosedTs });
    }

    const lastClosed = isObject(state.lastClosed) ? { ...state.lastClosed } : {};
    for (const entry of entries) {
      const key = entry.pair + ":" + entry.tf;
      const existing = Number(lastClosed[key]) || 0;
      lastClosed[key] = Math.max(existing, entry.lastClosedTs);
    }

    state.lastClosed = lastClosed;
    // These were not present in the exported read-only endpoints. Keep the
    // imported aggregate stats and Telegram history untouched; start the new
    // worker with no stale partial combo signals or cooldown timestamps.
    if (!isObject(state.lastAlertAt)) state.lastAlertAt = {};
    if (!isObject(state.lastSmaTouch)) state.lastSmaTouch = {};
    if (!Array.isArray(state.recentSignals)) state.recentSignals = [];
    if (!Array.isArray(state.performanceSignals)) state.performanceSignals = [];
    if (!Array.isArray(state.telegramHistory)) state.telegramHistory = [];

    const completedAt = new Date().toISOString();
    const missingRuntimeFields = [
      "lastAlertAt (reinitialized empty; old cooldown timestamps were not exported)",
      "lastSmaTouch (not exported)",
      "recentSignals (not exported; starts empty to avoid stale combo assembly)",
      "performanceSignals (raw records not exported; aggregate stats remain in statsSnapshot)",
    ];
    state.migrationSnapshot = {
      ...migrationSnapshot,
      complete: false,
      runtimeBootstrap: {
        status: "seeded",
        completedAt,
        source: "latest confirmed OKX candles",
        entries,
        emitsEnabled: false,
        telegramSendingEnabled: false,
      },
      missingRuntimeFields,
    };

    const { data: saved, error: saveError } = await client.rpc(
      "save_okx_v2_worker_state",
      { p_lease_token: leaseToken, p_state: state },
    );
    if (saveError) throw new Error("Could not save bootstrapped runtime state: " + saveError.message);
    if (saved !== true) throw new Error("Worker lease expired before the bootstrap state could be saved.");

    return json({
      ok: true,
      bootstrapped: true,
      mode: "bootstrap-only",
      telegramSendingEnabled: false,
      rulesRevision: rulesRow.revision,
      entries,
      missingRuntimeFields,
      statsSnapshotPreserved: Boolean(state.statsSnapshot),
      telegramHistoryCount: Array.isArray(state.telegramHistory) ? state.telegramHistory.length : 0,
    });
  } catch (error) {
    releaseStatus = "failed";
    releaseError = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: releaseError, telegramSendingEnabled: false }, 502);
  } finally {
    const { error } = await client.rpc("release_okx_v2_worker_tick", {
      p_lease_token: leaseToken,
      p_status: releaseStatus,
      p_error: releaseError,
    });
    if (error) console.error("Could not release bootstrap lease:", error.message);
  }
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const origin = req.headers.get("origin") || "";
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") {
    if (origin && !getAllowedOrigins().has(origin)) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: cors });
  }
  if (origin && !getAllowedOrigins().has(origin)) {
    return json({ ok: false, error: "Origin not allowed" }, 403);
  }

  const route = url.pathname.split("/").filter(Boolean).at(-1) || "";
  if (req.method === "GET" && route === "health") {
    try {
      const client = getAdminClient();
      const [runtime, rules] = await Promise.all([loadRuntime(client), loadRules(client)]);
      return json({
        ok: true,
        service: "okx-signal-pro-v2",
        mode: "bootstrap-only",
        telegramSendingEnabled: false,
        rules: rules.rules.length,
        rulesRevision: rules.revision,
        lastTickAt: runtime.last_tick_at,
        lastTickStatus: runtime.last_tick_status,
        updatedAt: runtime.updated_at,
      }, 200, cors);
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 503, cors);
    }
  }

  if (req.method === "GET" && route === "config") {
    try {
      const client = getAdminClient();
      const rules = await loadRules(client);
      return json({ rules: rules.rules, revision: rules.revision, updatedAt: rules.updated_at }, 200, cors);
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 503, cors);
    }
  }

  if (req.method === "GET" && route === "telegram-history") {
    try {
      const client = getAdminClient();
      const runtime = await loadRuntime(client);
      const history = Array.isArray(runtime.state?.telegramHistory) ? runtime.state.telegramHistory : [];
      const limit = parseLimit(url.searchParams.get("limit"), 100);
      const items = [...history].sort((a, b) => String(b?.createdAt || "").localeCompare(String(a?.createdAt || ""))).slice(0, limit);
      return json({ items, total: history.length, limit }, 200, cors);
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 503, cors);
    }
  }

  if (req.method === "GET" && route === "stats") {
    try {
      const client = getAdminClient();
      const runtime = await loadRuntime(client);
      return json(runtime.state?.statsSnapshot ?? {
        generatedAt: null,
        periodDays: 90,
        signalCount: 0,
        pending12h: 0,
        groups: [],
        note: "No imported statistics snapshot is available.",
      }, 200, cors);
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 503, cors);
    }
  }

  if (req.method === "POST" && route === "bootstrap") {
    try {
      const client = getAdminClient();
      const response = await handleBootstrap(req, client);
      return new Response(response.body, {
        status: response.status,
        headers: { ...Object.fromEntries(response.headers), ...cors },
      });
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 503, cors);
    }
  }

  return json({ ok: false, error: "Not found" }, 404, cors);
});
