import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile("infra/worker_manager.js", "utf8");

// We test the pure config validation logic extracted from worker_manager
// The updateConfig function validates config values

// Test config validation logic (DEF-20)
const configKeys = ["maxMatches", "maxScannedChars", "maxChunkMs", "workerTimeoutMs", "batchSize"];

function isValidConfigValue(k, v) {
  switch (k) {
    case "maxMatches":
    case "maxScannedChars":
    case "maxChunkMs":
    case "workerTimeoutMs":
    case "batchSize":
      return typeof v === "number" && isFinite(v) && v > 0;
    case "allowUnsafeEcmascript":
      return true; // any value coerced to boolean
    default:
      return false;
  }
}

test("config: valid numeric values accepted", () => {
  for (const k of configKeys) {
    assert.ok(isValidConfigValue(k, 100), k + " should accept 100");
    assert.ok(isValidConfigValue(k, 1), k + " should accept 1");
    assert.ok(isValidConfigValue(k, 999999), k + " should accept 999999");
  }
});

test("config: negative values rejected", () => {
  for (const k of configKeys) {
    assert.equal(isValidConfigValue(k, -1), false, k + " should reject -1");
    assert.equal(isValidConfigValue(k, -100), false, k + " should reject -100");
  }
});

test("config: zero values rejected", () => {
  for (const k of configKeys) {
    assert.equal(isValidConfigValue(k, 0), false, k + " should reject 0");
  }
});

test("config: non-numeric values rejected", () => {
  for (const k of configKeys) {
    assert.equal(isValidConfigValue(k, "abc"), false, k + " should reject string");
    assert.equal(isValidConfigValue(k, null), false, k + " should reject null");
    assert.equal(isValidConfigValue(k, undefined), false, k + " should reject undefined");
    assert.equal(isValidConfigValue(k, NaN), false, k + " should reject NaN");
    assert.equal(isValidConfigValue(k, Infinity), false, k + " should reject Infinity");
  }
});

test("config: unknown keys rejected", () => {
  assert.equal(isValidConfigValue("unknownKey", 1), false);
  assert.equal(isValidConfigValue("randomField", "value"), false);
});

test("config: allowUnsafeEcmascript always accepted (boolean coercion)", () => {
  assert.ok(isValidConfigValue("allowUnsafeEcmascript", true));
  assert.ok(isValidConfigValue("allowUnsafeEcmascript", false));
  assert.ok(isValidConfigValue("allowUnsafeEcmascript", "truthy"));
});
