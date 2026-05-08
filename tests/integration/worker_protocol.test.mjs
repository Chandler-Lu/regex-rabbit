import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { resolve } from "node:path";

const wsPath = resolve("search_worker.js");
let workerSource = await readFile(wsPath, "utf8");
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
    const t = setTimeout(() => rej(new Error("timeout")), ms);
    worker.on("message", d => { clearTimeout(t); res(d); });
    worker.on("error", e => { clearTimeout(t); rej(e); });
  });
}

test("complete flow", async () => {
  const wk = w();
  wk.postMessage({ type: "start", taskId: 1, pattern: "hello", flags: "gi", maxMatches: 100, maxScannedChars: 10000, maxChunkMs: 100, policyStatus: "safe", allowUnsafeEcmascript: false });
  wk.postMessage({ type: "chunks", taskId: 1, chunks: [{ id: 0, text: "hello world" }] });
  wk.postMessage({ type: "finish", taskId: 1 });
  const m = await recv(wk);
  assert.equal(m.type, "complete");
  assert.equal(m.totalMatches, 1);
  wk.terminate();
});

test("invalid pattern → error 400", async () => {
  const wk = w();
  wk.postMessage({ type: "start", taskId: 2, pattern: "[bad", flags: "", maxMatches: 100, maxScannedChars: 1000, maxChunkMs: 100, policyStatus: "safe", allowUnsafeEcmascript: false });
  const m = await recv(wk);
  assert.equal(m.type, "error");
  assert.equal(m.numericCode, 400);
  wk.terminate();
});

test("unsafe blocked → 452", async () => {
  const wk = w();
  wk.postMessage({ type: "start", taskId: 3, pattern: "(a+)*", flags: "", maxMatches: 100, maxScannedChars: 1000, maxChunkMs: 100, policyStatus: "unsafe", allowUnsafeEcmascript: false });
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
  wk.postMessage({ type: "start", taskId: 5, pattern: "x", flags: "", maxMatches: 100, maxScannedChars: 1000, maxChunkMs: 100, policyStatus: "safe", allowUnsafeEcmascript: false });
  wk.postMessage({ type: "cancel", taskId: 5 });
  wk.postMessage({ type: "finish", taskId: 5 });
  let got = false;
  wk.on("message", () => { got = true; });
  await new Promise(r => setTimeout(r, 100));
  assert.equal(got, false);
  wk.terminate();
});
