import assert from "node:assert/strict";
import { readRuntimeSource as readFile } from "../fixtures/runtime_source.mjs";
import test from "node:test";

const source = await readFile("domain/pattern_analyzer.js", "utf8");
function createAnalyzer() {
  const scope = {};
  new Function("globalThis", source)(scope);
  return scope.RRPatternAnalyzer;
}
const pa = createAnalyzer();

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
  const r = pa.addRule({ id: "test-rule", pattern: /XY/, reason: "Test reason" });
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

test("rejects non-string input without coercion", () => {
  const analyzer = createAnalyzer();
  const coercionTrap = { toString() { throw new Error("must not coerce"); } };
  for (const pattern of [undefined, null, 123, false, [], coercionTrap, Symbol("pattern")]) {
    const r = analyzer.analyze(pattern);
    assert.equal(r.status, "invalid");
    assert.equal(r.errorCode, 400);
    assert.equal(r.mode, "regex");
  }
});

test("pattern length is bounded in regex and literal modes", () => {
  const analyzer = createAnalyzer();
  const longest = "x".repeat(analyzer.MAX_PATTERN_LENGTH);
  for (const mode of ["regex", "literal"]) {
    assert.equal(analyzer.analyze(longest, "", { mode }).status, mode === "literal" ? "safe" : "deferred");
    const r = analyzer.analyze(longest + "x", "", { mode });
    assert.equal(r.status, "invalid");
    assert.equal(r.mode, mode);
  }
});

test("flags require strings, unique native flags, and compatible Unicode modes", () => {
  const analyzer = createAnalyzer();
  for (const flags of [null, {}, [], 42, "gg", "ii", "guu", "uv", "g\n", "G", "ggggggggg"]) {
    assert.equal(analyzer.analyze("a", flags).status, "invalid", String(flags));
    assert.equal(analyzer.analyze("[", flags, { mode: "literal" }).status, "invalid", String(flags));
  }
  assert.equal(analyzer.analyze("a", "gimsuy").status, "safe");
  assert.equal(analyzer.analyze("a").status, "safe");
});

test("literal mode permits regex metacharacters and invalid regex syntax", () => {
  const analyzer = createAnalyzer();
  for (const pattern of ["[unclosed", "(a+)*", "(a|aa)+", "\\", ".*+?()[]{}|^$"]) {
    const r = analyzer.analyze(pattern, "gi", { mode: "literal" });
    assert.equal(r.ok, true, pattern);
    assert.equal(r.status, "safe");
    assert.equal(r.mode, "literal");
    assert.deepEqual(r.reasons, []);
  }
  assert.equal(analyzer.analyze("(a+)*", "", { mode: "regex" }).status, "unsafe");
});

test("rejects invalid mode and options without throwing", () => {
  const analyzer = createAnalyzer();
  for (const options of [null, [], "literal", { mode: "unknown" }, { mode: null }]) {
    assert.equal(analyzer.analyze("a", "", options).status, "invalid");
  }
  const options = { get mode() { throw { get message() { throw new Error("must not read"); } }; } };
  assert.equal(analyzer.analyze("a", "", options).status, "invalid");
});

test("mode getter is read only once", () => {
  const analyzer = createAnalyzer();
  let reads = 0;
  const r = analyzer.analyze("[", "", { get mode() { reads += 1; return "literal"; } });
  assert.equal(r.status, "safe");
  assert.equal(reads, 1);
});

test("character classes and escaped punctuation do not create unsafe structures", () => {
  const analyzer = createAnalyzer();
  for (const pattern of ["([+*])+", "([()|])+", "(a\\+)+", "(a\\*)*", "(a\\|b)+", "\\(a+\\)\\*", "([\\]()+*|])+", "((abc))+", "(a{2})+", "((a){2})+"]) {
    assert.equal(analyzer.analyze(pattern, "u").status, "safe", pattern);
  }
});

