import assert from "node:assert/strict";
import { readRuntimeSource as readFile } from "../fixtures/runtime_source.mjs";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { resolve } from "node:path";

const wsPath = resolve("search_worker.js");
const workerSource = (await Promise.all(["domain/pattern_analyzer.js", "domain/literal_matcher.js", wsPath].map(path => readFile(path, "utf8")))).join("\n");
const adapted = `
const { parentPort } = require("node:worker_threads");
const { performance } = require("node:perf_hooks");
const self = {
  postMessage(d) { parentPort.postMessage(d); },
  get onmessage() { return this._onm; },
  set onmessage(f) { this._onm = f; if (f) parentPort.on("message", d => f({data:d})); }
};
${workerSource}
`;

function w() { return new Worker(adapted, { eval: true }); }
function recv(worker, ms = 3000) {
  return new Promise((res, rej) => {
    function cleanup() { clearTimeout(t); worker.off("message", onMessage); worker.off("error", onError); }
    function onMessage(d) { cleanup(); res(d); }
    function onError(e) { cleanup(); rej(e); }
    const t = setTimeout(() => { cleanup(); rej(new Error("timeout")); }, ms);
    worker.on("message", onMessage);
    worker.on("error", onError);
  });
}

test("complete flow", async () => {
  const wk = w();
  wk.postMessage({ type: "start", taskId: 1, pattern: "hello", flags: "gi", maxMatches: 100, maxScannedChars: 10000, policyStatus: "safe", allowUnsafeEcmascript: false });
  wk.postMessage({ type: "chunks", taskId: 1, chunks: [{ id: 0, text: "hello world" }] });
  wk.postMessage({ type: "finish", taskId: 1 });
  const m = await recv(wk);
  assert.equal(m.type, "complete");
  assert.equal(m.totalMatches, 1);
  wk.terminate();
});

test("invalid pattern → error 400", async () => {
  const wk = w();
  wk.postMessage({ type: "start", taskId: 2, pattern: "[bad", flags: "", maxMatches: 100, maxScannedChars: 1000, policyStatus: "safe", allowUnsafeEcmascript: false });
  const m = await recv(wk);
  assert.equal(m.type, "error");
  assert.equal(m.numericCode, 400);
  wk.terminate();
});

test("unsafe blocked → 452", async () => {
  const wk = w();
  wk.postMessage({ type: "start", taskId: 3, pattern: "(a+)*", flags: "", maxMatches: 100, maxScannedChars: 1000, policyStatus: "unsafe", allowUnsafeEcmascript: false });
  const m = await recv(wk);
  assert.equal(m.numericCode, 452);
  wk.terminate();
});

test("unknown type → 530", async () => {
  const wk = w();
  wk.postMessage({ type: "foo", taskId: 4 });
  const m = await recv(wk);
  assert.equal(m.numericCode, 530);
  wk.terminate();
});

test("cancel + finish → silent", async () => {
  const wk = w();
  wk.postMessage({ type: "start", taskId: 5, pattern: "x", flags: "", maxMatches: 100, maxScannedChars: 1000, policyStatus: "safe", allowUnsafeEcmascript: false });
  wk.postMessage({ type: "cancel", taskId: 5 });
  wk.postMessage({ type: "finish", taskId: 5 });
  let got = false;
  wk.on("message", () => { got = true; });
  await new Promise(r => setTimeout(r, 100));
  assert.equal(got, false);
  wk.terminate();
});

test("maxMatches stops scan and marks result limited", async () => {
  const wk = w();
  wk.postMessage({ type: "start", taskId: 6, pattern: "a", flags: "g", maxMatches: 3, maxScannedChars: 1000, policyStatus: "safe", allowUnsafeEcmascript: false });
  wk.postMessage({ type: "chunks", taskId: 6, chunks: [{ id: 0, text: "aaaaaaaaaa" }, { id: 1, text: "aaaaaaaaaa" }] });
  const m = await recv(wk);
  assert.equal(m.type, "complete");
  assert.equal(m.matches.length, 3);
  assert.equal(m.totalMatches, 3);
  assert.equal(m.limited, true);
  wk.terminate();
});

