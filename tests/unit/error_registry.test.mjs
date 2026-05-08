import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile("domain/error_registry.js", "utf8");
const scope = {};
new Function("globalThis", source)(scope);
const reg = scope.RRErrorRegistry;

test("codes array has entries", () => assert.ok(reg.codes.length >= 7));
test("no duplicate slugs", () => {
  const seen = new Set();
  for (const e of reg.codes) assert.ok(!seen.has(e.slug), "duplicate: " + e.slug), seen.add(e.slug);
});
test("no duplicate codes", () => {
  const seen = new Set();
  for (const e of reg.codes) assert.ok(!seen.has(e.code), "duplicate: " + e.code), seen.add(e.code);
});
test("bySlug ↔ byCode consistent", () => {
  for (const e of reg.codes) {
    assert.equal(reg.bySlug[e.slug].code, e.code);
    assert.equal(reg.byCode[e.code].slug, e.slug);
  }
});
test("codeFor returns correct code", () => {
  assert.equal(reg.codeFor("pattern-invalid-syntax"), 400);
  assert.equal(reg.codeFor("worker-crashed"), 503);
  assert.equal(reg.codeFor("nonexistent"), null);
});
test("slugFor returns correct slug", () => {
  assert.equal(reg.slugFor(400), "pattern-invalid-syntax");
  assert.equal(reg.slugFor(504), "search-timeout");
  assert.equal(reg.slugFor(999), null);
});
test("4xx = user-fixable", () => assert.ok(reg.codes.some(e => e.code >= 400 && e.code < 500)));
test("5xx = system errors", () => assert.ok(reg.codes.some(e => e.code >= 500)));
test("each entry has required fields", () => {
  for (const e of reg.codes) {
    assert.equal(typeof e.slug, "string");
    assert.equal(typeof e.code, "number");
    assert.equal(typeof e.message, "string");
  }
});
