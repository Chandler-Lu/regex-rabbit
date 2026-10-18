import assert from "node:assert/strict";
import { readRuntimeSource as readFile } from "../fixtures/runtime_source.mjs";
import test from "node:test";
import { Worker } from "node:worker_threads";

const [managerSource, searchSource, analyzerSource, literalSource] = await Promise.all([
  readFile("infra/worker_manager.js", "utf8"), readFile("search_worker.js", "utf8"), readFile("domain/pattern_analyzer.js", "utf8"), readFile("domain/literal_matcher.js", "utf8")
]);
const workerSource = analyzerSource + "\n" + literalSource + "\n" + searchSource;
const adapted = `
const { parentPort } = require("node:worker_threads");
const { performance } = require("node:perf_hooks");
let batchStartedAt = null;
const self = { postMessage(data) {
    if (data.type === "ack" && data.batchId !== undefined && batchStartedAt !== null) {
      parentPort.postMessage({ type: "test-batch-time", elapsed: performance.now() - batchStartedAt });
    }
    parentPort.postMessage(data);
  },
  set onmessage(handler) { parentPort.on("message", data => {
    batchStartedAt = data.type === "chunks" ? performance.now() : null;
    handler({ data }); batchStartedAt = null;
  }); } };
${workerSource}
`;

function liveManager() {
  const workers = [];
  class BridgeWorker {
    constructor() {
      this.inner = new Worker(adapted, { eval: true });
      this.inner.on("message", data => {
        if (data.type === "test-batch-time") { this.batchDurationMs = data.elapsed; return; }
        if (this.onmessage) this.onmessage({ data });
      });
      this.inner.on("error", error => { if (this.onerror) this.onerror(error); });
      this.inner.on("online", () => { this.online = true; });
      workers.push(this);
    }
    postMessage(message) { this.inner.postMessage(message); }
    terminate() { this.terminated = true; this.inner.terminate(); }
  }
  const scope = {};
  new Function("globalThis", "chrome", "fetch", "Worker", "URL", "Blob", managerSource)(scope,
    { runtime: { getURL: () => "search_worker.js" } }, async () => ({ text: async () => workerSource }), BridgeWorker,
    { createObjectURL: () => "blob:worker", revokeObjectURL() {} }, Blob);
  return { manager: scope.RRWorkerManager, workers };
}

test("a backtracking query missed by static screening is terminated and subsequent search succeeds", { timeout: 7000 }, async () => {
  const scope = {};
  new Function("globalThis", analyzerSource)(scope);
  const pattern = "a*a*a*a*a*a*a*a*b";
  assert.equal(scope.RRPatternAnalyzer.analyze(pattern, "g").ok, true);
  const { manager, workers } = liveManager();
  manager.updateConfig({ workerTimeoutMs: 1000, allowUnsafeEcmascript: true });
  let mainThreadTicks = 0;
  const timer = setInterval(() => { mainThreadTicks++; }, 20);
  try {
    await assert.rejects(manager.search(1, pattern, "g", [{ id: 0, text: "a".repeat(200) + "!" }], { mode: "regex", status: "safe" }), { code: "search-timeout", numericCode: 504 });
    assert.equal(workers[0].online, true);
    assert.equal(workers[0].terminated, true);
    assert.ok(mainThreadTicks > 2, "main thread remained responsive during hung matching");
    const recovered = await manager.search(2, "a*", "g", [{ id: 0, text: "a* a*" }], { mode: "literal", status: "safe" });
    assert.deepEqual(recovered.matches.map(match => [match.start, match.end]), [[0, 2], [3, 5]]);
    assert.equal(recovered.engine, "literal");
  } finally {
    clearInterval(timer);
    manager.dispose();
    await Promise.all(workers.map(worker => worker.inner.terminate()));
  }
});

test("a normal native-regexp scan over 250 ms completes within the whole-query deadline", { timeout: 8000 }, async () => {
  const { manager, workers } = liveManager();
  manager.updateConfig({ workerTimeoutMs: 5000 });
  let mainThreadTicks = 0;
  const timer = setInterval(() => { mainThreadTicks++; }, 20);
  try {
    const text = "a".repeat(1_000_000);
    const result = await manager.search(5, "a(?=[a-z]{200}b)", "g", [{ id: 0, text }], { mode: "regex", status: "safe" });
    assert.ok(workers[0].batchDurationMs > 250, `actual Worker matching took ${workers[0].batchDurationMs} ms`);
    assert.equal(result.scannedChars, text.length);
    assert.equal(result.scannedNodes, 1);
    assert.equal(result.totalMatches, 0);
    assert.equal(result.limited, false);
    assert.equal(result.limitReason, null);
    assert.ok(mainThreadTicks > 2, "the page thread stayed responsive during normal matching");
  } finally {
    clearInterval(timer);
    manager.dispose();
    await Promise.all(workers.map(worker => worker.inner.terminate()));
  }
});

test("live streaming consumes one acknowledged batch at a time and respects global match cap", async () => {
  const { manager, workers } = liveManager();
  manager.updateConfig({ batchSize: 1, maxMatches: 3 });
  let sent = 0, continued = true;
  try {
    const result = await manager.searchStream(3, "x", "g", async (send, keepGoing) => {
      sent += await send([{ id: 0, text: "xx" }]);
      sent += await send([{ id: 1, text: "xx" }]);
      continued = keepGoing();
      sent += await send([{ id: 2, text: "xx" }]);
    }, { mode: "literal", status: "safe" });
    // The producer may finish a microtask after the search promise resolves.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(result.totalMatches, 3);
    assert.equal(result.limitReason, "max-matches");
    assert.equal(continued, false);
    assert.equal(sent, 2);
  } finally {
    manager.dispose();
    await Promise.all(workers.map(worker => worker.inner.terminate()));
  }
});

test("live sparse-hit streams release unmatched source metadata after every acknowledged batch", async () => {
  const { manager, workers } = liveManager();
  manager.updateConfig({ batchSize: 8, workerTimeoutMs: 3000 });
  const retained = new Map();
  let peak = 0;
  try {
    const result = await manager.searchStream(4, "needle", "g", async (send, keepGoing, getLastBatchMatchedIds) => {
      for (let batch = 0; batch < 20 && keepGoing(); batch++) {
        const entries = Array.from({ length: 16 }, (_, index) => {
          const id = batch * 16 + index;
          return { id, text: id === 123 || id === 301 ? "needle needle" : " ", segments: [{ largeSourceMetadata: id }] };
        });
        for (const entry of entries) retained.set(entry.id, entry);
        peak = Math.max(peak, retained.size);
        assert.equal(await send(entries), entries.length);
        const ids = getLastBatchMatchedIds();
        assert.ok(Array.isArray(ids));
        const hits = new Set(ids);
        for (const entry of entries) if (!hits.has(entry.id)) retained.delete(entry.id);
      }
    }, { mode: "literal", status: "safe" });
    assert.equal(result.totalMatches, 4);
    assert.deepEqual([...retained.keys()], [123, 301]);
    assert.ok(peak <= 18, "metadata retained only the current producer batch plus hit entries");
    assert.deepEqual([...new Set(result.matches.map(match => match.chunkId))], [...retained.keys()]);
  } finally {
    manager.dispose();
    await Promise.all(workers.map(worker => worker.inner.terminate()));
  }
});
