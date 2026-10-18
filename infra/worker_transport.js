/** Worker-compatible transport to the extension's offscreen worker host. */
(function () {
  "use strict";
  var POLICY = globalThis.RRRuntimePolicy;
  var PORT_NAME = "regex-rabbit-worker-v1";
  var TIMEOUT_MS = POLICY.transport.acknowledgementTimeoutMs;
  var HANDSHAKE_TIMEOUT_MS = POLICY.transport.handshakeTimeoutMs;
  var MAX_WORKER_TIMEOUT_MS = POLICY.search.maxTimeoutMs;
  var MAX_PATTERN_LENGTH = POLICY.search.maxPatternChars;
  var MAX_BATCH_CHARS = POLICY.transport.maxBatchChars;
  var START_FIELDS = POLICY.transport.startFields;
  var nextClient = 0;

  function error(code, message) {
    var result = new Error(message);
    result.code = code;
    switch (code) {
      case "search-timeout": result.numericCode = POLICY.errors.timeout; break;
      case "worker-protocol-error": result.numericCode = POLICY.errors.protocol; break;
      case "search-cancelled": result.numericCode = POLICY.errors.cancelled; break;
      case "worker-crashed":
      case "worker-disconnected": result.numericCode = POLICY.errors.workerUnavailable; break;
      default: result.numericCode = POLICY.errors.workerStartup;
    }
    return result;
  }

  function now() {
    return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
  }

  function copyStream(stream, textLength) {
    if (!stream || typeof stream !== "object" || Array.isArray(stream) ||
        !Number.isSafeInteger(stream.runId) || stream.runId < 0 ||
        !Number.isSafeInteger(stream.offset) || stream.offset < 0 ||
        !Number.isSafeInteger(stream.ownedStart) || !Number.isSafeInteger(stream.ownedEnd) ||
        stream.offset > stream.ownedStart || stream.ownedStart > stream.ownedEnd ||
        stream.offset > Number.MAX_SAFE_INTEGER - textLength || stream.ownedEnd > stream.offset + textLength ||
        typeof stream.first !== "boolean" || typeof stream.last !== "boolean") {
      throw error("worker-protocol-error", "Invalid worker stream range.");
    }
    return { runId: stream.runId, offset: stream.offset, ownedStart: stream.ownedStart,
      ownedEnd: stream.ownedEnd, first: stream.first, last: stream.last };
  }

  function copySource(source, chunkId, textLength) {
    if (!source || typeof source !== "object" || Array.isArray(source) ||
        !Number.isSafeInteger(source.runId) || source.runId < 0 ||
        !Number.isSafeInteger(source.offset) || source.offset < 0 ||
        source.offset > Number.MAX_SAFE_INTEGER - textLength ||
        typeof source.first !== "boolean" || typeof source.last !== "boolean" ||
        source.first && (source.offset !== 0 || source.runId !== chunkId)) {
      throw error("worker-protocol-error", "Invalid worker source range.");
    }
    return { runId: source.runId, offset: source.offset, first: source.first, last: source.last };
  }

  function prepare(data) {
    if (!data || !["start", "chunks", "finish", "cancel"].includes(data.type) || !Number.isSafeInteger(data.taskId) || data.taskId < 0) throw error("worker-protocol-error", "Invalid worker message.");
    if (data.type !== "start" && START_FIELDS.some(function (key) { return data[key] !== undefined; })) throw error("worker-protocol-error", "Search options are accepted only in the start message.");
    if (data.workerTimeoutMs !== undefined && (data.type !== "start" || !Number.isSafeInteger(data.workerTimeoutMs) || data.workerTimeoutMs <= 0 || data.workerTimeoutMs > MAX_WORKER_TIMEOUT_MS)) throw error("worker-protocol-error", "Invalid worker timeout.");
    if (data.analyzeInWorker !== undefined && (data.type !== "start" || typeof data.analyzeInWorker !== "boolean")) throw error("worker-protocol-error", "Invalid worker validation option.");
    var result = { type: data.type, taskId: data.taskId };
    var fields = data.type === "start" ? START_FIELDS : ["batchId", "limitReason"];
    fields.forEach(function (key) {
      if (data[key] === undefined) return;
      var value = data[key];
      if (value !== null && !["string", "number", "boolean"].includes(typeof value)) throw error("worker-protocol-error", "Invalid worker message field.");
      if (typeof value === "string" && value.length > (key === "pattern" ? MAX_PATTERN_LENGTH : POLICY.transport.maxMetadataChars)) throw error("worker-protocol-error", "Worker message field exceeds its limit.");
      if (typeof value === "number" && !Number.isFinite(value)) throw error("worker-protocol-error", "Invalid worker message number.");
      result[key] = value;
    });
    if (data.type === "chunks") {
      if (!Array.isArray(data.chunks) || data.chunks.length > POLICY.transport.maxBatchNodes) throw error("worker-protocol-error", "Invalid worker batch.");
      var chars = 0;
      result.chunks = data.chunks.map(function (chunk) {
        if (!chunk || !Number.isSafeInteger(chunk.id) || chunk.id < 0 || typeof chunk.text !== "string") throw error("worker-protocol-error", "Invalid worker text item.");
        chars += chunk.text.length;
        if (chars > MAX_BATCH_CHARS) throw error("worker-protocol-error", "Worker batch exceeds its character limit.");
        if (chunk.stream !== undefined && chunk.source !== undefined) throw error("worker-protocol-error", "A chunk cannot contain both stream and source ranges.");
        var item = { id: chunk.id, text: chunk.text };
        if (chunk.stream !== undefined) item.stream = copyStream(chunk.stream, chunk.text.length);
        if (chunk.source !== undefined) item.source = copySource(chunk.source, chunk.id, chunk.text.length);
        return item;
      });
    }
    return result;
  }

  function create(options) {
    return new Promise(function (resolve, reject) {
      var signal = options && options.signal;
      if (signal && (typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) {
        reject(error("worker-protocol-error", "Invalid worker cancellation signal."));
        return;
      }
      if (signal && signal.aborted) {
        var aborted = error("search-cancelled", "Search worker creation cancelled.");
        aborted.name = "AbortError";
        reject(aborted);
        return;
      }
      var port;
      try { port = chrome.runtime.connect({ name: PORT_NAME }); }
      catch (cause) { reject(error("worker-spawn-failed", cause.message || "Worker connection failed.")); return; }
      var clientId = "rr-" + Date.now().toString(36) + "-" + (++nextClient).toString(36) + "-" + Math.random().toString(36).slice(2);
      var closed = false;
      var ready = false;
      var sequence = 0;
      var inFlight = 0;
      var pending = new Map();
      var taskDeadline = null;
      var timer = setTimeout(function () { fail(error("worker-spawn-failed", "Worker host did not respond.")); }, HANDSHAKE_TIMEOUT_MS);
      var adapter = { onmessage: null, onerror: null, postMessage: postMessage, terminate: terminate };

      function cleanup(reason) {
        if (closed) return false;
        closed = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", terminate);
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(onDisconnect);
        pending.forEach(function (entry) { clearTimeout(entry.timer); entry.reject(reason); });
        pending.clear();
        try { port.disconnect(); } catch (ignored) {}
        return true;
      }

      function fail(reason) {
        if (!cleanup(reason)) return;
        if (!ready) reject(reason);
        else if (typeof adapter.onerror === "function") adapter.onerror({ message: reason.message, error: reason });
      }

      function terminate() {
        var reason = error("search-cancelled", "Search worker terminated.");
        reason.name = "AbortError";
        if (cleanup(reason) && !ready) reject(reason);
      }

      function onDisconnect() {
        // Reading lastError here also prevents Chrome's unchecked-error warning.
        var last = chrome.runtime.lastError;
        fail(error("worker-disconnected", last && last.message || "Search worker connection closed."));
      }

      function onMessage(message) {
        if (closed || !message || message.clientId !== clientId) return;
        if (message.kind === "ready" && !ready) {
          ready = true;
          clearTimeout(timer);
          resolve(adapter);
        } else if (message.kind === "failure") {
          fail(error(message.code || "worker-spawn-failed", message.message || "Search worker failed."));
        } else if (ready && message.kind === "ack") {
          if (message.sequence !== inFlight) return;
          var entry = pending.get(message.sequence);
          if (!entry) return;
          pending.delete(message.sequence);
          inFlight = 0;
          clearTimeout(entry.timer);
          entry.resolve();
          if (entry.cancelsTask) {
            // Each authenticated route hosts one disposable task. A cancelled
            // route cannot start another task, so release its worker immediately.
            var cancelled = error("search-cancelled", "Search worker task cancelled.");
            cancelled.name = "AbortError";
            cleanup(cancelled);
          } else pump();
        } else if (ready && message.kind === "message") {
          // The host disposes its worker after a terminal response. Close before
          // notifying callers so queued sends cannot wait for an impossible ACK.
          if (message.data && ["complete", "error"].includes(message.data.type)) {
            var timedOut = message.data.type === "error" && (message.data.code === "search-timeout" || message.data.numericCode === POLICY.errors.timeout);
            cleanup(timedOut ? error("search-timeout", typeof message.data.message === "string" ? message.data.message : "Search worker task timed out.") : error("worker-disconnected", "Search worker task ended."));
          }
          if (typeof adapter.onmessage === "function") adapter.onmessage({ data: message.data });
        }
      }

      function pump() {
        if (closed || inFlight || !pending.size) return;
        var first = pending.entries().next().value;
        var current = first[0];
        var entry = first[1];
        inFlight = current;
        var remaining = taskDeadline === null ? TIMEOUT_MS : Math.min(MAX_WORKER_TIMEOUT_MS, taskDeadline - now());
        if (remaining <= 0) { fail(error("search-timeout", "Search worker message timed out.")); return; }
        entry.timer = setTimeout(function () { fail(error("search-timeout", "Search worker message timed out.")); }, remaining);
        try { port.postMessage({ kind: "message", clientId: clientId, sequence: current, data: entry.data }); }
        catch (cause) { fail(error("worker-disconnected", cause.message || "Search worker message failed.")); }
        // The port already copied the payload; retain only its ACK callbacks.
        entry.data = null;
      }

      function postMessage(data) {
        var promise = new Promise(function (sent, failed) {
          if (closed || !ready) { failed(error("worker-disconnected", "Search worker is unavailable.")); return; }
          if (pending.size >= POLICY.transport.maxPendingMessages) { failed(error("worker-backpressure", "Too many unacknowledged worker messages.")); return; }
          var payload = prepare(data);
          if (payload.type === "start" && taskDeadline === null) taskDeadline = now() + (payload.workerTimeoutMs === undefined ? POLICY.search.defaultTimeoutMs : payload.workerTimeoutMs);
          var current = ++sequence;
          var entry = { resolve: sent, reject: failed, timer: null, data: payload, cancelsTask: payload.type === "cancel" };
          pending.set(current, entry);
          pump();
        });
        // Worker callers may use the native fire-and-forget API. Awaiting this
        // same promise still reports delivery failures to streaming callers.
        promise.catch(function () {});
        return promise;
      }

      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);
      if (signal) signal.addEventListener("abort", terminate, { once: true });
      try { port.postMessage({ kind: "open", clientId: clientId }); }
      catch (cause) { fail(error("worker-spawn-failed", cause.message || "Worker connection failed.")); }
    });
  }

  function isAvailable() {
    return typeof chrome !== "undefined" && !!chrome.runtime && typeof chrome.runtime.connect === "function";
  }

  globalThis.RRWorkerTransport = { create: create, isAvailable: isAvailable };
})();
