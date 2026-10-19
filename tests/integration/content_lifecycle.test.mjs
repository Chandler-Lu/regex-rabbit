import assert from "node:assert/strict";
import test from "node:test";
import { readRuntimeSourceSync as readFileSync } from "../fixtures/runtime_source.mjs";
import { JSDOM } from "jsdom";

const files = [
  "infra/ui_i18n.js", "infra/toolbar_position.js", "domain/runtime_config.js", "domain/pattern_analyzer.js", "domain/display_formatter.js", "infra/page_visibility.js", "infra/selection_capture.js",
  "infra/text_mapping.js", "infra/text_collector.js", "infra/search_controller.js", "infra/search_toolbar.js", "content_script.js"
];
const sources = new Map(files.map(file => [file, readFileSync(file, "utf8")]));
const turn = () => new Promise(resolve => setImmediate(resolve));
async function waitUntil(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "content operation did not finish");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function setup(t, { config = {}, initialPending = false } = {}) {
  const dom = new JSDOM('<p id="content">foo bar 中文</p>', {
    url: "https://example.com/", runScripts: "outside-only", pretendToBeVisual: true
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  const requests = [], cancelled = [], pendingStorage = [], observers = [];
  const heldWorkers = [];
  let onMessage, onStorageChange, workerConfig = {}, disposed = 0;
  let holdNextWorker = false;
  let storage = { uiLanguage: "zh-CN", characterBudgetVersion: 1, ...config };
  w.chrome = {
    runtime: {
      id: "extension", lastError: null,
      onMessage: { addListener(listener) { onMessage = listener; } }
    },
    storage: {
      sync: { get(defaults, callback) {
        const snapshot = Array.isArray(defaults) ? Object.fromEntries(defaults.filter(key => Object.hasOwn(storage, key)).map(key => [key, storage[key]])) : { ...defaults, ...storage };
        pendingStorage.push(() => callback(snapshot));
      } },
      onChanged: { addListener(listener) { onStorageChange = listener; } }
    }
  };
  w.RRWorkerManager = {
    updateConfig(value) { workerConfig = { ...workerConfig, ...value }; },
    cancel(id) { cancelled.push(id); },
    dispose() { disposed++; },
    async searchStream(id, pattern, flags, producer, policy) {
      requests.push({ id, pattern, flags, policy: { ...policy }, config: { ...workerConfig } });
      if (holdNextWorker) {
        holdNextWorker = false;
        await new Promise(resolve => heldWorkers.push(resolve));
      }
      await producer(async batch => batch.length, () => true);
      return { matches: [], scannedChars: 0, limited: false, engine: "test-boundary" };
    }
  };
  w.RRHighlightEngine = {
    configure() {}, removeHighlights() {},
    async renderMatchesBatched() { return { handles: [], marks: [], cancelled: false }; }
  };
  w.RRDynamicObserver = { create(options) {
    const observer = { options, starts: 0, stops: 0,
      start() { this.starts++; }, stop() { this.stops++; },
      addRoot() {}, updateRoots() {}, setDebounce() {} };
    observers.push(observer);
    return observer;
  } };
  for (const file of files) w.eval(sources.get(file));
  if (!initialPending) pendingStorage.shift()();
  function toggle() {
    let response;
    onMessage({ action: "toggleSearch" }, { id: "extension" }, value => { response = value; });
    return response.status;
  }
  function enter(query, options = {}) {
    const input = w.document.querySelector("#regex-search-input");
    input.value = query;
    input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...options }));
  }
  function input(query) {
    const element = w.document.querySelector("#regex-search-input");
    element.value = query;
    element.dispatchEvent(new w.Event("input", { bubbles: true }));
  }
  return { w, requests, cancelled, observers, toggle, enter, input,
    get disposed() { return disposed; },
    deliverConfig(index = 0) { assert.ok(pendingStorage.length); pendingStorage.splice(index, 1)[0](); },
    changeConfig(value, area = "sync", changes = {}) { storage = { characterBudgetVersion: 1, ...value }; onStorageChange(changes, area); },
    holdNextWorker() { holdNextWorker = true; },
    releaseWorker() { assert.ok(heldWorkers.length); heldWorkers.shift()(); },
    get pendingConfigCount() { return pendingStorage.length; }
  };
}

