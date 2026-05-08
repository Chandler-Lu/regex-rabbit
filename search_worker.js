/**
 * @file src/worker/search_worker.js
 * @description Search worker for Regex Rabbit — single source for dev and prod.
 *
 * ## Dev vs Prod
 *
 * This file uses `REPLACE_ENGINE_NAME` placeholder:
 *   - Dev (root): keeps `REPLACE_ENGINE_NAME` fallback defaulting to `"ecmascript-dev"`
 *   - Prod (dist/): replaced with `"ecmascript"` via esbuild `define`
 *
 * ## Message protocol (inbound → worker)
 *
 *   { type: "start",   taskId, pattern, flags, maxMatches, maxScannedChars, maxChunkMs, policyStatus, allowUnsafeEcmascript }
 *   { type: "chunks",  taskId, chunks: [{id:number, text:string}] }
 *   { type: "finish",  taskId }
 *   { type: "cancel",  taskId }
 *   { type: "search",  taskId, pattern, flags, chunks, maxMatches, maxScannedChars, maxChunkMs, policyStatus, allowUnsafeEcmascript }
 *
 * ## Message protocol (outbound ← worker)
 *
 *   { type: "complete", taskId, engine, matches: [{chunkId,start,end,text}], totalMatches, limited }
 *   { type: "error",    taskId, code, numericCode, message }
 */

/**
 * Active search tasks, keyed by taskId.
 * @type {Object<number, Object>}
 */
var tasks = {};

/**
 * Engine name.
 *
 * At build time, esbuild's `define` replaces `REPLACE_ENGINE_NAME`
 * with the string literal `"ecmascript"`. In dev (root loaded directly),
 * REPLACE_ENGINE_NAME is undefined, so we fall back.
 *
 * The try/catch prevents esbuild from prematurely constant-folding
 * the reference to REPLACE_ENGINE_NAME before the define substitution.
 */
function engineName() {
  // esbuild define: REPLACE_ENGINE_NAME → "ecmascript" at build time
  try { return REPLACE_ENGINE_NAME; } catch (e) { return "ecmascript-dev"; }
}

function now() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function createEcmaScriptEngine(pattern, flags) {
  try {
    return { type: engineName(), regex: new RegExp(pattern, flags) };
  } catch (e) {
    return null;
  }
}

/**
 * Select and create the ECMAScript engine based on policyStatus.
 * @param {string} pattern
 * @param {string} flags
 * @param {string} policyStatus
 * @param {boolean} allowUnsafeEcmascript
 * @returns {{engine:{type:string}|null, error:{code:string,numericCode:number,message:string}|null}}
 */
function selectEngine(pattern, flags, policyStatus, allowUnsafeEcmascript) {
  if (policyStatus === "unsafe" && !allowUnsafeEcmascript) {
    return { engine: null, error: { code: "engine-unsafe-fallback-blocked", numericCode: 452, message: "Unsafe pattern blocked from ECMAScript engine." } };
  }

  var esEngine = createEcmaScriptEngine(pattern, flags);
  if (!esEngine) {
    return { engine: null, error: { code: "pattern-invalid-syntax", numericCode: 400, message: "Invalid regular expression syntax." } };
  }
  return { engine: esEngine, error: null };
}

// ── Match execution ────────────────────────────────────────────────────────

/**
 * Execute all matches of the engine against a text string.
 * @param {{type:string,regex:RegExp}} engine
 * @param {string} text
 * @param {number} maxChunkMs
 * @param {number} chunkStartedAt
 * @returns {Array<{index:number,length:number,text:string}>}
 */
function execMatches(engine, text, maxChunkMs, chunkStartedAt) {
  var results = [];
  engine.regex.lastIndex = 0;
  var match;
  while ((match = engine.regex.exec(text)) !== null) {
    results.push({ index: match.index, length: match[0].length, text: match[0] });
    if (match[0].length === 0) {
      if (engine.regex.lastIndex === match.index) engine.regex.lastIndex += 1;
      if (engine.regex.lastIndex >= text.length) break;
    }
    if (now() - chunkStartedAt > maxChunkMs) break;
  }
  return results;
}

// ── Task management ────────────────────────────────────────────────────────

/**
 * Create a new search task.
 * @param {Object} params
 * @returns {Object}
 */
function createTask(params) {
  return {
    taskId: params.taskId,
    engine: null,
    matches: [],
    totalMatches: 0,
    scannedChars: 0,
    limited: false,
    scanLimitReached: false,
    maxMatches: params.maxMatches || 5000,
    maxScannedChars: params.maxScannedChars || 50 * 1024 * 1024,
    maxChunkMs: params.maxChunkMs || 200
  };
}

// ── Message handlers ───────────────────────────────────────────────────────

function handleStart(message) {
  var task = createTask(message);
  var result = selectEngine(
    message.pattern, message.flags,
    message.policyStatus, message.allowUnsafeEcmascript
  );
  if (result.error) {
    self.postMessage({
      type: "error", taskId: message.taskId,
      code: result.error.code, numericCode: result.error.numericCode,
      message: result.error.message
    });
    return;
  }
  task.engine = result.engine;
  tasks[message.taskId] = task;
}

function handleChunks(message) {
  var task = tasks[message.taskId];
  if (!task || task.scanLimitReached) return;

  var chunks = message.chunks || [];
  for (var i = 0; i < chunks.length; i++) {
    var chunk = chunks[i];
    var chunkStartedAt = now();
    var text = chunk.text || "";
    task.scannedChars += text.length;

    if (task.scannedChars > task.maxScannedChars) {
      task.limited = true;
      task.scanLimitReached = true;
      break;
    }

    var matches = execMatches(task.engine, text, task.maxChunkMs, chunkStartedAt);
    for (var j = 0; j < matches.length; j++) {
      var m = matches[j];
      task.totalMatches += 1;
      if (task.matches.length < task.maxMatches && m.length > 0) {
        task.matches.push({ chunkId: chunk.id, start: m.index, end: m.index + m.length, text: m.text });
      } else if (task.matches.length >= task.maxMatches) {
        task.limited = true;
      }
    }

    if (now() - chunkStartedAt > task.maxChunkMs) {
      task.limited = true;
    }
  }
}

function handleFinish(message) {
  var task = tasks[message.taskId];
  if (!task) return;
  self.postMessage({
    type: "complete", taskId: task.taskId,
    engine: engineName(),
    matches: task.matches, totalMatches: task.totalMatches,
    limited: task.limited
  });
  delete tasks[message.taskId];
}

function handleCancel(message) {
  delete tasks[message.taskId];
}

function handleSearch(message) {
  handleStart(message);
  if (!tasks[message.taskId]) return;
  handleChunks({ taskId: message.taskId, chunks: message.chunks || [] });
  handleFinish(message);
}

// ── Message dispatcher ─────────────────────────────────────────────────────

self.onmessage = function (event) {
  var message = event.data;
  if (!message || typeof message.type !== "string") {
    self.postMessage({ type: "error", taskId: 0, code: "worker-protocol-error", numericCode: 530, message: "Invalid message format." });
    return;
  }

  switch (message.type) {
    case "start":   handleStart(message);   break;
    case "chunks":  handleChunks(message);  break;
    case "finish":  handleFinish(message);  break;
    case "cancel":  handleCancel(message);  break;
    case "search":  handleSearch(message);  break;
    default:
      self.postMessage({ type: "error", taskId: message.taskId || 0, code: "worker-protocol-error", numericCode: 530, message: "Unknown message type: " + message.type });
  }
};
