/**
 * Observe searchable DOM boundaries without changing page prototypes.
 * Discovery runs in bounded slices; mutation handling never walks a subtree.
 */
(function () {
  "use strict";

  // These values bound one polling turn. Cursors retain all unfinished work.
  var POLL_SLICE_MS = 2;
  var ROOT_PRUNE_BATCH_SIZE = 128;
  var ROOT_DISCOVERY_BATCH_SIZE = 32;
  var SHEET_ROOT_BATCH_SIZE = 16;
  var SHEET_ROOT_SLICE_MS = 4;
  var SHEET_ENTRY_BATCH_SIZE = 64;
  var CSS_JOB_START_BATCH_SIZE = 32;
  var CSS_RULE_BATCH_SIZE = 128;
  var CSS_TEXT_SLICE_CHARS = 32768;
  var MAX_EAGER_SELECTOR_CHARS = 65536;
  var CONTROL_HASH_SLICE_CHARS = 131072;
  var CONTROL_HASH_CHUNK_CHARS = 32768;
  var CONTROL_HASH_JOBS_PER_TURN = 4;
  var CONTROL_HASH_CHECK_INTERVAL = 2048;
  var CONTROL_HASH_CONTINUE_MS = 100;
  var DISCOVERY_CONTINUE_MS = 250;
  var MUTATION_RECORDS_PER_TURN = 4096;
  var MUTATION_DISCOVERY_BATCH_SIZE = 64;
  var WRAPPER_TEXT_BUDGET_CHARS = 131072;
  var WRAPPER_NODE_BATCH_SIZE = 256;
  // Dual 32-bit rolling fingerprints detect eventless control/CSS changes.
  var FNV_OFFSET_BASIS = 2166136261, FNV_PRIME = 16777619;
  var SECOND_HASH_SEED = 2246822519, SECOND_HASH_PRIME = 3266489917;
  var OBSERVER_DEFAULTS = Object.freeze({
    debounceMs: 1500, maxDebounceMs: 60000, maxWaitMs: 5000, maxWaitMultiplier: 3,
    maxWaitCeilingMs: 120000, discoveryIntervalMs: 2000, minDiscoveryIntervalMs: 20,
    maxDiscoveryIntervalMs: 60000, discoveryBatchSize: 800, maxDiscoveryBatchSize: 10000,
    discoveryBudgetMs: 4, maxDiscoveryBudgetMs: 16
  });

  var multiply = Math.imul;

  var EVENTS = ["input", "change", "slotchange", "toggle", "load", "loadedmetadata", "focusin", "focusout",
    "fullscreenchange",
    "pointerover", "pointerout", "pointerdown", "pointerup", "pointercancel",
    "transitionrun", "transitionend", "transitioncancel", "animationstart", "animationiteration", "animationend", "animationcancel"];
  var VIEW_EVENTS = ["resize", "hashchange", "popstate"];

  function create(options) {
    options = options || {};
    var doc = options.document || globalThis.document;
    var entries = new Map();
    var observers = new Map();
    var pendingWalks = new Map();
    var mutationHead = null, mutationTail = null, mutationTimer = null;
    var ownCache = new WeakMap();
    var ownedSheets = new WeakSet();
    var controlValues = new WeakMap();
    var definitionStates = new WeakMap();
    var controlHashControls = new Set(), controlHashTracked = new WeakSet(), controlHashCursor = null, controlHashJob = null;
    var mediaViews = new Map();
    var hoverSources = 0, activeSources = 0;
    var rootCursors = { walk: null, sheets: null, prune: null, css: null };
    var cssJob = null;
    var stylesheetScans = 0;
    var sheetHashes = new WeakMap();
    var sheetStates = new WeakMap();
    var running = false, disposed = false, pauseDepth = 0, generation = 0;
    var dirty = false, rootsChanged = false, reasons = new Set();
    var debounceTimer = null, maxWaitTimer = null, discoveryTimer = null;
    var containerWasConnected = false;
    var debounceMs = number(options.debounceMs, OBSERVER_DEFAULTS.debounceMs, 0, OBSERVER_DEFAULTS.maxDebounceMs);
    var maxWaitMs = number(options.maxWaitMs, Math.max(debounceMs * OBSERVER_DEFAULTS.maxWaitMultiplier, OBSERVER_DEFAULTS.maxWaitMs), 1, OBSERVER_DEFAULTS.maxWaitCeilingMs);
    var discoveryIntervalMs = number(options.discoveryIntervalMs, OBSERVER_DEFAULTS.discoveryIntervalMs, OBSERVER_DEFAULTS.minDiscoveryIntervalMs, OBSERVER_DEFAULTS.maxDiscoveryIntervalMs);
    var discoveryBatchSize = number(options.discoveryBatchSize, OBSERVER_DEFAULTS.discoveryBatchSize, 1, OBSERVER_DEFAULTS.maxDiscoveryBatchSize);
    var discoveryBudgetMs = number(options.discoveryBudgetMs, OBSERVER_DEFAULTS.discoveryBudgetMs, 1, OBSERVER_DEFAULTS.maxDiscoveryBudgetMs);

    function own(node) {
      if (!node) return false;
      if (ownCache.has(node)) return ownCache.get(node);
      if (typeof options.isOwnNode === "function") {
        try { if (options.isOwnNode(node)) { ownCache.set(node, true); return true; } } catch (ignored) {}
      }
      var cursor = node, path = [], result = false;
      while (cursor) {
        if (ownCache.has(cursor)) { result = ownCache.get(cursor); break; }
        path.push(cursor);
        if (cursor.nodeType === 1) {
          if (cursor.id === "regex-search-container" || cursor.id === "rr-host" ||
              cursor.id === "rr-dynamic-colors" || cursor.id === "rr-highlight-style" ||
              cursor.hasAttribute("data-regex-rabbit-owned") ||
              cursor.getAttribute("data-regex-rabbit-highlight") === "true" ||
              cursor.getAttribute("data-regexrabbithighlight") === "true" ||
              (cursor.tagName === "MARK" && cursor.classList.contains("regex-search-highlight"))) {
            if (cursor.tagName === "STYLE" && cursor.sheet) ownedSheets.add(cursor.sheet);
            result = true; break;
          }
        }
        cursor = cursor.parentNode || cursor.host;
      }
      for (var i = 0; i < path.length; i++) ownCache.set(path[i], result);
      return result;
    }

    function safeCallback(fn, argument) {
      if (typeof fn !== "function") return;
      try { fn(argument); } catch (ignored) {}
    }

    function clearSearchTimers() {
      clearTimeout(debounceTimer); clearTimeout(maxWaitTimer);
      debounceTimer = null; maxWaitTimer = null;
    }

    function markDirty(reason, boundaryChanged) {
      if (!running) return;
      dirty = true;
      reasons.add(reason);
      if (boundaryChanged) rootsChanged = true;
      if (pauseDepth > 0) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flush, debounceMs);
      if (maxWaitTimer === null) maxWaitTimer = setTimeout(flush, maxWaitMs);
    }

    function flush() {
      if (!running) return false;
      observers.forEach(function (state) {
        if (state.observer) processMutations(state.observer.takeRecords());
      });
      if (!running || pauseDepth > 0 || !dirty) return false;
      clearSearchTimers();
      var change = { reasons: Array.from(reasons), rootsChanged: rootsChanged, roots: Array.from(entries.keys()) };
      dirty = false; rootsChanged = false; reasons.clear();
      safeCallback(options.onChange, change);
      return true;
    }

    function checkContainer() {
      if (typeof options.getContainer !== "function") return true;
      var container;
      try { container = options.getContainer(); } catch (ignored) { return true; }
      if (container && container.isConnected) { containerWasConnected = true; return true; }
      if (!containerWasConnected) return true;
      stop();
      safeCallback(options.onContainerRemoved, container);
      return false;
    }

    function frameDocument(frame) {
      try {
        var childDoc = frame.contentDocument;
        if (!childDoc || !childDoc.documentElement || !childDoc.defaultView) return null;
        // Touching location rejects cross-origin WindowProxy implementations.
        void childDoc.defaultView.location.href;
        return childDoc;
      } catch (ignored) { return null; }
    }

    function connected(root, seen) {
      if (!root) return false;
      if (root === doc) return true;
      if (root.nodeType === 9) {
        try {
          var frame = root.defaultView && root.defaultView.frameElement;
          if (frame) return connected(frame, seen) && frameDocument(frame) === root;
          return false;
        } catch (ignored) { return false; }
      }
      if (root.host) return connected(root.host, seen);
      if (!root.isConnected) return false;
      var owner = root.ownerDocument;
      if (!owner || owner === doc) return true;
      seen = seen || new Set();
      if (seen.has(owner)) return false;
      seen.add(owner);
      return connected(owner, seen);
    }

    function dropRoot(root) {
      var entry = entries.get(root);
      if (!entry) return;
      var state = observers.get(entry.owner);
      if (state) { state.roots.delete(root); state.needsReconnect = true; }
      EVENTS.forEach(function (eventName) {
        try { root.removeEventListener(eventName, handleEvent, true); } catch (ignored) {}
      });
      // A same-origin frame may have navigated to another origin since its
      // WindowProxy was registered. Cleanup must still release our references.
      VIEW_EVENTS.forEach(function (eventName) {
        try { if (entry.view) entry.view.removeEventListener(eventName, handleViewEvent); } catch (ignored) {}
      });
      try { if (entry.fonts) entry.fonts.removeEventListener("loadingdone", handleFonts); } catch (ignored) {}
      if (entry.sheetMedia) {
        Array.from(entry.sheetMedia.keys()).forEach(function (sheet) { replaceMediaQueries(root, sheet, new Set()); });
      }
      if (entry.sheetPseudos) {
        Array.from(entry.sheetPseudos.keys()).forEach(function (sheet) { replacePseudoState(root, sheet, null); });
      }
      entries.delete(root);
      pendingWalks.delete(root);
      if (entry.sheetScan) stylesheetScans -= 1;
      if (cssJob && cssJob.root === root) cssJob = null;
    }

    function reconnectObservers() {
      observers.forEach(function (state, owner) {
        if (!state.needsReconnect) return;
        state.needsReconnect = false;
        try { state.observer.disconnect(); } catch (ignored) {}
        if (!state.roots.size) { observers.delete(owner); return; }
        state.roots.forEach(function (root) { observeRoot(state, root); });
      });
    }

    function observeRoot(state, root) {
      if (!state || !state.observer) return;
      try {
        state.observer.observe(root, { subtree: true, childList: true, characterData: true,
          // Every attribute can participate in a CSS visibility selector.
          attributes: true });
      } catch (ignored) {}
    }

    function pruneRoots() {
      var removed = false, started = Date.now();
      for (var checked = 0; checked < ROOT_PRUNE_BATCH_SIZE && Date.now() - started < POLL_SLICE_MS; checked++) {
        var root = nextRoot("prune");
        if (!root) break;
        if (!connected(root)) { dropRoot(root); removed = true; }
      }
      reconnectObservers();
      if (removed) {
        markDirty("roots", true);
      }
    }

    function nextRoot(cursor) {
      if (!rootCursors[cursor]) rootCursors[cursor] = entries.keys();
      var next = rootCursors[cursor].next();
      if (next.done) { rootCursors[cursor] = null; return null; }
      return next.value;
    }

    function addRoot(root, notify) {
      if (!root || entries.has(root) || own(root) ||
          (root.nodeType !== 9 && root.nodeType !== 11 && root.nodeType !== 1) || !connected(root)) return false;
      var owner = root.nodeType === 9 ? root : root.ownerDocument;
      var view = owner && owner.defaultView;
      var Observer;
      try { Observer = (view && view.MutationObserver) || globalThis.MutationObserver; } catch (ignored) {}
      var entry = { owner: owner, view: root.nodeType === 9 ? view : null, sheets: null, sheetScan: null, cssCursor: 0,
        sheetMedia: new Map(), sheetPseudos: new Map(), fonts: null };
      var state = observers.get(owner);
      if (!state && typeof Observer === "function") {
        try {
          state = { observer: new Observer(processMutations), roots: new Set(), needsReconnect: false };
          observers.set(owner, state);
        } catch (ignored) {}
      }
      if (state) { state.roots.add(root); observeRoot(state, root); }
      EVENTS.forEach(function (eventName) {
        try { root.addEventListener(eventName, handleEvent, true); } catch (ignored) {}
      });
      VIEW_EVENTS.forEach(function (eventName) {
        try { if (entry.view) entry.view.addEventListener(eventName, handleViewEvent); } catch (ignored) {}
      });
      try {
        if (entry.view && root.fonts && typeof root.fonts.addEventListener === "function") {
          entry.fonts = root.fonts;
          entry.fonts.addEventListener("loadingdone", handleFonts);
        }
      } catch (ignored) {}
      entries.set(root, entry);
      queueWalk(root);
      if (notify) markDirty("roots", true);
      return true;
    }

    function handleViewEvent(event) { markDirty(event && event.type || "resize"); }
    function handleFonts() { markDirty("font-load"); }

    function handleEvent(event) {
      ownCache = new WeakMap();
      if (!running || own(event.target)) return;
      if ((event.type === "pointerover" || event.type === "pointerout") && !hoverSources) return;
      if ((event.type === "pointerdown" || event.type === "pointerup" || event.type === "pointercancel") && !activeSources) return;
      if (event.type === "load") {
        pruneRoots();
        var tag = event.target && event.target.tagName;
        if (tag === "IFRAME" || tag === "FRAME") {
          addRoot(frameDocument(event.target), true);
          markDirty("frame-load", true);
        } else if (tag === "LINK" || tag === "STYLE") markDirty("stylesheet");
        else if (tag === "IMG" || tag === "VIDEO" || tag === "AUDIO" || tag === "OBJECT") markDirty("layout-load");
        return;
      }
      // An explicit edit event establishes the polling baseline immediately,
      // so the next discovery pass does not refresh the same edit a second time.
      if (event.type === "input" || event.type === "change") checkControl(event.target, true);
      markDirty(event.type);
    }

    function inOwnedHighlight(node) {
      var cursor = node;
      while (cursor) {
        if (cursor.nodeType === 1) {
          if (cursor.id === "regex-search-container" || cursor.id === "rr-host") return false;
          if (cursor.tagName === "MARK" && (cursor.classList.contains("regex-search-highlight") ||
              cursor.getAttribute("data-regexrabbithighlight") === "true" ||
              cursor.getAttribute("data-regex-rabbit-highlight") === "true")) return true;
        }
        cursor = cursor.parentNode || cursor.host;
      }
      return false;
    }

    function textPieces(nodes, limit, budget) {
      var result = [], hasOwn = false;
      if (nodes.length > limit) return null;
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        var text = "";
        if (node.nodeType === 3) text = node.nodeValue || "";
        else if (own(node)) {
          hasOwn = true;
          if (node.tagName === "MARK") {
            // Our marks contain at most one text node. Never walk arbitrary
            // page-owned nested content simply because it copied a CSS class.
            if (node.childNodes.length > 1 || (node.firstChild && node.firstChild.nodeType !== 3)) return null;
            text = node.firstChild ? node.firstChild.nodeValue || "" : "";
          }
        } else return null;
        if (text.length > budget.remaining) return null;
        budget.remaining -= text.length;
        if (text) result.push(text);
      }
      return { pieces: result, hasOwn: hasOwn };
    }

    function processMutations(records) {
      if (!running || records.length === 0 || !checkContainer()) return;
      var batch = { records: records, index: 0, next: null };
      if (mutationTail) mutationTail.next = batch;
      else mutationHead = batch;
      mutationTail = batch;
      if (mutationTimer === null) drainMutationBatches();
    }

    function drainMutationBatches() {
      mutationTimer = null;
      if (!running || !checkContainer()) return;
      var remaining = MUTATION_RECORDS_PER_TURN;
      while (mutationHead && remaining > 0) {
        var batch = mutationHead;
        var end = Math.min(batch.records.length, batch.index + remaining);
        processMutationBatch(batch.records, batch.index, end);
        if (!running) return;
        remaining -= end - batch.index;
        batch.index = end;
        if (end === batch.records.length) {
          // Release processed MutationRecords immediately, including detached DOM.
          mutationHead = batch.next;
          if (!mutationHead) mutationTail = null;
        }
      }
      if (mutationHead) {
        // Conservatively refresh while the rest is pending. Every remaining
        // record still gets discovery and cleanup on a later task.
        markDirty("mutation");
        mutationTimer = setTimeout(drainMutationBatches, 0);
      }
    }

    function processMutationBatch(records, start, end) {
      ownCache = new WeakMap();
      var changed = false, removed = false;
      var wrapperChanges = new Map();
      var textBudget = { remaining: WRAPPER_TEXT_BUDGET_CHARS };
      var discoveryRemaining = MUTATION_DISCOVERY_BATCH_SIZE;
      for (var i = start; i < end; i++) {
        var record = records[i];
        if (own(record.target)) {
          if (record.type !== "attributes" && inOwnedHighlight(record.target)) changed = true;
          continue;
        }
        if (record.type !== "childList") { changed = true; continue; }
        if (record.removedNodes.length) removed = true;
        var before = textPieces(record.removedNodes, WRAPPER_NODE_BATCH_SIZE, textBudget);
        var after = textPieces(record.addedNodes, WRAPPER_NODE_BATCH_SIZE, textBudget);
        if (before && after) {
          var group = wrapperChanges.get(record.target);
          if (!group) { group = { before: [], after: [], hasOwn: false }; wrapperChanges.set(record.target, group); }
          group.before.push.apply(group.before, before.pieces);
          group.after.push.apply(group.after, after.pieces);
          group.hasOwn = group.hasOwn || before.hasOwn || after.hasOwn;
        } else changed = true;
        // Only newly inserted element boundaries are queued, never their entire trees.
        for (var j = 0; j < record.addedNodes.length && discoveryRemaining > 0; j++) {
          discoveryRemaining -= 1;
          var added = record.addedNodes[j];
          if (added.nodeType === 1 && !own(added)) {
            inspectElement(added);
            queueWalk(added);
          }
        }
        if (record.addedNodes.length > MUTATION_DISCOVERY_BATCH_SIZE || discoveryRemaining === 0) {
          // Walk this boundary incrementally instead of dropping later siblings.
          queueWalk(record.target);
        }
      }
      wrapperChanges.forEach(function (group) {
        // Exact equality avoids false invalidation when legacy marks only wrap text.
        if (!group.hasOwn || group.before.join("") !== group.after.join("")) changed = true;
      });
      if (removed) pruneRoots();
      if (changed) markDirty("mutation");
    }

    function queueWalk(root) {
      if (!root || own(root) || pendingWalks.has(root)) return;
      var owner = root.nodeType === 9 ? root : root.ownerDocument;
      if (!owner || !owner.createTreeWalker) return;
      try {
        var walker = owner.createTreeWalker(root, 1, { acceptNode: function (node) { return own(node) ? 2 : 1; } });
        pendingWalks.set(root, { root: root, walker: walker, first: root.nodeType === 1 });
      } catch (ignored) {}
    }

    function checkControl(element, explicitEdit, suppressDirty, observed) {
      var tag = element && element.tagName;
      if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return;
      if (tag === "INPUT" && element.type === "hidden") return;
      var password = tag === "INPUT" && element.type === "password";
      var value;
      if (password) {
        // Only the public placeholder state is searchable. Never read the
        // password value, even temporarily; the scalar length below represents
        // whether that placeholder is shown, not the password's actual length.
        try { value = (observed && typeof observed.empty === "boolean" ? observed.empty : element.matches(":placeholder-shown")) ? "" : "x"; }
        catch (ignored) { return; }
      }
      else if (!password && observed && typeof observed.value === "string") value = observed.value;
      else { try { value = element.value; } catch (ignored) { return; } }
      if (typeof value !== "string") return;
      var state = { value: password || value.length > CONTROL_HASH_SLICE_CHARS ? null : value,
        length: password ? (value.length ? 1 : 0) : value.length,
        checked: false, indeterminate: false, selectedIndex: -1, valid: true };
      try {
        state.checked = tag === "INPUT" && !!element.checked;
        state.indeterminate = tag === "INPUT" && !!element.indeterminate;
        state.selectedIndex = tag === "SELECT" ? element.selectedIndex : -1;
        state.valid = !element.validity || !!element.validity.valid;
      } catch (ignored) {}
      var previous = controlValues.get(element);
      var changed = previous && (previous.value !== state.value || previous.length !== state.length ||
        previous.checked !== state.checked || previous.indeterminate !== state.indeterminate ||
        previous.selectedIndex !== state.selectedIndex || previous.valid !== state.valid);
      if (changed && !suppressDirty) markDirty("control-value");
      if (previous) {
        // Keep a stable state object while an incremental fingerprint is in
        // flight. Explicit input events already deliver the edit, so establish
        // a fresh polling baseline instead of refreshing it a second time.
        if (changed || explicitEdit) previous.revision += 1;
        if (previous.length !== state.length || explicitEdit || state.value !== null || password) {
          previous.hash1 = undefined; previous.hash2 = undefined;
        }
        Object.assign(previous, state);
        state = previous;
      } else state.revision = 0;
      controlValues.set(element, state);
      // Store small exact baselines. Larger values have no length cutoff and
      // are hashed in bounded slices with just one retained snapshot.
      // Weak references and a rotating cursor keep
      // all tracked controls fair without retaining detached page subtrees.
      if (!password && value.length > CONTROL_HASH_SLICE_CHARS &&
          !controlHashTracked.has(element)) {
        var reference = typeof WeakRef === "function" ? new WeakRef(element) : { deref: function () { return element; } };
        controlHashControls.add(reference);
        controlHashTracked.add(element);
      }
    }

    function pollControlHashes() {
      var started = Date.now(), characters = 0, jobs = 0;
      while (characters < CONTROL_HASH_SLICE_CHARS && jobs < CONTROL_HASH_JOBS_PER_TURN && Date.now() - started < POLL_SLICE_MS) {
        if (!controlHashJob) {
          if (!controlHashControls.size) return;
          if (!controlHashCursor) controlHashCursor = controlHashControls.values();
          var next = controlHashCursor.next();
          if (next.done) { controlHashCursor = null; return; }
          var reference = next.value, element = reference.deref();
          jobs += 1;
          if (!element || !connected(element) || own(element)) {
            controlHashControls.delete(reference);
            if (element) controlHashTracked.delete(element);
            continue;
          }
          if (element.type === "password") {
            controlHashControls.delete(reference);
            controlHashTracked.delete(element);
            continue;
          }
          var state = controlValues.get(element), value;
          try { value = element.value; } catch (ignored) { continue; }
          if (!state || typeof value !== "string" || value.length <= CONTROL_HASH_SLICE_CHARS) {
            controlHashControls.delete(reference);
            controlHashTracked.delete(element);
            continue;
          }
          controlHashJob = { element: element, state: state, revision: state.revision,
            value: value, offset: 0, hash1: FNV_OFFSET_BASIS, hash2: SECOND_HASH_SEED };
        }
        var job = controlHashJob;
        if (job.element.type === "password" || !connected(job.element) ||
            controlValues.get(job.element) !== job.state || job.state.revision !== job.revision) {
          controlHashJob = null;
          continue;
        }
        var end = Math.min(job.value.length, job.offset + CONTROL_HASH_CHUNK_CHARS, job.offset + CONTROL_HASH_SLICE_CHARS - characters);
        for (var i = job.offset; i < end; i++) {
          var code = job.value.charCodeAt(i);
          job.hash1 = multiply(job.hash1 ^ code, FNV_PRIME) >>> 0;
          job.hash2 = multiply(job.hash2 ^ code, SECOND_HASH_PRIME) >>> 0;
          if ((i & (CONTROL_HASH_CHECK_INTERVAL - 1)) === CONTROL_HASH_CHECK_INTERVAL - 1 && Date.now() - started >= POLL_SLICE_MS) { end = i + 1; break; }
        }
        characters += end - job.offset;
        job.offset = end;
        if (job.offset === job.value.length) {
          if (job.state.hash1 !== undefined && (job.state.hash1 !== job.hash1 || job.state.hash2 !== job.hash2)) {
            markDirty("control-value");
          }
          job.state.hash1 = job.hash1; job.state.hash2 = job.hash2;
          controlHashJob = null;
        }
      }
    }

    function inspectElement(element) {
      if (own(element)) return;
      var tag = String(element.tagName).toUpperCase();
      var customName = tag.indexOf("-") !== -1 ? element.localName : element.getAttribute("is");
      if (customName) {
        try {
          var view = element.ownerDocument && element.ownerDocument.defaultView;
          var registry = view && view.customElements;
          if (registry && typeof registry.get === "function") {
            var defined = !!registry.get(customName), previous = definitionStates.get(element);
            if (previous !== undefined && previous !== defined) markDirty("custom-definition");
            definitionStates.set(element, defined);
          }
        } catch (ignored) {}
      }
      // Chrome's closed-root API can expose native control internals. Search
      // controls through their public values, and frames through their Document.
      if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT" && tag !== "IFRAME" && tag !== "FRAME") {
        var shadow = getShadowRoot(element);
        if (shadow) addRoot(shadow, true);
      }
      if (element.tagName === "IFRAME" || element.tagName === "FRAME") addRoot(frameDocument(element), true);
      checkControl(element);
    }

    function getShadowRoot(element) {
      try {
        var visibility = globalThis.RRPageVisibility;
        if (visibility && typeof visibility.getShadowRoot === "function") return visibility.getShadowRoot(element);
      } catch (ignored) {}
      try {
        if (element.shadowRoot) return element.shadowRoot;
        var domAPI = globalThis.chrome && globalThis.chrome.dom;
        if (domAPI && typeof domAPI.openOrClosedShadowRoot === "function") return domAPI.openOrClosedShadowRoot(element);
      } catch (ignored) { /* The API is unavailable outside an extension context. */ }
      return null;
    }

    function mediaText(source) {
      try { return source && source.media && String(source.media.mediaText || "").trim() || ""; }
      catch (ignored) { return ""; }
    }

    function recordMedia(job, query) {
      if (query) job.media.add(query);
    }

    function replacePseudoState(root, sheet, flags) {
      var entry = entries.get(root);
      if (!entry) return;
      var previous = entry.sheetPseudos.get(sheet);
      if (previous) {
        if (previous.hover) hoverSources -= 1;
        if (previous.active) activeSources -= 1;
        entry.sheetPseudos.delete(sheet);
      }
      if (!flags || (!flags.hover && !flags.active)) return;
      entry.sheetPseudos.set(sheet, { hover: !!flags.hover, active: !!flags.active });
      if (flags.hover) hoverSources += 1;
      if (flags.active) activeSources += 1;
    }

    function recordPseudos(job, selector) {
      if (!selector) return;
      // Inaccessible or exceptionally large selectors are conservatively
      // treated as state-dependent, without retaining another large string.
      if (selector.length > MAX_EAGER_SELECTOR_CHARS) { job.hover = true; job.active = true; return; }
      var lower = selector.toLowerCase();
      if (lower.indexOf(":hover") !== -1) job.hover = true;
      if (lower.indexOf(":active") !== -1) job.active = true;
    }

    function acquireMedia(view, query) {
      if (!view || typeof view.matchMedia !== "function" || !query) return null;
      var queries = mediaViews.get(view), tracked = queries && queries.get(query);
      if (tracked) { tracked.references += 1; return tracked; }
      try {
        var list = view.matchMedia(query);
        var listener = function () { markDirty("media-query"); };
        if (typeof list.addEventListener === "function") list.addEventListener("change", listener);
        else if (typeof list.addListener === "function") list.addListener(listener);
        else return null;
        tracked = { list: list, listener: listener, references: 1 };
        if (!queries) { queries = new Map(); mediaViews.set(view, queries); }
        queries.set(query, tracked);
        return tracked;
      } catch (ignored) { return null; }
    }

    function releaseMedia(view, query) {
      var queries = mediaViews.get(view), tracked = queries && queries.get(query);
      if (!tracked) return;
      if (--tracked.references > 0) return;
      try {
        if (typeof tracked.list.removeEventListener === "function") tracked.list.removeEventListener("change", tracked.listener);
        else if (typeof tracked.list.removeListener === "function") tracked.list.removeListener(tracked.listener);
      } catch (ignored) {}
      queries.delete(query);
      if (!queries.size) mediaViews.delete(view);
    }

    function replaceMediaQueries(root, sheet, conditions) {
      var entry = entries.get(root);
      if (!entry) return;
      var owner = root.nodeType === 9 ? root : root.ownerDocument, view;
      try { view = owner && owner.defaultView; } catch (ignored) { return; }
      var previous = entry.sheetMedia.get(sheet) || new Set(), next = new Set();
      previous.forEach(function (query) { if (!conditions.has(query)) releaseMedia(view, query); });
      conditions.forEach(function (query) {
        if (previous.has(query) || acquireMedia(view, query)) next.add(query);
      });
      if (next.size) entry.sheetMedia.set(sheet, next);
      else entry.sheetMedia.delete(sheet);
    }

    function newSheetScan(root) {
      var sources = [];
      try {
        if (root.styleSheets) sources.push(root.styleSheets);
        if (root.adoptedStyleSheets) sources.push(root.adoptedStyleSheets);
      } catch (ignored) {}
      return { sources: sources, sourceIndex: 0, index: 0, signature: [], seen: new WeakSet(),
        live: new WeakSet(), changed: false, cleanup: null };
    }

    function checkStylesheets(root, entry) {
      if (!entry.sheetScan) { entry.sheetScan = newSheetScan(root); stylesheetScans += 1; }
      var scan = entry.sheetScan, started = Date.now(), visited = 0;
      // Continue from the saved cursor until every accessible sheet is checked.
      while (scan.sourceIndex < scan.sources.length &&
             visited < SHEET_ENTRY_BATCH_SIZE && Date.now() - started < POLL_SLICE_MS) {
        var source = scan.sources[scan.sourceIndex];
        if (!source || scan.index >= source.length) { scan.sourceIndex += 1; scan.index = 0; continue; }
        var sheet = source[scan.index++], count = -1;
        visited += 1;
        if (!sheet || scan.seen.has(sheet)) continue;
        scan.seen.add(sheet);
        if (ownedSheets.has(sheet) || (sheet.ownerNode && own(sheet.ownerNode))) continue;
        try { count = sheet.cssRules.length; } catch (ignored) {}
        if (count === -1) replacePseudoState(root, sheet, { hover: true, active: true });
        var disabled = sheet.disabled, currentMedia = mediaText(sheet);
        var oldState = sheetStates.get(sheet);
        var changed = oldState && (oldState.disabled !== disabled || oldState.count !== count || oldState.media !== currentMedia);
        if (changed) {
          markDirty("stylesheet");
          if (cssJob && cssJob.sheet === sheet) cssJob = null;
        }
        if (!oldState || changed) sheetStates.set(sheet, { disabled: disabled, count: count, media: currentMedia });
        // Constructable sheets are often shared by hundreds of shadow roots.
        // Keep one set of scalar metadata and only sheet references per root.
        if (entry.sheets && sheet !== entry.sheets[scan.signature.length]) scan.changed = true;
        scan.signature.push(sheet);
        scan.live.add(sheet);
      }
      if (scan.sourceIndex < scan.sources.length) return;
      if (!scan.cleanup) {
        if (entry.sheets && (scan.changed || scan.signature.length !== entry.sheets.length)) {
          markDirty("stylesheet");
          if (cssJob && cssJob.root === root) cssJob = null;
        }
        entry.sheets = scan.signature;
        if (cssJob && cssJob.root === root && !scan.live.has(cssJob.sheet)) cssJob = null;
        scan.cleanup = { media: entry.sheetMedia.keys(), pseudos: entry.sheetPseudos.keys(), mediaDone: false };
      }
      // Cleanup uses the same advancing slice as discovery; a large sheet list
      // never requires another full copy or a quadratic membership check.
      while (visited < SHEET_ENTRY_BATCH_SIZE && Date.now() - started < POLL_SLICE_MS) {
        var iterator = scan.cleanup.mediaDone ? scan.cleanup.pseudos : scan.cleanup.media;
        var next = iterator.next();
        if (next.done) {
          if (!scan.cleanup.mediaDone) { scan.cleanup.mediaDone = true; continue; }
          entry.sheetScan = null; stylesheetScans -= 1;
          return;
        }
        visited += 1;
        if (scan.live.has(next.value)) continue;
        if (scan.cleanup.mediaDone) replacePseudoState(root, next.value, null);
        else replaceMediaQueries(root, next.value, new Set());
      }
    }

    function nextCssJob() {
      var started = Date.now();
      for (var checked = 0; checked < CSS_JOB_START_BATCH_SIZE && Date.now() - started < POLL_SLICE_MS; checked++) {
        var root = nextRoot("css");
        if (!root) return null;
        var entry = entries.get(root);
        if (!entry || !connected(root)) continue;
        var signatures = entry.sheets || [];
        if (!signatures.length) continue;
        entry.cssCursor %= signatures.length;
        var sheet = signatures[entry.cssCursor++];
        try {
          var rules = sheet.cssRules;
          return { root: root, sheet: sheet, stack: [{ rules: rules, index: 0 }], sheets: new WeakSet([sheet]),
            ruleLists: new WeakSet([rules]),
            hash: FNV_OFFSET_BASIS, text: null, offset: 0, media: new Set(), hover: false, active: false };
        } catch (ignored) { replacePseudoState(root, sheet, { hover: true, active: true }); }
      }
      return null;
    }

    function hashCssChunk(job, text, end) {
      for (var index = job.offset; index < end; index++) {
        job.hash = multiply(job.hash ^ text.charCodeAt(index), FNV_PRIME) >>> 0;
      }
      job.offset = end;
    }

    function pollCssRules() {
      if (!cssJob) cssJob = nextCssJob();
      if (!cssJob) return;
      var job = cssJob, started = Date.now(), characters = 0, rules = 0;
      recordMedia(job, mediaText(job.sheet));
      // Only one serialized leaf rule is retained between slices. Grouping
      // rules are visited recursively, avoiding repeated copies of their bodies.
      while (characters < CSS_TEXT_SLICE_CHARS && rules < CSS_RULE_BATCH_SIZE && Date.now() - started < POLL_SLICE_MS) {
        if (job.text !== null) {
          var end = Math.min(job.text.length, job.offset + CSS_TEXT_SLICE_CHARS - characters);
          characters += end - job.offset;
          hashCssChunk(job, job.text, end);
          if (job.offset < job.text.length) break;
          job.text = null; job.offset = 0;
        }
        if (!job.stack.length) {
          var previous = sheetHashes.get(job.sheet);
          if (previous !== undefined && previous !== job.hash) markDirty("cssom");
          sheetHashes.set(job.sheet, job.hash);
          replaceMediaQueries(job.root, job.sheet, job.media);
          replacePseudoState(job.root, job.sheet, job);
          cssJob = null;
          return;
        }
        var frame = job.stack[job.stack.length - 1];
        if (frame.index >= frame.rules.length) { job.stack.pop(); continue; }
        var rule;
        try { rule = frame.rules[frame.index++]; } catch (ignored) { job.stack.pop(); continue; }
        if (!rule) continue;
        rules += 1;
        try {
          recordPseudos(job, rule.selectorText);
          recordPseudos(job, rule.start);
          recordPseudos(job, rule.end);
          if (rule.type === 4 && rule.conditionText) recordMedia(job, String(rule.conditionText).trim());
          var condition = mediaText(rule);
          recordMedia(job, condition);
          if (rule.cssRules) {
            job.text = String(rule.type) + ":" + String(rule.conditionText || rule.name || rule.keyText || "") +
              ":" + String(rule.start || "") + ":" + String(rule.end || "") +
              ":" + String(rule.selectorText || "") + ":" + (rule.style ? String(rule.style.cssText || "") : "") +
              ":" + rule.cssRules.length + ";";
            if (!job.ruleLists.has(rule.cssRules)) {
              job.ruleLists.add(rule.cssRules);
              job.stack.push({ rules: rule.cssRules, index: 0 });
            }
          } else {
            job.text = String(rule.cssText || "") + ";";
            // @import is not a grouping rule, but its loaded sheet can change
            // through CSSOM without mutating the importing rule's own text.
            try {
              var imported = rule.styleSheet;
              if (imported && !job.sheets.has(imported)) {
                var importedRules = imported.cssRules;
                job.sheets.add(imported);
                var importedCondition = mediaText(imported);
                recordMedia(job, importedCondition);
                if (!job.ruleLists.has(importedRules)) {
                  job.ruleLists.add(importedRules);
                  job.stack.push({ rules: importedRules, index: 0 });
                }
              }
            } catch (ignored) { job.hover = true; job.active = true; }
          }
        } catch (ignored) { job.text = "inaccessible;"; job.hover = true; job.active = true; }
      }
    }

    function discover() {
      discoveryTimer = null;
      if (!running || !checkContainer()) return;
      ownCache = new WeakMap();
      pruneRoots();
      if (pendingWalks.size === 0 && entries.size) {
        var rootsStarted = Date.now();
        for (var r = 0; r < ROOT_DISCOVERY_BATCH_SIZE && Date.now() - rootsStarted < POLL_SLICE_MS; r++) {
          var discoveredRoot = nextRoot("walk");
          if (!discoveredRoot) break;
          queueWalk(discoveredRoot);
        }
      }
      var started = Date.now(), visited = 0;
      while (pendingWalks.size && visited < discoveryBatchSize && Date.now() - started < discoveryBudgetMs) {
        var work = pendingWalks.values().next().value;
        pendingWalks.delete(work.root);
        if (!connected(work.root)) continue;
        var element;
        if (work.first) { work.first = false; element = work.root; }
        else { try { element = work.walker.nextNode(); } catch (ignored) {} }
        if (!element) continue;
        pendingWalks.set(work.root, work);
        inspectElement(element);
        visited += 1;
      }
      if (entries.size) {
        var sheetsStarted = Date.now();
        for (var i = 0; i < SHEET_ROOT_BATCH_SIZE && Date.now() - sheetsStarted < SHEET_ROOT_SLICE_MS; i++) {
          var root = nextRoot("sheets");
          if (!root) break;
          if (entries.has(root)) checkStylesheets(root, entries.get(root));
        }
      }
      pollCssRules();
      pollControlHashes();
      if (running) {
        // Long DOM/style scans yield between bounded slices, then return to
        // the low-frequency interval as soon as the current pass finishes.
        var interval = controlHashJob ? Math.min(discoveryIntervalMs, CONTROL_HASH_CONTINUE_MS) :
          pendingWalks.size || cssJob || stylesheetScans ? Math.min(discoveryIntervalMs, DISCOVERY_CONTINUE_MS) : discoveryIntervalMs;
        discoveryTimer = setTimeout(discover, interval);
      }
    }

    function updateRoots(roots) {
      if (disposed || !running) return api;
      var wanted = new Set([doc]);
      if (roots && typeof roots[Symbol.iterator] === "function") {
        for (var root of roots) {
          if (root && (root.nodeType === 9 || root.nodeType === 11 || root.nodeType === 1) &&
              connected(root) && !own(root)) wanted.add(root);
        }
      }
      // A collector snapshot may omit hidden boundaries, selection-external
      // roots, or roots beyond its current scan budget. Keep live observations
      // so discovery does not repeatedly remove/re-add those same boundaries.
      // Navigation/removal is authoritative evidence that a root can be freed.
      pruneRoots();
      wanted.forEach(function (root) { addRoot(root, false); });
      return api;
    }

    function start(roots) {
      if (disposed) return api;
      if (running) return roots ? updateRoots(roots) : api;
      running = true;
      generation += 1;
      pauseDepth = 0;
      containerWasConnected = false;
      if (!checkContainer()) return api;
      addRoot(doc, false);
      if (roots) updateRoots(roots);
      discover();
      return api;
    }

    function pause() {
      var tokenGeneration = generation, active = running;
      if (active) {
        observers.forEach(function (state) { if (state.observer) processMutations(state.observer.takeRecords()); });
        if (running && generation === tokenGeneration) {
          pauseDepth += 1;
          clearSearchTimers();
        } else active = false;
      }
      var used = false;
      return function () {
        if (used) return;
        used = true;
        if (active && running && generation === tokenGeneration) resume();
      };
    }

    function resume() {
      if (!running || pauseDepth === 0) return api;
      pauseDepth -= 1;
      if (pauseDepth === 0 && dirty) markDirty("resume");
      return api;
    }

    function stop() {
      running = false;
      generation += 1;
      clearSearchTimers();
      clearTimeout(discoveryTimer); discoveryTimer = null;
      clearTimeout(mutationTimer); mutationTimer = null;
      mutationHead = null; mutationTail = null;
      entries.forEach(function (_entry, root) { dropRoot(root); });
      observers.forEach(function (state) { try { state.observer.disconnect(); } catch (ignored) {} });
      observers.clear();
      pendingWalks.clear();
      ownCache = new WeakMap();
      ownedSheets = new WeakSet();
      controlValues = new WeakMap();
      definitionStates = new WeakMap();
      controlHashControls.clear(); controlHashTracked = new WeakSet(); controlHashCursor = null; controlHashJob = null;
      mediaViews.clear();
      hoverSources = 0; activeSources = 0;
      rootCursors = { walk: null, sheets: null, prune: null, css: null };
      cssJob = null;
      stylesheetScans = 0;
      sheetHashes = new WeakMap();
      sheetStates = new WeakMap();
      pauseDepth = 0; dirty = false; rootsChanged = false; reasons.clear();
      containerWasConnected = false;
      return api;
    }

    function setDebounce(value, maxWait) {
      debounceMs = number(value, debounceMs, 0, OBSERVER_DEFAULTS.maxDebounceMs);
      if (maxWait !== undefined) maxWaitMs = number(maxWait, maxWaitMs, 1, OBSERVER_DEFAULTS.maxWaitCeilingMs);
      if (running && dirty && pauseDepth === 0) {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(flush, debounceMs);
        // Keep the original maximum-wait deadline when configuration changes.
      }
      return api;
    }

    function dispose() { stop(); disposed = true; }

    function registerRoot(root) {
      if (running && !disposed) {
        ownCache = new WeakMap();
        addRoot(root, false);
      }
      return api;
    }

    function syncControl(element, observed) {
      // A search can read an eventless edit before polling sees it. Adopt
      // that actual read as the baseline so a subsequent edit is not lost.
      // Do not emit another refresh for content the search already consumed.
      // Reuse a supplied public value/state without retaining its wrapper or
      // resetting an unchanged large control's in-flight fingerprint.
      if (running && !disposed && connected(element) && !own(element)) checkControl(element, false, true, observed);
      return api;
    }

    var api = { start: start, addRoot: registerRoot, updateRoots: updateRoots, pause: pause, resume: resume,
      stop: stop, flush: flush, setDebounce: setDebounce, syncControl: syncControl, dispose: dispose };
    return api;
  }

  function number(value, fallback, min, max) {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
  }

  globalThis.RRDynamicObserver = { create: create };
})();
