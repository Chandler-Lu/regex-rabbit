/**
 * Range-based result presentation. Page text nodes and form values are never
 * replaced. CSS Custom Highlight is preferred; older browsers use a bounded,
 * pointer-transparent rectangle layer. `marks` contains navigation descriptors,
 * not elements, and preserves the legacy navigation interface.
 *
 * Text entries: {id,node,text,segments:[{node,start,end,nodeStart?,nodeEnd?,sourceText?}]}.
 * Segment start/end address displayed entry.text; nodeStart/nodeEnd and the
 * sourceText snapshot address the original Text, including collapsed whitespace.
 * One logical match can contain multiple ranges across visible composed roots.
 * Control entries use kind 'control', 'label' or 'placeholder', with displayed
 * text and an optional raw displayTextSnapshot. Streamed controls additionally
 * provide controlOffset, textTransform and controlTransform for a bounded slice.
 * Navigation selects control
 * values and focuses labels/placeholders; rendering never changes selection.
 */
(function () {
  "use strict";
  var POLICY = globalThis.RRRuntimePolicy;
  // Yield frequencies, not result/DOM caps: every iterator resumes afterwards.
  var VALIDATION_YIELD_INTERVAL = 32;
  var DEFAULT_RENDER_BUDGET_MS = 8;
  var MAX_COLOR_CHARS = 96;
  var NAVIGATION_MARGIN_PX = 12;
  var TOOLBAR_CLEARANCE_PX = 8;
  var SCROLL_EPSILON_PX = 0.5;
  var FALLBACK_FRAME_DELAY_MS = 16;

  var sequence = 0;
  var activeSessions = new Set();
  var config = { highlightColor: "#ffe082", currentColor: "#ff6d00" };
  var OWN_ATTRIBUTE = "data-regex-rabbit-owned";
  var SOURCE_CHECK_CHARS = POLICY.text.sourceChunkChars;

  function validColor(value) {
    if (typeof value !== "string" || value.length > MAX_COLOR_CHARS) return false;
    return /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value) ||
      /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i.test(value);
  }

  function updateConfig(next) {
    if (!next || typeof next !== "object") return;
    if (validColor(next.highlightColor)) config.highlightColor = next.highlightColor;
    if (validColor(next.currentColor)) config.currentColor = next.currentColor;
    activeSessions.forEach(function (session) {
      session.documents.forEach(function (state) {
        state.styles.forEach(function (style) { style.textContent = highlightStyle(state); });
        if (!state.native) schedulePaint(state);
      });
    });
  }

  function createSession() {
    return { id: "rr-find-" + Date.now().toString(36) + "-" + (++sequence), documents: new Map(), current: null, disposed: false,
      validation: createValidation(), observers: new Map(), observerDocuments: new Map(), anchors: new Map(), snapshots: new Set(),
      mutationQueue: [], mutationSteps: null, mutationValidation: null, mutationTimer: null };
  }

  function createGroups(matches) {
    var groups = new Map();
    if (!Array.isArray(matches)) return groups;
    matches.forEach(function (match) {
      if (!match || !Number.isInteger(match.start) || !Number.isInteger(match.end) || match.start < 0 || match.end <= match.start) return;
      var list = groups.get(match.chunkId);
      if (!list) groups.set(match.chunkId, list = []);
      list.push(match);
    });
    return groups;
  }

  function renderMatches(entries, matches, options) {
    return renderSync(entries, createGroups(matches), createSession(), options || {});
  }

  function renderSync(entries, groups, session, options) {
    var marks = [];
    try {
      (Array.isArray(entries) ? entries : []).forEach(function (entry) {
        var matches = entry && groups.get(entry.id);
        if (matches) { for (var ignored of renderEntry(entry, matches, session, marks, options)) {} }
      });
      return finish(session, marks);
    } catch (error) {
      removeHighlights([session]);
      throw error;
    }
  }

  async function renderMatchesBatched(entries, matches, options) {
    options = options || {};
    var session = createSession();
    var groups = createGroups(matches);
    var marks = [];
    // The clock controls production work slices. An explicit batchSize remains
    // available to callers that need a smaller deterministic work quantum.
    var batchSize = positiveNumber(options.batchSize, 0);
    var budgetMs = positiveNumber(options.budgetMs, DEFAULT_RENDER_BUDGET_MS);
    var started = now();
    var processed = 0;
    entries = Array.isArray(entries) ? entries : [];
    try {
      for (var i = 0; i < entries.length; i++) {
        if (options.shouldContinue && !options.shouldContinue()) return cancel(session);
        var entry = entries[i];
        var entryMatches = entry && groups.get(entry.id);
        var steps = entryMatches ? renderEntry(entry, entryMatches, session, marks, options) : [null];
        for (var ignored of steps) {
          processed++;
          if (batchSize && processed % batchSize === 0 || now() - started >= budgetMs) {
            await yieldToMainThread();
            if (options.shouldContinue && !options.shouldContinue()) return cancel(session);
            refreshValidation(session.validation);
            started = now();
          }
        }
      }
      if (options.shouldContinue && !options.shouldContinue()) return cancel(session);
      return await finishBatched(session, marks, options, batchSize, budgetMs);
    } catch (error) {
      removeHighlights([session]);
      throw error;
    }
  }

  function cancel(session) {
    removeHighlights([session]);
    return { handles: [], marks: [], cancelled: true };
  }

  function* validateResults(session, marks, validation) {
    // Pages can change during a yielded render. Recheck actual text and geometry
    // before the coordinator displays a count, without a quadratic splice loop.
    validation = validation || createValidation();
    for (var i = 0; i < marks.length; i++) {
      var mark = marks[i];
      if (yield* validateDescriptorSteps(mark, validation)) yield mark;
      else {
        if (mark.state.normal) mark.ranges.forEach(function (range) { mark.state.normal.delete(range); });
        yield null;
      }
    }
  }

  function finish(session, marks) {
    var valid = [];
    for (var mark of validateResults(session, marks)) { if (mark) valid.push(mark); }
    return completeSession(session, valid);
  }

  async function finishBatched(session, marks, options, batchSize, budgetMs) {
    var valid = [];
    var validation = createValidation();
    var started = now();
    var processed = 0;
    for (var mark of validateResults(session, marks, validation)) {
      if (options.shouldContinue && !options.shouldContinue()) return cancel(session);
      if (mark) valid.push(mark);
      processed++;
      if (batchSize && processed % batchSize === 0 || now() - started >= budgetMs) {
        await yieldToMainThread();
        if (options.shouldContinue && !options.shouldContinue()) return cancel(session);
        refreshValidation(validation);
        started = now();
      }
    }
    return completeSession(session, valid);
  }

  function completeSession(session, marks) {
    var retained = new Set(marks);
    var snapshots = new Set();
    marks.forEach(function (mark) { if (mark.snapshot) snapshots.add(mark.snapshot); });
    session.snapshots.forEach(function (snapshot) {
      if (snapshots.has(snapshot)) return;
      snapshot.anchors.forEach(function (anchor) {
        var anchored = session.anchors.get(anchor);
        if (anchored) {
          anchored.delete(snapshot);
          if (!anchored.size) session.anchors.delete(anchor);
        }
      });
      session.snapshots.delete(snapshot);
    });
    session.documents.forEach(function (state) {
      state.marks = state.marks.filter(function (mark) { return retained.has(mark); });
    });
    session.validation = null;
    if (!marks.length) {
      removeHighlights([session]);
      return { handles: [], marks: [] };
    }
    activeSessions.add(session);
    if (session.mutationQueue.length) scheduleMutationDrain(session);
    session.documents.forEach(function (state) {
      if (state.native) commitNativeHighlight(state);
      if (!state.native) paint(state);
    });
    return { handles: [session], marks: marks };
  }

  function* prepareSegments(entry, validation) {
    var segments = entry.segments || [{ node: entry.node, start: 0, end: entry.text.length, nodeStart: 0 }];
    if (!Array.isArray(segments) || !segments.length) return null;
    var next = 0;
    var doc = null;
    var normalized = [];
    for (var i = 0; i < segments.length; i++) {
      if (i > 0 && i % VALIDATION_YIELD_INTERVAL === 0) yield null;
      var part = segments[i];
      if (!part || !part.node || part.node.nodeType !== 3 || !part.node.isConnected) return null;
      var nodeStart = part.nodeStart === undefined ? 0 : part.nodeStart;
      var nodeEnd = part.nodeEnd === undefined ? nodeStart + part.end - part.start : part.nodeEnd;
      var sourceText = typeof part.sourceText === "string" ? part.sourceText : entry.text.slice(part.start, part.end);
      var mappedLength = part.end - part.start;
      var sourceLength = nodeEnd - nodeStart;
      if (!Number.isInteger(part.start) || !Number.isInteger(part.end) || part.start !== next || part.end <= part.start ||
          !Number.isInteger(nodeStart) || !Number.isInteger(nodeEnd) || nodeStart < 0 || nodeEnd > part.node.length ||
          sourceLength !== sourceText.length || part.end > entry.text.length) return null;
      var collapsed = mappedLength !== sourceLength;
      if (collapsed && !(mappedLength === 1 && /^\s$/.test(entry.text.slice(part.start, part.end)))) return null;
      if (!(yield* sourceMatchesSteps(part.node, nodeStart, nodeEnd, sourceText, collapsed)) || !displayMappingCurrent(part, validation)) return null;
      if (doc && doc !== part.node.ownerDocument) return null;
      doc = part.node.ownerDocument;
      normalized.push({ node: part.node, start: part.start, end: part.end, nodeStart: nodeStart, nodeEnd: nodeEnd, index: i, sourceText: sourceText,
        document: doc, root: part.node.getRootNode(), whiteSpace: part.whiteSpace, textTransform: part.textTransform });
      next = part.end;
    }
    return next === entry.text.length ? normalized : null;
  }

  function* sourceMatchesSteps(node, start, end, expected, whitespaceOnly) {
    var raw = node.nodeValue;
    if (typeof raw !== "string" || end > raw.length || end - start !== expected.length || whitespaceOnly && !expected.length) return false;
    for (var offset = 0; offset < expected.length; offset += SOURCE_CHECK_CHARS) {
      if (offset > 0) yield null;
      var source = offset === 0 && expected.length <= SOURCE_CHECK_CHARS ? expected : expected.slice(offset, offset + SOURCE_CHECK_CHARS);
      if (raw.slice(start + offset, Math.min(end, start + offset + SOURCE_CHECK_CHARS)) !== source ||
          whitespaceOnly && !/^[\t\n\r ]+$/.test(source)) return false;
    }
    return node.nodeValue === raw;
  }

  function* boundSourceCurrentSteps(segment) {
    var raw = segment.node.nodeValue;
    if (typeof raw !== "string" || segment.nodeEnd > raw.length) return false;
    for (var offset = 0; offset < segment.nodeEnd - segment.nodeStart; offset += SOURCE_CHECK_CHARS) {
      if (offset) yield null;
      var length = Math.min(SOURCE_CHECK_CHARS, segment.nodeEnd - segment.nodeStart - offset);
      if (raw.slice(segment.nodeStart + offset, segment.nodeStart + offset + length) !==
          segment.rawSnapshot.slice(segment.snapshotStart + offset, segment.snapshotStart + offset + length)) return false;
    }
    return segment.node.nodeValue === raw;
  }

  function* segmentSourceCurrentSteps(segment) {
    if (typeof segment.rawSnapshot === "string") return yield* boundSourceCurrentSteps(segment);
    return yield* sourceMatchesSteps(segment.node, segment.nodeStart, segment.nodeEnd, segment.sourceText, false);
  }

  function* prepareBoundSpans(entry, validation) {
    if (!Array.isArray(entry.boundSpans) || !entry.boundSpans.length || !Number.isSafeInteger(entry.displayLength) || entry.displayLength <= 0) return null;
    var segments = [], doc = null, displayed = 0;
    for (var i = 0; i < entry.boundSpans.length; i++) {
      if (i && i % VALIDATION_YIELD_INTERVAL === 0) yield null;
      var part = entry.boundSpans[i];
      if (!part || !part.node || part.node.nodeType !== 3 || !part.node.isConnected || typeof part.rawSnapshot !== "string" ||
          !Number.isSafeInteger(part.nodeStart) || !Number.isSafeInteger(part.nodeEnd) || part.nodeStart < 0 || part.nodeEnd <= part.nodeStart || part.nodeEnd > part.node.length ||
          !Number.isSafeInteger(part.snapshotStart) || !Number.isSafeInteger(part.snapshotEnd) || part.snapshotStart < 0 || part.snapshotEnd > part.rawSnapshot.length ||
          part.snapshotEnd - part.snapshotStart !== part.nodeEnd - part.nodeStart ||
          !Number.isSafeInteger(part.start) || !Number.isSafeInteger(part.end) || part.start !== displayed || part.end <= part.start || part.end > entry.displayLength) return null;
      if (doc && doc !== part.node.ownerDocument) return null;
      doc = part.node.ownerDocument;
      var segment = Object.assign({}, part, { index: i, document: doc, root: part.node.getRootNode() });
      if (!(yield* boundSourceCurrentSteps(segment)) || !displayMappingCurrent(segment, validation)) return null;
      segments.push(segment);
      displayed = part.end;
    }
    return displayed === entry.displayLength ? segments : null;
  }

  function* renderBoundEntry(entry, matches, session, marks, options) {
    if (!entry.node || !entry.node.isConnected || !Number.isSafeInteger(entry.displayLength) || entry.displayLength <= 0) return;
    var control = /^(control|label|placeholder)$/.test(entry.kind || "");
    if (!control && entry.kind !== "bound-text") return;
    if (control && !boundControlCurrent(entry.node, entry.kind, entry.displayTextSnapshot, entry.controlOffset, entry.displayLength,
        entry.snapshotStart, entry.snapshotEnd, entry.textTransform, entry.controlTransform, session.validation)) return;
    var segments = control ? null : yield* prepareBoundSpans(entry, session.validation);
    if (!control && !segments) return;
    var doc = entry.node.ownerDocument;
    if (!doc || !doc.defaultView || !elementVisible(entry.node, session.validation)) return;
    if (options.collectionGuard) {
      var guardCurrent = options.collectionGuard.entryCurrentSteps ? yield* options.collectionGuard.entryCurrentSteps(entry) : options.collectionGuard.isEntryCurrent(entry);
      if (!guardCurrent) return;
    }
    var snapshot = control ? null : yield* observeEntry(session, segments);
    for (var m = 0; m < matches.length; m++) {
      yield null;
      var match = matches[m];
      if (match.start !== 0 || match.end !== entry.displayLength) continue;
      var pieces = [];
      if (segments) {
        for (var i = 0; i < segments.length; i++) {
          if (i && i % VALIDATION_YIELD_INTERVAL === 0) yield null;
          var part = segments[i], previous = pieces[pieces.length - 1];
          if (previous && previous.range.endContainer === part.node && previous.range.endOffset === part.nodeStart &&
              previous.segment.whiteSpace === part.whiteSpace && previous.segment.textTransform === part.textTransform) {
            try { previous.range.setEnd(part.node, part.nodeEnd); } catch (_) { return; }
            previous.boundSpans.push(part);
          } else {
            var range;
            try { range = doc.createRange(); range.setStart(part.node, part.nodeStart); range.setEnd(part.node, part.nodeEnd); }
            catch (_) { return; }
            pieces.push({ range: range, segment: part, boundSpans: [part] });
          }
        }
      }
      var descriptor = createDescriptor(session, entry, match, pieces, segments, doc, snapshot);
      if (!(yield* validateDescriptorSteps(descriptor, session.validation))) continue;
      var state = documentState(session, doc);
      descriptor.state = state;
      state.marks.push(descriptor);
      if (state.native) {
        for (var r = 0; r < descriptor.ranges.length; r++) {
          if (r && r % VALIDATION_YIELD_INTERVAL === 0) yield null;
          ensureStyle(state, descriptor.ranges[r].startContainer.getRootNode());
          state.normal.add(descriptor.ranges[r]);
        }
      }
      marks.push(descriptor);
    }
  }

  function* renderEntry(entry, matches, session, marks, options) {
    if (entry && (entry.kind === "bound-text" || typeof entry.text !== "string" && entry.displayLength !== undefined)) {
      yield* renderBoundEntry(entry, matches, session, marks, options);
      return;
    }
    if (!entry || typeof entry.text !== "string" || !entry.node || !entry.node.isConnected) return;
    var control = /^(control|label|placeholder)$/.test(entry.kind || "text");
    if (control) {
      if (entry.controlOffset !== undefined) {
        if (!controlFragmentCurrent(entry.node, entry.kind, entry.displayTextSnapshot, entry.text, entry.controlOffset,
            entry.textTransform, entry.controlTransform, session.validation)) return;
      } else if (readControlText(entry.node, entry.kind, session.validation) !== entry.text ||
          rawControlText(entry.node, entry.kind) !== (typeof entry.displayTextSnapshot === "string" ? entry.displayTextSnapshot : entry.text)) return;
    }
    var segments = control ? null : yield* prepareSegments(entry, session.validation);
    if (!control && !segments) return;
    var doc = entry.node.ownerDocument;
    if (!doc || !doc.defaultView || !elementVisible(entry.node, session.validation)) return;
    if (options.collectionGuard) {
      var guardCurrent = options.collectionGuard.entryCurrentSteps ? yield* options.collectionGuard.entryCurrentSteps(entry) : options.collectionGuard.isEntryCurrent(entry);
      if (!guardCurrent) return;
    }
    var snapshot = control ? null : yield* observeEntry(session, segments);
    var lastEnd = -1;
    var sorted = true;
    for (var order = 1; order < matches.length; order++) {
      if (matches[order].start < matches[order - 1].start ||
          matches[order].start === matches[order - 1].start && matches[order].end < matches[order - 1].end) { sorted = false; break; }
    }
    if (!sorted) matches.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    for (var i = 0; i < matches.length; i++) {
      // A single run can have thousands of matches; yielding per match keeps
      // cancellation and the time budget effective inside that run as well.
      yield null;
      var match = matches[i];
      if (match.end > entry.text.length || match.start < lastEnd) continue;
      var pieces = [];
      if (!control) {
        var start = locateSegment(segments, match.start);
        var end = locateSegment(segments, match.end - 1);
        if (!start || !end) continue;
        var valid = true;
        for (var partIndex = start.index; partIndex <= end.index; partIndex++) {
          if (partIndex > start.index && (partIndex - start.index) % VALIDATION_YIELD_INTERVAL === 0) yield null;
          var part = segments[partIndex];
          var startOffset = sourceOffset(part, Math.max(match.start, part.start));
          var endOffset = sourceOffset(part, Math.min(match.end, part.end));
          var sourceStart = startOffset - part.nodeStart;
          var sourceEnd = endOffset - part.nodeStart;
          var expected = part.sourceText.slice(sourceStart, sourceEnd);
          if (part.node.nodeValue.slice(startOffset, endOffset) !== expected) { valid = false; break; }
          var previous = pieces[pieces.length - 1];
          // Normalization often creates one segment per collapsed whitespace
          // run. Adjacent source spans in the same Text need only one Range.
          if (previous && previous.range.endContainer === part.node && previous.range.endOffset === startOffset &&
              previous.segment.whiteSpace === part.whiteSpace && previous.segment.textTransform === part.textTransform) {
            try { previous.range.setEnd(part.node, endOffset); } catch (_) { valid = false; break; }
            if (!previous.sources) previous.sources = [previous.source.slice(previous.start, previous.end)];
            previous.sources.push(expected);
          } else {
            var range;
            try {
              range = doc.createRange();
              range.setStart(part.node, startOffset);
              range.setEnd(part.node, endOffset);
            } catch (_) { valid = false; break; }
            pieces.push({ range: range, source: part.sourceText, start: sourceStart, end: sourceEnd, segment: part });
          }
        }
        if (!valid || !pieces.length) continue;
        for (var pieceIndex = 0; pieceIndex < pieces.length; pieceIndex++) {
          var piece = pieces[pieceIndex];
          if (piece.sources) {
            piece.source = piece.sources.join("");
            piece.start = 0;
            piece.end = piece.source.length;
            delete piece.sources;
          }
        }
      }
      var descriptor = createDescriptor(session, entry, match, pieces, segments, doc, snapshot);
      if (!(yield* validateDescriptorSteps(descriptor, session.validation))) continue;
      var state = documentState(session, doc);
      descriptor.state = state;
      state.marks.push(descriptor);
      if (state.native) {
        for (var rangeIndex = 0; rangeIndex < descriptor.ranges.length; rangeIndex++) {
          if (rangeIndex > 0 && rangeIndex % VALIDATION_YIELD_INTERVAL === 0) yield null;
          var registeredRange = descriptor.ranges[rangeIndex];
          ensureStyle(state, registeredRange.startContainer.getRootNode());
          state.normal.add(registeredRange);
        }
      }
      marks.push(descriptor);
      lastEnd = match.end;
    }
  }

  function sourceOffset(segment, offset) {
    if (segment.end - segment.start === segment.nodeEnd - segment.nodeStart) return segment.nodeStart + offset - segment.start;
    return offset === segment.start ? segment.nodeStart : segment.nodeEnd;
  }

  function locateSegment(segments, offset) {
    var lo = 0, hi = segments.length - 1;
    while (lo <= hi) {
      var middle = (lo + hi) >>> 1;
      var segment = segments[middle];
      if (offset < segment.start) hi = middle - 1;
      else if (offset >= segment.end) lo = middle + 1;
      else return segment;
    }
    return null;
  }

  function documentState(session, doc) {
    var state = session.documents.get(doc);
    if (state) return state;
    var win = doc.defaultView;
    state = { session: session, document: doc, window: win, marks: [], styles: new Map(),
      name: session.id, currentName: session.id + "-current", native: false, normal: null, current: null,
      registry: null, overlay: null, layer: null, frame: null, paintJob: null };
    try {
      if (win.CSS && win.CSS.highlights && typeof win.Highlight === "function") {
        state.registry = win.CSS.highlights;
        reserveNativeNames(state);
        state.normal = new win.Highlight();
        state.current = new win.Highlight();
        state.current.priority = 1;
        // Keep both objects detached while building and validating Ranges.
        // Updating a registered Highlight invalidates Chromium's whole marker
        // registry; interleaved geometry reads would rebuild growing results.
        state.native = true;
      }
    } catch (_) {
      state.registry = null;
      state.normal = null; state.current = null;
    }
    session.documents.set(doc, state);
    if (!state.native) enableFallbackGeometry(state);
    return state;
  }

  function reserveNativeNames(state) {
    // Rendering yields to the page, so a name free at construction may have
    // been taken before the final commit. Check both names again at that point.
    while (state.registry.has(state.name) || state.registry.has(state.currentName)) {
      state.name = state.session.id + "-" + (++sequence);
      state.currentName = state.name + "-current";
    }
  }

  function deleteOwnedRegistration(state, name, highlight) {
    try { if (state.registry.get(name) === highlight) state.registry.delete(name); }
    catch (_) {}
  }

  function commitNativeHighlight(state) {
    try {
      reserveNativeNames(state);
      // The global colors can change while this session is being built and is
      // not yet exposed through activeSessions. Refresh every owned root style.
      state.styles.forEach(function (style) { style.textContent = highlightStyle(state); });
      state.registry.set(state.name, state.normal);
      state.registry.set(state.currentName, state.current);
    } catch (_) {
      // If only the first set succeeded, remove that exact owned value and
      // retain a page value that replaced it. Then use the rectangle fallback.
      deleteOwnedRegistration(state, state.name, state.normal);
      deleteOwnedRegistration(state, state.currentName, state.current);
      if (state.normal) state.normal.clear();
      if (state.current) state.current.clear();
      state.normal = null; state.current = null; state.registry = null;
      state.native = false;
      enableFallbackGeometry(state);
    }
  }

  function enableFallbackGeometry(state) {
    if (state.onGeometryChange) return;
    var win = state.window;
    state.onGeometryChange = function () { schedulePaint(state); };
    win.addEventListener("scroll", state.onGeometryChange, true);
    win.addEventListener("resize", state.onGeometryChange);
    if (win.visualViewport) {
      win.visualViewport.addEventListener("scroll", state.onGeometryChange);
      win.visualViewport.addEventListener("resize", state.onGeometryChange);
    }
  }

  function highlightStyle(state) {
    return "::highlight(" + state.name + "){background-color:" + config.highlightColor + ";}" +
      "::highlight(" + state.currentName + "){background-color:" + config.currentColor + ";text-decoration:underline;}";
  }

  function ensureStyle(state, root) {
    if (state.styles.has(root)) return;
    var style = state.document.createElement("style");
    style.setAttribute(OWN_ATTRIBUTE, "true");
    style.textContent = highlightStyle(state);
    var target = root.nodeType === 9 ? root.head || root.documentElement : root;
    if (!target) return;
    target.appendChild(style);
    state.styles.set(root, style);
  }

  function rawControlText(node, kind) {
    if (!node || node.type === "password" && kind !== "placeholder") return null;
    if (kind === "label") {
      if (node.tagName !== "SELECT" || node.multiple || node.size > 1) return null;
      var option = node.options && node.options[node.selectedIndex];
      return option ? option.label : "";
    }
    if (kind === "placeholder") {
      if (node.tagName !== "TEXTAREA" && (node.tagName !== "INPUT" || !/^(text|search|email|url|tel|password|number)$/.test(node.type))) return null;
      if (node.type === "password") {
        // The pseudo-class checks whether the public placeholder is displayed
        // without reading the password value, including through a page getter.
        try {
          if (!node.matches(":placeholder-shown")) return null;
          var passwordPlaceholder = node.placeholder;
          return typeof passwordPlaceholder === "string" ? passwordPlaceholder : null;
        }
        catch (_) { return null; }
      }
      if (node.value !== "") return null;
      var placeholder = node.placeholder;
      return typeof placeholder === "string" ? placeholder : null;
    }
    if (node.tagName !== "TEXTAREA" && (node.tagName !== "INPUT" || !/^(text|search|email|url|tel|number|button|submit|reset)$/.test(node.type))) return null;
    var value = node.value;
    return typeof value === "string" ? value : null;
  }

  function controlDisplayTransform(node, kind, validation) {
    var win = node.ownerDocument.defaultView;
    if (!win) return null;
    var style = computedStyle(node, validation);
    var transform = style.textTransform || "none";
    if (kind === "placeholder" && win.CSS && typeof win.CSS.supports === "function" && win.CSS.supports("selector(::placeholder)")) {
      var pseudo = win.getComputedStyle(node, "::placeholder");
      if (pseudo.visibility === "hidden" || pseudo.visibility === "collapse" || pseudo.display === "none" ||
          pseudo.opacity !== "" && Number(pseudo.opacity) === 0 || parseFloat(pseudo.fontSize) === 0 ||
          globalThis.RRPageVisibility && globalThis.RRPageVisibility.transparentColor(pseudo.color)) return null;
      transform = pseudo.textTransform || transform;
    }
    return transform;
  }

  function readControlText(node, kind, validation) {
    var text = rawControlText(node, kind);
    if (text === null) return null;
    validation = validation || createValidation();
    var transform = controlDisplayTransform(node, kind, validation);
    if (transform === null) return null;
    if (transform !== "uppercase" && transform !== "lowercase") return text;
    var cached = validation.controls.get(node);
    if (cached && cached.kind === kind && cached.raw === text && cached.transform === transform) return cached.display;
    var display = /^[\x00-\x7f]*$/.test(text) ? (transform === "uppercase" ? text.toUpperCase() : text.toLowerCase()) : text;
    validation.controls.set(node, { kind: kind, raw: text, transform: transform, display: display });
    return display;
  }

  function controlFragmentCurrent(node, kind, snapshot, display, offset, textTransform, controlTransform, validation) {
    if (typeof snapshot !== "string" || typeof display !== "string" || !Number.isSafeInteger(offset) || offset < 0 ||
        offset > snapshot.length - display.length || typeof textTransform !== "string" || typeof controlTransform !== "string" ||
        !/^(none|uppercase|lowercase)$/.test(controlTransform || "")) return false;
    // Retain the original immutable string reference for stale-value detection;
    // only the matched slice is scanned or transformed on the page thread.
    var raw = rawControlText(node, kind);
    if (raw !== snapshot) return false;
    validation = validation || createValidation();
    var transform = controlDisplayTransform(node, kind, validation);
    if (transform === null || transform !== textTransform || controlTransform !== "none" && controlTransform !== transform) return false;
    var fragment = raw.slice(offset, offset + display.length);
    if (controlTransform !== "none") {
      if (!/^[\x00-\x7f]*$/.test(fragment)) return false;
      fragment = controlTransform === "uppercase" ? fragment.toUpperCase() : fragment.toLowerCase();
    }
    return fragment === display;
  }

  function boundControlCurrent(node, kind, snapshot, offset, length, snapshotStart, snapshotEnd, textTransform, controlTransform, validation) {
    if (typeof snapshot !== "string" || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0 ||
        offset > snapshot.length - length || typeof textTransform !== "string" || typeof controlTransform !== "string" ||
        !/^(none|uppercase|lowercase)$/.test(controlTransform)) return false;
    var start = snapshotStart === undefined ? offset : snapshotStart;
    var end = snapshotEnd === undefined ? offset + length : snapshotEnd;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start !== offset || end !== offset + length) return false;
    if (rawControlText(node, kind) !== snapshot) return false;
    var transform = controlDisplayTransform(node, kind, validation || createValidation());
    return transform !== null && transform === textTransform && (controlTransform === "none" || controlTransform === transform);
  }

  function createDescriptor(session, entry, match, pieces, segments, doc, snapshot) {
    var ranges = pieces.map(function (piece) { return piece.range; });
    var range = ranges[0] || null;
    var bound = entry.kind === "bound-text" || typeof entry.text !== "string";
    var mark = { session: session, state: null, document: doc, node: range ? range.startContainer : entry.node, range: range, ranges: ranges, pieces: pieces, kind: entry.kind || "text",
      start: match.start + (!range && entry.controlOffset !== undefined ? entry.controlOffset : 0),
      end: match.end + (!range && entry.controlOffset !== undefined ? entry.controlOffset : 0),
      valueSnapshot: !range ? (typeof entry.displayTextSnapshot === "string" ? entry.displayTextSnapshot : entry.text) : null,
      displaySnapshot: !range && !bound ? entry.text : null, segments: segments,
      boundDisplayLength: bound ? entry.displayLength : undefined,
      boundSpans: bound && range ? segments : null,
      snapshotStart: bound && !range ? entry.snapshotStart : undefined,
      snapshotEnd: bound && !range ? entry.snapshotEnd : undefined,
      controlOffset: !range ? entry.controlOffset : undefined,
      textTransform: !range ? entry.textTransform : undefined,
      controlTransform: !range ? entry.controlTransform : undefined,
      snapshot: snapshot,
      firstSegment: segments ? (bound ? 0 : locateSegment(segments, match.start).index) : 0,
      lastSegment: segments ? (bound ? segments.length - 1 : locateSegment(segments, match.end - 1).index) : 0 };
    if (bound) Object.defineProperty(mark, "textContent", { get: descriptorText });
    else mark.textContent = entry.text.slice(match.start, match.end);
    Object.defineProperty(mark, "isConnected", { get: descriptorIsConnected });
    mark.classList = { mark: mark, add: addCurrentClass, remove: removeCurrentClass, contains: containsCurrentClass };
    mark.getBoundingClientRect = descriptorRect;
    mark.scrollIntoView = scrollDescriptor;
    return mark;
  }

  // Share methods across results rather than retaining a closure for each
  // method of every match. Text remains lazy and uses the shared raw snapshot.
  function descriptorText() {
    if (this.boundSpans) return globalThis.RRTextMapping && typeof globalThis.RRTextMapping.readBoundText === "function" ?
      globalThis.RRTextMapping.readBoundText(this.boundSpans) : this.boundSpans.map(function (part) { return part.rawSnapshot.slice(part.snapshotStart, part.snapshotEnd); }).join("");
    var value = this.valueSnapshot.slice(this.start, this.end);
    return this.controlTransform === "uppercase" ? value.toUpperCase() : this.controlTransform === "lowercase" ? value.toLowerCase() : value;
  }
  function descriptorIsConnected() { return descriptorVisible(this); }
  function addCurrentClass(name) { if (name === "current") setCurrent(this.mark); }
  function removeCurrentClass(name) { if (name === "current" && this.mark.session.current === this.mark) setCurrent(null, this.mark.session); }
  function containsCurrentClass(name) { return name === "current" && this.mark.session.current === this.mark; }
  function scrollDescriptor(options) { return navigate(this, options); }
  function descriptorRect() {
    try {
      if (!this.range) return this.node.getBoundingClientRect();
      var first = this.range.getBoundingClientRect();
      var rect = { left: first.left, top: first.top, right: first.right, bottom: first.bottom };
      for (var i = 1; i < this.ranges.length; i++) {
        var next = this.ranges[i].getBoundingClientRect();
        rect.left = Math.min(rect.left, next.left); rect.top = Math.min(rect.top, next.top);
        rect.right = Math.max(rect.right, next.right); rect.bottom = Math.max(rect.bottom, next.bottom);
      }
      rect.width = rect.right - rect.left; rect.height = rect.bottom - rect.top;
      rect.x = rect.left; rect.y = rect.top;
      return rect;
    }
    catch (_) { return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  }

  function descriptorConnected(mark, validation) {
    if (!mark || mark.session.disposed || !mark.node.isConnected || mark.node.ownerDocument !== mark.document || !activeDocument(mark.document)) return false;
    if (!mark.range) {
      if (mark.boundDisplayLength !== undefined) return boundControlCurrent(mark.node, mark.kind, mark.valueSnapshot, mark.controlOffset,
        mark.boundDisplayLength, mark.snapshotStart, mark.snapshotEnd, mark.textTransform, mark.controlTransform, validation);
      if (mark.controlOffset !== undefined) return controlFragmentCurrent(mark.node, mark.kind, mark.valueSnapshot, mark.displaySnapshot,
        mark.controlOffset, mark.textTransform, mark.controlTransform, validation);
      return rawControlText(mark.node, mark.kind) === mark.valueSnapshot && readControlText(mark.node, mark.kind, validation) === mark.displaySnapshot;
    }
    if (!entrySnapshotCurrent(mark, validation)) return false;
    try {
      for (var i = 0; i < mark.pieces.length; i++) {
        var piece = mark.pieces[i];
        if (piece.boundSpans) {
          var boundValid;
          var boundSteps = boundPieceCurrentSteps(piece, validation || createValidation(), mark.snapshot && mark.snapshot.observed);
          do { boundValid = boundSteps.next(); } while (!boundValid.done);
          if (!boundValid.value) return false;
          continue;
        }
        if (!piece.range.startContainer.isConnected || !piece.range.endContainer.isConnected || !segmentLocationCurrent(piece.segment) ||
            piece.range.toString() !== piece.source.slice(piece.start, piece.end) ||
            !displayMappingCurrent(piece.segment, validation || createValidation())) return false;
      }
      return true;
    } catch (_) { return false; }
  }

  function activeDocument(doc) {
    var helper = globalThis.RRPageVisibility;
    if (helper && typeof helper.isDocumentAttached === "function") return helper.isDocumentAttached(doc);
    var seen = new Set();
    try {
      while (doc && !seen.has(doc)) {
        seen.add(doc);
        var view = doc.defaultView;
        if (!view || view.document !== doc) return false;
        var frame = view.frameElement;
        if (!frame) return true;
        if (!frame.isConnected) return false;
        doc = frame.ownerDocument;
      }
    } catch (_) { return false; }
    return false;
  }

  function createValidation() {
    var helper = globalThis.RRPageVisibility;
    return { visibility: helper && typeof helper.createContext === "function" ? helper.createContext() : null,
      styles: new WeakMap(), visibilityCache: new WeakMap(), mappings: new WeakMap(), clips: new WeakMap(), entries: new WeakMap(), frames: new WeakMap(), anchors: new WeakMap(), controls: new WeakMap() };
  }

  function refreshValidation(validation) {
    // A suspended generator can retain this object. Replace its caches in place
    // so resumed source/geometry checks use the page's current styles.
    var next = createValidation();
    Object.keys(next).forEach(function (key) { validation[key] = next[key]; });
  }

  function entryAnchor(node, validation) {
    if (validation.anchors.has(node)) return validation.anchors.get(node);
    var element = validationParent(node, validation);
    var seen = new Set();
    var visited = [node];
    var anchor = null;
    while (element && !seen.has(element)) {
      seen.add(element);
      if (validation.anchors.has(element)) { anchor = validation.anchors.get(element); break; }
      visited.push(element);
      if (element.nodeType === 1) {
        var state = validation.visibility && typeof validation.visibility.inspectElement === "function" ? validation.visibility.inspectElement(element) : null;
        var display = computedStyle(element, validation).display;
        if (state ? state.block : display && !/^(inline|contents|ruby|ruby-base|ruby-text)$/.test(display)) { anchor = element; break; }
      }
      var parent = validationParent(element, validation);
      if (!parent || parent.ownerDocument !== node.ownerDocument) { anchor = element; break; }
      element = parent;
    }
    anchor = anchor || node.parentNode || node;
    visited.forEach(function (item) { validation.anchors.set(item, anchor); });
    return anchor;
  }

  function* mutationOwnedSteps(record) {
    if (isOwnNode(record.target)) return true;
    if (record.type !== "childList" || !record.addedNodes.length && !record.removedNodes.length) return false;
    var processed = 0;
    for (var listIndex = 0; listIndex < 2; listIndex++) {
      var nodes = listIndex ? record.removedNodes : record.addedNodes;
      for (var i = 0; i < nodes.length; i++) {
        if (++processed % VALIDATION_YIELD_INTERVAL === 0) yield null;
        if (!isOwnNode(nodes[i])) return false;
      }
    }
    return true;
  }

  function* stylesheetMutationSteps(record) {
    var target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
    if (target && /^(STYLE|LINK)$/.test(target.tagName)) return true;
    if (record.type !== "childList") return false;
    var processed = 0, seen = new WeakSet();
    for (var listIndex = 0; listIndex < 2; listIndex++) {
      var roots = listIndex ? record.removedNodes : record.addedNodes;
      for (var i = 0; i < roots.length; i++) {
        var root = roots[i], node = root;
        if (isOwnNode(root)) continue;
        while (node && !seen.has(node)) {
          seen.add(node);
          if (++processed % VALIDATION_YIELD_INTERVAL === 0) yield null;
          if (node.nodeType === 1 && /^(STYLE|LINK)$/.test(node.tagName)) return true;
          if (node.firstChild) { node = node.firstChild; continue; }
          while (node !== root && !node.nextSibling) node = node.parentNode;
          node = node === root ? null : node.nextSibling;
        }
      }
    }
    return false;
  }

  function composedContains(parent, node, validation) {
    var seen = new WeakSet();
    while (node && !seen.has(node)) {
      if (node === parent || parent.contains && parent.contains(node)) return true;
      seen.add(node);
      node = validationParent(node, validation);
    }
    return false;
  }

  function invalidateAllSnapshots(session) {
    session.snapshots.forEach(function (snapshot) { snapshot.invalid = true; });
  }

  function invalidateMutations(session, records) {
    if (!records.length || session.disposed) return;
    // Record volume schedules work; it never decides whether a match exists.
    session.mutationQueue.push(records);
    // Published native highlights have no paint loop. Drain changes even when
    // the user never navigates again, so removed page subtrees are not retained
    // indefinitely in MutationRecords. During rendering its deadline owns this
    // work instead of an independent background task.
    if (activeSessions.has(session)) scheduleMutationDrain(session);
  }

  function scheduleMutationDrain(session) {
    if (session.disposed || session.mutationTimer !== null) return;
    session.mutationTimer = setTimeout(function () {
      session.mutationTimer = null;
      if (session.disposed) return;
      var started = now();
      for (var ignored of flushMutationSteps(session)) {
        if (now() - started >= POLICY.scheduling.pageSliceMs) { scheduleMutationDrain(session); break; }
      }
    }, 0);
  }

  function* flushMutationSteps(session) {
    // A synchronous navigation may arrive between scheduled slices. Resume the
    // same iterator so no partially processed batch can escape its validation.
    if (session.mutationValidation) refreshValidation(session.mutationValidation);
    while (!session.disposed && (session.mutationSteps || session.mutationQueue.length)) {
      if (!session.mutationSteps) session.mutationSteps = processMutationSteps(session);
      var step = session.mutationSteps.next();
      if (step.done) { session.mutationSteps = null; session.mutationValidation = null; }
      else yield null;
    }
  }

  function* processMutationSteps(session) {
    var processed = 0;
    while (session.mutationQueue.length) {
      var batches = session.mutationQueue;
      session.mutationQueue = [];
      var validation = session.mutationValidation = createValidation();
      for (var batch = 0; batch < batches.length; batch++) {
        var records = batches[batch];
        for (var i = 0; i < records.length; i++) {
          if (++processed % VALIDATION_YIELD_INTERVAL === 0) yield null;
          var record = records[i];
          if (yield* mutationOwnedSteps(record)) continue;
          // A real stylesheet mutation can change omitted gaps as well as the
          // matched spans. Its collected text context must be collected again.
          if (yield* stylesheetMutationSteps(record)) { invalidateAllSnapshots(session); continue; }
          var node = record.target, seen = new WeakSet();
          while (node && !seen.has(node)) {
            seen.add(node);
            if (++processed % VALIDATION_YIELD_INTERVAL === 0) yield null;
            var snapshots = session.anchors.get(node);
            if (snapshots) snapshots.forEach(function (snapshot) { snapshot.invalid = true; });
            node = validationParent(node, validation);
          }
          if (record.type === "attributes") {
            // Many matches share one text block. Check its ancestor relation
            // once, then invalidate the snapshots indexed under that block.
            for (var anchored of session.anchors) {
              if (++processed % VALIDATION_YIELD_INTERVAL === 0) yield null;
              if (composedContains(record.target, anchored[0], validation)) {
                anchored[1].forEach(function (snapshot) { snapshot.invalid = true; });
              }
            }
          }
        }
      }
    }
  }

  function observeRoot(session, root) {
    if (session.observers.has(root)) return session.observers.get(root) !== null;
    var doc = root.nodeType === 9 ? root : root.ownerDocument;
    var Observer = doc && doc.defaultView && doc.defaultView.MutationObserver;
    if (typeof Observer !== "function") { session.observers.set(root, null); return false; }
    try {
      var observer = session.observerDocuments.get(doc);
      if (!observer) {
        observer = new Observer(function (records) { invalidateMutations(session, records); });
        session.observerDocuments.set(doc, observer);
      }
      observer.observe(root, { subtree: true, characterData: true, childList: true, attributes: true });
      session.observers.set(root, observer);
      return true;
    } catch (_) { session.observers.set(root, null); return false; }
  }

  function composedRoots(root) {
    var roots = new Set();
    while (root && !roots.has(root)) {
      roots.add(root);
      if (root.host) root = root.host.getRootNode();
      else if (root.nodeType === 9) {
        var frame;
        try { frame = root.defaultView.frameElement; } catch (_) { return null; }
        root = frame ? frame.getRootNode() : null;
      } else return null;
    }
    return roots;
  }

  function* observeEntry(session, segments) {
    var snapshot = { invalid: false, observed: true, segments: segments, observers: new Set(), anchors: new Set() };
    session.snapshots.add(snapshot);
    var validation = session.validation;
    for (var i = 0; i < segments.length; i++) {
      if (i > 0 && i % VALIDATION_YIELD_INTERVAL === 0) yield null;
      var segment = segments[i];
      var roots = composedRoots(segment.root);
      if (!roots) { snapshot.invalid = true; continue; }
      for (var root of roots) {
        snapshot.observed = observeRoot(session, root) && snapshot.observed;
        var observer = session.observers.get(root);
        if (observer) snapshot.observers.add(observer);
      }
      var anchor = entryAnchor(segment.node, validation);
      snapshot.anchors.add(anchor);
      var snapshots = session.anchors.get(anchor);
      if (!snapshots) session.anchors.set(anchor, snapshots = new Set());
      snapshots.add(snapshot);
      if (!segment.node.isConnected || !segmentLocationCurrent(segment) ||
          !(yield* segmentSourceCurrentSteps(segment))) snapshot.invalid = true;
    }
    return snapshot;
  }

  function entrySnapshotCurrent(mark, validation) {
    var steps = entrySnapshotCurrentSteps(mark, validation), step;
    do { step = steps.next(); } while (!step.done);
    return step.value;
  }

  function* entrySnapshotCurrentSteps(mark, validation) {
    var snapshot = mark.snapshot;
    if (!snapshot) return true;
    // Drain pending records before navigation; MutationObserver callbacks may
    // otherwise run only after the page's current event handler returns.
    snapshot.observers.forEach(function (observer) {
      invalidateMutations(mark.session, observer.takeRecords());
    });
    yield* flushMutationSteps(mark.session);
    if (snapshot.invalid) return false;
    if (snapshot.observed) return true;
    validation = validation || createValidation();
    if (validation.entries.has(snapshot)) return validation.entries.get(snapshot);
    var valid = true;
    for (var i = 0; i < snapshot.segments.length; i++) {
      var segment = snapshot.segments[i];
      if (!segment.node.isConnected || !segmentLocationCurrent(segment) ||
          !(yield* segmentSourceCurrentSteps(segment))) { valid = false; break; }
    }
    validation.entries.set(snapshot, valid);
    return valid;
  }

  function createCollectionGuard() {
    var observers = new Map(), observerDocuments = new Map();
    var changes = new Map(), styleDocuments = new Set(), pending = [];
    var entries = new WeakMap(), validation = createValidation();
    var version = 0, disposed = false;
    function recordChanges(records) {
      if (!disposed && records.length) pending.push(records);
    }
    function* processChangesSteps() {
      var processed = 0;
      while (pending.length) {
        var batches = pending; pending = [];
        for (var batch = 0; batch < batches.length; batch++) {
          for (var i = 0; i < batches[batch].length; i++) {
            if (++processed % VALIDATION_YIELD_INTERVAL === 0) yield null;
            var record = batches[batch][i];
            if (yield* mutationOwnedSteps(record)) continue;
            version++;
            if (yield* stylesheetMutationSteps(record)) styleDocuments.add(record.target.ownerDocument || record.target);
            changes.set(record.target, changes.get(record.target) || record.type === "attributes");
          }
        }
        refreshValidation(validation);
      }
    }
    function addRoot(root) {
      if (disposed || !root) return;
      var roots = composedRoots(root);
      if (!roots) return;
      for (var relatedRoot of roots) {
        if (observers.has(relatedRoot)) continue;
        var doc = relatedRoot.nodeType === 9 ? relatedRoot : relatedRoot.ownerDocument;
        var Observer = doc && doc.defaultView && doc.defaultView.MutationObserver;
        try {
          if (typeof Observer !== "function") throw new Error("MutationObserver unavailable");
          var observer = observerDocuments.get(doc);
          if (!observer) { observer = new Observer(recordChanges); observerDocuments.set(doc, observer); }
          observer.observe(relatedRoot, { subtree: true, characterData: true, childList: true, attributes: true });
          observers.set(relatedRoot, observer);
        } catch (_) { observers.set(relatedRoot, null); }
      }
    }
    function entryParts(entry) {
      return Array.isArray(entry.boundSpans) ? entry.boundSpans : Array.isArray(entry.segments) ? entry.segments : [{ node: entry.node }];
    }
    function relatedObservers(entry) {
      var related = new Set(), parts = entryParts(entry);
      for (var i = 0; i < parts.length; i++) {
        var node = parts[i] && parts[i].node;
        if (!node || !node.isConnected) return null;
        var roots = composedRoots(node.getRootNode());
        if (!roots) return null;
        for (var root of roots) {
          var observer = observers.get(root);
          if (!observer) return null;
          related.add(observer);
        }
      }
      return related;
    }
    function* entryCurrentSteps(entry) {
      if (disposed || !entry || !entry.node) return false;
      var cached = entries.get(entry);
      var related = cached ? cached.observers : relatedObservers(entry);
      if (!related) return false;
      related.forEach(function (observer) { recordChanges(observer.takeRecords()); });
      yield* processChangesSteps();
      if (!entry.node.isConnected || !activeDocument(entry.node.ownerDocument) || styleDocuments.has(entry.node.ownerDocument)) return false;
      if (cached && cached.version === version) return cached.valid;
      if (cached) { related = relatedObservers(entry); if (!related) return false; }
      if (!changes.size) {
        entries.set(entry, { version: version, valid: true, observers: related });
        return true;
      }
      var anchors = new Set(), parts = entryParts(entry);
      for (var i = 0; i < parts.length; i++) {
        if (i && i % VALIDATION_YIELD_INTERVAL === 0) yield null;
        var node = parts[i] && parts[i].node;
        if (!node || !node.isConnected || !observers.get(node.getRootNode())) return false;
        anchors.add(entryAnchor(node, validation));
      }
      var valid = true, checks = 0;
      for (var change of changes) {
        for (var anchor of anchors) {
          if (++checks % VALIDATION_YIELD_INTERVAL === 0) yield null;
          if (composedContains(anchor, change[0], validation) || change[1] && composedContains(change[0], anchor, validation)) { valid = false; break; }
        }
        if (!valid) break;
      }
      entries.set(entry, { version: version, valid: valid, observers: related });
      return valid;
    }
    function isEntryCurrent(entry) {
      var steps = entryCurrentSteps(entry), step;
      do { step = steps.next(); } while (!step.done);
      return step.value;
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      observerDocuments.forEach(function (observer) { observer.disconnect(); });
      observers.clear(); observerDocuments.clear(); changes.clear(); styleDocuments.clear(); pending = [];
      entries = new WeakMap(); validation = null;
    }
    return { addRoot: addRoot, isEntryCurrent: isEntryCurrent, entryCurrentSteps: entryCurrentSteps, dispose: dispose };
  }

  function computedStyle(element, validation) {
    var style = validation.styles.get(element);
    if (!style) {
      style = validation.visibility && typeof validation.visibility.styleFor === "function" ?
        validation.visibility.styleFor(element) : element.ownerDocument.defaultView.getComputedStyle(element);
      if (!style) style = {};
      validation.styles.set(element, style);
    }
    return style;
  }

  function displayMappingCurrent(segment, validation) {
    if (!segment || segment.whiteSpace === undefined && segment.textTransform === undefined && segment.collapseMode === undefined) return true;
    validation = validation || createValidation();
    var state = validation.mappings.get(segment.node);
    if (!state) {
      if (validation.visibility && typeof validation.visibility.ancestorState === "function") {
        state = validation.visibility.ancestorState(segment.node);
      } else {
        state = { whiteSpace: "normal", textTransform: "none" };
        var element = segment.node.parentElement;
        var foundSpace = false, foundTransform = false, foundCollapse = false, seen = new WeakSet();
        while (element && !seen.has(element) && (!foundSpace || !foundTransform || !foundCollapse)) {
          seen.add(element);
          var style = computedStyle(element, validation);
          if (!foundSpace && style.whiteSpace) { state.whiteSpace = style.whiteSpace; foundSpace = true; }
          if (!foundTransform && style.textTransform) { state.textTransform = style.textTransform; foundTransform = true; }
          if (!foundCollapse && style.whiteSpaceCollapse) { state.whiteSpaceCollapse = style.whiteSpaceCollapse; foundCollapse = true; }
          element = composedParent(element);
        }
      }
      if (!state.whiteSpaceCollapse) {
        var space = state.whiteSpace || "normal";
        state.whiteSpaceCollapse = /(?:^|\s)preserve-breaks(?:\s|$)/.test(space) || space === "pre-line" ? "preserve-breaks" :
          /(?:^|\s)break-spaces(?:\s|$)/.test(space) ? "break-spaces" : /(?:^|\s)preserve-spaces(?:\s|$)/.test(space) ? "preserve-spaces" :
            space === "pre" || space === "pre-wrap" || /(?:^|\s)preserve(?:\s|$)/.test(space) ? "preserve" : "collapse";
      }
      validation.mappings.set(segment.node, state);
    }
    return (segment.whiteSpace === undefined || segment.whiteSpace === (state.whiteSpace || "normal")) &&
      (segment.textTransform === undefined || segment.textTransform === (state.textTransform || "none")) &&
      (segment.collapseMode === undefined || segment.collapseMode === state.whiteSpaceCollapse);
  }

  function segmentLocationCurrent(segment) {
    return segment.node.ownerDocument === segment.document && segment.node.getRootNode() === segment.root;
  }

  function validationParent(node, validation) {
    return validation.visibility && typeof validation.visibility.composedParent === "function" ?
      validation.visibility.composedParent(node) : composedParent(node);
  }

  function elementVisible(node, validation) {
    if (!node || !node.isConnected) return false;
    validation = validation || createValidation();
    if (validation.visibilityCache.has(node)) return validation.visibilityCache.get(node);
    var visible = inspectVisibility(node, validation);
    validation.visibilityCache.set(node, visible);
    return visible;
  }

  function inspectVisibility(node, validation) {
    if (validation.visibility) {
      try { return validation.visibility.isVisible(node); }
      catch (_) { return false; }
    }
    var element = node.nodeType === 1 ? node : node.parentElement;
    if (!element) return false;
    var ownStyle = computedStyle(element, validation);
    if (ownStyle.visibility === "hidden" || ownStyle.visibility === "collapse" || ownStyle.fontSize === "0px") return false;
    var seen = new Set();
    while (element && !seen.has(element)) {
      seen.add(element);
      var style = computedStyle(element, validation);
      if (style.display === "none" || style.contentVisibility === "hidden" || style.opacity === "0") return false;
      if (element.tagName === "IFRAME" && (style.visibility === "hidden" || style.visibility === "collapse")) return false;
      if (element.tagName === "DETAILS" && !element.open) {
        var summary = Array.from(element.children).find(function (child) { return child.tagName === "SUMMARY"; });
        if (!summary || !summary.contains(node)) return false;
      }
      element = composedParent(element);
    }
    return true;
  }

  function composedParent(node) {
    if (node.assignedSlot) return node.assignedSlot;
    if (node.parentElement) return node.parentElement;
    var root = node.getRootNode && node.getRootNode();
    if (root && root.host) return root.host;
    try { return node.ownerDocument.defaultView.frameElement; } catch (_) { return null; }
  }

  function* validateDescriptorSteps(mark, validation) {
    if (!mark || mark.session.disposed || !mark.node.isConnected || mark.node.ownerDocument !== mark.document || !activeDocument(mark.document)) return false;
    if (!mark.range) return descriptorVisible(mark, validation);
    if (!(yield* entrySnapshotCurrentSteps(mark, validation))) return false;
    for (var i = 0; i < mark.pieces.length; i++) {
      if (i > 0 && i % VALIDATION_YIELD_INTERVAL === 0) yield null;
      var piece = mark.pieces[i];
      try {
        if (piece.boundSpans) {
          if (!(yield* boundPieceCurrentSteps(piece, validation, mark.snapshot && mark.snapshot.observed)) || !elementVisible(piece.range.startContainer, validation)) return false;
          continue;
        }
        if (!piece.range.startContainer.isConnected || !piece.range.endContainer.isConnected || !segmentLocationCurrent(piece.segment) ||
            piece.range.toString() !== piece.source.slice(piece.start, piece.end) ||
            !displayMappingCurrent(piece.segment, validation) || !elementVisible(piece.range.startContainer, validation)) return false;
      } catch (_) { return false; }
    }
    return (yield* visibleRectsSteps(mark, validation, true)).length > 0;
  }

  function* boundPieceCurrentSteps(piece, validation, observed) {
    var parts = piece.boundSpans, first = parts[0], last = parts[parts.length - 1];
    if (piece.range.startContainer !== first.node || piece.range.startOffset !== first.nodeStart ||
        piece.range.endContainer !== last.node || piece.range.endOffset !== last.nodeEnd) return false;
    for (var i = 0; i < parts.length; i++) {
      if (i && i % VALIDATION_YIELD_INTERVAL === 0) yield null;
      var part = parts[i];
      if (!part.node.isConnected || !segmentLocationCurrent(part) || !displayMappingCurrent(part, validation) ||
          !observed && !(yield* boundSourceCurrentSteps(part))) return false;
    }
    return true;
  }

  function descriptorVisible(mark, validation) {
    validation = validation || createValidation();
    if (!descriptorConnected(mark, validation) || !elementVisible(mark.node, validation)) return false;
    if (mark.pieces) {
      for (var i = 1; i < mark.pieces.length; i++) {
        if (!elementVisible(mark.pieces[i].range.startContainer, validation)) return false;
      }
    }
    return visibleRects(mark, validation, true).length > 0;
  }

  function visibleRects(mark, validation, stopAfterFirst) {
    var steps = visibleRectsSteps(mark, validation, stopAfterFirst), step;
    do { step = steps.next(); } while (!step.done);
    return step.value;
  }

  function* visibleRectsSteps(mark, validation, stopAfterFirst) {
    var rects = [];
    for (var rect of visibleRectSteps(mark, validation)) {
      if (!rect) { yield null; continue; }
      rects.push(rect);
      if (stopAfterFirst) return rects;
    }
    return rects;
  }

  function* visibleRectSteps(mark, validation) {
    validation = validation || createValidation();
    if (!embeddingFramesVisible(mark.document, validation)) return;
    var ranges = mark.ranges.length ? mark.ranges : [null], checked = 0;
    for (var pieceIndex = 0; pieceIndex < ranges.length; pieceIndex++) {
      var range = ranges[pieceIndex], raw;
      try { raw = range ? range.getClientRects() : mark.node.getClientRects(); }
      catch (_) { continue; }
      var clips = clippingAncestors(range ? range.startContainer : mark.node, validation);
      for (var i = 0; i < raw.length; i++) {
        if (++checked % VALIDATION_YIELD_INTERVAL === 0) yield null;
        var rect = raw[i];
        if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) continue;
        var clipped = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
        for (var j = 0; j < clips.length; j++) {
          var clip = clips[j];
          if (clip.x) { clipped.left = Math.max(clipped.left, clip.rect.left); clipped.right = Math.min(clipped.right, clip.rect.right); }
          if (clip.y) { clipped.top = Math.max(clipped.top, clip.rect.top); clipped.bottom = Math.min(clipped.bottom, clip.rect.bottom); }
        }
        clipped.width = clipped.right - clipped.left; clipped.height = clipped.bottom - clipped.top;
        if (clipped.width > 0 && clipped.height > 0) {
          clipped.last = pieceIndex === ranges.length - 1 && i === raw.length - 1;
          yield clipped;
        }
      }
    }
  }

  function clippingAncestors(node, validation) {
    if (validation.clips.has(node)) return validation.clips.get(node);
    var clips = [];
    var element = node.nodeType === 1 ? node : validationParent(node, validation);
    var seen = new WeakSet();
    while (element && element.ownerDocument === node.ownerDocument && !seen.has(element)) {
      seen.add(element);
      if (element.nodeType !== 1) { element = validationParent(element, validation); continue; }
      var style = computedStyle(element, validation);
      // display:contents has no box and cannot clip its rendered descendants.
      var x = style.display !== "contents" && /^(hidden|clip)$/.test(style.overflowX || style.overflow);
      var y = style.display !== "contents" && /^(hidden|clip)$/.test(style.overflowY || style.overflow);
      if (x || y) clips.push({ x: x, y: y, rect: element.getBoundingClientRect() });
      var inset = style.display !== "contents" && insetClipRect(element, style);
      if (inset) clips.push({ x: true, y: true, rect: inset });
      // Rectangles in an iframe use its viewport coordinates; its parent frame
      // visibility is checked separately, never mix the two coordinate spaces.
      element = validationParent(element, validation);
    }
    validation.clips.set(node, clips);
    return clips;
  }

  function insetClipRect(element, style) {
    var value = style.clipPath || style.getPropertyValue && style.getPropertyValue("clip-path") || "";
    var match = /^inset\(\s*([^()]+)\s*\)$/.exec(value);
    if (!match) return null;
    var tokens = match[1].split(/\s+round\s+/)[0].trim().split(/\s+/);
    if (!tokens.length || tokens.length > 4 || !tokens.every(function (token) { return /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|%)?$/.test(token); })) return null;
    var top = tokens[0], right = tokens[1] || top, bottom = tokens[2] || top, left = tokens[3] || right;
    var box = element.getBoundingClientRect();
    function pixels(token, dimension, untransformed) {
      return /%$/.test(token) ? parseFloat(token) * dimension / 100 : parseFloat(token) * (untransformed > 0 ? dimension / untransformed : 1);
    }
    return { left: box.left + pixels(left, box.width, element.offsetWidth), right: box.right - pixels(right, box.width, element.offsetWidth),
      top: box.top + pixels(top, box.height, element.offsetHeight), bottom: box.bottom - pixels(bottom, box.height, element.offsetHeight) };
  }

  function embeddingFramesVisible(doc, validation) {
    if (validation.frames.has(doc)) return validation.frames.get(doc);
    var result = !!doc.defaultView && doc.defaultView.innerWidth !== 0 && doc.defaultView.innerHeight !== 0;
    var frame;
    try { frame = doc.defaultView.frameElement; } catch (_) { result = false; }
    if (result && frame) {
      // The child's own visibility check already crosses the frame boundary.
      // Its text does not inherit the frame element's color or font size.
      result = frame.isConnected && embeddingFramesVisible(frame.ownerDocument, validation);
      if (result) {
        result = false;
        var rects, clips;
        try { rects = frame.getClientRects(); clips = clippingAncestors(frame, validation); }
        catch (_) { validation.frames.set(doc, false); return false; }
        for (var i = 0; i < rects.length; i++) {
          var rect = rects[i];
          if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) continue;
          var left = rect.left, right = rect.right, top = rect.top, bottom = rect.bottom;
          for (var j = 0; j < clips.length; j++) {
            if (clips[j].x) { left = Math.max(left, clips[j].rect.left); right = Math.min(right, clips[j].rect.right); }
            if (clips[j].y) { top = Math.max(top, clips[j].rect.top); bottom = Math.min(bottom, clips[j].rect.bottom); }
          }
          if (right > left && bottom > top) { result = true; break; }
        }
      }
    }
    validation.frames.set(doc, result);
    return result;
  }

  function setCurrent(mark, session) {
    session = session || mark && mark.session;
    if (!session || session.disposed) return false;
    if (mark && !descriptorVisible(mark)) return false;
    var previous = session.current;
    if (previous === mark) return true;
    if (previous && previous.state.current) previous.ranges.forEach(function (range) { previous.state.current.delete(range); });
    session.current = mark || null;
    if (mark && mark.state.current) mark.ranges.forEach(function (range) { mark.state.current.add(range); });
    if (previous && !previous.state.native) schedulePaint(previous.state);
    if (mark && !mark.state.native) schedulePaint(mark.state);
    return true;
  }

  function navigationRect(mark, range, validation) {
    // Read geometry afresh after every ancestor scroll. A cached clip rectangle
    // would otherwise keep the target pinned to its old document position.
    validation = validation || createValidation();
    var raw;
    try { raw = range ? range.getClientRects() : mark.node.getClientRects(); }
    catch (_) { return null; }
    var clips = clippingAncestors(range ? range.startContainer : mark.node, validation);
    for (var i = 0; i < raw.length; i++) {
      if (!usableNavigationRect(raw[i])) continue;
      var rect = { left: raw[i].left, right: raw[i].right, top: raw[i].top, bottom: raw[i].bottom };
      for (var j = 0; j < clips.length; j++) {
        if (clips[j].x) { rect.left = Math.max(rect.left, clips[j].rect.left); rect.right = Math.min(rect.right, clips[j].rect.right); }
        if (clips[j].y) { rect.top = Math.max(rect.top, clips[j].rect.top); rect.bottom = Math.min(rect.bottom, clips[j].rect.bottom); }
      }
      if (usableNavigationRect(rect)) return rect;
    }
    return null;
  }

  function navigationPiece(mark) {
    var validation = createValidation();
    if (!mark.range) return navigationRect(mark, null, validation) ? { node: mark.node, range: null } : null;
    // Locate the first painted line, skipping permanently clipped pieces. Its
    // own ancestor chain may differ from the logical match's first text node.
    for (var i = 0; i < mark.ranges.length; i++) {
      if (navigationRect(mark, mark.ranges[i], validation)) return { node: mark.ranges[i].startContainer, range: mark.ranges[i] };
    }
    return null;
  }

  function usableNavigationRect(rect) {
    return rect && Number.isFinite(rect.left) && Number.isFinite(rect.top) && Number.isFinite(rect.right) &&
      Number.isFinite(rect.bottom) && rect.right > rect.left && rect.bottom > rect.top;
  }

  function navigationDelta(start, end, viewStart, viewEnd, alignment) {
    if (viewEnd <= viewStart) return 0;
    if (alignment === "center") return (start + end - viewStart - viewEnd) / 2;
    if (start >= viewStart && end <= viewEnd || start <= viewStart && end >= viewEnd) return 0;
    var margin = Math.min(NAVIGATION_MARGIN_PX, (viewEnd - viewStart) / 8);
    return start < viewStart ? start - viewStart - margin : end - viewEnd + margin;
  }

  function instantScroll(node, left, top) {
    if (!Number.isFinite(left) || !Number.isFinite(top) || Math.abs(left) < SCROLL_EPSILON_PX && Math.abs(top) < SCROLL_EPSILON_PX) return;
    // `auto` and direct scrollTop assignments inherit scroll-behavior:smooth.
    // Explicit instant calls neither change page CSS nor leave a later animation
    // that could pull the user back after they scroll.
    if (typeof node.scrollBy === "function") node.scrollBy({ left: left, top: top, behavior: "instant" });
  }

  function navigationBox(element) {
    var box = element.getBoundingClientRect();
    var scaleX = element.offsetWidth > 0 ? box.width / element.offsetWidth : 1;
    var scaleY = element.offsetHeight > 0 ? box.height / element.offsetHeight : 1;
    if (!Number.isFinite(scaleX) || scaleX <= 0) scaleX = 1;
    if (!Number.isFinite(scaleY) || scaleY <= 0) scaleY = 1;
    var left = box.left + (element.clientLeft || 0) * scaleX;
    var top = box.top + (element.clientTop || 0) * scaleY;
    return { left: left, top: top, right: left + element.clientWidth * scaleX,
      bottom: top + element.clientHeight * scaleY, scaleX: scaleX, scaleY: scaleY };
  }

  function viewportFixed(element, validation) {
    var doc = element.ownerDocument, ancestor = validationParent(element, validation);
    var seen = new WeakSet();
    for (; ancestor && ancestor.ownerDocument === doc && !seen.has(ancestor);) {
      seen.add(ancestor);
      if (ancestor.nodeType === 1) {
        var style = computedStyle(ancestor, validation);
        var transformed = [style.transform, style.translate, style.rotate, style.scale, style.perspective, style.filter, style.backdropFilter]
          .some(function (value) { return value && value !== "none"; });
        if (transformed || /(?:^|\s)(?:layout|paint|strict|content)(?:\s|$)/.test(style.contain || "") ||
            /(?:^|,\s*)(?:transform|translate|rotate|scale|perspective|filter|backdrop-filter)(?:\s*,|$)/.test(style.willChange || "") ||
            style.contentVisibility === "auto") return false;
      }
      ancestor = validationParent(ancestor, validation);
    }
    return true;
  }

  function scrollNavigationDocument(target, readRect, options, validation, topDocument) {
    var doc = target.ownerDocument, win = doc.defaultView, ancestor = target, fixed = false;
    var seen = new WeakSet();
    for (; ancestor && ancestor.ownerDocument === doc && !seen.has(ancestor);) {
      seen.add(ancestor);
      if (ancestor.nodeType === 1) {
        var style = computedStyle(ancestor, validation);
        if (style.position === "fixed" && viewportFixed(ancestor, validation)) fixed = true;
        // The viewport scroll is handled once below, not again through html/body.
        if (ancestor !== doc.scrollingElement) {
          var scrollX = /^(auto|scroll)$/.test(style.overflowX || style.overflow) && ancestor.scrollWidth > ancestor.clientWidth;
          var scrollY = /^(auto|scroll)$/.test(style.overflowY || style.overflow) && ancestor.scrollHeight > ancestor.clientHeight;
          if (scrollX || scrollY) {
            var box = navigationBox(ancestor), rect = readRect();
            if (rect) instantScroll(ancestor,
              scrollX ? navigationDelta(rect.left, rect.right, box.left, box.right, options.inline) / box.scaleX : 0,
              scrollY ? navigationDelta(rect.top, rect.bottom, box.top, box.bottom, options.block) / box.scaleY : 0);
          }
        }
        if (fixed) break;
      }
      ancestor = validationParent(ancestor, validation);
    }
    var result = readRect();
    if (!result || fixed) return;
    var viewport = win.visualViewport;
    var left = viewport ? viewport.offsetLeft : 0, top = viewport ? viewport.offsetTop : 0;
    var right = left + (viewport ? viewport.width : win.innerWidth), bottom = top + (viewport ? viewport.height : win.innerHeight);
    var deltaX = navigationDelta(result.left, result.right, left, right, options.inline);
    var deltaY = navigationDelta(result.top, result.bottom, top, bottom, options.block);
    var scrolling = doc.scrollingElement || doc.documentElement;
    var currentY = win.scrollY || scrolling.scrollTop || 0;
    var maxY = Math.max(0, scrolling.scrollHeight - (scrolling.clientHeight || win.innerHeight));
    // Occlusion must use the position the browser can actually reach at an
    // edge. Otherwise an unreachable center can hide a match under the panel.
    if (scrolling.clientHeight > 0) deltaY = Math.max(-currentY, Math.min(deltaY, maxY - currentY));
    if (scrolling.clientWidth > 0) {
      var currentX = win.scrollX || scrolling.scrollLeft || 0;
      var maxX = Math.max(0, scrolling.scrollWidth - scrolling.clientWidth);
      var rootStyle = computedStyle(scrolling, validation);
      var reverseX = rootStyle.direction === "rtl" || /^(vertical|sideways)-rl$/.test(rootStyle.writingMode);
      deltaX = Math.max((reverseX ? -maxX : 0) - currentX, Math.min(deltaX, (reverseX ? 0 : maxX) - currentX));
    }
    var avoid = topDocument && options.avoidRect;
    // Move away from the requested center only if the floating panel covers it.
    if (usableNavigationRect(avoid) && result.right - deltaX > avoid.left && result.left - deltaX < avoid.right &&
        result.bottom - deltaY > avoid.top && result.top - deltaY < avoid.bottom) {
      var projectedTop = result.top - deltaY, projectedBottom = result.bottom - deltaY;
      var above = projectedBottom - avoid.top + TOOLBAR_CLEARANCE_PX, below = projectedTop - avoid.bottom - TOOLBAR_CLEARANCE_PX;
      var candidates = [];
      if (projectedTop - above >= top && currentY + deltaY + above >= 0 && currentY + deltaY + above <= maxY) candidates.push(above);
      if (projectedBottom - below <= bottom && currentY + deltaY + below >= 0 && currentY + deltaY + below <= maxY) candidates.push(below);
      if (candidates.length) {
        candidates.sort(function (a, b) { return Math.abs(a) - Math.abs(b); });
        deltaY += candidates[0];
      }
    }
    instantScroll(win, deltaX, deltaY);
  }

  function frameNavigationReader(readChild, frame) {
    return function () {
      var child = readChild();
      if (!child) return null;
      var box = navigationBox(frame);
      return { left: box.left + child.left * box.scaleX, right: box.left + child.right * box.scaleX,
        top: box.top + child.top * box.scaleY, bottom: box.top + child.bottom * box.scaleY };
    };
  }

  function navigate(mark, options) {
    var validation = createValidation();
    if (!mark || !descriptorVisible(mark, validation)) return false;
    options = options && typeof options === "object" ? options : { block: "center", inline: "nearest" };
    var piece = navigationPiece(mark);
    if (!piece) return false;
    var target = piece.node;
    while (target && target.nodeType !== 1) target = validationParent(target, validation);
    if (!target) return false;
    var readRect = function () { return navigationRect(mark, piece.range); };
    if (!readRect()) return false;
    // Focus is reserved for explicit form-control navigation. Page text and
    // contenteditable selections keep their existing focus and selection.
    if (!mark.range) {
      try { target.focus({ preventScroll: true }); } catch (_) {}
      if (mark.kind === "control") {
        try { target.setSelectionRange(mark.start, mark.end); } catch (_) {}
      }
    }
    try {
      var seen = new WeakSet();
      for (; target && !seen.has(target);) {
        seen.add(target);
        var win = target.ownerDocument.defaultView;
        var frame = win.frameElement;
        scrollNavigationDocument(target, readRect, options, validation, !frame);
        if (!frame) break;
        readRect = frameNavigationReader(readRect, frame);
        target = frame;
      }
    } catch (_) { return false; }
    if (!mark.state.native) schedulePaint(mark.state);
    return true;
  }

  function ensureOverlay(state) {
    if (state.overlay && state.overlay.isConnected) return;
    var host = state.document.createElement("div");
    host.setAttribute(OWN_ATTRIBUTE, "true");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;pointer-events:none!important;z-index:2147483646!important;overflow:hidden!important;contain:strict!important;";
    var root = host.attachShadow ? host.attachShadow({ mode: "closed" }) : host;
    var layer = state.document.createElement("div");
    layer.style.cssText = "position:absolute;inset:0;pointer-events:none;";
    root.appendChild(layer);
    (state.document.body || state.document.documentElement).appendChild(host);
    state.overlay = host;
    state.layer = layer;
  }

  function requestPaintFrame(state) {
    if (state.session.disposed || state.frame !== null) return;
    var win = state.window;
    var run = function () { state.frame = null; if (!state.session.disposed) paint(state); };
    state.frame = win.requestAnimationFrame ? win.requestAnimationFrame(run) : win.setTimeout(run, FALLBACK_FRAME_DELAY_MS);
  }

  function schedulePaint(state) {
    // Geometry/current/color changes invalidate a partially assembled overlay.
    // Keep at most one scheduled frame and one bounded detached fragment.
    state.paintJob = null;
    requestPaintFrame(state);
  }

  function* paintMarkSteps(mark, validation) {
    if (!mark.range || !(yield* validateDescriptorSteps(mark, validation))) return;
    yield* visibleRectSteps(mark, validation);
  }

  function createCanvasLayer(state, width, height) {
    var win = state.window;
    if (typeof win.CanvasRenderingContext2D !== "function") return null;
    try {
      var canvas = state.document.createElement("canvas");
      var ratio = Number.isFinite(win.devicePixelRatio) && win.devicePixelRatio > 0 ? win.devicePixelRatio : 1;
      canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio));
      canvas.style.cssText = "all:initial!important;position:absolute!important;left:0!important;top:0!important;pointer-events:none!important;width:" + width + "px!important;height:" + height + "px!important;";
      var context = canvas.getContext("2d", { alpha: true, desynchronized: true });
      if (!context || typeof context.fillRect !== "function" || typeof context.clearRect !== "function" || typeof context.setTransform !== "function" || context.isContextLost && context.isContextLost()) {
        canvas.width = 0; canvas.height = 0; return null;
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0); context.globalAlpha = 0.5;
      return { canvas: canvas, context: context };
    } catch (_) { return null; }
  }

  function releaseCanvasLayers(state) {
    var layers = state.canvasLayers;
    if (!layers) return;
    layers.normal.canvas.width = 0; layers.normal.canvas.height = 0;
    layers.current.canvas.width = 0; layers.current.canvas.height = 0;
    state.canvasLayers = null;
  }

  function canvasLayers(state, width, height) {
    if (state.canvasFailed) return null;
    var layers = state.canvasLayers;
    var ratio = Number.isFinite(state.window.devicePixelRatio) && state.window.devicePixelRatio > 0 ? state.window.devicePixelRatio : 1;
    if (!layers) {
      var normal = createCanvasLayer(state, width, height);
      var current = normal && createCanvasLayer(state, width, height);
      if (!normal || !current) {
        if (normal) { normal.canvas.width = 0; normal.canvas.height = 0; }
        return null;
      }
      layers = state.canvasLayers = { normal: normal, current: current, width: width, height: height, ratio: ratio };
    }
    try {
      for (var layer of [layers.normal, layers.current]) {
        if (layers.width !== width || layers.height !== height || layers.ratio !== ratio) {
          layer.canvas.width = Math.max(1, Math.round(width * ratio)); layer.canvas.height = Math.max(1, Math.round(height * ratio));
          layer.canvas.style.setProperty("width", width + "px", "important"); layer.canvas.style.setProperty("height", height + "px", "important");
        }
        if (layer.context.isContextLost && layer.context.isContextLost()) throw new Error("Canvas context lost");
        layer.context.setTransform(ratio, 0, 0, ratio, 0, 0);
        layer.context.clearRect(0, 0, width, height); layer.context.globalAlpha = 0.5;
      }
      layers.width = width; layers.height = height; layers.ratio = ratio;
      return layers;
    } catch (_) { state.canvasFailed = true; releaseCanvasLayers(state); return null; }
  }

  function createPaintJob(state) {
    var width = state.window.innerWidth, height = state.window.innerHeight;
    var layers = canvasLayers(state, width, height);
    var normal = layers && layers.normal, current = layers && layers.current;
    var fragment = state.document.createDocumentFragment();
    var installed = !!state.layer && normal && current && normal.canvas.parentNode === state.layer && current.canvas.parentNode === state.layer;
    if (normal && current && !installed) { fragment.appendChild(normal.canvas); fragment.appendChild(current.canvas); }
    return {
      fragment: fragment, validation: createValidation(), rectSteps: null, rectMark: null,
      normal: normal && current ? normal : null, currentLayer: normal && current ? current : null,
      installed: !!installed, drawn: false, index: 0, width: width, height: height,
      current: state.session.current && state.session.current.state === state ? state.session.current : null,
      currentMark: state.session.current && state.session.current.state === state ? state.session.current : null
    };
  }

  function installPaintJob(state, job) {
    if (!job.installed) {
      ensureOverlay(state); state.layer.replaceChildren(job.fragment); job.installed = true;
    } else if (!job.normal && job.fragment.childNodes.length) state.layer.appendChild(job.fragment);
  }

  function drawPaintRect(state, job, rect) {
    var current = state.session.current === job.rectMark;
    var color = current ? config.currentColor : config.highlightColor;
    if (job.normal) {
      var context = (current ? job.currentLayer : job.normal).context;
      if (context.isContextLost && context.isContextLost()) throw new Error("Canvas context lost");
      context.fillStyle = color;
      context.fillRect(rect.left, rect.top, rect.width, rect.height);
    } else {
      var box = state.document.createElement("div");
      box.style.cssText = "position:absolute;pointer-events:none;opacity:.5;background:" + color +
        ";left:" + rect.left + "px;top:" + rect.top + "px;width:" + rect.width + "px;height:" + rect.height + "px;";
      job.fragment.appendChild(box);
    }
    job.drawn = true;
  }

  function paint(state) {
    if (state.session.disposed) return;
    var job = state.paintJob || createPaintJob(state);
    if (state.paintJob) refreshValidation(job.validation);
    var started = now();
    // Canvas storage follows viewport pixels rather than rectangle count. When
    // Canvas is unavailable, the same cursor incrementally appends DOM boxes.
    while (job.rectSteps || job.current || job.index < state.marks.length) {
      if (!job.rectSteps) {
        var mark;
        if (job.current) { mark = job.current; job.current = null; }
        else { mark = state.marks[job.index++]; if (mark === job.currentMark) continue; }
        job.rectMark = mark; job.rectSteps = paintMarkSteps(mark, job.validation);
      }
      var step = job.rectSteps.next();
      if (step.done) { job.rectSteps = null; job.rectMark = null; }
      else if (step.value) {
        var rect = step.value;
        if (rect.bottom > 0 && rect.top < job.height && rect.right > 0 && rect.left < job.width) {
          try { drawPaintRect(state, job, rect); }
          catch (_) {
            // A real allocation/context failure switches to the complete DOM
            // cursor without changing which matches were validated or counted.
            state.canvasFailed = true; releaseCanvasLayers(state); state.paintJob = null; requestPaintFrame(state); return;
          }
        }
        if (rect.last) { job.rectSteps = null; job.rectMark = null; }
      }
      if (now() - started >= POLICY.scheduling.pageSliceMs) break;
    }
    if (job.drawn || state.overlay) installPaintJob(state, job);
    if (job.rectSteps || job.current || job.index < state.marks.length) {
      state.paintJob = job; requestPaintFrame(state); return;
    }
    state.paintJob = null;
  }

  function removeHighlights(handles) {
    if (!Array.isArray(handles)) return;
    handles.forEach(function (session) {
      if (!session || session.disposed || !(session.documents instanceof Map)) return;
      session.disposed = true;
      session.current = null;
      session.validation = null;
      session.observerDocuments.forEach(function (observer) { observer.disconnect(); });
      session.observers.clear();
      session.observerDocuments.clear();
      session.mutationQueue = [];
      session.mutationSteps = null;
      session.mutationValidation = null;
      if (session.mutationTimer !== null) clearTimeout(session.mutationTimer);
      session.mutationTimer = null;
      session.anchors.clear();
      session.snapshots.clear();
      session.documents.forEach(function (state) {
        releaseCanvasLayers(state);
        if (state.registry) {
          // A page may replace a named entry after rendering. Preserve it.
          if (state.registry.get(state.name) === state.normal) state.registry.delete(state.name);
          if (state.registry.get(state.currentName) === state.current) state.registry.delete(state.currentName);
        }
        if (state.normal) state.normal.clear();
        if (state.current) state.current.clear();
        state.styles.forEach(function (style) { style.remove(); });
        state.styles.clear();
        if (state.frame !== null) {
          if (state.window.cancelAnimationFrame) state.window.cancelAnimationFrame(state.frame);
          else state.window.clearTimeout(state.frame);
        }
        if (state.onGeometryChange) {
          state.window.removeEventListener("scroll", state.onGeometryChange, true);
          state.window.removeEventListener("resize", state.onGeometryChange);
          if (state.window.visualViewport) {
            state.window.visualViewport.removeEventListener("scroll", state.onGeometryChange);
            state.window.visualViewport.removeEventListener("resize", state.onGeometryChange);
          }
        }
        if (state.overlay) state.overlay.remove();
        state.paintJob = null;
        state.marks.length = 0;
      });
      session.documents.clear();
      activeSessions.delete(session);
    });
  }

  function isOwnNode(node) {
    if (!node) return false;
    var element = node.nodeType === 1 ? node : node.parentElement;
    var seen = new WeakSet();
    while (element && !seen.has(element)) {
      seen.add(element);
      if (element.getAttribute && element.getAttribute(OWN_ATTRIBUTE) === "true") return true;
      element = element.parentElement || element.getRootNode && element.getRootNode().host || null;
    }
    return false;
  }

  function positiveNumber(value, fallback) {
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  function yieldToMainThread() {
    if (globalThis.RRTaskScheduler) return globalThis.RRTaskScheduler.yield();
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  function now() { return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now(); }

  globalThis.RRHighlightEngine = {
    createCollectionGuard: createCollectionGuard,
    renderMatches: renderMatches,
    renderMatchesBatched: renderMatchesBatched,
    removeHighlights: removeHighlights,
    setCurrent: setCurrent,
    navigate: navigate,
    updateConfig: updateConfig,
    configure: updateConfig,
    isOwnNode: isOwnNode,
    isVisible: descriptorVisible,
    isValid: descriptorVisible
  };
})();
