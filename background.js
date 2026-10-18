/** MV3 injection and authenticated offscreen Worker routing. */
"use strict";

if (typeof importScripts === "function" && !globalThis.RRRuntimePolicy) importScripts("domain/runtime_policy.js");
const POLICY = globalThis.RRRuntimePolicy;

const CONTENT_PORT = "regex-rabbit-worker-v1";
const HOST_PORT = "regex-rabbit-offscreen-v1";
const MAX_BATCH_CHARS = POLICY.transport.maxBatchChars;
const MAX_PATTERN_LENGTH = POLICY.search.maxPatternChars;
const MAX_WORKER_TIMEOUT_MS = POLICY.search.maxTimeoutMs;
const START_FIELDS = POLICY.transport.startFields;
const clients = new Map();
const injectionJobs = new Map();
let hostPort = null;
let offscreenJob = null;
let closingJob = null;
let idleTimer = null;
let nextClient = 0;
let hostWaiters = [];

function isInjectable(url) {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    if (!["http:", "https:", "file:"].includes(parsed.protocol)) return false;
    if (parsed.hostname === "chromewebstore.google.com") return false;
    if (parsed.hostname === "chrome.google.com" && /^\/webstore(?:\/|$)/.test(parsed.pathname)) return false;
    return true;
  } catch (ignored) { return false; }
}

function post(port, message) {
  try { port.postMessage(message); return true; } catch (ignored) { return false; }
}

function scheduleIdleClose() {
  if (clients.size || idleTimer !== null) return;
  idleTimer = setTimeout(function () {
    idleTimer = null;
    if (clients.size || closingJob || offscreenJob) return;
    let closeTimer = null;
    const deadline = new Promise(function (resolve, reject) {
      closeTimer = setTimeout(function () { reject(new Error("Worker host closure timed out.")); }, POLICY.transport.handshakeTimeoutMs);
    });
    const job = Promise.race([
      Promise.resolve().then(function () { return chrome.offscreen.closeDocument(); }),
      deadline
    ]).catch(function () {}).finally(function () {
      clearTimeout(closeTimer);
      if (closingJob === job) closingJob = null;
    });
    closingJob = job;
  }, POLICY.transport.idleCloseDelayMs);
}

function release(client, disconnect) {
  if (clients.get(client.routeId) !== client) return;
  clients.delete(client.routeId);
  clearTimeout(client.timer);
  client.port.onMessage.removeListener(client.listener);
  if (client.host) post(client.host, { kind: "close", clientId: client.routeId });
  if (disconnect) try { client.port.disconnect(); } catch (ignored) {}
  scheduleIdleClose();
}

function fail(client, code, message) {
  if (clients.get(client.routeId) !== client) return;
  post(client.port, { kind: "failure", clientId: client.clientId, code: code, message: message });
  release(client, true);
}

function awaitHost() {
  let entry = null;
  const promise = new Promise(function (resolve, reject) {
    if (hostPort) { resolve(hostPort); return; }
    entry = { resolve: resolve, reject: reject, timer: null };
    entry.timer = setTimeout(function () {
      hostWaiters = hostWaiters.filter(function (waiter) { return waiter !== entry; });
      reject(new Error("Worker host did not connect."));
    }, POLICY.transport.handshakeTimeoutMs);
    hostWaiters.push(entry);
  });
  promise.cancel = function (cause) {
    if (!entry || !hostWaiters.includes(entry)) return;
    hostWaiters = hostWaiters.filter(function (waiter) { return waiter !== entry; });
    clearTimeout(entry.timer);
    entry.reject(cause);
  };
  return promise;
}