test("detects variable repeats through nested groups and bounded repeats", () => {
  const analyzer = createAnalyzer();
  for (const pattern of ["((a+)b)+", "(a{1,3})+", "(a+){2}", "(a{2,})*", "(?:a+){2,4}", "(\\w+)*"]) {
    assert.equal(analyzer.analyze(pattern, "u").status, "unsafe", pattern);
  }
  for (const pattern of ["(a+){1}", "(a+){0,1}", "(a+)?"]) {
    assert.equal(analyzer.analyze(pattern, "u").status, "safe", pattern);
  }
});

test("Unicode escapes are atoms while legacy identity escapes preserve structure", () => {
  const analyzer = createAnalyzer();
  assert.equal(analyzer.analyze("(\\u{61})+", "u").status, "safe");
  assert.equal(analyzer.analyze("(\\p{L})+", "u").status, "safe");
  assert.equal(analyzer.analyze("\\u{(a+)*}", "").status, "unsafe");
  assert.equal(analyzer.analyze("\\k<(a+)*>", "").status, "unsafe");
  assert.equal(analyzer.analyze("(?<word>a+)\\k<word>*", "u").status, "safe");
});

test("large runs of literal braces remain valid in legacy mode", () => {
  const analyzer = createAnalyzer();
  assert.equal(analyzer.analyze("{".repeat(analyzer.MAX_MAIN_THREAD_PATTERN_LENGTH)).status, "safe");
});

test("global and sticky custom rules remain deterministic across calls", () => {
  const analyzer = createAnalyzer();
  const globalRule = /GLOBAL/g;
  const stickyRule = /STICKY/y;
  globalRule.lastIndex = 999;
  stickyRule.lastIndex = 999;
  assert.equal(analyzer.addRule({ id: "global", pattern: globalRule, reason: "global blocked" }), true);
  assert.equal(analyzer.addRule({ id: "sticky", pattern: stickyRule, reason: "sticky blocked" }), true);
  for (let i = 0; i < 5; i++) {
    assert.equal(analyzer.analyze("GLOBAL").status, "unsafe");
    assert.equal(analyzer.analyze("STICKY").status, "unsafe");
  }
  assert.equal(globalRule.lastIndex, 999);
  assert.equal(stickyRule.lastIndex, 999);
});

test("custom rule ownership is isolated from caller mutations", () => {
  const analyzer = createAnalyzer();
  const original = { id: "owned", pattern: /ORIGINAL/, reason: "original reason" };
  assert.equal(analyzer.addRule(original), true);
  original.id = "changed";
  original.reason = "changed reason";
  original.pattern.compile("CHANGED");
  const r = analyzer.analyze("ORIGINAL");
  assert.equal(r.status, "unsafe");
  assert.deepEqual(r.reasons, ["original reason"]);
  assert.equal(analyzer.analyze("CHANGED").status, "safe");
});

test("public rules expose isolated frozen snapshots", () => {
  const analyzer = createAnalyzer();
  const snapshot = analyzer.UNSAFE_RULES;
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot[0]), true);
  assert.throws(() => snapshot.pop(), TypeError);
  assert.throws(() => { snapshot[0].reason = "changed"; }, TypeError);
  snapshot[0].pattern.compile("ANYTHING");
  assert.equal(analyzer.analyze("(a+)*").status, "unsafe");
  assert.equal(analyzer.analyze("ANYTHING").status, "safe");
  assert.notEqual(analyzer.UNSAFE_RULES[0].pattern.source, "ANYTHING");
});

