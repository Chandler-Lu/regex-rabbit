/** Capture the page selection before the search bar receives focus. */
(function () {
  "use strict";
  function documentAttached(doc) {
    if (globalThis.RRPageVisibility && globalThis.RRPageVisibility.isDocumentAttached) return globalThis.RRPageVisibility.isDocumentAttached(doc);
    if (doc === document) return true;
    var seen = new WeakSet();
    while (doc && !seen.has(doc)) {
      if (doc === document) return true;
      seen.add(doc);
      try {
        var frame = doc.defaultView && doc.defaultView.frameElement;
        if (!frame || !frame.isConnected || frame.contentDocument !== doc) return false;
        doc = frame.ownerDocument;
      } catch (_) { return false; }
    }
    return false;
  }
  function isExcluded(node, excluded) {
    var seen = new WeakSet();
    var visibility = globalThis.RRPageVisibility;
    var context = visibility && visibility.createContext ? visibility.createContext({ cacheStyles: false }) : visibility;
    while (node && !seen.has(node)) {
      seen.add(node);
      if (node === excluded || node.nodeType === 1 && node.getAttribute("data-regex-rabbit-owned") === "true") return true;
      node = context ? context.composedParent(node) : node.parentNode || node.host;
    }
    return false;
  }
  function supportedControl(node) {
    var tag = String(node.tagName || "").toUpperCase();
    return tag === "TEXTAREA" || tag === "INPUT" && /^(?:text|search|url|tel)$/.test(node.type);
  }
  function controlOffsets(start, end) {
    return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start;
  }
  function controlSelection(node, excluded) {
    if (!node || isExcluded(node, excluded)) return null;
    try {
      if (!supportedControl(node)) return null;
      var start = node.selectionStart, end = node.selectionEnd;
      if (!controlOffsets(start, end)) return null;
      var value = node.value;
      if (typeof value !== "string" || end > value.length) return null;
      return { kind: "control-selection", node: node, start: start, end: end, valueSnapshot: value };
    } catch (_) { return null; }
  }
  function connectedRange(range, excluded) {
    return range && !range.collapsed && range.startContainer && range.endContainer &&
      range.startContainer.isConnected && range.endContainer.isConnected &&
      documentAttached(range.startContainer.ownerDocument) && documentAttached(range.endContainer.ownerDocument) &&
      !isExcluded(range.startContainer, excluded) && !isExcluded(range.endContainer, excluded);
  }
  function selectionRange(selection, roots, excluded) {
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    try {
      if (typeof selection.getComposedRanges === "function") {
        // Supplying the accessible roots prevents retargeting a shadow selection
        // to the host's complete light subtree. DOM Range cannot span roots.
        var anchorRoot = selection.anchorNode && selection.anchorNode.getRootNode();
        var known = roots.slice();
        var knownRoots = new WeakSet(known), seenRoots = new WeakSet();
        while (anchorRoot && anchorRoot.host && !seenRoots.has(anchorRoot)) {
          seenRoots.add(anchorRoot);
          if (!knownRoots.has(anchorRoot)) { known.push(anchorRoot); knownRoots.add(anchorRoot); }
          anchorRoot = anchorRoot.host.getRootNode();
        }
        var ranges = selection.getComposedRanges({ shadowRoots: known });
        if (ranges.length) {
          var source = ranges[0];
          if (source.startContainer.getRootNode() !== source.endContainer.getRootNode()) return null;
          var range = source.startContainer.ownerDocument.createRange();
          range.setStart(source.startContainer, source.startOffset);
          range.setEnd(source.endContainer, source.endOffset);
          return connectedRange(range, excluded) ? range : null;
        }
      }
      var fallback = selection.getRangeAt(0);
      return connectedRange(fallback, excluded) ? fallback.cloneRange() : null;
    } catch (_) { return null; }
  }
  function capture(options) {
    options = options || {};
    var doc = options.document || document, excluded = options.exclude || null;
    var initial = options.root || doc;
    var contexts = [initial], roots = initial.host ? [initial] : [], current = initial, active = null, seen = new WeakSet();
    while (current && !seen.has(current)) {
      seen.add(current);
      try { active = current.activeElement; } catch (_) { break; }
      if (!active || isExcluded(active, excluded)) break;
      var control = controlSelection(active, excluded);
      if (control) return control;
      var next = null;
      try {
        if (/^(?:IFRAME|FRAME)$/.test(String(active.tagName).toUpperCase())) next = active.contentDocument;
        else if (globalThis.RRPageVisibility) next = globalThis.RRPageVisibility.getShadowRoot(active);
        else next = active.shadowRoot;
      } catch (_) { /* Cross-origin and detached frames cannot expose selections. */ }
      if (!next || seen.has(next)) break;
      if (next.host) roots.push(next);
      contexts.push(next); current = next;
    }
    for (var j = contexts.length - 1; j >= 0; j--) {
      try {
        var context = contexts[j];
        var selected = typeof context.getSelection === "function" ? context.getSelection() :
          context.defaultView && context.defaultView.getSelection();
        var range = selectionRange(selected, roots, excluded);
        if (range) return range;
      } catch (_) { /* Selection may disappear when a frame navigates. */ }
    }
    return null;
  }
  function isValid(selection) {
    if (selection && selection.kind === "control-selection") {
      var node = selection.node;
      try {
        if (!node || !node.isConnected || !documentAttached(node.ownerDocument) || !supportedControl(node) ||
            typeof selection.valueSnapshot !== "string" || !controlOffsets(selection.start, selection.end) ||
            selection.end > selection.valueSnapshot.length) return false;
        return node.value === selection.valueSnapshot;
      } catch (_) { return false; }
    }
    return !!connectedRange(selection, null);
  }
  function rootFor(selection) {
    if (selection.kind === "control-selection") return selection.node;
    return selection.commonAncestorContainer.nodeType === 3 ? selection.commonAncestorContainer.parentNode : selection.commonAncestorContainer;
  }
  function createTracker(options) {
    options = options || {};
    var topDocument = options.document || document, listeners = new Map(), active = false;
    var events = ["selectionchange", "select", "pointerup", "keyup", "pointerdown", "wheel", "touchstart", "keydown"];
    var shadowEvents = ["selectionchange", "select"];
    function connected(root) {
      try {
        if (root === topDocument) return true;
        if (root.host) return root.host.isConnected &&
          documentAttached(root.host.ownerDocument) &&
          (!globalThis.RRPageVisibility || globalThis.RRPageVisibility.getShadowRoot(root.host) === root);
        var frame = root.defaultView && root.defaultView.frameElement;
        return !!frame && frame.isConnected && frame.contentDocument === root && documentAttached(root);
      } catch (_) { return false; }
    }
    function remove(root, listener) {
      (root.host ? shadowEvents : events).forEach(function (name) { root.removeEventListener(name, listener, true); });
      listeners.delete(root);
    }
    function prune() {
      listeners.forEach(function (listener, root) { if (!connected(root)) remove(root, listener); });
    }
    function addRoot(root) {
      if (!active || !root || typeof root.addEventListener !== "function") return;
      if (listeners.has(root)) return;
      if (!connected(root)) return;
      // Composed input/pointer events are handled once by their Document.
      // A shadow root only needs its own non-composed selection events.
      if (root.host) addRoot(root.ownerDocument);
      var listener = function (event) {
        if (!active || root.host && event.composed) return;
        var excluded = options.getExcluded ? options.getExcluded() : null;
        if (isExcluded(event.target, excluded)) return;
        if (["pointerdown", "wheel", "touchstart", "keydown"].indexOf(event.type) !== -1) {
          if (options.onInteraction) options.onInteraction(event);
          return;
        }
        var selected = controlSelection(event.target, excluded) || capture({
          document: root.nodeType === 9 ? root : root.ownerDocument, root: root, exclude: excluded
        });
        if (selected && options.onSelection) options.onSelection(selected, event);
      };
      listeners.set(root, listener);
      (root.host ? shadowEvents : events).forEach(function (name) { root.addEventListener(name, listener, { capture: true, passive: true }); });
    }
    function start(roots) {
      active = true; prune(); addRoot(topDocument);
      (roots || []).forEach(addRoot);
    }
    function stop() {
      active = false;
      listeners.forEach(function (listener, root) { remove(root, listener); });
    }
    return { start: start, addRoot: addRoot, prune: prune, stop: stop, dispose: stop };
  }
  globalThis.RRSelectionCapture = { capture: capture, isValid: isValid, rootFor: rootFor, createTracker: createTracker };
})();
