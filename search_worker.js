/** Bounded matching worker. Native RegExp execution is isolated and externally terminable. */
"use strict";

if (typeof importScripts === "function") {
  if (!globalThis.RRRuntimePolicy) importScripts("domain/runtime_policy.js");
  if (!globalThis.RRPatternAnalyzer) importScripts("domain/pattern_analyzer.js");
  if (!globalThis.RRLiteralMatcher) importScripts("domain/literal_matcher.js");
}

var POLICY = globalThis.RRRuntimePolicy;
var tasks = Object.create(null);
var activeTaskId = null;
var WORD_CHARACTER = /[\p{L}\p{N}\p{M}\p{Pc}\u200C\u200D]/u;
var legacyWordSource = null;
var DEFAULT_LIMITS = {
  maxMatches: POLICY.search.defaultMatches, maxScannedChars: POLICY.search.defaultScannedChars,
  maxBatchChars: POLICY.transport.maxBatchChars, maxBatchNodes: POLICY.transport.maxBatchNodes
};
var HARD_LIMITS = {
  maxMatches: POLICY.search.maxWorkerMatches, maxScannedChars: POLICY.search.maxScannedChars,
  maxBatchChars: POLICY.transport.maxBatchChars, maxBatchNodes: POLICY.transport.maxBatchNodes
};
var PHYSICAL_CHUNK_LIMIT = POLICY.transport.maxBatchChars;

function engineName() {
  try { return REPLACE_ENGINE_NAME; } catch (ignored) { return "ecmascript-dev"; }
}
function validId(value) { return Number.isSafeInteger(value) && value >= 0; }
function protocolError(message) {
  return { code: "worker-protocol-error", numericCode: POLICY.errors.protocol, message: message };
}
function reportError(taskId, failure) {
  var message = typeof failure.message === "string" ? failure.message : "Invalid worker request.";
  if (message.length > POLICY.diagnostics.maxMessageChars) message = message.slice(0, POLICY.diagnostics.messageHeadChars) + "… " + message.slice(-POLICY.diagnostics.messageTailChars);
  self.postMessage({ type: "error", taskId: validId(taskId) ? taskId : 0,
    code: failure.code || "worker-protocol-error", numericCode: failure.numericCode || POLICY.errors.protocol,
    message: message });
  delete tasks[taskId];
  if (activeTaskId === taskId) activeTaskId = null;
}
function readLimit(message, key) {
  var value = message[key];
  if (value === undefined) return DEFAULT_LIMITS[key];
  if (!Number.isSafeInteger(value) || value <= 0 || value > HARD_LIMITS[key]) throw protocolError("Invalid limit: " + key);
  return value;
}
function advanceStringIndex(text, index, unicode) {
  if (!unicode || index + 1 >= text.length) return index + 1;
  var first = text.charCodeAt(index), second = text.charCodeAt(index + 1);
  return first >= 0xD800 && first <= 0xDBFF && second >= 0xDC00 && second <= 0xDFFF ? index + 2 : index + 1;
}
function characterBefore(text, index) {
  if (index <= 0) return "";
  var start = index - 1;
  var last = text.charCodeAt(start);
  if (last >= 0xDC00 && last <= 0xDFFF && start > 0) {
    var first = text.charCodeAt(start - 1);
    if (first >= 0xD800 && first <= 0xDBFF) start--;
  }
  return text.slice(start, index);
}
function acceptsMatch(task, text, start, end) {
  if (!task.wholeWord) return true;
  var before = characterBefore(text, start);
  var after = end < text.length ? String.fromCodePoint(text.codePointAt(end)) : "";
  return !WORD_CHARACTER.test(before) && !WORD_CHARACTER.test(after);
}
function markLimited(task, reason, stop) {
  task.limited = true;
  task.limitReason = task.limitReason || reason;
  if (stop) task.stopped = true;
}
function recordMatch(task, chunk, start, end) {
  if (!acceptsMatch(task, chunk.text, start, end)) return false;
  task.matches.push({ chunkId: chunk.id, start: start, end: end });
  if (task.batchMatchedIds) task.batchMatchedIds.add(chunk.id);
  if (task.batchMatchedIntervals) task.batchMatchedIntervals.push({ chunkId: chunk.id, start: start, end: end });
  task.totalMatches++;
  if (task.matches.length >= task.maxMatches) markLimited(task, "max-matches", true);
  return true;
}

