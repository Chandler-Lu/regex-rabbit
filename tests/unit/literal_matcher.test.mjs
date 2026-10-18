import assert from "node:assert/strict";
import { readRuntimeSource as readFile } from "../fixtures/runtime_source.mjs";
import test from "node:test";
import vm from "node:vm";

const source = await readFile("domain/literal_matcher.js", "utf8");
const fixture = JSON.parse(await readFile("tests/fixtures/unicode-simple-fold-17.json", "utf8"));
const escape = /[\\^$.*+?()[\]{}|]/g;

function setup() {
  const allocations = [];
  class TrackedArray extends Uint32Array {
    constructor(length) { super(length); allocations.push(this.byteLength); }
  }
  const scope = vm.createContext({ Uint32Array: TrackedArray });
  vm.runInContext(source, scope);
  return { matcher: scope.RRLiteralMatcher, allocations };
}
function run(matcher, text, from = 0, accept = () => "accepted", checkTime) {
  const actual = [];
  matcher.scan(text, from, (start, end) => {
    const decision = accept(start, end);
    if (decision === "accepted") actual.push([start, end]);
    return decision;
  }, checkTime);
  return actual;
}
function oracle(pattern, text, flags, accept = () => "accepted") {
  const regexp = new RegExp(pattern.replace(escape, "\\$&"), flags.includes("g") ? flags : flags + "g");
  const unicode = flags.includes("u") || flags.includes("v"), sticky = flags.includes("y");
  const matches = [];
  let value;
  while ((value = regexp.exec(text))) {
    const start = value.index, end = start + value[0].length, decision = accept(start, end);
    if (decision === "accepted") matches.push([start, end]);
    else if (decision === "stop" || sticky) break;
    else regexp.lastIndex = start + (unicode && text.codePointAt(start) > 0xFFFF ? 2 : 1);
  }
  return matches;
}

test("fixed strings agree with native Unicode and legacy simple case folding", () => {
  const { matcher } = setup();
  for (const [left, right] of fixture.pairs) {
    for (const [needle, haystack] of [[left, right], [right, left]]) {
      const pattern = String.fromCodePoint(needle), text = "!" + String.fromCodePoint(haystack) + "!";
      for (const flags of ["gi", "giu", "giv"]) {
        assert.deepEqual(run(matcher.compile(pattern, flags), text), oracle(pattern, text, flags),
          `${needle.toString(16)} ${haystack.toString(16)} ${flags}`);
      }
    }
  }
});

test("literal metacharacters, Unicode expansions and surrogate boundaries remain exact", () => {
  const { matcher } = setup();
  const samples = [
    ["a.b+[c](d)^$\\?{|}", "!a.b+[c](d)^$\\?{|}!"], ["i", "iIİı"], ["K", "kKK"],
    ["s", "sSſ"], ["ß", "ßẞss"], ["Σ", "Σσς"], ["𐐀a", "!𐐨A𐐀a!"],
    ["\uDE00", "😀 \uDE00 😀"], ["\uD800", "𐀀 \uD800"], ["É", "Ée\u0301"]
  ];
  for (const [pattern, text] of samples) for (const flags of ["g", "gu", "gi", "giu", "giv", "iyu"]) {
    assert.deepEqual(run(matcher.compile(pattern, flags), text), oracle(pattern, text, flags), JSON.stringify({ pattern, flags }));
  }
  assert.deepEqual(run(matcher.compile("", "giu"), "abc"), []);
});

test("rejected matches preserve overlapping candidates and sticky termination", () => {
  const { matcher } = setup();
  for (const size of [3, 4097]) {
    const pattern = "a".repeat(size), text = "A".repeat(size + 7);
    for (const flags of ["gi", "giu", "iyu"]) {
      const accept = start => start < 3 ? "rejected" : "accepted";
      assert.deepEqual(run(matcher.compile(pattern, flags), text, 0, accept), oracle(pattern, text, flags, accept));
    }
  }
  const matcherInstance = matcher.compile("aba", "giu"), text = "abababa";
  assert.deepEqual(run(matcherInstance, text, 0, start => start === 0 ? undefined : "accepted"), [[2, 5]]);
});

