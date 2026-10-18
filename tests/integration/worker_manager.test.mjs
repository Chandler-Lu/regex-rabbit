import assert from "node:assert/strict";
import { readRuntimeSource as readFile } from "../fixtures/runtime_source.mjs";
import test from "node:test";

const source = await readFile("infra/worker_manager.js", "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(options = {}) {
  const workers = [], created = [], revoked = [], fetches = [], blobs = [];
  class MockWorker {
    constructor() { this.messages = []; this.terminated = false; workers.push(this); }
    postMessage(message) {
      if (this.terminated) throw new Error("Posting to terminated worker");
      this.messages.push(message);
      if (options.onPost) return options.onPost(this, message);
      if (message.type === "chunks") queueMicrotask(() => this.respond({ type: "ack", taskId: message.taskId, batchId: message.batchId }));
      if (message.type === "finish") queueMicrotask(() => this.respond({ type: "complete", taskId: message.taskId, matches: [], totalMatches: 0, scannedChars: 0, limited: false, limitReason: null }));
    }
    respond(message) { if (!this.terminated && this.onmessage) this.onmessage({ data: message }); }
    terminate() { this.terminated = true; }
  }
  const scope = { RRWorkerTransport: options.transport, performance: options.clock ? { now: options.clock } : performance };
  const fetch = (...args) => {
    fetches.push(args);
    return options.fetch ? options.fetch(...args) : Promise.resolve({ ok: true, text: async () => "// worker" });
  };
  new Function("globalThis", "chrome", "fetch", "Worker", "URL", "Blob", source)(scope,
    { runtime: { getURL: filename => "extension://" + filename } }, fetch, MockWorker,
    { createObjectURL: blob => { const url = "blob:" + created.length; blobs.push(blob); created.push(url); return url; }, revokeObjectURL: url => revoked.push(url) }, Blob);
  return { manager: scope.RRWorkerManager, workers, created, revoked, fetches, blobs };
}
const nodes = [{ id: 0, text: "hello" }];

test("manager validates inputs without coercing user values", async () => {
  const { manager, workers } = fixture();
  const bad = { toString() { throw new Error("must not coerce"); } };
  await assert.rejects(manager.search("__proto__", "x", "g", nodes), { code: "worker-protocol-error" });
  await assert.rejects(manager.search(1, bad, "g", nodes), { code: "worker-protocol-error" });
  await assert.rejects(manager.search(1, "x", bad, nodes), { code: "worker-protocol-error" });
  await assert.rejects(manager.search(1, "x", "g", {}), { code: "worker-protocol-error" });
  await assert.rejects(manager.search(1, "x", "g", nodes, { mode: "evil" }), { code: "worker-protocol-error" });
  await assert.rejects(manager.search(1, "x", "g", nodes, { wholeWord: "yes" }), { code: "worker-protocol-error" });
  await assert.rejects(manager.search(1, "x", "g".repeat(10), nodes), { code: "worker-protocol-error" });
  await assert.rejects(manager.search(1, "x", "g", nodes, { status: {} }), { code: "worker-protocol-error" });
  await assert.rejects(manager.search(1, "x", "g", nodes, { analyzeInWorker: "yes" }), { code: "worker-protocol-error" });
  await assert.rejects(manager.search(1, "x".repeat(4096001), "g", nodes), { code: "worker-protocol-error" });
  assert.equal(workers.length, 0);
});

test("million-character queries remain uncompiled until the Worker and physical transfer stays bounded", async () => {
  const h = fixture({ fetch: async filename => ({ text: async () => "// " + filename }) });
  h.manager.updateConfig({ maxScannedChars: 64 * 1024 * 1024 * 1000, maxNodeChars: 4 * 1024 * 1024 * 1000,
    maxChunkMs: 1, maxBatchChars: 4 * 1024 * 1024 * 1000, workerTimeoutMs: 900000 });
  const pattern = "x".repeat(4096000);
  await h.manager.search(1, pattern, "giu", nodes, { mode: "literal", status: "deferred", analyzeInWorker: true });
  const start = h.workers[0].messages[0];
  assert.equal(start.pattern, pattern);
  assert.equal(start.analyzeInWorker, true);
  assert.equal(start.policyStatus, "deferred");
  assert.equal(start.maxScannedChars, 64 * 1024 * 1024 * 1000);
  assert.equal("maxNodeChars" in start, false);
  assert.equal("maxChunkMs" in start, false);
  assert.equal(start.maxBatchChars, 16 * 1024 * 1024);
  assert.ok(start.workerTimeoutMs > 899000 && start.workerTimeoutMs <= 900000);
  assert.deepEqual(h.workers[0].messages.filter(message => message.type === "chunks").flatMap(message => message.chunks), nodes);
  assert.deepEqual(h.fetches.map(([url]) => url), ["extension://domain/runtime_policy.js", "extension://domain/pattern_analyzer.js", "extension://domain/literal_matcher.js", "extension://search_worker.js"]);
  assert.equal(await h.blobs[0].text(), h.fetches.map(([url]) => "// " + url).join("\n"));
  h.manager.dispose();
});

test("manager config ignores fractions, invalid types, excessive limits and inherited keys", async () => {
  const { manager, workers } = fixture();
  manager.updateConfig({ maxMatches: 17, allowUnsafeEcmascript: false });
  manager.updateConfig({ maxMatches: 1.5, batchSize: -1, maxBatchChars: Infinity, maxNodeChars: 0, workerTimeoutMs: 1e20, allowUnsafeEcmascript: "false", hasOwnProperty: null });
  manager.updateConfig(Object.assign(Object.create({ maxMatches: 2 }), { batchSize: 3 }));
  await manager.search(1, "x", "g", nodes);
  const start = workers[0].messages[0];
  assert.equal(start.maxMatches, 17);
  assert.equal(start.maxBatchNodes, 3);
  assert.equal("maxNodeChars" in start, false);
  assert.equal("maxChunkMs" in start, false);
  assert.equal(start.allowUnsafeEcmascript, false);
  manager.dispose();
});

test("search supersedes a pending startup and shares one source fetch", async () => {
  const pending = deferred();
  const { manager, workers, fetches } = fixture({ fetch: () => pending.promise });
  const first = manager.search(1, "x", "g", nodes);
  const cancelled = assert.rejects(first, { code: "search-cancelled" });
  await tick();
  const second = manager.search(2, "x", "g", nodes);
  await tick();
  assert.equal(fetches.length, 4);
  pending.resolve({ text: async () => "// worker" });
  await cancelled;
  await second;
  assert.equal(workers.length, 1);
  assert.equal(workers[0].messages[0].taskId, 2);
  manager.dispose();
});