async function ensureOffscreen() {
  if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
  if (closingJob) await closingJob;
  if (hostPort) return hostPort;
  if (offscreenJob) return offscreenJob;
  const waiting = awaitHost();
  let cancelled = false;
  let startupTimer = null;
  const initializing = (async function () {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [chrome.runtime.getURL("offscreen.html")] });
    if (cancelled) return;
    if (!contexts.length) {
      await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["WORKERS"], justification: "Run bounded regular-expression searches in disposable extension Workers, independent of page CSP." });
    } else if (!hostPort) {
      await chrome.runtime.sendMessage({ target: "regex-rabbit-offscreen", kind: "connect" }).catch(function () {});
    }
  })();
  // A connected host can resolve waiting before a Chrome API call settles.
  // Bound the entire startup independently so a stalled API cannot retain its job.
  const deadline = new Promise(function (resolve, reject) {
    startupTimer = setTimeout(function () { reject(new Error("Worker host startup timed out.")); }, POLICY.transport.handshakeTimeoutMs);
  });
  const job = Promise.race([
    Promise.all([initializing, waiting]).then(function (results) { return results[1]; }),
    deadline
  ]).catch(function (cause) {
    cancelled = true;
    waiting.cancel(cause);
    throw cause;
  }).finally(function () {
    cancelled = true;
    clearTimeout(startupTimer);
    if (offscreenJob === job) { offscreenJob = null; scheduleIdleClose(); }
  });
  offscreenJob = job;
  return job;
}

function isContentSender(sender) {
  return sender && sender.id === chrome.runtime.id && sender.tab && Number.isInteger(sender.tab.id) && sender.tab.id >= 0 && sender.frameId === 0 && typeof sender.documentId === "string" && sender.documentId.length > 0 && isInjectable(sender.url);
}

function validStream(stream, textLength) {
  return !!stream && typeof stream === "object" && !Array.isArray(stream) &&
    Number.isSafeInteger(stream.runId) && stream.runId >= 0 &&
    Number.isSafeInteger(stream.offset) && stream.offset >= 0 &&
    Number.isSafeInteger(stream.ownedStart) && Number.isSafeInteger(stream.ownedEnd) &&
    stream.offset <= stream.ownedStart && stream.ownedStart <= stream.ownedEnd &&
    stream.offset <= Number.MAX_SAFE_INTEGER - textLength && stream.ownedEnd <= stream.offset + textLength &&
    typeof stream.first === "boolean" && typeof stream.last === "boolean";
}

function validSource(source, chunkId, textLength) {
  return !!source && typeof source === "object" && !Array.isArray(source) &&
    Number.isSafeInteger(source.runId) && source.runId >= 0 &&
    Number.isSafeInteger(source.offset) && source.offset >= 0 &&
    source.offset <= Number.MAX_SAFE_INTEGER - textLength &&
    typeof source.first === "boolean" && typeof source.last === "boolean" &&
    (!source.first || source.offset === 0 && source.runId === chunkId);
}

function routeMessage(data) {
  const routed = { type: data.type, taskId: data.taskId };
  const fields = data.type === "start" ? START_FIELDS : ["batchId", "limitReason"];
  fields.forEach(function (key) { if (data[key] !== undefined) routed[key] = data[key]; });
  if (data.type !== "chunks") return routed;
  routed.chunks = data.chunks.map(function (chunk) {
    const item = { id: chunk.id, text: chunk.text };
    if (chunk.stream !== undefined) {
      const stream = chunk.stream;
      item.stream = { runId: stream.runId, offset: stream.offset, ownedStart: stream.ownedStart,
        ownedEnd: stream.ownedEnd, first: stream.first, last: stream.last };
    }
    if (chunk.source !== undefined) {
      const source = chunk.source;
      item.source = { runId: source.runId, offset: source.offset, first: source.first, last: source.last };
    }
    return item;
  });
  return routed;
}

