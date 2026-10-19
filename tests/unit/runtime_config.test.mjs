import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readRuntimeSourceSync as readFileSync } from "../fixtures/runtime_source.mjs";
const scope = vm.createContext({});
vm.runInContext(readFileSync("domain/runtime_config.js", "utf8"), scope);
const config = scope.RRRuntimeConfig;
test("storage values cannot disable resource limits or inject CSS", () => {
  const result = config.normalize({ maxMatches: Infinity, workerTimeoutMs: NaN, maxScannedChars: -1, scale: "2", includeControls: "true", highlightColor: "#fff}body{display:none}", currentColor: "rgb(999,1,2)", mode: "__proto__" });
  assert.equal(result.maxMatches, 9999);
  assert.equal(result.workerTimeoutMs, 5000);
  assert.equal(result.maxScannedChars, 1024);
  assert.equal(result.scale, 1);
  assert.equal(result.mode, "regex");
  assert.equal(result.highlightColor, "#ffe082");
  assert.equal(result.currentColor, "#ff6d00");
});
test("real numeric config is clamped to bounded integers", () => {
  const result = config.normalize({ maxScannedChars: 9e15, maxMatches: 9e15, workerTimeoutMs: 1e10, autoSearchDebounce: 1, scale: 1.3, wholeWord: true, mode: "literal" });
  assert.equal(result.maxMatches, 20000);
  assert.equal(result.maxScannedChars, 64 * 1024 * 1024 * 1000);
  assert.equal(result.workerTimeoutMs, 900000);
  assert.equal(result.autoSearchDebounce, 500);
  assert.equal(result.scale, 1.3);
  assert.equal(result.wholeWord, true);
  assert.equal(result.mode, "literal");
});
test("character defaults and ceilings are 1000 times their original values without 32-bit truncation", () => {
  assert.equal(config.defaults.maxScannedChars, 33554432000);
  const result = config.normalize({ maxScannedChars: 4294967297 });
  assert.equal(result.maxScannedChars, 4294967297);
  for (const value of [67108864001, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
    const bounded = config.normalize({ maxScannedChars: value });
    assert.equal(bounded.maxScannedChars, 67108864000);
    assert.equal(Number.isSafeInteger(bounded.maxScannedChars), true);
  }
});
test("character normalization preserves valid older choices and bounds malformed values", () => {
  for (const value of [1024, 4096, 1048576, 33554432]) {
    const result = config.normalize({ maxScannedChars: value });
    assert.equal(result.maxScannedChars, value);
  }
  for (const value of [NaN, Infinity, -Infinity, "33554432000", null, {}, []]) {
    const result = config.normalize({ maxScannedChars: value });
    assert.equal(result.maxScannedChars, config.defaults.maxScannedChars);
  }
  const fractional = config.normalize({ maxScannedChars: 33554432000.75 });
  assert.equal(fractional.maxScannedChars, 33554432000);
  const negative = config.normalize({ maxScannedChars: -1 });
  assert.equal(negative.maxScannedChars, 1024);
});
test("search deadlines can be increased to fifteen minutes while retaining the short default", () => {
  assert.equal(config.defaults.workerTimeoutMs, 5000);
  for (const value of [500, 5000, 30000, 900000]) assert.equal(config.normalize({ workerTimeoutMs: value }).workerTimeoutMs, value);
  assert.equal(config.normalize({ workerTimeoutMs: 900001 }).workerTimeoutMs, 900000);
  assert.equal(config.normalize({ workerTimeoutMs: 899999.5 }).workerTimeoutMs, 899999);
  assert.equal(config.normalize({ workerTimeoutMs: Infinity }).workerTimeoutMs, 5000);
});
test("stored legacy character budgets migrate once while other settings remain unchanged", () => {
  const stored = {
    maxScannedChars: 33554432, maxBlockChars: 1048576, workerTimeoutMs: 1234,
    maxMatches: 500, uiLanguage: "ja", rememberPosition: true, scale: 1.35,
    highlightColor: "#11223344", currentColor: "rgba(1,2,3,0.5)", mode: "literal", caseSensitive: true
  };
  const migrated = config.migrateStored(stored);
  assert.equal(migrated.changed, true);
  assert.deepEqual(JSON.parse(JSON.stringify(migrated.persistPatch)), {
    maxScannedChars: 33554432000, characterBudgetVersion: 1
  });
  const expected = config.normalize({ ...stored, maxScannedChars: 33554432000 });
  assert.deepEqual(migrated.values, expected);
  assert.equal(stored.maxScannedChars, 33554432);
  assert.equal(stored.maxBlockChars, 1048576);
  assert.equal(Object.prototype.hasOwnProperty.call(migrated.values, "maxBlockChars"), false);
  const second = config.migrateStored({ ...stored, ...migrated.persistPatch });
  assert.equal(second.changed, false);
  assert.deepEqual(JSON.parse(JSON.stringify(second.persistPatch)), {});
  assert.deepEqual(second.values, expected);
  assert.equal(Object.prototype.hasOwnProperty.call(config.defaults, "characterBudgetVersion"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(migrated.values, "characterBudgetVersion"), false);
  assert.equal(Object.isFrozen(config.storageKeys), true);
  assert.deepEqual(Array.from(config.storageKeys), Object.keys(config.defaults).concat("characterBudgetVersion"));
});
test("legacy preset and custom character budgets scale by 1000 without changing already large budgets", () => {
  for (const scan of [8 * 1024 * 1024, 32 * 1024 * 1024, 64 * 1024 * 1024, 1024, 12345]) {
    const migrated = config.migrateStored({ maxScannedChars: scan });
    assert.equal(migrated.values.maxScannedChars, scan * 1000);
  }
  const current = config.migrateStored({ maxScannedChars: 4294967297 });
  assert.equal(current.values.maxScannedChars, 4294967297);
  assert.deepEqual(JSON.parse(JSON.stringify(current.persistPatch)), { characterBudgetVersion: 1 });
});
test("completed migration markers preserve intentionally smaller new budgets and future metadata", () => {
  for (const characterBudgetVersion of [1, 2, Number.MAX_SAFE_INTEGER]) {
    const migrated = config.migrateStored({ maxScannedChars: 4096, characterBudgetVersion });
    assert.equal(migrated.values.maxScannedChars, 4096);
    assert.equal(migrated.changed, false);
    assert.deepEqual(JSON.parse(JSON.stringify(migrated.persistPatch)), {});
  }
  for (const characterBudgetVersion of [0, -1, "1", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const migrated = config.migrateStored({ maxScannedChars: 4096, characterBudgetVersion });
    assert.equal(migrated.values.maxScannedChars, 4096000);
    assert.equal(migrated.persistPatch.characterBudgetVersion, 1);
  }
});
test("migration never persists missing or malformed character fields or reads inherited accessors", () => {
  for (const value of [undefined, null, {}, [], { maxScannedChars: NaN }, { maxScannedChars: "33554432" }, { maxScannedChars: 1024.5 }]) {
    const migrated = config.migrateStored(value);
    assert.deepEqual(JSON.parse(JSON.stringify(migrated.persistPatch)), { characterBudgetVersion: 1 });
  }
  let reads = 0;
  const accessor = Object.create({ maxScannedChars: 33554432, characterBudgetVersion: 1 });
  Object.defineProperty(accessor, "maxScannedChars", { get() { reads++; throw new Error("must not read"); } });
  const migrated = config.migrateStored(accessor);
  assert.equal(reads, 0);
  assert.equal(migrated.values.maxScannedChars, config.defaults.maxScannedChars);
  assert.deepEqual(JSON.parse(JSON.stringify(migrated.persistPatch)), { characterBudgetVersion: 1 });
  const broken = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("malformed storage"); } });
  assert.equal(config.migrateStored(broken).values.maxScannedChars, config.defaults.maxScannedChars);
});
test("the obsolete per-block budget cannot affect the single scan budget or migration patch", () => {
  for (const maxBlockChars of [1024, 1048576, 4194304000, NaN, "1024"]) {
    const stored = { maxScannedChars: 33554432, maxBlockChars };
    const migrated = config.migrateStored(stored);
    assert.equal(migrated.values.maxScannedChars, 33554432000);
    assert.equal(Object.prototype.hasOwnProperty.call(migrated.values, "maxBlockChars"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(migrated.persistPatch, "maxBlockChars"), false);
  }
  assert.equal(Object.prototype.hasOwnProperty.call(config.defaults, "maxBlockChars"), false);
  assert.equal(Array.from(config.storageKeys).includes("maxBlockChars"), false);
  const stored = { maxScannedChars: 33554432 };
  assert.equal(config.migrateStored(stored).values.maxScannedChars, 33554432000);
  assert.equal(config.migrateStored(stored).values.maxScannedChars, 33554432000);
  assert.equal(stored.maxScannedChars, 33554432);
});
test("colors must have valid hex lengths and valid RGB channels", () => {
  for (const value of ["#fffff", "#fffffff", "rgb(256,0,0)", "rgba(1,2,3)", "rgb(1,2,3,.5)", "url(https://example.com)"]) assert.equal(config.sanitizeColor(value), null);
  for (const value of ["#fff", "#ffff", "#ffffff", "#ffffffff", "rgb(255, 0, 1)", "rgba(1,2,3,0.5)"]) assert.equal(config.sanitizeColor(value), value);
});
test("color validation rejects oversized imported strings before scanning them", () => {
  assert.equal(config.sanitizeColor("rgba(1,2,3,0." + "1".repeat(100000) + ")"), null);
  assert.equal(config.sanitizeColor("rgb(" + " ".repeat(100000) + "1,2,3)"), null);
});
test("malformed settings do not invoke inherited or accessor properties", () => {
  const values = Object.create({ maxMatches: 15000 });
  let reads = 0;
  Object.defineProperty(values, "scale", { get() { reads++; throw new Error("bad setting"); } });
  values.workerTimeoutMs = 1234;
  const result = config.normalize(values);
  assert.equal(reads, 0);
  assert.equal(result.scale, 1);
  assert.equal(result.maxMatches, 9999);
  assert.equal(result.workerTimeoutMs, 1234);
  assert.equal(config.normalize([1, 2, 3]).scale, 1);
});
test("language choices and permanent position memory are opt in and strictly validated", () => {
  assert.equal(config.defaults.uiLanguage, "auto");
  assert.equal(config.defaults.rememberPosition, false);
  for (const uiLanguage of ["auto", "zh-CN", "zh-TW", "en", "ja", "ko", "de", "fr", "es"]) {
    assert.equal(config.normalize({ uiLanguage, rememberPosition: true }).uiLanguage, uiLanguage);
    assert.equal(config.normalize({ uiLanguage, rememberPosition: true }).rememberPosition, true);
  }
  for (const uiLanguage of ["__proto__", "constructor", "en-US", "ZH-CN", "", null, true, {}, ["en"]]) {
    assert.equal(config.normalize({ uiLanguage }).uiLanguage, "auto");
  }
  for (const rememberPosition of ["false", "true", 0, 1, null, {}, []]) {
    assert.equal(config.normalize({ rememberPosition }).rememberPosition, false);
  }
  let reads = 0;
  const imported = {};
  Object.defineProperty(imported, "uiLanguage", { get() { reads++; return "ja"; } });
  Object.defineProperty(imported, "rememberPosition", { get() { reads++; return true; } });
  const normalized = config.normalize(imported);
  assert.equal(reads, 0);
  assert.equal(normalized.uiLanguage, "auto");
  assert.equal(normalized.rememberPosition, false);
});