test("maximum ASCII query avoids needle arrays until a Unicode window needs them", () => {
  const { matcher, allocations } = setup();
  const pattern = "Ab".repeat(2048000), text = "!" + pattern.toLowerCase() + "!";
  const compiled = matcher.compile(pattern, "giu");
  assert.equal(compiled.length, 4096000);
  assert.equal(compiled.unicode, true);
  assert.deepEqual(run(compiled, text), [[1, 4096001]]);
  assert.equal(allocations.length, 0, "ASCII search must not allocate the 46.9 MiB needle tables");
  assert.deepEqual(run(compiled, "猫" + pattern.toLowerCase()), [[1, 4096001]]);
  const allocated = allocations.reduce((sum, bytes) => sum + bytes, 0);
  assert.equal(allocated, pattern.length * 12);
  assert.deepEqual(run(compiled, "😀" + pattern.toUpperCase()), [[2, 4096002]]);
  assert.equal(allocations.reduce((sum, bytes) => sum + bytes, 0), allocated, "later windows reuse the same fallback tables");
});

test("long ASCII windows preserve Kelvin sign and long-s distinctions between flags", () => {
  const { matcher } = setup();
  for (const [character, equivalent] of [["k", "K"], ["s", "ſ"]]) {
    const pattern = character.repeat(4097), text = equivalent.repeat(4097);
    for (const flags of ["gi", "giu", "giv"]) {
      assert.deepEqual(run(matcher.compile(pattern, flags), text), oracle(pattern, text, flags));
    }
  }
  const pattern = "i".repeat(4097);
  assert.deepEqual(run(matcher.compile(pattern, "giu"), "İ" + pattern.toUpperCase()), [[1, 4098]]);
});

test("repetitive near misses retain linear fallback and do not create false matches", () => {
  const { matcher, allocations } = setup();
  const length = 65536, pattern = "a".repeat(length / 4) + "b" + "a".repeat(length * 3 / 4 - 1);
  const compiled = matcher.compile(pattern, "giu");
  assert.deepEqual(run(compiled, "A".repeat(length * 2)), []);
  assert.ok(allocations.length > 0, "ambiguous long comparisons must use the linear fallback");
  const allocated = allocations.reduce((sum, bytes) => sum + bytes, 0);
  assert.deepEqual(run(compiled, pattern.toUpperCase()), [[0, length]]);
  assert.equal(allocations.reduce((sum, bytes) => sum + bytes, 0), allocated);
});

test("long sticky matching advances complete matches and stops at the first rejection", () => {
  const { matcher } = setup();
  const pattern = "Ab".repeat(2049), compiled = matcher.compile(pattern, "iyu");
  assert.deepEqual(run(compiled, pattern.toLowerCase().repeat(3) + "!"), [[0, 4098], [4098, 8196], [8196, 12294]]);
  assert.deepEqual(run(compiled, "!" + pattern), []);
  assert.deepEqual(run(compiled, pattern.repeat(2), 0, start => start ? "rejected" : "accepted"), [[0, 4098]]);
});

test("starting inside a surrogate pair keeps the previous scanner's exact position", () => {
  const { matcher } = setup();
  assert.deepEqual(run(matcher.compile("\uDE00", "gu"), "😀 \uDE00", 1), [[1, 2], [3, 4]]);
  assert.deepEqual(run(matcher.compile("😀", "gu"), "😀 😀", 1), [[3, 5]]);
});

test("dense one-character matches resume native Unicode search across long sparse tails", () => {
  const { matcher } = setup();
  const text = "S".repeat(16385) + "ſ" + "猫".repeat(20000) + "sS";
  for (const flags of ["gi", "giu", "giv"]) {
    assert.deepEqual(run(matcher.compile("s", flags), text), oracle("s", text, flags));
  }
});

test("native and fallback scans obey cancellation before publishing more matches", () => {
  const { matcher } = setup();
  for (const pattern of ["a", "a".repeat(4097)]) {
    const compiled = matcher.compile(pattern, "giu"), text = pattern.repeat(3);
    assert.deepEqual(run(compiled, text, 0, undefined, () => false), []);
    let visible = 0;
    const result = run(compiled, text, 0, () => { visible++; return "accepted"; }, () => visible === 0);
    assert.equal(result.length, 1);
  }
});
