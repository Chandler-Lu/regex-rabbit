import assert from "node:assert/strict";
import test from "node:test";
import { readRuntimeSourceSync as readFileSync } from "../fixtures/runtime_source.mjs";
import { JSDOM } from "jsdom";

const html = readFileSync("options.html", "utf8");
const configSource = readFileSync("domain/runtime_config.js", "utf8");
const i18nSource = readFileSync("infra/ui_i18n.js", "utf8");
const optionsSource = readFileSync("options.js", "utf8");

test('settings form constraints and presets agree with the runtime schema', t => {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://extension.test/options.html' });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.chrome = { runtime: {}, storage: { sync: { get() {} } } };
  window.eval(configSource);
  window.eval(i18nSource);
  window.eval(optionsSource);
  const config = window.RRRuntimeConfig;
  for (const [key, range] of Object.entries(config.numericRanges)) {
    const field = window.document.getElementById(key);
    assert.equal(Number(field.min), range.min, key);
    assert.equal(Number(field.max), range.max, key);
    assert.equal(field.step, range.integer ? '1' : 'any', key);
    assert.ok(Object.isFrozen(range));
  }
  for (const preset of Object.values(config.budgetPresets)) {
    const normalized = config.normalize(preset);
    for (const [key, value] of Object.entries(preset)) assert.equal(normalized[key], value, key);
  }
  assert.equal(window.document.getElementById('highlightColor').maxLength, config.maxColorChars);
});

function openOptions(t, browserLanguage = "zh-CN") {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://extension.test/options.html" });
  t.after(() => dom.window.close());
  const { window } = dom;
  const getRequests = [], setRequests = [];
  window.chrome = {
    i18n: { getUILanguage: () => browserLanguage },
    runtime: { lastError: undefined },
    storage: { sync: {
      get(defaults, callback) { getRequests.push({ defaults, callback }); },
      set(values, callback) { setRequests.push({ values, callback }); }
    } }
  };
  window.eval(configSource);
  window.eval(i18nSource);
  window.eval(optionsSource);
  const el = id => window.document.getElementById(id);
  function input(id, value) {
    const field = el(id);
    if (field.type === "checkbox") field.checked = value; else field.value = value;
    field.dispatchEvent(new window.Event("input", { bubbles: true }));
  }
  function load(values = {}, requestIndex = 0) { getRequests[requestIndex].callback(values); }
  function submit() { el("settings").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); }
  function finishSave(index = 0, error) {
    window.chrome.runtime.lastError = error ? { message: error } : undefined;
    setRequests[index].callback();
    window.chrome.runtime.lastError = undefined;
  }
  return { window, el, input, load, submit, finishSave, getRequests, setRequests };
}

test("all normalized settings have real controls and save waits for storage", t => {
  const page = openOptions(t);
  for (const key of Object.keys(page.window.RRRuntimeConfig.defaults)) assert.ok(page.el(key), key);
  assert.equal(page.el("save").disabled, true);
  page.submit();
  assert.equal(page.setRequests.length, 0);
  page.load();
  assert.equal(page.el("save").disabled, false);
});

test("opening and saving unrelated settings preserves every accepted color format", t => {
  const page = openOptions(t);
  const colors = ["#fff", "#abcd", "#123456", "#11223344", "rgb(255, 0, 1)", "rgba(1,2,3,0.5)"];
  for (const color of colors) {
    page.load({ highlightColor: color, currentColor: color });
    assert.equal(page.el("highlightColor").value, color);
    page.submit();
    const index = page.setRequests.length - 1;
    assert.equal(page.setRequests[index].values.highlightColor, color);
    assert.equal(page.setRequests[index].values.currentColor, color);
    page.finishSave(index);
  }
});

test("a delayed storage response preserves fields the user has already edited", t => {
  const page = openOptions(t);
  page.input("maxMatches", "2500");
  page.input("highlightColor", "rgba(1,2,3,0.2)");
  page.input("caseSensitive", true);
  page.load({ maxMatches: 1800, highlightColor: "#aabbcc", currentColor: "#445566", caseSensitive: false });
  assert.equal(page.el("maxMatches").value, "2500");
  assert.equal(page.el("highlightColor").value, "rgba(1,2,3,0.2)");
  assert.equal(page.el("caseSensitive").checked, true);
  assert.equal(page.el("currentColor").value, "#445566");
});
test("loading a valid fractional scale does not prevent saving other settings", t => {
  const page = openOptions(t);
  page.load({ scale: 1.35 });
  page.submit();
  assert.equal(page.setRequests.length, 1);
  assert.equal(page.setRequests[0].values.scale, 1.35);
});

