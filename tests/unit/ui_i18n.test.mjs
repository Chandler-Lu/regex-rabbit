import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readdirSync } from "node:fs";
import { readRuntimeSourceSync as readFileSync } from "../fixtures/runtime_source.mjs";
import { JSDOM } from "jsdom";

const source = readFileSync("infra/ui_i18n.js", "utf8");
function open(environment = {}) {
  const scope = vm.createContext(environment);
  vm.runInContext(source, scope);
  return scope.RRi18n;
}

test("automatic UI language follows Chrome before the page or navigator", () => {
  const i18n = open({ chrome: { i18n: { getUILanguage: () => "de-DE" } }, navigator: { languages: ["zh-CN"] } });
  assert.equal(i18n.getLanguage(), "de");
  assert.equal(i18n.getPreference(), "auto");
  assert.equal(i18n.setLanguage("ja"), "ja");
  assert.equal(i18n.getPreference(), "ja");
  assert.equal(i18n.setLanguage("auto"), "de");
  const unsupportedChrome = open({ chrome: { i18n: { getUILanguage: () => "it-IT" } }, navigator: { languages: ["zh-CN"] } });
  assert.equal(unsupportedChrome.getLanguage(), "en");
});

test("navigator and browser-free environments have a defined fallback", () => {
  assert.equal(open().getLanguage(), "en");
  assert.equal(open({ navigator: { language: "es-MX" } }).getLanguage(), "es");
  assert.equal(open({ navigator: { languages: ["it", "fr-CA"], language: "de" } }).getLanguage(), "fr");
  assert.equal(open({ chrome: { i18n: { getUILanguage() { throw new Error("unavailable"); } } }, navigator: { language: "ko-KR" } }).getLanguage(), "ko");
});

test("automatic language checks preferences beyond sixteen entries without modifying the browser list", () => {
  const languages = Object.freeze([...Array(20).fill('it'), 'fr-CA']);
  assert.equal(open({ navigator: { languages, language: 'de' } }).getLanguage(), 'fr');
  assert.equal(languages.length, 21);
});

test("Chinese script and regional variants map to the correct UI", () => {
  for (const locale of ["zh-CN", "zh_SG", "zh", "zh-Hans", "zh-Hans-HK"]) {
    assert.equal(open({ chrome: { i18n: { getUILanguage: () => locale } } }).getLanguage(), "zh-CN", locale);
  }
  for (const locale of ["zh-TW", "zh_HK", "zh-MO", "zh-Hant", "zh-Hant-TW"]) {
    assert.equal(open({ chrome: { i18n: { getUILanguage: () => locale } } }).getLanguage(), "zh-TW", locale);
  }
});

test("explicit language preferences use a whitelist and cannot select object properties", () => {
  const i18n = open({ navigator: { language: "ja" } });
  for (const value of ["__proto__", "constructor", "en-US", {}, ["en"], null, true]) {
    assert.equal(i18n.setLanguage(value), "ja");
    assert.equal(i18n.getPreference(), "auto");
  }
  for (const value of i18n.supportedLanguages) assert.equal(i18n.setLanguage(value), value);
  i18n.setLanguage("zh-CN");
  assert.equal(i18n.t("toolbar.find"), "查找");
  assert.equal(i18n.t("toolbar.jumpRange", { total: 9999 }), "请输入 1 至 9999 之间的序号");
  assert.equal(i18n.t("status.jumpUnavailable"), "该序号已失效");
  i18n.setLanguage("en");
  assert.equal(i18n.t("toolbar.find"), "Find");
  assert.equal(i18n.t("status.invalidPattern"), "Invalid regex");
  assert.equal(i18n.t("status.jumpUnavailable"), "Match unavailable");
});

test("parameters interpolate as text without invoking accessors or user conversion code", () => {
  const i18n = open();
  let reads = 0;
  const params = { total: 10 };
  Object.defineProperty(params, "current", { get() { reads++; return 1; } });
  assert.equal(i18n.t("toolbar.locateCount", params), "Locate match {current} of 10");
  assert.equal(reads, 0);
  assert.equal(i18n.t("toolbar.locateCount", { current: { toString() { reads++; return "1"; } }, total: Infinity }), "Locate match {current} of {total}");
  assert.equal(reads, 0);
  assert.equal(i18n.t("toolbar.locateCount", { current: 0, total: 0 }), "Locate match 0 of 0");
  assert.equal(i18n.t("options.loadError", { error: "${alert(1)}<img src=x onerror=alert(1)>" }), "Failed to load settings: ${alert(1)}<img src=x onerror=alert(1)>");
  assert.equal(i18n.t("options.loadError", Object.create({ error: "inherited" })), "Failed to load settings: {error}");
  assert.equal(i18n.t("unknown.key"), "unknown.key");
  assert.equal(i18n.t("__proto__"), "__proto__");
  assert.equal(i18n.t(null), "");
});

