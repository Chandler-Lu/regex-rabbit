/**
 * @file infra/worker_manager.js
 * @description Worker lifecycle management and search protocol.
 *
 * Creates a Web Worker from a Blob URL (fetched from search_worker.js),
 * manages the start→chunks→finish protocol, and handles timeout/cancel/crash.
 *
 * Public API:
 *   search(taskId, pattern, flags, nodes, policy) → Promise<SearchResult>
 *   searchStream(taskId, pattern, flags, streamNodes, policy) → Promise<SearchResult>
 *   cancel(taskId) → void
 *   dispose() → void
 */
(function () {
  "use strict";

  var blobUrl = null;
  var activeWorker = null;
  var activeTaskId = 0;
  var activeReject = null;
  var activeTimeoutId = null;
  var config = {
    maxMatches: 5000,
    maxScannedChars: 256 * 1024 * 1024,
    maxChunkMs: 250,
    workerTimeoutMs: 30000,
    batchSize: 200,
    maxBatchChars: 1024 * 1024,
    allowUnsafeEcmascript: false
  };

  // ── Blob URL ────────────────────────────────

  async function getBlobUrl() {
    if (blobUrl) return blobUrl;
    var url = chrome.runtime.getURL("search_worker.js");
    var text = await (await fetch(url)).text();
    blobUrl = URL.createObjectURL(new Blob([text], { type: "application/javascript" }));
    return blobUrl;
  }

  // ── Search ───────────────────────────────────

  /**
   * @param {number} taskId
   * @param {string} pattern
   * @param {string} flags
   * @param {Array<{id:number, node:Text, text:string}>} nodes
   * @param {{ok:boolean, status:string}} policy
   * @returns {Promise<{engine:string, matches:Array, totalMatches:number, limited:boolean}>}
   */
  async function search(taskId, pattern, flags, nodes, policy) {
    // Reject prior in-flight search before creating a new Worker
    rejectActiveSearch("Search superseded.");

    var url = await getBlobUrl();

    var worker;
    try { worker = new Worker(url); }
    catch (e) {
      throw { code: "worker-spawn-failed", numericCode: 531, message: "Failed to create search worker: " + (e.message || String(e)) };
    }

    activeWorker = worker;
    activeTaskId = taskId;

    return new Promise(function (resolve, reject) {
      // Timeout
      var tid = setTimeout(function () {
        terminate();
        reject({ code: "search-timeout", numericCode: 504, message: "Search timed out." });
      }, config.workerTimeoutMs);
      activeTimeoutId = tid;
      activeReject = reject;

      // Worker response
      worker.onmessage = function (e) {
        var d = e.data;
        if (!d || d.taskId !== taskId) return;
        if (d.type === "complete") {
          finishWorker(worker);
          resolve(d);
        } else if (d.type === "error") {
          finishWorker(worker);
          reject({ code: d.code, numericCode: d.numericCode, message: d.message });
        }
      };

      // Worker crash
      worker.onerror = function (e) {
        finishWorker(worker);
        reject({ code: "worker-crashed", numericCode: 503, message: e.message || "Worker crashed." });
      };

      // Start protocol
      postStart(worker, taskId, pattern, flags, policy);

      // Send chunks
      sendChunks(worker, taskId, nodes)
        .then(function () {
          if (activeWorker === worker && activeTaskId === taskId) {
            worker.postMessage({ type: "finish", taskId: taskId });
          }
        })
        .catch(function (e) {
          if (activeWorker === worker && activeTaskId === taskId) {
            terminate();
            reject(e);
          }
        });
    });
  }

  /**
   * Stream text-node batches into the worker while the page is still being
   * traversed. The stream callback receives `(sendBatch, shouldContinue)`.
   *
   * @param {number} taskId
   * @param {string} pattern
   * @param {string} flags
   * @param {Function} streamNodes
   * @param {{ok:boolean, status:string}} policy
   * @returns {Promise<{engine:string, matches:Array, totalMatches:number, limited:boolean}>}
   */
  async function searchStream(taskId, pattern, flags, streamNodes, policy) {
    rejectActiveSearch("Search superseded.");

    var url = await getBlobUrl();
    var worker;
    try { worker = new Worker(url); }
    catch (e) {
      throw { code: "worker-spawn-failed", numericCode: 531, message: "Failed to create search worker: " + (e.message || String(e)) };
    }

    activeWorker = worker;
    activeTaskId = taskId;

    return new Promise(function (resolve, reject) {
      var tid = setTimeout(function () {
        terminate();
        reject({ code: "search-timeout", numericCode: 504, message: "Search timed out." });
      }, config.workerTimeoutMs);
      activeTimeoutId = tid;
      activeReject = reject;

      worker.onmessage = function (e) {
        var d = e.data;
        if (!d || d.taskId !== taskId) return;
        if (d.type === "complete") {
          finishWorker(worker);
          resolve(d);
        } else if (d.type === "error") {
          finishWorker(worker);
          reject({ code: d.code, numericCode: d.numericCode, message: d.message });
        }
      };

      worker.onerror = function (e) {
        finishWorker(worker);
        reject({ code: "worker-crashed", numericCode: 503, message: e.message || "Worker crashed." });
      };

      postStart(worker, taskId, pattern, flags, policy);

      Promise.resolve().then(function () {
        return streamNodes(
          function (batch) { return sendBatch(worker, taskId, batch); },
          function () { return isActive(worker, taskId); }
        );
      }).then(function () {
        if (isActive(worker, taskId)) {
          worker.postMessage({ type: "finish", taskId: taskId });
        }
      }).catch(function (e) {
        if (isActive(worker, taskId)) {
          terminate();
          reject(e);
        }
      });
    });
  }

  // ── Chunks ───────────────────────────────────

  async function sendChunks(worker, taskId, nodes) {
    var bs = config.batchSize;
    for (var i = 0; i < nodes.length; i += bs) {
      if (activeWorker !== worker || activeTaskId !== taskId) return;
      var end = Math.min(i + bs, nodes.length);
      sendNodeRange(worker, taskId, nodes, i, end);
      if (end < nodes.length) {
        await new Promise(function (r) { setTimeout(r, 0); });
      }
    }
  }

  async function sendBatch(worker, taskId, nodes) {
    if (!isActive(worker, taskId)) return 0;
    var batch = [];
    var batchChars = 0;
    var sent = 0;

    for (var j = 0; j < nodes.length; j++) {
      if (!isActive(worker, taskId)) break;
      var text = nodes[j].text || "";
      var textLength = text.length;

      if (batch.length > 0 && batchChars + textLength > config.maxBatchChars) {
        worker.postMessage({ type: "chunks", taskId: taskId, chunks: batch });
        sent += batch.length;
        batch = [];
        batchChars = 0;
        await yieldToMainThread();
        if (!isActive(worker, taskId)) break;
      }

      batch.push({ id: nodes[j].id, text: text });
      batchChars += textLength;

      if (textLength >= config.maxBatchChars) {
        worker.postMessage({ type: "chunks", taskId: taskId, chunks: batch });
        sent += batch.length;
        batch = [];
        batchChars = 0;
        await yieldToMainThread();
      }
    }

    if (batch.length > 0 && isActive(worker, taskId)) {
      worker.postMessage({ type: "chunks", taskId: taskId, chunks: batch });
      sent += batch.length;
    }

    return sent;
  }

  function sendNodeRange(worker, taskId, nodes, start, end) {
    if (!isActive(worker, taskId)) return false;
    var batch = [];
    for (var j = start; j < end; j++) {
      batch.push({ id: nodes[j].id, text: nodes[j].text });
    }
    worker.postMessage({ type: "chunks", taskId: taskId, chunks: batch });
    return true;
  }

  function postStart(worker, taskId, pattern, flags, policy) {
    worker.postMessage({
      type: "start", taskId: taskId, pattern: pattern, flags: flags,
      maxMatches: config.maxMatches, maxScannedChars: config.maxScannedChars,
      maxChunkMs: config.maxChunkMs,
      policyStatus: (policy && policy.status) || "safe",
      allowUnsafeEcmascript: config.allowUnsafeEcmascript
    });
  }

  function isActive(worker, taskId) {
    return activeWorker === worker && activeTaskId === taskId;
  }

  function rejectActiveSearch(message) {
    if (!activeReject) return;
    var priorReject = activeReject;
    terminate();
    priorReject({ name: "AbortError", code: "search-cancelled", numericCode: 0, message: message });
  }

  // ── Cancel ───────────────────────────────────

  function cancel(taskId) {
    if (activeTaskId === taskId) {
      var rej = activeReject;
      terminate();
      if (rej) rej({ name: "AbortError", code: "search-cancelled", numericCode: 0, message: "Search cancelled." });
    }
  }

  // ── Lifecycle ────────────────────────────────

  function terminate() {
    if (activeWorker) { activeWorker.terminate(); activeWorker = null; }
    cleanup(true);
    activeTaskId = 0;
  }

  function finishWorker(worker) {
    try { worker.terminate(); } catch (e) {}
    if (activeWorker === worker) activeWorker = null;
    cleanup(true);
    activeTaskId = 0;
  }

  function cleanup(clearReject) {
    if (activeTimeoutId !== null) { clearTimeout(activeTimeoutId); activeTimeoutId = null; }
    if (clearReject) activeReject = null;
    else { activeWorker = null; activeTaskId = 0; }
  }

  function dispose() {
    terminate();
    if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
  }

  // ── Config ───────────────────────────────────

  function updateConfig(cfg) {
    if (!cfg || typeof cfg !== "object") return;
    for (var k in cfg) {
      if (!cfg.hasOwnProperty(k) || !config.hasOwnProperty(k)) continue;
      var v = cfg[k];
      switch (k) {
        case "maxMatches":
        case "maxScannedChars":
        case "maxChunkMs":
        case "workerTimeoutMs":
        case "batchSize":
        case "maxBatchChars":
          if (typeof v === "number" && isFinite(v) && v > 0) config[k] = v;
          break;
        case "allowUnsafeEcmascript":
          config[k] = !!v;
          break;
      }
    }
  }

  function yieldToMainThread() {
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  globalThis.RRWorkerManager = {
    search: search,
    searchStream: searchStream,
    cancel: cancel,
    dispose: dispose,
    updateConfig: updateConfig
  };
})();
