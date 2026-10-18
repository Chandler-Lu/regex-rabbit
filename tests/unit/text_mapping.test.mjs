import assert from "node:assert/strict";
import { readRuntimeSource as readFile } from "../fixtures/runtime_source.mjs";
import test from "node:test";

const scope = {};
new Function("globalThis", await readFile("infra/text_mapping.js", "utf8"))(scope);
const mapping = scope.RRTextMapping;

function recipe(rawSnapshot, overrides = {}, node = {}) {
  return { node, rawSnapshot, rawBaseOffset: 0, rawStart: 0, rawEnd: rawSnapshot.length,
    displayStart: 0, start: 0, end: rawSnapshot.length, initialOriginalRunLength: 0,
    initialPreviousCollapsedWhitespace: false, initialAtLineStart: false,
    initialTrailingIsSelected: false, whiteSpace: "normal", collapseMode: "collapse",
    textTransform: "none", actualTransform: "none", ...overrides };
}

test("collapsed whitespace resolves original UTF-16 endpoints and merges contiguous raw spans", async () => {
  const raw = "  a \t \n b   c ";
  const records = [recipe(raw, { end: 5 })];
  const [result] = await mapping.resolveMatches(records, [{ chunkId: 7, start: 0, end: 5 }]);
  assert.equal(result.chunkId, 7);
  assert.equal(result.spans.length, 1);
  assert.equal(result.spans[0].nodeStart, 2);
  assert.equal(result.spans[0].nodeEnd, 13);
  assert.equal(result.spans[0].rawSnapshot, raw);
  assert.equal(mapping.readBoundText(result.spans), "a b c");
});

test("one ordinary space remains a linear original position", async () => {
  const raw = "a b c";
  const results = await mapping.resolveMatches([recipe(raw)], [{ start: 1, end: 2 }, { start: 3, end: 5 }]);
  assert.deepEqual(results.map(result => [result.spans[0].nodeStart, result.spans[0].nodeEnd]), [[1, 2], [3, 5]]);
  assert.equal(mapping.readBoundText(results[1].spans), " c");
});

test("pre-line removes spaces around real newlines without bridging unpainted gaps", async () => {
  const raw = "x \t \n  y\n z  ";
  const [result] = await mapping.resolveMatches([recipe(raw, { end: 5, collapseMode: "preserve-breaks", whiteSpace: "pre-line" })], [{ start: 0, end: 5 }]);
  assert.equal(result.spans.length, 4);
  assert.deepEqual(result.spans.map(span => [span.nodeStart, span.nodeEnd]), [[0, 1], [4, 5], [7, 9], [10, 11]]);
  assert.equal(mapping.readBoundText(result.spans), "x\ny\nz");
});

test("selection clips original offsets and ignores the collapsed-away tail", async () => {
  const raw = "aa  bb cc";
  const selected = recipe(raw, { end: 3, mappedSelection: true, selectionIntersects: true, selectionStart: 2, selectionEnd: 6 });
  const [result] = await mapping.resolveMatches([selected], [{ start: 0, end: 3 }]);
  assert.equal(mapping.readBoundText(result.spans), " bb");
  assert.deepEqual(result.spans.map(span => [span.nodeStart, span.nodeEnd]), [[2, 6]]);
  const tail = { ...selected, selectionStart: 3, end: 2 };
  const [tailResult] = await mapping.resolveMatches([tail], [{ start: 0, end: 2 }]);
  assert.deepEqual(tailResult.spans.map(span => [span.nodeStart, span.nodeEnd]), [[4, 6]]);
  assert.equal(mapping.readBoundText(tailResult.spans), "bb");
});

test("pre-line can remove a previous chunk's trailing space after window coordinates change", async () => {
  const record = recipe("\nb", { start: 1, end: 3, displayStart: 2, initialOriginalRunLength: 2,
    initialPreviousCollapsedWhitespace: true, collapseMode: "preserve-breaks", whiteSpace: "pre-line" });
  const window = mapping.sliceWindow([record], 1, 3, 1);
  const [result] = await mapping.resolveMatches(window, [{ start: 0, end: 2 }]);
  assert.equal(mapping.readBoundText(result.spans), "\nb");
  assert.equal(window[0].initialDisplayedLength, 2);
  assert.equal(record.displayStart, 2);
});

