/** Short continuations with periodic ordinary tasks for fair page scheduling. */
(function () {
  "use strict";
  var MAX_BOOSTED_CONTINUATIONS = 4;
  var ORDINARY_TASK_INTERVAL_MS = 24;
  var boosted = 0;
  var lastOrdinaryTask = now();
  function now() { return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now(); }
  function ordinaryTask() {
    boosted = 0;
    return new Promise(function (resolve) {
      setTimeout(function () { lastOrdinaryTask = now(); resolve(); }, 0);
    });
  }
  function yieldToPage() {
    // scheduler.yield continuations have boosted priority. Repeating only those
    // can starve normal timers, even though each slice is small.
    if (++boosted < MAX_BOOSTED_CONTINUATIONS && now() - lastOrdinaryTask < ORDINARY_TASK_INTERVAL_MS && typeof scheduler !== "undefined" && typeof scheduler.yield === "function") {
      try { return Promise.resolve(scheduler.yield()).catch(ordinaryTask); }
      catch (_) { return ordinaryTask(); }
    }
    return ordinaryTask();
  }
  globalThis.RRTaskScheduler = { yield: yieldToPage };
})();
