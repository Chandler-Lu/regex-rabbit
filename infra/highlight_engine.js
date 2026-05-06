/**
 * @fileoverview DOM highlight renderer for Regex Rabbit search results.
 *
 * Wraps matched text ranges in `<mark>` elements with class
 * `"regex-rabbit-highlight"` and data-attribute `"regexRabbitHighlight"`
 * for identification.  Stores cleanup handles so close/refresh cycles
 * don't accidentally normalize unrelated DOM.
 *
 * ## Data flow
 *
 * Input comes from two sources:
 *   - **Indexed nodes** — produced by `SearchCoordinator.collectTextNodesBatched()`
 *     Each entry: `{ id: number, node: TextNode, text: string }`
 *   - **Worker matches** — produced by the search worker's `complete` message
 *     Each entry: `{ chunkId: number, start: number, end: number, text: string }`
 *
 * The `chunkId` in a worker match corresponds to the `id` in an indexed node.
 * The renderer groups matches by `chunkId`, then for each group splits the
 * text node at match boundaries and wraps each match in a `<mark>`.
 *
 * ## MutationObserver interaction
 *
 * `mutation_observer.js` ignores mutations inside the extension's Shadow DOM
 * (`#rr-host`).  The renderer's `<mark>` elements are in the **page DOM** (not
 * the Shadow DOM), so `RRMutationObserver.ignoreOwnMutations()` must be called
 * after rendering to prevent the observer from triggering a re-search for our
 * own DOM changes.
 *
 * ## Layout guard
 *
 * Real pages may have high-specificity or later-loaded `<mark>` CSS that
 * forces highlights into block layout, making them span the full line width
 * instead of wrapping just the matched text.  The renderer applies inline
 * `!important` styles to each `<mark>` to force inline display, zero margins,
 * and content-box sizing.
 *
 * ## Global export
 *
 * `globalThis.RRHighlightEngine` exposes:
 * - `.renderMatches(indexedNodes, workerMatches)` — synchronous, delegates to `renderMatchesSync`
 * - `.renderMatchesBatched(indexedNodes, workerMatches, options)` — async, yields while rendering
 * - `.removeHighlights(handles)` — restores original text nodes
 *
 * ## Cross-references
 *
 * - `search_coordinator.js` — calls `renderMatches` / `renderMatchesBatched`
 *   and stores the returned handles for later cleanup
 * - `mutation_observer.js` — calls `ignoreOwnMutations()` after rendering
 * - `style.css` — styles `mark.regex-rabbit-highlight` and `.current`
 * - `search_worker.js` — produces the `workerMatches` data
 *
 * @module highlight_renderer
 */
