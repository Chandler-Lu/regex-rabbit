/** Shared, per-scan visibility checks for the composed DOM. */
(function () {
  "use strict";
  var EXCLUDED = {
    SCRIPT: true, STYLE: true, NOSCRIPT: true, TEMPLATE: true,
    HEAD: true, TITLE: true, META: true, LINK: true,
    CANVAS: true, VIDEO: true, AUDIO: true, OPTION: true, OPTGROUP: true,
    DEFS: true, SYMBOL: true, CLIPPATH: true, MASK: true,
    LINEARGRADIENT: true, RADIALGRADIENT: true, PATTERN: true,
    FILTER: true, MARKER: true, DESC: true
  };
  var BLOCK_TAGS = {
    ADDRESS: true, ARTICLE: true, ASIDE: true, BLOCKQUOTE: true,
    BODY: true, CAPTION: true, DD: true, DETAILS: true, DIALOG: true,
    DIV: true, DL: true, DT: true, FIELDSET: true, FIGCAPTION: true,
    FIGURE: true, FOOTER: true, FORM: true, H1: true, H2: true,
    H3: true, H4: true, H5: true, H6: true, HEADER: true, HR: true,
    LEGEND: true, LI: true, MAIN: true, NAV: true, OL: true, P: true,
    PRE: true, SECTION: true, SUMMARY: true, TABLE: true, TBODY: true,
    TD: true, TFOOT: true, TH: true, THEAD: true, TR: true, UL: true,
    RT: true, RP: true
  };
  var REPLACED_INLINE_TAGS = {
    IMG: true, INPUT: true, TEXTAREA: true, SELECT: true, IFRAME: true, FRAME: true,
    EMBED: true, OBJECT: true, VIDEO: true, AUDIO: true, CANVAS: true, METER: true, PROGRESS: true
  };
  function tagName(element) { return String(element && element.tagName || "").toUpperCase(); }
  function getShadowRoot(element) {
    if (!element || element.nodeType !== 1 || /^(?:INPUT|TEXTAREA|SELECT|OPTION|OPTGROUP|BUTTON|IFRAME|FRAME|VIDEO|AUDIO|METER|PROGRESS)$/.test(tagName(element))) return null;
    try {
      if (element.shadowRoot) return element.shadowRoot;
      var dom = globalThis.chrome && globalThis.chrome.dom;
      if (dom && typeof dom.openOrClosedShadowRoot === "function") {
        var root = dom.openOrClosedShadowRoot(element);
        if (root && root.nodeType === 11 && root.host === element) return root;
      }
    } catch (_) { /* Missing/unsupported extension bindings do not stop a scan. */ }
    return null;
  }
  function composedParent(node) {
    if (!node) return null;
    if (node.assignedSlot) return node.assignedSlot;
    if (node.parentNode) return node.parentNode;
    if (node.host) return node.host;
    if (node.nodeType === 9) {
      try { return node.defaultView && node.defaultView.frameElement; }
      catch (_) { return null; }
    }
    return null;
  }
  function isDocumentAttached(doc) {
    var mainDocument = globalThis.document || (typeof document !== "undefined" ? document : null);
    if (!doc || doc.nodeType !== 9 || !mainDocument) return false;
    if (doc === mainDocument) return true;
    var seen = new WeakSet();
    while (doc) {
      if (doc === mainDocument) return true;
      if (seen.has(doc)) return false;
      seen.add(doc);
      try {
        var frame = doc.defaultView && doc.defaultView.frameElement;
        // Nodes in a removed iframe's old Document can retain isConnected.
        // Only its current, connected embedding frame makes them visible.
        if (!frame || !frame.isConnected || frame.contentDocument !== doc || !frame.ownerDocument) return false;
        doc = frame.ownerDocument;
      } catch (_) { return false; }
    }
    return false;
  }
  function firstSummary(element) {
    // A constant selector lets the browser find a direct summary without a
    // JavaScript loop over every hidden sibling during match revalidation.
    try { return element.querySelector(":scope > summary"); }
    catch (_) { /* Older DOM implementations can lack :scope support. */ }
    for (var child = element.firstElementChild; child; child = child.nextElementSibling) {
      if (tagName(child) === "SUMMARY") return child;
    }
    return null;
  }
  function transparentColor(color) {
    color = String(color || "").trim();
    return color === "transparent" ||
      /\/\s*0(?:\.0+)?%?\s*\)$/.test(color) ||
      /^(?:rgba|hsla)\([^,]+,[^,]+,[^,]+,\s*0(?:\.0+)?%?\s*\)$/.test(color);
  }
  function transparentShadows(value) {
    value = String(value || "").trim();
    if (!value || value === "none") return true;
    var depth = 0, start = 0;
    for (var i = 0; i <= value.length; i++) {
      var character = value[i];
      if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
      if (i !== value.length && !(character === "," && depth === 0)) continue;
      var shadow = value.slice(start, i).trim();
      var token = /(?:^|\s)([a-z][a-z-]*)(?=\(|\s|$)/i.exec(shadow);
      if (!token) return false;
      var color = token[1], position = token.index + token[0].length;
      if (shadow[position] === "(") {
        var colorStart = position - color.length, colorDepth = 0;
        for (; position < shadow.length; position++) {
          if (shadow[position] === "(") colorDepth += 1;
          else if (shadow[position] === ")" && --colorDepth === 0) break;
        }
        color = shadow.slice(colorStart, position + 1);
      }
      if (!transparentColor(color)) return false;
      start = i + 1;
    }
    return true;
  }
  function createContext(options) {
    // Discard the cache after each scan/render so dynamic styles remain current.
    var styles = !options || options.cacheStyles !== false ? new WeakMap() : null;
    var summaries = new WeakMap();
    var closedSlotRoots = new WeakSet(), closedAssignments = new WeakMap();
    function assignedSlotFor(node) {
      if (node.assignedSlot) return node.assignedSlot;
      var host = node.parentNode;
      var root = host && host.nodeType === 1 ? getShadowRoot(host) : null;
      if (!root || root.mode !== "closed") return null;
      if (!closedSlotRoots.has(root)) {
        closedSlotRoots.add(root);
        // The standard assignedSlot getter deliberately conceals closed roots.
        // Read slot distribution through the root exposed to the extension.
        var slots = root.querySelectorAll("slot");
        for (var i = 0; i < slots.length; i++) {
          var assigned = slots[i].assignedNodes();
          for (var j = 0; j < assigned.length; j++) closedAssignments.set(assigned[j], slots[i]);
        }
      }
      return closedAssignments.get(node) || null;
    }
    function parentOf(node) {
      return node && assignedSlotFor(node) || composedParent(node);
    }
    function isComposed(node) {
      var seen = new WeakSet();
      while (node) {
        if (seen.has(node)) return false;
        seen.add(node);
        var assignedSlot = assignedSlotFor(node);
        if (assignedSlot) { node = assignedSlot; continue; }
        var parent = node.parentNode;
        if (parent && parent.nodeType === 1) {
          if (getShadowRoot(parent)) return false;
          if (tagName(parent) === "SLOT" && parent.assignedNodes && parent.assignedNodes().length) return false;
        }
        node = parentOf(node);
      }
      return true;
    }
    function summaryFor(element) {
      if (!summaries.has(element)) summaries.set(element, firstSummary(element));
      return summaries.get(element);
    }
    function styleFor(element) {
      if (styles && styles.has(element)) return styles.get(element);
      var style = null;
      try {
        var view = element.ownerDocument && element.ownerDocument.defaultView;
        if (view && view.getComputedStyle) style = view.getComputedStyle(element);
      } catch (_) { /* A navigated frame can lose its window. */ }
      if (styles) styles.set(element, style);
      return style;
    }
    function inspectElement(element, parentState) {
      var parent = parentState || { hiddenSubtree: false, visible: true, fontSize: null, visibilityHidden: false };
      var tag = tagName(element);
      var style = styleFor(element);
      var display = style && style.display || "";
      var visibility = style && style.visibility || "";
      var opacity = style && style.opacity;
      var filter = style && style.filter || "";
      var zeroFilteredOpacity = display !== "contents" && filter.indexOf("url(") === -1 &&
        /\bopacity\(\s*0(?:\.0+)?%?\s*\)/.test(filter);
      var contentVisibility = style && (style.contentVisibility || style.getPropertyValue("content-visibility")) || "";
      // content-visibility applies only where layout containment can apply.
      // Ignored box properties on contents/non-atomic inline elements must
      // not prune descendants that the browser still visibly paints.
      var canContainLayout = display !== "contents" && (display !== "inline" || !!REPLACED_INLINE_TAGS[tag]) &&
        !/^(?:ruby|table|inline-table)$/.test(display) &&
        !/^ruby-(?:base|text|base-container|text-container)$/.test(display) &&
        !/^table-(?:row|row-group|column|column-group|header-group|footer-group)$/.test(display) &&
        (element.namespaceURI !== "http://www.w3.org/2000/svg" || tag === "SVG");
      var fontSize = style && style.fontSize || parent.fontSize;
      var whiteSpace = style && style.whiteSpace || parent.whiteSpace || "normal";
      var whiteSpaceCollapse = style && (style.whiteSpaceCollapse || style.getPropertyValue("white-space-collapse"));
      if (!whiteSpaceCollapse && !(style && style.whiteSpace)) whiteSpaceCollapse = parent.whiteSpaceCollapse;
      if (!whiteSpaceCollapse) {
        // Modern white-space is a shorthand and can serialize, for example,
        // as "preserve-breaks nowrap" rather than one legacy keyword.
        whiteSpaceCollapse = /(?:^|\s)preserve-breaks(?:\s|$)/.test(whiteSpace) || whiteSpace === "pre-line" ? "preserve-breaks" :
          /(?:^|\s)break-spaces(?:\s|$)/.test(whiteSpace) ? "break-spaces" :
          /(?:^|\s)preserve-spaces(?:\s|$)/.test(whiteSpace) ? "preserve-spaces" :
          whiteSpace === "pre" || whiteSpace === "pre-wrap" || /(?:^|\s)preserve(?:\s|$)/.test(whiteSpace) ? "preserve" : "collapse";
      }
      var hidden = parent.hiddenSubtree || !!EXCLUDED[tag] ||
        element.id === "regex-search-container" ||
        element.getAttribute("data-regex-rabbit-owned") === "true" || display === "none" ||
        canContainLayout && contentVisibility === "hidden" || zeroFilteredOpacity ||
        (display !== "contents" && opacity !== "" && opacity != null && Number(opacity) === 0);
      // An author may override the hidden attribute's display rule.
      if (element.hasAttribute("hidden") && !display) hidden = true;
      if (parent.closedDetails && element.parentNode === parent.element && element !== parent.summary) hidden = true;
      var visibilityHidden = visibility === "hidden" || visibility === "collapse" ||
        (visibility !== "visible" && !!parent.visibilityHidden);
      var visible = !hidden && !visibilityHidden;
      // Children may override inherited visibility or a zero font size.
      if (fontSize && parseFloat(fontSize) === 0) visible = false;
      var color = style && (style.getPropertyValue("-webkit-text-fill-color") || style.color) || "";
      if (style && element.namespaceURI !== "http://www.w3.org/2000/svg" && transparentColor(color)) {
        var strokePaintsText = parseFloat(style.getPropertyValue("-webkit-text-stroke-width")) > 0 &&
          !transparentColor(style.getPropertyValue("-webkit-text-stroke-color") || style.color || color);
        var clipsBackgroundToText = style.getPropertyValue("background-clip") === "text" || style.getPropertyValue("-webkit-background-clip") === "text";
        var backgroundPaintsText = clipsBackgroundToText &&
          (style.backgroundImage && style.backgroundImage !== "none" || !transparentColor(style.backgroundColor || "transparent"));
        if (transparentShadows(style.textShadow) && !strokePaintsText && !backgroundPaintsText) visible = false;
      }
      var svgFill, svgStroke, svgFillOpacity, svgStrokeOpacity, svgStrokeWidth;
      var svgTextContext = false;
      if (element.namespaceURI === "http://www.w3.org/2000/svg") {
        // SVG Text nodes paint only inside text and its text-content children.
        // Raw strings in svg/g/a, and orphan tspan/textPath elements, may
        // otherwise pollute a run that also contains genuinely painted text.
        svgTextContext = tag === "TEXT" || !!parent.svgTextContext && /^(?:TSPAN|TEXTPATH|A)$/.test(tag);
        function paintProperty(property, attribute, inherited, fallback) {
          var value = style && (style[property] || style.getPropertyValue(attribute)) || element.getAttribute(attribute);
          return !value || value === "inherit" ? inherited == null ? fallback : inherited : value;
        }
        svgFill = paintProperty("fill", "fill", parent.svgFill, "black");
        svgStroke = paintProperty("stroke", "stroke", parent.svgStroke, "none");
        svgFillOpacity = paintProperty("fillOpacity", "fill-opacity", parent.svgFillOpacity, "1");
        svgStrokeOpacity = paintProperty("strokeOpacity", "stroke-opacity", parent.svgStrokeOpacity, "1");
        svgStrokeWidth = paintProperty("strokeWidth", "stroke-width", parent.svgStrokeWidth, "1");
        var svgColor = style && style.color || "black";
        var fillColor = svgFill.toLowerCase() === "currentcolor" ? svgColor : svgFill;
        var strokeColor = svgStroke.toLowerCase() === "currentcolor" ? svgColor : svgStroke;
        var fillPaints = fillColor !== "none" && !transparentColor(fillColor) && parseFloat(svgFillOpacity) !== 0;
        var strokePaints = strokeColor !== "none" && !transparentColor(strokeColor) &&
          parseFloat(svgStrokeOpacity) !== 0 && parseFloat(svgStrokeWidth) !== 0;
        // SVG glyphs can have nonzero layout rectangles even when neither
        // fill nor stroke paints them. Children may restore either property.
        if (!fillPaints && !strokePaints) visible = false;
      }
      var block = display ? display !== "inline" && display !== "contents" && display !== "ruby" && display !== "ruby-base" && display !== "ruby-text" : !!BLOCK_TAGS[tag];
      if (display !== "contents" && style && (style.position === "absolute" || style.position === "fixed")) block = true;
      var rubyContainer = tag === "RUBY" || !!parent.rubyContainer;
      var rubyAnnotation = !!parent.rubyContainer && (display === "ruby-text" || display === "ruby-text-container" || /^(?:RT|RTC)$/.test(tag) && !display);
      if (rubyAnnotation || tag === "RP" && !display) block = true;
      var closedDetails = tag === "DETAILS" && !element.hasAttribute("open");
      return {
        element: element, hiddenSubtree: hidden, visible: visible, block: block,
        fontSize: fontSize, visibilityHidden: visibilityHidden, style: style,
        whiteSpace: whiteSpace, whiteSpaceCollapse: whiteSpaceCollapse,
        textTransform: style && style.textTransform || parent.textTransform || "none",
        svgFill: svgFill, svgStroke: svgStroke, svgFillOpacity: svgFillOpacity,
        svgStrokeOpacity: svgStrokeOpacity, svgStrokeWidth: svgStrokeWidth,
        svgTextContext: svgTextContext,
        textRenderable: element.namespaceURI !== "http://www.w3.org/2000/svg" || svgTextContext,
        rubyContainer: rubyContainer, rubyAnnotation: rubyAnnotation,
        closedDetails: closedDetails,
        summary: closedDetails && !(options && options.lazyDetails) ? summaryFor(element) : null
      };
    }
    function ancestorState(node) {
      var chain = [], seen = new WeakSet(), parent = parentOf(node);
      while (parent && !seen.has(parent)) {
        seen.add(parent);
        if (parent.nodeType === 1 || parent.nodeType === 9) chain.push(parent);
        parent = parentOf(parent);
      }
      var state = { hiddenSubtree: false, visible: true, fontSize: null, visibilityHidden: false };
      for (var i = chain.length - 1; i >= 0; i--) {
        if (state.closedDetails && !state.summary) state.summary = summaryFor(state.element);
        state = chain[i].nodeType === 9 ? forFrame(state) : inspectElement(chain[i], state);
      }
      if (state.closedDetails && !state.summary) state.summary = summaryFor(state.element);
      return state;
    }
    function forFrame(state) {
      var hidden = !!state.hiddenSubtree || !!state.visibilityHidden;
      return { hiddenSubtree: hidden, visible: !hidden, fontSize: null, visibilityHidden: false };
    }
    function isVisible(node) {
      if (!node || node.isConnected === false || !isDocumentAttached(node.nodeType === 9 ? node : node.ownerDocument) || !isComposed(node)) return false;
      var state = ancestorState(node);
      if (node.nodeType === 1) state = inspectElement(node, state);
      else if (state.closedDetails && node.parentNode === state.element) return false;
      return !state.hiddenSubtree && state.visible && (node.nodeType !== 3 || state.textRenderable !== false);
    }
    return { inspectElement: inspectElement, ancestorState: ancestorState, styleFor: styleFor,
      isVisible: isVisible, forFrame: forFrame, composedParent: parentOf };
  }
  globalThis.RRPageVisibility = {
    createContext: createContext,
    isVisible: function (node) { return createContext().isVisible(node); },
    composedParent: function (node) { return createContext().composedParent(node); },
    getShadowRoot: getShadowRoot, transparentColor: transparentColor,
    isDocumentAttached: isDocumentAttached
  };
})();