test("color picker updates text and preview while invalid text cannot alter preview or save", t => {
  const page = openOptions(t);
  page.load({ highlightColor: "rgba(255,0,255,0.5)" });
  assert.equal(page.el("highlightColorPicker").value, "#ff00ff");
  page.input("highlightColorPicker", "#123456");
  assert.equal(page.el("highlightColor").value, "#123456");
  assert.equal(page.el("colorPreview").style.background, "rgb(18, 52, 86)");
  page.input("highlightColor", "#fff}body{display:none}");
  assert.equal(page.el("highlightColor").validity.customError, true);
  assert.equal(page.el("colorPreview").style.background, "rgb(18, 52, 86)");
  page.submit();
  assert.equal(page.setRequests.length, 0);
});

test("blank, out of range and fractional integer limits are rejected instead of silently stored", t => {
  const page = openOptions(t);
  page.load();
  for (const value of ["", "99", "20001", "1000.5"]) {
    page.input("maxMatches", value);
    page.submit();
    assert.equal(page.setRequests.length, 0, value);
  }
  page.input("maxMatches", "1501");
  page.input("workerTimeoutMs", "5001");
  page.submit();
  assert.equal(page.setRequests.length, 1);
  assert.equal(page.setRequests[0].values.maxMatches, 1501);
  assert.equal(page.setRequests[0].values.workerTimeoutMs, 5001);
});

test("only one save is in flight and edits made during save remain unsaved", t => {
  const page = openOptions(t);
  page.load();
  page.submit();
  page.submit();
  assert.equal(page.setRequests.length, 1);
  assert.equal(page.el("save").disabled, true);
  page.input("maxMatches", "2500");
  page.finishSave();
  assert.equal(page.el("save").disabled, false);
  assert.equal(page.el("maxMatches").value, "2500");
  assert.equal(page.el("status").textContent, "已保存上次修改；当前还有未保存的修改。");
  page.submit();
  assert.equal(page.setRequests[1].values.maxMatches, 2500);
});

test("failed saves remain visible and permit retry", t => {
  const page = openOptions(t);
  page.load();
  page.submit();
  page.finishSave(0, "QUOTA_BYTES exceeded");
  assert.equal(page.el("status").textContent, "保存失败：QUOTA_BYTES exceeded");
  assert.equal(page.el("save").disabled, false);
  page.submit();
  assert.equal(page.setRequests.length, 2);
});

test("restore defaults changes the form but writes nothing until save", t => {
  const page = openOptions(t);
  page.load({ maxMatches: 5000, mode: "literal", caseSensitive: true });
  page.el("reset").click();
  assert.equal(page.el("maxMatches").value, "9999");
  assert.equal(page.el("mode").value, "regex");
  assert.equal(page.el("caseSensitive").checked, false);
  assert.equal(page.setRequests.length, 0);
  page.submit();
  assert.deepEqual(JSON.parse(JSON.stringify(page.setRequests[0].values)), { ...JSON.parse(JSON.stringify(page.window.RRRuntimeConfig.defaults)), characterBudgetVersion: 1 });
});

test("restoring defaults before loading is not overwritten by late storage", t => {
  const page = openOptions(t);
  page.el("reset").click();
  page.load({ maxMatches: 5000, mode: "literal" });
  assert.equal(page.el("maxMatches").value, "9999");
  assert.equal(page.el("mode").value, "regex");
});

test("storage load errors show the cause and retain defaults and local edits", t => {
  const page = openOptions(t);
  page.input("mode", "literal");
  page.window.chrome.runtime.lastError = { message: "Extension context invalidated" };
  page.load();
  page.window.chrome.runtime.lastError = undefined;
  assert.equal(page.el("mode").value, "literal");
  assert.equal(page.el("maxMatches").value, "9999");
  assert.equal(page.el("status").textContent, "读取设置失败：Extension context invalidated");
  assert.equal(page.el("save").disabled, true);
  assert.equal(page.el("retryLoad").hidden, false);
  page.submit();
  assert.equal(page.setRequests.length, 0);
  page.el("retryLoad").click();
  assert.equal(page.getRequests.length, 2);
  assert.equal(page.el("retryLoad").disabled, true);
  page.load({ mode: "regex", maxMatches: 2500, highlightColor: "#11223344" }, 1);
  assert.equal(page.el("mode").value, "literal");
  assert.equal(page.el("maxMatches").value, "2500");
  assert.equal(page.el("highlightColor").value, "#11223344");
  assert.equal(page.el("save").disabled, false);
  assert.equal(page.el("retryLoad").hidden, true);
  page.submit();
  assert.equal(page.setRequests[0].values.maxMatches, 2500);
  assert.equal(page.setRequests[0].values.highlightColor, "#11223344");
});