function validMessage(client, envelope) {
  if (!envelope || envelope.kind !== "message" || envelope.clientId !== client.clientId || !Number.isSafeInteger(envelope.sequence) || envelope.sequence !== client.sequence + 1 || client.awaiting) return false;
  const data = envelope.data;
  if (!data || !Number.isSafeInteger(data.taskId) || data.taskId < 0) return false;
  if (data.workerTimeoutMs !== undefined && (data.type !== "start" || !Number.isSafeInteger(data.workerTimeoutMs) || data.workerTimeoutMs <= 0 || data.workerTimeoutMs > MAX_WORKER_TIMEOUT_MS)) return false;
  if (data.analyzeInWorker !== undefined && (data.type !== "start" || typeof data.analyzeInWorker !== "boolean")) return false;
  if (client.taskId === null) {
    if (data.type !== "start" || typeof data.pattern !== "string" || data.pattern.length > MAX_PATTERN_LENGTH || (data.flags !== undefined && (typeof data.flags !== "string" || data.flags.length > POLICY.transport.maxFlagsChars))) return false;
    client.taskId = data.taskId;
  } else if (data.taskId !== client.taskId || !["chunks", "finish", "cancel"].includes(data.type)) return false;
  if (data.type !== "start" && START_FIELDS.some(function (key) { return data[key] !== undefined; })) return false;
  if (data.type === "chunks") {
    if (!Array.isArray(data.chunks) || data.chunks.length > POLICY.transport.maxBatchNodes) return false;
    let chars = 0;
    for (const chunk of data.chunks) {
      if (!chunk || !Number.isSafeInteger(chunk.id) || chunk.id < 0 || typeof chunk.text !== "string") return false;
      if (chunk.stream !== undefined && chunk.source !== undefined) return false;
      if (chunk.stream !== undefined && !validStream(chunk.stream, chunk.text.length)) return false;
      if (chunk.source !== undefined && !validSource(chunk.source, chunk.id, chunk.text.length)) return false;
      chars += chunk.text.length;
      if (chars > MAX_BATCH_CHARS) return false;
    }
  }
  return true;
}

function connectContent(port) {
  if (!isContentSender(port.sender)) {
    let timer = setTimeout(function () { try { port.disconnect(); } catch (ignored) {} }, POLICY.transport.rejectedPortTimeoutMs);
    const reject = function (message) {
      clearTimeout(timer);
      port.onMessage.removeListener(reject);
      if (message && typeof message.clientId === "string") post(port, { kind: "failure", clientId: message.clientId, code: "worker-busy", message: "Worker connection is unavailable." });
      try { port.disconnect(); } catch (ignored) {}
    };
    port.onMessage.addListener(reject);
    port.onDisconnect.addListener(function () { clearTimeout(timer); port.onMessage.removeListener(reject); });
    return;
  }
  const client = { port: port, clientId: null, routeId: "host-" + (++nextClient), host: null, taskId: null, sequence: 0, awaiting: 0, ready: false, timer: null, listener: null };
  clients.set(client.routeId, client);
  client.timer = setTimeout(function () { fail(client, "worker-spawn-failed", "Search connection handshake timed out."); }, POLICY.transport.handshakeTimeoutMs);
  client.listener = function (message) {
    if (client.clientId === null) {
      if (!message || message.kind !== "open" || typeof message.clientId !== "string" || message.clientId.length < 1 || message.clientId.length > POLICY.transport.maxMetadataChars) { release(client, true); return; }
      client.clientId = message.clientId;
      ensureOffscreen().then(function (host) {
        if (clients.get(client.routeId) !== client) return;
        client.host = host;
        if (!post(host, { kind: "open", clientId: client.routeId })) fail(client, "worker-disconnected", "Worker host disconnected.");
      }).catch(function (cause) { fail(client, "worker-spawn-failed", cause.message || "Worker host creation failed."); });
      return;
    }
    if (!client.ready || !validMessage(client, message)) { fail(client, "worker-protocol-error", "Invalid search worker message."); return; }
    if (message.data.type === "start") {
      clearTimeout(client.timer);
      const timeout = message.data.workerTimeoutMs === undefined ? POLICY.search.defaultTimeoutMs : message.data.workerTimeoutMs;
      client.timer = setTimeout(function () { fail(client, "search-timeout", "Search connection exceeded its lifetime."); }, Math.max(POLICY.transport.unusedRouteTimeoutMs, timeout + POLICY.transport.disconnectedRouteGraceMs));
    }
    client.sequence = message.sequence;
    client.awaiting = message.sequence;
    if (!client.host || client.host !== hostPort || !post(client.host, { kind: "message", clientId: client.routeId, sequence: message.sequence, data: routeMessage(message.data) })) fail(client, "worker-disconnected", "Worker host disconnected.");
  };
  port.onMessage.addListener(client.listener);
  port.onDisconnect.addListener(function () { void chrome.runtime.lastError; release(client, false); });
}