function hasUnpairedSurrogate(text) {
  for (var index = 0; index < text.length; index++) {
    var value = text.charCodeAt(index);
    if (value >= 0xD800 && value <= 0xDBFF) {
      var next = text.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) index++;
      else return true;
    } else if (value >= 0xDC00 && value <= 0xDFFF) return true;
  }
  return false;
}
function hexEscape(value) { return "\\u" + value.toString(16).padStart(4, "0"); }
function wordRanges(first, last, high) {
  var ranges = [], start = -1;
  for (var value = first; value <= last + 1; value++) {
    var word = value <= last && WORD_CHARACTER.test(high === undefined ? String.fromCharCode(value) : String.fromCharCode(high, value));
    if (word && start < 0) start = value;
    else if (!word && start >= 0) {
      ranges.push(hexEscape(start) + (value - 1 > start ? "-" + hexEscape(value - 1) : ""));
      start = -1;
    }
  }
  return ranges.join("");
}
function wholeWordSource(unicode) {
  if (unicode) return "[\\p{L}\\p{N}\\p{M}\\p{Pc}\\u200C\\u200D]";
  if (legacyWordSource !== null) return legacyWordSource;
  // Keep the original non-Unicode regexp grammar and UTF-16 semantics. Build
  // equivalent word-character ranges only for this uncommon compatibility path;
  // the fixed Unicode alphabet bounds both work and memory, inside the Worker.
  var parts = ["[" + wordRanges(0, 0xFFFF) + "]"];
  var previous = null, firstHigh = 0;
  function append(lastHigh) {
    if (!previous) return;
    var prefix = firstHigh === lastHigh ? hexEscape(firstHigh) : "[" + hexEscape(firstHigh) + "-" + hexEscape(lastHigh) + "]";
    parts.push(prefix + "[" + previous + "]");
  }
  for (var high = 0xD800; high <= 0xDBFF + 1; high++) {
    var current = high <= 0xDBFF ? wordRanges(0xDC00, 0xDFFF, high) : null;
    if (current !== previous) { append(high - 1); previous = current; firstHigh = high; }
  }
  legacyWordSource = "(?:" + parts.join("|") + ")";
  return legacyWordSource;
}
function isFixedString(pattern, mode) {
  return mode === "literal" || !!pattern && !/[\\^$.*+?()[\]{}|]/.test(pattern);
}
function engineFailure(cause) {
  if (cause.code) return cause;
  var message = typeof cause.message === "string" ? cause.message : "Invalid regular expression syntax.";
  var tooLarge = /too (?:large|big)|maximum|allocation|out of memory/i.test(message);
  if (message.length > POLICY.diagnostics.maxMessageChars) message = "Regular expression could not be compiled: " + message.slice(-POLICY.diagnostics.messageTailChars);
  return { code: tooLarge ? "engine-pattern-too-large" : "pattern-invalid-syntax", numericCode: tooLarge ? POLICY.errors.patternTooLarge : POLICY.errors.invalidPattern, message: message };
}
function createEngine(pattern, flags, mode, policyStatus, allowUnsafe, wholeWord) {
  if (mode !== "literal" && policyStatus === "unsafe" && !allowUnsafe) {
    throw { code: "engine-unsafe-fallback-blocked", numericCode: POLICY.errors.unsafeEngine, message: "Unsafe pattern blocked from ECMAScript engine." };
  }
  try {
    // Validate original flags before normalization; always scan globally, even without g.
    new RegExp("", flags);
    if (mode === "literal" && !pattern) return { type: "literal", literal: "", fixed: true, sticky: false };
    var unicode = flags.indexOf("u") !== -1 || flags.indexOf("v") !== -1;
    if (isFixedString(pattern, mode)) {
      var fixed = { type: "literal", fixed: true, literal: pattern, sticky: flags.indexOf("y") !== -1, unicode: unicode };
      if (flags.indexOf("i") !== -1 || unicode && hasUnpairedSurrogate(pattern)) {
        if (!globalThis.RRLiteralMatcher) throw protocolError("Fixed-string matcher is unavailable.");
        fixed.matcher = RRLiteralMatcher.compile(pattern, flags);
      }
      return fixed;
    }
    // Main-thread screening of long sources is deferred; short sources may
    // also come through a forged protocol request. Independently validate every
    // non-fixed expression inside the disposable Worker.
    if (!globalThis.RRPatternAnalyzer) throw protocolError("Pattern analyzer is unavailable.");
    var analyzed = RRPatternAnalyzer.analyzeInWorker(pattern, flags, { mode: mode });
    if (analyzed.status === "invalid") {
      throw engineFailure({ message: analyzed.reasons[0] || "Invalid regular expression syntax." });
    }
    if (!analyzed.ok && !allowUnsafe) throw { code: "pattern-unsafe-blocked", numericCode: POLICY.errors.unsafePattern, message: "Unsafe pattern blocked." };
    // Validate before adding assertions so captures, backreferences and the
    // original flags retain their native syntax. Assertions allow the engine to
    // try another alternative or length at the same start when word checks fail.
    if (wholeWord) {
      var words = wholeWordSource(unicode);
      pattern = "(?<!" + words + ")(?:" + pattern + ")(?!" + words + ")";
    }
    return { type: engineName(), regex: new RegExp(pattern, flags.indexOf("g") === -1 ? flags + "g" : flags) };
  } catch (cause) {
    throw engineFailure(cause);
  }
}
function scanLiteral(task, chunk) {
  var needle = task.engine.literal;
  if (!needle) return;
  var stream = chunk.stream;
  var globalFrom = stream ? Math.max(stream.ownedStart, task.streamRun.nextGlobalOffset) : 0;
  var from = stream ? globalFrom - stream.offset : 0, index;
  function accept(index, end) {
    var globalIndex = stream ? stream.offset + index : index;
    if (stream && globalIndex >= stream.ownedEnd) return "stop";
    if (task.engine.sticky && globalIndex !== globalFrom) {
      if (stream) task.streamRun.stickyStopped = true;
      return "stop";
    }
    var accepted = recordMatch(task, chunk, index, end);
    if (task.stopped) return "stop";
    if (accepted) {
      globalFrom = stream ? stream.offset + end : end;
      if (stream) task.streamRun.nextGlobalOffset = globalFrom;
      return "accepted";
    }
    if (task.engine.sticky) {
      if (stream) task.streamRun.stickyStopped = true;
      return "stop";
    }
    return "rejected";
  }
  if (stream && task.streamRun.stickyStopped) return;
  if (task.engine.matcher) {
    task.engine.matcher.scan(chunk.text, from, accept);
    if (stream && task.engine.sticky && globalFrom < stream.ownedEnd) task.streamRun.stickyStopped = true;
    return;
  }
  while ((index = task.engine.sticky ? chunk.text.startsWith(needle, from) ? from : -1 : chunk.text.indexOf(needle, from)) !== -1) {
    var decision = accept(index, index + needle.length);
    if (decision === "stop") break;
    from = decision === "accepted" ? index + needle.length : advanceStringIndex(chunk.text, index, task.engine.unicode);
  }
  if (stream && task.engine.sticky && globalFrom < stream.ownedEnd) task.streamRun.stickyStopped = true;
}
function scanRegex(task, chunk) {
  var regex = task.engine.regex;
  regex.lastIndex = 0;
  var match;
  while (true) {
    try { match = regex.exec(chunk.text); }
    catch (cause) { throw engineFailure(cause); }
    if (match === null) break;
    var length = match[0].length;
    if (length > 0) recordMatch(task, chunk, match.index, match.index + length);
    else regex.lastIndex = advanceStringIndex(chunk.text, match.index, regex.unicode || regex.unicodeSets);
    if (task.stopped || regex.lastIndex > chunk.text.length) break;
  }
}

