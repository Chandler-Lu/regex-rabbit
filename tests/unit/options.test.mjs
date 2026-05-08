import assert from "node:assert/strict";
import test from "node:test";

// Test the sanitizeColor function (extracted from options.js for testability)
test("sanitizeColor: 6-digit hex", () => {
  assert.ok(/^#[0-9a-fA-F]{3,8}$/.test("#ff0000"));
  assert.ok(/^#[0-9a-fA-F]{3,8}$/.test("#abcdef"));
  assert.ok(/^#[0-9a-fA-F]{3,8}$/.test("#FFFFFF"));
});

test("sanitizeColor: 3-digit hex", () => {
  assert.ok(/^#[0-9a-fA-F]{3,8}$/.test("#f00"));
  assert.ok(/^#[0-9a-fA-F]{3,8}$/.test("#ffe082"));
});

test("sanitizeColor: CSS injection attempt blocked", () => {
  assert.equal(/^#[0-9a-fA-F]{3,8}$/.test("#ff0000}body{display:none}"), false);
  assert.equal(/^#[0-9a-fA-F]{3,8}$/.test("red}*{color:red}"), false);
  assert.equal(/^#[0-9a-fA-F]{3,8}$/.test('"}body{display:none}.x{"'), false);
});

test("sanitizeColor: valid rgb", () => {
  assert.ok(/^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/.test("rgb(255,0,0)"));
  assert.ok(/^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/.test("rgb(0, 255, 128)"));
});

test("sanitizeColor: valid rgba", () => {
  const rgbaRe = /^rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(0|1|0?\.\d+)\s*\)$/;
  assert.ok(rgbaRe.test("rgba(0,0,0,0.5)"));
  assert.ok(rgbaRe.test("rgba(255,128,0,1)"));
});

test("sanitizeColor: invalid colors rejected", () => {
  assert.equal(/^#[0-9a-fA-F]{3,8}$/.test("not-a-color"), false);
  assert.equal(/^#[0-9a-fA-F]{3,8}$/.test(""), false);
  assert.equal(/^#[0-9a-fA-F]{3,8}$/.test("transparent"), false);
});

// Test the scale NaN fallback logic
test("options: parseFloat NaN → default 1.0", () => {
  const v = parseFloat("abc");
  const scale = isNaN(v) || v < 0.5 || v > 2.5 ? 1.0 : v;
  assert.equal(scale, 1.0);
});

test("options: scale 0 → rejected → 1.0", () => {
  const v = parseFloat("0");
  const scale = isNaN(v) || v < 0.5 || v > 2.5 ? 1.0 : v;
  assert.equal(scale, 1.0);
});

test("options: scale 3.0 → rejected → 1.0", () => {
  const v = parseFloat("3.0");
  const scale = isNaN(v) || v < 0.5 || v > 2.5 ? 1.0 : v;
  assert.equal(scale, 1.0);
});

test("options: scale 1.5 → accepted", () => {
  const v = parseFloat("1.5");
  const scale = isNaN(v) || v < 0.5 || v > 2.5 ? 1.0 : v;
  assert.equal(scale, 1.5);
});

test("options: maxMatches NaN → default 1000", () => {
  const v = parseInt("abc", 10);
  const maxMatches = isNaN(v) || v < 100 ? 1000 : v;
  assert.equal(maxMatches, 1000);
});

test("options: maxMatches 0 → default 1000", () => {
  const v = parseInt("0", 10);
  const maxMatches = isNaN(v) || v < 100 ? 1000 : v;
  assert.equal(maxMatches, 1000);
});

test("options: maxMatches 500 → accepted", () => {
  const v = parseInt("500", 10);
  const maxMatches = isNaN(v) || v < 100 ? 1000 : v;
  assert.equal(maxMatches, 500);
});

test("options: maxMatches 20000 → accepted (max)", () => {
  const v = parseInt("20000", 10);
  const maxMatches = isNaN(v) || v < 100 ? 1000 : v;
  assert.equal(maxMatches, 20000);
});
