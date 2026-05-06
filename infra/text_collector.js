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

  /**
   * Element selectors whose text content should be excluded.
   */
  var EXCLUDE_SELECTOR = 'script, style, noscript, textarea, #regex-search-container, [contenteditable="true"]';

  /**
   * Collect all visible text nodes from the document body.
   * @returns {Array<{id:number, node:Text, text:string}>}
   */
  function collect() {
    var nodes = [];
    var id = 0;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var parent = node.parentElement;
        if (!parent || parent.closest(EXCLUDE_SELECTOR)) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var n;
    while ((n = walker.nextNode())) {
      nodes.push({ id: id++, node: n, text: n.nodeValue });
    }
    return nodes;
  }

  globalThis.RRTextCollector = { collect: collect };
})();