test("first query waits for asynchronous initial config before starting matching", async t => {
  const s = setup(t, { config: { maxMatches: 20000, caseSensitive: true, mode: "literal" }, initialPending: true });
  assert.equal(s.toggle(), "shown");
  s.enter("foo");
  await turn();
  assert.equal(s.requests.length, 0);
  s.deliverConfig();
  await turn();
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].config.maxMatches, 20000);
  assert.equal(s.requests[0].flags, "gu");
  assert.equal(s.requests[0].policy.mode, "literal");
});

test("legacy saved character budgets take effect at the new scale without a separate block restriction", async t => {
  const s = setup(t, { config: { characterBudgetVersion: undefined,
    maxScannedChars: 33554432, maxBlockChars: 1048576 } });
  s.toggle(); s.enter("foo");
  await waitUntil(() => s.requests.length === 1);
  assert.equal(s.requests[0].config.maxScannedChars, 33554432000);
  assert.equal(Object.hasOwn(s.requests[0].config, "maxNodeChars"), false);
  assert.equal(Object.hasOwn(s.requests[0].config, "maxChunkMs"), false);

  s.changeConfig({ uiLanguage: "zh-CN", maxScannedChars: 2048 }, "sync", {
    characterBudgetVersion: { newValue: 1 }, maxScannedChars: { newValue: 2048 }
  });
  s.deliverConfig();
  await waitUntil(() => s.requests.length === 2);
  assert.equal(s.requests[1].config.maxScannedChars, 2048);
});

test("sync config changes search only after new settings arrive", async t => {
  const s = setup(t);
  s.toggle(); s.enter("foo");
  await turn();
  assert.equal(s.requests.length, 1);
  s.changeConfig({ maxMatches: 20000, mode: "literal", wholeWord: true });
  await turn();
  assert.equal(s.requests.length, 1);
  s.deliverConfig();
  await turn();
  assert.equal(s.requests.length, 2);
  assert.equal(s.requests.at(-1).config.maxMatches, 20000);
  assert.equal(s.requests.at(-1).policy.mode, "literal");
  assert.equal(s.requests.at(-1).policy.wholeWord, true);
  s.changeConfig({ maxMatches: 100 }, "local");
  assert.equal(s.pendingConfigCount, 0);
});

test("IME does not search intermediate composition or consume composition Enter", async t => {
  const s = setup(t);
  s.toggle();
  const input = s.w.document.querySelector("#regex-search-input");
  input.dispatchEvent(new s.w.CompositionEvent("compositionstart", { bubbles: true }));
  s.input("中");
  s.enter("中", { isComposing: true });
  await new Promise(resolve => setTimeout(resolve, 230));
  assert.equal(s.requests.length, 0);
  input.value = "中文";
  input.dispatchEvent(new s.w.CompositionEvent("compositionend", { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 230));
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].pattern, "中文");
});

test("persisted pageshow restores visible queries when Auto is disabled", async t => {
  const s = setup(t);
  s.toggle(); s.enter("foo");
  await turn();
  assert.equal(s.requests.length, 1);
  s.w.dispatchEvent(new s.w.PageTransitionEvent("pagehide", { persisted: true }));
  assert.equal(s.disposed, 1);
  assert.equal(s.w.document.querySelector("#regex-search-count").textContent, "");
  s.w.dispatchEvent(new s.w.PageTransitionEvent("pageshow", { persisted: true }));
  await turn();
  assert.equal(s.requests.length, 2);
  assert.equal(s.requests.at(-1).pattern, "foo");
  await waitUntil(() => s.w.document.querySelector("#regex-search-count").textContent === "0");
  assert.equal(s.w.document.querySelector("#regex-search-count").textContent, "0");
  assert.equal(s.observers.length, 0);
});

test("closing the search bar cancels config-waiting and debounced searches", async t => {
  const s = setup(t, { initialPending: true });
  s.toggle(); s.enter("foo");
  assert.equal(s.toggle(), "hidden");
  s.deliverConfig();
  await turn();
  assert.equal(s.requests.length, 0);
  s.toggle(); s.input("bar");
  assert.equal(s.toggle(), "hidden");
  await new Promise(resolve => setTimeout(resolve, 230));
  assert.equal(s.requests.length, 0);
});