function connectHost(port) {
  const sender = port.sender;
  if (!sender || sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL("offscreen.html") || hostPort) { try { port.disconnect(); } catch (ignored) {} return; }
  hostPort = port;
  hostWaiters.splice(0).forEach(function (entry) { clearTimeout(entry.timer); entry.resolve(port); });
  port.onMessage.addListener(function (message) {
    if (hostPort !== port || !message || message.kind === "ping") return;
    const client = clients.get(message.clientId);
    if (!client || client.host !== port) return;
    if (message.kind === "ready") {
      if (client.ready) return;
      client.ready = true;
      clearTimeout(client.timer);
      client.timer = setTimeout(function () { fail(client, "search-timeout", "Search connection exceeded its lifetime."); }, POLICY.transport.unusedRouteTimeoutMs);
    }
    else if (message.kind === "ack") {
      if (message.sequence !== client.awaiting) return;
      client.awaiting = 0;
    } else if (message.kind === "failure") { fail(client, message.code || "worker-crashed", message.message || "Search worker failed."); return; }
    else if (message.kind === "message") {
      if (!message.data || message.data.taskId !== client.taskId) return;
    } else return;
    if (!post(client.port, Object.assign({}, message, { clientId: client.clientId }))) release(client, true);
    else if (message.kind === "message" && ["complete", "error"].includes(message.data.type)) release(client, false);
  });
  port.onDisconnect.addListener(function () {
    void chrome.runtime.lastError;
    if (hostPort !== port) return;
    hostPort = null;
    Array.from(clients.values()).forEach(function (client) {
      if (client.host === port) fail(client, "worker-disconnected", "Worker host connection closed.");
    });
  });
  scheduleIdleClose();
}

chrome.runtime.onConnect.addListener(function (port) {
  if (port.name === CONTENT_PORT) connectContent(port);
  else if (port.name === HOST_PORT) connectHost(port);
  else try { port.disconnect(); } catch (ignored) {}
});

// The toolbar opens the extension's own settings without reading page URLs.
if (chrome.runtime.onMessage && typeof chrome.runtime.openOptionsPage === "function") {
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.action !== "regexRabbitOpenOptions" || !isContentSender(sender)) return false;
    Promise.resolve().then(function () { return chrome.runtime.openOptionsPage(); }).then(function () {
      sendResponse({ ok: true });
    }, function () { sendResponse({ ok: false }); });
    return true;
  });
}

async function injectScripts(tabId) {
  if (injectionJobs.has(tabId)) return injectionJobs.get(tabId);
  const job = (async function () {
    try {
      const ping = await chrome.tabs.sendMessage(tabId, { action: "regexRabbitPing" }, { frameId: 0 }).catch(function () { return null; });
      if (ping && ping.loaded === true) return true;
      const target = { tabId: tabId, frameIds: [0] };
      await chrome.scripting.removeCSS({ target: target, files: ["style.css"], origin: "AUTHOR" }).catch(function () {});
      await chrome.scripting.removeCSS({ target: target, files: ["style.css"], origin: "USER" }).catch(function () {});
      await chrome.scripting.insertCSS({ target: target, files: ["style.css"], origin: "USER" });
      await chrome.scripting.executeScript({ target: target, files: [
        "domain/runtime_policy.js", "infra/ui_i18n.js", "domain/error_registry.js", "domain/runtime_config.js", "domain/pattern_analyzer.js", "domain/display_formatter.js",
        "infra/task_scheduler.js", "infra/page_visibility.js", "infra/selection_capture.js", "infra/text_mapping.js", "infra/text_collector.js", "infra/highlight_engine.js", "infra/worker_transport.js",
        "infra/worker_manager.js", "infra/dynamic_observer.js", "infra/search_controller.js", "infra/search_toolbar.js", "infra/toolbar_position.js", "content_script.js"
      ] });
      return true;
    } catch (cause) { console.warn("[RegexRabbit] Injection failed:", tabId, cause.message); return false; }
  })().finally(function () { injectionJobs.delete(tabId); });
  injectionJobs.set(tabId, job);
  return job;
}

async function sendToggle(tabId) {
  await chrome.tabs.sendMessage(tabId, { action: "toggleSearch" }, { frameId: 0 });
}

async function toggle() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !Number.isInteger(tab.id) || !isInjectable(tab.url)) return;
    if (await injectScripts(tab.id)) await sendToggle(tab.id);
  } catch (cause) { console.warn("[RegexRabbit] Toggle failed:", cause.message); }
}

chrome.action.onClicked.addListener(toggle);
chrome.commands.onCommand.addListener(function (command) { if (command === "_execute_action") toggle(); });
