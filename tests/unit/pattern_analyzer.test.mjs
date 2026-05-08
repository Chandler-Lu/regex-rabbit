import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile("domain/pattern_analyzer.js", "utf8");
const scope = {};
new Function("globalThis", source)(scope);
const pa = scope.RRPatternAnalyzer;

// ── Safe patterns ────────────────────────────────
test("simple literal safe", () => {
  const r = pa.analyze("hello", "");
  assert.equal(r.ok, true);
  assert.equal(r.status, "safe");
});
test("character class safe", () => assert.equal(pa.analyze("[abc]").status, "safe"));
test("anchors safe", () => assert.equal(pa.analyze("^hello$").status, "safe"));
test("groups safe", () => assert.equal(pa.analyze("(abc)").status, "safe"));
test("alternation safe", () => assert.equal(pa.analyze("cat|dog").status, "safe"));

// ── Invalid patterns ──────────────────────────────
test("syntax error invalid", () => {
  const r = pa.analyze("[unclosed");
  assert.equal(r.ok, false);
  assert.equal(r.status, "invalid");
  assert.equal(r.errorCode, 400);
});
test("bad flags invalid", () => assert.equal(pa.analyze("a", "z").status, "invalid"));

// ── Unsafe patterns ───────────────────────────────
test("nested quantifier unsafe", () => assert.equal(pa.analyze("(a+)*").status, "unsafe"));
test("alternation quantifier unsafe", () => assert.equal(pa.analyze("(a|b)+").status, "unsafe"));
test("deep nested unsafe", () => assert.equal(pa.analyze("((a)+)*").status, "unsafe"));
test("errorCode 451 on unsafe", () => assert.equal(pa.analyze("(a+)*").errorCode, 451));
test("reasons populated for unsafe", () => assert.ok(pa.analyze("(a+)*").reasons.length > 0));

// ── New rules (DEF-13) ──────────────────────────
test("noncapture nested quantifier unsafe", () => assert.equal(pa.analyze("(?:a+)*").status, "unsafe"));
test("exponential backtracking unsafe", () => assert.equal(pa.analyze("(a+)+").status, "unsafe"));
test("repeated wildcard unsafe", () => assert.equal(pa.analyze("(.*)+").status, "unsafe"));
test("multiple reasons for multi-rule pattern", () => {
  const r = pa.analyze("(a+)*(a+)+");
  assert.equal(r.status, "unsafe");
  assert.ok(r.reasons.length >= 2, "should have at least 2 reasons, got " + r.reasons.length);
});

// ── addRule validation (DEF-21) ───────────────────
test("addRule valid rule succeeds", () => {
  const r = pa.addRule({ id: "test-rule", pattern: /X+Y+/, reason: "Test reason" });
  assert.equal(r, true);
});
test("addRule null fails", () => assert.equal(pa.addRule(null), false));
test("addRule missing id fails", () => assert.equal(pa.addRule({ pattern: /a/, reason: "r" }), false));
test("addRule non-regexp pattern fails", () => assert.equal(pa.addRule({ id: "x", pattern: "abc", reason: "r" }), false));
test("addRule duplicate id fails", () => {
  pa.addRule({ id: "unique-test", pattern: /a/, reason: "first" });
  assert.equal(pa.addRule({ id: "unique-test", pattern: /b/, reason: "dup" }), false);
});
test("addRule empty reason fails", () => assert.equal(pa.addRule({ id: "x", pattern: /a/, reason: "" }), false));

// ── Edge ──────────────────────────────────────────
test("empty string safe", () => assert.equal(pa.analyze("").status, "safe"));
test("null does not throw", () => assert.doesNotThrow(() => pa.analyze(null)));
test("result echoes pattern", () => assert.equal(pa.analyze("test").ok, true));