test("custom rules reject malformed fields and ignored spoofed regex properties", () => {
  const analyzer = createAnalyzer();
  assert.equal(analyzer.addRule({ id: " ", pattern: /a/, reason: "reason" }), false);
  assert.equal(analyzer.addRule({ id: "blank", pattern: /a/, reason: " " }), false);
  assert.equal(analyzer.addRule({ id: "x".repeat(129), pattern: /a/, reason: "reason" }), false);
  assert.equal(analyzer.addRule({ id: "reason-limit", pattern: /a/, reason: "x".repeat(1025) }), false);
  assert.equal(analyzer.addRule({ id: "source-limit", pattern: new RegExp("x".repeat(analyzer.MAX_RULE_SOURCE_LENGTH + 1)), reason: "reason" }), false);
  assert.equal(analyzer.addRule({ get id() { throw new Error("bad getter"); } }), false);
  const pattern = /SPOOF/g;
  for (const property of ["source", "flags", "global"]) {
    Object.defineProperty(pattern, property, { get() { throw new Error("must ignore " + property); } });
  }
  assert.equal(analyzer.addRule({ id: "native", pattern, reason: "native blocked" }), true);
  assert.equal(analyzer.analyze("SPOOF").status, "unsafe");
});

test("custom rule storage has a fixed upper bound", () => {
  const analyzer = createAnalyzer();
  let accepted = 0;
  for (let i = 0; i < 200; i++) {
    if (analyzer.addRule({ id: "bounded-" + i, pattern: /BLOCKED/, reason: "blocked" })) accepted += 1;
  }
  assert.equal(accepted, 122);
  assert.equal(analyzer.UNSAFE_RULES.length, 128);
});

test("custom rules permit only a bounded fixed-width subset", () => {
  const analyzer = createAnalyzer();
  const sources = ["literal", "^prefix$", "[a-z]", "[^abc]", "[+*?{}()|.]", "[\\]()+*|]",
    "\\(\\)\\+\\*\\?\\{\\}\\|\\.", "\\x61\\u0062", "\\d\\w\\s", "\\cA", "\\bhello\\b"];
  for (let i = 0; i < sources.length; i++) {
    assert.equal(analyzer.addRule({ id: "fixed-" + i, pattern: new RegExp(sources[i], "u"), reason: "fixed rule" }), true, sources[i]);
  }
  assert.equal(analyzer.addRule({ id: "maximum-fixed", pattern: new RegExp("x".repeat(512)), reason: "fixed rule" }), true);
  assert.equal(analyzer.addRule({ id: "oversize-fixed", pattern: new RegExp("x".repeat(513)), reason: "fixed rule" }), false);
  assert.equal(analyzer.MAX_RULE_SOURCE_LENGTH, 512);
});

test("custom rules reject every repetition, group, branch, lookaround, and backreference", () => {
  const analyzer = createAnalyzer();
  const blocked = [/(a+)+$/, /a*a*a*a*a*a*b/, /a+/, /a?/, /a{2}/, /a{0,1}/, /a{2,}/,
    /(a)/, /(?:a)/, /a|b/, /(?=a)/, /(?!a)/, /(?<=a)/, /(?<!a)/, /(a)\1/, /\1/,
    /\k<name>/, /\0/, /a.*b/, /\p{L}/u, /[\p{L}]/u, /\u{61}/u, /\q/];
  for (let i = 0; i < blocked.length; i++) {
    // Reject the rule before analyzing any candidate; never execute a dangerous
    // custom regex to prove that it is dangerous.
    assert.equal(analyzer.addRule({ id: "blocked-" + i, pattern: blocked[i], reason: "blocked rule" }), false, blocked[i].source);
  }
  assert.equal(analyzer.UNSAFE_RULES.length, 6);
  assert.equal(analyzer.analyze("a".repeat(32) + "!").status, "safe");
  assert.equal(analyzer.analyze("a".repeat(analyzer.MAX_MAIN_THREAD_PATTERN_LENGTH - 1) + "!").status, "safe");
});

