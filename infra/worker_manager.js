/** Worker ownership, cancellation and acknowledged streaming transport. */
(function () {
  "use strict";
  var DEFAULT_BATCH_NODES = 200;
  var MAX_BATCH_NODES = 1000; // Producer slices; the wire envelope can hold more.

  var POLICY = globalThis.RRRuntimePolicy;

  var blobUrl = null;
  var sourceRequest = null;
  var sourceGeneration = 0;
  var active = null;
  var MAX_PATTERN_LENGTH = POLICY.search.maxPatternChars;
  var MAX_TRANSFER_CHARS = POLICY.transport.maxBatchChars;
  var config = {
    maxMatches: POLICY.search.defaultMatches, maxScannedChars: POLICY.search.defaultScannedChars,
    workerTimeoutMs: POLICY.search.defaultTimeoutMs, batchSize: DEFAULT_BATCH_NODES,
    maxBatchChars: MAX_TRANSFER_CHARS, allowUnsafeEcmascript: false
  };
  var bounds = {
    maxMatches: POLICY.search.maxWorkerMatches, maxScannedChars: POLICY.search.maxScannedChars,
    workerTimeoutMs: POLICY.search.maxTimeoutMs, batchSize: MAX_BATCH_NODES,
    maxBatchChars: MAX_TRANSFER_CHARS
  };

  function error(code, numericCode, message) {
    return { code: code, numericCode: numericCode, message: message };
  }
  function abortError(message) {
    var value = error("search-cancelled", POLICY.errors.cancelled, message);
    value.name = "AbortError";
    return value;
  }
  function validId(value) { return Number.isSafeInteger(value) && value >= 0; }
  function now() {
    return globalThis.performance && typeof globalThis.performance.now === "function" ? globalThis.performance.now() : Date.now();
  }
  function validLimitReason(value) {
    return value === undefined || value === null || ["max-scanned-chars",
      "max-matches", "collection-budget"].includes(value);
  }
  function copyMatch(match) { return { chunkId: match.chunkId, start: match.start, end: match.end }; }
  function matchKey(match) { return match.chunkId + ":" + match.start + ":" + match.end; }
  function validMatch(match, lengths) {
    return match && validId(match.chunkId) && validId(match.start) && validId(match.end) &&
      match.end > match.start &&
      (!lengths || (lengths.has(match.chunkId) && match.end <= lengths.get(match.chunkId)));
  }
  function validWindowMatch(match, ranges) {
    var range = ranges && ranges.get(match.chunkId);
    return !range || (match.start >= range.start && match.start < range.end);
  }
  function validIntervals(task, intervals, lengths, ids, ranges) {
    if (!Array.isArray(intervals) || intervals.length > task.cfg.maxMatches) return false;
    var seen = new Set(), hitIds = new Set();
    for (var index = 0; index < intervals.length; index++) {
      var match = intervals[index];
      if (!validMatch(match, lengths) || !validWindowMatch(match, ranges)) return false;
      var key = matchKey(match);
      if (seen.has(key) || task.confirmedMatches.has(key)) return false;
      seen.add(key); hitIds.add(match.chunkId);
    }
    if (task.confirmedMatches.size + seen.size > task.cfg.maxMatches ||
        (ids && (ids.length !== hitIds.size || ids.some(function (id) { return !hitIds.has(id); })))) return false;
    seen.forEach(function (key) { task.confirmedMatches.add(key); });
    return true;
  }
  function prepareStream(task, value, length) {
    if (value === undefined) return null;
    if (!value || typeof value !== "object" || Array.isArray(value) || !validId(value.runId) || !validId(value.offset) ||
        !validId(value.ownedStart) || !validId(value.ownedEnd) || typeof value.first !== "boolean" || typeof value.last !== "boolean" ||
        value.ownedStart < value.offset || value.ownedEnd <= value.ownedStart ||
        !Number.isSafeInteger(value.offset + length) || value.ownedEnd > value.offset + length ||
        (value.first && (value.offset !== 0 || value.ownedStart !== 0))) throw error("worker-protocol-error", POLICY.errors.protocol, "Invalid streamed text window.");
    var previous = task.streamRuns.get(value.runId);
    if (value.first ? previous : !previous || value.ownedStart !== previous.ownedEnd) {
      throw error("worker-protocol-error", POLICY.errors.protocol, "Invalid streamed text window order.");
    }
    var stream = { runId: value.runId, offset: value.offset, ownedStart: value.ownedStart,
      ownedEnd: value.ownedEnd, first: value.first, last: value.last };
    var runEnd = previous ? previous.runEnd : null;
    if (value.last) {
      if (runEnd !== null && value.offset + length !== runEnd) throw error("worker-protocol-error", POLICY.errors.protocol, "Streamed text run endpoint changed.");
      runEnd = value.offset + length;
    }
    if (runEnd !== null && (value.offset + length > runEnd || !value.last && value.offset + length === runEnd)) {
      throw error("worker-protocol-error", POLICY.errors.protocol, "Invalid streamed text run endpoint.");
    }
    var complete = runEnd !== null && value.ownedEnd === runEnd;
    if (complete) task.streamRuns.delete(value.runId);
    else task.streamRuns.set(value.runId, { ownedEnd: value.ownedEnd, runEnd: runEnd });
    return stream;
  }
  function prepareSource(task, value, chunkId, length) {
    if (value === undefined) return null;
    if (!value || typeof value !== "object" || Array.isArray(value) || !validId(value.runId) || !validId(value.offset) ||
        typeof value.first !== "boolean" || typeof value.last !== "boolean" || !Number.isSafeInteger(value.offset + length) ||
        (length === 0 && !value.last) ||
        (value.first && (value.offset !== 0 || value.runId !== chunkId))) throw error("worker-protocol-error", POLICY.errors.protocol, "Invalid logical source fragment.");
    var previous = task.sourceRuns.get(value.runId);
    if (value.first ? previous : !previous || value.offset !== previous.length) {
      throw error("worker-protocol-error", POLICY.errors.protocol, "Invalid logical source fragment order.");
    }
    var source = { runId: value.runId, offset: value.offset, first: value.first, last: value.last };
    task.usedSources = true;
    if (value.last) task.sourceRuns.delete(value.runId);
    else task.sourceRuns.set(value.runId, { length: value.offset + length });
    return source;
  }
  function validCompletedSources(message, pending, previous, terminal) {
    var ids = message.completedSourceIds;
    if (ids === undefined) return !(pending && pending.hasSource);
    if (!Array.isArray(ids)) return false;
    var allowed = pending ? pending.sourceLengths : new Map((previous || []).map(function (id) { return [id, 0]; }));
    if (ids.length > allowed.size) return false;
    var seen = new Set();
    for (var index = 0; index < ids.length; index++) {
      if (!validId(ids[index]) || !allowed.has(ids[index]) || seen.has(ids[index])) return false;
      seen.add(ids[index]);
    }
    return (terminal ? message.limited === true : message.stopped === true) || ids.length === allowed.size;
  }
  function snapshotConfig() {
    var result = {};
    Object.keys(config).forEach(function (key) { result[key] = config[key]; });
    return result;
  }
  function validComplete(task, message) {
    if (task.usedSources && (!task.knownMatchIds || !task.knownIntervals)) return false;
    if (!Array.isArray(message.matches) || message.matches.length > task.cfg.maxMatches ||
        (message.totalMatches !== undefined && (!validId(message.totalMatches) || message.totalMatches !== message.matches.length)) ||
        (message.scannedChars !== undefined && (!validId(message.scannedChars) || message.scannedChars > task.sentChars)) ||
        (message.scannedNodes !== undefined && (!validId(message.scannedNodes) || message.scannedNodes > task.sentNodes)) ||
        (message.limited !== undefined && typeof message.limited !== "boolean") ||
        (message.engine !== undefined && (typeof message.engine !== "string" || message.engine.length > POLICY.transport.maxMetadataChars)) ||
        !validLimitReason(message.limitReason)) return false;
    if ((task.sourceRuns.size || task.streamRuns.size) && message.limited !== true && !task.limitReason ||
        !validCompletedSources(message, task.ack, task.lastAckCompletedSourceIds, true)) return false;
    var seen = new Set(), pendingCount = 0;
    for (var index = 0; index < message.matches.length; index++) {
      var match = message.matches[index];
      if (!validMatch(match)) return false;
      var key = matchKey(match);
      if (seen.has(key)) return false;
      seen.add(key);
      if (task.knownIntervals && !task.confirmedMatches.has(key)) {
        if (!task.ack || !validMatch(match, task.ack.chunkLengths) || !validWindowMatch(match, task.ack.chunkRanges)) return false;
        if (task.ack.sourceLengths.has(match.chunkId) && (!Array.isArray(message.completedSourceIds) ||
            message.completedSourceIds.indexOf(match.chunkId) === -1)) return false;
        pendingCount++;
      }
      if (task.knownMatchIds) {
        var length = task.hitChunkLengths.get(match.chunkId);
        var pendingLength = task.ack && task.ack.chunkLengths.get(match.chunkId);
        if (pendingLength !== undefined) length = length === undefined ? pendingLength : Math.max(length, pendingLength);
        if (length === undefined || match.end > length) return false;
      } else if (match.end > MAX_TRANSFER_CHARS && !task.hitChunkLengths.has(match.chunkId) &&
          (!task.ack || !task.ack.sourceLengths.has(match.chunkId))) return false;
    }
    if (task.knownIntervals && seen.size !== task.confirmedMatches.size + pendingCount) return false;
    return true;
  }

  function getBlobUrl() {
    if (blobUrl) return Promise.resolve(blobUrl);
    if (sourceRequest) return sourceRequest.promise;
    var generation = sourceGeneration;
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var request = { controller: controller, promise: null };
    request.promise = Promise.resolve().then(function () {
      return Promise.all(["domain/runtime_policy.js", "domain/pattern_analyzer.js", "domain/literal_matcher.js", "search_worker.js"].map(function (filename) {
        return fetch(chrome.runtime.getURL(filename), controller ? { signal: controller.signal } : undefined).then(function (response) {
          if (response.ok === false) throw new Error("Worker source request failed: " + response.status);
          return response.text();
        }).then(function (source) {
          if (typeof source !== "string") throw new Error("Invalid worker source.");
          return source;
        });
      }));
    }).then(function (sources) {
      var source = sources.join("\n");
      // A fetch implementation may ignore AbortSignal. Never create a URL after dispose.
      if (generation !== sourceGeneration) throw abortError("Worker source disposed.");
      // These are bundled extension assets, not page input. Their combined
      // size is not a search quota; fetch/allocation failures still reject and
      // the active task's original deadline covers source loading.
      blobUrl = URL.createObjectURL(new Blob([source], { type: "application/javascript" }));
      return blobUrl;
    }).catch(function (cause) {
      if (controller) controller.abort();
      throw cause;
    }).finally(function () {
      if (sourceRequest === request) sourceRequest = null;
    });
    sourceRequest = request;
    return request.promise;
  }

  function isActive(task) {
    if (active !== task || task.settled) return false;
    if (now() >= task.deadline) { settle(task, error("search-timeout", POLICY.errors.timeout, "Search timed out.")); return false; }
    return true;
  }
  function clearSourceRequest() {
    sourceGeneration++;
    if (sourceRequest && sourceRequest.controller) sourceRequest.controller.abort();
    sourceRequest = null;
  }
  function settle(task, failure, result) {
    if (task.settled) return;
    task.settled = true;
    task.hitChunkLengths.clear();
    task.confirmedMatches.clear();
    task.streamRuns.clear();
    task.sourceRuns.clear();
    clearTimeout(task.timeoutId);
    if (task.controller) task.controller.abort();
    if (failure && failure.code === "search-timeout" && !task.worker && sourceRequest) clearSourceRequest();
    if (task.worker) {
      task.worker.onmessage = null;
      task.worker.onerror = null;
      task.worker.onmessageerror = null;
      try { task.worker.terminate(); } catch (ignored) {}
      task.worker = null;
    }
    if (active === task) active = null;
    if (task.ack) {
      var pending = task.ack;
      // A terminal response can arrive before its ACK. Keep this last batch's
      // stored hits so streaming callers do not discard their source segments.
      var ids = !failure && result && Array.isArray(result.matches) ? [] : null;
      if (ids) {
        var seen = new Set();
        result.matches.forEach(function (match) {
          if (match && pending.chunkIds.has(match.chunkId) && !seen.has(match.chunkId)) {
            seen.add(match.chunkId);
            ids.push(match.chunkId);
          }
        });
      }
      pending.resolve(ids ? { matchedChunkIds: ids, matchedIntervals: result.matches.filter(function (match) {
        return pending.chunkIds.has(match.chunkId);
      }).map(copyMatch), completedSourceIds: Array.isArray(result.completedSourceIds) ? result.completedSourceIds.slice() : [] } : undefined);
      task.ack = null;
    }
    if (failure) task.reject(failure);
    else {
      if (task.limitReason && !result.limitReason) {
        result.limited = true;
        result.limitReason = task.limitReason;
      }
      task.resolve(result);
    }
  }

  function begin(taskId, pattern, flags, producer, policy) {
    if (!validId(taskId) || typeof pattern !== "string" || pattern.length > MAX_PATTERN_LENGTH ||
        (flags !== undefined && (typeof flags !== "string" || flags.length > POLICY.transport.maxFlagsChars)) || typeof producer !== "function" ||
        (policy !== undefined && (!policy || typeof policy !== "object")) ||
        (policy && policy.mode !== undefined && policy.mode !== "regex" && policy.mode !== "literal") ||
        (policy && policy.status !== undefined && policy.status !== "safe" && policy.status !== "unsafe" && policy.status !== "deferred") ||
        (policy && policy.wholeWord !== undefined && typeof policy.wholeWord !== "boolean") ||
        (policy && policy.analyzeInWorker !== undefined && typeof policy.analyzeInWorker !== "boolean")) {
      return Promise.reject(error("worker-protocol-error", POLICY.errors.protocol, "Invalid search arguments."));
    }
    if (active) settle(active, abortError("Search superseded."));
    return new Promise(function (resolve, reject) {
      var task = {
        taskId: taskId, resolve: resolve, reject: reject, worker: null,
        settled: false, cfg: snapshotConfig(), ack: null, sequence: 0,
        sending: false, limitReason: null, sentChars: 0, sentNodes: 0, lastSentChunkId: -1,
        hitChunkLengths: new Map(), knownMatchIds: true,
        confirmedMatches: new Set(), knownIntervals: true,
        streamRuns: new Map(), sourceRuns: new Map(), usedSources: false, lastAckCompletedSourceIds: [],
        controller: typeof AbortController === "function" ? new AbortController() : null
      };
      active = task;
      task.deadline = now() + task.cfg.workerTimeoutMs;
      // Includes source fetch/startup, and preempts a single hung RegExp.exec.
      task.timeoutId = setTimeout(function () {
        settle(task, error("search-timeout", POLICY.errors.timeout, "Search timed out."));
      }, task.cfg.workerTimeoutMs);
      Promise.resolve().then(function () {
        if (!isActive(task)) return null;
        var transport = globalThis.RRWorkerTransport;
        if (transport && typeof transport.create === "function" &&
            (typeof transport.isAvailable !== "function" || transport.isAvailable())) {
          return transport.create(task.controller ? { signal: task.controller.signal } : undefined);
        }
        return getBlobUrl().then(function (url) {
          if (!isActive(task)) return null;
          return new Worker(url);
        });
      }).then(async function (worker) {
        if (!isActive(task)) {
          if (worker) worker.terminate();
          return;
        }
        if (!worker) throw new Error("Worker initialization failed.");
        task.worker = worker;
        worker.onmessage = function (event) {
          if (!isActive(task)) return;
          var message = event.data;
          if (!message || message.taskId !== taskId) return;
          if (message.type === "ack") {
            if (task.ack && message.batchId === task.ack.batchId) {
              if ((message.scannedChars !== undefined && (!validId(message.scannedChars) || message.scannedChars > task.sentChars)) ||
                  (message.scannedNodes !== undefined && (!validId(message.scannedNodes) || message.scannedNodes > task.sentNodes)) ||
                  (message.limited !== undefined && typeof message.limited !== "boolean") ||
                  (message.stopped !== undefined && typeof message.stopped !== "boolean") || !validLimitReason(message.limitReason)) {
                settle(task, error("worker-protocol-error", POLICY.errors.protocol, "Invalid worker acknowledgement state."));
                return;
              }
              if (!validCompletedSources(message, task.ack) || task.usedSources &&
                  (!task.knownMatchIds || !task.knownIntervals || !Array.isArray(message.matchedChunkIds) || !Array.isArray(message.matchedIntervals))) {
                settle(task, error("worker-protocol-error", POLICY.errors.protocol, "Invalid completed logical sources in worker acknowledgement."));
                return;
              }
              var completedSources = new Set(message.completedSourceIds || []);
              if (message.matchedChunkIds !== undefined) {
                var ids = message.matchedChunkIds;
                var seen = new Set();
                var invalid = !Array.isArray(ids) || ids.length > task.ack.chunkCount;
                for (var index = 0; !invalid && index < ids.length; index++) {
                  var id = ids[index];
                  if (!validId(id) || !task.ack.chunkIds.has(id) || seen.has(id) ||
                      task.ack.sourceLengths.has(id) && !completedSources.has(id)) invalid = true;
                  else seen.add(id);
                }
                if (invalid) {
                  settle(task, error("worker-protocol-error", POLICY.errors.protocol, "Invalid matched chunk IDs in worker acknowledgement."));
                  return;
                }
                if (message.matchedIntervals !== undefined && !validIntervals(task, message.matchedIntervals, task.ack.chunkLengths, ids, task.ack.chunkRanges)) {
                  settle(task, error("worker-protocol-error", POLICY.errors.protocol, "Invalid match intervals in worker acknowledgement."));
                  return;
                }
                if (message.matchedIntervals === undefined) task.knownIntervals = false;
                if (task.knownMatchIds) {
                  for (var matchedIndex = 0; matchedIndex < ids.length; matchedIndex++) {
                    var matchedId = ids[matchedIndex];
                    var chunkLength = task.ack.chunkLengths.get(matchedId);
                    var oldLength = task.hitChunkLengths.get(matchedId);
                    task.hitChunkLengths.set(matchedId, oldLength === undefined ? chunkLength : Math.max(oldLength, chunkLength));
                  }
                  if (task.hitChunkLengths.size > task.cfg.maxMatches) {
                    settle(task, error("worker-protocol-error", POLICY.errors.protocol, "Worker acknowledgement exceeds the match budget."));
                    return;
                  }
                }
              } else {
                // Compatibility workers can omit IDs. Do not retain metadata for
                // every scanned block merely to validate their final response.
                task.knownMatchIds = false;
                task.hitChunkLengths.clear();
                task.knownIntervals = false;
                if (message.matchedIntervals !== undefined) {
                  settle(task, error("worker-protocol-error", POLICY.errors.protocol, "Worker match intervals require matching chunk IDs."));
                  return;
                }
              }
              if (message.stopped === true) {
                task.workerStopped = true;
                task.transportLimited = true;
              }
              var pending = task.ack;
              task.lastAckCompletedSourceIds = Array.from(completedSources);
              task.ack = null;
              pending.resolve(message);
            }
          } else if (message.type === "complete") {
            if (!validComplete(task, message)) settle(task, error("worker-protocol-error", POLICY.errors.protocol, "Invalid search worker result."));
            else settle(task, null, message);
          }
          else if (message.type === "error") settle(task, error(message.code, message.numericCode, message.message));
        };
        worker.onerror = function (event) {
          if (!isActive(task)) return;
          var cause = event && event.error;
          settle(task, cause && typeof cause.code === "string" ?
            error(cause.code, cause.numericCode || POLICY.errors.workerUnavailable, cause.message || "Worker transport failed.") :
            error("worker-crashed", POLICY.errors.workerUnavailable, event && event.message || "Worker crashed."));
        };
        worker.onmessageerror = function () {
          if (!isActive(task)) return;
          settle(task, error("worker-protocol-error", POLICY.errors.protocol, "Worker response could not be decoded."));
        };
        var remaining = Math.ceil(task.deadline - now());
        if (remaining <= 0) {
          settle(task, error("search-timeout", POLICY.errors.timeout, "Search timed out."));
          return;
        }
        await worker.postMessage({
          type: "start", taskId: taskId, pattern: pattern, flags: flags || "",
          mode: (policy && policy.mode) || "regex", wholeWord: !!(policy && policy.wholeWord),
          policyStatus: (policy && policy.status) || "safe", acknowledged: true,
          analyzeInWorker: !!(policy && policy.analyzeInWorker),
          maxMatches: task.cfg.maxMatches, maxScannedChars: task.cfg.maxScannedChars,
          maxBatchChars: task.cfg.maxBatchChars, maxBatchNodes: task.cfg.batchSize,
          allowUnsafeEcmascript: task.cfg.allowUnsafeEcmascript,
          workerTimeoutMs: remaining
        });
        if (!isActive(task)) return;
        var produced = await producer(function (nodes) { return sendBatch(task, nodes); }, function () {
          return isActive(task) && !task.transportLimited;
        }, function () {
          return task.lastBatchMatchedIds === null || task.lastBatchMatchedIds === undefined ? null : task.lastBatchMatchedIds.slice();
        }, function () {
          return task.lastBatchMatches === null || task.lastBatchMatches === undefined ? null : task.lastBatchMatches.map(copyMatch);
        }, function () {
          return (task.lastBatchCompletedSourceIds || []).slice();
        });
        if (produced && typeof produced === "object" && Object.prototype.hasOwnProperty.call(produced, "limitReason")) {
          var producerReason = produced.limitReason;
          if (!validLimitReason(producerReason) || producerReason === "max-matches") {
            throw error("worker-protocol-error", POLICY.errors.protocol, "Invalid producer scan limit.");
          }
          task.limitReason = task.limitReason || producerReason;
        }
        if (isActive(task) && !task.workerStopped) await worker.postMessage({ type: "finish", taskId: taskId, limitReason: task.limitReason });
      }).catch(function (cause) {
        if (isActive(task)) settle(task, cause && cause.code ? cause : error("worker-spawn-failed", POLICY.errors.workerStartup, cause && cause.message || "Worker initialization failed."));
      });
    });
  }

  function search(taskId, pattern, flags, nodes, policy) {
    if (!Array.isArray(nodes)) return Promise.reject(error("worker-protocol-error", POLICY.errors.protocol, "Search nodes must be an array."));
    return begin(taskId, pattern, flags, function (send) { return send(nodes); }, policy);
  }
  function searchStream(taskId, pattern, flags, streamNodes, policy) {
    return begin(taskId, pattern, flags, streamNodes, policy);
  }
  async function postBatch(task, chunks) {
    if (!isActive(task) || !chunks.length) return { sent: 0, matchedChunkIds: [], matchedIntervals: [], completedSourceIds: [] };
    var batchId = ++task.sequence;
    var chunkLengths = new Map();
    var chunkRanges = new Map(), sourceLengths = new Map(), hasSource = false;
    chunks.forEach(function (chunk) {
      if (chunk.source) {
        hasSource = true;
        if (chunk.source.last) {
          var length = chunk.source.offset + chunk.text.length;
          sourceLengths.set(chunk.source.runId, length);
          chunkLengths.set(chunk.source.runId, length);
        }
      } else chunkLengths.set(chunk.id, chunk.text.length);
      if (chunk.stream) chunkRanges.set(chunk.id, { start: chunk.stream.ownedStart - chunk.stream.offset,
        end: chunk.stream.ownedEnd - chunk.stream.offset });
    });
    var ack = new Promise(function (resolve) {
      task.ack = { batchId: batchId, resolve: resolve,
        chunkCount: chunks.length, chunkIds: new Set(chunkLengths.keys()),
        chunkLengths: chunkLengths, chunkRanges: chunkRanges, sourceLengths: sourceLengths, hasSource: hasSource };
    });
    await task.worker.postMessage({ type: "chunks", taskId: task.taskId, batchId: batchId, chunks: chunks });
    var response = await ack;
    return { sent: chunks.length, matchedChunkIds: response && response.matchedChunkIds !== undefined ? response.matchedChunkIds : null,
      matchedIntervals: response && response.matchedIntervals !== undefined ? response.matchedIntervals.map(copyMatch) : null,
      completedSourceIds: response && Array.isArray(response.completedSourceIds) ? response.completedSourceIds.slice() : [] };
  }
  async function sendBatch(task, nodes) {
    if (!isActive(task) || task.transportLimited) { task.lastBatchMatchedIds = []; task.lastBatchMatches = []; task.lastBatchCompletedSourceIds = []; return 0; }
    if (!Array.isArray(nodes)) throw error("worker-protocol-error", POLICY.errors.protocol, "Search batch must be an array.");
    if (task.sending) throw error("worker-protocol-error", POLICY.errors.protocol, "Await the previous search batch before sending another.");
    task.sending = true;
    var batch = [], batchChars = 0, sent = 0;
    var matchedIds = new Set();
    var matches = [], completedIds = [], knownIds = true, knownIntervals = true;
    task.lastBatchMatchedIds = null;
    task.lastBatchMatches = null;
    task.lastBatchCompletedSourceIds = [];
    async function flush() {
      var result = await postBatch(task, batch);
      sent += result.sent;
      if (result.matchedChunkIds === null) knownIds = false;
      else result.matchedChunkIds.forEach(function (id) { matchedIds.add(id); });
      if (result.matchedIntervals === null) knownIntervals = false;
      else result.matchedIntervals.forEach(function (match) { matches.push(match); });
      result.completedSourceIds.forEach(function (id) { completedIds.push(id); });
      batch = []; batchChars = 0;
    }
    try {
      for (var index = 0; index < nodes.length && isActive(task); index++) {
        var node = nodes[index];
        if (!node || !validId(node.id) || typeof node.text !== "string") throw error("worker-protocol-error", POLICY.errors.protocol, "Invalid search node.");
        var length = node.text.length;
        if (length > MAX_TRANSFER_CHARS || length > task.cfg.maxBatchChars) throw error("worker-protocol-error", POLICY.errors.protocol, "Search window exceeds its physical transfer budget.");
        if (node.stream !== undefined && node.source !== undefined) throw error("worker-protocol-error", POLICY.errors.protocol, "Search source types are mutually exclusive.");
        var stream = prepareStream(task, node.stream, length);
        var source = prepareSource(task, node.source, node.id, length);
        var scannedLength = stream ? stream.ownedEnd - stream.ownedStart : length;
        var newLogicalNode = source ? source.first : !stream || stream.first;
        if (task.sentChars + scannedLength > task.cfg.maxScannedChars) {
          task.limitReason = "max-scanned-chars";
          task.transportLimited = true;
          break;
        }
        // IDs identify immutable source mappings through ACK and completion.
        // A strictly increasing sequence enforces uniqueness without retaining
        // metadata for every scanned window.
        if (node.id <= task.lastSentChunkId) throw error("worker-protocol-error", POLICY.errors.protocol, "Search chunk IDs must strictly increase.");
        if (batch.length && (batch.length >= task.cfg.batchSize || batchChars + length > task.cfg.maxBatchChars)) {
          await flush();
          if (!isActive(task) || task.workerStopped) break;
        }
        var chunk = { id: node.id, text: node.text };
        if (stream) chunk.stream = stream;
        if (source) chunk.source = source;
        batch.push(chunk);
        task.lastSentChunkId = node.id;
        batchChars += length;
        task.sentChars += scannedLength;
        if (newLogicalNode) task.sentNodes++;
      }
      if (batch.length && isActive(task)) await flush();
      task.lastBatchMatchedIds = knownIds ? Array.from(matchedIds) : null;
      task.lastBatchMatches = knownIntervals ? matches : null;
      task.lastBatchCompletedSourceIds = completedIds;
      return sent;
    } finally { task.sending = false; }
  }

  function cancel(taskId) {
    if (active && active.taskId === taskId) settle(active, abortError("Search cancelled."));
  }
  function dispose() {
    if (active) settle(active, abortError("Search disposed."));
    clearSourceRequest();
    if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
  }
  function updateConfig(value) {
    if (!value || typeof value !== "object") return;
    Object.keys(value).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(config, key)) return;
      var setting = value[key];
      if (key === "allowUnsafeEcmascript") {
        if (typeof setting === "boolean") config[key] = setting;
      } else if (Number.isSafeInteger(setting) && setting > 0 && setting <= bounds[key]) config[key] = setting;
    });
  }
  globalThis.RRWorkerManager = {
    search: search, searchStream: searchStream, cancel: cancel,
    dispose: dispose, updateConfig: updateConfig
  };
})();