test("cross-chunk collapsed whitespace retains only the painted source part", async () => {
  const raw = "a " + " ".repeat(256 * 1024) + "b";
  const node = {};
  const first = recipe(raw, { rawEnd: 128 * 1024, end: 2 }, node);
  const last = recipe(raw, { rawStart: 256 * 1024, start: 2, end: 3, displayStart: 2,
    initialOriginalRunLength: 2, initialPreviousCollapsedWhitespace: true }, node);
  const [result] = await mapping.resolveMatches([first, last], [{ start: 1, end: 3 }]);
  assert.equal(result.spans.length, 2);
  assert.deepEqual(result.spans.map(span => [span.nodeStart, span.nodeEnd]), [[1, 128 * 1024], [raw.length - 1, raw.length]]);
  assert.equal(mapping.readBoundText(result.spans), " b");
});

test("separate Text nodes and ASCII casing retain exact source references", async () => {
  const firstNode = {}, lastNode = {};
  const first = recipe("ab ", { end: 3, textTransform: "uppercase", actualTransform: "uppercase" }, firstNode);
  const last = recipe("Cd", { start: 3, end: 5, displayStart: 3, initialOriginalRunLength: 3,
    initialPreviousCollapsedWhitespace: true, textTransform: "lowercase", actualTransform: "lowercase" }, lastNode);
  const [result] = await mapping.resolveMatches([first, last], [{ start: 1, end: 5 }]);
  assert.equal(result.spans.length, 2);
  assert.equal(result.spans[0].node, firstNode);
  assert.equal(result.spans[1].node, lastNode);
  assert.equal(mapping.readBoundText(result.spans), "B cd");
});

test("preserved whitespace, replaced spaces and surrogate offsets stay in UTF-16 units", async () => {
  const raw = "a😀\t\r\nb";
  const [preserved] = await mapping.resolveMatches([recipe(raw, { collapseMode: "preserve", whiteSpace: "break-spaces" })], [{ start: 1, end: raw.length }]);
  assert.equal(preserved.spans[0].nodeStart, 1);
  assert.equal(preserved.spans[0].nodeEnd, raw.length);
  assert.equal(mapping.readBoundText(preserved.spans), "😀\t\r\nb");
  const [spaces] = await mapping.resolveMatches([recipe(raw, { collapseMode: "preserve-spaces" })], [{ start: 1, end: raw.length }]);
  assert.equal(mapping.readBoundText(spaces.spans), "😀   b");
});

test("window slicing preserves raw snapshot offsets from selected substrings", async () => {
  const raw = "a  bb";
  const record = recipe(raw, { rawBaseOffset: 100, rawStart: 100, rawEnd: 105, end: 4 });
  const sliced = mapping.sliceWindow([record], 1, 4, 1);
  const [result] = await mapping.resolveMatches(sliced, [{ start: 0, end: 3 }]);
  assert.deepEqual(result.spans.map(span => [span.nodeStart, span.nodeEnd, span.snapshotStart, span.snapshotEnd]), [[101, 105, 1, 5]]);
  assert.equal(mapping.readBoundText(result.spans), " bb");
  assert.equal(sliced[0].rawSnapshot, raw);
});

test("many matches replay a raw chunk once and preserve the caller's match order", async () => {
  const raw = "a  ".repeat(40000);
  const record = recipe(raw, { end: 79999 });
  const intervals = Array.from({ length: 9999 }, (_, index) => ({ chunkId: 4, start: index * 2, end: index * 2 + 1 }));
  let checkpoints = 0;
  const results = await mapping.resolveMatches([record], intervals, { checkpoint() { checkpoints++; return true; } });
  assert.equal(results.length, 9999);
  assert.ok(checkpoints < intervals.length / 32, `preparation and replay must check in batches, not per hit: ${checkpoints}`);
  assert.deepEqual(results[9998].spans.map(span => [span.nodeStart, span.nodeEnd]), [[9998 * 3, 9998 * 3 + 1]]);
  const reversed = await mapping.resolveMatches([recipe("abc")], [{ chunkId: 3, start: 2, end: 3 }, { chunkId: 3, start: 0, end: 1 }]);
  assert.deepEqual(reversed.map(result => result.start), [2, 0]);
});

test("synchronous mapping checkpoints do not create a microtask per source record", async () => {
  const records = Array.from({ length: 2048 }, (_, index) => recipe('abc', {
    start: index * 3, end: index * 3 + 3, displayStart: index * 3, collapseMode: 'preserve'
  }));
  let active = true, microtasks = 0;
  function pulse() { if (active) { microtasks++; queueMicrotask(pulse); } }
  queueMicrotask(pulse);
  let results;
  try { results = await mapping.resolveMatches(records, records.map(record => ({ start: record.start, end: record.end })), { checkpoint: () => true }); }
  finally { active = false; }
  assert.equal(results.length, records.length);
  assert.ok(microtasks < 10, `mapping queued ${microtasks} microtask turns`);
});