test("mode radio controls update the stored field and regex options without losing checked defaults", t => {
  const page = openOptions(t);
  page.load({ mode: "regex", multiline: true, dotAll: true });
  const literal = page.window.document.querySelector('input[name="searchMode"][value="literal"]');
  literal.checked = true;
  literal.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  assert.equal(page.el("mode").value, "literal");
  assert.equal(page.el("regexOptions").disabled, true);
  assert.equal(page.el("multiline").checked, true);
  assert.equal(page.el("dotAll").checked, true);
  page.submit();
  assert.equal(page.setRequests[0].values.mode, "literal");
  assert.equal(page.setRequests[0].values.multiline, true);
  assert.equal(page.setRequests[0].values.dotAll, true);
  page.finishSave();
  const regex = page.window.document.querySelector('input[name="searchMode"][value="regex"]');
  regex.checked = true;
  regex.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  assert.equal(page.el("regexOptions").disabled, false);
  assert.equal(page.el("multiline").checked, true);
});

test("mode radio edits before storage loads stay selected", t => {
  const page = openOptions(t);
  const literal = page.window.document.querySelector('input[name="searchMode"][value="literal"]');
  literal.checked = true;
  literal.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  page.load({ mode: "regex" });
  assert.equal(page.el("mode").value, "literal");
  assert.equal(literal.checked, true);
});

test("budget presets change only limits and remain local until saved", t => {
  const page = openOptions(t);
  page.load({ mode: "literal", highlightColor: "#11223344", autoSearchDebounce: 1701 });
  const light = page.window.document.querySelector('[data-budget="light"]');
  light.click();
  assert.equal(page.el("maxMatches").value, "500");
  assert.equal(page.el("workerTimeoutMs").value, "3000");
  assert.equal(page.el("maxScannedChars").value, String(8 * 1024 * 1024 * 1000));
  assert.equal(page.el("mode").value, "literal");
  assert.equal(page.el("highlightColor").value, "#11223344");
  assert.equal(page.el("autoSearchDebounce").value, "1701");
  assert.equal(light.getAttribute("aria-pressed"), "true");
  assert.equal(page.setRequests.length, 0);
  page.input("maxMatches", "501");
  assert.equal(light.getAttribute("aria-pressed"), "false");
  assert.equal(page.el("budgetStatus").textContent, "自定义限制");
  page.submit();
  assert.equal(page.setRequests[0].values.maxMatches, 501);
});

test("budget preset edits before loading preserve all three values", t => {
  const page = openOptions(t);
  page.window.document.querySelector('[data-budget="large"]').click();
  page.load({ maxMatches: 1500, workerTimeoutMs: 3000, maxScannedChars: 4096, maxBlockChars: 2048 });
  assert.equal(page.el("maxMatches").value, "20000");
  assert.equal(page.el("workerTimeoutMs").value, "10000");
  assert.equal(page.el("maxScannedChars").value, String(64 * 1024 * 1024 * 1000));
});

test("large character budgets save exact values above the 32-bit boundary", t => {
  const page = openOptions(t);
  page.load();
  assert.equal(page.el("maxScannedChars").value, "33554432000");
  page.input("maxScannedChars", "67108864000");
  page.submit();
  assert.equal(page.setRequests.length, 1);
  assert.equal(page.setRequests[0].values.maxScannedChars, 67108864000);
  page.finishSave();
  for (const [key, values] of [
    ["maxScannedChars", ["", "1023", "67108864001", "33554432000.5", "1e309", "9007199254740992"]]
  ]) {
    for (const value of values) {
      page.input(key, value);
      assert.equal(page.el(key).validity.customError, true, `${key}: ${value}`);
      page.submit();
      assert.equal(page.setRequests.length, 1, `${key}: ${value}`);
    }
    page.input(key, "33554432000");
  }
});

