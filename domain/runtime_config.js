(function () {
  "use strict";
  var POLICY = globalThis.RRRuntimePolicy;
  var MAX_COLOR_CHARS = 64;
  var CHARACTER_BUDGET_MULTIPLIER = 1000;
  var defaults = Object.freeze({
    scale: 1, maxMatches: POLICY.search.defaultMatches, highlightColor: "#ffe082", currentColor: "#ff6d00",
    caseSensitive: false, autoSearchDebounce: 1500, mode: "regex",
    wholeWord: false, multiline: false, dotAll: false, includeControls: true,
    workerTimeoutMs: POLICY.search.defaultTimeoutMs, maxScannedChars: POLICY.search.defaultScannedChars,
    uiLanguage: "auto", rememberPosition: false
  });
  // One schema drives storage normalization and the settings form constraints.
  var numericRanges = POLICY.settings.numericRanges;
  var budgetPresets = Object.freeze({
    light: Object.freeze({ maxMatches: 500, workerTimeoutMs: 3000, maxScannedChars: 8000 * POLICY.units.mib }),
    balanced: Object.freeze({ maxMatches: defaults.maxMatches, workerTimeoutMs: defaults.workerTimeoutMs, maxScannedChars: defaults.maxScannedChars }),
    large: Object.freeze({ maxMatches: numericRanges.maxMatches.max, workerTimeoutMs: 10000, maxScannedChars: numericRanges.maxScannedChars.max })
  });
  var characterBudgetVersion = 1;
  var characterBudgetVersionKey = "characterBudgetVersion";
  // Keep migration metadata separate from user settings. Array-based reads
  // preserve an absent marker instead of supplying a default prematurely.
  var storageKeys = Object.freeze(Object.keys(defaults).concat(characterBudgetVersionKey));
  function number(value, fallback, min, max, integer) {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    value = Math.max(min, Math.min(max, value));
    return integer ? Math.floor(value) : value;
  }
  function color(value) {
    // Storage can contain imported values, so bound the scan before parsing.
    if (typeof value !== "string" || value.length > MAX_COLOR_CHARS) return null;
    if (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) return value;
    var m = value.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/);
    if (!m || +m[1] > 255 || +m[2] > 255 || +m[3] > 255) return null;
    if (value.startsWith("rgba") !== (m[4] !== undefined)) return null;
    return value;
  }
  function normalize(value) {
    value = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    // Settings arrive as plain JSON. Ignore inherited/accessor properties rather
    // than letting a malformed setting execute code or abort all normalization.
    var supplied = {};
    Object.keys(defaults).forEach(function (key) {
      supplied[key] = ownValue(value, key);
    });
    value = supplied;
    var result = Object.assign({}, defaults);
    Object.keys(numericRanges).forEach(function (key) {
      var range = numericRanges[key];
      result[key] = number(value[key], defaults[key], range.min, range.max, range.integer);
    });
    ["caseSensitive", "wholeWord", "multiline", "dotAll", "includeControls", "rememberPosition"].forEach(function (key) {
      if (typeof value[key] === "boolean") result[key] = value[key];
    });
    if (value.mode === "literal" || value.mode === "regex") result.mode = value.mode;
    if (["auto", "zh-CN", "zh-TW", "en", "ja", "ko", "de", "fr", "es"].indexOf(value.uiLanguage) !== -1) result.uiLanguage = value.uiLanguage;
    result.highlightColor = color(value.highlightColor) || defaults.highlightColor;
    result.currentColor = color(value.currentColor) || defaults.currentColor;
    return result;
  }
  function ownValue(value, key) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    try {
      var descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value") ? descriptor.value : undefined;
    } catch (_) { return undefined; }
  }
  function migrateStored(value) {
    var supplied = {};
    Object.keys(defaults).forEach(function (key) {
      var stored = ownValue(value, key);
      if (stored !== undefined) supplied[key] = stored;
    });
    var version = ownValue(value, characterBudgetVersionKey), persistPatch = {};
    if (!Number.isSafeInteger(version) || version < characterBudgetVersion) {
      // Only actual, valid legacy settings are multiplied. Missing or malformed
      // values use the new defaults in memory and are never written as read data.
      var stored = supplied.maxScannedChars;
      var scanRange = numericRanges.maxScannedChars;
      if (Number.isSafeInteger(stored) && stored >= scanRange.min && stored <= scanRange.max / CHARACTER_BUDGET_MULTIPLIER) {
        supplied.maxScannedChars = stored * CHARACTER_BUDGET_MULTIPLIER;
        persistPatch.maxScannedChars = supplied.maxScannedChars;
      }
      persistPatch[characterBudgetVersionKey] = characterBudgetVersion;
    }
    return { values: normalize(supplied), changed: Object.keys(persistPatch).length > 0, persistPatch: persistPatch };
  }
  globalThis.RRRuntimeConfig = { defaults: defaults, normalize: normalize, sanitizeColor: color,
    numericRanges: numericRanges, budgetPresets: budgetPresets, maxColorChars: MAX_COLOR_CHARS,
    characterBudgetVersion: characterBudgetVersion, characterBudgetVersionKey: characterBudgetVersionKey,
    storageKeys: storageKeys, migrateStored: migrateStored };
})();
