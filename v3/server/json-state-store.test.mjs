import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJsonStateStore } from "./json-state-store.mjs";

async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "okx-v3-state-"));
  try { await run(dir); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test("loads fallback state when the volume file does not exist", async () => {
  await withTempDir(async dir => {
    const store = createJsonStateStore(path.join(dir, "state.json"));
    assert.deepEqual(await store.load({ version: 1 }), { version: 1 });
  });
});

test("writes and reloads a JSON state snapshot", async () => {
  await withTempDir(async dir => {
    const store = createJsonStateStore(path.join(dir, "state.json"));
    await store.save({ version: 1, processed: { "BTC-USDT-SWAP|1m": 123 } });
    assert.deepEqual(await store.load(), { version: 1, processed: { "BTC-USDT-SWAP|1m": 123 } });
  });
});

test("serializes concurrent writes and always leaves a valid final JSON file", async () => {
  await withTempDir(async dir => {
    const store = createJsonStateStore(path.join(dir, "nested", "state.json"));
    await Promise.all(Array.from({ length: 60 }, (_, index) =>
      store.save({ sequence: index, payload: "x".repeat(index + 1) })
    ));
    const finalState = await store.load();
    assert.equal(finalState.sequence, 59);
    assert.equal(finalState.payload.length, 60);
    const names = await fs.readdir(path.dirname(store.filePath));
    assert.deepEqual(names.filter(name => name.endsWith(".tmp")), []);
  });
});

test("rejects malformed persisted JSON instead of silently resetting state", async () => {
  await withTempDir(async dir => {
    const filePath = path.join(dir, "state.json");
    await fs.writeFile(filePath, "{broken", "utf8");
    const store = createJsonStateStore(filePath);
    await assert.rejects(store.load(), /Could not load persisted state/);
  });
});

test("a failed save does not permanently poison later writes", async () => {
  await withTempDir(async dir => {
    const store = createJsonStateStore(path.join(dir, "state.json"));
    await assert.rejects(store.save({ toJSON() { throw new Error("test serialization failure"); } }), /Could not persist state/);
    await store.save({ recovered: true });
    assert.deepEqual(await store.load(), { recovered: true });
  });
});
