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
 *   { type: "complete", taskId, engine, matches: [{chunkId,start,end}], totalMatches, limited }
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
    var literal = createLiteralEngine(pattern, flags);
    if (literal) return literal;
    return { type: engineName(), regex: new RegExp(pattern, flags) };
  } catch (e) {
    return null;
  }
}

function createLiteralEngine(pattern, flags) {
  flags = flags || "";
  if (!pattern || flags.indexOf("i") !== -1 || flags.indexOf("y") !== -1) return null;
  if (/[\\^$.*+?()[\]{}|]/.test(pattern)) return null;
  return { type: "literal", literal: pattern };
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

function scanChunk(task, chunk, chunkStartedAt) {
  if (task.engine.type === "literal") {
    scanLiteralChunk(task, chunk, chunkStartedAt);
    return;
  }

  var text = chunk.text || "";
  var regex = task.engine.regex;
  regex.lastIndex = 0;
  var match;

  while ((match = regex.exec(text)) !== null) {
    var length = match[0].length;

    if (length > 0) {
      task.totalMatches += 1;
      if (task.matches.length < task.maxMatches) {
        task.matches.push({ chunkId: chunk.id, start: match.index, end: match.index + length });
        if (task.matches.length >= task.maxMatches) {
          task.limited = true;
          task.scanLimitReached = true;
          break;
        }
      } else {
        task.limited = true;
        task.scanLimitReached = true;
        break;
      }
    }

    if (length === 0) {
      if (regex.lastIndex === match.index) regex.lastIndex += 1;
      if (regex.lastIndex >= text.length) break;
    }

    if (now() - chunkStartedAt > task.maxChunkMs) {
      task.limited = true;
      task.scanLimitReached = true;
      break;
    }
  }
}

function scanLiteralChunk(task, chunk, chunkStartedAt) {
  var text = chunk.text || "";
  var needle = task.engine.literal;
  var needleLength = needle.length;
  var from = 0;
  var index;

  while ((index = text.indexOf(needle, from)) !== -1) {
    task.totalMatches += 1;
    if (task.matches.length < task.maxMatches) {
      task.matches.push({ chunkId: chunk.id, start: index, end: index + needleLength });
      if (task.matches.length >= task.maxMatches) {
        task.limited = true;
        task.scanLimitReached = true;
        break;
      }
    } else {
      task.limited = true;
      task.scanLimitReached = true;
      break;
    }

    from = index + needleLength;
    if (now() - chunkStartedAt > task.maxChunkMs) {
      task.limited = true;
      task.scanLimitReached = true;
      break;
    }
  }
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
    maxScannedChars: params.maxScannedChars || 256 * 1024 * 1024,
    maxChunkMs: params.maxChunkMs || 250
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

    scanChunk(task, chunk, chunkStartedAt);
    if (task.scanLimitReached) break;
  }

  if (task.scanLimitReached) completeTask(task);
}

function handleFinish(message) {
  var task = tasks[message.taskId];
  if (!task) return;
  completeTask(task);
}

function completeTask(task) {
  self.postMessage({
    type: "complete", taskId: task.taskId,
    engine: task.engine && task.engine.type ? task.engine.type : engineName(),
    matches: task.matches, totalMatches: task.totalMatches,
    limited: task.limited
  });
  delete tasks[task.taskId];
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
