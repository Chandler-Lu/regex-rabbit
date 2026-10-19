import assert from "node:assert/strict";
import { readRuntimeSource as readFile } from "../fixtures/runtime_source.mjs";
import test from "node:test";
import vm from "node:vm";

const source = (await Promise.all(["domain/pattern_analyzer.js", "domain/literal_matcher.js", "search_worker.js"].map(path => readFile(path, "utf8")))).join("\n");
const unicodeFixture = JSON.parse(await readFile("tests/fixtures/unicode-simple-fold-17.json", "utf8"));

function harness() {
  const messages = [];
  const scope = vm.createContext({ self: { postMessage(message) { messages.push(message); } }, performance });
  vm.runInContext(source, scope);
  const send = data => scope.self.onmessage({ data });
  return { messages, scope, send };
}

function windows(text, needleLength, core = 8, runId = 0) {
  const result = [];
  let start = 0;
  const cutsPair = index => index > 0 && index < text.length &&
    text.charCodeAt(index - 1) >= 0xD800 && text.charCodeAt(index - 1) <= 0xDBFF &&
    text.charCodeAt(index) >= 0xDC00 && text.charCodeAt(index) <= 0xDFFF;
  while (start < text.length) {
    let end = Math.min(text.length, start + core);
    if (cutsPair(end)) end++;
    let offset = Math.max(0, start - 2);
    if (cutsPair(offset)) offset--;
    let right = Math.min(text.length, end + needleLength + 2);
    if (cutsPair(right)) right++;
    result.push({ id: result.length, text: text.slice(offset, right), stream: {
      runId, offset, ownedStart: start, ownedEnd: end, first: start === 0, last: right === text.length
    } });
    start = end;
  }
  return result;
}

test("literal Unicode case folding agrees with native C/S pairs and never expands text", () => {
  const { messages, send } = harness();
  let taskId = 10000;
  for (const [left, right] of unicodeFixture.pairs) {
    for (const flags of ["gi", "giu", "giv"]) {
      const pattern = String.fromCodePoint(left), text = String.fromCodePoint(right);
      const native = new RegExp(pattern, flags).exec(text);
      messages.length = 0;
      send({ type: "search", taskId: taskId++, pattern, flags, mode: "literal", chunks: [{ id: 0, text }] });
      const actual = messages.find(message => message.type === "complete");
      assert.ok(actual, `${left.toString(16)} ${flags}`);
      assert.deepEqual(Array.from(actual.matches, value => [value.start, value.end]),
        native ? [[native.index, native.index + native[0].length]] : [], `${left.toString(16)} -> ${right.toString(16)} ${flags}`);
    }
  }
  for (const [pattern, text] of [["İ", "i"], ["ı", "i"], ["ß", "ss"], ["É", "e\u0301"], ["\u0345", "Ιι"], ["ᾈ", "ᾀ"]]) {
    messages.length = 0;
    send({ type: "search", taskId: taskId++, pattern, flags: "giu", mode: "literal", chunks: [{ id: 0, text }] });
    const native = Array.from(text.matchAll(new RegExp(pattern, "giu")), value => [value.index, value.index + value[0].length]);
    assert.deepEqual(Array.from(messages.at(-1).matches, value => [value.start, value.end]), native, JSON.stringify({ pattern, text }));
  }
});

test("real 4,096,000-unit literals match under default Unicode ignore-case semantics", () => {
  const { messages, send } = harness();
  const pattern = "Ab".repeat(2048000), text = "!" + pattern.toLowerCase() + "!";
  for (const mode of ["literal", "regex"]) {
    messages.length = 0;
    send({ type: "search", taskId: 20000, pattern, flags: "giu", mode, policyStatus: "deferred", chunks: [{ id: 0, text }] });
    const result = messages.at(-1);
    assert.equal(result.type, "complete");
    assert.equal(result.engine, "literal");
    assert.equal(result.limited, false);
    assert.deepEqual(Array.from(result.matches, value => [value.start, value.end]), [[1, 4096001]]);
  }
  // Non-Latin identity folds use the same bounded numeric cache. A source this
  // long must not compile millions of one-character native expressions.
  const nonLatin = "猫".repeat(4096000);
  messages.length = 0;
  send({ type: "search", taskId: 20001, pattern: nonLatin, flags: "giu", mode: "literal",
    chunks: [{ id: 0, text: "!" + nonLatin + "!" }] });
  const result = messages.at(-1);
  assert.equal(result.type, "complete");
  assert.equal(result.limited, false);
  assert.deepEqual(Array.from(result.matches, value => [value.start, value.end]), [[1, 4096001]]);
});