test("plain case-sensitive pattern uses literal engine", async () => {
  const wk = w();
  wk.postMessage({ type: "start", taskId: 7, pattern: "needle", flags: "gu", maxMatches: 100, maxScannedChars: 1000, policyStatus: "safe", allowUnsafeEcmascript: false });
  wk.postMessage({ type: "chunks", taskId: 7, chunks: [{ id: 0, text: "needle hay needle" }] });
  wk.postMessage({ type: "finish", taskId: 7 });
  const m = await recv(wk);
  assert.equal(m.type, "complete");
  assert.equal(m.engine, "literal");
  assert.deepEqual(m.matches.map(match => [match.start, match.end]), [[0, 6], [11, 17]]);
  wk.terminate();
});

test("regex metacharacters use regexp while fixed ignore-case strings use the bounded literal engine", async () => {
  const meta = w();
  meta.postMessage({ type: "start", taskId: 8, pattern: "n.e", flags: "g", maxMatches: 100, maxScannedChars: 1000, policyStatus: "safe", allowUnsafeEcmascript: false });
  meta.postMessage({ type: "chunks", taskId: 8, chunks: [{ id: 0, text: "nae n.e" }] });
  meta.postMessage({ type: "finish", taskId: 8 });
  const metaResult = await recv(meta);
  assert.notEqual(metaResult.engine, "literal");
  assert.equal(metaResult.matches.length, 2);
  meta.terminate();

  const ignoreCase = w();
  ignoreCase.postMessage({ type: "start", taskId: 9, pattern: "needle", flags: "gi", maxMatches: 100, maxScannedChars: 1000, policyStatus: "safe", allowUnsafeEcmascript: false });
  ignoreCase.postMessage({ type: "chunks", taskId: 9, chunks: [{ id: 0, text: "Needle needle" }] });
  ignoreCase.postMessage({ type: "finish", taskId: 9 });
  const ignoreCaseResult = await recv(ignoreCase);
  assert.equal(ignoreCaseResult.engine, "literal");
  assert.equal(ignoreCaseResult.matches.length, 2);
  ignoreCase.terminate();
});

async function request(messages, predicate = message => message.type !== "ack") {
  const worker = w();
  try {
    const output = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Worker response timeout")), 3000);
      worker.on("message", message => { if (predicate(message)) { clearTimeout(timer); resolve(message); } });
      worker.on("error", error => { clearTimeout(timer); reject(error); });
    });
    for (const message of messages) worker.postMessage(message);
    return await output;
  } finally { await worker.terminate(); }
}
const start = (taskId, extra = {}) => ({ type: "start", taskId, pattern: "a", flags: "g", ...extra });
const batch = (taskId, chunks, extra = {}) => ({ type: "chunks", taskId, chunks, ...extra });
const finish = taskId => ({ type: "finish", taskId });

test("regex without global flag scans all occurrences and terminates", async () => {
  const result = await request([start(11, { pattern: "a+", flags: "" }), batch(11, [{ id: 0, text: "aa aa" }]), finish(11)]);
  assert.deepEqual(result.matches.map(match => [match.start, match.end]), [[0, 2], [3, 5]]);
  assert.equal(result.scannedChars, 5);
});

test("zero-width Unicode advancement skips complete surrogate pairs", async () => {
  const result = await request([start(12, { pattern: "(?=😀)|x", flags: "gu" }), batch(12, [{ id: 0, text: "😀x" }]), finish(12)]);
  assert.deepEqual(result.matches, [{ chunkId: 0, start: 2, end: 3 }]);
  const allZero = await request([start(13, { pattern: "(?=.)", flags: "gu" }), batch(13, [{ id: 0, text: "😀" }]), finish(13)]);
  assert.equal(allZero.totalMatches, 0);
  assert.equal(allZero.limited, false);
});

test("literal mode treats regex syntax and invalid regex patterns as text", async () => {
  const result = await request([start(14, { pattern: "[a+)*", mode: "literal" }), batch(14, [{ id: 0, text: "x [a+)* y [a+)*" }]), finish(14)]);
  assert.equal(result.engine, "literal");
  assert.deepEqual(result.matches.map(match => [match.start, match.end]), [[2, 7], [10, 15]]);
});

test("literal ignore-case respects Unicode case rules and original UTF-16 offsets", async () => {
  const result = await request([start(15, { pattern: "k", mode: "literal", flags: "giu" }), batch(15, [{ id: 0, text: "İ K K 😀k" }]), finish(15)]);
  assert.equal(result.engine, "literal");
  assert.deepEqual(result.matches.map(match => [match.start, match.end]), [[2, 3], [4, 5], [8, 9]]);
  const expanded = await request([start(16, { pattern: "i", mode: "literal", flags: "giu" }), batch(16, [{ id: 0, text: "İ i" }]), finish(16)]);
  assert.deepEqual(expanded.matches.map(match => [match.start, match.end]), [[2, 3]]);
});

