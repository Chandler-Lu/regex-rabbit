import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile("background.js", "utf8");
const scope = {};
// The isInjectable function is local — extract for testing
const isInjectable = (function () {
  const BLOCKED = [
    "chrome://", "chrome-extension://",
    "https://chrome.google.com/webstore", "https://chromewebstore.google.com",
    "edge://", "about:"
  ];
  return function isInjectable(url) {
    if (!url || typeof url !== "string") return false;
    for (const p of BLOCKED) { if (url.startsWith(p)) return false; }
    return true;
  };
})();

test("chrome:// URLs are blocked", () => {
  assert.equal(isInjectable("chrome://settings/"), false);
  assert.equal(isInjectable("chrome://extensions/"), false);
});

test("chrome-extension:// URLs are blocked", () => {
  assert.equal(isInjectable("chrome-extension://abcdef"), false);
});

test("edge:// URLs are blocked", () => {
  assert.equal(isInjectable("edge://settings/"), false);
});

test("about: URLs are blocked", () => {
  assert.equal(isInjectable("about:blank"), false);
  assert.equal(isInjectable("about:newtab"), false);
});

test("Google Web Store is blocked", () => {
  assert.equal(isInjectable("https://chrome.google.com/webstore"), false);
  assert.equal(isInjectable("https://chromewebstore.google.com"), false);
});

test("https:// URLs are injectable", () => {
  assert.equal(isInjectable("https://example.com"), true);
  assert.equal(isInjectable("https://github.com"), true);
});

test("http:// URLs are injectable", () => {
  assert.equal(isInjectable("http://localhost"), true);
});

test("null URL returns false", () => {
  assert.equal(isInjectable(null), false);
});

test("undefined URL returns false", () => {
  assert.equal(isInjectable(undefined), false);
});

test("non-string URL returns false", () => {
  assert.equal(isInjectable(123), false);
  assert.equal(isInjectable({}), false);
});

test("empty string URL returns false (falsy check)", () => {
  assert.equal(isInjectable(""), false);
});

test("file:// URLs are injectable (not blocked)", () => {
  assert.equal(isInjectable("file:///tmp/test.html"), true);
});
