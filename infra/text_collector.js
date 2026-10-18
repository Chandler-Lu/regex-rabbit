/** Collect bounded text runs from the rendered, composed DOM. */
(function () {
  "use strict";
  var NORMALIZATION_YIELD_INTERVAL = 256;
  var LEGACY_SEGMENT_HEADROOM = 1024;
  // Batch controls only choose when to yield/send; they never end a scan.
  var BATCH_OPTIONS = Object.freeze({
    nodes: Object.freeze({ defaultValue: 500, max: 10000 }),
    milliseconds: Object.freeze({ defaultValue: 8, max: 50 }),
    segments: Object.freeze({ defaultValue: 10000, max: 100000 })
  });
  var POLICY = globalThis.RRRuntimePolicy;
  var DEFAULTS = {
    maxChars: POLICY.search.defaultScannedChars, maxDurationMs: 15 * POLICY.units.secondMs
  };
  var HARD_LIMITS = {
    maxChars: POLICY.search.maxScannedChars, maxDurationMs: POLICY.search.maxTimeoutMs
  };
  var TEXT_INPUTS = {
    text: true, search: true, email: true, url: true, tel: true,
    number: true, button: true, submit: true, reset: true
  };
  // Logical coverage is independent from the bounded strings sent to a Worker.
  var RAW_CHUNK_CHARS = POLICY.text.sourceChunkChars;
  var PHYSICAL_FRAGMENT_CHARS = POLICY.text.sourceChunkChars;
  var LEGACY_CONTROL_SNAPSHOT_CHARS = POLICY.transport.maxBatchChars;
  var MAX_LITERAL_CHARS = POLICY.search.maxPatternChars;
  function numberOption(options, name, fallback, minimum, maximum) {
    var value = options && options[name];
    return typeof value === "number" && Number.isFinite(value) ?
      Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback;
  }
  function createScan(options) {
    options = options || {};
    if (!globalThis.RRPageVisibility) throw new Error("RRPageVisibility must load before RRTextCollector");
    var visibility = globalThis.RRPageVisibility.createContext({ cacheStyles: false, lazyDetails: true });
    var limits = {};
    Object.keys(DEFAULTS).forEach(function (key) {
      limits[key] = numberOption(options, key, DEFAULTS[key], key === "maxDurationMs" ? 1 : 0, HARD_LIMITS[key]);
    });
    var compactMappings = options.compactMappings === true;
    if (compactMappings && !globalThis.RRTextMapping) throw new Error("RRTextMapping must load before compact text collection");
    limits.maxRunChars = numberOption(options, "maxRunChars", limits.maxChars, 0, Number.MAX_SAFE_INTEGER);
    ["maxEntries", "maxVisitedNodes", "maxRunSegments", "maxTotalSegments", "maxRoots"].forEach(function (key) {
      // Standalone callers may request a structural budget explicitly. The
      // extension profile has only its user-selected character/deadline limits.
      limits[key] = compactMappings ? Infinity : numberOption(options, key, Infinity, key === "maxRoots" ? 1 : 0, Number.MAX_SAFE_INTEGER);
    });
    // Keep the initial development option compatible with the explicit name.
    if (!compactMappings && options.maxTotalSegments == null) limits.maxTotalSegments = numberOption(options, "maxSegments", limits.maxTotalSegments, 0, Number.MAX_SAFE_INTEGER);
    var startedAt = now();
    var needleLength = numberOption(options, "literalQueryLength", 1, 1, MAX_LITERAL_CHARS);
    var coreChars = Math.max(RAW_CHUNK_CHARS, needleLength + POLICY.text.boundaryContextChars);
    var afterChars = needleLength + POLICY.text.boundaryContextChars;
    var streamLiterals = options.streamLiterals === true;
    var fragmentRegex = compactMappings && !streamLiterals;
    var scopedTextSelection = options.selectionScoped === true && options.selection && options.selection.kind !== "control-selection";
    var mappedTextSelection = (streamLiterals || scopedTextSelection) && options.selection && options.selection.kind !== "control-selection";
    var stats = {
      visitedNodes: 0, visitedTextNodes: 0, textNodes: 0, entries: 0, logicalEntries: 0,
      controlEntries: 0, placeholderEntries: 0, labelEntries: 0, characters: 0,
      sourceCharacters: 0, scannedSourceCharacters: 0, processedSourceCharacters: 0, segments: 0, peakBufferedSegments: 0,
      roots: 0, shadowRoots: 0, closedShadowRoots: 0,
      frames: 0, inaccessibleFrames: 0, hiddenFrames: 0,
      oversizedRuns: 0, oversizedCharacters: 0,
      incompleteRuns: 0, incompleteCharacters: 0, hiddenElements: 0,
      truncated: false, aborted: false, reasons: [], elapsedMs: 0
    };
    var roots = [], seenRoots = new WeakSet(), seenNodes = new WeakSet();
    var stopped = false, parts = [], segments = [], mappingRecords = [], runLength = 0;
    var activeChunkParts = null;
    var runRoot = null, runDocument = null, runSourceLength = 0;
    var oversized = false, incomplete = false, runSegmentCount = 0;
    var previousCollapsedWhitespace = false, atLineStart = false;
    var runId = 0, nextRunId = 1, bufferOffset = 0, ownedOffset = 0;
    var reportedSourceLength = 0, runLimited = false, oversizedReason = "run-size";
    var runKind = "text", runNode = null, runSnapshot = null, controlBaseOffset = 0, runControlTransform = "none", runCssTransform = "none";
    var runAccepted = false;
    var assembledRunId = null;
    var originalRunLength = 0, trailingIsSelected = false;
    var bufferedSegments = 0;
    var pendingBatchSegments = 0;
    var releasingBatches = options.storeNodes === false && typeof options.onBatch === "function";
    var selectionTextNode = null, selectionTextOffset = 0, selectionText = null;
    function stop(reason, aborted) {
      stopped = true;
      stats.aborted = stats.aborted || !!aborted;
      stats.truncated = stats.truncated || !aborted;
      if (stats.reasons.indexOf(reason) === -1) stats.reasons.push(reason);
    }
    function canContinue() {
      if (stopped) return false;
      if (options.signal && options.signal.aborted) { stop("signal", true); return false; }
      if (options.shouldContinue && !options.shouldContinue()) { stop("cancelled", true); return false; }
      if (options.externalDeadline !== true && now() - startedAt >= limits.maxDurationMs) { stop("duration", false); return false; }
      return true;
    }
    function addRoot(root, kind, frameElement) {
      if (!root || seenRoots.has(root)) return false;
      if (roots.length >= limits.maxRoots) {
        stats.truncated = true;
        if (stats.reasons.indexOf("root-limit") === -1) stats.reasons.push("root-limit");
        return false;
      }
      seenRoots.add(root);
      roots.push(root);
      stats.roots = roots.length;
      if (kind === "shadow") stats.shadowRoots += 1;
      if (kind === "shadow" && root.mode === "closed") stats.closedShadowRoots += 1;
      if (options.onRoot) options.onRoot(root, { kind: kind, frameElement: frameElement || null });
      return true;
    }
    function discardMaps() {
      bufferedSegments -= compactMappings ? mappingRecords.length : segments.length;
      parts = []; segments = []; mappingRecords = []; activeChunkParts = null;
    }
    function resetRun(keepMaps) {
      if (!keepMaps) discardMaps();
      parts = []; segments = []; mappingRecords = []; runLength = 0; activeChunkParts = null;
      runRoot = null; runDocument = null; runSourceLength = 0;
      oversized = false; incomplete = false; runSegmentCount = 0;
      previousCollapsedWhitespace = false; atLineStart = false;
      runId = nextRunId++; bufferOffset = 0; ownedOffset = 0;
      reportedSourceLength = 0; runLimited = false; oversizedReason = "run-size";
      runKind = "text"; runNode = null; runSnapshot = null; controlBaseOffset = 0; runControlTransform = "none"; runCssTransform = "none";
      runAccepted = false;
      assembledRunId = null;
      originalRunLength = 0; trailingIsSelected = false;
    }
    function suspendRun() {
      var saved = { parts: parts, segments: segments, mappingRecords: mappingRecords, length: runLength,
        root: runRoot, document: runDocument, sourceLength: runSourceLength,
        oversized: oversized, incomplete: incomplete, segmentCount: runSegmentCount,
        previousCollapsedWhitespace: previousCollapsedWhitespace, atLineStart: atLineStart,
        id: runId, bufferOffset: bufferOffset, ownedOffset: ownedOffset,
        reportedSourceLength: reportedSourceLength, limited: runLimited, oversizedReason: oversizedReason,
        kind: runKind, node: runNode, snapshot: runSnapshot, controlBaseOffset: controlBaseOffset, controlTransform: runControlTransform, cssTransform: runCssTransform,
        accepted: runAccepted, assembledRunId: assembledRunId, originalRunLength: originalRunLength, trailingIsSelected: trailingIsSelected };
      resetRun(true);
      return saved;
    }
    function restoreRun(saved) {
      parts = saved.parts; segments = saved.segments; mappingRecords = saved.mappingRecords; runLength = saved.length;
      runRoot = saved.root; runDocument = saved.document; runSourceLength = saved.sourceLength;
      oversized = saved.oversized; incomplete = saved.incomplete; runSegmentCount = saved.segmentCount;
      previousCollapsedWhitespace = saved.previousCollapsedWhitespace; atLineStart = saved.atLineStart;
      runId = saved.id; bufferOffset = saved.bufferOffset; ownedOffset = saved.ownedOffset;
      reportedSourceLength = saved.reportedSourceLength; runLimited = saved.limited; oversizedReason = saved.oversizedReason;
      runKind = saved.kind; runNode = saved.node; runSnapshot = saved.snapshot; controlBaseOffset = saved.controlBaseOffset;
      runControlTransform = saved.controlTransform;
      runCssTransform = saved.cssTransform;
      runAccepted = saved.accepted;
      assembledRunId = saved.assembledRunId;
      originalRunLength = saved.originalRunLength; trailingIsSelected = saved.trailingIsSelected;
    }
    function acceptEntry(entry) {
      if (!entry.node || !entry.node.isConnected || !globalThis.RRPageVisibility.isDocumentAttached(entry.node.ownerDocument)) return null;
      if ((!entry.stream && !entry.source || !runAccepted) && stats.logicalEntries >= limits.maxEntries) { stop("entries", false); return null; }
      var sourceLength = entry.sourceLength == null ? entry.text.length : entry.sourceLength;
      if (stats.sourceCharacters + sourceLength > limits.maxChars) { stop("characters", false); return null; }
      var segmentCount = entry.mappingRecords ? entry.mappingRecords.length : entry.segments ? entry.segments.length : 0;
      if (releasingBatches ? bufferedSegments + pendingBatchSegments + segmentCount > limits.maxTotalSegments :
          !entry.stream && stats.segments + segmentCount > limits.maxTotalSegments) { stop("segments", false); return null; }
      if (releasingBatches) pendingBatchSegments += segmentCount;
      entry.id = stats.entries++;
      var firstEntry = !entry.stream && !entry.source || !runAccepted;
      if (firstEntry) stats.logicalEntries += 1;
      if (entry.stream || entry.source) runAccepted = true;
      stats.characters += entry.stream ? entry.stream.ownedEnd - entry.stream.ownedStart : entry.source ? entry.text.length : options.selection && options.selection.kind === "control-selection" &&
        options.selection.node === entry.node ? sourceLength : entry.text.length;
      stats.sourceCharacters += sourceLength;
      stats.segments += segmentCount;
      if (firstEntry && entry.kind !== "text") stats.controlEntries += 1;
      if (firstEntry && entry.kind === "placeholder") stats.placeholderEntries += 1;
      if (firstEntry && entry.kind === "label") stats.labelEntries += 1;
      return entry;
    }
    function reserveSource(length) {
      // Skipped oversized/incomplete runs still consumed collection work.
      // Count their original characters before allocating display maps so
      // they cannot bypass the total scan budget by never becoming entries.
      if (stats.scannedSourceCharacters + length > limits.maxChars) { stop("characters", false); return false; }
      stats.scannedSourceCharacters += length;
      return true;
    }
    function removeTrailingCollapsed() {
      if (previousCollapsedWhitespace) originalRunLength = Math.max(0, originalRunLength - 1);
      if (compactMappings && previousCollapsedWhitespace && (!mappedTextSelection || trailingIsSelected) && runLength > bufferOffset) {
        var target = activeChunkParts && activeChunkParts.length ? activeChunkParts : parts;
        if (target.length) {
          runLength -= 1;
          var lastText = target[target.length - 1];
          if (lastText.length === 1) target.pop();
          else target[target.length - 1] = lastText.slice(0, -1);
          if (target === parts && mappingRecords.length) {
            var trailingRecord = mappingRecords[mappingRecords.length - 1];
            trailingRecord.end = Math.min(trailingRecord.end, runLength);
            if (trailingRecord.end <= trailingRecord.start) { mappingRecords.pop(); bufferedSegments -= 1; }
          }
        }
        previousCollapsedWhitespace = false; trailingIsSelected = false;
        return;
      }
      if (previousCollapsedWhitespace && (!mappedTextSelection || trailingIsSelected) && segments.length) {
        var trailing = segments[segments.length - 1];
        runLength -= 1;
        if (trailing.end - trailing.start === 1) { segments.pop(); parts.pop(); bufferedSegments -= 1; }
        else {
          trailing.end -= 1; trailing.nodeEnd -= 1;
          trailing.sourceText = trailing.sourceText.slice(0, -1);
          parts[parts.length - 1] = parts[parts.length - 1].slice(0, -1);
        }
      }
      previousCollapsedWhitespace = false;
      trailingIsSelected = false;
    }
    function invalidateRun() {
      incomplete = true;
      discardMaps(); runLength = 0;
    }
    function slicedMaps(start, end, offset) {
      var mapped = [];
      for (var i = 0; i < segments.length; i++) {
        var segment = segments[i];
        if (segment.end <= start) continue;
        if (segment.start >= end) break;
        var left = Math.max(start, segment.start), right = Math.min(end, segment.end);
        var sameOffsets = segment.end - segment.start === segment.nodeEnd - segment.nodeStart;
        var before = sameOffsets ? left - segment.start : 0;
        var after = sameOffsets ? right - segment.start : segment.nodeEnd - segment.nodeStart;
        mapped.push({ node: segment.node, start: left - offset, end: right - offset,
          nodeStart: segment.nodeStart + before, nodeEnd: segment.nodeStart + after,
          sourceText: segment.sourceText.slice(before, after), collapsedWhitespace: segment.collapsedWhitespace,
          whiteSpace: segment.whiteSpace, textTransform: segment.textTransform });
      }
      return mapped;
    }
    function pairBoundary(text, offset) {
      if (offset <= 0 || offset >= text.length) return false;
      var before = text.charCodeAt(offset - 1), after = text.charCodeAt(offset);
      return before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF;
    }
    function nearMappingLimit() {
      return segments.length >= Math.max(1, limits.maxRunSegments - LEGACY_SEGMENT_HEADROOM) ||
        bufferedSegments >= Math.max(1, (limits.maxTotalSegments - pendingBatchSegments) / 2 - LEGACY_SEGMENT_HEADROOM);
    }
    function* emitStream(final, completedBoundary, force) {
      // A resource cutoff is not a logical boundary. Keep real right context
      // unowned so the Worker can reject incomplete/whole-word edge matches.
      var maximumOwnedEnd = completedBoundary ? runLength : Math.max(0, runLength - afterChars);
      while (!stopped && ownedOffset < maximumOwnedEnd) {
        var stableEnd = runLength - (previousCollapsedWhitespace && (!mappedTextSelection || trailingIsSelected) ? 1 : 0);
        var currentCoreChars = coreChars;
        if (!final && stableEnd - ownedOffset < coreChars + afterChars + 1) {
          if (!force) return;
          currentCoreChars = Math.min(coreChars, stableEnd - ownedOffset - afterChars - 1);
          if (currentCoreChars <= 0) return;
        }
        var text = parts.length === 1 ? parts[0] : parts.join("");
        var ownedEnd = Math.min(maximumOwnedEnd, ownedOffset + currentCoreChars);
        if (pairBoundary(text, ownedEnd - bufferOffset)) ownedEnd += ownedEnd < maximumOwnedEnd ? 1 : -1;
        if (ownedEnd <= ownedOffset) return;
        var start = Math.max(0, ownedOffset - 2), end = Math.min(runLength, ownedEnd + afterChars);
        if (pairBoundary(text, start - bufferOffset)) start -= 1;
        if (pairBoundary(text, end - bufferOffset)) end += 1;
        if (!final && end > stableEnd) return;
        var records = compactMappings && runKind === "text" ? globalThis.RRTextMapping.sliceWindow(mappingRecords, start, end, start) : null;
        var maps = !compactMappings && runKind === "text" ? slicedMaps(start, end, start) : null;
        var entry = { node: records ? records[0] && records[0].node : maps ? maps[0] && maps[0].node : runNode,
          text: text.slice(start - bufferOffset, end - bufferOffset), kind: runKind, root: runRoot,
          sourceLength: Math.max(0, runSourceLength - reportedSourceLength),
          stream: { runId: runId, offset: start, ownedStart: ownedOffset, ownedEnd: ownedEnd,
            first: start === 0, last: !!completedBoundary && end === runLength } };
        if (records) entry.mappingRecords = records;
        else if (maps) entry.segments = maps;
        else {
          entry.displayTextSnapshot = runSnapshot;
          entry.controlOffset = controlBaseOffset + start;
          entry.displayOffset = entry.controlOffset;
          entry.controlTransform = runControlTransform;
          entry.textTransform = runCssTransform;
          entry.selectionProcessed = !!(options.selection && options.selection.kind === "control-selection");
        }
        if ((maps || records) && mappedTextSelection) entry.selectionProcessed = true;
        var accepted = entry ? acceptEntry(entry) : null;
        if (entry && !accepted) { invalidateRun(); return; }
        reportedSourceLength = runSourceLength;
        ownedOffset = ownedEnd;
        // Retain only the two preceding UTF-16 positions, plus a possible
        // surrogate partner. Future overlap maps do not accumulate per run.
        var retainStart = Math.max(0, ownedOffset - 3);
        if (pairBoundary(text, retainStart - bufferOffset)) retainStart -= 1;
        if (compactMappings && runKind === "text") {
          var retainedRecords = globalThis.RRTextMapping.sliceWindow(mappingRecords, retainStart, runLength, 0);
          bufferedSegments += retainedRecords.length - mappingRecords.length;
          mappingRecords = retainedRecords;
          parts = [text.slice(retainStart - bufferOffset)];
        } else if (runKind === "text") {
          var remainingMaps = slicedMaps(retainStart, runLength, 0);
          bufferedSegments += remainingMaps.length - segments.length;
          segments = remainingMaps;
          runSegmentCount = segments.length;
          parts = remainingMaps.map(function (segment) { return text.slice(segment.start - bufferOffset, segment.end - bufferOffset); });
        } else parts = [text.slice(retainStart - bufferOffset)];
        bufferOffset = retainStart;
        if (accepted) yield accepted;
      }
    }
    function* emitSource(final, completedBoundary) {
      // Keep a final real character until the structural end is known, so an
      // exact-size run still has a non-empty EOF fragment to complete it.
      var stableEnd = runLength - (previousCollapsedWhitespace && (!mappedTextSelection || trailingIsSelected) ? 1 : 0) - (final ? 0 : 1);
      while (!stopped && ownedOffset < stableEnd) {
        if (!final && stableEnd - ownedOffset < PHYSICAL_FRAGMENT_CHARS) return;
        var text = parts.length === 1 ? parts[0] : parts.join("");
        var end = Math.min(stableEnd, ownedOffset + PHYSICAL_FRAGMENT_CHARS);
        if (pairBoundary(text, end - bufferOffset)) end += end < stableEnd ? 1 : -1;
        if (end <= ownedOffset) return;
        var records = runKind === "text" ? globalThis.RRTextMapping.sliceWindow(mappingRecords, ownedOffset, end, ownedOffset) : null;
        var sourceId = assembledRunId == null ? stats.entries : assembledRunId;
        var entry = { node: records ? records[0] && records[0].node : runNode,
          text: text.slice(ownedOffset - bufferOffset, end - bufferOffset), kind: runKind, root: runRoot,
          sourceLength: Math.max(0, runSourceLength - reportedSourceLength),
          source: { runId: sourceId, offset: ownedOffset, first: assembledRunId == null,
            last: !!completedBoundary && end === runLength } };
        if (records) { entry.mappingRecords = records; entry.selectionProcessed = !!mappedTextSelection; }
        else {
          entry.displayTextSnapshot = runSnapshot; entry.controlOffset = controlBaseOffset + ownedOffset;
          entry.controlTransform = runControlTransform; entry.textTransform = runCssTransform;
          entry.selectionProcessed = !!(options.selection && options.selection.kind === "control-selection");
        }
        var accepted = acceptEntry(entry);
        if (!accepted) { invalidateRun(); return; }
        assembledRunId = sourceId;
        reportedSourceLength = runSourceLength; ownedOffset = end;
        if (records) {
          var remaining = globalThis.RRTextMapping.sliceWindow(mappingRecords, end, runLength, 0);
          bufferedSegments += remaining.length - mappingRecords.length;
          mappingRecords = remaining;
        }
        parts = [text.slice(end - bufferOffset)]; bufferOffset = end;
        yield accepted;
      }
    }
    function* flushRun(completedBoundary) {
      if (completedBoundary == null) completedBoundary = true;
      if (incomplete) {
        stats.incompleteRuns += 1;
        stats.incompleteCharacters += runSourceLength;
        resetRun();
        return;
      }
      if (oversized) {
        stats.oversizedRuns += 1;
        stats.oversizedCharacters += runSourceLength;
        stats.truncated = true;
        if (stats.reasons.indexOf(oversizedReason) === -1) stats.reasons.push(oversizedReason);
        resetRun();
        return;
      }
      // Collapsed trailing whitespace is not painted at a block boundary.
      removeTrailingCollapsed();
      if (!runLength) { resetRun(); return; }
      if (streamLiterals) {
        yield* emitStream(true, completedBoundary && !runLimited);
        if (runLimited) { stats.oversizedRuns += 1; stats.oversizedCharacters += runSourceLength; }
        resetRun();
        return;
      }
      if (fragmentRegex) {
        yield* emitSource(true, completedBoundary && !runLimited);
        resetRun();
        return;
      }
      var text = parts.length === 1 ? parts[0] : parts.join("");
      var nonWhitespace = false;
      for (var i = 0; i < text.length; i += RAW_CHUNK_CHARS) {
        if (/[^\t\n\r ]/.test(text.slice(i, i + RAW_CHUNK_CHARS))) { nonWhitespace = true; break; }
        yield null;
      }
      var entry = nonWhitespace ? {
        node: compactMappings ? mappingRecords[0].node : segments[0].node, text: text, kind: "text",
        segments: compactMappings ? undefined : segments, mappingRecords: compactMappings ? mappingRecords : undefined,
        root: runRoot, sourceLength: runSourceLength, selectionProcessed: !!scopedTextSelection
      } : null;
      resetRun();
      var accepted = entry ? acceptEntry(entry) : null;
      if (accepted) yield accepted;
    }
    function* asciiTransform(text, transform) {
      if (transform !== "uppercase" && transform !== "lowercase") return "none";
      // Decide once per original node/value. A later non-ASCII character must
      // not change the casing semantics of windows already sent to a Worker.
      for (var i = 0; i < text.length; i += RAW_CHUNK_CHARS) {
        if (/[^\x00-\x7f]/.test(text.slice(i, i + RAW_CHUNK_CHARS))) return "none";
        yield null;
      }
      return transform;
    }
    function markRunLimited(reason) {
      runLimited = true;
      stats.truncated = true;
      if (stats.reasons.indexOf(reason) === -1) stats.reasons.push(reason);
    }
    function* appendText(node, text, root, state, sourceOffset) {
      sourceOffset = sourceOffset || 0;
      runRoot = runRoot || root;
      runDocument = node.ownerDocument;
      runNode = runNode || node;
      var whiteSpace = state.whiteSpace || "normal";
      var collapseMode = state.whiteSpaceCollapse || "collapse";
      var collapse = collapseMode === "collapse" || collapseMode === "preserve-breaks";
      var preserveNewlines = collapseMode === "preserve-breaks";
      var transform = state.textTransform || "none";
      var actualTransform = yield* asciiTransform(text, transform);
      var selectedNodeStart = sourceOffset, selectedNodeEnd = sourceOffset + text.length;
      if (mappedTextSelection) {
        var selection = options.selection, intersects = false;
        try { intersects = selection.intersectsNode(node); } catch (_) { /* Other document. */ }
        if (!intersects) selectedNodeEnd = selectedNodeStart;
        else {
          if (selection.startContainer === node) selectedNodeStart = Math.max(selectedNodeStart, selection.startOffset);
          if (selection.endContainer === node) selectedNodeEnd = Math.min(selectedNodeEnd, selection.endOffset);
          selectedNodeEnd = Math.max(selectedNodeStart, selectedNodeEnd);
        }
      }
      var chunk, chunkOffset, currentChunkStart;
      function addPiece(start, end, collapsed) {
        if (stopped || end <= start) return;
        var sourceText = start === 0 && end === chunk.length ? chunk : chunk.slice(start, end);
        var rendered = collapsed ? " " : sourceText;
        if (!collapsed && collapseMode === "preserve-spaces") rendered = rendered.replace(/[\t\n\r]/g, " ");
        if (!collapsed && actualTransform === "uppercase") rendered = rendered.toUpperCase();
        else if (!collapsed && actualTransform === "lowercase") rendered = rendered.toLowerCase();
        if (collapsed && (!(mappedTextSelection ? originalRunLength : runLength) || previousCollapsedWhitespace || atLineStart)) return;
        originalRunLength += rendered.length;
        previousCollapsedWhitespace = collapsed || collapse && rendered.endsWith(" ");
        atLineStart = preserveNewlines && rendered.endsWith("\n");
        var nodeStart = start + sourceOffset + chunkOffset, nodeEnd = end + sourceOffset + chunkOffset;
        trailingIsSelected = false;
        if (mappedTextSelection) {
          var selection = options.selection;
          try { if (!selection.intersectsNode(node)) return; }
          catch (_) { return; }
          var chosenStart = selection.startContainer === node ? Math.max(nodeStart, selection.startOffset) : nodeStart;
          var chosenEnd = selection.endContainer === node ? Math.min(nodeEnd, selection.endOffset) : nodeEnd;
          if (chosenStart >= chosenEnd || collapsed && chosenStart > nodeStart) return;
          if (!collapsed) {
            rendered = rendered.slice(chosenStart - nodeStart, chosenEnd - nodeStart);
            sourceText = sourceText.slice(chosenStart - nodeStart, chosenEnd - nodeStart);
            trailingIsSelected = chosenEnd === nodeEnd;
          } else {
            sourceText = sourceText.slice(0, chosenEnd - nodeStart);
            trailingIsSelected = true;
          }
          nodeStart = chosenStart; nodeEnd = chosenEnd;
        }
        runSegmentCount += 1;
        if (runSegmentCount > limits.maxRunSegments) {
          if (streamLiterals) { stop("run-segments", false); return; }
          oversized = true; oversizedReason = "run-segments"; discardMaps(); return;
        }
        if ((releasingBatches ? bufferedSegments + pendingBatchSegments : streamLiterals ? bufferedSegments : stats.segments + bufferedSegments) >= limits.maxTotalSegments) { stop("segments", false); return; }
        if (compactMappings) {
          currentChunkStart = Math.min(currentChunkStart, runLength);
          activeChunkParts.push(rendered);
        } else {
          parts.push(rendered);
          segments.push({ node: node, start: runLength, end: runLength + rendered.length,
            nodeStart: nodeStart, nodeEnd: nodeEnd,
            sourceText: sourceText, collapsedWhitespace: collapsed,
            whiteSpace: whiteSpace, textTransform: transform });
          bufferedSegments += 1;
          stats.peakBufferedSegments = Math.max(stats.peakBufferedSegments, bufferedSegments);
        }
        runLength += rendered.length;
      }
      for (chunkOffset = 0; chunkOffset < text.length && !stopped; ) {
        var rawEnd = Math.min(text.length, chunkOffset + RAW_CHUNK_CHARS);
        if (pairBoundary(text, rawEnd)) rawEnd += 1;
        var available = limits.maxChars - stats.scannedSourceCharacters;
        var chargeStart = scopedTextSelection ? Math.max(chunkOffset + sourceOffset, selectedNodeStart) : chunkOffset + sourceOffset;
        var chargeEnd = scopedTextSelection ? Math.min(rawEnd + sourceOffset, selectedNodeEnd) : rawEnd + sourceOffset;
        var sourceChars = Math.max(0, chargeEnd - chargeStart);
        var exhausted = (streamLiterals || fragmentRegex) && available < sourceChars;
        if (exhausted) {
          rawEnd = chargeStart - sourceOffset + Math.max(0, available);
          if (pairBoundary(text, rawEnd)) rawEnd -= 1;
          sourceChars = Math.max(0, rawEnd + sourceOffset - chargeStart);
        }
        if (rawEnd <= chunkOffset) {
          if (streamLiterals || fragmentRegex) { yield* flushRun(false); stop("characters", false); }
          else stop("characters", false);
          return;
        }
        if (!reserveSource(sourceChars)) return;
        stats.processedSourceCharacters += rawEnd - chunkOffset;
        var previousSourceLength = runSourceLength;
        runSourceLength += sourceChars;
        if (incomplete || oversized || runLimited) {
          chunkOffset = rawEnd;
          yield null;
          continue;
        }
        var materialLimit = limits.maxRunChars;
        var permitted = Math.max(0, materialLimit - previousSourceLength);
        if (sourceChars > permitted && !streamLiterals && !fragmentRegex) {
          oversized = true;
          oversizedReason = "run-size";
          discardMaps(); chunkOffset = rawEnd; yield null; continue;
        }
        var processEnd = sourceChars > permitted ? Math.min(rawEnd, chargeStart - sourceOffset + permitted) : rawEnd;
        if (processEnd < rawEnd && pairBoundary(text, processEnd)) processEnd -= 1;
        chunk = text.slice(chunkOffset, processEnd);
        var chunkRecord = compactMappings ? { node: node, rawSnapshot: text, rawBaseOffset: sourceOffset,
          rawStart: chunkOffset + sourceOffset, rawEnd: processEnd + sourceOffset,
          displayStart: runLength, whiteSpace: whiteSpace, collapseMode: collapseMode,
          textTransform: transform, actualTransform: actualTransform,
          initialOriginalRunLength: originalRunLength, initialPreviousCollapsedWhitespace: previousCollapsedWhitespace,
          initialAtLineStart: atLineStart, initialTrailingIsSelected: trailingIsSelected,
          mappedSelection: !!mappedTextSelection, selectionIntersects: selectedNodeEnd > selectedNodeStart,
          selectionStart: selectedNodeStart, selectionEnd: selectedNodeEnd } : null;
        currentChunkStart = runLength;
        if (compactMappings) activeChunkParts = [];
        if (!collapse) addPiece(0, chunk.length, false);
        else {
          // A DOM carriage return is a CSS space; form feed stays a glyph.
          var pattern = preserveNewlines ? /[\t\r ]+|\n/g : /[\t\n\r ]+/g;
          var cursor = 0, match, processed = 0;
          while (!stopped && !oversized && (match = pattern.exec(chunk))) {
            if (++processed % NORMALIZATION_YIELD_INTERVAL === 0) {
              if (streamLiterals && !compactMappings) yield* emitStream(false, false, nearMappingLimit());
              yield null;
            }
            if (preserveNewlines && match[0] === "\n") {
              addPiece(cursor, match.index, false);
              removeTrailingCollapsed();
              addPiece(match.index, pattern.lastIndex, false);
              atLineStart = true;
              cursor = pattern.lastIndex;
              continue;
            }
            var leading = match.index === cursor && (!(mappedTextSelection ? originalRunLength : runLength) || previousCollapsedWhitespace || atLineStart);
            if (match[0] === " " && !leading) continue;
            addPiece(cursor, match.index, false);
            addPiece(match.index, pattern.lastIndex, true);
            cursor = pattern.lastIndex;
          }
          if (!stopped && !oversized) addPiece(cursor, chunk.length, false);
        }
        if (compactMappings) {
          if (activeChunkParts.length) parts.push(activeChunkParts.length === 1 ? activeChunkParts[0] : activeChunkParts.join(""));
          activeChunkParts = null;
          chunkRecord.start = currentChunkStart; chunkRecord.end = runLength;
          if (chunkRecord.end > chunkRecord.start) {
            mappingRecords.push(chunkRecord); bufferedSegments += 1;
            stats.peakBufferedSegments = Math.max(stats.peakBufferedSegments, bufferedSegments);
          }
        }
        if ((streamLiterals || fragmentRegex) && sourceChars > permitted) {
          markRunLimited("run-size");
          removeTrailingCollapsed();
          if (streamLiterals) yield* emitStream(true, false);
          else yield* emitSource(true, false);
        } else if (streamLiterals) yield* emitStream(false, false, nearMappingLimit());
        else if (fragmentRegex) yield* emitSource(false, false);
        chunkOffset = rawEnd;
        if (exhausted) {
          yield* flushRun(false);
          stop("characters", false);
          return;
        }
        // Every raw piece has a checkpoint, including preformatted strings
        // without whitespace and chunks that produce no painted characters.
        yield null;
      }
    }
    function notifyControlRead(node, observed) {
      if (typeof options.onControlRead !== "function") return;
      try { options.onControlRead(node, observed); } catch (_) { /* Optional observation cannot break collection. */ }
    }
    function* controlEntry(node, state) {
      if (options.includeControls === false) return null;
      if (options.selection && options.selection.kind !== "control-selection") return null;
      if (!node.isConnected || !globalThis.RRPageVisibility.isDocumentAttached(node.ownerDocument)) return null;
      var tag = String(node.tagName).toUpperCase();
      var text, kind = "control", transform = state.textTransform;
      var inputType = String(node.type || "text").toLowerCase();
      try {
        if (tag === "SELECT") {
          if (!state.visible || node.multiple || node.size > 1 || node.selectedIndex < 0) return null;
          text = String(node.options[node.selectedIndex].label);
          kind = "label";
          notifyControlRead(node);
        } else {
          if (tag !== "TEXTAREA" && (tag !== "INPUT" || (!TEXT_INPUTS[inputType] && inputType !== "password"))) return null;
          if (inputType === "password") {
            var placeholderShown = node.matches(":placeholder-shown");
            if (node.placeholder) notifyControlRead(node, { empty: placeholderShown });
            if (!placeholderShown) return null;
          }
          text = inputType === "password" ? "" : String(node.value || "");
          if (inputType !== "password") notifyControlRead(node, { value: text });
          if (!text && node.placeholder && (tag === "TEXTAREA" || /^(?:text|search|email|url|tel|password|number)$/.test(inputType))) {
            text = String(node.placeholder);
            kind = "placeholder";
            // Browsers can paint a placeholder with styles different from its
            // input. jsdom lacks pseudo-element layout/style support.
            var range = node.ownerDocument.createRange();
            if (typeof range.getClientRects === "function") {
              var pseudo = node.ownerDocument.defaultView.getComputedStyle(node, "::placeholder");
              transform = pseudo.textTransform || transform;
              if (pseudo.visibility === "hidden" || pseudo.display === "none" ||
                  pseudo.opacity !== "" && Number(pseudo.opacity) === 0 ||
                  pseudo.fontSize && parseFloat(pseudo.fontSize) === 0 ||
                  globalThis.RRPageVisibility.transparentColor(pseudo.color)) return null;
            } else if (!state.visible) return null;
          } else if (!state.visible || inputType === "password") return null;
        }
      } catch (_) { return null; }
      var sourceLength = text.length, selected = options.selection;
      if (selected && selected.kind === "control-selection") {
        if (selected.node !== node || kind !== "control" || text !== selected.valueSnapshot ||
            !Number.isInteger(selected.start) || !Number.isInteger(selected.end) ||
            selected.start < 0 || selected.end <= selected.start || selected.end > text.length) return null;
        // Keep the complete value/display snapshot for control validation and
        // navigation; the controller only sends the chosen substring to its
        // Worker. Budget the part the user actually asked to search.
        sourceLength = selected.end - selected.start;
      }
      var selectedControl = selected && selected.kind === "control-selection";
      var snapshot = text, actualTransform = yield* asciiTransform(text, transform);
      var chosenStart = selectedControl ? selected.start : 0;
      var chosenEnd = selectedControl ? selected.end : text.length;
      if (!streamLiterals && !fragmentRegex) {
        if (!reserveSource(sourceLength)) return;
        if (sourceLength > limits.maxRunChars) {
          stats.oversizedRuns += 1; stats.oversizedCharacters += sourceLength; stats.truncated = true;
          var reason = "run-size";
          if (stats.reasons.indexOf(reason) === -1) stats.reasons.push(reason);
          return;
        }
        // Small selections retain the historical complete-value contract.
        // Huge values keep only the chosen display slice, with original offsets.
        var processedSelection = selectedControl && text.length > LEGACY_CONTROL_SNAPSHOT_CHARS;
        var displayStart = processedSelection ? chosenStart : 0;
        var displayEnd = processedSelection ? chosenEnd : text.length;
        var displayed = [], nonWhitespace = false;
        for (var offset = displayStart; offset < displayEnd; ) {
          var end = Math.min(displayEnd, offset + RAW_CHUNK_CHARS);
          if (end < displayEnd && pairBoundary(text, end)) end += 1;
          var piece = text.slice(offset, end);
          if (/\S/.test(piece)) nonWhitespace = true;
          if (actualTransform === "uppercase") piece = piece.toUpperCase();
          else if (actualTransform === "lowercase") piece = piece.toLowerCase();
          displayed.push(piece); offset = end;
          yield null;
        }
        if (!nonWhitespace) return;
        var entry = { node: node, text: displayed.length === 1 ? displayed[0] : displayed.join(""), kind: kind,
          displayTextSnapshot: snapshot, sourceLength: sourceLength, root: node.getRootNode(),
          textTransform: transform || "none", controlTransform: actualTransform };
        if (processedSelection) {
          entry.selectionProcessed = true; entry.controlOffset = chosenStart;
          entry.textTransform = transform || "none"; entry.controlTransform = actualTransform;
        }
        var accepted = acceptEntry(entry);
        if (accepted) yield accepted;
        return;
      }
      runKind = kind; runNode = node; runSnapshot = snapshot;
      controlBaseOffset = chosenStart; runControlTransform = actualTransform;
      runCssTransform = transform || "none";
      runRoot = node.getRootNode(); runDocument = node.ownerDocument;
      var hasPaintedText = false;
      // Do not create matches from a completely empty/blank control. The
      // checkpointed check also avoids an unbounded whole-value RegExp call.
      var probeEnd = Math.min(chosenEnd, chosenStart + limits.maxRunChars,
        chosenStart + Math.max(0, limits.maxChars - stats.scannedSourceCharacters));
      for (var probe = chosenStart; probe < probeEnd; probe += RAW_CHUNK_CHARS) {
        if (/\S/.test(text.slice(probe, Math.min(probeEnd, probe + RAW_CHUNK_CHARS)))) { hasPaintedText = true; break; }
        yield null;
      }
      for (var cursor = chosenStart; cursor < chosenEnd && !stopped; ) {
        var rawEnd = Math.min(chosenEnd, cursor + RAW_CHUNK_CHARS);
        if (rawEnd < chosenEnd && pairBoundary(text, rawEnd)) rawEnd += 1;
        var available = limits.maxChars - stats.scannedSourceCharacters;
        var exhausted = available < rawEnd - cursor;
        if (exhausted) rawEnd = cursor + Math.max(0, available);
        if (exhausted && pairBoundary(text, rawEnd)) rawEnd -= 1;
        if (rawEnd <= cursor) { yield* flushRun(false); stop("characters", false); return; }
        var rawChars = rawEnd - cursor, previousSourceLength = runSourceLength;
        if (!reserveSource(rawChars)) return;
        runSourceLength += rawChars;
        var permitted = Math.max(0, limits.maxRunChars - previousSourceLength);
        if (!incomplete && !runLimited && hasPaintedText) {
          var processEnd = Math.min(rawEnd, cursor + permitted);
          if (processEnd < rawEnd && pairBoundary(text, processEnd)) processEnd -= 1;
          var part = text.slice(cursor, processEnd);
          if (actualTransform === "uppercase") part = part.toUpperCase();
          else if (actualTransform === "lowercase") part = part.toLowerCase();
          if (part) { parts.push(part); runLength += part.length; }
        }
        if (!incomplete && !runLimited && rawChars > permitted) {
          markRunLimited("run-size");
          if (streamLiterals) yield* emitStream(true, false);
          else yield* emitSource(true, false);
        } else if (!incomplete && !runLimited) {
          if (streamLiterals) yield* emitStream(false, false);
          else yield* emitSource(false, false);
        }
        cursor = rawEnd;
        if (exhausted) { yield* flushRun(false); stop("characters", false); return; }
        yield null;
      }
      yield* flushRun(true);
    }
    function childFrame(node, state, root) {
      return { kind: "children", next: node.firstChild, state: state, root: root };
    }
    function* iterate() {
      var requestedRoot = options.root || document;
      var startNode = requestedRoot.nodeType === 9 ? requestedRoot.body || requestedRoot.documentElement : requestedRoot;
      if (!startNode || !startNode.isConnected || !globalThis.RRPageVisibility.isDocumentAttached(startNode.ownerDocument)) return;
      var selected = options.selection;
      if (selected && selected.kind !== "control-selection" && selected.startContainer === selected.endContainer &&
          selected.startContainer && selected.startContainer.nodeType === 3) {
        var selectedNode = selected.startContainer, value = selectedNode.nodeValue;
        if (Number.isInteger(selected.startOffset) && Number.isInteger(selected.endOffset) &&
            selected.startOffset >= 0 && selected.endOffset > selected.startOffset && selected.endOffset <= value.length) {
          var chosen = value.slice(selected.startOffset, selected.endOffset);
          // Cropping general collapsed whitespace needs the surrounding inline
          // context. This precise fast path only changes a single Text range
          // whose selected source contains no CSS-collapsible characters.
          var preciseSelected = true;
          for (var selectedCursor = 0; selectedCursor < chosen.length; selectedCursor += RAW_CHUNK_CHARS) {
            if (/[\t\n\r ]/.test(chosen.slice(selectedCursor, selectedCursor + RAW_CHUNK_CHARS))) { preciseSelected = false; break; }
            yield null;
          }
          if (preciseSelected) {
            selectionTextNode = selectedNode; selectionTextOffset = selected.startOffset; selectionText = chosen;
          }
        }
      }
      var root = requestedRoot.nodeType === 9 || requestedRoot.nodeType === 11 ? requestedRoot : requestedRoot.getRootNode();
      addRoot(root, root.nodeType === 11 ? "shadow" : "document");
      var stack = [{ kind: "node", node: startNode, state: visibility.ancestorState(startNode), root: root }];
      while (stack.length && !stopped) {
        var frame = stack[stack.length - 1];
        if (frame.kind === "restore-run") {
          stack.pop();
          restoreRun(frame.run);
          continue;
        }
        if (frame.kind === "exit") {
          stack.pop();
          yield* flushRun();
          continue;
        }
        var node;
        if (frame.kind === "children" || frame.kind === "summary") {
          node = frame.next;
          if (!node) { stack.pop(); continue; }
          frame.next = node.nextSibling;
        } else if (frame.kind === "list") {
          if (frame.index >= frame.nodes.length) { stack.pop(); continue; }
          node = frame.nodes[frame.index++];
        } else { stack.pop(); node = frame.node; }
        // Checkpoint for each visited node, even empty or excluded nodes.
        yield null;
        if (seenNodes.has(node)) continue;
        if (stats.visitedNodes >= limits.maxVisitedNodes) { stop("nodes", false); break; }
        seenNodes.add(node);
        stats.visitedNodes += 1;
        if (frame.kind === "summary") {
          if (node.nodeType !== 1 || String(node.tagName).toUpperCase() !== "SUMMARY") continue;
          // The first direct summary is the sole rendered branch of a closed
          // details. Searching for it shares the normal time/cancel budget.
          stack.pop();
          frame.state.summary = node;
        }
        if (node.nodeType === 3) {
          stats.visitedTextNodes += 1;
          if (selectionTextNode && node !== selectionTextNode) continue;
          if (!frame.state.visible || frame.state.hiddenSubtree || frame.state.textRenderable === false ||
              !globalThis.RRPageVisibility.isDocumentAttached(node.ownerDocument) || !node.nodeValue) continue;
          var textRoot = node.getRootNode();
          if (runDocument && runDocument !== node.ownerDocument) {
            yield* flushRun();
          }
          stats.textNodes += 1;
          yield* appendText(node, selectionTextNode ? selectionText : node.nodeValue, textRoot, frame.state,
            selectionTextNode ? selectionTextOffset : 0);
          continue;
        }
        if (node.nodeType === 11) {
          if (frame.state.hiddenSubtree) continue;
          stack.push({ kind: "exit" });
          stack.push(childFrame(node, frame.state, node));
          continue;
        }
        if (node.nodeType !== 1) continue;
        var tag = String(node.tagName).toUpperCase();
        if (tag === "IFRAME" || tag === "FRAME") stats.frames += 1;
        var state = visibility.inspectElement(node, frame.state);
        if (state.hiddenSubtree) {
          stats.hiddenElements += 1;
          if (tag === "IFRAME" || tag === "FRAME") stats.hiddenFrames += 1;
          continue;
        }
        if (state.rubyAnnotation) {
          // Ruby annotations paint beside their base text. Search each
          // annotation separately while preserving the surrounding base run,
          // so a word split by rt elements can still be matched in full.
          stack.push({ kind: "restore-run", run: suspendRun() });
        }
        if (state.block || tag === "BR" || tag === "HR" || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "IFRAME" || tag === "FRAME") {
          yield* flushRun();
        }
        if (stopped) break;
        if (tag === "BR" || tag === "HR") continue;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
          if (!state.visibilityHidden) {
            yield* controlEntry(node, state);
          }
          continue;
        }
        if (tag === "IFRAME" || tag === "FRAME") {
          if (state.visibilityHidden) { stats.hiddenFrames += 1; continue; }
          var frameDocument = null;
          try {
            frameDocument = node.contentDocument;
            if (!frameDocument && node.contentWindow) frameDocument = node.contentWindow.document;
          } catch (_) { /* Cross-origin or sandboxed document. */ }
          if (!frameDocument || !globalThis.RRPageVisibility.isDocumentAttached(frameDocument)) { stats.inaccessibleFrames += 1; continue; }
          if (!addRoot(frameDocument, "document", node)) continue;
          var body = frameDocument.body || frameDocument.documentElement;
          if (body) {
            stack.push({ kind: "exit" });
            stack.push({ kind: "node", node: body, state: visibility.forFrame(state), root: frameDocument });
          }
          continue;
        }
        if (state.block) stack.push({ kind: "exit" });
        var shadowRoot = globalThis.RRPageVisibility.getShadowRoot(node);
        if (shadowRoot) {
          if (addRoot(shadowRoot, "shadow")) stack.push(childFrame(shadowRoot, state, shadowRoot));
          else invalidateRun();
          continue;
        }
        if (tag === "SLOT" && typeof node.assignedNodes === "function") {
          // Traverse nested slots themselves so their visibility is checked.
          var assigned = node.assignedNodes();
          if (assigned.length) stack.push({ kind: "list", nodes: assigned, index: 0, state: state, root: frame.root });
          else stack.push(childFrame(node, state, frame.root));
          continue;
        }
        if (state.closedDetails) {
          var summaryFrame = childFrame(node, state, frame.root);
          summaryFrame.kind = "summary";
          stack.push(summaryFrame);
          continue;
        }
        stack.push(childFrame(node, state, frame.root));
      }
      if (!stopped) {
        yield* flushRun();
      }
    }
    function finish() {
      resetRun();
      stats.elapsedMs = Math.max(0, now() - startedAt);
      if (options.onStats) options.onStats(stats);
    }
    return { iterator: iterate(), stats: stats, roots: roots, canContinue: canContinue, stop: stop, finish: finish,
      releaseSegments: function (count) { pendingBatchSegments = Math.max(0, pendingBatchSegments - count); },
      shouldFlushBatch: function () { return releasingBatches && pendingBatchSegments >= Math.max(1, limits.maxTotalSegments / 4); } };
  }
  function resultArray(scan) {
    var entries = [];
    Object.defineProperties(entries, {
      stats: { value: scan.stats, enumerable: false }, roots: { value: scan.roots, enumerable: false }
    });
    return entries;
  }
  function collect(options) {
    var scan = createScan(options), entries = resultArray(scan);
    try {
      while (scan.canContinue()) {
        var step = scan.iterator.next();
        if (step.done) break;
        if (step.value) entries.push(step.value);
      }
    } finally { scan.iterator.return(); scan.finish(); }
    return entries;
  }
  async function collectBatched(options) {
    options = options || {};
    var scan = createScan(options), entries = resultArray(scan);
    var batchSize = numberOption(options, "batchSize", BATCH_OPTIONS.nodes.defaultValue, 1, BATCH_OPTIONS.nodes.max);
    var budgetMs = numberOption(options, "budgetMs", BATCH_OPTIONS.milliseconds.defaultValue, 1, BATCH_OPTIONS.milliseconds.max);
    var maxBatchSourceChars = numberOption(options, "maxBatchSourceChars", POLICY.transport.maxBatchChars, 1, POLICY.transport.maxBatchChars);
    var maxBatchSegments = numberOption(options, "maxBatchSegments", BATCH_OPTIONS.segments.defaultValue, 1, BATCH_OPTIONS.segments.max);
    var batch = [], batchSourceChars = 0, batchSegments = 0, visitedAtYield = 0, startedAt = now();
    try {
      while (scan.canContinue()) {
        var step = scan.iterator.next();
        if (step.done) break;
        if (step.value) {
          // A long collapsed source span occupies only its displayed window.
          // Streaming batches bound transported strings, not logical source work.
          var sourceChars = step.value.stream || step.value.source ? step.value.text.length :
            step.value.sourceLength == null ? step.value.text.length : step.value.sourceLength;
          var segmentCount = step.value.mappingRecords ? step.value.mappingRecords.length : step.value.segments ? step.value.segments.length : 0;
          if (options.onBatch && batch.length && (batchSourceChars + sourceChars > maxBatchSourceChars || batchSegments + segmentCount > maxBatchSegments)) {
            if (await options.onBatch(batch) === false) { scan.stop("onBatch", true); break; }
            scan.releaseSegments(batchSegments);
            batch = []; batchSourceChars = 0; batchSegments = 0;
            if (!scan.canContinue()) break;
          }
          if (options.storeNodes !== false) entries.push(step.value);
          if (options.onBatch) { batch.push(step.value); batchSourceChars += sourceChars; batchSegments += segmentCount; }
        }
        var budgetExpired = now() - startedAt >= budgetMs;
        var batchFull = batch.length >= batchSize || batchSourceChars >= maxBatchSourceChars || batchSegments >= maxBatchSegments || scan.shouldFlushBatch();
        if (batchFull || scan.stats.visitedNodes - visitedAtYield >= batchSize || budgetExpired) {
          if (batch.length && options.onBatch && (batchFull || budgetExpired)) {
            if (await options.onBatch(batch) === false) { scan.stop("onBatch", true); break; }
            scan.releaseSegments(batchSegments);
            batch = []; batchSourceChars = 0; batchSegments = 0;
          }
          if (!scan.canContinue()) break;
          if (options.onStats) options.onStats(scan.stats);
          await yieldToMainThread();
          visitedAtYield = scan.stats.visitedNodes;
          startedAt = now();
        }
      }
      if (batch.length && !scan.stats.aborted && options.onBatch) {
        if (await options.onBatch(batch) === false) scan.stop("onBatch", true);
        else scan.releaseSegments(batchSegments);
      }
    } finally { scan.iterator.return(); scan.finish(); }
    return entries;
  }
  function yieldToMainThread() {
    if (globalThis.RRTaskScheduler) return globalThis.RRTaskScheduler.yield();
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  function now() {
    return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  }
  /** Crop displayed text using its original DOM offsets, including collapsed spaces. */
  function normalizeSelection(entry, selection) {
    if (!selection) return entry;
    if (!entry || entry.kind && entry.kind !== "text" || selection.collapsed) return null;
    var source = entry.segments || [{ node: entry.node, start: 0, end: entry.text.length,
      nodeStart: 0, nodeEnd: entry.text.length, sourceText: entry.text }];
    var parts = [], mapped = [], offset = 0, sourceLength = 0;
    var originalStart = null, originalEnd = null;
    for (var i = 0; i < source.length; i++) {
      var segment = source[i], node = segment.node;
      try { if (!selection.intersectsNode(node)) continue; }
      catch (_) { continue; }
      var nodeStart = segment.nodeStart || 0;
      var nodeEnd = segment.nodeEnd == null ? nodeStart + segment.end - segment.start : segment.nodeEnd;
      var start = selection.startContainer === node ? Math.max(nodeStart, selection.startOffset) : nodeStart;
      var end = selection.endContainer === node ? Math.min(nodeEnd, selection.endOffset) : nodeEnd;
      if (start >= end) continue;
      var raw = segment.sourceText == null ? entry.text.slice(segment.start, segment.end) : segment.sourceText;
      var rendered;
      if (segment.end - segment.start === nodeEnd - nodeStart) {
        rendered = entry.text.slice(segment.start + start - nodeStart, segment.start + end - nodeStart);
        if (originalStart == null) originalStart = segment.start + start - nodeStart;
        originalEnd = segment.start + end - nodeStart;
      } else {
        // One painted space can correspond to several source whitespace characters.
        // Only the first source position paints that space; selecting its
        // collapsed-away tail does not select an additional visible character.
        if (start > nodeStart) continue;
        rendered = entry.text.slice(segment.start, segment.end);
        if (originalStart == null) originalStart = segment.start;
        originalEnd = segment.end;
      }
      var sourceText = raw.slice(start - nodeStart, end - nodeStart);
      parts.push(rendered);
      mapped.push({ node: node, start: offset, end: offset + rendered.length,
        nodeStart: start, nodeEnd: end, sourceText: sourceText,
        collapsedWhitespace: !!segment.collapsedWhitespace,
        whiteSpace: segment.whiteSpace, textTransform: segment.textTransform });
      offset += rendered.length;
      sourceLength += sourceText.length;
    }
    if (!mapped.length) return null;
    var cropped = { id: entry.id, node: mapped[0].node, kind: "text",
      text: parts.join(""), segments: mapped, root: entry.root, sourceLength: sourceLength };
    if (entry.stream) {
      var stream = entry.stream, windowStart = stream.offset + originalStart;
      var windowEnd = stream.offset + originalEnd;
      var ownedStart = Math.max(stream.ownedStart, windowStart), ownedEnd = Math.min(stream.ownedEnd, windowEnd);
      if (ownedStart >= ownedEnd) return null;
      var firstMap = mapped[0], lastMap = mapped[mapped.length - 1];
      cropped.stream = { runId: stream.runId, offset: windowStart, ownedStart: ownedStart, ownedEnd: ownedEnd,
        first: stream.first || originalStart > 0 || selection.startContainer === firstMap.node && selection.startOffset === firstMap.nodeStart,
        last: stream.last || originalEnd < entry.text.length || selection.endContainer === lastMap.node && selection.endOffset === lastMap.nodeEnd };
      cropped.selectionProcessed = true;
    }
    return cropped;
  }
  globalThis.RRTextCollector = { collect: collect, collectBatched: collectBatched, normalizeSelection: normalizeSelection };
})();
