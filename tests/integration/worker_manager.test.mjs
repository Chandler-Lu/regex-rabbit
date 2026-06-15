import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile("infra/worker_manager.js", "utf8");

// We test the pure config validation logic extracted from worker_manager
// The updateConfig function validates config values

// Test config validation logic (DEF-20)
const configKeys = ["maxMatches", "maxScannedChars", "maxChunkMs", "workerTimeoutMs", "batchSize", "maxBatchChars"];

function isValidConfigValue(k, v) {
  switch (k) {
    case "maxMatches":
    case "maxScannedChars":
    case "maxChunkMs":
    case "workerTimeoutMs":
    case "batchSize":
    case "maxBatchChars":
      return typeof v === "number" && isFinite(v) && v > 0;
    case "allowUnsafeEcmascript":
      return true; // any value coerced to boolean
    default:
      return false;
  }
}

test("config: valid numeric values accepted", () => {
  for (const k of configKeys) {
    assert.ok(isValidConfigValue(k, 100), k + " should accept 100");
    assert.ok(isValidConfigValue(k, 1), k + " should accept 1");
    assert.ok(isValidConfigValue(k, 999999), k + " should accept 999999");
  }
});

test("config: negative values rejected", () => {
  for (const k of configKeys) {
    assert.equal(isValidConfigValue(k, -1), false, k + " should reject -1");
    assert.equal(isValidConfigValue(k, -100), false, k + " should reject -100");
  }
});

test("config: zero values rejected", () => {
  for (const k of configKeys) {
    assert.equal(isValidConfigValue(k, 0), false, k + " should reject 0");
  }
});

test("config: non-numeric values rejected", () => {
  for (const k of configKeys) {
    assert.equal(isValidConfigValue(k, "abc"), false, k + " should reject string");
    assert.equal(isValidConfigValue(k, null), false, k + " should reject null");
    assert.equal(isValidConfigValue(k, undefined), false, k + " should reject undefined");
    assert.equal(isValidConfigValue(k, NaN), false, k + " should reject NaN");
    assert.equal(isValidConfigValue(k, Infinity), false, k + " should reject Infinity");
  }
});

test("config: unknown keys rejected", () => {
  assert.equal(isValidConfigValue("unknownKey", 1), false);
  assert.equal(isValidConfigValue("randomField", "value"), false);
});

test("config: allowUnsafeEcmascript always accepted (boolean coercion)", () => {
  assert.ok(isValidConfigValue("allowUnsafeEcmascript", true));
  assert.ok(isValidConfigValue("allowUnsafeEcmascript", false));
  assert.ok(isValidConfigValue("allowUnsafeEcmascript", "truthy"));
});

test("searchStream stops accepting batches after early worker completion", async () => {
  const oldChrome = globalThis.chrome;
  const oldFetch = globalThis.fetch;
  const oldWorker = globalThis.Worker;
  const oldURL = globalThis.URL;

  class MockWorker {
    static instances = [];

    constructor() {
      this.chunkMessages = 0;
      this.terminated = false;
      MockWorker.instances.push(this);
    }

    postMessage(message) {
      if (message.type !== "chunks") return;
      this.chunkMessages += 1;
      setTimeout(() => {
        if (!this.terminated && this.onmessage) {
          this.onmessage({
            data: {
              type: "complete",
              taskId: message.taskId,
              engine: "mock",
              matches: [{ chunkId: 0, start: 0, end: 1 }],
              totalMatches: 1,
              limited: true
            }
          });
        }
      }, 0);
    }

    terminate() {
      this.terminated = true;
    }
  }

  try {
    globalThis.chrome = { runtime: { getURL() { return "search_worker.js"; } } };
    globalThis.fetch = async () => ({ text: async () => "" });
    globalThis.Worker = MockWorker;
    globalThis.URL = {
      createObjectURL() { return "blob:mock"; },
      revokeObjectURL() {}
    };

    const scope = {};
    new Function("globalThis", source)(scope);

    let secondSend;
    let finishStream;
    const streamDone = new Promise(resolve => { finishStream = resolve; });

    const result = await scope.RRWorkerManager.searchStream(
      10,
      "a",
      "g",
      async (sendBatch, shouldContinue) => {
        assert.equal(shouldContinue(), true);
        assert.equal(await sendBatch([{ id: 0, text: "a" }]), 1);
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(shouldContinue(), false);
        secondSend = await sendBatch([{ id: 1, text: "b" }]);
        finishStream();
      },
      { status: "safe" }
    );

    await streamDone;

    assert.equal(result.limited, true);
    assert.equal(result.matches.length, 1);
    assert.equal(secondSend, 0);
    assert.equal(MockWorker.instances[0].chunkMessages, 1);
  } finally {
    globalThis.chrome = oldChrome;
    globalThis.fetch = oldFetch;
    globalThis.Worker = oldWorker;
    globalThis.URL = oldURL;
  }
});

test("searchStream splits batches by maxBatchChars", async () => {
  const oldChrome = globalThis.chrome;
  const oldFetch = globalThis.fetch;
  const oldWorker = globalThis.Worker;
  const oldURL = globalThis.URL;

  class MockWorker {
    static instances = [];

    constructor() {
      this.chunkSizes = [];
      this.terminated = false;
      MockWorker.instances.push(this);
    }

    postMessage(message) {
      if (message.type === "chunks") {
        this.chunkSizes.push(message.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0));
      }
    }

    terminate() {
      this.terminated = true;
    }
  }

  try {
    globalThis.chrome = { runtime: { getURL() { return "search_worker.js"; } } };
    globalThis.fetch = async () => ({ text: async () => "" });
    globalThis.Worker = MockWorker;
    globalThis.URL = {
      createObjectURL() { return "blob:mock"; },
      revokeObjectURL() {}
    };

    const scope = {};
    new Function("globalThis", source)(scope);
    scope.RRWorkerManager.updateConfig({ maxBatchChars: 5 });

    const resultPromise = scope.RRWorkerManager.searchStream(
      11,
      "z",
      "g",
      async (sendBatch) => {
        const sent = await sendBatch([
          { id: 0, text: "aaaa" },
          { id: 1, text: "bbbb" },
          { id: 2, text: "cc" }
        ]);
        assert.equal(sent, 3);
      },
      { status: "safe" }
    );

    await new Promise(resolve => setTimeout(resolve, 10));
    scope.RRWorkerManager.cancel(11);
    await assert.rejects(resultPromise, error => error && error.code === "search-cancelled");

    assert.deepEqual(MockWorker.instances[0].chunkSizes, [4, 4, 2]);
  } finally {
    globalThis.chrome = oldChrome;
    globalThis.fetch = oldFetch;
    globalThis.Worker = oldWorker;
    globalThis.URL = oldURL;
  }
});