test("sticky matching stops at the first gap in regex and literal modes", async () => {
  for (const mode of ["regex", "literal"]) {
    const result = await request([start(17, { pattern: "a", flags: "y", mode }), batch(17, [{ id: 0, text: "aa ba" }]), finish(17)]);
    assert.deepEqual(result.matches.map(match => [match.start, match.end]), [[0, 1], [1, 2]]);
  }
});

test("wholeWord checks Unicode letters, combining marks, numbers and connector punctuation", async () => {
  const result = await request([start(18, { pattern: "cat", wholeWord: true }), batch(18, [{ id: 0, text: "cat 猫cat cat𐐀 cat_ cat2 cat\u0301 !cat!" }]), finish(18)]);
  assert.deepEqual(result.matches.map(match => [match.start, match.end]), [[0, 3], [31, 34]]);
});

test("wholeWord preserves overlapping candidates after rejecting a partial word", async () => {
  for (const mode of ["literal", "regex"]) {
    for (const flags of ["g", "gu", "giu"]) {
      const result = await request([start(31, { pattern: "a a", mode, flags, wholeWord: true }), batch(31, [{ id: 0, text: "xa a a" }]), finish(31)]);
      assert.deepEqual(result.matches.map(match => [match.start, match.end]), [[3, 6]], `${mode} ${flags}`);
    }
  }
});

test("wholeWord assertions let alternatives and lazy quantifiers find a complete word without changing captures", async () => {
  for (const flags of ["g", "gu", "gv"]) {
    const alternatives = await request([start(32, { pattern: "cat|cater", flags, wholeWord: true }), batch(32, [{ id: 0, text: "cater cat cat𐐀 𐐀cat cat猫 cat_ cat\u0301" }]), finish(32)]);
    assert.deepEqual(alternatives.matches.map(match => [match.start, match.end]), [[0, 5], [6, 9]], flags);
    const lazy = await request([start(33, { pattern: "a+?", flags, wholeWord: true }), batch(33, [{ id: 0, text: "aaa aa" }]), finish(33)]);
    assert.deepEqual(lazy.matches.map(match => [match.start, match.end]), [[0, 3], [4, 6]], flags);
    const captures = await request([start(34, { pattern: "(cat)\\1|cat", flags, wholeWord: true }), batch(34, [{ id: 0, text: "catcat cat" }]), finish(34)]);
    assert.deepEqual(captures.matches.map(match => [match.start, match.end]), [[0, 6], [7, 10]], flags);
  }
});

test("wholeWord sticky matching stops on a rejected boundary instead of continuing past it", async () => {
  for (const mode of ["literal", "regex"]) {
    const result = await request([start(35, { pattern: "a", mode, flags: "yu", wholeWord: true }), batch(35, [{ id: 0, text: "aa a" }]), finish(35)]);
    assert.deepEqual(result.matches, [], mode);
  }
});

test("wholeWord keeps ZWJ and ZWNJ inside connected words while preserving zero-width space boundaries", async () => {
  for (const mode of ["literal", "regex"]) {
    for (const flags of ["g", "gu", "gv"]) {
      const result = await request([start(39, { pattern: mode === "literal" ? "bar" : "bar|b", mode, flags, wholeWord: true }),
        batch(39, [{ id: 0, text: "foo\u200Dbar foo\u200Cbar foo\u200Bbar bar" }]), finish(39)]);
      assert.deepEqual(result.matches.map(match => [match.start, match.end]), [[20, 23], [24, 27]], `${mode} ${flags}`);
      const complete = await request([start(40, { pattern: "foo\u200Dbar", mode, flags, wholeWord: true }),
        batch(40, [{ id: 0, text: "foo\u200Dbar" }]), finish(40)]);
      assert.deepEqual(complete.matches.map(match => [match.start, match.end]), [[0, 7]], `${mode} ${flags} complete`);
    }
  }
});