test("bundled Worker assets can exceed the former per-file and combined source caps", async () => {
  const sourceAsset = '// ' + 'x'.repeat(1024 * 1024) + '\n';
  const h = fixture({ fetch: async () => ({ ok: true, text: async () => sourceAsset }) });
  try {
    await h.manager.search(1, 'x', 'g', nodes);
    assert.equal(h.workers.length, 1);
    assert.equal(h.fetches.length, 4);
    assert.equal(h.blobs[0].size, sourceAsset.length * 4 + 3);
  } finally { h.manager.dispose(); }
  assert.equal(h.revoked.length, 1);
});

test("cancel during source fetch rejects promptly and does not create a worker", async () => {
  const pending = deferred();
  const { manager, workers } = fixture({ fetch: () => pending.promise });
  const result = manager.search(8, "x", "g", nodes);
  const rejection = assert.rejects(result, { name: "AbortError", code: "search-cancelled" });
  await tick();
  manager.cancel(8);
  await rejection;
  pending.resolve({ text: async () => "// worker" });
  await tick();
  assert.equal(workers.length, 0);
  manager.dispose();
});

test("dispose during source fetch aborts and never leaks a late Blob URL", async () => {
  const pending = deferred();
  const { manager, workers, created, fetches } = fixture({ fetch: () => pending.promise });
  const result = manager.search(1, "x", "g", nodes);
  const rejection = assert.rejects(result, { code: "search-cancelled" });
  await tick();
  manager.dispose();
  await rejection;
  assert.equal(fetches[0][1].signal.aborted, true);
  pending.resolve({ text: async () => "// worker" });
  await tick();
  assert.equal(created.length, 0);
  assert.equal(workers.length, 0);
});

test("dispose cancels live searches, revokes source and allows later searches", async () => {
  let ack = false;
  const { manager, workers, created, revoked } = fixture({ onPost(worker, message) {
    if (message.type === "chunks" && ack) queueMicrotask(() => worker.respond({ type: "ack", taskId: message.taskId, batchId: message.batchId }));
    if (message.type === "finish") queueMicrotask(() => worker.respond({ type: "complete", taskId: message.taskId, matches: [], limited: false }));
  } });
  const result = manager.search(1, "x", "g", nodes);
  const rejection = assert.rejects(result, { code: "search-cancelled" });
  await tick();
  manager.dispose();
  await rejection;
  assert.equal(workers[0].terminated, true);
  assert.deepEqual(revoked, [created[0]]);
  ack = true;
  await manager.search(2, "x", "g", nodes);
  assert.equal(created.length, 2);
  manager.dispose();
});

test("a stale worker callback cannot settle a newer task or clear its timeout", async () => {
  const { manager, workers } = fixture({ onPost() {} });
  const first = manager.search(1, "x", "g", nodes);
  const rejection = assert.rejects(first, { code: "search-cancelled" });
  await tick();
  const staleCallback = workers[0].onmessage;
  const second = manager.search(2, "x", "g", nodes);
  await rejection;
  await tick();
  staleCallback({ data: { type: "complete", taskId: 1, matches: [] } });
  assert.equal(workers[1].terminated, false);
  workers[1].respond({ type: "complete", taskId: 2, matches: [], limited: false });
  await second;
  manager.dispose();
});

test("both search APIs split by character and node count and await each ACK", async () => {
  for (const streaming of [false, true]) {
    const { manager, workers } = fixture();
    manager.updateConfig({ maxBatchChars: 5, batchSize: 2 });
    const input = [{ id: 0, text: "aaaa" }, { id: 1, text: "bbbb" }, { id: 2, text: "c" }, { id: 3, text: "d" }, { id: 4, text: "e" }];
    if (streaming) await manager.searchStream(1, "z", "g", async send => assert.equal(await send(input), 5));
    else await manager.search(1, "z", "g", input);
    const batches = workers[0].messages.filter(message => message.type === "chunks");
    assert.deepEqual(batches.map(message => message.chunks.map(chunk => chunk.text)), [["aaaa"], ["bbbb", "c"], ["d", "e"]]);
    assert.deepEqual(batches.map(message => message.batchId), [1, 2, 3]);
    manager.dispose();
  }
});

test("worker backpressure permits only one outstanding batch", async () => {
  const { manager, workers } = fixture({ onPost(worker, message) {
    if (message.type === "finish") queueMicrotask(() => worker.respond({ type: "complete", taskId: message.taskId, matches: [], limited: false }));
  } });
  manager.updateConfig({ batchSize: 1 });
  const result = manager.search(1, "z", "g", [{ id: 0, text: "a" }, { id: 1, text: "b" }]);
  await tick();
  const worker = workers[0];
  assert.equal(worker.messages.filter(message => message.type === "chunks").length, 1);
  worker.respond({ type: "ack", taskId: 1, batchId: 999 });
  await tick();
  assert.equal(worker.messages.filter(message => message.type === "chunks").length, 1);
  worker.respond({ type: "ack", taskId: 1, batchId: 1 });
  await tick();
  assert.equal(worker.messages.filter(message => message.type === "chunks").length, 2);
  worker.respond({ type: "ack", taskId: 1, batchId: 2 });
  await result;
  manager.dispose();
});

test("early completion releases ACK wait and stops later streamed batches", async () => {
  const { manager, workers } = fixture({ onPost(worker, message) {
    if (message.type === "chunks") queueMicrotask(() => worker.respond({ type: "complete", taskId: message.taskId, matches: [{ chunkId: 0, start: 0, end: 1 }], limited: true }));
  } });
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  let sentAgain;
  const result = await manager.searchStream(10, "a", "g", async (send, keepGoing) => {
    assert.equal(await send([{ id: 0, text: "a" }]), 1);
    assert.equal(keepGoing(), false);
    sentAgain = await send([{ id: 1, text: "b" }]);
    finish();
  });
  await done;
  assert.equal(result.limited, true);
  assert.equal(sentAgain, 0);
  assert.equal(workers[0].messages.filter(message => message.type === "chunks").length, 1);
  manager.dispose();
});