test("literal windows preserve global nonoverlap, whole words, Unicode and sticky matching", () => {
  const cases = [
    { pattern: "aba", text: "abababa abababa", flags: "gu" },
    { pattern: "a a", text: "xa a a !a a! xa a a", flags: "giu", wholeWord: true },
    { pattern: "cat", text: "cat𐐀 !cat! 猫cat cat\u200Bcat", flags: "giu", wholeWord: true },
    { pattern: "𐐀a", text: "!𐐨A𐐀a 😀𐐨A!", flags: "giu" },
    { pattern: "\uDE00", text: "😀 \uDE00 😀 \uDE00", flags: "gu" },
    { pattern: "a", text: "aaaaaa baaa", flags: "yu" }
  ];
  const word = "[\\p{L}\\p{N}\\p{M}\\p{Pc}\\u200C\\u200D]";
  for (const item of cases) {
    for (const mode of ["literal", "regex"]) {
      const { messages, send } = harness();
      const chunks = windows(item.text, item.pattern.length, 4);
      send({ type: "start", taskId: 30000, ...item, mode, acknowledged: true });
      for (let index = 0; index < chunks.length; index++) send({ type: "chunks", taskId: 30000, batchId: index, chunks: [chunks[index]] });
      send({ type: "finish", taskId: 30000 });
      const result = messages.find(message => message.type === "complete");
      assert.ok(result, JSON.stringify({ item, mode, messages }));
      let expectedSource = item.pattern.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
      if (item.wholeWord) expectedSource = `(?<!${word})(?:${expectedSource})(?!${word})`;
      const expected = Array.from(item.text.matchAll(new RegExp(expectedSource, item.flags.includes("g") ? item.flags : item.flags + "g")), value => [value.index, value.index + value[0].length]);
      const actual = Array.from(result.matches, value => [chunks[value.chunkId].stream.offset + value.start, chunks[value.chunkId].stream.offset + value.end]);
      assert.deepEqual(actual, expected, JSON.stringify({ item, mode }));
      assert.equal(result.scannedChars, item.text.length);
      assert.equal(result.scannedNodes, 1);
      const ackMatches = messages.filter(message => message.batchId !== undefined).flatMap(message => Array.from(message.matchedIntervals));
      assert.deepEqual(ackMatches.map(value => [value.chunkId, value.start, value.end]), Array.from(result.matches, value => [value.chunkId, value.start, value.end]));
    }
  }
});

test("aggregate accounting remains exact above 2^32 without allocating a multi-gigabyte string", () => {
  const { messages, scope, send } = harness();
  const before = 2 ** 32 + 17;
  send({ type: "start", taskId: 40000, pattern: "needle", mode: "literal", maxScannedChars: before + 6 });
  // Seed a previously consumed logical budget; the actual next chunks are real
  // six/one-unit strings. This exercises arithmetic, not a 4 GiB scan claim.
  scope.tasks[40000].scannedChars = before;
  send({ type: "chunks", taskId: 40000, chunks: [{ id: 0, text: "needle" }, { id: 1, text: "x" }] });
  const result = messages.at(-1);
  assert.equal(result.scannedChars, before + 6);
  assert.equal(result.limitReason, "max-scanned-chars");
  assert.equal(result.totalMatches, 1);
});

test("a logical text continuation has no independent per-run character limit", () => {
  const { messages, scope, send } = harness();
  const before = 5 * 1024 * 1024 * 1024;
  send({ type: "start", taskId: 40004, pattern: "needle", flags: "giu", mode: "literal", maxScannedChars: before + 7 });
  // Seed prior owned-window accounting and resume one real nine-unit window.
  // This checks logical offsets above the removed 4 GiB cap without claiming a
  // physical multi-gigabyte scan or allocating one multi-gigabyte string.
  scope.tasks[40004].scannedChars = before;
  scope.tasks[40004].scannedNodes = 1;
  scope.tasks[40004].streamRuns.set(7, { runId: 7, ownedEnd: before, runEnd: null, nextGlobalOffset: before, stickyStopped: false });
  send({ type: "chunks", taskId: 40004, chunks: [{ id: 0, text: "!!needle!", stream: {
    runId: 7, offset: before - 2, ownedStart: before, ownedEnd: before + 7, first: false, last: true
  } }] });
  send({ type: "finish", taskId: 40004 });
  const result = messages.at(-1);
  assert.equal(result.type, "complete");
  assert.equal(result.scannedChars, before + 7);
  assert.equal(result.scannedNodes, 1);
  assert.equal(result.limited, false);
  assert.deepEqual(Array.from(result.matches, value => [value.start, value.end]), [[2, 8]]);
});