test("intentionally smaller new character budgets remain unchanged after the migration marker is saved", t => {
  const page = openOptions(t);
  page.load({ maxScannedChars: 33554432, maxBlockChars: 1048576, characterBudgetVersion: 1 });
  page.input("rememberPosition", true);
  page.submit();
  assert.equal(page.setRequests[0].values.maxScannedChars, 33554432);
  assert.equal(Object.prototype.hasOwnProperty.call(page.setRequests[0].values, "maxBlockChars"), false);
  assert.equal(page.setRequests[0].values.characterBudgetVersion, 1);
});

test("legacy saved scan budgets take effect at the expanded value without automatic storage writes", t => {
  const page = openOptions(t);
  assert.equal(Array.isArray(page.getRequests[0].defaults), true);
  assert.equal(page.getRequests[0].defaults.includes("characterBudgetVersion"), true);
  assert.equal(page.getRequests[0].defaults.includes("maxBlockChars"), false);
  const stored = { maxScannedChars: 33554432, maxBlockChars: 1048576, workerTimeoutMs: 30000, maxMatches: 500, uiLanguage: "ja" };
  page.load(stored);
  assert.equal(page.el("maxScannedChars").value, "33554432000");
  assert.equal(page.el("workerTimeoutMs").value, "30000");
  assert.equal(page.el("maxMatches").value, "500");
  assert.equal(page.el("uiLanguage").value, "ja");
  assert.equal(page.el("maxBlockChars"), null);
  assert.equal(page.setRequests.length, 0);
  page.load(stored);
  assert.equal(page.el("maxScannedChars").value, "33554432000");
  assert.equal(stored.maxScannedChars, 33554432);
  page.submit();
  assert.equal(page.setRequests.length, 1);
  assert.equal(page.setRequests[0].values.maxScannedChars, 33554432000);
  assert.equal(page.setRequests[0].values.characterBudgetVersion, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(page.setRequests[0].values, "maxBlockChars"), false);
});

test("a late legacy read never overwrites a newly edited smaller scan budget or writes it automatically", t => {
  const page = openOptions(t);
  page.input("maxScannedChars", "4096");
  page.load({ maxScannedChars: 33554432 });
  assert.equal(page.el("maxScannedChars").value, "4096");
  assert.equal(page.setRequests.length, 0);
  page.submit();
  assert.equal(page.setRequests[0].values.maxScannedChars, 4096);
  assert.equal(page.setRequests[0].values.characterBudgetVersion, 1);
  page.finishSave();
  page.load(page.setRequests[0].values);
  assert.equal(page.el("maxScannedChars").value, "4096");
  assert.equal(page.setRequests.length, 1);
});

test("failed legacy reads neither migrate nor persist partially returned settings", t => {
  const page = openOptions(t);
  page.window.chrome.runtime.lastError = { message: "Storage unavailable" };
  page.load({ maxScannedChars: 4096, maxBlockChars: 1024 });
  page.window.chrome.runtime.lastError = undefined;
  assert.equal(page.el("maxScannedChars").value, "33554432000");
  assert.equal(page.setRequests.length, 0);
  assert.equal(page.el("save").disabled, true);
  page.submit();
  assert.equal(page.setRequests.length, 0);
});

test("a fifteen-minute search deadline can be saved without changing the default or presets", t => {
  const page = openOptions(t);
  page.load();
  assert.equal(page.el("workerTimeoutMs").value, "5000");
  page.input("workerTimeoutMs", "900000");
  page.submit();
  assert.equal(page.setRequests[0].values.workerTimeoutMs, 900000);
  page.finishSave();
  for (const value of ["499", "900001", "900000.5", "", "Infinity"]) {
    page.input("workerTimeoutMs", value);
    assert.equal(page.el("workerTimeoutMs").validity.customError, true, value);
    page.submit();
    assert.equal(page.setRequests.length, 1);
  }
  for (const [preset, value] of [["light", "3000"], ["balanced", "5000"], ["large", "10000"]]) {
    page.window.document.querySelector(`[data-budget="${preset}"]`).click();
    assert.equal(page.el("workerTimeoutMs").value, value);
  }
});