test("the total scan budget is independent from removed per-node limits", async () => {
  const { manager, workers } = fixture();
  manager.updateConfig({ maxNodeChars: 4, maxScannedChars: 5 });
  const result = await manager.search(1, "x$", "g", [{ id: 0, text: "xxxxx" }, { id: 1, text: "abc" }, { id: 2, text: "de" }, { id: 3, text: "f" }]);
  assert.deepEqual(workers[0].messages.filter(message => message.type === "chunks").flatMap(message => message.chunks).map(chunk => chunk.text), ["xxxxx"]);
  assert.equal(result.limited, true);
  assert.equal(result.limitReason, "max-scanned-chars");
  manager.dispose();
});

test("physical windows stay bounded without treating overlap as scanned text or extra logical nodes", async () => {
  const input = [
    { id: 0, text: "abcdef", stream: { runId: 0, offset: 0, ownedStart: 0, ownedEnd: 2, first: true, last: true } },
    { id: 1, text: "abcdef", stream: { runId: 0, offset: 0, ownedStart: 2, ownedEnd: 4, first: false, last: true } },
    { id: 2, text: "cdef", stream: { runId: 0, offset: 2, ownedStart: 4, ownedEnd: 6, first: false, last: true } }
  ];
  for (const extra of [false, true]) {
    const h = fixture();
    h.manager.updateConfig({ maxScannedChars: 100, maxScannedNodes: 1, maxNodeChars: 1, maxChunkMs: 1 });
    const supplied = extra ? [...input, { id: 3, text: "next logical node" }] : input;
    const result = await h.manager.search(1, "cde", "g", supplied, { mode: "literal" });
    assert.deepEqual(h.workers[0].messages.filter(message => message.type === "chunks").flatMap(message => message.chunks), supplied);
    assert.equal(result.limited, false);
    assert.equal(result.limitReason, null);
    assert.equal("maxScannedNodes" in h.workers[0].messages[0], false);
    h.manager.dispose();
  }
  const h = fixture();
  h.manager.updateConfig({ maxScannedChars: 4, maxScannedNodes: 1 });
  const window = { ...input[0], stream: { ...input[0].stream, ownedEnd: 4 } };
  const result = await h.manager.searchStream(1, "cde", "g", async send => {
    assert.equal(await send([window]), 1);
    return { limitReason: "max-scanned-chars" };
  }, { mode: "literal" });
  assert.deepEqual(h.workers[0].messages.find(message => message.type === "chunks").chunks, [window]);
  assert.equal(result.limitReason, "max-scanned-chars");
  h.manager.dispose();
});

test("old cumulative node limits are ignored while reported node counts remain validated", async () => {
  let scannedNodes = 0;
  const h = fixture({ onPost(worker, message) {
    if (message.type === "chunks") queueMicrotask(() => {
      scannedNodes += message.chunks.length;
      worker.respond({ type: "ack", taskId: message.taskId, batchId: message.batchId,
        scannedNodes, matchedChunkIds: [], matchedIntervals: [] });
    });
    if (message.type === "finish") queueMicrotask(() => worker.respond({ type: "complete", taskId: message.taskId,
      matches: [], totalMatches: 0, scannedNodes, limited: false, limitReason: null }));
  } });
  h.manager.updateConfig({ maxScannedNodes: 1, batchSize: 2 });
  const supplied = [{ id: 0, text: "a" }, { id: 1, text: "" }, { id: 2, text: "b" }, { id: 3, text: "" }, { id: 4, text: "c" }];
  const result = await h.manager.search(1, "z", "g", supplied);
  assert.equal(result.scannedNodes, supplied.length);
  assert.equal(result.limited, false);
  assert.equal("maxScannedNodes" in h.workers[0].messages[0], false);
  assert.deepEqual(h.workers[0].messages.filter(message => message.type === "chunks").flatMap(message => message.chunks), supplied);
  h.manager.dispose();
});

test("oversized physical windows fail as invalid transport rather than a logical scan limit", async () => {
  const h = fixture();
  await assert.rejects(h.manager.search(1, "x", "g", [{ id: 0, text: "x".repeat(16 * 1024 * 1024 + 1) }]),
    { code: "worker-protocol-error", numericCode: 530 });
  assert.equal(h.workers[0].messages.some(message => message.type === "chunks"), false);
  assert.equal(h.workers[0].terminated, true);
  await h.manager.search(2, "x", "g", nodes);
  h.manager.dispose();
});

test("startup subtracts from the supplied deadline and one remaining millisecond is accepted", async () => {
  let clock = 0;
  const h = fixture({ clock: () => clock, fetch: async () => {
    clock = 30;
    return { text: async () => "// worker" };
  } });
  h.manager.updateConfig({ workerTimeoutMs: 50 });
  await h.manager.search(1, "x", "g", nodes);
  assert.equal(h.workers[0].messages[0].workerTimeoutMs, 20);
  h.manager.updateConfig({ workerTimeoutMs: 1 });
  await h.manager.search(2, "x", "g", nodes);
  assert.equal(h.workers[1].messages[0].workerTimeoutMs, 1);
  h.manager.dispose();
});

test("startup and late replies cannot extend a deadline while its timer callback is delayed", async () => {
  for (const type of ["ack", "complete"]) {
    let clock = 0;
    const h = fixture({ clock: () => clock, onPost() {} });
    h.manager.updateConfig({ workerTimeoutMs: 100000 });
    const result = h.manager.search(1, "x", "g", nodes);
    const rejected = assert.rejects(result, { code: "search-timeout", numericCode: 504 });
    await tick();
    assert.equal(h.workers[0].terminated, false);
    clock = 100001;
    h.workers[0].respond({ type, taskId: 1, batchId: 1, matches: [], matchedChunkIds: [], matchedIntervals: [] });
    await rejected;
    assert.equal(h.workers[0].terminated, true);
    h.manager.dispose();
  }
  let clock = 0;
  const h = fixture({ clock: () => clock, fetch: async () => {
    clock = 100001;
    return { text: async () => "// worker" };
  } });
  h.manager.updateConfig({ workerTimeoutMs: 100000 });
  await assert.rejects(h.manager.search(1, "x", "g", nodes), { code: "search-timeout", numericCode: 504 });
  assert.equal(h.workers.length, 0);
  h.manager.dispose();
});

