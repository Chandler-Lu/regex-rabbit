/**
 * Shared runtime contracts. Counts of text characters use UTF-16 code units.
 *
 * search: public query/settings bounds; these may end a search with feedback.
 * transport: per-message buffers and connection cleanup; never text coverage.
 * text/scheduling: resumable work sizes; exhausting a slice must not drop work.
 */
(function () {
  "use strict";

  var KIB = 1024;
  var MIB = KIB * KIB;
  var SECOND_MS = 1000;
  var MINUTE_MS = 60 * SECOND_MS;
  var search = Object.freeze({
    maxPatternChars: 4096000,
    defaultMatches: 9999,
    maxWorkerMatches: 100000,
    defaultScannedChars: 32000 * MIB,
    maxScannedChars: 64000 * MIB,
    defaultTimeoutMs: 5 * SECOND_MS,
    maxTimeoutMs: 15 * MINUTE_MS
  });

  globalThis.RRRuntimePolicy = Object.freeze({
    units: Object.freeze({ kib: KIB, mib: MIB, secondMs: SECOND_MS, minuteMs: MINUTE_MS }),
    search: search,
    // The settings UI intentionally offers a smaller match range than the
    // standalone Worker API. Both ranges are explicit, not transport cutoffs.
    settings: Object.freeze({
      numericRanges: Object.freeze({
        scale: Object.freeze({ min: 0.5, max: 2.5, integer: false }),
        maxMatches: Object.freeze({ min: 100, max: 20000, integer: true }),
        autoSearchDebounce: Object.freeze({ min: 500, max: 5000, integer: true }),
        workerTimeoutMs: Object.freeze({ min: 500, max: search.maxTimeoutMs, integer: true }),
        maxScannedChars: Object.freeze({ min: KIB, max: search.maxScannedChars, integer: true })
      })
    }),
    errors: Object.freeze({
      cancelled: 0, invalidPattern: 400, patternTooLarge: 413, textTooLarge: 414,
      unsafePattern: 451, unsafeEngine: 452, workerUnavailable: 503,
      timeout: 504, protocol: 530, workerStartup: 531
    }),
    transport: Object.freeze({
      startFields: Object.freeze([
        "pattern", "flags", "mode", "wholeWord", "policyStatus", "acknowledged",
        "maxMatches", "maxScannedChars", "maxBatchChars", "maxBatchNodes",
        "workerTimeoutMs", "analyzeInWorker", "allowUnsafeEcmascript"
      ]),
      maxBatchChars: 16 * MIB,
      maxBatchNodes: 2000,
      // One in-flight message plus one queued continuation. Producers await ACKs.
      maxPendingMessages: 2,
      maxMetadataChars: 128,
      // Envelope validation leaves RegExp flag semantics to the analyzer.
      maxFlagsChars: 9,
      handshakeTimeoutMs: 9 * SECOND_MS,
      acknowledgementTimeoutMs: 10 * SECOND_MS,
      idleCloseDelayMs: 15 * SECOND_MS,
      heartbeatIntervalMs: 15 * SECOND_MS,
      unusedRouteTimeoutMs: 2 * MINUTE_MS,
      disconnectedRouteGraceMs: 10 * SECOND_MS,
      rejectedPortTimeoutMs: SECOND_MS,
      concurrentWorkers: 4
    }),
    text: Object.freeze({
      sourceChunkChars: 128 * KIB,
      // A Unicode code point can occupy two UTF-16 units on either boundary.
      boundaryContextChars: 2
    }),
    scheduling: Object.freeze({ pageSliceMs: 6 }),
    diagnostics: Object.freeze({ maxMessageChars: 512, messageHeadChars: 180, messageTailChars: 160 })
  });
})();