test("completed logical sources keep statistical counts beyond the removed ten-million quota", () => {
  const { messages, scope, send } = harness();
  send({ type: "start", taskId: 40005, pattern: "needle", mode: "literal", maxScannedNodes: 1 });
  // Seed previously completed sources solely to test count arithmetic; no ten-
  // million-source physical scan is claimed. New sources are actual entries.
  scope.tasks[40005].scannedNodes = 10_000_001;
  send({ type: "chunks", taskId: 40005, chunks: [
    { id: 0, text: "needle" },
    { id: 1, text: "needle", stream: { runId: 8, offset: 0, ownedStart: 0, ownedEnd: 6, first: true, last: true } }
  ] });
  send({ type: "finish", taskId: 40005 });
  const result = messages.at(-1);
  assert.equal(result.type, "complete");
  assert.equal(result.scannedNodes, 10_000_003);
  assert.equal(result.totalMatches, 2);
  assert.equal(result.limited, false);
  assert.equal(result.limitReason, null);
});

test("sticky literal matching stops at the first mismatch without consuming the rest of the window", () => {
  const { messages, scope, send } = harness();
  vm.runInContext(`var consumedPoints = 0;
    var nativeAttempts = [];
    var nativePoint = String.prototype.codePointAt;
    String.prototype.codePointAt = function (index) { consumedPoints++; return nativePoint.call(this, index); };
    var nativeExec = RegExp.prototype.exec;
    RegExp.prototype.exec = function (text) {
      if (text.length >= 1024 * 1024) nativeAttempts.push({ sticky: this.sticky, start: this.lastIndex });
      return nativeExec.call(this, text);
    };`, scope);
  send({ type: "start", taskId: 40002, pattern: "a", flags: "iyu", mode: "literal" });
  scope.consumedPoints = 0;
  send({ type: "chunks", taskId: 40002, chunks: [{ id: 0, text: "b" + "a".repeat(1024 * 1024) }] });
  send({ type: "finish", taskId: 40002 });
  assert.equal(messages.at(-1).totalMatches, 0);
  assert.equal(messages.at(-1).limited, false);
  assert.ok(scope.consumedPoints <= 1, "a scalar matcher may read the first failing code point; native matching needs no JS point reads");
  assert.ok(scope.nativeAttempts.length <= 1, "native matching must not retry later positions after the first sticky failure");
  assert.ok(Array.from(scope.nativeAttempts).every(attempt => attempt.sticky && attempt.start === 0),
    "every native attempt is anchored at the failing initial position");
});

test("suspended Ruby-style runs keep independent nonoverlap offsets while annotation is scanned", () => {
  for (const annotationStream of [true, false]) {
    const { messages, send } = harness();
    const text = "aba abababa", base = windows(text, 3, 4, 1);
    for (let index = 1; index < base.length; index++) base[index].id++;
    const byId = new Map(base.map(chunk => [chunk.id, chunk]));
    const annotation = { id: 1, text: "aba" };
    if (annotationStream) annotation.stream = { runId: 2, offset: 0, ownedStart: 0, ownedEnd: 3, first: true, last: true };
    send({ type: "start", taskId: 40003, pattern: "aba", mode: "literal", flags: "giu" });
    send({ type: "chunks", taskId: 40003, chunks: [base[0], annotation, ...base.slice(1)] });
    send({ type: "finish", taskId: 40003 });
    const result = messages.at(-1);
    assert.equal(result.type, "complete");
    assert.equal(result.totalMatches, 4);
    const baseMatches = Array.from(result.matches).filter(match => match.chunkId !== 1)
      .map(match => [byId.get(match.chunkId).stream.offset + match.start, byId.get(match.chunkId).stream.offset + match.end]);
    assert.deepEqual(baseMatches, [[0, 3], [4, 7], [8, 11]]);
    assert.equal(result.scannedChars, text.length + annotation.text.length);
    assert.equal(result.scannedNodes, 2);
  }
});

