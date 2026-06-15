/**
 * @file infra/text_collector.js
 * @description DOM text node collector.
 *
 * Walks document.body with TreeWalker, filtering out
 * script/style/noscript/textarea/contenteditable elements.
 * Assigns sequential IDs to each collected text node.
 */
(function () {
  "use strict";

  var EXCLUDED_TAGS = {
    SCRIPT: true,
    STYLE: true,
    NOSCRIPT: true,
    TEXTAREA: true
  };

  /**
   * Collect all visible text nodes from the document body.
   * @returns {Array<{id:number, node:Text, text:string}>}
   */
  function collect() {
    var nodes = [];
    var id = 0;
    var walker = createWalker();
    var n;
    while ((n = walker.nextNode())) {
      nodes.push({ id: id++, node: n, text: n.nodeValue });
    }
    return nodes;
  }

  /**
   * Collect text nodes in batches so very large documents do not monopolize
   * the page thread while the search UI is open.
   * @param {{batchSize?:number,budgetMs?:number,shouldContinue?:Function,onBatch?:Function,storeNodes?:boolean}} [options]
   * @returns {Promise<Array<{id:number, node:Text, text:string}>>}
   */
  async function collectBatched(options) {
    var nodes = [];
    var id = 0;
    var batchSize = Math.max(1, (options && options.batchSize) || 500);
    var budgetMs = Math.max(1, (options && options.budgetMs) || 8);
    var shouldContinue = options && options.shouldContinue;
    var onBatch = options && options.onBatch;
    var storeNodes = !options || options.storeNodes !== false;
    var walker = createWalker();
    var batch = [];
    var processed = 0;
    var startedAt = now();
    var n;

    while ((n = walker.nextNode())) {
      if (shouldContinue && !shouldContinue()) return nodes;
      var entry = { id: id++, node: n, text: n.nodeValue };
      if (storeNodes) nodes.push(entry);
      if (onBatch) batch.push(entry);
      processed += 1;
      if (processed % batchSize === 0 || now() - startedAt >= budgetMs) {
        if (batch.length > 0) {
          var keepGoing = await flushBatch(batch, onBatch);
          if (keepGoing === false) return nodes;
        }
        batch = [];
        await yieldToMainThread();
        startedAt = now();
      }
    }
    if (batch.length > 0) await flushBatch(batch, onBatch);
    return nodes;
  }

  async function flushBatch(batch, onBatch) {
    if (!onBatch) return true;
    return await onBatch(batch);
  }

  function createWalker() {
    return document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      { acceptNode: acceptNode }
    );
  }

  function acceptNode(node) {
    if (node.nodeType === 1) {
      return isExcludedElement(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
    }
    if (node.nodeType !== 3) return NodeFilter.FILTER_REJECT;
    if (!node.nodeValue || !hasNonWhitespace(node.nodeValue)) return NodeFilter.FILTER_REJECT;
    return NodeFilter.FILTER_ACCEPT;
  }

  function isExcludedElement(node) {
    if (node.id === "regex-search-container") return true;
    if (EXCLUDED_TAGS[node.tagName]) return true;
    return node.getAttribute && node.getAttribute("contenteditable") === "true";
  }

  function hasNonWhitespace(text) {
    return /\S/.test(text);
  }

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

  function now() {
    if (typeof performance !== "undefined" && performance.now) return performance.now();
    return Date.now();
  }

  globalThis.RRTextCollector = { collect: collect, collectBatched: collectBatched };
})();
