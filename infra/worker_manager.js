/**
 * @file infra/worker_manager.js
 * @description Worker lifecycle management and search protocol.
 *
 * Creates a Web Worker from a Blob URL (fetched from search_worker.js),
 * manages the start→chunks→finish protocol, and handles timeout/cancel/crash.
 *
 * Public API:
 *   search(taskId, pattern, flags, nodes, policy) → Promise<SearchResult>
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
    maxScannedChars: 50 * 1024 * 1024,
    maxChunkMs: 200,
    workerTimeoutMs: 30000,
    batchSize: 200,
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
    if (activeReject) {
      var priorReject = activeReject;
      terminate();
      priorReject({ name: "AbortError", code: "search-cancelled", numericCode: 0, message: "Search superseded." });
    }

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
        if (d.type === "complete") { cleanup(false); resolve(d); }
        else if (d.type === "error") { cleanup(false); reject({ code: d.code, numericCode: d.numericCode, message: d.message }); }
      };

      // Worker crash
      worker.onerror = function (e) {
        cleanup(false);
        reject({ code: "worker-crashed", numericCode: 503, message: e.message || "Worker crashed." });
      };

      // Start protocol
      worker.postMessage({
        type: "start", taskId: taskId, pattern: pattern, flags: flags,
        maxMatches: config.maxMatches, maxScannedChars: config.maxScannedChars,
        maxChunkMs: config.maxChunkMs,
        policyStatus: (policy && policy.status) || "safe",
        allowUnsafeEcmascript: config.allowUnsafeEcmascript
      });

      // Send chunks
      sendChunks(worker, taskId, nodes)
        .then(function () { worker.postMessage({ type: "finish", taskId: taskId }); })
        .catch(function (e) { terminate(); reject(e); });
    });
  }

  // ── Chunks ───────────────────────────────────

  async function sendChunks(worker, taskId, nodes) {
    var bs = config.batchSize;
    for (var i = 0; i < nodes.length; i += bs) {
      var batch = nodes.slice(i, i + bs).map(function (n) { return { id: n.id, text: n.text }; });
      worker.postMessage({ type: "chunks", taskId: taskId, chunks: batch });
      if (i + bs < nodes.length) {
        await new Promise(function (r) { setTimeout(r, 0); });
      }
    }
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
          if (typeof v === "number" && isFinite(v) && v > 0) config[k] = v;
          break;
        case "allowUnsafeEcmascript":
          config[k] = !!v;
          break;
      }
    }
  }

  globalThis.RRWorkerManager = {
    search: search,
    cancel: cancel,
    dispose: dispose,
    updateConfig: updateConfig
  };
})();