test("Unicode fixed-string optimization never matches half of a surrogate pair", async () => {
  for (const mode of ["literal", "regex"]) {
    for (const flags of ["gu", "gv"]) {
      const low = await request([start(36, { pattern: "\uDE00", mode, flags }), batch(36, [{ id: 0, text: "😀 \uDE00" }]), finish(36)]);
      assert.deepEqual(low.matches.map(match => [match.start, match.end]), [[3, 4]], `${mode} ${flags} low`);
      const high = await request([start(37, { pattern: "\uD83D", mode, flags }), batch(37, [{ id: 0, text: "😀 \uD83D" }]), finish(37)]);
      assert.deepEqual(high.matches.map(match => [match.start, match.end]), [[3, 4]], `${mode} ${flags} high`);
    }
    const legacy = await request([start(38, { pattern: "\uDE00", mode, flags: "g" }), batch(38, [{ id: 0, text: "😀 \uDE00" }]), finish(38)]);
    assert.deepEqual(legacy.matches.map(match => [match.start, match.end]), [[1, 2], [3, 4]], `${mode} legacy UTF-16`);
  }
});

test("character budget never scans a truncated node or exceeds its limit", async () => {
  const result = await request([start(19, { pattern: ".$", maxScannedChars: 5 }), batch(19, [{ id: 0, text: "abc" }, { id: 1, text: "de" }, { id: 2, text: "fff" }]), finish(19)]);
  assert.equal(result.scannedChars, 5);
  assert.equal(result.scannedNodes, 2);
  assert.equal(result.limited, true);
  assert.equal(result.limitReason, "max-scanned-chars");
  assert.deepEqual(result.matches.map(match => match.chunkId), [0, 1]);
});

test("obsolete per-node limits do not skip whole sources or create artificial anchor matches", async () => {
  const result = await request([start(20, { pattern: "1234$", maxNodeChars: 4, maxChunkMs: 1 }),
    batch(20, [{ id: 0, text: "12345" }, { id: 1, text: "1234" }]), finish(20)]);
  assert.equal(result.scannedChars, 9);
  assert.equal(result.limited, false);
  assert.equal(result.limitReason, null);
  assert.deepEqual(result.matches, [{ chunkId: 1, start: 0, end: 4 }]);
});

test("obsolete source-count limits do not stop scanning and the independent match cap remains explicit", async () => {
  const nodes = await request([start(21, { maxScannedNodes: 1 }), batch(21, [{ id: 0, text: "a" }, { id: 1, text: "a" }]), finish(21)]);
  assert.equal(nodes.scannedNodes, 2);
  assert.equal(nodes.scannedChars, 2);
  assert.equal(nodes.totalMatches, 2);
  assert.equal(nodes.limited, false);
  assert.equal(nodes.limitReason, null);
  const matches = await request([start(22, { maxMatches: 2 }), batch(22, [{ id: 0, text: "aaaa" }])]);
  assert.equal(matches.totalMatches, 2);
  assert.equal(matches.limitReason, "max-matches");
});

test("worker rejects malformed parameter types, IDs, flags and resource limits", async () => {
  const invalid = [
    { taskId: "__proto__" }, { taskId: -1 }, { pattern: {} }, { pattern: "a".repeat(4096001) },
    { flags: {} }, { flags: "gg" }, { mode: "evil" }, { wholeWord: "yes" },
    { allowUnsafeEcmascript: "false" }, { maxMatches: 0 }, { maxMatches: -1 },
    { maxMatches: "3" }, { maxMatches: 1.5 }, { maxMatches: Infinity },
    { maxMatches: 100001 }, { maxScannedChars: NaN }
  ];
  for (const extra of invalid) {
    const result = await request([start(23, extra)]);
    assert.equal(result.type, "error", JSON.stringify(extra));
    assert.ok([400, 530].includes(result.numericCode), JSON.stringify(extra));
  }
});

test("worker validates entire batches and rejects excessive payloads", async () => {
  for (const chunks of [{}, [{ id: "__proto__", text: "a" }], [{ id: 0, text: 7 }], [null]]) {
    const result = await request([start(24), batch(24, chunks)]);
    assert.equal(result.numericCode, 530);
  }
  const chars = await request([start(24, { maxBatchChars: 4 }), batch(24, [{ id: 0, text: "12345" }])]);
  assert.equal(chars.numericCode, 530);
  const count = await request([start(24, { maxBatchNodes: 1 }), batch(24, [{ id: 0, text: "a" }, { id: 1, text: "a" }])]);
  assert.equal(count.numericCode, 530);
});