(function () {
  "use strict";

  // ── Constants ──────────────────────────────────────────────────────────────

  /**
   * CSS class applied to every highlight `<mark>` element.
   *
   * Styled by `style.css` (injected into the page by `background.js`).
   * The stylesheet defines background colour, outline, and transition.
   * The `.current` subclass marks the active match during navigation.
   *
   * Must be kept in sync with the selectors in `style.css`.
   *
   * @type {string}
   */
  var HIGHLIGHT_CLASS = "regex-search-highlight";

  /**
   * Dataset attribute name used to identify our own `<mark>` elements.
   *
   * Set to `"true"` on every highlight we create.  `removeHighlights()`
   * checks this attribute to avoid removing page-owned `<mark>` elements.
   *
   * Accessed as `mark.dataset.regexRabbitHighlight` in code and
   * rendered as `data-regexrabbithighlight="true"` in the DOM (dataset
   * names are lowercased by the browser).
   *
   * @type {string}
   */
  var HIGHLIGHT_ATTR = "regexRabbitHighlight";

  /**
   * Inline layout guard styles applied with `!important` to beat hostile
   * page CSS.
   *
   * Each entry is `[cssProperty, cssValue]`.  Applied via
   * `mark.style.setProperty(prop, value, "important")` in
   * `applyHighlightLayoutGuard()`.
   *
   * These prevent the highlight from expanding to full-line width when
   * a page's stylesheet forces `<mark>` into block layout.
   *
   * @type {Array<[string, string]>}
   */
  var HIGHLIGHT_LAYOUT_STYLES = [
    ["display", "inline"],
    ["float", "none"],
    ["clear", "none"],
    ["position", "static"],
    ["width", "auto"],
    ["min-width", "0"],
    ["max-width", "none"],
    ["height", "auto"],
    ["min-height", "0"],
    ["max-height", "none"],
    ["margin", "0"],
    ["padding", "1px 0"],
    ["line-height", "inherit"],
    ["vertical-align", "baseline"],
    ["white-space", "inherit"],
    ["box-sizing", "content-box"]
  ];

  // ── Public rendering API ───────────────────────────────────────────────────

  /**
   * Render worker matches as `<mark>` elements in the DOM.
   *
   * Delegates to `renderMatchesSync()` (synchronous).  This is the
   * primary entry point used by `search_coordinator.js` when the match
   * count is small or when async rendering is not needed.
   *
   * For each indexed text node that has matches, splits the text node
   * into alternating text and `<mark>` fragments, then replaces the
   * original node with the assembled `DocumentFragment`.
   *
   * @param {Array<{id:number,node:TextNode,text:string}>} indexedNodes
   *   Text nodes collected by `SearchCoordinator.collectTextNodesBatched()`.
   *   Each entry carries a numeric `id` that matches `chunkId` in worker
   *   results, plus the live DOM `node` and its `text` content snapshot.
   * @param {Array<{chunkId:number,start:number,end:number}>} workerMatches
   *   Match ranges from the search worker's `complete` message.
   *   `chunkId` maps to `indexedNodes[id]`, `start`/`end` are character
   *   offsets within that node's text content.
   * @returns {{handles:Array<{parent:Element,marks:Array<HTMLElement>}>, marks:Array<HTMLElement>}}
   *   - `handles` — cleanup data for `removeHighlights()`.  Each handle
   *     groups the `<mark>` elements that share a parent element.
   *   - `marks` — flat array of all `<mark>` elements created, used by
   *     `SearchCoordinator` for navigation (`navigate()`).
   */
  function renderMatches(indexedNodes, workerMatches) {
    return renderMatchesSync(indexedNodes, workerMatches);
  }

  /**
   * Render worker matches while periodically yielding to the page thread.
   *
   * Used by `SearchCoordinator` for large result sets to keep the UI
   * responsive.  Yields after every `batchSize` nodes or when the time
   * budget (`budgetMs`) is exceeded.
   *
   * @param {Array<{id:number,node:TextNode,text:string}>} indexedNodes
   *   Same format as `renderMatches`.
   * @param {Array<{chunkId:number,start:number,end:number}>} workerMatches
   *   Same format as `renderMatches`.
   * @param {{batchSize?:number,budgetMs?:number}} [options]
   *   - `batchSize` — number of node groups to process before yielding
   *     (default: 100)
   *   - `budgetMs` — maximum milliseconds per batch before yielding
   *     (default: 8)
   * @returns {Promise<{handles:Array<{parent:Element,marks:Array<HTMLElement>}>, marks:Array<HTMLElement>}>}
   *   Same return format as `renderMatches`.
   */
  async function renderMatchesBatched(indexedNodes, workerMatches, options) {
    /** @type {Map<number,{id:number,node:TextNode,text:string}>} Indexed nodes keyed by id */
    var nodesById = createNodesById(indexedNodes);
    /** @type {Map<number,Array<{chunkId:number,start:number,end:number}>>} Matches grouped by chunkId */
    var groupedMatches = createGroupedMatches(workerMatches);
    /** @type {Array<{parent:Element,marks:Array<HTMLElement>}>} Accumulated cleanup handles */
    var handles = [];
    /** @type {Array<HTMLElement>} Accumulated <mark> elements */
    var marks = [];
    /** @type {number} Number of node groups to process before yielding */
    var batchSize = Math.max(1, (options && options.batchSize) || 100);
    /** @type {number} Time budget per batch in milliseconds */
    var budgetMs = Math.max(1, (options && options.budgetMs) || 8);
    /** @type {number} Count of node groups processed since last yield */
    var processed = 0;
    /** @type {number} Timestamp of the current batch start */
    var batchStartedAt = now();

    for (var iterator = groupedMatches.entries(), step = iterator.next(); !step.done; step = iterator.next()) {
      /** @type {number} The chunkId (= indexed node id) for this group */
      var chunkId = step.value[0];
      /** @type {Array<{chunkId:number,start:number,end:number}>} Matches for this node */
      var nodeMatches = step.value[1];
      renderNodeMatches(nodesById.get(chunkId), nodeMatches, handles, marks);
      processed += 1;

      if (processed % batchSize === 0 || now() - batchStartedAt >= budgetMs) {
        await yieldToMainThread();
        batchStartedAt = now();
      }
    }

    return { handles: handles, marks: marks };
  }

  // ── Internal rendering ────────────────────────────────────────────────────

  /**
   * Synchronous renderer used by `renderMatches()` and by tests.
   *
   * Builds the node-id and match-group maps inline (no helper calls)
   * for maximum simplicity.  Does not yield — blocks the main thread
   * until all matches are rendered.
   *
   * @param {Array<{id:number,node:TextNode,text:string}>} indexedNodes
   * @param {Array<{chunkId:number,start:number,end:number}>} workerMatches
   * @returns {{handles:Array<{parent:Element,marks:Array<HTMLElement>}>, marks:Array<HTMLElement>}}
   */
  function renderMatchesSync(indexedNodes, workerMatches) {
    /** @type {Map<number,{id:number,node:TextNode,text:string}>} */
    var nodesById = new Map();
    for (var i = 0; i < indexedNodes.length; i++) {
      nodesById.set(indexedNodes[i].id, indexedNodes[i]);
    }

    /** @type {Map<number,Array<{chunkId:number,start:number,end:number}>>} */
    var groupedMatches = new Map();
    for (var j = 0; j < workerMatches.length; j++) {
      var match = workerMatches[j];
      if (!groupedMatches.has(match.chunkId)) {
        groupedMatches.set(match.chunkId, []);
      }
      groupedMatches.get(match.chunkId).push(match);
    }

    /** @type {Array<{parent:Element,marks:Array<HTMLElement>}>} */
    var handles = [];
    /** @type {Array<HTMLElement>} */
    var marks = [];

    groupedMatches.forEach(function (nodeMatches, chunkId) {
      renderNodeMatches(nodesById.get(chunkId), nodeMatches, handles, marks);
    });

    return { handles: handles, marks: marks };
  }

  /**
   * Build a Map from indexed node `id` to the full entry object.
   *
   * Used by `renderMatchesBatched()` to look up the DOM node for a
   * given `chunkId`.
   *
   * @param {Array<{id:number,node:TextNode,text:string}>} indexedNodes
   * @returns {Map<number,{id:number,node:TextNode,text:string}>}
   */
  function createNodesById(indexedNodes) {
    var nodesById = new Map();
    for (var i = 0; i < indexedNodes.length; i++) {
      nodesById.set(indexedNodes[i].id, indexedNodes[i]);
    }
    return nodesById;
  }

  /**
   * Group worker matches by their `chunkId` (= indexed node `id`).
   *
   * Each group contains all matches that fall within the same text node.
   * The groups are not sorted internally — `renderNodeMatches()` sorts
   * each group by `start` before processing.
   *
   * @param {Array<{chunkId:number,start:number,end:number}>} workerMatches
   * @returns {Map<number,Array<{chunkId:number,start:number,end:number}>>}
   */
  function createGroupedMatches(workerMatches) {
    var groupedMatches = new Map();
    for (var j = 0; j < workerMatches.length; j++) {
      var match = workerMatches[j];
      if (!groupedMatches.has(match.chunkId)) {
        groupedMatches.set(match.chunkId, []);
      }
      groupedMatches.get(match.chunkId).push(match);
    }
    return groupedMatches;
  }

  /**
   * Render all matches for one text node.
   *
   * Algorithm:
   *   1. Filter matches by `isValidMatch()` (bounds check against text length)
   *   2. Sort remaining matches by `start` (ascending)
   *   3. Walk the sorted matches, building a `DocumentFragment` with
   *      alternating plain-text and `<mark>` nodes
   *   4. Skip overlapping matches (if `m.start < lastIndex`, skip)
   *   5. Replace the original text node with the assembled fragment
   *   6. Push a cleanup handle `{ parent, marks }` onto `handles`
   *
   * If the text node has been removed from the DOM (`!parent.isConnected`)
   * or if no valid matches remain after filtering, the function returns
   * without modifying the DOM.
   *
   * @param {{id:number,node:TextNode,text:string}|undefined} entry
   *   The indexed node entry.  May be `undefined` if the worker reported
   *   a match for a node that was not indexed (should not happen in
   *   normal operation, but guarded for robustness).
   * @param {Array<{start:number,end:number}>} nodeMatches
   *   Matches for this node (may include invalid/out-of-bounds entries;
   *   filtered by `isValidMatch()` before processing).
   * @param {Array<{parent:Element,marks:Array<HTMLElement>}>} handles
   *   Accumulator for cleanup handles.  Each handle groups the `<mark>`
   *   elements that share a parent, so `removeHighlights()` can normalize
   *   the parent after removing all its marks.
   * @param {Array<HTMLElement>} marks
   *   Accumulator for all `<mark>` elements.  Used by `SearchCoordinator`
   *   for match navigation.
   */
  function renderNodeMatches(entry, nodeMatches, handles, marks) {
    if (!entry) return;

    /** @type {TextNode} The live DOM text node to split */
    var textNode = entry.node;
    /** @type {string} Snapshot of the text content (may differ from textNode.nodeValue if DOM changed) */
    var text = entry.text;
    /** @type {Element} Parent element of the text node */
    var parent = textNode.parentNode;
    if (!parent || !parent.isConnected) return;

    /** @type {DocumentFragment} Assembled replacement for the text node */
    var fragment = document.createDocumentFragment();
    /** @type {Array<HTMLElement>} <mark> elements created for this node */
    var nodeMarks = [];
    /** @type {number} Last character offset processed (tracks progress through text) */
    var lastIndex = 0;

    nodeMatches
      .filter(function (m) { return isValidMatch(m, text.length); })
      .sort(function (a, b) { return a.start - b.start; })
      .forEach(function (m) {
        // Skip overlapping matches
        if (m.start < lastIndex) return;
        // Insert plain text between last match end and this match start
        if (m.start > lastIndex) {
          fragment.appendChild(document.createTextNode(text.substring(lastIndex, m.start)));
        }
        // Create and insert the highlight <mark>
        var mark = createHighlightMark(text.substring(m.start, m.end));
        fragment.appendChild(mark);
        nodeMarks.push(mark);
        marks.push(mark);
        lastIndex = m.end;
      });

    // If no valid matches survived filtering, don't modify the DOM
    if (nodeMarks.length === 0) return;

    // Append trailing text after the last match
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
    }

    // Replace the original text node with the assembled fragment
    try {
      parent.replaceChild(fragment, textNode);
      handles.push({ parent: parent, marks: nodeMarks });
    } catch (e) {
      // Node may have been removed by another process between indexing and rendering
    }
  }

  /**
   * Create a single `<mark>` element with inline layout guard styles.
   *
   * Some real pages use high-specificity or later-loaded `<mark>` CSS
   * that forces highlights into block layout.  Inline `!important`
   * styles keep matches sized to the keyword instead of the full line.
   *
   * The element is configured with:
   * - `class="regex-rabbit-highlight"` — for CSS styling from `style.css`
   * - `data-regexRabbitHighlight="true"` — for identification by `removeHighlights()`
   * - Inline `!important` layout guard styles — from `HIGHLIGHT_LAYOUT_STYLES`
   *
   * @param {string} text — the matched text to display inside the `<mark>`
   * @returns {HTMLElement} the configured `<mark>` element
   */
  function createHighlightMark(text) {
    var mark = document.createElement("mark");
    mark.className = HIGHLIGHT_CLASS;
    mark.dataset[HIGHLIGHT_ATTR] = "true";
    mark.textContent = text;
    applyHighlightLayoutGuard(mark);
    return mark;
  }

  /**
   * Apply the `HIGHLIGHT_LAYOUT_STYLES` guard to a `<mark>` element.
   *
   * Each style is set with `!important` priority via
   * `mark.style.setProperty(prop, value, "important")` to override
   * any page CSS that might force `<mark>` into block layout.
   *
   * @param {HTMLElement} mark — the highlight element to guard
   */
  function applyHighlightLayoutGuard(mark) {
    for (var i = 0; i < HIGHLIGHT_LAYOUT_STYLES.length; i++) {
      mark.style.setProperty(
        HIGHLIGHT_LAYOUT_STYLES[i][0],
        HIGHLIGHT_LAYOUT_STYLES[i][1],
        "important"
      );
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  /**
   * Remove all highlight `<mark>` elements created by `renderMatches`,
   * restoring the original text nodes and normalizing the parent.
   *
   * Only removes `<mark>` elements that have `data-regexRabbitHighlight="true"`,
   * so page-owned `<mark>` elements are preserved.
   *
   * Processing order: handles are processed in reverse order (last rendered
   * first removed) to correctly restore the DOM structure.
   *
   * After removing all marks from a parent, `parent.normalize()` is called
   * to merge adjacent text nodes that were split during rendering.
   *
   * @param {Array<{parent:Element,marks:Array<HTMLElement>}>} handles
   *   Cleanup handles from `renderMatches` or `renderMatchesBatched`.
   *   Each handle groups the `<mark>` elements that share a parent.
   */
  function removeHighlights(handles) {
    for (var i = handles.length - 1; i >= 0; i--) {
      var handle = handles[i];
      if (!handle || !handle.parent || !handle.parent.isConnected) continue;

      for (var j = 0; j < handle.marks.length; j++) {
        var mark = handle.marks[j];
        if (!mark || !mark.isConnected || mark.dataset[HIGHLIGHT_ATTR] !== "true") continue;
        try {
          mark.replaceWith(document.createTextNode(mark.textContent));
        } catch (e) {
          // Mark may have already been removed by another process
        }
      }

      try {
        handle.parent.normalize();
      } catch (e) {
        // Parent may have been removed from the DOM
      }
    }
  }

  // ── Validation ─────────────────────────────────────────────────────────────

  /**
   * Validate that a match range is within bounds of the text.
   *
   * A valid match must have:
   * - `start` and `end` are integers
   * - `start >= 0`
   * - `end > start` (zero-length matches are rejected)
   * - `end <= textLength` (match must not extend past the text)
   *
   * @param {{start:number,end:number}} match — the match object to validate
   * @param {number} textLength — length of the text node's content
   * @returns {boolean} `true` if the match is valid and within bounds
   */
  function isValidMatch(match, textLength) {
    return (
      Number.isInteger(match.start) &&
      Number.isInteger(match.end) &&
      match.start >= 0 &&
      match.end > match.start &&
      match.end <= textLength
    );
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  /**
   * Yield control so large pages can paint and process input while rendering.
   *
   * Uses `scheduler.yield()` (Chromium scheduling API) when available,
   * falls back to `requestIdleCallback` with a 50ms timeout, then to
   * `setTimeout(resolve, 0)` in environments without either.
   *
   * @returns {Promise<void>} Resolves when the main thread is available again.
   */
  function yieldToMainThread() {
    if (typeof scheduler !== "undefined" && scheduler.yield) {
      return scheduler.yield().catch(function () {});
    }
    return new Promise(function (resolve) {
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(function () { resolve(); }, { timeout: 50 });
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  /**
   * Get the current high-resolution timestamp.
   *
   * Uses `performance.now()` when available (browser main thread,
   * Worker), falls back to `Date.now()` (Node.js test environment).
   *
   * @returns {number} Timestamp in milliseconds.
   */
  function now() {
    if (typeof performance !== "undefined" && performance.now) {
      return performance.now();
    }
    return Date.now();
  }

  // ── Module export ──────────────────────────────────────────────────────────

  /**
   * Global export for the highlight renderer.
   *
   * Other modules access this as `RRHighlightEngine` (set on
   * `globalThis` because content scripts are classic scripts, not
   * ES modules).
   *
   * @type {{renderMatches: Function, renderMatchesBatched: Function, removeHighlights: Function}}
   */
  globalThis.RRHighlightEngine = {
    renderMatches: renderMatches,
    renderMatchesBatched: renderMatchesBatched,
    removeHighlights: removeHighlights
  };
})();