test("missing ACK times out, terminates the worker, and the manager recovers", async () => {
  let acknowledge = false;
  const { manager, workers } = fixture({ onPost(worker, message) {
    if (message.type === "chunks" && acknowledge) queueMicrotask(() => worker.respond({ type: "ack", taskId: message.taskId, batchId: message.batchId }));
    if (message.type === "finish") queueMicrotask(() => worker.respond({ type: "complete", taskId: message.taskId, matches: [], limited: false }));
  } });
  manager.updateConfig({ workerTimeoutMs: 20 });
  await assert.rejects(manager.search(1, "x", "g", nodes), { numericCode: 504 });
  assert.equal(workers[0].terminated, true);
  acknowledge = true;
  await manager.search(2, "x", "g", nodes);
  manager.dispose();
});

test("timeout covers stalled fetch and synchronous source creation failures", async () => {
  let fetchCount = 0;
  const { manager, workers, fetches } = fixture({ fetch: () => ++fetchCount === 1 ? new Promise(() => {}) : Promise.resolve({ text: async () => "// worker" }) });
  manager.updateConfig({ workerTimeoutMs: 15 });
  await assert.rejects(manager.search(1, "x", "g", nodes), { numericCode: 504 });
  assert.equal(workers.length, 0);
  assert.equal(fetches[0][1].signal.aborted, true);
  await manager.search(2, "x", "g", nodes);
  assert.equal(workers.length, 1);
  manager.dispose();
  const broken = fixture({ fetch: async () => ({ ok: false, status: 404 }) });
  await assert.rejects(broken.manager.search(1, "x", "g", nodes), { numericCode: 531 });
  broken.manager.dispose();
});

test("transport factory startup receives cancellation and late transports are terminated", async () => {
  const ready = deferred();
  let signal;
  const transport = { create(options) { signal = options.signal; return ready.promise; } };
  const { manager, fetches } = fixture({ transport });
  const result = manager.search(1, "x", "g", nodes);
  const rejection = assert.rejects(result, { code: "search-cancelled" });
  await tick();
  manager.cancel(1);
  await rejection;
  assert.equal(signal.aborted, true);
  const late = { terminate() { this.terminated = true; } };
  ready.resolve(late);
  await tick();
  assert.equal(late.terminated, true);
  assert.equal(fetches.length, 0);
  manager.dispose();
});

test("transport timeout codes are preserved and unexpected crashes report 503", async () => {
  for (const cause of [null, { code: "search-timeout", numericCode: 504, message: "ACK timed out" }]) {
    const { manager, workers } = fixture({ onPost() {} });
    const result = manager.search(1, "x", "g", nodes);
    const rejection = assert.rejects(result, { numericCode: cause ? 504 : 503 });
    await tick();
    workers[0].onerror({ message: "worker failed", error: cause });
    await rejection;
    assert.equal(workers[0].terminated, true);
    manager.dispose();
  }
});

test("unavailable extension transport uses Blob fallback while available transport failures stay visible", async () => {
  const unavailable = fixture({ transport: {
    isAvailable: () => false,
    create() { throw new Error("unavailable transport must not be invoked"); }
  } });
  await unavailable.manager.search(1, "x", "g", nodes);
  assert.equal(unavailable.fetches.length, 4);
  assert.equal(unavailable.workers.length, 1);
  unavailable.manager.dispose();

  const failed = fixture({ transport: {
    isAvailable: () => true,
    create: async () => { throw { code: "worker-spawn-failed", numericCode: 531, message: "Host disconnected" }; }
  } });
  await assert.rejects(failed.manager.search(1, "x", "g", nodes), { numericCode: 531 });
  assert.equal(failed.fetches.length, 0);
  assert.equal(failed.workers.length, 0);
  failed.manager.dispose();
});

test("stream match IDs aggregate split batches while numeric sendBatch API stays intact", async () => {
  const { manager } = fixture({ onPost(worker, message) {
    if (message.type === "chunks") queueMicrotask(() => worker.respond({
      type: "ack", taskId: message.taskId, batchId: message.batchId,
      matchedChunkIds: message.chunks.filter(chunk => chunk.id === 1 || chunk.id === 4).map(chunk => chunk.id)
    }));
    if (message.type === "finish") queueMicrotask(() => worker.respond({ type: "complete", taskId: message.taskId, matches: [], limited: false }));
  } });
  manager.updateConfig({ batchSize: 2 });
  let ids;
  await manager.searchStream(1, "x", "g", async (send, keepGoing, getLastBatchMatchedIds) => {
    assert.equal(await send(Array.from({ length: 5 }, (_, id) => ({ id, text: "text" }))), 5);
    ids = getLastBatchMatchedIds();
    assert.deepEqual(ids, [1, 4]);
    ids.push(999);
    assert.deepEqual(getLastBatchMatchedIds(), [1, 4]);
    assert.equal(keepGoing(), true);
    assert.equal(await send([{ id: 5, text: "nothing" }]), 1);
    assert.deepEqual(getLastBatchMatchedIds(), []);
  });
  manager.dispose();
});

test("legacy ACKs without match IDs report null so callers can preserve all entries", async () => {
  const { manager } = fixture();
  let ids, matches;
  await manager.searchStream(1, "x", "g", async (send, keepGoing, getLastBatchMatchedIds, getLastBatchMatches) => {
    await send(nodes);
    ids = getLastBatchMatchedIds();
    matches = getLastBatchMatches();
  });
  assert.equal(ids, null);
  assert.equal(matches, null);
  manager.dispose();
});

test("ACK intervals aggregate across split batches and producers receive independent snapshots", async () => {
  const matches = [];
  const h = fixture({ onPost(worker, message) {
    if (message.type === "chunks") queueMicrotask(() => {
      const batch = message.chunks.filter(chunk => chunk.id < 2).map(chunk => ({ chunkId: chunk.id, start: 1, end: 2 }));
      matches.push(...batch);
      worker.respond({ type: "ack", taskId: message.taskId, batchId: message.batchId,
        matchedChunkIds: batch.map(match => match.chunkId), matchedIntervals: batch });
    });
    if (message.type === "finish") queueMicrotask(() => worker.respond({ type: "complete", taskId: message.taskId, matches, totalMatches: matches.length }));
  } });
  h.manager.updateConfig({ batchSize: 1 });
  await h.manager.searchStream(1, "x", "g", async (send, keepGoing, getIds, getMatches) => {
    await send([{ id: 0, text: "axa" }, { id: 1, text: "bxb" }]);
    assert.deepEqual(getMatches(), [{ chunkId: 0, start: 1, end: 2 }, { chunkId: 1, start: 1, end: 2 }]);
    const copy = getMatches();
    copy[0].start = 100; copy.push({ chunkId: 999, start: 0, end: 1 });
    assert.deepEqual(getMatches(), matches);
    await send([{ id: 2, text: "none" }]);
    assert.deepEqual(getMatches(), []);
    assert.deepEqual(getIds(), []);
    assert.equal(keepGoing(), true);
  });
  h.manager.dispose();
});