test("fractional scale and preset choices keep the accessible percentage in sync", t => {
  const page = openOptions(t);
  page.load({ scale: 1.35 });
  assert.equal(page.el("scaleVal").textContent, "135%");
  assert.equal(page.el("scale").getAttribute("aria-valuetext"), "135%");
  assert.ok(Array.from(page.window.document.querySelectorAll("[data-scale]")).every(button => button.getAttribute("aria-pressed") === "false"));
  page.window.document.querySelector('[data-scale="1.25"]').click();
  assert.equal(page.el("scale").value, "1.25");
  assert.equal(page.el("scaleVal").textContent, "125%");
  assert.equal(page.window.document.querySelector('[data-scale="1.25"]').getAttribute("aria-pressed"), "true");
});

test("invalid collapsed limits are revealed before native form validation", t => {
  const page = openOptions(t);
  page.load();
  assert.equal(page.el("advancedSettings").open, false);
  page.input("maxMatches", "20001");
  page.el("save").click();
  assert.equal(page.el("advancedSettings").open, true);
  assert.equal(page.setRequests.length, 0);
  assert.equal(page.el("status").textContent, "请修正标出的设置后再保存。");
});

test("preview text chooses a readable foreground and keeps transparent color data intact", t => {
  const page = openOptions(t);
  page.load({ highlightColor: "#000000", currentColor: "#ffffff" });
  assert.equal(page.el("colorPreview").style.color, "rgb(255, 255, 255)");
  assert.equal(page.el("currentPreview").style.color, "rgb(0, 0, 0)");
  page.input("highlightColor", "rgba(0,0,0,0)");
  assert.equal(page.el("colorPreview").style.color, "rgb(0, 0, 0)");
  page.submit();
  assert.equal(page.setRequests[0].values.highlightColor, "rgba(0,0,0,0)");
});

test("save state is announced and the action label recovers after failure", t => {
  const page = openOptions(t);
  page.load();
  page.input("caseSensitive", true);
  assert.equal(page.window.document.querySelector(".action-bar").dataset.state, "pending");
  page.submit();
  assert.equal(page.el("save").textContent, "正在保存…");
  assert.equal(page.el("settings").getAttribute("aria-busy"), "true");
  page.finishSave(0, "Storage unavailable");
  assert.equal(page.el("save").textContent, "保存");
  assert.equal(page.el("settings").getAttribute("aria-busy"), "false");
  assert.equal(page.window.document.querySelector(".action-bar").dataset.state, "error");
});

test("ready settings do not add a visible status and preset feedback remains accessible", t => {
  const page = openOptions(t);
  page.load();
  assert.equal(page.el("status").textContent, "");
  assert.equal(page.el("budgetStatus").textContent, "均衡预设");
  assert.equal(page.el("budgetStatus").classList.contains("sr-only"), true);
  assert.equal(page.el("budgetStatus").getAttribute("aria-live"), "polite");
});

test("automatic language follows the browser and explicit choices preview without saving", t => {
  const page = openOptions(t, "en-US");
  page.load();
  assert.equal(page.el("uiLanguage").value, "auto");
  assert.equal(page.window.document.documentElement.lang, "en");
  assert.equal(page.el("save").textContent, "Save");
  assert.equal(page.el("searchHeading").textContent, "Search defaults");
  page.input("uiLanguage", "zh-CN");
  assert.equal(page.window.document.documentElement.lang, "zh-CN");
  assert.equal(page.el("save").textContent, "保存");
  assert.equal(page.el("searchHeading").textContent, "默认搜索");
  assert.equal(page.setRequests.length, 0);
  page.input("uiLanguage", "auto");
  assert.equal(page.el("save").textContent, "Save");
});

test("language changes update titles, accessibility names, validity and active errors", t => {
  const page = openOptions(t);
  page.load();
  page.input("highlightColor", "broken");
  page.submit();
  page.input("uiLanguage", "en");
  assert.equal(page.window.document.title, "Settings · Regex Rabbit");
  assert.equal(page.el("highlightColorPicker").getAttribute("aria-label"), "Choose the color for all matches");
  assert.equal(page.el("rememberPosition").closest("label").title.startsWith("When off,"), true);
  assert.equal(page.el("highlightColor").validationMessage, "Enter a valid hexadecimal, rgb() or rgba() color.");
  page.submit();
  assert.equal(page.el("status").textContent, "Correct the marked settings before saving.");
  page.input("highlightColor", "#ffe082");
  page.input("maxMatches", "0");
  assert.equal(page.el("maxMatches").validationMessage, "Enter a whole number between 100 and 20,000.");
  page.input("maxMatches", "1000");
  page.submit();
  page.finishSave(0, "Storage unavailable");
  assert.equal(page.el("status").textContent, "Failed to save: Storage unavailable");
  page.input("uiLanguage", "zh-CN");
  // Editing changes the status to the untranslated data's new, localized state.
  assert.equal(page.el("status").textContent, "有未保存的修改。");
});