test("DOM translations update text and accessibility attributes without changing unrelated nodes", () => {
  const dom = new JSDOM('<section data-i18n-title="toolbar.more"><span data-i18n="options.save"></span><input data-i18n-placeholder="toolbar.find" data-i18n-aria-label="toolbar.inputLabel"><span id="plain">Unchanged</span><div data-i18n-onclick="options.save"></div></section>', { runScripts: "outside-only" });
  try {
    dom.window.eval(source);
    const i18n = dom.window.RRi18n;
    i18n.setLanguage("zh-CN");
    const root = dom.window.document.querySelector("section");
    i18n.apply(root);
    assert.equal(root.title, "更多选项");
    assert.equal(root.querySelector("span").textContent, "保存");
    assert.equal(root.querySelector("input").placeholder, "查找");
    assert.equal(root.querySelector("input").getAttribute("aria-label"), "查找内容");
    assert.equal(root.querySelector("#plain").textContent, "Unchanged");
    assert.equal(root.querySelector("div").hasAttribute("onclick"), false);
    i18n.setLanguage("en");
    i18n.apply(dom.window.document);
    assert.equal(root.querySelector("span").textContent, "Save");
    assert.equal(root.querySelector("input").placeholder, "Find");
    i18n.apply(null);
  } finally { dom.window.close(); }
});

test("number formatting and language choices follow the selected language", () => {
  const i18n = open();
  i18n.setLanguage("de");
  assert.equal(i18n.formatNumber(12345.6), new Intl.NumberFormat("de").format(12345.6));
  i18n.setLanguage("en");
  assert.equal(i18n.formatNumber(12345.678, { maximumFractionDigits: 1 }), "12,345.7");
  assert.equal(i18n.formatNumber(NaN), "");
  assert.equal(i18n.formatNumber("1"), "");
  i18n.setLanguage("zh-CN");
  assert.equal(i18n.languages[0].label, "跟随浏览器");
  assert.deepEqual(Array.from(i18n.languages, item => item.value), ["auto", "zh-CN", "zh-TW", "en", "ja", "ko", "de", "fr", "es"]);
  assert.equal(Object.isFrozen(i18n.languages), true);
  assert.equal(Object.isFrozen(i18n.languages[1]), true);
});

test("every locale translates the full UI and preserves interpolation parameters", () => {
  const match = source.match(/var MESSAGES = ([\s\S]*?);\n  Object\.keys\(MESSAGES\)/);
  assert.ok(match, "UI dictionaries must be static data");
  const dictionaries = JSON.parse(match[1]);
  const i18n = open();
  const expected = Object.keys(dictionaries.en).sort();
  const placeholders = value => Array.from(value.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g), match => match[1]).sort();
  for (const language of i18n.supportedLanguages) {
    assert.ok(dictionaries[language], language + " dictionary exists");
    assert.deepEqual(Object.keys(dictionaries[language]).sort(), expected, language + " complete UI keys");
    for (const key of expected) {
      assert.equal(typeof dictionaries[language][key], "string", language + " " + key);
      assert.notEqual(dictionaries[language][key], "", language + " " + key);
      assert.deepEqual(placeholders(dictionaries[language][key]), placeholders(dictionaries.en[key]), language + " " + key + " parameters");
    }
  }
});

test("Chrome metadata translations contain only manifest strings in all supported locales", () => {
  const expected = ["de", "en", "es", "fr", "ja", "ko", "zh_CN", "zh_TW"];
  assert.deepEqual(readdirSync("_locales").sort(), expected);
  for (const locale of expected) {
    const metadata = JSON.parse(readFileSync("_locales/" + locale + "/messages.json", "utf8"));
    assert.deepEqual(Object.keys(metadata).sort(), ["appDescription", "appName", "openCommand"]);
    for (const entry of Object.values(metadata)) assert.equal(typeof entry.message, "string");
  }
});