test("config-waiting queries cannot start after pagehide", async t => {
  const s = setup(t, { initialPending: true });
  s.toggle(); s.enter("foo");
  s.w.dispatchEvent(new s.w.PageTransitionEvent("pagehide", { persisted: true }));
  s.deliverConfig();
  await turn();
  assert.equal(s.requests.length, 0);
  s.w.dispatchEvent(new s.w.PageTransitionEvent("pageshow", { persisted: true }));
  await turn();
  assert.equal(s.requests.length, 1);
});

test("a new query supersedes requests waiting for initial settings", async t => {
  const s = setup(t, { initialPending: true });
  s.toggle(); s.enter("foo"); s.enter("bar");
  s.deliverConfig();
  await turn();
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].pattern, "bar");
});

test("closing and reopening cannot revive earlier config-waiting requests", async t => {
  const s = setup(t, { initialPending: true });
  s.toggle(); s.enter("foo");
  s.toggle(); s.toggle();
  s.deliverConfig();
  await turn();
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].pattern, "foo");
});

test("a new dynamic search consumes a scheduled rerun without cancelling itself", async t => {
  const s = setup(t, { config: { autoSearchDebounce: 500 } });
  s.toggle();
  s.w.document.querySelector("#regex-auto-toggle").click();
  s.holdNextWorker(); s.enter("foo");
  await waitUntil(() => s.requests.length === 1);
  const change = s.observers[0].options.onChange;
  // A page update during the first search schedules one rerun after it ends.
  change();
  s.releaseWorker();
  await waitUntil(() => s.w.document.querySelector("#regex-search-count").textContent === "0");
  // Another already queued observer notification starts a fresh search before
  // that rerun timer expires. It has already covered the earlier notification.
  s.holdNextWorker(); change();
  await waitUntil(() => s.requests.length === 2);
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal(s.requests.length, 2);
  assert.equal(s.cancelled.includes(s.requests[1].id), false);
  s.releaseWorker();
  await waitUntil(() => s.w.document.querySelector("#regex-search-count").textContent === "0");
});

test("out-of-order storage replies cannot restore stale query settings", async t => {
  const s = setup(t, { config: { mode: "regex", caseSensitive: false }, initialPending: true });
  s.toggle(); s.enter("foo");
  s.changeConfig({ mode: "literal", caseSensitive: true, maxMatches: 20000 });
  assert.equal(s.pendingConfigCount, 2);
  s.deliverConfig(1);
  await waitUntil(() => s.requests.length === 1);
  assert.equal(s.requests[0].policy.mode, "literal");
  assert.equal(s.requests[0].flags, "gu");
  s.deliverConfig(); await turn();
  assert.equal(s.requests.length, 1);
  s.enter("bar"); await waitUntil(() => s.requests.length === 2);
  assert.equal(s.requests[1].policy.mode, "literal");
  assert.equal(s.requests[1].config.maxMatches, 20000);
});

test("Escape during IME composition preserves the query and native key handling", t => {
  const s = setup(t); s.toggle();
  const input = s.w.document.querySelector("#regex-search-input");
  input.value = "中文";
  input.dispatchEvent(new s.w.CompositionEvent("compositionstart", { bubbles: true }));
  const escape = new s.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, isComposing: true });
  input.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, false);
  assert.equal(input.value, "中文");
  assert.equal(s.w.document.querySelector("#regex-search-container").style.display, "flex");
});

test("a delayed opening frame cannot focus the toolbar after it was closed", t => {
  const s = setup(t), frames = [];
  s.w.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  const pageInput = s.w.document.createElement("input"); s.w.document.body.appendChild(pageInput); pageInput.focus();
  s.toggle(); s.toggle();
  for (const frame of frames) frame();
  assert.equal(s.w.document.activeElement, pageInput);
});

