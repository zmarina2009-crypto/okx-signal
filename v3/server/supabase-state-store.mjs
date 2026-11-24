const TABLE_NAME = "okx_v3_worker_runtime";
const REQUEST_TIMEOUT_MS = 10_000;

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainState(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function createSupabaseStateStore({
  supabaseUrl,
  secretKey,
  serviceRoleKey,
  fetchImpl = globalThis.fetch
} = {}) {
  if (typeof supabaseUrl !== "string" || !supabaseUrl.trim()) {
    throw new TypeError("SUPABASE_URL is required when V3_STATE_BACKEND=supabase.");
  }
  const serverApiKey = typeof secretKey === "string" && secretKey.trim()
    ? secretKey.trim()
    : typeof serviceRoleKey === "string" ? serviceRoleKey.trim() : "";
  if (!serverApiKey) {
    throw new TypeError("SUPABASE_SECRET_KEY (preferred) or SUPABASE_SERVICE_ROLE_KEY (legacy) is required when V3_STATE_BACKEND=supabase.");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("A fetch implementation is required.");
  }

  let baseUrl;
  try {
    baseUrl = new URL(supabaseUrl.trim());
  } catch {
    throw new TypeError("SUPABASE_URL must be a valid HTTPS URL.");
  }
  if (baseUrl.protocol !== "https:") {
    throw new TypeError("SUPABASE_URL must use HTTPS.");
  }

  const endpoint = new URL("/rest/v1/" + TABLE_NAME, baseUrl.origin).toString();
  // New sb_secret_* keys are not JWTs: send them only as apikey.
  // Keep the Authorization header only for the legacy JWT service_role key.
  const authHeaders = { apikey: serverApiKey };
  if (!serverApiKey.startsWith("sb_secret_")) {
    authHeaders.authorization = "Bearer " + serverApiKey;
  }
  let writeQueue = Promise.resolve();

  async function load(fallback = {}) {
    const url = new URL(endpoint);
    url.search = new URLSearchParams({
      id: "eq.singleton",
      select: "state",
      limit: "1"
    }).toString();

    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: authHeaders,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (error) {
      throw new Error("Supabase state load request failed: " + String(error?.message || error).slice(0, 300), { cause: error });
    }

    if (!response.ok) {
      throw new Error("Supabase state load failed (HTTP " + response.status + ").");
    }

    let rows;
    try {
      rows = await response.json();
    } catch (error) {
      throw new Error("Supabase state load returned invalid JSON.", { cause: error });
    }
    if (!Array.isArray(rows)) {
      throw new Error("Supabase state load returned an unexpected response.");
    }
    if (rows.length === 0) return cloneJson(fallback);
    if (!isPlainState(rows[0]?.state)) {
      throw new Error("Supabase v3 runtime row contains an invalid state snapshot.");
    }
    return rows[0].state;
  }

  function save(snapshot) {
    if (!isPlainState(snapshot)) {
      return Promise.reject(new TypeError("The state snapshot must be a JSON object."));
    }

    let frozenSnapshot;
    try {
      frozenSnapshot = JSON.parse(JSON.stringify(snapshot));
    } catch (error) {
      return Promise.reject(new TypeError("The state snapshot cannot be serialized as JSON.", { cause: error }));
    }

    const task = writeQueue.then(async () => {
      let response;
      try {
        response = await fetchImpl(endpoint + "?on_conflict=id", {
          method: "POST",
          headers: {
            ...authHeaders,
            "content-type": "application/json",
            prefer: "resolution=merge-duplicates,return=minimal"
          },
          body: JSON.stringify({
            id: "singleton",
            state: frozenSnapshot,
            updated_at: new Date().toISOString()
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
      } catch (error) {
        throw new Error("Supabase state save request failed: " + String(error?.message || error).slice(0, 300), { cause: error });
      }

      if (!response.ok) {
        throw new Error("Supabase state save failed (HTTP " + response.status + ").");
      }
    });

    // Match the JSON store's serialized writes and keep the queue usable after a failure.
    writeQueue = task.catch(() => {});
    return task;
  }

  return {
    load,
    save,
    tableName: TABLE_NAME,
    backend: "supabase"
  };
}