test("multi-megabyte page-side regex validation compiles only empty native sources", () => {
  const compiledLengths = [];
  function TrackedRegExp(pattern, flags) {
    compiledLengths.push(pattern.length);
    assert.equal(pattern, "", "large sources must not be compiled on the page thread");
    return new RegExp(pattern, flags);
  }
  TrackedRegExp.prototype = RegExp.prototype;
  const scope = {};
  new Function("globalThis", "RegExp", source)(scope, TrackedRegExp);
  const analyzer = scope.RRPatternAnalyzer;
  const pattern = "x".repeat(4096000 - 7) + "(a+)+$";
  const policy = analyzer.analyze(pattern, "gi");
  assert.equal(policy.ok, true);
  assert.equal(policy.status, "deferred", "deferred must not claim a risk-screened expression is safe");
  assert.deepEqual(policy.reasons, []);
  assert.equal(analyzer.analyze(pattern, "gi", { mode: "literal" }).status, "safe");
  assert.deepEqual(compiledLengths, [0, 0]);
  assert.equal(analyzer.MAX_PATTERN_LENGTH, 4096000);
  assert.equal(analyzer.MAX_MAIN_THREAD_PATTERN_LENGTH, 8192);
});

test("long sources still reject unsupported, duplicate, and incompatible flags immediately", () => {
  const analyzer = createAnalyzer();
  const pattern = "x".repeat(10000);
  for (const flags of ["z", "ii", "uv", "ggggggggg", null, {}]) {
    assert.equal(analyzer.analyze(pattern, flags).status, "invalid", String(flags));
  }
});

test("worker validation reviews long regex syntax and risk rather than trusting deferred status", () => {
  const analyzer = createAnalyzer();
  const prefix = "x".repeat(10000);
  assert.equal(analyzer.analyze(prefix + "[", "u").status, "deferred");
  const invalid = analyzer.analyzeInWorker(prefix + "[", "u");
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.errorCode, 400);
  assert.ok(invalid.reasons[0].length <= 512, "native compile error must not echo the complete source");
  assert.equal(analyzer.analyzeInWorker(prefix + "(a+)+$", "u").status, "unsafe");
  assert.equal(analyzer.analyzeInWorker(prefix, "u").status, "safe");
  assert.equal(analyzer.analyzeInWorker(prefix + "[", "u", { mode: "literal" }).status, "safe");
});

test("custom rules reject Unicode set mode when the runtime supports it", (t) => {
  let pattern;
  try { pattern = new RegExp("[a&&b]", "v"); }
  catch { t.skip("Runtime does not support the v flag"); return; }
  const analyzer = createAnalyzer();
  assert.equal(analyzer.addRule({ id: "unicode-set", pattern, reason: "set rule" }), false);
});
test("nested wrapper groups cannot conceal quantified alternation", () => {
  const analyzer = createAnalyzer();
  for (const pattern of ["((a|aa))+$", "(?:(?:a|aa))+$", "(((a|aa)))+$"]) {
    assert.equal(analyzer.analyze(pattern, "u").status, "unsafe", pattern);
  }
});
test("optional atoms inside a repeated group are recognized as variable repeats", () => {
  const analyzer = createAnalyzer();
  for (const pattern of ["(a?a?)+$", "(a{0,1}a{0,1})+$", "((a?))+$", "(?:a{1,2})+$"]) {
    assert.equal(analyzer.analyze(pattern, "u").status, "unsafe", pattern);
  }
  for (const pattern of ["(a+)?", "(a+){0,1}", "a+?", "(?:a?){1}"]) {
    assert.equal(analyzer.analyze(pattern, "u").status, "safe", pattern);
  }
});
test("fixed-width custom wildcard rules permit one atom and reject repetition", () => {
  const analyzer = createAnalyzer();
  assert.equal(analyzer.addRule({ id: "wildcard", pattern: /a.b/su, reason: "wildcard blocked" }), true);
  assert.equal(analyzer.analyze("a\nb").status, "unsafe");
  assert.equal(analyzer.analyze("axxb").status, "safe");
  assert.equal(analyzer.addRule({ id: "repeated-wildcard", pattern: /a.*b/, reason: "blocked" }), false);
});