test("the independent 16 Mi physical source bound is enforced as a protocol limit", async () => {
  const text = "a".repeat(16 * 1024 * 1024);
  const exact = await request([start(50013, { pattern: "z" }), batch(50013, [{ id: 0, text }]), finish(50013)]);
  assert.equal(exact.type, "complete");
  assert.equal(exact.scannedChars, text.length);
  assert.equal(exact.limited, false);
  const oversized = await request([start(50014, { pattern: "z" }), batch(50014, [{ id: 0, text: text + "a" }])]);
  assert.equal(oversized.type, "error");
  assert.equal(oversized.numericCode, 530);
});

test("worker supports batch and relay sequence acknowledgements independently", async () => {
  const ack = await request([start(25, { acknowledged: true, sequence: 1 }), batch(25, [{ id: 0, text: "a" }], { batchId: 7, sequence: 2 })], message => message.type === "ack" && message.batchId === 7);
  assert.equal(ack.scannedChars, 1);
  assert.equal(ack.sequence, undefined);
  const relay = await request([start(26, { sequence: 42 })], message => message.sequence === 42);
  assert.equal(relay.type, "ack");
  assert.equal(relay.taskId, 26);
});

test("batch ACK match IDs are deduplicated and include only stored nonempty matches", async () => {
  const ack = await request([
    start(27, { acknowledged: true, pattern: "x" }),
    batch(27, [{ id: 2, text: "xx" }, { id: 3, text: "none" }, { id: 4, text: "x" }], { batchId: 1 })
  ], message => message.type === "ack" && message.batchId === 1);
  assert.deepEqual(ack.matchedChunkIds, [2, 4]);
  const rejected = await request([
    start(28, { acknowledged: true, pattern: "cat", wholeWord: true }),
    batch(28, [{ id: 0, text: "cat2" }], { batchId: 1 })
  ], message => message.type === "ack" && message.batchId === 1);
  assert.deepEqual(rejected.matchedChunkIds, []);
  const zero = await request([
    start(29, { acknowledged: true, pattern: "(?=x)" }),
    batch(29, [{ id: 0, text: "x" }], { batchId: 1 })
  ], message => message.type === "ack" && message.batchId === 1);
  assert.deepEqual(zero.matchedChunkIds, []);
  const stopped = await request([
    start(30, { acknowledged: true, pattern: "x", maxMatches: 1 }),
    batch(30, [{ id: 0, text: "x" }, { id: 1, text: "x" }], { batchId: 1 })
  ], message => message.type === "ack" && message.batchId === 1);
  assert.equal(stopped.stopped, true);
  assert.deepEqual(stopped.matchedChunkIds, [0]);
  assert.deepEqual(stopped.matchedIntervals, [{ chunkId: 0, start: 0, end: 1 }]);
});

test("stream metadata rejects complex regex, fabricated boundaries and noncontiguous ownership", async () => {
  const stream = { runId: 0, offset: 0, ownedStart: 0, ownedEnd: 2, first: true, last: false };
  const invalid = [
    { pattern: "^a", text: "a-----", stream },
    { text: "aaaaaa", stream: { ...stream, offset: -1 } },
    { text: "aaaaaa", stream: { ...stream, runId: "0" } },
    { text: "aaaaaa", stream: { ...stream, first: 1 } },
    { text: "aaaaaa", stream: { ...stream, ownedStart: 1 } },
    { text: "aaaaaa", stream: { ...stream, ownedEnd: 7 } },
    { text: "aaaa", stream },
    { text: "😀aaaa", stream: { ...stream, ownedEnd: 1 }, flags: "gu" }
  ];
  for (const item of invalid) {
    const result = await request([start(50000, { pattern: item.pattern || "a", flags: item.flags || "g" }),
      batch(50000, [{ id: 0, text: item.text, stream: item.stream }])]);
    assert.equal(result.numericCode, 530, JSON.stringify(item));
  }
  const missing = await request([start(50001), batch(50001, [{ id: 0, text: "aaaaaa", stream }]), finish(50001)]);
  assert.equal(missing.numericCode, 530);
  const gap = await request([start(50002), batch(50002, [{ id: 0, text: "aaaaaa", stream }]),
    batch(50002, [{ id: 1, text: "aaaaaa", stream: { runId: 0, offset: 0, ownedStart: 3, ownedEnd: 6, first: false, last: true } }])]);
  assert.equal(gap.numericCode, 530);
  const movingTail = await request([start(50006), batch(50006, [{ id: 0, text: "aaaaaa", stream: { ...stream, last: true } }]),
    batch(50006, [{ id: 1, text: "aaaaaaa", stream: { runId: 0, offset: 0, ownedStart: 2, ownedEnd: 7, first: false, last: true } }])]);
  assert.equal(movingTail.numericCode, 530);
});

