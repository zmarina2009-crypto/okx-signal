import test from "node:test";
import assert from "node:assert/strict";
import { createSupabaseStateStore } from "./supabase-state-store.mjs";

function response(body, status = 200) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

const baseOptions = {
  supabaseUrl: "https://example.supabase.co",
  serviceRoleKey: "test-server-only-key"
};

test("requires a valid HTTPS Supabase URL and server-only key", () => {
  assert.throws(
    () => createSupabaseStateStore({ ...baseOptions, supabaseUrl: "http://example.supabase.co" }),
    /HTTPS/
  );
  assert.throws(
    () => createSupabaseStateStore({ ...baseOptions, serviceRoleKey: "" }),
    /SUPABASE_SECRET_KEY.*SUPABASE_SERVICE_ROLE_KEY/
  );
});

test("loads the persisted v3 singleton state", async () => {
  const expected = { schemaVersion: 1, config: { enabled: false }, signalJournal: [] };
  let request;
  const store = createSupabaseStateStore({
    ...baseOptions,
    fetchImpl: async (url, options) => {
      request = { url: new URL(url), options };
      return response([{ state: expected }]);
    }
  });

  assert.deepEqual(await store.load({ ignored: true }), expected);
  assert.equal(request.url.pathname, "/rest/v1/okx_v3_worker_runtime");
  assert.equal(request.url.searchParams.get("id"), "eq.singleton");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.headers.apikey, baseOptions.serviceRoleKey);
  assert.equal(request.options.headers.authorization, "Bearer " + baseOptions.serviceRoleKey);
});

test("sends modern Supabase secret keys only through the apikey header", async () => {
  const modernSecretKey = "sb_secret_test_key_value";
  const requests = [];
  const store = createSupabaseStateStore({
    supabaseUrl: baseOptions.supabaseUrl,
    secretKey: modernSecretKey,
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options });
      return options.method === "GET" ? response([]) : response(null, 204);
    }
  });

  await store.load({});
  await store.save({ enabled: false });

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.options.headers.apikey, modernSecretKey);
    assert.equal(request.options.headers.authorization, undefined);
  }
});

test("returns an independent fallback when the v3 singleton row does not exist", async () => {
  const fallback = { schemaVersion: 1, config: { enabled: false } };
  const store = createSupabaseStateStore({
    ...baseOptions,
    fetchImpl: async () => response([])
  });

  const loaded = await store.load(fallback);
  assert.deepEqual(loaded, fallback);
  assert.notEqual(loaded, fallback);
});

test("upserts only the v3 singleton and serializes concurrent writes", async () => {
  const requests = [];
  const store = createSupabaseStateStore({
    ...baseOptions,
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options, body: JSON.parse(options.body) });
      return response(null, 204);
    }
  });

  await Promise.all([
    store.save({ sequence: 1 }),
    store.save({ sequence: 2 }),
    store.save({ sequence: 3 })
  ]);

  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map(item => item.body.state.sequence), [1, 2, 3]);
  for (const item of requests) {
    assert.equal(item.url.pathname, "/rest/v1/okx_v3_worker_runtime");
    assert.equal(item.url.searchParams.get("on_conflict"), "id");
    assert.equal(item.body.id, "singleton");
    assert.match(item.options.headers.prefer, /resolution=merge-duplicates/);
  }
});

test("does not silently reset state when Supabase is unavailable or the stored row is malformed", async () => {
  const unavailable = createSupabaseStateStore({
    ...baseOptions,
    fetchImpl: async () => response({ message: "denied" }, 503)
  });
  await assert.rejects(unavailable.load({ safeDefault: true }), /HTTP 503/);

  const malformed = createSupabaseStateStore({
    ...baseOptions,
    fetchImpl: async () => response([{ state: [] }])
  });
  await assert.rejects(malformed.load({ safeDefault: true }), /invalid state snapshot/);
});

test("a failed save does not poison later saves", async () => {
  let calls = 0;
  const store = createSupabaseStateStore({
    ...baseOptions,
    fetchImpl: async () => {
      calls++;
      return calls === 1 ? response({ message: "temporary failure" }, 503) : response(null, 204);
    }
  });

  await assert.rejects(store.save({ sequence: 1 }), /HTTP 503/);
  await store.save({ sequence: 2 });
  assert.equal(calls, 2);
});