function handleStart(message) {
  if (activeTaskId !== null) throw protocolError("Only one active task is allowed per worker.");
  if (typeof message.pattern !== "string" || message.pattern.length > POLICY.search.maxPatternChars ||
      (message.flags !== undefined && (typeof message.flags !== "string" || message.flags.length > POLICY.transport.maxFlagsChars)) ||
      (message.mode !== undefined && message.mode !== "literal" && message.mode !== "regex") ||
      (message.policyStatus !== undefined && message.policyStatus !== "safe" && message.policyStatus !== "unsafe" && message.policyStatus !== "deferred") ||
      (message.allowUnsafeEcmascript !== undefined && typeof message.allowUnsafeEcmascript !== "boolean") ||
      (message.acknowledged !== undefined && typeof message.acknowledged !== "boolean") ||
      (message.wholeWord !== undefined && typeof message.wholeWord !== "boolean")) throw protocolError("Invalid search parameters.");
  var task = {
    taskId: message.taskId, engine: null, matches: [], totalMatches: 0,
    scannedChars: 0, scannedNodes: 0, limited: false, limitReason: null,
    stopped: false, acknowledged: message.acknowledged === true,
    wholeWord: message.wholeWord === true, streamRun: null, streamRuns: new Map(), sourceRuns: new Map(), lastChunkId: -1
  };
  Object.keys(DEFAULT_LIMITS).forEach(function (key) { task[key] = readLimit(message, key); });
  task.engine = createEngine(message.pattern, message.flags || "", message.mode || "regex", message.policyStatus || "safe", message.allowUnsafeEcmascript === true, task.wholeWord);
  tasks[message.taskId] = task;
  activeTaskId = message.taskId;
}
function validStream(stream, chunk, task) {
  if (!stream || typeof stream !== "object" || Array.isArray(stream) || !task.engine.fixed ||
      !validId(stream.runId) || !validId(stream.offset) || !validId(stream.ownedStart) || !validId(stream.ownedEnd) ||
      typeof stream.first !== "boolean" || typeof stream.last !== "boolean" ||
      stream.ownedEnd <= stream.ownedStart || stream.offset > stream.ownedStart ||
      !Number.isSafeInteger(stream.offset + chunk.text.length) || stream.ownedEnd > stream.offset + chunk.text.length) return false;
  if (stream.first && (stream.offset !== 0 || stream.ownedStart !== 0)) return false;
  if (task.engine.unicode) {
    var start = stream.ownedStart - stream.offset, end = stream.ownedEnd - stream.offset;
    function cutsPair(index) {
      return index > 0 && index < chunk.text.length && chunk.text.charCodeAt(index - 1) >= 0xD800 &&
        chunk.text.charCodeAt(index - 1) <= 0xDBFF && chunk.text.charCodeAt(index) >= 0xDC00 && chunk.text.charCodeAt(index) <= 0xDFFF;
    }
    if (cutsPair(start) || cutsPair(end)) return false;
  }
  // Whole-word checks and Unicode matching need genuine preceding context.
  if (!stream.first && stream.offset > Math.max(0, stream.ownedStart - POLICY.text.boundaryContextChars)) return false;
  var windowEnd = stream.offset + chunk.text.length;
  // last describes the actual right boundary of the logical run, not the last
  // owned partition. Several overlapping tail windows may touch that boundary.
  if (stream.last) return true;
  // Every start in this partition must have enough right context to decide the
  // complete literal and the following Unicode word character.
  return windowEnd - stream.ownedEnd >= task.engine.literal.length + POLICY.text.boundaryContextChars;
}
function validSource(source, chunk) {
  return !!source && typeof source === "object" && !Array.isArray(source) && validId(source.runId) && validId(source.offset) &&
    typeof source.first === "boolean" && typeof source.last === "boolean" &&
    Number.isSafeInteger(source.offset + chunk.text.length) &&
    (!source.first || source.offset === 0 && source.runId === chunk.id) && (chunk.text.length > 0 || source.last);
}
function scanChunk(task, chunk) {
  if (task.engine.regex) scanRegex(task, chunk);
  else scanLiteral(task, chunk);
}
function acceptSourceFragment(task, chunk) {
  var source = chunk.source;
  if (source.first) {
    if (task.sourceRuns.has(source.runId)) throw protocolError("Logical source is already active.");
    task.sourceRuns.set(source.runId, { length: 0, text: "" });
  }
  var run = task.sourceRuns.get(source.runId);
  if (!run || run.length !== source.offset) throw protocolError("Noncontiguous logical source fragment.");
  // V8 keeps this as a rope until matching needs the complete source. Native
  // String length/allocation failures surface immediately; there is no plugin
  // quota on complete logical-source length.
  try { run.text += chunk.text; }
  catch (cause) {
    throw { code: "engine-text-too-large", numericCode: POLICY.errors.textTooLarge, message: "The browser cannot assemble this complete text source." };
  }
  run.length += chunk.text.length;
  if (!source.last) return;
  var text = run.text;
  // Free assembler references before matching. Assertions/backreferences/sticky
  // semantics always see the complete original logical source exactly once.
  task.sourceRuns.delete(source.runId);
  run.text = "";
  if (task.batchCompletedSourceIds) task.batchCompletedSourceIds.push(source.runId);
  scanChunk(task, { id: source.runId, text: text });
}
function handleChunks(message) {
  var task = tasks[message.taskId];
  if (!task) return;
  if (!Array.isArray(message.chunks) || message.chunks.length > task.maxBatchNodes ||
      (task.acknowledged && !validId(message.batchId))) throw protocolError("Invalid search batch.");
  // Validate the complete batch before scanning any part; malformed inputs never coerce.
  var batchChars = 0;
  var lastChunkId = task.lastChunkId;
  for (var index = 0; index < message.chunks.length; index++) {
    var chunk = message.chunks[index];
    if (!chunk || !validId(chunk.id) || chunk.id <= lastChunkId || typeof chunk.text !== "string" || chunk.text.length > PHYSICAL_CHUNK_LIMIT ||
        chunk.stream !== undefined && chunk.source !== undefined ||
        chunk.stream !== undefined && !validStream(chunk.stream, chunk, task) ||
        chunk.source !== undefined && !validSource(chunk.source, chunk)) throw protocolError("Invalid search chunk.");
    lastChunkId = chunk.id;
    batchChars += chunk.text.length;
    if (batchChars > task.maxBatchChars) throw protocolError("Search batch exceeds character budget.");
  }
  task.lastChunkId = lastChunkId;
  task.batchMatchedIds = task.acknowledged ? new Set() : null;
  task.batchMatchedIntervals = task.acknowledged ? [] : null;
  task.batchCompletedSourceIds = [];
  for (var i = 0; i < message.chunks.length && !task.stopped; i++) {
    var item = message.chunks[i];
    var stream = item.stream, chars = stream ? stream.ownedEnd - stream.ownedStart : item.text.length;
    if (stream) {
      if (stream.first) {
        if (task.streamRuns.has(stream.runId)) throw protocolError("Logical text run is already active.");
        task.streamRuns.set(stream.runId, { runId: stream.runId, ownedEnd: 0, runEnd: null, nextGlobalOffset: 0, stickyStopped: false });
      }
      task.streamRun = task.streamRuns.get(stream.runId);
      if (!task.streamRun || task.streamRun.ownedEnd !== stream.ownedStart) {
        throw protocolError("Noncontiguous logical text window.");
      }
      var windowEnd = stream.offset + item.text.length;
      if (task.streamRun.runEnd !== null && (windowEnd > task.streamRun.runEnd ||
          stream.last && windowEnd !== task.streamRun.runEnd || !stream.last && windowEnd === task.streamRun.runEnd)) {
        throw protocolError("Inconsistent logical text boundary.");
      }
      if (stream.last) task.streamRun.runEnd = windowEnd;
    }
    if (task.scannedChars + chars > task.maxScannedChars) { markLimited(task, "max-scanned-chars", true); break; }
    task.scannedChars += chars;
    if (item.source ? item.source.first : !stream || stream.first) {
      var scannedNodes = task.scannedNodes + 1;
      if (!validId(scannedNodes)) throw protocolError("Invalid scanned source statistics.");
      task.scannedNodes = scannedNodes;
    }
    if (item.source) acceptSourceFragment(task, item);
    else scanChunk(task, item);
    if (stream) {
      task.streamRun.ownedEnd = stream.ownedEnd;
      if (task.streamRun.runEnd === stream.ownedEnd) task.streamRuns.delete(stream.runId);
      task.streamRun = null;
    }
  }
  if (task.acknowledged) self.postMessage({ type: "ack", taskId: task.taskId, batchId: message.batchId,
    scannedChars: task.scannedChars, stopped: task.stopped,
    limited: task.limited, limitReason: task.limitReason,
    matchedChunkIds: Array.from(task.batchMatchedIds), matchedIntervals: task.batchMatchedIntervals,
    completedSourceIds: task.batchCompletedSourceIds });
  task.batchMatchedIds = null;
  task.batchMatchedIntervals = null;
  task.lastBatchCompletedSourceIds = task.batchCompletedSourceIds.slice();
  task.batchCompletedSourceIds = null;
  if (task.stopped) completeTask(task);
}
function completeTask(task) {
  self.postMessage({ type: "complete", taskId: task.taskId, engine: task.engine.type,
    matches: task.matches, totalMatches: task.totalMatches,
    scannedChars: task.scannedChars, scannedNodes: task.scannedNodes,
    limited: task.limited, limitReason: task.limitReason,
    completedSourceIds: task.lastBatchCompletedSourceIds || [] });
  delete tasks[task.taskId];
  if (activeTaskId === task.taskId) activeTaskId = null;
}
function handleFinish(message) {
  var task = tasks[message.taskId];
  if (!task) return;
  if (message.limitReason !== undefined && message.limitReason !== null) {
    if (["max-scanned-chars", "collection-budget"].indexOf(message.limitReason) === -1) throw protocolError("Invalid limit reason.");
    markLimited(task, message.limitReason, false);
  }
  if ((task.streamRuns.size || task.sourceRuns.size) && !task.limited) throw protocolError("Unfinished logical text source.");
  completeTask(task);
}
function handleCancel(message) {
  delete tasks[message.taskId];
  if (activeTaskId === message.taskId) activeTaskId = null;
}
function handleSearch(message) {
  handleStart(message);
  handleChunks({ taskId: message.taskId, chunks: message.chunks === undefined ? [] : message.chunks, batchId: message.batchId });
  handleFinish(message);
}

self.onmessage = function (event) {
  var message = event.data;
  try {
    if (!message || typeof message !== "object" || typeof message.type !== "string" || !validId(message.taskId)) throw protocolError("Invalid message format.");
    switch (message.type) {
      case "start": handleStart(message); break;
      case "chunks": handleChunks(message); break;
      case "finish": handleFinish(message); break;
      case "cancel": handleCancel(message); break;
      case "search": handleSearch(message); break;
      default: throw protocolError("Unknown message type: " + message.type);
    }
  } catch (failure) {
    reportError(message && message.taskId, failure);
  } finally {
    // Offscreen relay uses a separate sequence ACK; batch ACK remains visible to manager.
    if (message && Number.isSafeInteger(message.sequence) && message.sequence > 0) self.postMessage({ type: "ack", taskId: message.taskId, sequence: message.sequence });
  }
};
