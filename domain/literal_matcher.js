/** Exact fixed-string matching, including native Unicode case equivalence. */
(function () {
  "use strict";
  var DENSE_ASCII_WINDOW_CHARS = 16384;
  var MATCH_CHECK_INTERVAL = 16384; // Power of two for hot-loop cancellation checks.
  var ASCII_LIMIT = 128;
  var ASCII_UPPER_A = 65, ASCII_UPPER_Z = 90, ASCII_CASE_OFFSET = 32;

  var CACHE_LIMIT = 4096;
  // These select equivalent execution methods; they never limit search scope.
  // Longer native atoms can repeatedly compare almost an entire needle.
  var NATIVE_LITERAL_LENGTH = 64;
  var ANCHOR_LENGTH = 32;
  var MAX_FAILED_ANCHORS = 2;
  var NON_ASCII = /[^\x00-\x7f]/;
  var ESCAPE_LITERAL = /[\\^$.*+?()[\]{}|]/g;

  function advance(text, index, unicode) {
    return index + (unicode && text.codePointAt(index) > 0xFFFF ? 2 : 1);
  }
  function splitsSurrogate(text, index) {
    var before = text.charCodeAt(index - 1), after = text.charCodeAt(index);
    return before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF;
  }
  function chooseAnchor(needle) {
    var last = Math.max(0, needle.length - ANCHOR_LENGTH);
    var offsets = [0, Math.floor(last / 2), last], best = 0, diversity = -1;
    for (var index = 0; index < offsets.length; index++) {
      var characters = new Set();
      for (var offset = offsets[index]; offset < Math.min(needle.length, offsets[index] + ANCHOR_LENGTH); offset++) {
        characters.add(needle.charCodeAt(offset));
      }
      if (characters.size > diversity) {
        diversity = characters.size;
        best = offsets[index];
      }
    }
    return { offset: best, text: needle.slice(best, best + ANCHOR_LENGTH) };
  }
  function asciiValue(value, ignoreCase) {
    return ignoreCase && value >= ASCII_UPPER_A && value <= ASCII_UPPER_Z ? value + ASCII_CASE_OFFSET : value;
  }
  function scanDenseAscii(text, from, value, ignoreCase, visit, checkTime) {
    // Use scalar scanning only for a short prefix after adjacent one-character
    // matches. Resume native search afterwards so sparse tails remain fast.
    var end = Math.min(text.length, from + DENSE_ASCII_WINDOW_CHARS);
    for (var offset = from; offset < end; offset++) {
      if (checkTime && !checkTime()) return -1;
      var point = text.charCodeAt(offset);
      if (point >= ASCII_LIMIT) return offset;
      if (asciiValue(point, ignoreCase) === value && visit(offset, offset + 1) === "stop") return -1;
    }
    return end;
  }
  function oneCodePoint(text) {
    return text.length === 1 || text.length === 2 && text.codePointAt(0) > 0xFFFF;
  }
  function canonicalizer(ignoreCase, unicode) {
    if (!ignoreCase) return function (value) { return value; };
    if (!unicode) return function (value) {
      var upper = String.fromCharCode(value).toUpperCase();
      // ECMA-262 Canonicalize deliberately excludes non-ASCII -> ASCII folds
      // in legacy mode and every expanding uppercase conversion.
      return upper.length !== 1 || value >= ASCII_LIMIT && upper.charCodeAt(0) < ASCII_LIMIT ? value : upper.charCodeAt(0);
    };
    var cache = new Map();
    function remember(value, canonical) {
      if (cache.size >= CACHE_LIMIT) cache.clear();
      cache.set(value, canonical);
      return canonical;
    }
    return function (value) {
      if (value < ASCII_LIMIT) return value >= ASCII_UPPER_A && value <= ASCII_UPPER_Z ? value + ASCII_CASE_OFFSET : value;
      if (cache.has(value)) return cache.get(value);
      var original = String.fromCodePoint(value);
      var exceptional = value === 0x1FD3 ? 0x0390 : value === 0x1FE3 ? 0x03B0 : value === 0xFB05 ? 0xFB06 : -1;
      // Most Unicode text (including CJK and emoji) has no case conversion.
      // Avoid a native oracle; remember the numeric identity in the same bounded
      // cache so repeated long non-Latin needles do not redo string conversions.
      if (exceptional === -1 && original.toUpperCase() === original && original.toLowerCase() === original) return remember(value, value);
      var oracle = new RegExp("^(?:" + original.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&") + ")$", "iu");
      var visited = [], current = original;
      // These simple folds have expanding full uppercase/lowercase mappings,
      // so the single-code-point conversion graph cannot connect the pair.
      // Native validation keeps the table compatible with the engine's data.
      if (exceptional !== -1 && oracle.test(String.fromCodePoint(exceptional))) current = String.fromCodePoint(exceptional);
      while (visited.indexOf(current) === -1) {
        visited.push(current);
        var upper = current.toUpperCase();
        if (oneCodePoint(upper) && oracle.test(upper)) current = upper;
        var lower = current.toLowerCase();
        if (oneCodePoint(lower) && oracle.test(lower)) current = lower;
      }
      // Ignore transient characters (e.g. U+0345) before the stable fold cycle.
      var cycleStart = visited.indexOf(current), canonical = current.codePointAt(0);
      for (var index = cycleStart; index < visited.length; index++) canonical = Math.min(canonical, visited[index].codePointAt(0));
      return remember(value, canonical);
    };
  }

  function compileKMP(pattern, flags) {
    var unicode = flags.indexOf("u") !== -1 || flags.indexOf("v") !== -1;
    var sticky = flags.indexOf("y") !== -1;
    var fold = canonicalizer(flags.indexOf("i") !== -1, unicode);
    // Three bounded 32-bit arrays: canonical needle, prefix table and a ring of
    // original UTF-16 positions. Even the maximum 4,096,000-unit needle stays
    // below 47 MiB, with no transformed copy of the searched text.
    var symbols = new Uint32Array(pattern.length), count = 0;
    for (var index = 0; index < pattern.length;) {
      var value = unicode ? pattern.codePointAt(index) : pattern.charCodeAt(index);
      symbols[count++] = fold(value);
      index += unicode && value > 0xFFFF ? 2 : 1;
    }
    var prefix = new Uint32Array(sticky ? 0 : count);
    for (var position = 1, length = 0; !sticky && position < count; position++) {
      while (length > 0 && symbols[position] !== symbols[length]) length = prefix[length - 1];
      if (symbols[position] === symbols[length]) length++;
      prefix[position] = length;
    }
    var starts = new Uint32Array(sticky ? 0 : count);
    return {
      unicode: unicode,
      length: pattern.length,
      scan: function (text, from, visit, checkTime) {
        if (!count) return;
        if (sticky) {
          var cursor = from, steps = 0;
          while (cursor < text.length) {
            var start = cursor;
            for (var part = 0; part < count; part++) {
              if (cursor >= text.length) return;
              var point = unicode ? text.codePointAt(cursor) : text.charCodeAt(cursor);
              if (fold(point) !== symbols[part]) return;
              cursor += unicode && point > 0xFFFF ? 2 : 1;
              if ((++steps & (MATCH_CHECK_INTERVAL - 1)) === 0 && checkTime && !checkTime()) return;
            }
            if (visit(start, cursor) !== "accepted") return;
          }
          return;
        }
        var matched = 0, seen = 0;
        for (var offset = from; offset < text.length;) {
          var value = unicode ? text.codePointAt(offset) : text.charCodeAt(offset);
          var next = offset + (unicode && value > 0xFFFF ? 2 : 1);
          var symbol = fold(value);
          starts[seen % count] = offset;
          seen++;
          while (matched > 0 && symbol !== symbols[matched]) matched = prefix[matched - 1];
          if (symbol === symbols[matched]) matched++;
          if (matched === count) {
            var start = starts[(seen - count) % count];
            var decision = visit(start, next);
            if (decision === "stop") return;
            matched = decision === "accepted" ? 0 : prefix[matched - 1];
          }
          offset = next;
          if ((seen & (MATCH_CHECK_INTERVAL - 1)) === 0 && checkTime && !checkTime()) return;
        }
      }
    };
  }

  function nativeMatcher(pattern, flags, unicode, sticky) {
    var regex = new RegExp(pattern.replace(ESCAPE_LITERAL, "\\$&"), flags.indexOf("g") === -1 ? flags + "g" : flags);
    var fallback = null;
    var ignoreCase = flags.indexOf("i") !== -1;
    var asciiCharacter = pattern.length === 1 && pattern.charCodeAt(0) < ASCII_LIMIT ? asciiValue(pattern.charCodeAt(0), ignoreCase) : -1;
    function linear(text, from, visit, checkTime) {
      if (!fallback) fallback = compileKMP(pattern, flags);
      fallback.scan(text, from, visit, checkTime);
    }
    return {
      unicode: unicode,
      length: pattern.length,
      scan: function (text, from, visit, checkTime) {
        // RegExp may move a Unicode lastIndex backwards into a surrogate pair.
        // Keep the existing scanner's exact starting position in this case.
        if (unicode && splitsSurrogate(text, from)) return linear(text, from, visit, checkTime);
        var cursor = from;
        while (cursor <= text.length) {
          if (checkTime && !checkTime()) return;
          regex.lastIndex = cursor;
          var matched;
          try { matched = regex.exec(text); }
          catch (ignored) { return linear(text, cursor, visit, checkTime); }
          if (!matched) return;
          var start = matched.index, end = start + matched[0].length;
          var decision = visit(start, end);
          if (decision === "stop" || sticky && decision !== "accepted") return;
          cursor = decision === "accepted" ? end : advance(text, start, unicode);
          if (decision === "accepted" && !sticky && asciiCharacter >= 0 && cursor < text.length) {
            var next = text.charCodeAt(cursor);
            if (next < ASCII_LIMIT && asciiValue(next, ignoreCase) === asciiCharacter) {
              cursor = scanDenseAscii(text, cursor, asciiCharacter, ignoreCase, visit, checkTime);
              if (cursor < 0) return;
            }
          }
        }
      }
    };
  }

  function asciiMatcher(pattern, flags, unicode, sticky, ignoreCase) {
    var needle = ignoreCase ? pattern.toLowerCase() : pattern;
    // Prefer a distinctive fixed-size fragment. Equal scores retain the prefix,
    // so repetitive needles do not mistake their own beginning for their tail.
    var selected = chooseAnchor(needle), anchorOffset = selected.offset, anchor = selected.text;
    var fallback = null, linearOnly = false;
    function linear(text, from, visit, checkTime) {
      if (!fallback) fallback = compileKMP(pattern, flags);
      fallback.scan(text, from, visit, checkTime);
    }
    return {
      unicode: unicode,
      length: pattern.length,
      scan: function (text, from, visit, checkTime) {
        if (checkTime && !checkTime()) return;
        // Full lowercasing can expand Unicode characters and change offsets;
        // ASCII windows have identical UTF-16 lengths and native /i semantics.
        if (linearOnly || ignoreCase && NON_ASCII.test(text)) return linear(text, from, visit, checkTime);
        var source = ignoreCase ? text.toLowerCase() : text;
        var cursor = from, failures = 0;
        if (sticky) {
          while (cursor + needle.length <= source.length) {
            if (checkTime && !checkTime() || !source.startsWith(needle, cursor)) return;
            if (visit(cursor, cursor + needle.length) !== "accepted") return;
            cursor += needle.length;
          }
          return;
        }
        while (cursor + needle.length <= source.length) {
          if (checkTime && !checkTime()) return;
          var found = source.indexOf(anchor, cursor + anchorOffset);
          if (found < 0) return;
          var start = found - anchorOffset;
          if (source.startsWith(needle, start)) {
            var decision = visit(start, start + needle.length);
            if (decision === "stop") return;
            if (decision === "accepted") {
              cursor = start + needle.length;
              continue;
            }
          }
          cursor = advance(text, start, unicode);
          // Successful probes advance by the entire needle. Only failed or
          // rejected probes can repeatedly compare overlapping long prefixes.
          // Bound those comparisons, then preserve linear KMP work thereafter.
          if (++failures >= MAX_FAILED_ANCHORS) {
            linearOnly = true;
            return linear(text, cursor, visit, checkTime);
          }
        }
      }
    };
  }

  function compile(pattern, flags) {
    var unicode = flags.indexOf("u") !== -1 || flags.indexOf("v") !== -1;
    var sticky = flags.indexOf("y") !== -1;
    if (!pattern.length) return { unicode: unicode, length: 0, scan: function () {} };
    if (pattern.length <= NATIVE_LITERAL_LENGTH) {
      try { return nativeMatcher(pattern, flags, unicode, sticky); }
      catch (ignored) { return compileKMP(pattern, flags); }
    }
    if (!NON_ASCII.test(pattern)) return asciiMatcher(pattern, flags, unicode, sticky, flags.indexOf("i") !== -1);
    return compileKMP(pattern, flags);
  }

  globalThis.RRLiteralMatcher = { compile: compile, canonicalizer: canonicalizer, CACHE_LIMIT: CACHE_LIMIT };
})();
