/** Hosts disposable search Workers outside a page's CSP and main thread. */
(function () {
  "use strict";
  var POLICY = globalThis.RRRuntimePolicy;
  var MAX_WORKERS = POLICY.transport.concurrentWorkers;
  var workers = new Map();
  var activeWorkers = 0;
  var queueHead = null, queueTail = null, draining = false, drainTimer = null;
  var port = null;
  var heartbeat = null;
  function now() {
    return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
  }

  function post(message) {
    if (!port) return;
    try { port.postMessage(message); } catch (ignored) { disconnect(); }
  }

  function release(clientId) {
    var entry = workers.get(clientId);
    if (!entry) return;
    workers.delete(clientId);
    unqueue(entry);
    clearTimeout(entry.timer);
    clearTimeout(entry.queryTimer);
    entry.startData = null; entry.terminal = null;
    if (entry.worker) {
      activeWorkers--;
      entry.worker.onmessage = null; entry.worker.onerror = null; entry.worker.onmessageerror = null;
      try { entry.worker.terminate(); } catch (ignored) {}
      entry.worker = null;
    }
    if (!workers.size && heartbeat !== null) { clearInterval(heartbeat); heartbeat = null; }
    if (!workers.size && drainTimer !== null) { clearTimeout(drainTimer); drainTimer = null; }
    drain();
  }

  function disconnect() {
    void chrome.runtime.lastError;
    var old = port;
    port = null;
    if (drainTimer !== null) { clearTimeout(drainTimer); drainTimer = null; }
    Array.from(workers.keys()).forEach(release);
    if (old) try { old.disconnect(); } catch (ignored) {}
  }

  function failure(clientId, code, message) {
    post({ kind: "failure", clientId: clientId, code: code, message: message });
    release(clientId);
  }
  function expireQuery(clientId, entry) {
    if (workers.get(clientId) !== entry) return;
    post({ kind: "message", clientId: clientId, data: { type: "error", taskId: entry.taskId,
      code: "search-timeout", numericCode: POLICY.errors.timeout, message: "Search timed out." } });
    release(clientId);
  }

  function enqueue(entry) {
    entry.queued = true;
    entry.previous = queueTail; entry.next = null;
    if (queueTail) queueTail.next = entry;
    else queueHead = entry;
    queueTail = entry;
  }
  function unqueue(entry) {
    if (!entry.queued) return;
    if (entry.previous) entry.previous.next = entry.next;
    else queueHead = entry.next;
    if (entry.next) entry.next.previous = entry.previous;
    else queueTail = entry.previous;
    entry.queued = false; entry.previous = null; entry.next = null;
  }
  function drain() {
    if (draining || drainTimer !== null || !port) return;
    draining = true;
    var startedAt = now();
    try {
      while (port && activeWorkers < MAX_WORKERS && queueHead) {
        if (now() - startedAt >= POLICY.scheduling.pageSliceMs) {
          drainTimer = setTimeout(function () { drainTimer = null; drain(); }, 0);
          break;
        }
        var entry = queueHead;
        unqueue(entry);
        if (workers.get(entry.clientId) !== entry) continue;
        if (now() >= entry.deadline) { expireQuery(entry.clientId, entry); continue; }
        spawn(entry);
      }
    } finally { draining = false; }
  }

  function open(clientId) {
    if (workers.has(clientId)) {
      failure(clientId, "worker-protocol-error", "Search route is already open.");
      return;
    }
    var entry = { clientId: clientId, worker: null, taskId: null, sequence: 0, awaiting: 0, terminal: null, timer: null,
      queryTimer: null, deadline: null, startData: null, queued: false, previous: null, next: null };
    workers.set(clientId, entry);
    // Opening a route does not reserve a Worker. Queued clients become ready
    // immediately, so only their query deadline governs the wait for a slot.
    entry.timer = setTimeout(function () { failure(clientId, "search-timeout", "Search route did not start a task."); }, POLICY.transport.unusedRouteTimeoutMs);
    if (heartbeat === null) heartbeat = setInterval(function () { post({ kind: "ping" }); }, POLICY.transport.heartbeatIntervalMs);
    post({ kind: "ready", clientId: clientId });
  }

  function spawn(entry) {
    var clientId = entry.clientId;
    var worker;
    try { worker = new Worker(chrome.runtime.getURL("search_worker.js")); }
    catch (cause) { failure(clientId, "worker-spawn-failed", cause.message || "Worker creation failed."); return; }
    entry.worker = worker;
    activeWorkers++;
    worker.onmessage = function (event) {
      if (workers.get(clientId) !== entry) return;
      var data = event.data;
      if (!data || data.taskId !== entry.taskId) return;
      if (entry.deadline !== null && now() >= entry.deadline) { expireQuery(clientId, entry); return; }
      if (data.type === "ack" && Number.isSafeInteger(data.sequence) && data.sequence === entry.awaiting) {
        entry.awaiting = 0;
        post({ kind: "ack", clientId: clientId, sequence: data.sequence });
        if (Number.isSafeInteger(data.batchId)) post({ kind: "message", clientId: clientId, data: data });
        if (entry.terminal) {
          post({ kind: "message", clientId: clientId, data: entry.terminal });
          release(clientId);
        }
      } else if (data.type === "complete" || data.type === "error") {
        if (entry.awaiting) entry.terminal = data;
        else { post({ kind: "message", clientId: clientId, data: data }); release(clientId); }
      } else if (data.type === "ack" && Number.isSafeInteger(data.batchId)) {
        post({ kind: "message", clientId: clientId, data: data });
      }
    };
    worker.onerror = function (event) {
      if (workers.get(clientId) !== entry) return;
      if (entry.deadline !== null && now() >= entry.deadline) expireQuery(clientId, entry);
      else failure(clientId, "worker-crashed", event.message || "Search worker crashed.");
    };
    worker.onmessageerror = function () {
      if (workers.get(clientId) !== entry) return;
      if (entry.deadline !== null && now() >= entry.deadline) expireQuery(clientId, entry);
      else failure(clientId, "worker-protocol-error", "Search worker returned an unreadable message.");
    };
    var remaining = Math.ceil(entry.deadline - now());
    if (remaining <= 0) { expireQuery(clientId, entry); return; }
    var data = entry.startData;
    entry.startData = null;
    try { worker.postMessage(Object.assign({}, data, { sequence: entry.sequence, workerTimeoutMs: remaining })); }
    catch (cause) { failure(clientId, "worker-protocol-error", cause.message || "Search worker rejected a message."); }
  }

  function onMessage(message) {
    if (!message || typeof message.clientId !== "string") return;
    if (message.kind === "open") { open(message.clientId); return; }
    if (message.kind === "close") { release(message.clientId); return; }
    if (message.kind !== "message") return;
    var entry = workers.get(message.clientId);
    if (!entry) return;
    if (entry.deadline !== null && now() >= entry.deadline) { expireQuery(message.clientId, entry); return; }
    var data = message.data;
    if (!data || !Number.isSafeInteger(data.taskId) || message.sequence !== entry.sequence + 1 || entry.awaiting) {
      failure(message.clientId, "worker-protocol-error", "Invalid worker task sequence.");
      return;
    }
    if (entry.taskId === null && data.type === "start") {
      if (data.workerTimeoutMs !== undefined && (!Number.isSafeInteger(data.workerTimeoutMs) || data.workerTimeoutMs < 1 || data.workerTimeoutMs > POLICY.search.maxTimeoutMs)) {
        failure(message.clientId, "worker-protocol-error", "Invalid worker search deadline.");
        return;
      }
      entry.taskId = data.taskId;
      var queryTimeoutMs = data.workerTimeoutMs === undefined ? POLICY.search.defaultTimeoutMs : data.workerTimeoutMs;
      entry.deadline = now() + queryTimeoutMs;
      entry.queryTimer = setTimeout(function () { expireQuery(message.clientId, entry); }, queryTimeoutMs);
      clearTimeout(entry.timer); entry.timer = null;
      entry.sequence = message.sequence; entry.awaiting = message.sequence;
      entry.startData = data;
      enqueue(entry);
      drain();
      return;
    }
    if (data.taskId !== entry.taskId) { failure(message.clientId, "worker-protocol-error", "Worker task identity changed."); return; }
    if (entry.deadline !== null && now() >= entry.deadline) { expireQuery(message.clientId, entry); return; }
    entry.sequence = message.sequence;
    entry.awaiting = message.sequence;
    if (!entry.worker) { failure(message.clientId, "worker-protocol-error", "Search task has not acquired a Worker."); return; }
    try { entry.worker.postMessage(Object.assign({}, data, { sequence: message.sequence })); }
    catch (cause) { failure(message.clientId, "worker-protocol-error", cause.message || "Search worker rejected a message."); }
  }

  function connect() {
    if (port) return;
    try {
      port = chrome.runtime.connect({ name: "regex-rabbit-offscreen-v1" });
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(disconnect);
    } catch (ignored) { disconnect(); }
  }

  chrome.runtime.onMessage.addListener(function (message, sender) {
    if (sender.id === chrome.runtime.id && !sender.tab && message && message.target === "regex-rabbit-offscreen" && message.kind === "connect") connect();
    return false;
  });
  connect();
})();