test("invalid ACK match intervals stop production and release the Worker", async () => {
  const good = { chunkId: 0, start: 0, end: 1 };
  for (const intervals of [null, {}, [null], [{ ...good, chunkId: 1 }], [{ ...good, start: "0" }],
    [{ ...good, start: -1 }], [{ ...good, end: 0 }], [{ ...good, end: 3 }], [good, good], []]) {
    let resumed = false;
    const h = fixture({ onPost(worker, message) {
      if (message.type === "chunks") queueMicrotask(() => worker.respond({ type: "ack", taskId: message.taskId,
        batchId: message.batchId, matchedChunkIds: [0], matchedIntervals: intervals }));
    } });
    await assert.rejects(h.manager.searchStream(1, "x", "g", async send => { await send([{ id: 0, text: "xx" }]); resumed = true; }),
      { code: "worker-protocol-error", numericCode: 530 });
    assert.equal(h.workers[0].terminated, true);
    await tick();
    // The ACK wait is released for cleanup, but cannot transmit another batch.
    assert.equal(resumed, true);
    h.manager.dispose();
  }
});

test("confirmed intervals reject changed or missing terminal matches", async () => {
  for (const finalMatches of [[], [{ chunkId: 0, start: 0, end: 2 }]]) {
    const h = fixture({ onPost(worker, message) {
      if (message.type === "chunks") queueMicrotask(() => worker.respond({ type: "ack", taskId: message.taskId,
        batchId: message.batchId, matchedChunkIds: [0], matchedIntervals: [{ chunkId: 0, start: 0, end: 1 }] }));
      if (message.type === "finish") queueMicrotask(() => worker.respond({ type: "complete", taskId: message.taskId, matches: finalMatches }));
    } });
    await assert.rejects(h.manager.search(1, "x", "g", [{ id: 0, text: "xx" }]), { code: "worker-protocol-error" });
    assert.equal(h.workers[0].terminated, true);
    h.manager.dispose();
  }
});

test("malformed ACK scan statistics and stop flags fail before the batch is accepted", async () => {
  for (const malformed of [{ scannedChars: "1" }, { scannedChars: 2 }, { scannedNodes: 2 }, { limited: "true" },
    { stopped: 1 }, { limitReason: "unknown" }]) {
    const h = fixture({ onPost(worker, message) {
      if (message.type === "chunks") queueMicrotask(() => worker.respond({ type: "ack", taskId: message.taskId,
        batchId: message.batchId, matchedChunkIds: [], matchedIntervals: [], ...malformed }));
    } });
    await assert.rejects(h.manager.search(1, "x", "g", [{ id: 0, text: "x" }]), { code: "worker-protocol-error" });
    assert.equal(h.workers[0].terminated, true);
    h.manager.dispose();
  }
});

test("ACK intervals cannot report duplicated hits from the preceding overlap", async () => {
  const h = fixture({ onPost(worker, message) {
    if (message.type === "chunks") queueMicrotask(() => {
      const id = message.chunks[0].id;
      worker.respond({ type: "ack", taskId: message.taskId, batchId: message.batchId,
        matchedChunkIds: id === 1 ? [1] : [], matchedIntervals: id === 1 ? [{ chunkId: 1, start: 0, end: 1 }] : [] });
    });
  } });
  h.manager.updateConfig({ batchSize: 1 });
  await assert.rejects(h.manager.search(1, "x", "g", [
    { id: 0, text: "xxxx", stream: { runId: 0, offset: 0, ownedStart: 0, ownedEnd: 2, first: true, last: false } },
    { id: 1, text: "xxxx", stream: { runId: 0, offset: 0, ownedStart: 2, ownedEnd: 4, first: false, last: true } }
  ], { mode: "literal" }), { code: "worker-protocol-error" });
  h.manager.dispose();
});

test("ACK match counts stay bounded while total matching text is not truncated", async () => {
  for (const config of [{ maxMatches: 1 }, { maxMatches: 10 }]) {
    const text = "x".repeat(config.maxMatches === 1 ? 2 : 16 * 1024 * 1024);
    const matches = [];
    const h = fixture({ onPost(worker, message) {
      if (message.type === "chunks") queueMicrotask(() => {
        const batch = message.chunks.map(chunk => ({ chunkId: chunk.id, start: 0, end: chunk.text.length }));
        matches.push(...batch);
        worker.respond({ type: "ack", taskId: message.taskId,
        batchId: message.batchId, matchedChunkIds: message.chunks.map(chunk => chunk.id),
        matchedIntervals: batch });
      });
      if (message.type === "finish") queueMicrotask(() => worker.respond({ type: "complete", taskId: message.taskId, matches, totalMatches: matches.length }));
    } });
    h.manager.updateConfig({ ...config, batchSize: 1 });
    const searching = h.manager.search(1, "x", "g", [{ id: 0, text }, { id: 1, text }, { id: 2, text }]);
    if (config.maxMatches === 1) await assert.rejects(searching, { code: "worker-protocol-error" });
    else assert.equal((await searching).matches.reduce((sum, match) => sum + match.end - match.start, 0), 48 * 1024 * 1024);
    assert.equal(h.workers[0].terminated, true);
    h.manager.dispose();
  }
});

test("overlapping windows keep their stream metadata and count only owned scan characters", async () => {
  const h = fixture();
  h.manager.updateConfig({ maxScannedChars: 14, maxBatchChars: 14 });
  const first = { id: 0, text: "abcdefgh", stream: { runId: 7, offset: 0, ownedStart: 0, ownedEnd: 6, first: true, last: false } };
  const second = { id: 1, text: "efghijklmn", stream: { runId: 7, offset: 4, ownedStart: 6, ownedEnd: 14, first: false, last: true } };
  await h.manager.search(1, "x", "g", [first, second], { mode: "literal" });
  const sent = h.workers[0].messages.filter(message => message.type === "chunks").flatMap(message => message.chunks);
  assert.deepEqual(sent, [first, second]);
  assert.notEqual(sent[0].stream, first.stream);
  assert.equal(h.workers[0].messages.at(-1).limitReason, null);
  h.manager.dispose();
});

