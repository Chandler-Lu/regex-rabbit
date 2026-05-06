/**
 * @file domain/error_registry.js
 * @description Error code registry with bidirectional lookup.
 *
 * HTTP-style numeric table:
 *   4xx — pattern-side errors (user can fix)
 *   5xx — system-side errors (extension issue)
 *   0   — not an error (cancellation)
 */
(function () {
  "use strict";

  var codes = [
    { slug: "pattern-invalid-syntax",       code: 400, message: "Invalid regular expression syntax." },
    { slug: "pattern-unsafe-blocked",       code: 451, message: "Unsafe pattern blocked." },
    { slug: "engine-unsafe-fallback-blocked", code: 452, message: "Unsafe pattern blocked from ECMAScript engine." },
    { slug: "worker-crashed",              code: 503, message: "Search worker crashed." },
    { slug: "search-timeout",              code: 504, message: "Search timed out." },
    { slug: "worker-protocol-error",       code: 530, message: "Worker protocol error." },
    { slug: "worker-spawn-failed",         code: 531, message: "Failed to create search worker." }
  ];

  var bySlug = {};
  var byCode = {};
  for (var i = 0; i < codes.length; i++) {
    bySlug[codes[i].slug] = codes[i];
    byCode[codes[i].code] = codes[i];
  }

  globalThis.RRErrorRegistry = {
    codes: codes,
    bySlug: bySlug,
    byCode: byCode,
    codeFor: function (slug) { return bySlug[slug] ? bySlug[slug].code : null; },
    slugFor: function (code) { return byCode[code] ? byCode[code].slug : null; }
  };
})();
