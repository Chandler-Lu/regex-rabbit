/**
 * @file domain/display_formatter.js
 * @description Converts search state to UI display strings.
 *
 * Pure function — no dependencies on DOM, chrome.*, or Worker.
 */
(function () {
  "use strict";

  var STATUS_LABELS = {
    idle: "", empty: "", invalid: "Invalid Regex", unsafe: "Unsafe Regex",
    searching: "Searching", rendering: "Rendering",
    done: "", limited: "Limited", timeout: "Timeout",
    error: "Search Error", cancelled: "Cancelled", stale: "Page Changed"
  };

  var TRANSIENT = { searching: true, rendering: true };

  var ERROR_STATUSES = { invalid: true, unsafe: true, timeout: true, error: true };

  function format(state) {
    state = state || {};
    var isError = !!ERROR_STATUSES[state.status];

    // Count string
    var total = state.totalMatches || state.renderedMatches || 0;
    var count = "";
    if (total > 0) {
      var cur = state.currentIndex >= 0 ? state.currentIndex + 1 : 0;
      count = cur + " / " + total + (state.limited ? "+" : "");
    }

    // Status label
    var label = TRANSIENT[state.status] && state.message ? state.message : (STATUS_LABELS[state.status] || "");

    // Detail
    var detail = state.detail || "";
    if (!detail && state.status === "limited" && state.renderedMatches) {
      detail = "Showing " + state.renderedMatches + " highlights. Increase limit for more.";
    }
    if (!detail && state.engine) {
      detail = "Engine: " + state.engine;
    }

    // Error code badge
    var codeBadge = "";
    if (isError && state.errorCode) {
      codeBadge = "RR" + state.errorCode;
      if (state.errorSlug) codeBadge += " " + state.errorSlug;
    }

    return { count: count, status: label, detail: detail, code: codeBadge, isError: isError };
  }

  globalThis.RRDisplayFormatter = { format: format };
})();