test("all complex patterns are screened in Worker even when the sender claims safe", async () => {
  for (const pattern of ["(a+)+", "x".repeat(9000) + "(a+)+"]) {
    for (const policyStatus of ["safe", "deferred"]) {
      const result = await request([start(50003, { pattern, policyStatus })]);
      assert.equal(result.numericCode, 451);
    }
  }
  const invalid = await request([start(50004, { pattern: "x".repeat(100000) + "[", policyStatus: "deferred" })]);
  assert.equal(invalid.numericCode, 400);
  assert.ok(invalid.message.length <= 512);
  const allowed = await request([start(50009, { pattern: "(a+)+", allowUnsafeEcmascript: true }),
    batch(50009, [{ id: 0, text: "aaa" }]), finish(50009)]);
  assert.equal(allowed.type, "complete");
  assert.equal(allowed.totalMatches, 1);
});

test("chunk IDs increase strictly within and across batches without an unbounded ID set", async () => {
  for (const ids of [[1, 1], [2, 1]]) {
    const duplicate = await request([start(50010), batch(50010, ids.map(id => ({ id, text: "a" })))]);
    assert.equal(duplicate.numericCode, 530);
  }
  const repeated = await request([start(50011), batch(50011, [{ id: 2, text: "a" }]), batch(50011, [{ id: 2, text: "a" }])]);
  assert.equal(repeated.numericCode, 530);
  const monotonic = await request([start(50012), batch(50012, [{ id: 9, text: "a" }]), batch(50012, [{ id: 100, text: "a" }]), finish(50012)]);
  assert.equal(monotonic.type, "complete");
  assert.equal(monotonic.totalMatches, 2);
});

test("native oversized-regexp failures report the engine limit with a short message", async () => {
  const pattern = "a".repeat(70000) + ".";
  const result = await request([start(50005, { pattern, policyStatus: "deferred" }),
    batch(50005, [{ id: 0, text: "a".repeat(70000) + "b" }]), finish(50005)]);
  assert.equal(result.type, "error");
  assert.equal(result.numericCode, 413);
  assert.equal(result.code, "engine-pattern-too-large");
  assert.ok(result.message.length <= 512);
});

test("deep suspended logical runs are accepted and incomplete runs require an explicit limit", async () => {
  const chunks = Array.from({ length: 129 }, (_, id) => ({ id, text: "aaaa", stream: {
    runId: id, offset: 0, ownedStart: 0, ownedEnd: 1, first: true, last: false
  } }));
  const ends = chunks.toReversed().map((chunk, index) => ({ id: chunks.length + index, text: "aaaa", stream: {
    runId: chunk.stream.runId, offset: 0, ownedStart: 1, ownedEnd: 4, first: false, last: true
  } }));
  const deep = await request([start(50007), batch(50007, chunks), batch(50007, ends), finish(50007)]);
  assert.equal(deep.type, "complete");
  assert.equal(deep.totalMatches, 516);
  assert.equal(deep.scannedNodes, 129);
  assert.equal(deep.scannedChars, 516);
  assert.equal(deep.limited, false);
  for (const limitReason of ["max-scanned-chars", "collection-budget"]) {
    const partial = await request([start(50008), batch(50008, [chunks[0]]), { type: "finish", taskId: 50008, limitReason }]);
    assert.equal(partial.type, "complete");
    assert.equal(partial.limited, true);
    assert.equal(partial.limitReason, limitReason);
    assert.equal(partial.totalMatches, 1);
  }
  for (const limitReason of ["max-node-chars", "max-chunk-ms", "max-scanned-nodes", "max-retained-chars", "max-retained-segments", "max-retained-control-chars"]) {
    const obsolete = await request([start(50015), { type: "finish", taskId: 50015, limitReason }]);
    assert.equal(obsolete.type, "error");
    assert.equal(obsolete.numericCode, 530);
  }
});