test("changing a color keeps the page's temporary mode and case switches", async t => {
  const s = setup(t); s.toggle();
  s.w.document.querySelector("#regex-case-toggle").click();
  s.w.document.querySelector("#regex-mode-literal").click();
  s.enter("foo"); await waitUntil(() => s.requests.length === 1);
  s.changeConfig({ highlightColor: "#123456" }, "sync", { highlightColor: { newValue: "#123456" } });
  s.deliverConfig(); await turn();
  assert.equal(s.requests.length, 1);
  s.enter("bar"); await waitUntil(() => s.requests.length === 2);
  assert.equal(s.requests[1].policy.mode, "literal");
  assert.equal(s.requests[1].flags, "gu");
});

test("unrelated sync storage changes do not read config or repeat the search", async t => {
  const s = setup(t); s.toggle(); s.enter("foo");
  await waitUntil(() => s.requests.length === 1);
  s.changeConfig({}, "sync", { unrelatedPreference: { newValue: true } });
  assert.equal(s.pendingConfigCount, 0);
  await turn(); assert.equal(s.requests.length, 1);
});

test("initial asynchronous settings do not overwrite switches the user already clicked", async t => {
  const s = setup(t, { initialPending: true }); s.toggle();
  s.w.document.querySelector("#regex-case-toggle").click();
  s.w.document.querySelector("#regex-mode-literal").click();
  s.w.document.querySelector("#regex-word-toggle").click();
  s.enter("foo"); s.deliverConfig();
  await waitUntil(() => s.requests.length === 1);
  assert.equal(s.requests[0].policy.mode, "literal");
  assert.equal(s.requests[0].policy.wholeWord, true);
  assert.equal(s.requests[0].flags, "gu");
});

test("settings arriving during composition do not search uncommitted candidates", async t => {
  const s = setup(t); s.toggle();
  const input = s.w.document.querySelector("#regex-search-input");
  input.dispatchEvent(new s.w.CompositionEvent("compositionstart", { bubbles: true })); s.input("中");
  s.changeConfig({ mode: "literal" }); s.deliverConfig();
  await new Promise(resolve => setTimeout(resolve, 230)); assert.equal(s.requests.length, 0);
  input.value = "中文"; input.dispatchEvent(new s.w.CompositionEvent("compositionend", { bubbles: true }));
  await waitUntil(() => s.requests.length === 1);
  assert.equal(s.requests[0].pattern, "中文");
});

test("closing an unfinished composition does not block typing after reopening", async t => {
  const s = setup(t); s.toggle();
  const input = s.w.document.querySelector("#regex-search-input");
  input.dispatchEvent(new s.w.CompositionEvent("compositionstart", { bubbles: true })); s.input("中");
  s.toggle(); s.toggle(); s.input("foo");
  await waitUntil(() => s.requests.length === 1);
  assert.equal(s.requests[0].pattern, "foo");
});

test("closing restores focus to the page control used before opening", t => {
  const s = setup(t), frames = [];
  s.w.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  const pageInput = s.w.document.createElement("input"); s.w.document.body.appendChild(pageInput); pageInput.focus();
  s.toggle(); frames.shift()();
  assert.equal(s.w.document.activeElement.id, "regex-search-input");
  s.toggle(); assert.equal(s.w.document.activeElement, pageInput);
});

