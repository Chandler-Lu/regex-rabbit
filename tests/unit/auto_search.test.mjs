import assert from "node:assert/strict";
import test from "node:test";

// ── Debounce logic tests (EXTRACTED from content_script:scheduleAutoSearch) ──

function createAutoSearchSchedule(getDebounceMs, performSearch) {
  var autoSearchTimer = null;
  var searchCount = 0;
  var input = { get value() { return "test"; } };
  var isVisible = true;

  function schedule() {
    clearTimeout(autoSearchTimer);
    if (!input || !input.value) return;
    var ms = getDebounceMs();
    autoSearchTimer = setTimeout(function () {
      autoSearchTimer = null;
      if (isVisible && input && input.value) {
        searchCount++;
        performSearch(input.value);
      }
    }, ms);
  }

  function cancel() {
    clearTimeout(autoSearchTimer);
    autoSearchTimer = null;
  }

  function setVisible(v) { isVisible = v; }
  function clearInput() { input = null; }
  function getSearchCount() { return searchCount; }

  return { schedule, cancel, setVisible, clearInput, getSearchCount };
}

test("debounce: rapid calls schedule only one search", async () => {
  var called = [];
  var auto = createAutoSearchSchedule(function () { return 100; }, function (v) { called.push(v); });

  auto.schedule();
  auto.schedule();
  auto.schedule();
  await new Promise(function (r) { setTimeout(r, 200); });

  assert.equal(called.length, 1);
  assert.equal(called[0], "test");
});

test("debounce: later call resets timer", async () => {
  var called = [];
  var auto = createAutoSearchSchedule(function () { return 100; }, function (v) { called.push(v); });

  auto.schedule();
  await new Promise(function (r) { setTimeout(r, 50); });
  auto.schedule(); // reset
  await new Promise(function (r) { setTimeout(r, 200); });

  assert.equal(called.length, 1);
});

test("debounce: cancel prevents execution", async () => {
  var called = [];
  var auto = createAutoSearchSchedule(function () { return 100; }, function (v) { called.push(v); });

  auto.schedule();
  auto.cancel();
  await new Promise(function (r) { setTimeout(r, 200); });

  assert.equal(called.length, 0);
});

test("debounce: different delays respected", async () => {
  var delays = [];
  var callTimes = [];
  var auto = createAutoSearchSchedule(function () { return delays.shift() || 100; }, function () { callTimes.push(Date.now()); });

  delays = [50];
  var t0 = Date.now();
  auto.schedule();
  await new Promise(function (r) { setTimeout(r, 150); });
  assert.equal(callTimes.length, 1);
  assert.ok(callTimes[0] - t0 >= 40, "should wait at least ~40ms");
});

test("debounce: empty input skips search", async () => {
  var called = [];
  var auto = createAutoSearchSchedule(function () { return 100; }, function (v) { called.push(v); });

  auto.clearInput();
  auto.schedule();
  await new Promise(function (r) { setTimeout(r, 200); });

  assert.equal(called.length, 0);
});

test("debounce: not visible skips search", async () => {
  var called = [];
  var auto = createAutoSearchSchedule(function () { return 100; }, function (v) { called.push(v); });

  auto.setVisible(false);
  auto.schedule();
  await new Promise(function (r) { setTimeout(r, 200); });

  assert.equal(called.length, 0);
});

// ── Mutation filter logic tests ──

function shouldTriggerSearch(mutations, containerEl) {
  for (var i = 0; i < mutations.length; i++) {
    var target = mutations[i].target;
    if (target === containerEl || (containerEl && containerEl.contains(target))) continue;
    return true;
  }
  return false;
}

test("mutation filter: normal DOM mutation triggers", () => {
  var result = shouldTriggerSearch(
    [{ type: "childList", target: {} }],
    null
  );
  assert.equal(result, true);
});

test("mutation filter: own container mutation skipped", () => {
  var container = { contains: function () { return false; } };
  var result = shouldTriggerSearch(
    [{ type: "childList", target: container }],
    container
  );
  assert.equal(result, false);
});

test("mutation filter: child of container skipped", () => {
  var container = { contains: function (t) { return t === child; } };
  var child = {};
  var result = shouldTriggerSearch(
    [{ type: "childList", target: child }],
    container
  );
  assert.equal(result, false);
});

test("mutation filter: does not call closest on mutation targets", () => {
  var el = { closest: function () { throw new Error("closest should not be called"); } };
  var result = shouldTriggerSearch(
    [{ type: "childList", target: el }],
    null
  );
  assert.equal(result, true);
});

test("mutation filter: unrelated DOM element triggers", () => {
  var el = {};
  var container = { contains: function () { return false; } };
  var result = shouldTriggerSearch(
    [{ type: "characterData", target: el }],
    container
  );
  assert.equal(result, true);
});
