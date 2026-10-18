/** Resolve displayed text positions from sparse, immutable source recipes. */
(function () {
  "use strict";
  var REPLAY_YIELD_INTERVAL = 8192;
  var SPAN_YIELD_INTERVAL = 256;
  var LEGACY_MATCH_YIELD_INTERVAL = 64;
  var MAX_UINT32 = 0xffffffff;

  function integer(value) { return Number.isSafeInteger(value); }
  function startOf(record) { return record.start == null ? record.displayStart : record.start; }
  function endOf(record) { return record.end == null ? record.displayEnd : record.end; }

  // A window changes only display coordinates. The original source and the
  // normalization context remain shared; no whitespace maps are expanded.
  function sliceWindow(records, start, end, offset) {
    offset = offset == null ? 0 : offset;
    if (!Array.isArray(records) || !integer(start) || !integer(end) || !integer(offset) || end < start) return [];
    var result = [];
    for (var index = 0; index < records.length; index++) {
      var record = records[index];
      if (!record || !integer(record.displayStart) || !integer(startOf(record)) || !integer(endOf(record))) return [];
      var left = Math.max(start, startOf(record)), right = Math.min(end, endOf(record));
      if (right <= left) continue;
      var copy = Object.assign({}, record, { start: left - offset, end: right - offset,
        displayStart: record.displayStart - offset,
        initialDisplayedLength: record.initialDisplayedLength == null ? record.displayStart : record.initialDisplayedLength });
      if (record.displayEnd != null) copy.displayEnd = record.displayEnd - offset;
      result.push(copy);
    }
    return result;
  }

  function validRecord(record) {
    if (!record || typeof record !== "object") return false;
    var base = record.rawBaseOffset == null ? 0 : record.rawBaseOffset;
    return record && record.node && typeof record.rawSnapshot === "string" &&
      integer(base) && integer(record.rawStart) && integer(record.rawEnd) &&
      record.rawStart >= base && record.rawEnd >= record.rawStart && record.rawEnd - base <= record.rawSnapshot.length &&
      integer(record.displayStart) && integer(startOf(record)) && integer(endOf(record)) && endOf(record) >= startOf(record);
  }

  // The dense positions exist only while resolving one raw chunk that actually
  // contains a hit. They are released before processing the next recipe.
  function* replay(record) {
    var capacity = record.rawEnd - record.rawStart;
    var base = record.rawBaseOffset == null ? 0 : record.rawBaseOffset;
    var raw = record.rawSnapshot, rawStart = record.rawStart, rawEnd = record.rawEnd;
    var mode = record.collapseMode || "collapse";
    var collapse = mode === "collapse" || mode === "preserve-breaks";
    var preserveNewlines = mode === "preserve-breaks";
    var mapped = record.mappedSelection === true;
    var selected = !mapped || record.selectionIntersects !== false;
    var selectionStart = mapped && integer(record.selectionStart) ? record.selectionStart : rawStart;
    var selectionEnd = mapped && integer(record.selectionEnd) ? record.selectionEnd : rawEnd;
    var originalLength = record.initialOriginalRunLength || 0;
    var initialLength = record.initialDisplayedLength == null ? record.displayStart : record.initialDisplayedLength;
    var previousWhitespace = !!record.initialPreviousCollapsedWhitespace;
    var lineStart = !!record.initialAtLineStart;
    var trailingSelected = !!record.initialTrailingIsSelected;
    var externalTrim = 0, operations = 0;
    var firstCode = raw.charCodeAt(rawStart - base);
    var linear = !collapse || !/[\t\r\n]| {2}/.test(raw.slice(rawStart - base, rawEnd - base)) &&
      !(firstCode === 32 && (!(mapped ? originalLength : initialLength) || previousWhitespace || lineStart));
    if (linear) {
      var linearStart = selected ? Math.max(rawStart, selectionStart) : rawStart;
      var linearEnd = selected ? Math.max(linearStart, Math.min(rawEnd, selectionEnd)) : rawStart;
      return { linear: true, nodeStart: linearStart, length: linearEnd - linearStart, displayStart: record.displayStart };
    }
    // Source offsets can exceed 32 bits, but these arrays only address this
    // recipe's raw window. Keep the absolute base as a Number outside them.
    var OffsetArray = capacity <= MAX_UINT32 ? Uint32Array : Float64Array;
    var starts = new OffsetArray(capacity), ends = new OffsetArray(capacity);
    var breaks = new Uint32Array(capacity + 1), count = 0, breakCount = 0;

    function append(sourceStart, sourceEnd) {
      sourceStart -= rawStart; sourceEnd -= rawStart;
      if (!count || ends[count - 1] !== sourceStart) breaks[breakCount++] = count;
      starts[count] = sourceStart; ends[count] = sourceEnd; count++;
    }
    function trimTrailing() {
      if (previousWhitespace) originalLength = Math.max(0, originalLength - 1);
      if (previousWhitespace && (!mapped || trailingSelected) && initialLength + count - externalTrim > 0) {
        if (count) {
          count--;
          while (breakCount && breaks[breakCount - 1] >= count) breakCount--;
        } else externalTrim++;
      }
      previousWhitespace = false; trailingSelected = false;
    }
    function* piece(start, end, collapsed) {
      if (end <= start) return;
      var length = collapsed ? 1 : end - start;
      if (collapsed && (!(mapped ? originalLength : initialLength + count - externalTrim) || previousWhitespace || lineStart)) return;
      originalLength += length;
      previousWhitespace = collapsed || collapse && raw.charCodeAt(end - base - 1) === 32;
      lineStart = preserveNewlines && raw.charCodeAt(end - base - 1) === 10;
      trailingSelected = false;
      if (!selected) return;
      var left = mapped ? Math.max(start, selectionStart) : start;
      var right = mapped ? Math.min(end, selectionEnd) : end;
      if (left >= right || collapsed && left > start) return;
      trailingSelected = collapsed || right === end;
      if (collapsed) { append(left, right); return; }
      for (var position = left; position < right; position++) {
        append(position, position + 1);
        if (++operations % REPLAY_YIELD_INTERVAL === 0) yield null;
      }
    }
    function whitespace(code) { return code === 9 || code === 13 || code === 32 || !preserveNewlines && code === 10; }

    if (!collapse) yield* piece(rawStart, rawEnd, false);
    else {
      var cursor = rawStart, scan = rawStart;
      while (scan < rawEnd) {
        var code = raw.charCodeAt(scan - base);
        if (preserveNewlines && code === 10) {
          yield* piece(cursor, scan, false);
          trimTrailing();
          yield* piece(scan, scan + 1, false);
          lineStart = true; scan++; cursor = scan;
        } else if (whitespace(code)) {
          var whitespaceStart = scan;
          do {
            scan++;
            if (++operations % REPLAY_YIELD_INTERVAL === 0) yield null;
          } while (scan < rawEnd && whitespace(raw.charCodeAt(scan - base)));
          var leading = whitespaceStart === cursor && (!(mapped ? originalLength : initialLength + count - externalTrim) || previousWhitespace || lineStart);
          // The collector leaves one ordinary inline space inside its linear
          // text piece; retaining it here preserves its one-to-one offsets.
          if (scan - whitespaceStart === 1 && code === 32 && !leading) continue;
          yield* piece(cursor, whitespaceStart, false);
          yield* piece(whitespaceStart, scan, true);
          cursor = scan;
        } else {
          scan++;
          if (++operations % REPLAY_YIELD_INTERVAL === 0) yield null;
        }
      }
      yield* piece(cursor, rawEnd, false);
    }
    breaks[breakCount] = count;
    return { starts: starts, ends: ends, nodeStart: rawStart, breaks: breaks, breakCount: breakCount,
      length: count, displayStart: record.displayStart - externalTrim };
  }

  function breakAt(replayed, offset) {
    var lo = 0, hi = replayed.breakCount;
    while (lo < hi) {
      var middle = Math.floor((lo + hi) / 2);
      if (replayed.breaks[middle] <= offset) lo = middle + 1;
      else hi = middle;
    }
    return Math.max(0, lo - 1);
  }
  function* appendSpan(result, record, replayed, start, end) {
    var localStart = start - replayed.displayStart, localEnd = end - replayed.displayStart;
    if (localStart < 0 || localEnd > replayed.length || localEnd <= localStart) return false;
    var group = replayed.linear ? 0 : breakAt(replayed, localStart), position = localStart;
    var base = record.rawBaseOffset == null ? 0 : record.rawBaseOffset;
    var operations = 0;
    while (position < localEnd) {
      if (++operations % SPAN_YIELD_INTERVAL === 0) yield null;
      var right = replayed.linear ? localEnd : Math.min(localEnd, replayed.breaks[group + 1]);
      if (right <= position) return false;
      var nodeStart = replayed.nodeStart + (replayed.linear ? position : replayed.starts[position]);
      var nodeEnd = replayed.nodeStart + (replayed.linear ? right : replayed.ends[right - 1]);
      var displayStart = replayed.displayStart + position - result.start;
      var displayEnd = replayed.displayStart + right - result.start;
      var previous = result.spans[result.spans.length - 1];
      if (previous && previous.node === record.node && previous.nodeEnd === nodeStart &&
          previous.rawSnapshot === record.rawSnapshot && previous.snapshotEnd === nodeStart - base &&
          previous.whiteSpace === record.whiteSpace && previous.textTransform === record.textTransform &&
          previous.collapseMode === record.collapseMode && previous.actualTransform === record.actualTransform && previous.end === displayStart) {
        previous.nodeEnd = nodeEnd; previous.snapshotEnd = nodeEnd - base; previous.end = displayEnd;
      } else result.spans.push({ node: record.node, nodeStart: nodeStart, nodeEnd: nodeEnd,
        rawSnapshot: record.rawSnapshot, snapshotStart: nodeStart - base, snapshotEnd: nodeEnd - base,
        start: displayStart, end: displayEnd, whiteSpace: record.whiteSpace,
        textTransform: record.textTransform, collapseMode: record.collapseMode, actualTransform: record.actualTransform });
      position = right; group++;
    }
    return true;
  }

  // Mapping owns the data traversal; callers own deadlines and page scheduling.
  // Keep one initial Promise boundary so callers can cancel after requesting
  // a mapping. Later synchronous checkpoints avoid microtasks per source.
  async function runResolution(steps, options) {
    options = options || {};
    var initialBoundary = true;
    try {
      while (true) {
        var step = steps.next();
        if (step.done) return step.value;
        if (options.shouldContinue && !options.shouldContinue()) return null;
        var continued = options.checkpoint ? options.checkpoint() : true;
        if (continued === false) return null;
        if (initialBoundary || continued && typeof continued.then === "function") {
          initialBoundary = false;
          continued = await continued;
          if (continued === false || options.shouldContinue && !options.shouldContinue()) return null;
        }
      }
    } finally { steps.return(); }
  }

  function* resolveMatchSteps(records, intervals) {
    if (!Array.isArray(records) || !Array.isArray(intervals)) return null;
    var results = [], sorted = true;
    for (var i = 0; i < intervals.length; i++) {
      if (i && i % SPAN_YIELD_INTERVAL === 0) yield null;
      var interval = intervals[i];
      if (!interval || !integer(interval.start) || !integer(interval.end) || interval.start < 0 || interval.end <= interval.start) return null;
      if (i && interval.start < intervals[i - 1].start) sorted = false;
      results.push(Object.assign({}, interval, { spans: [] }));
    }
    var ordered = sorted ? results : results.slice().sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    for (var matchOrder = 1; matchOrder < ordered.length; matchOrder++) {
      if (matchOrder % SPAN_YIELD_INTERVAL === 0) yield null;
      if (ordered[matchOrder].start < ordered[matchOrder - 1].end) return null;
    }
    var previousEnd = -Infinity, firstMatch = 0;
    for (var index = 0; index < records.length; index++) {
      var record = records[index];
      if (!validRecord(record) || startOf(record) < previousEnd) return null;
      previousEnd = endOf(record);
      // Records and intervals are ordered and non-overlapping. Advance one
      // cursor instead of repeating a binary search for every source recipe.
      while (firstMatch < ordered.length && ordered[firstMatch].end <= startOf(record)) {
        firstMatch++;
        if (firstMatch % SPAN_YIELD_INTERVAL === 0) yield null;
      }
      var first = firstMatch;
      if (first >= ordered.length || ordered[first].start >= endOf(record)) {
        if (index % SPAN_YIELD_INTERVAL === 0) yield null;
        continue;
      }
      yield null;
      var replayed = yield* replay(record);
      for (var matchIndex = first; matchIndex < ordered.length && ordered[matchIndex].start < endOf(record); matchIndex++) {
        if (matchIndex > first && (matchIndex - first) % SPAN_YIELD_INTERVAL === 0) yield null;
        var result = ordered[matchIndex];
        var left = Math.max(result.start, startOf(record)), right = Math.min(result.end, endOf(record));
        if (left < right && !(yield* appendSpan(result, record, replayed, left, right))) return null;
      }
      replayed = null;
    }
    for (var resultIndex = 0; resultIndex < results.length; resultIndex++) {
      if (resultIndex && resultIndex % SPAN_YIELD_INTERVAL === 0) yield null;
      var match = results[resultIndex], next = 0;
      for (var spanIndex = 0; spanIndex < match.spans.length; spanIndex++) {
        if (spanIndex && spanIndex % SPAN_YIELD_INTERVAL === 0) yield null;
        var span = match.spans[spanIndex];
        if (span.start !== next) return null;
        next = span.end;
      }
      if (next !== match.end - match.start) return null;
    }
    yield null;
    return results;
  }

  function resolveMatches(records, intervals, options) {
    return runResolution(resolveMatchSteps(records, intervals), options);
  }

  // Compatibility collectors can still return exact expanded segments. Their
  // snapshots are referenced directly; binding never duplicates matched text.
  function* resolveLegacySteps(entry, intervals) {
    if (!entry || typeof entry.text !== "string" || !Array.isArray(intervals)) return null;
    var segments = entry.segments || [{ node: entry.node, start: 0, end: entry.text.length,
      nodeStart: 0, nodeEnd: entry.text.length, sourceText: entry.text }];
    var results = [];
    for (var hitIndex = 0; hitIndex < intervals.length; hitIndex++) {
      if (hitIndex % LEGACY_MATCH_YIELD_INTERVAL === 0) yield null;
      var match = intervals[hitIndex];
      if (!match || !integer(match.start) || !integer(match.end) || match.start < 0 ||
          match.end <= match.start || match.end > entry.text.length) return null;
      var lo = 0, hi = segments.length;
      while (lo < hi) {
        var middle = Math.floor((lo + hi) / 2);
        if (segments[middle].end <= match.start) lo = middle + 1;
        else hi = middle;
      }
      var spans = [], expected = 0;
      for (var index = lo; index < segments.length && segments[index].start < match.end; index++) {
        if (spans.length && spans.length % SPAN_YIELD_INTERVAL === 0) yield null;
        var segment = segments[index], left = Math.max(match.start, segment.start), right = Math.min(match.end, segment.end);
        var nodeStart = segment.nodeStart == null ? 0 : segment.nodeStart;
        var nodeEnd = segment.nodeEnd == null ? nodeStart + segment.end - segment.start : segment.nodeEnd;
        var linear = segment.end - segment.start === nodeEnd - nodeStart;
        if (!linear && (segment.end - segment.start !== 1 || left !== segment.start || right !== segment.end)) return null;
        var before = linear ? left - segment.start : 0, after = linear ? right - segment.start : nodeEnd - nodeStart;
        var snapshot = typeof segment.sourceText === "string" ? segment.sourceText : segment.node.nodeValue;
        var snapshotBase = typeof segment.sourceText === "string" ? 0 : nodeStart;
        if (left - match.start !== expected || snapshotBase + after > snapshot.length) return null;
        spans.push({ node: segment.node, nodeStart: nodeStart + before, nodeEnd: nodeStart + after,
          rawSnapshot: snapshot, snapshotStart: snapshotBase + before, snapshotEnd: snapshotBase + after,
          start: left - match.start, end: right - match.start,
          whiteSpace: segment.whiteSpace, textTransform: segment.textTransform,
          collapseMode: segment.whiteSpace === "pre" || segment.whiteSpace === "pre-wrap" ? "preserve" : "collapse",
          actualTransform: segment.textTransform === "uppercase" || segment.textTransform === "lowercase" ? segment.textTransform : "none" });
        expected = right - match.start;
      }
      if (!spans.length || expected !== match.end - match.start) return null;
      results.push(Object.assign({}, match, { spans: spans }));
    }
    yield null;
    return results;
  }
  function resolveLegacyMatches(entry, intervals, options) {
    return runResolution(resolveLegacySteps(entry, intervals), options);
  }

  // Used only when a caller explicitly reads the matched display text. Search,
  // validation and highlighting do not allocate this optional string.
  function readBoundText(spans) {
    if (!Array.isArray(spans)) return "";
    var parts = [];
    for (var index = 0; index < spans.length; index++) {
      var span = spans[index];
      if (!span || typeof span.rawSnapshot !== "string" || !integer(span.snapshotStart) || !integer(span.snapshotEnd) ||
          span.snapshotStart < 0 || span.snapshotEnd < span.snapshotStart || span.snapshotEnd > span.rawSnapshot.length) return "";
      var text = span.rawSnapshot.slice(span.snapshotStart, span.snapshotEnd);
      var mode = span.collapseMode || "collapse";
      if (mode === "collapse") text = text.replace(/[\t\n\r ]+/g, " ");
      else if (mode === "preserve-breaks") text = text.replace(/[\t\r ]+/g, " ").replace(/ *\n */g, "\n");
      else if (mode === "preserve-spaces") text = text.replace(/[\t\n\r]/g, " ");
      if (span.actualTransform === "uppercase") text = text.toUpperCase();
      else if (span.actualTransform === "lowercase") text = text.toLowerCase();
      parts.push(text);
    }
    return parts.join("");
  }

  globalThis.RRTextMapping = { sliceWindow: sliceWindow, resolveMatches: resolveMatches, resolveLegacyMatches: resolveLegacyMatches, readBoundText: readBoundText };
})();
