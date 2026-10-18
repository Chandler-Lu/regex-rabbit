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

  var ERROR_DETAILS = {
    invalid: ["display.invalidDetail", "Check parentheses and escapes, or use plain text."],
    unsafe: ["display.unsafeDetail", "This expression can take too long to match. Simplify it or use plain text."],
    timeout: ["display.timeoutDetail", "The search time limit was reached. Narrow the scope or simplify the query."],
    error: ["display.errorDetail", "Try again or reload the extension and page."]
  };

  // Only user-facing query budgets have named limit messages. Legacy or
  // unfamiliar diagnostics must not imply another hidden search quota.
  var LIMIT_FEEDBACK = [
    { reasons: ["duration"], status: "status.timeout", label: "Search timed out",
      detail: "status.timeoutHint", hint: "Narrow the scope or use a more specific query" },
    { reasons: ["max-matches"], status: "status.matchLimit", label: "Match limit",
      detail: "status.limitHint", hint: "Narrow the scope or raise the match limit in settings" },
    { reasons: ["characters", "max-scanned-chars"], status: "status.scanLimit", label: "Scan limit",
      detail: "status.scanBudgetHint", hint: "The scanned-character budget was reached; raise it in settings or narrow the scope" }
  ];
  var PARTIAL_FEEDBACK = {
    status: "status.partialResults", label: "Partial results", detail: "status.partialResultsHint",
    hint: "Some page content was not searched; narrow the scope or try again"
  };
  var MAX_REASON_TEXT = 1024;
  var MAX_REASON_KEY_CHARS = 64;
  var REASON_PRIORITY = Object.create(null);
  LIMIT_FEEDBACK.forEach(function (feedback, priority) {
    feedback.reasons.forEach(function (reason) { REASON_PRIORITY[reason] = priority; });
  });
  Object.freeze(REASON_PRIORITY);

  function own(table, key) {
    return typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
  }
  function countValue(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }
  function text(translate, key, fallback, params) {
    if (typeof translate === "function") {
      try {
        var translated = translate(key, params);
        if (typeof translated === "string" && translated && translated !== key) return translated;
      } catch (_error) { /* Keep a useful fallback when localization fails. */ }
    }
    return fallback;
  }

  function limitFeedback(state, translate) {
    state = state || {};
    // Retain only the best known reason. Unknown diagnostics consume no set
    // entries and cannot hide a meaningful reason later in the input array.
    var priority = LIMIT_FEEDBACK.length;
    function addReason(reason) {
      if (typeof reason !== "string" || reason.length > MAX_REASON_KEY_CHARS) return;
      var candidate = own(REASON_PRIORITY, reason.trim());
      if (candidate !== undefined && candidate < priority) priority = candidate;
    }
    if (typeof state.limitReason === "string" && state.limitReason.length <= MAX_REASON_TEXT) {
      state.limitReason.split(",").forEach(addReason);
    }
    if (state.stats && Array.isArray(state.stats.reasons)) {
      for (var index = 0; index < state.stats.reasons.length && priority > 0; index += 1) {
        addReason(state.stats.reasons[index]);
      }
    }
    var feedback = priority < LIMIT_FEEDBACK.length ? LIMIT_FEEDBACK[priority] : PARTIAL_FEEDBACK;
    var params;
    var hint = feedback.hint;
    if (feedback.detail === "status.scanBudgetHint") {
      var scanned = typeof state.scannedChars === "number" && Number.isSafeInteger(state.scannedChars) && state.scannedChars >= 0 ? state.scannedChars : "?";
      var limit = typeof state.scanLimitChars === "number" && Number.isSafeInteger(state.scanLimitChars) && state.scanLimitChars > 0 ? state.scanLimitChars : "?";
      params = { scanned: scanned, limit: limit };
      if (scanned !== "?" && limit !== "?") hint = scanned + " / " + limit + " characters scanned. Raise the scan budget in settings or narrow the scope";
    }
    return {
      status: text(translate, feedback.status, feedback.label),
      detail: text(translate, feedback.detail, hint, params)
    };
  }

  function format(state, translate) {
    state = state || {};
    var isError = !!own(ERROR_STATUSES, state.status);

    // Count string
    var total = countValue(state.totalMatches) || countValue(state.renderedMatches);
    var count = "";
    var countTitle = "";
    if (total > 0) {
      var cur = Number.isSafeInteger(state.currentIndex) && state.currentIndex >= 0 ? Math.min(total, state.currentIndex + 1) : 0;
      count = cur + " / " + total + (state.limited ? "+" : "");
      countTitle = text(translate, state.limited ? "display.countPositionLimited" : "display.countPosition",
        "Match " + cur + " of " + total + (state.limited ? " or more" : ""), { current: cur, total: total });
    } else if (state.limited) {
      count = "0+";
      countTitle = text(translate, "display.countNoneLimited", "No matches within the scanned area");
    } else if (state.status === "done") {
      countTitle = text(translate, "display.countNone", "No matches");
    }

    // Status label
    var defaultLabel = own(STATUS_LABELS, state.status) || "";
    var label = typeof translate === "function" && defaultLabel ? text(translate, "display." + state.status, defaultLabel) :
      own(TRANSIENT, state.status) && typeof state.message === "string" && state.message ? state.message : defaultLabel;

    // Detail
    var detail = typeof state.detail === "string" ? state.detail : "";
    if (typeof translate === "function" && isError) {
      // Controller detail can contain browser or worker diagnostics in another
      // language. Localized UI uses a stable action rather than that raw text.
      var errorDetail = own(ERROR_DETAILS, state.status);
      detail = text(translate, errorDetail[0], errorDetail[1]);
    }
    if (!detail && state.status === "limited" && state.renderedMatches) {
      var rendered = countValue(state.renderedMatches);
      if (rendered) detail = text(translate, "display.limitDetail",
        "Showing " + rendered + " highlights. Increase limit for more.", { count: rendered });
    }
    if (!detail && typeof state.engine === "string" && state.engine) {
      detail = text(translate, "display.engineDetail", "Engine: " + state.engine, { engine: state.engine });
    }

    // Error code badge
    var codeBadge = "";
    if (isError && Number.isSafeInteger(state.errorCode) && state.errorCode > 0) {
      codeBadge = "RR" + state.errorCode;
      if (typeof state.errorSlug === "string" && state.errorSlug) codeBadge += " " + state.errorSlug;
    }

    return { count: count, countTitle: countTitle, status: label, detail: detail, code: codeBadge, isError: isError };
  }

  globalThis.RRDisplayFormatter = { format: format, limitFeedback: limitFeedback };
})();