test("invalid or discontinuous stream metadata cannot reach the Worker", async () => {
  const good = { runId: 0, offset: 0, ownedStart: 0, ownedEnd: 2, first: true, last: false };
  const invalid = [null, { ...good, first: "true" }, { ...good, offset: 1 }, { ...good, ownedEnd: 3 },
    { ...good, runId: -1 }, { ...good, first: false }];
  for (const stream of invalid) {
    const h = fixture();
    await assert.rejects(h.manager.search(1, "x", "g", [{ id: 0, text: "xx", stream }]), { code: "worker-protocol-error" });
    assert.equal(h.workers[0].messages.some(message => message.type === "chunks"), false);
    h.manager.dispose();
  }
  const h = fixture();
  await assert.rejects(h.manager.search(1, "x", "g", [{ id: 0, text: "xx", stream: good },
    { id: 1, text: "xx", stream: { runId: 0, offset: 0, ownedStart: 1, ownedEnd: 2, first: false, last: true } }]),
  { code: "worker-protocol-error" });
  h.manager.dispose();
});

test("tail-context windows keep the run open until all owned characters are consumed", async () => {
  const first = { id: 0, text: "abcdef", stream: { runId: 0, offset: 0, ownedStart: 0, ownedEnd: 4, first: true, last: true } };
  const second = { id: 1, text: "cdef", stream: { runId: 0, offset: 2, ownedStart: 4, ownedEnd: 6, first: false, last: true } };
  const h = fixture();
  const following = { id: 2, text: "another run" };
  await h.manager.search(1, "x", "g", [first, second, following], { mode: "literal" });
  assert.deepEqual(h.workers[0].messages.find(message => message.type === "chunks").chunks, [first, second, following]);
  h.manager.dispose();
  for (const final of [{ ...second, text: "cdefg", stream: { ...second.stream, ownedEnd: 7 } },
    { ...second, text: "cdefg", stream: { ...second.stream, last: false } },
    { ...second, stream: { ...second.stream, ownedStart: 3 } }]) {
    const invalid = fixture();
    await assert.rejects(invalid.manager.search(1, "x", "g", [first, final], { mode: "literal" }), { code: "worker-protocol-error" });
    assert.equal(invalid.workers[0].terminated, true);
    invalid.manager.dispose();
  }
});

test("logical runs may pause for annotations without an arbitrary active-run count", async () => {
  const h = fixture();
  const input = [
    { id: 0, text: "xxxxxy", stream: { runId: 0, offset: 0, ownedStart: 0, ownedEnd: 2, first: true, last: false } },
    { id: 1, text: "reading", stream: { runId: 1, offset: 0, ownedStart: 0, ownedEnd: 7, first: true, last: true } },
    { id: 2, text: "xxxxxy", stream: { runId: 0, offset: 0, ownedStart: 2, ownedEnd: 6, first: false, last: true } }
  ];
  await h.manager.search(1, "xy", "g", input, { mode: "literal" });
  assert.deepEqual(h.workers[0].messages.find(message => message.type === "chunks").chunks, input);
  h.manager.dispose();
  const many = fixture();
  const streams = Array.from({ length: 129 }, (_, id) => ({ id, text: "xxxxx", stream: {
    runId: id, offset: 0, ownedStart: 0, ownedEnd: 1, first: true, last: false
  } }));
  const tails = Array.from({ length: 129 }, (_, runId) => ({ id: 129 + runId, text: "xxxxx", stream: {
    runId, offset: 0, ownedStart: 1, ownedEnd: 5, first: false, last: true
  } }));
  await many.manager.search(1, "x", "g", [...streams, ...tails], { mode: "literal" });
  assert.equal(many.workers[0].messages.filter(message => message.type === "chunks").flatMap(message => message.chunks).length, 258);
  await many.manager.search(2, "x", "g", nodes);
  many.manager.dispose();
});

test("source chunk IDs must strictly increase within a batch and between awaited sends", async () => {
  for (const input of [[{ id: 42, text: "a" }, { id: 42, text: "b" }], [{ id: 42, text: "a" }, { id: 41, text: "b" }]]) {
    for (const split of [false, true]) {
      const h = fixture();
      await assert.rejects(h.manager.searchStream(1, "x", "g", async send => {
        if (split) { await send([input[0]]); await send([input[1]]); }
        else await send(input);
      }), { code: "worker-protocol-error" });
      assert.equal(h.workers[0].terminated, true);
      h.manager.dispose();
    }
  }
  const h = fixture();
  await h.manager.search(1, "x", "g", [{ id: 42, text: "a" }, { id: 50, text: "b" }]);
  h.manager.dispose();
});

test("assembled-source ACKs use complete logical ranges and report completion even without matches", async () => {
  const matches = [], piece = "x".repeat(16 * 1024 * 1024), total = 34 * 1024 * 1024;
  const h = fixture({ onPost(worker, message) {
    if (message.type === "chunks") queueMicrotask(() => {
      const completedSourceIds = message.chunks.filter(chunk => chunk.source.last).map(chunk => chunk.source.runId);
      const intervals = message.chunks.filter(chunk => chunk.source.last && chunk.source.runId === 42)
        .map(chunk => ({ chunkId: chunk.source.runId, start: 0, end: chunk.source.offset + chunk.text.length }));
      matches.push(...intervals);
      worker.respond({ type: "ack", taskId: message.taskId, batchId: message.batchId, completedSourceIds,
        matchedChunkIds: intervals.map(match => match.chunkId), matchedIntervals: intervals });
    });
    if (message.type === "finish") queueMicrotask(() => worker.respond({ type: "complete", taskId: message.taskId,
      matches, totalMatches: matches.length, completedSourceIds: [45] }));
  } });
  await h.manager.searchStream(1, ".+", "g", async (send, keepGoing, getIds, getMatches, getCompleted) => {
    await send([{ id: 42, text: piece, source: { runId: 42, offset: 0, first: true, last: false } }]);
    assert.deepEqual(getCompleted(), []);
    assert.deepEqual(getMatches(), []);
    await send([{ id: 43, text: piece, source: { runId: 42, offset: piece.length, first: false, last: false } },
      { id: 44, text: "x".repeat(2 * 1024 * 1024), source: { runId: 42, offset: piece.length * 2, first: false, last: true } }]);
    assert.deepEqual(getIds(), [42]);
    assert.deepEqual(getMatches(), [{ chunkId: 42, start: 0, end: total }]);
    assert.deepEqual(getCompleted(), [42]);
    const copy = getCompleted(); copy.push(999);
    assert.deepEqual(getCompleted(), [42]);
    await send([{ id: 45, text: "none", source: { runId: 45, offset: 0, first: true, last: true } }]);
    assert.deepEqual(getIds(), []);
    assert.deepEqual(getCompleted(), [45]);
    assert.equal(keepGoing(), true);
  });
  h.manager.dispose();
});

