/**
 * @file domain/pattern_analyzer.js
 * @description Regex pattern safety analysis.
 *
 * Checks:
 *   1. Syntax validity via RegExp() compilation
 *   2. Unsafe patterns via configurable rule table
 *
 * Returns PolicyResult with structured status and reasons.
 */
(function () {
  "use strict";

  // Configurable unsafe pattern rules
  var UNSAFE_RULES = [
    {
      id: "nested-quantifier",
      pattern: /\([^)]*[+*][^)]*\)[+*{]/,
      reason: "Nested quantifiers can cause catastrophic backtracking."
    },
    {
      id: "nested-quantifier-noncapture",
      pattern: /\(\?:[^)]*[+*][^)]*\)[+*{]/,
      reason: "Nested quantifiers (non-capturing) can cause catastrophic backtracking."
    },
    {
      id: "alternation-quantifier",
      pattern: /\([^)]*\|[^)]*\)[+*{]/,
      reason: "Alternation with quantifier can cause catastrophic backtracking."
    },
    {
      id: "repeated-wildcard",
      pattern: /\(\.\*\)[+*{]/,
      reason: "Repeated wildcard group with quantifier can cause catastrophic backtracking."
    },
    {
      id: "exponential-backtracking",
      pattern: /\([^)]+\+\)\+/,
      reason: "Exponential backtracking pattern (quantifier inside group with quantifier)."
    },
    {
      id: "deep-nested-quantifier",
      pattern: /\(\([^)]*\)[^)]*\)[+*{]/,
      reason: "Deeply nested quantifiers can cause catastrophic backtracking."
    }
  ];

  /**
   * @typedef {{ok:boolean, status:string, reasons:string[], errorCode:number|null}} PolicyResult
   */

  /**
   * Analyze pattern safety.
   * @param {string} pattern
   * @param {string} flags
   * @returns {PolicyResult}
   */
  function analyze(pattern, flags) {
    // 1. Syntax check
    try { new RegExp(pattern, flags); }
    catch (e) {
      return { ok: false, status: "invalid", reasons: [e.message], errorCode: 400 };
    }

    // 2. Unsafe pattern check
    var reasons = [];
    for (var i = 0; i < UNSAFE_RULES.length; i++) {
      if (UNSAFE_RULES[i].pattern.test(pattern)) {
        reasons.push(UNSAFE_RULES[i].reason);
      }
    }

    if (reasons.length > 0) {
      return { ok: false, status: "unsafe", reasons: reasons, errorCode: 451 };
    }

    return { ok: true, status: "safe", reasons: [], errorCode: null };
  }

  globalThis.RRPatternAnalyzer = {
    analyze: analyze,
    UNSAFE_RULES: UNSAFE_RULES,
    addRule: function (rule) {
      if (!rule || typeof rule !== "object") return false;
      if (typeof rule.id !== "string" || !rule.id) return false;
      if (!(rule.pattern instanceof RegExp)) return false;
      if (typeof rule.reason !== "string" || !rule.reason) return false;
      // Avoid duplicate IDs
      for (var i = 0; i < UNSAFE_RULES.length; i++) {
        if (UNSAFE_RULES[i].id === rule.id) return false;
      }
      UNSAFE_RULES.push(rule);
      return true;
    }
  };
})();