test("numeric matching results have no independent matched-text character quota", () => {
  const { messages, send } = harness();
  const pattern = "a".repeat(1024 * 1024), text = pattern.repeat(4);
  send({ type: "start", taskId: 40001, pattern, flags: "g" });
  for (let index = 0; index < 9; index++) send({ type: "chunks", taskId: 40001, chunks: [{ id: index, text }] });
  send({ type: "finish", taskId: 40001 });
  const result = messages.at(-1);
  assert.equal(result.type, "complete");
  assert.equal(result.totalMatches, 36);
  assert.equal(result.limitReason, null);
  assert.equal(result.limited, false);
  assert.equal(result.scannedChars, 36 * 1024 * 1024);
  assert.equal(Array.from(result.matches).reduce((total, match) => total + match.end - match.start, 0), 36 * 1024 * 1024);
});

test("fragmented complete sources preserve native anchors, lookarounds, backreferences and Unicode", () => {
  const cases = [
    { pattern: "^alpha beta$", text: "alpha beta", cuts: [6], flags: "gu" },
    { pattern: "a(?=bcd)", text: "xabcdx", cuts: [2], flags: "gu" },
    { pattern: "(?<=abc)d", text: "xabcdy", cuts: [4], flags: "gu" },
    { pattern: "(ab+)\\1", text: "abbabb abbabb", cuts: [2, 8], flags: "gu" },
    { pattern: "(?=😀)|x", text: "😀x", cuts: [1], flags: "gu" },
    { pattern: "a+", text: "aaa aa", cuts: [2], flags: "yu" },
    { pattern: "cat|cater", text: "cater cat_ !cat!", cuts: [3, 10], flags: "giu", wholeWord: true }
  ];
  const words = "[\\p{L}\\p{N}\\p{M}\\p{Pc}\\u200C\\u200D]";
  for (const item of cases) {
    const { messages, send } = harness();
    send({ type: "start", taskId: 40006, pattern: item.pattern, flags: item.flags, mode: "regex", wholeWord: item.wholeWord, acknowledged: true });
    const ends = [...item.cuts, item.text.length];
    let offset = 0;
    for (let id = 0; id < ends.length; id++) {
      const end = ends[id];
      send({ type: "chunks", taskId: 40006, batchId: id, chunks: [{ id, text: item.text.slice(offset, end), source: {
        runId: 0, offset, first: id === 0, last: id === ends.length - 1
      } }] });
      const ack = messages.at(-1);
      assert.equal(ack.type, "ack", JSON.stringify({ item, ack }));
      if (id !== ends.length - 1) {
        assert.deepEqual(Array.from(ack.matchedIntervals), [], "partial sources must not match at artificial boundaries");
        assert.deepEqual(Array.from(ack.completedSourceIds), []);
      } else assert.deepEqual(Array.from(ack.completedSourceIds), [0]);
      offset = end;
    }
    send({ type: "finish", taskId: 40006 });
    const result = messages.at(-1);
    assert.equal(result.type, "complete");
    let nativeSource = item.pattern;
    if (item.wholeWord) nativeSource = `(?<!${words})(?:${nativeSource})(?!${words})`;
    const oracle = new RegExp(nativeSource, item.flags.includes("g") ? item.flags : item.flags + "g");
    const expected = [];
    let match;
    while ((match = oracle.exec(item.text)) !== null) {
      if (match[0].length) expected.push([0, match.index, match.index + match[0].length]);
      else oracle.lastIndex += item.text.codePointAt(match.index) > 0xFFFF ? 2 : 1;
      if (oracle.lastIndex > item.text.length) break;
    }
    assert.deepEqual(Array.from(result.matches, value => [value.chunkId, value.start, value.end]), expected, JSON.stringify(item));
    assert.equal(result.scannedChars, item.text.length);
    assert.equal(result.scannedNodes, 1);
    assert.equal(result.limited, false);
  }
});

test("a real complex source over 16 Mi is assembled before matching with full-source offsets", () => {
  const { messages, send } = harness();
  const first = "a".repeat(12 * 1024 * 1024), second = "a".repeat(8 * 1024 * 1024) + "b";
  send({ type: "start", taskId: 40007, pattern: "^a+b$", flags: "g", mode: "regex", acknowledged: true });
  send({ type: "chunks", taskId: 40007, batchId: 0, chunks: [{ id: 0, text: first,
    source: { runId: 0, offset: 0, first: true, last: false } }] });
  assert.deepEqual(Array.from(messages.at(-1).matchedIntervals), []);
  send({ type: "chunks", taskId: 40007, batchId: 1, chunks: [{ id: 1, text: second,
    source: { runId: 0, offset: first.length, first: false, last: true } }] });
  const lastAck = messages.at(-1);
  assert.deepEqual(Array.from(lastAck.completedSourceIds), [0]);
  assert.deepEqual(Array.from(lastAck.matchedIntervals, value => [value.chunkId, value.start, value.end]), [[0, 0, first.length + second.length]]);
  send({ type: "finish", taskId: 40007 });
  const result = messages.at(-1);
  assert.equal(result.type, "complete");
  assert.equal(result.totalMatches, 1);
  assert.equal(result.scannedChars, 20 * 1024 * 1024 + 1);
  assert.equal(result.scannedNodes, 1);
  assert.equal(result.limited, false);
});

