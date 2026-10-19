(function () {
  "use strict";
  var WORKER_BATCH_SIZE = 256;
  var COLLECTION_BATCH_SIZE = 128;
  var MATCH_CHECK_INTERVAL = 64;
  var MAPPING_SHIFT_BATCH_SIZE = 512;
  var POLICY = globalThis.RRRuntimePolicy;
  var MAX_QUERY_CHARS = POLICY.search.maxPatternChars;
  var MAX_TRANSFER_CHARS = POLICY.transport.maxBatchChars;
  function now() { return globalThis.performance && typeof globalThis.performance.now === "function" ? globalThis.performance.now() : Date.now(); }
  function yieldToPage() {
    return globalThis.RRTaskScheduler && typeof globalThis.RRTaskScheduler.yield === "function" ?
      globalThis.RRTaskScheduler.yield() : new Promise(function (resolve) { setTimeout(resolve, 0); });
  }
  function createCheckpoint(shouldContinue) {
    var resumedAt = now();
    return function () {
      if (!shouldContinue()) return false;
      if (now() - resumedAt < POLICY.scheduling.pageSliceMs) return true;
      return yieldToPage().then(function () {
        resumedAt = now();
        return shouldContinue();
      });
    };
  }
  function matchKey(match) { return match.chunkId + ":" + match.start + ":" + match.end; }
  async function isLiteralSource(pattern, checkpoint) {
    for (var offset = 0; offset < pattern.length; offset += POLICY.text.sourceChunkChars) {
      var continued = checkpoint();
      if (continued !== true && !await continued) return null;
      if (/[\\^$.*+?()[\]{}|]/.test(pattern.slice(offset, offset + POLICY.text.sourceChunkChars))) return false;
    }
    return true;
  }
  function controlKind(kind) { return /^(control|label|placeholder)$/.test(kind || "text"); }
  function collectionRoot(selection) {
    if (!selection) return document;
    if (globalThis.RRSelectionCapture) return globalThis.RRSelectionCapture.rootFor(selection);
    var root = selection.commonAncestorContainer;
    return root.nodeType === 3 ? root.parentNode : root;
  }
  function validInterval(match, length) {
    return match && Number.isSafeInteger(match.start) && Number.isSafeInteger(match.end) &&
      match.start >= 0 && match.end > match.start && match.end <= length;
  }
  function controlBinding(entry, match, id, baseOffset) {
    if (!validInterval(match, entry.displayLength == null ? entry.text.length : entry.displayLength) ||
        typeof entry.displayTextSnapshot !== "string") return null;
    var offset = (baseOffset == null ? entry.controlOffset == null ? entry.selectionOffset || 0 : entry.controlOffset : baseOffset) + match.start;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + match.end - match.start > entry.displayTextSnapshot.length) return null;
    return { id: id, kind: entry.kind, node: entry.node, root: entry.root,
      displayLength: match.end - match.start, controlOffset: offset,
      snapshotStart: offset, snapshotEnd: offset + match.end - match.start,
      displayTextSnapshot: entry.displayTextSnapshot, textTransform: entry.textTransform || "none",
      controlTransform: entry.controlTransform || "none" };
  }
  function textBinding(entry, match, id) {
    return { id: id, kind: "bound-text", node: match.spans[0].node, root: entry.root,
      displayLength: match.end - match.start, boundSpans: match.spans };
  }
  // Coordinates collection, isolated matching and rendering. Owns cancellation
  // and result lifetime; UI and DOM observation are supplied as callbacks.
  function create(options) {
    options = options || {};
    var generation = 0, activeTask = 0, handles = null, activeGuard = null, activeRetention = null;
    var disposed = false, busy = false, state = { status: "idle" };
    function emit(next) {
      state = next;
      if (options.onState) options.onState(next);
    }
    function clear() {
      generation++;
      if (activeTask && globalThis.RRWorkerManager) globalThis.RRWorkerManager.cancel(activeTask);
      activeTask = 0;
      if (activeGuard) activeGuard.dispose();
      activeGuard = null;
      if (activeRetention) activeRetention();
      activeRetention = null;
      busy = false;
      state = { status: "idle", renderedMatches: 0 };
      if (handles && globalThis.RRHighlightEngine) globalThis.RRHighlightEngine.removeHighlights(handles);
      handles = null;
      if (options.onResults) options.onResults([], { reason: "clear" });
    }
    function crop(entry, selection) {
      if (!selection) return entry;
      if (entry.selectionProcessed) return entry;
      if (selection.kind === "control-selection") {
        if (entry.node !== selection.node || entry.kind !== "control" ||
            entry.displayTextSnapshot !== selection.valueSnapshot) return null;
        return Object.assign({}, entry, { text: entry.text.slice(selection.start, selection.end),
          sourceLength: selection.end - selection.start,
          selectionOffset: selection.start, selectionOriginal: entry });
      }
      return globalThis.RRTextCollector.normalizeSelection(entry, selection);
    }
    async function search(pattern, query) {
      if (disposed) return;
      var startedAt = now();
      clear();
      var gen = generation;
      query = query || {};
      if (!pattern) { emit({ status: "idle", renderedMatches: 0 }); return; }
      var config = globalThis.RRRuntimeConfig.normalize(options.getConfig ? options.getConfig() : {});
      var deadline = startedAt + config.workerTimeoutMs;
      function checkCurrent() {
        if (gen !== generation) return false;
        if (now() >= deadline) {
          var timeout = new Error("Search deadline exceeded");
          timeout.code = "search-timeout"; timeout.numericCode = POLICY.errors.timeout;
          throw timeout;
        }
        return true;
      }
      var selection = query.scope === "selection" ? query.selection : null;
      var selectionValid = globalThis.RRSelectionCapture ? globalThis.RRSelectionCapture.isValid(selection) :
        selection && !selection.collapsed && selection.commonAncestorContainer && selection.commonAncestorContainer.isConnected;
      if (query.scope === "selection" && !selectionValid) {
        emit({ status: "error", message: "Select page text first" }); return;
      }
      if (typeof pattern !== "string" || pattern.length > MAX_QUERY_CHARS) {
        emit({ status: "invalid", message: "Query exceeds " + MAX_QUERY_CHARS + " characters" }); return;
      }
      var flags = "gu" + (config.caseSensitive ? "" : "i") + (config.multiline ? "m" : "") + (config.dotAll ? "s" : "");
      var policy = globalThis.RRPatternAnalyzer.analyze(pattern, flags, { mode: config.mode });
      policy.mode = config.mode;
      policy.wholeWord = config.wholeWord;
      policy.analyzeInWorker = policy.status === "deferred";
      if (!policy.ok) {
        emit({ status: policy.status, message: policy.status === "unsafe" ? "Unsafe Regex" : "Invalid Regex", detail: (policy.reasons || []).join("; "), errorCode: policy.errorCode });
        return;
      }
      busy = true;
      emit({ status: "searching", message: "Searching" });
      var entries = [], collection = null, collectorResult = null, collectionGuard = null;
      var retainedHits = new Map(), pendingSources = new Map();
      function releaseSnapshots() {
        entries = [];
        retainedHits.clear();
        pendingSources.clear();
      }
      activeRetention = releaseSnapshots;
      try {
        if (!globalThis.RRWorkerManager || !globalThis.RRTextCollector || !globalThis.RRTextMapping || !globalThis.RRHighlightEngine) throw new Error("Search modules unavailable; reload the extension");
        var checkpoint = createCheckpoint(checkCurrent);
        var streamLiterals = config.mode === "literal" || await isLiteralSource(pattern, checkpoint);
        if (gen !== generation || streamLiterals === null) return;
        if (globalThis.RRHighlightEngine.createCollectionGuard) {
          collectionGuard = globalThis.RRHighlightEngine.createCollectionGuard();
          activeGuard = collectionGuard;
        }
        if (!checkCurrent()) return;
        activeTask = gen;
        globalThis.RRWorkerManager.updateConfig({
          maxMatches: config.maxMatches, maxScannedChars: config.maxScannedChars,
          workerTimeoutMs: Math.max(1, Math.ceil(deadline - now())),
          batchSize: WORKER_BATCH_SIZE, maxBatchChars: MAX_TRANSFER_CHARS
        });
        var result = await globalThis.RRWorkerManager.searchStream(gen, pattern, flags, function (sendBatch, shouldContinue, getLastBatchMatchedIds, getLastBatchMatches, getLastBatchCompletedSourceIds) {
          var compactMappings = typeof getLastBatchMatches === "function";
          collection = globalThis.RRTextCollector.collectBatched({
            batchSize: COLLECTION_BATCH_SIZE, budgetMs: POLICY.scheduling.pageSliceMs, storeNodes: false,
            maxChars: config.maxScannedChars, maxRunChars: config.maxScannedChars,
            maxBatchSourceChars: MAX_TRANSFER_CHARS, externalDeadline: true,
            streamLiterals: streamLiterals, literalQueryLength: pattern.length,
            compactMappings: compactMappings,
            includeControls: config.includeControls,
            selection: selection, selectionScoped: true,
            root: collectionRoot(selection),
            onRoot: function (root, meta) {
              if (collectionGuard) collectionGuard.addRoot(root);
              if (options.onRoot) options.onRoot(root, meta);
            },
            onControlRead: function (node, observed) {
              if (gen === generation && options.onControlRead) options.onControlRead(node, observed);
            },
            shouldContinue: function () { return checkCurrent() && shouldContinue(); },
            onBatch: async function (batch) {
              if (!checkCurrent() || !shouldContinue()) return false;
              var continued;
              var filtered = [];
              for (var i = 0; i < batch.length; i++) {
                var entry = crop(batch[i], selection);
                if (entry) filtered.push(entry);
              }
              if (filtered.length) {
                // Native expressions match a complete logical source. Keep its
                // sparse recipes until the final fragment is acknowledged;
                // fragment text itself is owned only by this awaited batch.
                for (var sourceIndex = 0; sourceIndex < filtered.length; sourceIndex++) {
                  var sourceEntry = filtered[sourceIndex], source = sourceEntry.source;
                  if (!compactMappings || !source) continue;
                  var pending = pendingSources.get(source.runId);
                  if (source.first) {
                    if (pending) throw new Error("Duplicate collected text source");
                    pending = { kind: sourceEntry.kind, node: sourceEntry.node, root: sourceEntry.root,
                      displayLength: 0, mappingRecords: [], displayTextSnapshot: sourceEntry.displayTextSnapshot,
                      controlOffset: sourceEntry.controlOffset == null ? sourceEntry.selectionOffset || 0 : sourceEntry.controlOffset - source.offset,
                      textTransform: sourceEntry.textTransform, controlTransform: sourceEntry.controlTransform };
                    pendingSources.set(source.runId, pending);
                  }
                  if (!pending || pending.displayLength !== source.offset) throw new Error("Invalid collected text source sequence");
                  pending.displayLength = source.offset + sourceEntry.text.length;
                  var sourceRecords = sourceEntry.mappingRecords || [];
                  for (var recordIndex = 0; recordIndex < sourceRecords.length; recordIndex += MAPPING_SHIFT_BATCH_SIZE) {
                    continued = checkpoint();
                    if (continued !== true && !await continued) return false;
                    var shifted = globalThis.RRTextMapping.sliceWindow(sourceRecords.slice(recordIndex, recordIndex + MAPPING_SHIFT_BATCH_SIZE),
                      0, sourceEntry.text.length, -source.offset);
                    for (var shiftedIndex = 0; shiftedIndex < shifted.length; shiftedIndex++) pending.mappingRecords.push(shifted[shiftedIndex]);
                  }
                }
                await sendBatch(filtered);
                if (!checkCurrent()) return false;
                var intervals = typeof getLastBatchMatches === "function" ? getLastBatchMatches() : null;
                if (Array.isArray(intervals)) {
                  var byId = new Map(), groups = new Map();
                  filtered.forEach(function (entry) { byId.set(entry.id, entry); });
                  for (var hitIndex = 0; hitIndex < intervals.length; hitIndex++) {
                    if ((hitIndex & (MATCH_CHECK_INTERVAL - 1)) === 0) {
                      continued = checkpoint();
                      if (continued !== true && !await continued) return false;
                    }
                    var hit = intervals[hitIndex], key = matchKey(hit);
                    if (retainedHits.has(key)) continue;
                    var grouped = groups.get(hit.chunkId);
                    if (!grouped) groups.set(hit.chunkId, grouped = []);
                    grouped.push(hit);
                  }
                  for (var group of groups) {
                    continued = checkpoint();
                    if (continued !== true && !await continued) return false;
                    var matchedEntry = pendingSources.get(group[0]) || byId.get(group[0]), hits = group[1];
                    if (!matchedEntry) throw new Error("Matched text source is unavailable");
                    if (controlKind(matchedEntry.kind)) {
                      for (var controlIndex = 0; controlIndex < hits.length; controlIndex++) {
                        if ((controlIndex & (MATCH_CHECK_INTERVAL - 1)) === 0) {
                          continued = checkpoint();
                          if (continued !== true && !await continued) return false;
                        }
                        var boundControl = controlBinding(matchedEntry, hits[controlIndex], retainedHits.size);
                        if (!boundControl) throw new Error("Invalid matched control mapping");
                        retainedHits.set(matchKey(hits[controlIndex]), boundControl);
                      }
                    } else {
                      var resolved = matchedEntry.mappingRecords ? await globalThis.RRTextMapping.resolveMatches(matchedEntry.mappingRecords,
                        hits, { shouldContinue: checkCurrent, checkpoint: checkpoint }) : await globalThis.RRTextMapping.resolveLegacyMatches(matchedEntry, hits,
                        { shouldContinue: checkCurrent, checkpoint: checkpoint });
                      if (!checkCurrent()) return false;
                      if (!resolved) throw new Error("Invalid matched text mapping");
                      for (var resolvedIndex = 0; resolvedIndex < resolved.length; resolvedIndex++) {
                        retainedHits.set(matchKey(resolved[resolvedIndex]), textBinding(matchedEntry, resolved[resolvedIndex], retainedHits.size));
                      }
                    }
                  }
                  var completed = typeof getLastBatchCompletedSourceIds === "function" ? getLastBatchCompletedSourceIds() :
                    filtered.filter(function (entry) { return entry.source && entry.source.last; }).map(function (entry) { return entry.source.runId; });
                  if (Array.isArray(completed)) {
                    completed.forEach(function (id) { pendingSources.delete(id); });
                  }
                } else {
                  // Older manager adapters expose only hit IDs. Keep their
                  // original complete-entry mapping contract.
                  var ids = typeof getLastBatchMatchedIds === "function" ? getLastBatchMatchedIds() : null;
                  var keep = Array.isArray(ids) ? new Set(ids) : null;
                  for (var j = 0; j < filtered.length; j++) {
                    if (keep && !keep.has(filtered[j].id)) continue;
                    entries.push(filtered[j]);
                  }
                }
              }
              return checkCurrent() && shouldContinue();
            }
          }).then(function (value) {
            collectorResult = value;
            return { limitReason: value && value.stats && value.stats.truncated ? "collection-budget" : undefined };
          });
          return collection;
        }, policy);
        if (collection) await collection;
        if (!checkCurrent()) return;
        activeTask = 0;
        var stats = collectorResult && collectorResult.stats;
        // Release all unmatched snapshots before constructing ranges.
        var workerMatches = result.matches || [];
        var matchedEntries = [], matches = [], nextRenderId = 0;
        var legacyIds = null, selectionOffsets = null;
        if (entries.length) {
          // Only compatibility adapters retain complete entries. The normal
          // bound-span path needs neither a second ID set nor source filtering.
          var wanted = new Set(workerMatches.map(function (match) { return match.chunkId; }));
          legacyIds = new Set();
          selectionOffsets = new Map();
          entries.forEach(function (entry) {
            if (!wanted.has(entry.id)) return;
            if (entry.selectionOriginal) {
              selectionOffsets.set(entry.id, entry.selectionOffset);
              entry = entry.selectionOriginal;
            }
            matchedEntries.push(entry);
            legacyIds.add(entry.id);
            nextRenderId = Math.max(nextRenderId, entry.id + 1);
          });
        }
        for (var renderIndex = 0; renderIndex < workerMatches.length; renderIndex++) {
          if ((renderIndex & (MATCH_CHECK_INTERVAL - 1)) === 0) {
            var ready = checkpoint();
            if (ready !== true && !await ready) return;
          }
          var match = workerMatches[renderIndex];
          var retained = retainedHits.get(matchKey(match));
          if (retained) {
            retained.id = nextRenderId++;
            matchedEntries.push(retained);
            matches.push({ chunkId: retained.id, start: 0, end: retained.displayLength });
          } else if (legacyIds && legacyIds.has(match.chunkId)) {
            if (selectionOffsets.has(match.chunkId)) {
              var offset = selectionOffsets.get(match.chunkId);
              match = Object.assign({}, match, { start: match.start + offset, end: match.end + offset });
            }
            matches.push(match);
          }
        }
        releaseSnapshots();
        emit({ status: "rendering", message: "Rendering" });
        var rendered = await globalThis.RRHighlightEngine.renderMatchesBatched(matchedEntries, matches, {
          budgetMs: POLICY.scheduling.pageSliceMs, collectionGuard: collectionGuard,
          shouldContinue: function () { return gen === generation && now() < deadline; }
        });
        var expired = now() >= deadline;
        if (gen !== generation || rendered.cancelled || expired) {
          globalThis.RRHighlightEngine.removeHighlights(rendered.handles);
          if (gen === generation && expired) {
            var timeout = new Error("Search deadline exceeded while marking results");
            timeout.code = "search-timeout";
            timeout.numericCode = POLICY.errors.timeout;
            throw timeout;
          }
          return;
        }
        handles = rendered.handles;
        var limited = !!result.limited || !!(stats && stats.truncated);
        var collectionReason = stats && stats.reasons && stats.reasons.join(", ");
        var limitReason = (result.limitReason === "collection-budget" ? collectionReason || result.limitReason : result.limitReason) || collectionReason || (stats && stats.truncated ? "collection-budget" : "");
        if (options.onResults) options.onResults(rendered.marks || [], { reason: query.reason || "manual", limited: limited });
        emit({ status: limited ? "limited" : "done", renderedMatches: (rendered.marks || []).length,
          limited: limited, limitReason: limitReason, stats: stats,
          scannedChars: stats && Number.isSafeInteger(stats.scannedSourceCharacters) && stats.scannedSourceCharacters >= 0 ? stats.scannedSourceCharacters : result.scannedChars,
          scanLimitChars: config.maxScannedChars,
          inaccessibleFrames: stats ? stats.inaccessibleFrames : 0,
          skippedMatches: (result.matches || []).length - (rendered.marks || []).length,
          engine: result.engine, roots: collectorResult ? collectorResult.roots : [] });
      } catch (error) {
        if (collection) await collection.catch(function () {});
        if (gen !== generation || (error && error.name === "AbortError")) return;
        activeTask = 0;
        emit({ status: error && error.code === "search-timeout" ? "timeout" : "error",
          message: error && error.code === "search-timeout" ? "Search timed out" : "Search unavailable",
          detail: error && error.message || String(error), errorCode: error && error.numericCode });
      } finally {
        releaseSnapshots();
        if (activeRetention === releaseSnapshots) activeRetention = null;
        if (collectionGuard) collectionGuard.dispose();
        if (activeGuard === collectionGuard) activeGuard = null;
        if (gen === generation) busy = false;
      }
    }
    function dispose() {
      clear();
      disposed = true;
      if (globalThis.RRWorkerManager) globalThis.RRWorkerManager.dispose();
    }
    return { search: search, clear: clear, dispose: dispose, isBusy: function () { return busy; },
      getGeneration: function () { return generation; }, getState: function () { return state; } };
  }
  globalThis.RRSearchController = { create: create };
})();