test("clearing and closing a busy query leaves a reopened empty toolbar ready", async t => {
  const s = setup(t);
  s.toggle(); s.holdNextWorker(); s.enter("foo");
  await waitUntil(() => s.requests.length === 1);
  const container = s.w.document.querySelector("#regex-search-container"), input = s.w.document.querySelector("#regex-search-input");
  assert.equal(container.getAttribute("aria-busy"), "true");
  for (let i = 0; i < 2; i++) input.dispatchEvent(new s.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(s.toggle(), "shown");
  assert.equal(input.value, "");
  assert.equal(container.getAttribute("aria-busy"), "false");
  s.releaseWorker(); await turn();
  assert.equal(container.getAttribute("aria-busy"), "false");
});

test("background settings changes wait for the page to become visible", async t => {
  const s = setup(t); let hidden = false;
  Object.defineProperty(s.w.document, "hidden", { get: () => hidden });
  s.toggle(); s.enter("foo"); await waitUntil(() => s.requests.length === 1);
  hidden = true; s.w.document.dispatchEvent(new s.w.Event("visibilitychange"));
  s.changeConfig({ mode: "literal" }); s.deliverConfig(); await turn();
  assert.equal(s.requests.length, 1);
  hidden = false; s.w.document.dispatchEvent(new s.w.Event("visibilitychange"));
  await waitUntil(() => s.requests.length === 2);
  assert.equal(s.requests[1].policy.mode, "literal");
});

test("automatic observation pauses in a background tab and resumes without scrolling", async t => {
  const s = setup(t); let hidden = false;
  Object.defineProperty(s.w.document, "hidden", { get: () => hidden });
  s.toggle(); s.w.document.querySelector("#regex-auto-toggle").click();
  const observer = s.observers[0]; assert.equal(observer.starts, 1);
  hidden = true; s.w.document.dispatchEvent(new s.w.Event("visibilitychange"));
  assert.ok(observer.stops > 0);
  hidden = false; s.w.document.dispatchEvent(new s.w.Event("visibilitychange"));
  assert.equal(observer.starts, 2); assert.equal(s.requests.length, 0);
});

test("an automatic query refreshes after an unobserved background interval", async t => {
  const s = setup(t); let hidden = false;
  Object.defineProperty(s.w.document, "hidden", { get: () => hidden });
  s.toggle(); s.enter("foo");
  await waitUntil(() => s.w.document.querySelector("#regex-search-count").textContent === "0");
  s.w.document.querySelector("#regex-auto-toggle").click();
  hidden = true; s.w.document.dispatchEvent(new s.w.Event("visibilitychange"));
  s.w.document.querySelector("#content").textContent = "foo foo";
  await turn(); assert.equal(s.requests.length, 1);
  hidden = false; s.w.document.dispatchEvent(new s.w.Event("visibilitychange"));
  await waitUntil(() => s.requests.length === 2);
  assert.equal(s.requests[1].pattern, "foo");
});

test("a query paused during typing resumes when the page becomes visible", async t => {
  const s = setup(t); let hidden = false;
  Object.defineProperty(s.w.document, "hidden", { get: () => hidden });
  s.toggle(); s.input("foo");
  hidden = true; s.w.document.dispatchEvent(new s.w.Event("visibilitychange"));
  await new Promise(resolve => setTimeout(resolve, 230)); assert.equal(s.requests.length, 0);
  hidden = false; s.w.document.dispatchEvent(new s.w.Event("visibilitychange"));
  await waitUntil(() => s.requests.length === 1);
  assert.equal(s.requests[0].pattern, "foo");
});

test("automatic toolbar recovery keeps the query after repeated page replacements", async t => {
  const s = setup(t); s.toggle();
  s.w.document.querySelector("#regex-auto-toggle").click();
  s.enter("foo"); await waitUntil(() => s.requests.length === 1);
  const observer = s.observers[0];
  for (let round = 0; round < 5; round++) {
    const old = s.w.document.querySelector("#regex-search-container");
    old.remove(); observer.options.onContainerRemoved();
    await waitUntil(() => {
      const current = s.w.document.querySelector("#regex-search-container");
      return current && current !== old && current.dataset.regexRabbitVisible === "true";
    });
    assert.equal(s.w.document.querySelector("#regex-search-input").value, "foo");
    assert.equal(s.w.document.querySelector("#regex-auto-toggle").getAttribute("aria-pressed"), "true");
    await waitUntil(() => s.requests.length === round + 2);
  }
  assert.equal(observer.starts, 6);
});

test("Escape cancels queued toolbar recovery without recreating the removed bar", async t => {
  const s = setup(t); s.toggle();
  s.w.document.querySelector("#regex-auto-toggle").click();
  s.w.document.querySelector("#regex-search-container").remove();
  s.observers[0].options.onContainerRemoved();
  s.w.document.dispatchEvent(new s.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(s.w.document.querySelector("#regex-search-container"), null);
  assert.equal(s.observers[0].starts, 1);
  assert.equal(s.toggle(), "shown");
  assert.ok(s.w.document.querySelector("#regex-search-container").isConnected);
});
