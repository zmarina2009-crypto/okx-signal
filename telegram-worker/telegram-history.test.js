import test from "node:test";
import assert from "node:assert/strict";
import {
  appendTelegramHistory,
  listTelegramHistory,
  markInterruptedTelegramAttempts
} from "./telegram-history.js";

test("Telegram history keeps only the configured newest records", () => {
  const state = { telegramHistory: [] };
  for (let i = 1; i <= 5; i += 1) {
    appendTelegramHistory(state, { id: String(i), status: "sent" }, 3);
  }
  assert.deepEqual(state.telegramHistory.map(entry => entry.id), ["3", "4", "5"]);
});

test("Telegram history endpoint data is newest-first and respects its limit", () => {
  const state = {
    telegramHistory: [
      { id: "old", status: "sent" },
      { id: "middle", status: "failed" },
      { id: "new", status: "skipped_cooldown" }
    ]
  };
  const result = listTelegramHistory(state, 2);
  assert.equal(result.total, 3);
  assert.equal(result.limit, 2);
  assert.deepEqual(result.items.map(entry => entry.id), ["new", "middle"]);
});

test("invalid or excessive requested limits are safely bounded", () => {
  const state = { telegramHistory: Array.from({ length: 600 }, (_, i) => ({ id: String(i) })) };
  assert.equal(listTelegramHistory(state, 0).limit, 100);
  assert.equal(listTelegramHistory(state, 1000).limit, 500);
  assert.equal(listTelegramHistory(state, 1000).items.length, 500);
});

test("a send interrupted by worker restart is marked unknown, not failed or sent", () => {
  const state = {
    telegramHistory: [
      { id: "in-flight", status: "attempting", error: null },
      { id: "sent", status: "sent" },
      { id: "failed", status: "failed" }
    ]
  };
  const changed = markInterruptedTelegramAttempts(state, 1_800_000_000_000);
  assert.equal(changed, 1);
  assert.equal(state.telegramHistory[0].status, "unknown");
  assert.match(state.telegramHistory[0].error, /restarted/);
  assert.equal(state.telegramHistory[1].status, "sent");
  assert.equal(state.telegramHistory[2].status, "failed");
});

test("missing history is handled as an empty journal", () => {
  assert.deepEqual(listTelegramHistory({}, 25), { items: [], total: 0, limit: 25 });
  assert.equal(markInterruptedTelegramAttempts({}), 0);
});
