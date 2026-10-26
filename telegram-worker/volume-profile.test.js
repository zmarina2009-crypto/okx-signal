import test from "node:test";
import assert from "node:assert/strict";
import { volumeProfileCrossings, volumeProfileLevels } from "./volume-profile.js";

const bars = [
  { h: 98, l: 92, c: 95, v: 100 }, { h: 99, l: 93, c: 96, v: 120 },
  { h: 100, l: 94, c: 97, v: 300 }, { h: 101, l: 95, c: 98, v: 240 },
  { h: 103, l: 97, c: 101, v: 160 }, { h: 105, l: 99, c: 102, v: 80 },
  { h: 106, l: 100, c: 103, v: 60 }, { h: 107, l: 101, c: 104, v: 50 },
  { h: 108, l: 102, c: 105, v: 40 }, { h: 109, l: 103, c: 106, v: 30 }
];

test("Volume Profile builds ordered POC and 70% value-area levels", () => {
  const levels = volumeProfileLevels(bars, 30);
  assert.ok(levels); assert.ok(levels.val <= levels.poc); assert.ok(levels.poc <= levels.vah); assert.ok(levels.val < levels.vah);
});

test("POC crossing upward produces LONG and crossing downward produces SHORT", () => {
  const levels = volumeProfileLevels(bars, 30);
  assert.deepEqual(volumeProfileCrossings(bars, levels.poc - 0.001, levels.poc + 0.001, "poc", 30).map(s => [s.direction, s.level]), [["LONG", "POC"]]);
  assert.deepEqual(volumeProfileCrossings(bars, levels.poc + 0.001, levels.poc - 0.001, "poc", 30).map(s => [s.direction, s.level]), [["SHORT", "POC"]]);
});

test("no POC crossing produces no signal", () => {
  const levels = volumeProfileLevels(bars, 30);
  assert.deepEqual(volumeProfileCrossings(bars, levels.poc + 1, levels.poc + 2, "poc", 30), []);
});

test("value-area mode detects VAH upward and VAL downward crossings", () => {
  const levels = volumeProfileLevels(bars, 30);
  assert.deepEqual(volumeProfileCrossings(bars, levels.vah - 0.001, levels.vah + 0.001, "va", 30).map(s => [s.direction, s.level]), [["LONG", "VAH"]]);
  assert.deepEqual(volumeProfileCrossings(bars, levels.val + 0.001, levels.val - 0.001, "va", 30).map(s => [s.direction, s.level]), [["SHORT", "VAL"]]);
});

test("empty and zero-volume profiles do not produce signals", () => {
  assert.equal(volumeProfileLevels([], 30), null);
  const flat = bars.map(c => ({ ...c, v: 0 }));
  assert.equal(volumeProfileLevels(flat, 30), null);
  assert.deepEqual(volumeProfileCrossings(flat, 1, 2), []);
});