test("invalid source shapes, mixed source types and discontinuous offsets are rejected", async () => {
  const good = { runId: 0, offset: 0, first: true, last: true };
  for (const source of [null, [], { ...good, runId: "0" }, { ...good, runId: 1 }, { ...good, offset: 1 },
    { ...good, first: "true" }, { ...good, first: false }, { ...good, offset: Number.MAX_SAFE_INTEGER }]) {
    const h = fixture();
    await assert.rejects(h.manager.search(1, ".", "g", [{ id: 0, text: "ab", source }]), { code: "worker-protocol-error" });
    assert.equal(h.workers[0].terminated, true);
    h.manager.dispose();
  }
  for (const input of [
    [{ id: 0, text: "", source: { ...good, last: false } }],
    [{ id: 0, text: "ab", source: good, stream: { runId: 0, offset: 0, ownedStart: 0, ownedEnd: 2, first: true, last: true } }],
    [{ id: 0, text: "ab", source: { ...good, last: false } }, { id: 1, text: "c", source: { runId: 0, offset: 1, first: false, last: true } }]
  ]) {
    const h = fixture();
    await assert.rejects(h.manager.search(1, ".", "g", input), { code: "worker-protocol-error" });
    h.manager.dispose();
  }
});

test("source ACKs cannot fake EOF, skip unfinished EOF or match an uncompleted source", async () => {
  for (const ack of [
    { completedSourceIds: undefined }, { completedSourceIds: null }, { completedSourceIds: [1] },
    { completedSourceIds: [0, 0] }, { completedSourceIds: [], limited: true, stopped: false },
    { completedSourceIds: [], stopped: true, matchedChunkIds: [0], matchedIntervals: [{ chunkId: 0, start: 0, end: 1 }] },
    { completedSourceIds: [0], matchedChunkIds: [0], matchedIntervals: [{ chunkId: 0, start: 0, end: 4 }] }
  ]) {
    const h = fixture({ onPost(worker, message) {
      if (message.type === "chunks") queueMicrotask(() => worker.respond({ type: "ack", taskId: message.taskId,
        batchId: message.batchId, matchedChunkIds: [], matchedIntervals: [], ...ack }));
    } });
    await assert.rejects(h.manager.search(1, ".", "g", [{ id: 0, text: "abc", source: { runId: 0, offset: 0, first: true, last: true } }]),
      { code: "worker-protocol-error" });
    h.manager.dispose();
  }
  const h = fixture({ onPost(worker, message) {
    if (message.type === "chunks") queueMicrotask(() => worker.respond({ type: "ack", taskId: message.taskId,
      batchId: message.batchId, matchedChunkIds: [], matchedIntervals: [], completedSourceIds: [0] }));
  } });
  await assert.rejects(h.manager.search(1, ".", "g", [{ id: 0, text: "abc", source: { runId: 0, offset: 0, first: true, last: false } }]),
    { code: "worker-protocol-error" });
  h.manager.dispose();
});

test("complete before an EOF ACK preserves the logical interval and completed-source getter", async () => {
  const h = fixture({ onPost(worker, message) {
    if (message.type === "chunks") queueMicrotask(() => {
      if (message.chunks[0].source.last) worker.respond({ type: "complete", taskId: message.taskId,
        matches: [{ chunkId: 4, start: 0, end: 3 }], totalMatches: 1, completedSourceIds: [4] });
      else worker.respond({ type: "ack", taskId: message.taskId, batchId: message.batchId,
        matchedChunkIds: [], matchedIntervals: [], completedSourceIds: [] });
    });
  } });
  let completed, intervals, finish;
  const producerDone = new Promise(resolve => { finish = resolve; });
  const result = await h.manager.searchStream(1, ".+", "g", async (send, keepGoing, getIds, getMatches, getCompleted) => {
    await send([{ id: 4, text: "a", source: { runId: 4, offset: 0, first: true, last: false } }]);
    await send([{ id: 5, text: "bc", source: { runId: 4, offset: 1, first: false, last: true } }]);
    completed = getCompleted(); intervals = getMatches();
    assert.equal(keepGoing(), false);
    finish();
  });
  await producerDone;
  assert.deepEqual(completed, [4]);
  assert.deepEqual(intervals, result.matches);
  h.manager.dispose();
});

test("native source tasks cannot lose their length proofs by mixing legacy acknowledgements", async () => {
  for (const terminal of [false, true]) {
    const h = fixture({ onPost(worker, message) {
      if (message.type === "chunks") queueMicrotask(() => {
        if (!message.chunks[0].source) worker.respond({ type: "ack", taskId: message.taskId, batchId: message.batchId });
        else if (terminal) worker.respond({ type: "complete", taskId: message.taskId,
          matches: [{ chunkId: 1, start: 0, end: 2 }], completedSourceIds: [1] });
        else worker.respond({ type: "ack", taskId: message.taskId, batchId: message.batchId,
          matchedChunkIds: [1], matchedIntervals: [{ chunkId: 1, start: 0, end: 2 }], completedSourceIds: [1] });
      });
    } });
    await assert.rejects(h.manager.searchStream(1, ".+", "g", async send => {
      await send([{ id: 0, text: "legacy" }]);
      await send([{ id: 1, text: "ab", source: { runId: 1, offset: 0, first: true, last: true } }]);
    }), { code: "worker-protocol-error" });
    h.manager.dispose();
  }
});

test("producer scan limits survive completion while unrecognized limits are rejected", async () => {
  for (const limitReason of ["collection-budget", "max-scanned-chars"]) {
    const h = fixture();
    const result = await h.manager.searchStream(1, "x", "g", async send => { await send(nodes); return { limitReason }; });
    assert.equal(result.limited, true);
    assert.equal(result.limitReason, limitReason);
    assert.equal(h.workers[0].messages.at(-1).limitReason, limitReason);
    h.manager.dispose();
  }
  for (const limitReason of ["unknown", {}, "max-matches", "max-node-chars", "max-chunk-ms", "max-scanned-nodes", "max-retained-chars", "max-retained-segments", "max-retained-control-chars"]) {
    const h = fixture();
    await assert.rejects(h.manager.searchStream(1, "x", "g", () => ({ limitReason })), { code: "worker-protocol-error" });
    assert.equal(h.workers[0].terminated, true);
    h.manager.dispose();
  }
});