test("asynchronous mapping cancellation releases a suspended traversal", async () => {
  let resume;
  const pending = mapping.resolveMatches([recipe('abc')], [{ start: 0, end: 3 }], {
    checkpoint: () => new Promise(resolve => { resume = resolve; })
  });
  assert.equal(typeof resume, 'function');
  resume(false);
  assert.equal(await pending, null);
});

test("callers can cancel immediately after requesting a mapping even with synchronous checkpoints", async () => {
  let active = true;
  const pending = mapping.resolveMatches([recipe('abc')], [{ start: 0, end: 3 }], {
    shouldContinue: () => active, checkpoint: () => true
  });
  active = false;
  assert.equal(await pending, null);
});

test("legacy segment mapping preserves collapsed whitespace and cross-node offsets", async () => {
  const first = {}, second = {};
  const entry = { node: first, text: 'ab c', segments: [
    { node: first, start: 0, end: 2, nodeStart: 0, nodeEnd: 2, sourceText: 'ab' },
    { node: first, start: 2, end: 3, nodeStart: 2, nodeEnd: 5, sourceText: '   ' },
    { node: second, start: 3, end: 4, nodeStart: 0, nodeEnd: 1, sourceText: 'c' }
  ] };
  const [hit] = await mapping.resolveLegacyMatches(entry, [{ start: 1, end: 4 }]);
  assert.deepEqual(hit.spans.map(span => [span.nodeStart, span.nodeEnd]), [[1, 2], [2, 5], [0, 1]]);
  assert.equal(mapping.readBoundText(hit.spans), 'b c');
  assert.equal(await mapping.resolveLegacyMatches(entry, [{ start: 1, end: 4 }], { checkpoint: () => false }), null);
});

test("cancellation and deadline exceptions propagate during long source replay", async () => {
  const raw = "x\t".repeat(64 * 1024);
  const records = [recipe(raw, { end: raw.length - 1 })];
  const intervals = [{ start: 0, end: raw.length - 1 }];
  let calls = 0;
  assert.equal(await mapping.resolveMatches(records, intervals, { checkpoint() { return ++calls < 3; } }), null);
  const timeout = Object.assign(new Error("deadline"), { code: 504 });
  await assert.rejects(mapping.resolveMatches(records, intervals, { checkpoint() { throw timeout; } }), error => error === timeout);
});

test("large raw DOM offsets are not truncated to 32 bits", async () => {
  const base = 4294967306;
  const [result] = await mapping.resolveMatches([recipe("abc", { rawBaseOffset: base, rawStart: base, rawEnd: base + 3 })], [{ start: 1, end: 3 }]);
  assert.equal(result.spans[0].nodeStart, base + 1);
  assert.equal(result.spans[0].nodeEnd, base + 3);
  assert.equal(mapping.readBoundText(result.spans), "bc");
});

test("dense whitespace replay uses compact relative offsets while retaining large source bases", async () => {
  const raw = 'a  '.repeat(40000), base = 4294967306;
  let allocated = 0;
  function track(Type) { return function (length) { const buffer = new Type(length); allocated += buffer.byteLength; return buffer; }; }
  const measured = {};
  new Function('globalThis', 'Uint32Array', 'Float64Array', await readFile('infra/text_mapping.js', 'utf8'))(
    measured, track(Uint32Array), track(Float64Array));
  const [result] = await measured.RRTextMapping.resolveMatches([recipe(raw, {
    rawBaseOffset: base, rawStart: base, rawEnd: base + raw.length, end: 80000
  })], [{ start: 79998, end: 80000 }]);
  assert.equal(result.spans[0].nodeStart, base + raw.length - 3);
  assert.equal(result.spans[0].nodeEnd, base + raw.length);
  assert.equal(mapping.readBoundText(result.spans), 'a ');
  assert.ok(allocated <= raw.length * 12 + 4, `temporary mapping buffers used ${allocated} bytes`);
});

test("invalid or incomplete displayed coverage is rejected without reading the DOM", async () => {
  const node = { get nodeValue() { throw new Error("DOM reads are not allowed"); } };
  const valid = recipe("abc", {}, node);
  assert.ok(await mapping.resolveMatches([valid], [{ start: 0, end: 3 }]));
  assert.equal(await mapping.resolveMatches([{ ...valid, rawEnd: 4 }], [{ start: 0, end: 3 }]), null);
  assert.equal(await mapping.resolveMatches([{ ...valid, start: 1 }], [{ start: 0, end: 3 }]), null);
  assert.equal(await mapping.resolveMatches([valid], [{ start: 0, end: 4 }]), null);
  assert.equal(await mapping.resolveMatches([valid], [{ start: 0, end: Infinity }]), null);
});
