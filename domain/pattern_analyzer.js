/**
 * @file domain/pattern_analyzer.js
 * @description Bounded input validation and conservative regex risk screening.
 *
 * The structural rules are heuristics, not a proof of execution safety. Matching
 * must run in a disposable Worker with an external timeout: RegExp.exec cannot
 * be interrupted by a timer in the same JavaScript execution context.
 */
(function () {
  "use strict";
  var MAX_RULE_ID_CHARS = 128;
  var MAX_RULE_REASON_CHARS = 1024;
  var POLICY = globalThis.RRRuntimePolicy;

  var MAX_PATTERN_LENGTH = POLICY.search.maxPatternChars;
  var MAX_MAIN_THREAD_PATTERN_LENGTH = 8192;
  var MAX_RULE_SOURCE_LENGTH = 512;
  var MAX_RULES = 128;
  var regexpSource = Object.getOwnPropertyDescriptor(RegExp.prototype, "source").get;
  var regexpTest = RegExp.prototype.test;
  var flagProperties = ["hasIndices", "global", "ignoreCase", "multiline", "dotAll", "unicode", "unicodeSets", "sticky"];
  var flagLetters = "dgimsuvy";
  var flagGetters = flagProperties.map(function (property) {
    var descriptor = Object.getOwnPropertyDescriptor(RegExp.prototype, property);
    return descriptor && descriptor.get;
  });

  function nativeFlags(pattern) {
    var flags = "";
    for (var i = 0; i < flagGetters.length; i++) {
      if (flagGetters[i] && flagGetters[i].call(pattern)) flags += flagLetters[i];
    }
    return flags;
  }

  function isHexDigit(character) {
    return character >= "0" && character <= "9" ||
      character >= "a" && character <= "f" || character >= "A" && character <= "F";
  }

  // A custom rule is executed on the main thread. Unlike the heuristic search
  // policy, this grammar must exclude every repetition and branching construct.
  // Each permitted atom consumes at most one code point; anchors/boundaries only
  // inspect a position. Source length is bounded, and no permitted construct
  // creates repetition or branch choices. Advanced Unicode sets/properties are
  // excluded, including string-valued character classes.
  function isBoundedRule(source, flags) {
    if (source.length > MAX_RULE_SOURCE_LENGTH || flags.indexOf("v") !== -1) return false;
    var inClass = false;
    for (var i = 0; i < source.length; i++) {
      var character = source[i];
      if (character === "\\") {
        var escaped = source[++i];
        if (!escaped) return false;
        if (".^$*+?()[]{}|\\/-".indexOf(escaped) !== -1 || "dDsSwWbBfnrtv".indexOf(escaped) !== -1) continue;
        if (escaped === "x" || escaped === "u") {
          var digits = escaped === "x" ? 2 : 4;
          for (var j = 0; j < digits; j++) if (!isHexDigit(source[++i])) return false;
          continue;
        }
        if (escaped === "c") {
          var control = source[++i];
          if (control >= "a" && control <= "z" || control >= "A" && control <= "Z") continue;
        }
        // This rejects backreferences, octal/identity escapes, property escapes,
        // braced Unicode escapes, and any future escape with unknown semantics.
        return false;
      }
      if (inClass) {
        if (character === "]") inClass = false;
        continue;
      }
      if (character === "[") { inClass = true; continue; }
      if ("()*+?{}|".indexOf(character) !== -1) return false;
    }
    return !inClass;
  }

  // Keep the public rule metadata for compatibility; built-ins are evaluated by
  // a single linear structural scan rather than six backtracking regex scans.
  var rules = [
    { id: "nested-quantifier", pattern: /\([^)]*[+*][^)]*\)[+*{]/,
      reason: "Nested quantifiers can cause catastrophic backtracking." },
    { id: "nested-quantifier-noncapture", pattern: /\(\?:[^)]*[+*][^)]*\)[+*{]/,
      reason: "Nested quantifiers (non-capturing) can cause catastrophic backtracking." },
    { id: "alternation-quantifier", pattern: /\([^)]*\|[^)]*\)[+*{]/,
      reason: "Alternation with quantifier can cause catastrophic backtracking." },
    { id: "repeated-wildcard", pattern: /\(\.\*\)[+*{]/,
      reason: "Repeated wildcard group with quantifier can cause catastrophic backtracking." },
    { id: "exponential-backtracking", pattern: /\([^)]+\+\)\+/,
      reason: "Exponential backtracking pattern (quantifier inside group with quantifier)." },
    { id: "deep-nested-quantifier", pattern: /\(\([^)]*\)[^)]*\)[+*{]/,
      reason: "Deeply nested quantifiers can cause catastrophic backtracking." }
  ];
  var builtinCount = rules.length;

  function result(ok, status, reasons, errorCode, mode) {
    return { ok: ok, status: status, reasons: reasons, errorCode: errorCode, mode: mode };
  }

  function invalid(reason, mode) {
    return result(false, "invalid", [reason], POLICY.errors.invalidPattern, mode);
  }

  // Skip an escaped atom without mistaking its body for grouping syntax.
  function skipEscape(pattern, index, unicode) {
    var next = pattern[index + 1];
    var start = index + 2;
    if (unicode && next === "u" && pattern[start] === "{") {
      // Syntax validation guarantees a closing brace for Unicode code points.
      return pattern.indexOf("}", start + 1) + 1;
    }
    return start;
  }

  function scanStructure(pattern, flags) {
    var found = Object.create(null);
    var stack = [];
    var plainAtom = { wildcard: false };
    var wildcardAtom = { wildcard: true };
    var atom = null;
    var unicodeSets = flags.indexOf("v") !== -1;
    var unicode = unicodeSets || flags.indexOf("u") !== -1;
    for (var i = 0; i < pattern.length;) {
      var ch = pattern[i];
      var group = stack[stack.length - 1];
      if (ch === "\\") {
        i = skipEscape(pattern, i, unicode);
        atom = plainAtom;
        continue;
      }
      if (ch === "[") {
        var depth = 1;
        for (i += 1; i < pattern.length && depth > 0; i++) {
          if (pattern[i] === "\\") { i = skipEscape(pattern, i, unicode) - 1; continue; }
          if (unicodeSets && pattern[i] === "[") depth += 1;
          if (pattern[i] === "]") depth -= 1;
        }
        atom = plainAtom;
        continue;
      }
      if (ch === "(") {
        var newGroup = { noncapture: pattern.slice(i, i + 3) === "(?:",
          quantifier: false, plus: false, alternation: false,
          wildcardStar: false, repeatedGroup: false };
        stack.push(newGroup);
        atom = null;
        i += 1;
        // Group modifiers and names are syntax, not atoms or quantifiers.
        if (pattern[i] === "?") {
          if (pattern[i + 1] === "<" && pattern[i + 2] !== "=" && pattern[i + 2] !== "!") {
            var nameEnd = pattern.indexOf(">", i + 2);
            if (nameEnd !== -1) i = nameEnd + 1;
          } else if (pattern[i + 1] === "<") i += 3;
          else i += 2;
        }
        continue;
      }
      if (ch === ")") {
        var closed = stack.pop();
        var parent = stack[stack.length - 1];
        if (closed && parent) {
          parent.quantifier = parent.quantifier || closed.quantifier;
          parent.alternation = parent.alternation || closed.alternation;
          parent.plus = parent.plus || closed.plus;
          parent.wildcardStar = parent.wildcardStar || closed.wildcardStar;
          parent.repeatedGroup = parent.repeatedGroup || closed.repeatedGroup;
        }
        atom = closed ? { group: closed } : null;
        i += 1;
        continue;
      }
      if (ch === "|") {
        if (group) group.alternation = true;
        atom = null;
        i += 1;
        continue;
      }

      var repeated = ch === "+" || ch === "*";
      var variable = repeated || ch === "?";
      var quantifierEnd = i + 1;
      if (ch === "{") {
        // Inspect only a possible numeric quantifier. Searching for every next
        // '}' would rescan long runs of literal '{' quadratically in legacy mode.
        var braceEnd = i + 1;
        while (pattern[braceEnd] >= "0" && pattern[braceEnd] <= "9") braceEnd += 1;
        if (braceEnd > i + 1) {
          if (pattern[braceEnd] === ",") {
            braceEnd += 1;
            while (pattern[braceEnd] >= "0" && pattern[braceEnd] <= "9") braceEnd += 1;
          }
          if (pattern[braceEnd] === "}") {
            var count = pattern.slice(i + 1, braceEnd);
            var comma = count.indexOf(",");
            var maximum = comma === -1 ? Number(count) : Number(count.slice(comma + 1));
            repeated = comma !== -1 && comma === count.length - 1 || maximum > 1;
            variable = comma !== -1 && (comma === count.length - 1 || maximum > Number(count.slice(0, comma)));
            quantifierEnd = braceEnd + 1;
          }
        }
      }
      if ((repeated || ch === "?" || quantifierEnd > i + 1) && atom) {
        var inner = atom.group;
        if (repeated && inner) {
          if (inner.quantifier) found["nested-quantifier"] = true;
          if (inner.quantifier && inner.noncapture) found["nested-quantifier-noncapture"] = true;
          if (inner.alternation) found["alternation-quantifier"] = true;
          if (inner.wildcardStar) found["repeated-wildcard"] = true;
          if (inner.plus && ch === "+") found["exponential-backtracking"] = true;
          if (inner.repeatedGroup) found["deep-nested-quantifier"] = true;
        }
        if (group) {
          group.quantifier = group.quantifier || variable;
          group.plus = group.plus || ch === "+";
          group.wildcardStar = group.wildcardStar || ch === "*" && atom.wildcard;
          group.repeatedGroup = group.repeatedGroup || !!inner && variable;
        }
        atom = null; // A following '?' changes greediness; it is not another atom.
        i = quantifierEnd;
        continue;
      }
      if (ch === "?" || quantifierEnd > i + 1) {
        atom = null;
        i = quantifierEnd;
        continue;
      }
      atom = ch === "^" || ch === "$" ? null : ch === "." ? wildcardAtom : plainAtom;
      i += 1;
    }
    return found;
  }

  /**
   * @typedef {{ok:boolean,status:string,reasons:string[],errorCode:number|null,mode:string}} PolicyResult
   * @param {string} pattern
   * @param {string} [flags=""]
   * @param {{mode?:"regex"|"literal"}} [options]
   * @returns {PolicyResult}
   */
  function analyzeInput(pattern, flags, options, inWorker) {
    var mode = "regex";
    var isLong = false;
    try {
      if (options !== undefined) {
        if (!options || typeof options !== "object" || Array.isArray(options)) {
          return invalid("Search options must be an object.", mode);
        }
        var requestedMode = options.mode;
        if (requestedMode !== undefined) mode = requestedMode;
        if (mode !== "regex" && mode !== "literal") {
          return invalid("Search mode must be regex or literal.", "regex");
        }
      }
      if (typeof pattern !== "string") return invalid("Pattern must be a string.", mode);
      if (pattern.length > MAX_PATTERN_LENGTH) {
        return invalid("Pattern exceeds the " + MAX_PATTERN_LENGTH + " character limit.", mode);
      }
      isLong = pattern.length > MAX_MAIN_THREAD_PATTERN_LENGTH;
      if (flags === undefined) flags = "";
      if (typeof flags !== "string" || flags.length > flagLetters.length || /[^dgimsuvy]/.test(flags)) {
        return invalid("Flags must contain supported regular expression flags.", mode);
      }
      var seen = Object.create(null);
      for (var f = 0; f < flags.length; f++) {
        if (seen[flags[f]]) return invalid("Duplicate regular expression flag: " + flags[f], mode);
        seen[flags[f]] = true;
      }
      // For long sources on the page, compile only an empty expression to check
      // native flags. Both syntax compilation and structural screening must run
      // inside the disposable Worker, where the external watchdog can stop them.
      try { new RegExp(mode === "literal" || isLong && !inWorker ? "" : pattern, flags); }
      catch (syntaxError) {
        var message = syntaxError.message;
        // Some engines include the complete source in a compile error. Never
        // forward a multi-megabyte error through the extension message channel.
        if (typeof message !== "string") message = "Invalid regular expression.";
        if (message.length > POLICY.diagnostics.maxMessageChars) message = "Regular expression could not be compiled: " + message.slice(-POLICY.diagnostics.messageTailChars);
        return invalid(message, mode);
      }
    } catch (e) {
      return invalid("Invalid search input.", mode);
    }

    if (mode === "literal") return result(true, "safe", [], null, mode);
    if (isLong && !inWorker) return result(true, "deferred", [], null, mode);

    var structure = scanStructure(pattern, flags);
    var reasons = [];
    for (var i = 0; i < rules.length; i++) {
      if (i < builtinCount ? structure[rules[i].id] : regexpTest.call(rules[i].pattern, pattern)) {
        reasons.push(rules[i].reason);
      }
    }
    return reasons.length ? result(false, "unsafe", reasons, POLICY.errors.unsafePattern, mode) : result(true, "safe", [], null, mode);
  }

  function analyze(pattern, flags, options) {
    return analyzeInput(pattern, flags, options, false);
  }

  // Call this entry point only inside an externally terminable Worker. A timer
  // in the same context cannot interrupt native compilation or custom rules.
  function analyzeInWorker(pattern, flags, options) {
    return analyzeInput(pattern, flags, options, true);
  }

  function addRule(rule) {
    try {
      if (!rule || typeof rule !== "object" || rules.length >= MAX_RULES) return false;
      var id = rule.id;
      var reason = rule.reason;
      var pattern = rule.pattern;
      if (typeof id !== "string" || !id.trim() || id.length > MAX_RULE_ID_CHARS) return false;
      if (typeof reason !== "string" || !reason.trim() || reason.length > MAX_RULE_REASON_CHARS) return false;
      // Native getters validate RegExp identity and ignore overridden .source/.flags.
      var source = regexpSource.call(pattern);
      var flags = nativeFlags(pattern).replace(/[gy]/g, "");
      if (!isBoundedRule(source, flags)) return false;
      for (var i = 0; i < rules.length; i++) if (rules[i].id === id) return false;
      rules.push({ id: id, reason: reason, pattern: new RegExp(source, flags) });
      return true;
    } catch (e) { return false; }
  }

  var analyzer = { analyze: analyze, analyzeInWorker: analyzeInWorker, addRule: addRule,
    MAX_PATTERN_LENGTH: MAX_PATTERN_LENGTH, MAX_MAIN_THREAD_PATTERN_LENGTH: MAX_MAIN_THREAD_PATTERN_LENGTH,
    MAX_RULE_SOURCE_LENGTH: MAX_RULE_SOURCE_LENGTH };
  Object.defineProperty(analyzer, "UNSAFE_RULES", {
    enumerable: true,
    get: function () {
      return Object.freeze(rules.map(function (rule) {
        return Object.freeze({ id: rule.id, reason: rule.reason,
          pattern: new RegExp(regexpSource.call(rule.pattern), nativeFlags(rule.pattern)) });
      }));
    }
  });
  globalThis.RRPatternAnalyzer = analyzer;
})();