test("native String assembly limits give a short browser-capability error and release the task", () => {
  const { messages, send } = harness();
  const fragment = "a".repeat(4 * 1024 * 1024);
  send({ type: "start", taskId: 40008, pattern: "^a+b$", flags: "g", mode: "regex" });
  // Reuse one real 4 Mi string reference. Native rope concatenation rejects the
  // 512 Mi length before flattening that giant string; no 512 Mi physical
  // transmission or unique-content scan is claimed by this test.
  for (let index = 0; index < 128; index++) send({ type: "chunks", taskId: 40008, chunks: [{ id: index, text: fragment,
    source: { runId: 0, offset: index * fragment.length, first: index === 0, last: false } }] });
  const failure = messages.at(-1);
  assert.equal(failure.type, "error");
  assert.equal(failure.code, "engine-text-too-large");
  assert.equal(failure.numericCode, 414);
  assert.ok(failure.message.length <= 512);
  messages.length = 0;
  send({ type: "search", taskId: 40009, pattern: "recovered", flags: "g", chunks: [{ id: 0, text: "recovered" }] });
  assert.equal(messages.at(-1).type, "complete");
  assert.equal(messages.at(-1).totalMatches, 1);
});

test("seeded Unicode contexts preserve native positions and whole-word branch selection", () => {
  const messages = [];
  const scope = vm.createContext({ self: { postMessage(message) { messages.push(message); } }, performance });
  vm.runInContext(source, scope);
  let seed = 104729;
  const random = bound => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % bound;
  const alphabet = ["a", "b", " ", "!", "猫", "𐐀", "😀", "\u0301", "_", "\uD83D", "\uDE00", "\u200C", "\u200D", "\u200B"];
  // ASCII expressions retain the same consuming semantics in u and legacy
  // modes; native Unicode assertions supply an independent word-boundary oracle.
  const patterns = ["a", "a a", "aa|a", "a|ab", "a+?", "(a)\\1|ab", "a(?=b)|ab", "[ab]+?", "(?=a)|a", "a*?b"];
  const word = "[\\p{L}\\p{N}\\p{M}\\p{Pc}\\u200C\\u200D]";
  for (let taskId = 1; taskId <= 2000; taskId++) {
    let text = "";
    const length = 10 + random(70);
    for (let index = 0; index < length; index++) text += alphabet[random(alphabet.length)];
    const pattern = patterns[random(patterns.length)];
    const mode = taskId % 2 ? "regex" : "literal";
    const wholeWord = Math.floor(taskId / 2) % 2 === 0;
    const flags = ["g", "gu", "giu", "gv"][Math.floor(taskId / 4) % 4];
    let expectedSource = mode === "literal" ? pattern.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&") : pattern;
    if (wholeWord) expectedSource = `(?<!${word})(?:${expectedSource})(?!${word})`;
    const oracle = new RegExp(expectedSource, flags.includes("u") || flags.includes("v") ? flags : flags + "u");
    const expected = [];
    let match;
    while ((match = oracle.exec(text)) !== null) {
      if (match[0].length) expected.push([match.index, match.index + match[0].length]);
      else oracle.lastIndex += text.codePointAt(match.index) > 0xFFFF ? 2 : 1;
      if (oracle.lastIndex > text.length) break;
    }
    messages.length = 0;
    scope.self.onmessage({ data: { type: "search", taskId, pattern, flags, mode, wholeWord, chunks: [{ id: 0, text }] } });
    const actual = messages.find(message => message.type === "complete");
    assert.ok(actual, `Worker must complete case ${taskId}`);
    assert.deepEqual(Array.from(actual.matches, value => [value.start, value.end]), expected,
      JSON.stringify({ taskId, pattern, flags, mode, wholeWord, text }));
    assert.equal(actual.limited, false);
  }
});