test("language and permanent position are saved while defaults keep page-only position", t => {
  const page = openOptions(t);
  page.load();
  assert.equal(page.el("rememberPosition").checked, false);
  page.input("uiLanguage", "ja");
  page.input("rememberPosition", true);
  assert.equal(page.setRequests.length, 0);
  page.submit();
  assert.equal(page.setRequests[0].values.uiLanguage, "ja");
  assert.equal(page.setRequests[0].values.rememberPosition, true);
  page.finishSave();
  page.el("reset").click();
  assert.equal(page.el("uiLanguage").value, "auto");
  assert.equal(page.el("rememberPosition").checked, false);
  assert.equal(page.setRequests.length, 1);
});

test("late loading cannot overwrite language and position edited on the settings page", t => {
  const page = openOptions(t);
  page.input("uiLanguage", "en");
  page.input("rememberPosition", true);
  page.load({ uiLanguage: "zh-TW", rememberPosition: false });
  assert.equal(page.el("uiLanguage").value, "en");
  assert.equal(page.el("rememberPosition").checked, true);
  assert.equal(page.el("save").textContent, "Save");
  page.submit();
  assert.equal(page.setRequests[0].values.uiLanguage, "en");
  assert.equal(page.setRequests[0].values.rememberPosition, true);
});

test("switching language during save keeps saving state and unsaved edits", t => {
  const page = openOptions(t);
  page.load();
  page.submit();
  page.input("uiLanguage", "en");
  assert.equal(page.el("save").textContent, "Saving…");
  assert.equal(page.el("status").textContent, "Saving settings…");
  assert.equal(page.el("save").disabled, true);
  page.finishSave();
  assert.equal(page.el("status").textContent, "Earlier changes were saved; you still have unsaved changes.");
  page.submit();
  assert.equal(page.setRequests[1].values.uiLanguage, "en");
});

test("all eight languages render settings text, help, labels and validity in the selected language", t => {
  const page = openOptions(t);
  page.load();
  const saveLabels = {
    "zh-CN": "保存", "zh-TW": "儲存", en: "Save", ja: "保存", ko: "저장",
    de: "Speichern", fr: "Enregistrer", es: "Guardar"
  };
  for (const [language, label] of Object.entries(saveLabels)) {
    page.input("uiLanguage", language);
    assert.equal(page.window.document.documentElement.lang, language);
    assert.equal(page.el("save").textContent, label, language);
    for (const element of page.window.document.querySelectorAll("[data-i18n]")) {
      const key = element.getAttribute("data-i18n");
      assert.notEqual(element.textContent, key, `${language}: ${key}`);
      assert.equal(element.textContent, page.window.RRi18n.t(key), `${language}: ${key}`);
    }
    assert.equal(page.el("highlightColorPicker").getAttribute("aria-label"), page.window.RRi18n.t("options.highlightPicker"));
    assert.equal(page.el("rememberPosition").closest("label").title, page.window.RRi18n.t("options.positionHint"));
    for (const [id, key, fieldId] of [["timeoutHelp", "options.timeoutHelp", "workerTimeoutMs"], ["scanHelp", "options.scanHelp", "maxScannedChars"]]) {
      const field = page.el(fieldId);
      const params = { min: page.window.RRi18n.formatNumber(Number(field.min)), max: page.window.RRi18n.formatNumber(Number(field.max)) };
      assert.equal(page.el(id).textContent, page.window.RRi18n.t(key, params), `${language}: ${key}`);
      assert.equal(page.el(id).textContent.includes(params.max), true);
      assert.equal(page.el(id).classList.contains("sr-only"), true);
      assert.equal(page.el(id).textContent.includes("{max}"), false);
    }
    page.input("highlightColor", "invalid");
    assert.equal(page.el("highlightColor").validationMessage, page.window.RRi18n.t("options.invalidColor"));
    page.submit();
    assert.equal(page.el("status").textContent, page.window.RRi18n.t("options.invalidSettings"));
    assert.equal(page.setRequests.length, 0);
    page.input("highlightColor", "#ffe082");
  }
});