test("invalid ACK matched IDs are rejected before the producer continues", async () => {
  for (const ids of [null, {}, "0", ["0"], [-1], [1], [0, 0], [0, 1], Array(1)]) {
    const { manager, workers } = fixture({ onPost(worker, message) {
      if (message.type === "chunks") queueMicrotask(() => worker.respond({ type: "ack", taskId: message.taskId, batchId: message.batchId, matchedChunkIds: ids }));
    } });
    await assert.rejects(manager.search(1, "x", "g", [{ id: 0, text: "x" }]), { code: "worker-protocol-error", numericCode: 530 });
    assert.equal(workers[0].terminated, true);
    manager.dispose();
  }
});

test("early complete without ACK preserves pending batch's final matching IDs", async () => {
  const { manager } = fixture({ onPost(worker, message) {
    if (message.type === "chunks") queueMicrotask(() => worker.respond({ type: "complete", taskId: message.taskId,
      matches: [{ chunkId: 3, start: 0, end: 1 }], limited: true }));
  } });
  let ids, intervals, finishProducer;
  const producerDone = new Promise(resolve => { finishProducer = resolve; });
  await manager.searchStream(1, "x", "g", async (send, keepGoing, getLastBatchMatchedIds, getLastBatchMatches) => {
    assert.equal(await send([{ id: 2, text: "none" }, { id: 3, text: "x" }]), 2);
    ids = getLastBatchMatchedIds();
    intervals = getLastBatchMatches();
    assert.equal(keepGoing(), false);
    finishProducer();
  });
  await producerDone;
  assert.deepEqual(ids, [3]);
  assert.deepEqual(intervals, [{ chunkId: 3, start: 0, end: 1 }]);
  manager.dispose();
});

test("ACK and complete in the same delivery turn preserve the last batch IDs", async () => {
  const { manager } = fixture({ onPost(worker, message) {
    if (message.type === "chunks") queueMicrotask(() => {
      worker.respond({ type: "ack", taskId: message.taskId, batchId: message.batchId, matchedChunkIds: [0], stopped: true });
      worker.respond({ type: "complete", taskId: message.taskId, matches: [{ chunkId: 0, start: 0, end: 1 }], limited: true });
    });
  } });
  let ids, finishProducer;
  const producerDone = new Promise(resolve => { finishProducer = resolve; });
  await manager.searchStream(1, "x", "g", async (send, keepGoing, getLastBatchMatchedIds) => {
    await send([{ id: 0, text: "x" }, { id: 1, text: "none" }]);
    ids = getLastBatchMatchedIds();
    assert.equal(keepGoing(), false);
    finishProducer();
  });
  await producerDone;
  assert.deepEqual(ids, [0]);
  manager.dispose();
});

test("malformed completion rejects promptly and terminates the worker instead of reaching rendering", async () => {
  const invalid = [
    { matches: null }, { matches: {} }, { matches: [null] },
    { matches: [{ chunkId: "0", start: 0, end: 1 }] },
    { matches: [{ chunkId: 0, start: 0.5, end: 1 }] },
    { matches: [{ chunkId: 0, start: 1, end: 1 }] },
    { matches: [{ chunkId: 0, start: -1, end: 1 }] },
    { matches: [{ chunkId: 0, start: 0, end: 2 }] },
    { matches: [{ chunkId: 99, start: 0, end: 1 }] },
    { totalMatches: 1 }, { scannedChars: 2 }, { scannedNodes: 2 },
    { limited: "false" }, { engine: {} }, { limitReason: "unknown" }
  ];
  for (const malformed of invalid) {
    const { manager, workers } = fixture({ onPost(worker, message) {
      if (message.type === "chunks") queueMicrotask(() => worker.respond({ type: "complete", taskId: message.taskId,
        matches: [], totalMatches: 0, scannedChars: 1, scannedNodes: 1, limited: false, ...malformed }));
    } });
    await assert.rejects(manager.search(1, "x", "g", [{ id: 0, text: "x" }]), { code: "worker-protocol-error", numericCode: 530 }, JSON.stringify(malformed));
    assert.equal(workers[0].terminated, true);
    manager.dispose();
  }
});

test("completion validates prior matched blocks after pruning unmatched ACK metadata", async () => {
  const { manager } = fixture({ onPost(worker, message) {
    if (message.type === "chunks") queueMicrotask(() => worker.respond({ type: "ack", taskId: message.taskId,
      batchId: message.batchId, matchedChunkIds: message.chunks.filter(chunk => chunk.id === 7).map(chunk => chunk.id) }));
    if (message.type === "finish") queueMicrotask(() => worker.respond({ type: "complete", taskId: message.taskId,
      matches: [{ chunkId: 7, start: 0, end: 1 }], totalMatches: 1, scannedChars: 3, scannedNodes: 3, limited: false }));
  } });
  manager.updateConfig({ batchSize: 1 });
  const result = await manager.search(1, "x", "g", [{ id: 7, text: "x" }, { id: 8, text: "a" }, { id: 9, text: "b" }]);
  assert.deepEqual(result.matches, [{ chunkId: 7, start: 0, end: 1 }]);
  manager.dispose();
});

test("ACKs cannot claim more unique matching blocks than the configured match budget", async () => {
  const { manager, workers } = fixture({ onPost(worker, message) {
    if (message.type === "chunks") queueMicrotask(() => worker.respond({ type: "ack", taskId: message.taskId,
      batchId: message.batchId, matchedChunkIds: message.chunks.map(chunk => chunk.id) }));
  } });
  manager.updateConfig({ maxMatches: 1, batchSize: 1 });
  await assert.rejects(manager.search(1, "x", "g", [{ id: 0, text: "x" }, { id: 1, text: "x" }]), { code: "worker-protocol-error", numericCode: 530 });
  assert.equal(workers[0].terminated, true);
  manager.dispose();
});

test("null and undefined producer failures settle promptly without an unhandled rejection", async () => {
  for (const cause of [null, undefined]) {
    const { manager, workers } = fixture();
    manager.updateConfig({ workerTimeoutMs: 1000 });
    await assert.rejects(manager.searchStream(1, "x", "g", async () => { throw cause; }), {
      code: "worker-spawn-failed", numericCode: 531, message: "Worker initialization failed."
    });
    assert.equal(workers[0].terminated, true);
    manager.dispose();
  }
});
