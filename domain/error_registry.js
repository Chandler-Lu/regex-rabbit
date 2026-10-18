/**
 * @file domain/error_registry.js
 * @description Error code registry with bidirectional lookup.
 *
 * HTTP-style numeric table:
 *   4xx — syntax, safety or native browser capacity errors
 *   5xx — system-side errors (extension issue)
 *   0   — not an error (cancellation)
 */
(function () {
  "use strict";
  var POLICY = globalThis.RRRuntimePolicy;

  var codes = [
    { slug: "pattern-invalid-syntax", code: POLICY.errors.invalidPattern, message: "Invalid regular expression syntax.",
      messageKey: "error.invalidSyntax.title", detailKey: "error.invalidSyntax.detail",
      detail: "Check parentheses and escapes, or use plain text." },
    { slug: "engine-pattern-too-large", code: POLICY.errors.patternTooLarge, message: "The regular expression is too large for the browser engine.",
      messageKey: "status.queryEngineLimit", detailKey: "status.queryEngineHint",
      detail: "Use text search or simplify the regular expression." },
    { slug: "engine-text-too-large", code: POLICY.errors.textTooLarge, message: "The text is too large for the browser engine.",
      messageKey: "status.textEngineLimit", detailKey: "status.textEngineHint",
      detail: "Use text search or search a selection." },
    { slug: "pattern-unsafe-blocked", code: POLICY.errors.unsafePattern, message: "Unsafe pattern blocked.",
      messageKey: "error.unsafeBlocked.title", detailKey: "error.unsafeBlocked.detail",
      detail: "This expression can take too long to match. Simplify it or use plain text." },
    { slug: "engine-unsafe-fallback-blocked", code: POLICY.errors.unsafeEngine, message: "Unsafe pattern blocked from ECMAScript engine.",
      messageKey: "error.unsafeFallback.title", detailKey: "error.unsafeFallback.detail",
      detail: "The safe engine cannot run this expression. Simplify it or use plain text." },
    { slug: "worker-crashed", code: POLICY.errors.workerUnavailable, message: "Search worker crashed.",
      messageKey: "error.workerCrashed.title", detailKey: "error.workerCrashed.detail",
      detail: "The search worker stopped. Try again or reload the page." },
    { slug: "search-timeout", code: POLICY.errors.timeout, message: "Search timed out.",
      messageKey: "error.timeout.title", detailKey: "error.timeout.detail",
      detail: "The search time limit was reached. Narrow the scope or simplify the query." },
    { slug: "worker-protocol-error", code: POLICY.errors.protocol, message: "Worker protocol error.",
      messageKey: "error.workerProtocol.title", detailKey: "error.workerProtocol.detail",
      detail: "The search worker returned invalid data. Reload the page and try again." },
    { slug: "worker-spawn-failed", code: POLICY.errors.workerStartup, message: "Failed to create search worker.",
      messageKey: "error.workerSpawn.title", detailKey: "error.workerSpawn.detail",
      detail: "The search worker could not start. Reload the extension and page, then try again." }
  ];

  var bySlug = Object.create(null);
  var byCode = Object.create(null);
  for (var i = 0; i < codes.length; i++) {
    Object.freeze(codes[i]);
    bySlug[codes[i].slug] = codes[i];
    byCode[codes[i].code] = codes[i];
  }
  Object.freeze(codes);
  Object.freeze(bySlug);
  Object.freeze(byCode);

  function textFor(slug, field, translate) {
    var entry = typeof slug === "string" ? bySlug[slug] : null;
    if (!entry) return "";
    var fallback = entry[field];
    var key = entry[field === "message" ? "messageKey" : "detailKey"];
    if (typeof translate === "function") {
      try {
        var translated = translate(key);
        if (typeof translated === "string" && translated && translated !== key) return translated;
      } catch (_error) { /* A missing or broken translator must not hide an error. */ }
    }
    return fallback;
  }

  globalThis.RRErrorRegistry = {
    codes: codes,
    bySlug: bySlug,
    byCode: byCode,
    codeFor: function (slug) { return typeof slug === "string" && bySlug[slug] ? bySlug[slug].code : null; },
    slugFor: function (code) { return typeof code === "number" && Number.isSafeInteger(code) && byCode[code] ? byCode[code].slug : null; },
    messageFor: function (slug, translate) { return textFor(slug, "message", translate); },
    detailFor: function (slug, translate) { return textFor(slug, "detail", translate); }
  };
})();
