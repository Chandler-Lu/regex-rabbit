import assert from "node:assert/strict";
import { readRuntimeSource as readFile } from "../fixtures/runtime_source.mjs";
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
  assert.equal(reg.codeFor("engine-pattern-too-large"), 413);
  assert.equal(reg.codeFor("engine-text-too-large"), 414);
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
test("unknown prototype names cannot be mistaken for registered errors", () => {
  for (const key of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
    assert.equal(reg.codeFor(key), null);
    assert.equal(reg.slugFor(key), null);
    assert.equal(reg.bySlug[key], undefined);
    assert.equal(reg.byCode[key], undefined);
  }
  const trap = { toString() { throw new Error("must not coerce"); } };
  assert.equal(reg.codeFor(trap), null);
  assert.equal(reg.slugFor(trap), null);
});
test("registry consumers cannot mutate later error lookups", () => {
  assert.throws(() => { reg.codes[0].code = 999; }, TypeError);
  assert.throws(() => { reg.byCode[400] = reg.codes[1]; }, TypeError);
  assert.throws(() => reg.codes.pop(), TypeError);
  assert.equal(reg.codeFor("pattern-invalid-syntax"), 400);
});

test("localized error text is explicit and leaves diagnostic messages unchanged", () => {
  const translated = {
    "error.invalidSyntax.title": "正则有误",
    "error.invalidSyntax.detail": "检查括号和转义，或改用普通文本。"
  };
  const translate = key => translated[key] ?? key;
  assert.equal(reg.messageFor("pattern-invalid-syntax", translate), "正则有误");
  assert.equal(reg.detailFor("pattern-invalid-syntax", translate), "检查括号和转义，或改用普通文本。");
  assert.equal(reg.messageFor("pattern-invalid-syntax"), "Invalid regular expression syntax.");
  assert.equal(reg.byCode[400].message, "Invalid regular expression syntax.");
});

test("missing and failed translations retain actionable fallbacks", () => {
  for (const translate of [undefined, key => key, () => "", () => null, () => { throw new Error("unavailable"); }]) {
    assert.equal(reg.messageFor("search-timeout", translate), "Search timed out.");
    assert.equal(reg.detailFor("search-timeout", translate), "The search time limit was reached. Narrow the scope or simplify the query.");
  }
});

test("unknown errors cannot invoke translations or coerce arbitrary objects", () => {
  let calls = 0;
  const translate = () => { calls++; return "unexpected"; };
  const trap = { toString() { throw new Error("must not coerce"); } };
  for (const slug of ["nonexistent", "__proto__", "constructor", trap, null]) {
    assert.equal(reg.messageFor(slug, translate), "");
    assert.equal(reg.detailFor(slug, translate), "");
  }
  assert.equal(calls, 0);
});
