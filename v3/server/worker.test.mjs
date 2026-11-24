import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultWorkerConfig } from "./worker-config.mjs";

test("default v3 monitor is not active until the user configures it", () => {
  const config = createDefaultWorkerConfig();
  assert.equal(config.enabled, false);
  assert.equal(config.targets.length, 0);
  assert.equal(config.notificationSchedule.enabled, false);
});