test("source fragments use canonical source IDs and ACK only completed real sources", async () => {
  const stream = w();
  const output = [];
  stream.on("message", message => output.push(message));
  try {
    stream.postMessage(start(50016, { pattern: "^abc$", acknowledged: true }));
    stream.postMessage(batch(50016, [{ id: 7, text: "ab", source: { runId: 7, offset: 0, first: true, last: false } }], { batchId: 0 }));
    const first = await recv(stream);
    assert.equal(first.type, "ack");
    assert.deepEqual(first.matchedIntervals, []);
    assert.deepEqual(first.completedSourceIds, []);
    stream.postMessage(batch(50016, [{ id: 8, text: "c", source: { runId: 7, offset: 2, first: false, last: true } }], { batchId: 1 }));
    const last = await recv(stream);
    assert.equal(last.type, "ack");
    assert.deepEqual(last.matchedChunkIds, [7]);
    assert.deepEqual(last.completedSourceIds, [7]);
    assert.deepEqual(last.matchedIntervals, [{ chunkId: 7, start: 0, end: 3 }]);
    stream.postMessage(finish(50016));
    const result = await recv(stream);
    assert.equal(result.scannedNodes, 1);
    assert.equal(result.scannedChars, 3);
    assert.deepEqual(result.completedSourceIds, [7]);
  } finally { await stream.terminate(); }
});

test("source protocol rejects overlaps, gaps, ID collisions and stream/source mixtures", async () => {
  const invalid = [
    { source: null },
    { source: { runId: 1, offset: 0, first: true, last: true } },
    { source: { runId: 0, offset: -1, first: true, last: true } },
    { source: { runId: 0, offset: 1, first: true, last: true } },
    { source: { runId: 0, offset: 0, first: 1, last: true } },
    { source: { runId: 0, offset: Number.MAX_SAFE_INTEGER, first: false, last: true } },
    { source: { runId: 0, offset: 0, first: true, last: false }, stream: { runId: 0, offset: 0, ownedStart: 0, ownedEnd: 1, first: true, last: true } }
  ];
  for (const extra of invalid) {
    const failure = await request([start(50017, { pattern: "^abc$" }), batch(50017, [{ id: 0, text: "abc", ...extra }])]);
    assert.equal(failure.numericCode, 530, JSON.stringify(extra));
  }
  for (const offset of [1, 3]) {
    const failure = await request([start(50018, { pattern: "^abc$" }),
      batch(50018, [{ id: 0, text: "ab", source: { runId: 0, offset: 0, first: true, last: false } }]),
      batch(50018, [{ id: 1, text: "c", source: { runId: 0, offset, first: false, last: true } }])]);
    assert.equal(failure.numericCode, 530);
  }
});

test("a truncated complex source is discarded without fabricated end-anchor matches", async () => {
  const initial = { id: 0, text: "abc", source: { runId: 0, offset: 0, first: true, last: false } };
  const incomplete = await request([start(50019, { pattern: "^abc$" }), batch(50019, [initial]), finish(50019)]);
  assert.equal(incomplete.numericCode, 530);
  const partial = await request([start(50020, { pattern: "^abc$" }), batch(50020, [initial]),
    { type: "finish", taskId: 50020, limitReason: "max-scanned-chars" }]);
  assert.equal(partial.type, "complete");
  assert.equal(partial.totalMatches, 0);
  assert.equal(partial.limited, true);
});

test("an empty EOF fragment completes a real source and reports unmatched source release", async () => {
  const sources = [
    { id: 0, text: "abc", source: { runId: 0, offset: 0, first: true, last: false } },
    { id: 1, text: "", source: { runId: 0, offset: 3, first: false, last: true } }
  ];
  const ack = await request([start(50021, { pattern: "^xyz$", acknowledged: true }), batch(50021, sources, { batchId: 0 })],
    message => message.type === "ack" && message.batchId === 0);
  assert.deepEqual(ack.matchedChunkIds, []);
  assert.deepEqual(ack.matchedIntervals, []);
  assert.deepEqual(ack.completedSourceIds, [0]);
  const complete = await request([start(50022, { pattern: "^abc$" }), batch(50022, sources), finish(50022)]);
  assert.equal(complete.scannedNodes, 1);
  assert.equal(complete.scannedChars, 3);
  assert.equal(complete.totalMatches, 1);
});
