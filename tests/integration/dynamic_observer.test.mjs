import assert from "node:assert/strict";
import { readRuntimeSource as readFile } from "../fixtures/runtime_source.mjs";
import test from "node:test";
import { JSDOM } from "jsdom";

const source = await readFile("infra/dynamic_observer.js", "utf8");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, timeout = 1500) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "expected observer condition was not reached");
    await wait(20);
  }
}

function setup(t, html = "<body><p id='text'>hello</p></body>", options = {}) {
  const dom = new JSDOM(html, { url: "https://test.com", runScripts: "outside-only" });
  dom.window.eval(source);
  const changes = [];
  const observer = dom.window.RRDynamicObserver.create({
    debounceMs: 10,
    maxWaitMs: 80,
    discoveryIntervalMs: 20,
    onChange(change) { changes.push(change); },
    ...options
  });
  t.after(() => { observer.dispose(); dom.window.close(); });
  if (typeof options.beforeStart === "function") options.beforeStart(dom.window.document);
  observer.start();
  observer.flush();
  changes.length = 0;
  return { dom, document: dom.window.document, window: dom.window, observer, changes };
}

test("actual observer debounces DOM text and visible attributes", async t => {
  const { document, observer, changes } = setup(t);
  const text = document.getElementById("text");
  text.firstChild.nodeValue = "changed";
  text.hidden = true;
  text.className = "new";
  assert.equal(observer.flush(), true, "flush must consume queued MutationObserver records");
  assert.equal(changes.length, 1);
  assert.ok(changes[0].reasons.includes("mutation"));
  await wait(25);
  assert.equal(changes.length, 1, "flush must cancel both pending refresh timers");
});

test("mutation batches beyond the old 4096-record prefix still discover their trailing shadow roots", async t => {
  const { document, observer, changes } = setup(t, undefined, { discoveryIntervalMs: 60000 });
  const text = document.getElementById('text');
  for (let index = 0; index < 4500; index++) text.setAttribute('data-pulse', String(index));
  const host = document.createElement('section');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<p>late root</p>';
  document.body.appendChild(host);
  observer.flush();
  await waitFor(() => {
    observer.flush();
    return changes.some(change => change.roots.includes(shadow));
  });
  changes.length = 0;
  shadow.firstChild.textContent = 'changed after discovery';
  assert.equal(observer.flush(), true);
  assert.ok(changes.some(change => change.reasons.includes('mutation')));

  for (let index = 0; index < 4500; index++) text.setAttribute('data-pulse', String(index));
  observer.flush();
  observer.stop();
  changes.length = 0;
  await wait(25);
  assert.equal(changes.length, 0, 'stop must release pending mutation continuation tasks');
});

test("ID and arbitrary attribute selector visibility changes are observed", t => {
  const { document, observer, changes } = setup(t, "<head><style>#hidden-panel,[data-state='hidden'] { display:none }</style></head><body><p id='text'>visible</p></body>");
  const p = document.getElementById("text");
  p.id = "hidden-panel";
  observer.flush();
  assert.equal(changes.length, 1);
  p.id = "text";
  observer.flush();
  changes.length = 0;
  p.dataset.state = "hidden";
  observer.flush();
  assert.equal(changes.length, 1);
  assert.equal(document.defaultView.getComputedStyle(p).display, "none");
});

test("body replacement remains observable", async t => {
  const { document, changes } = setup(t);
  const replacement = document.createElement("body");
  replacement.textContent = "replacement";
  document.body.replaceWith(replacement);
  await wait(25);
  changes.length = 0;
  replacement.firstChild.nodeValue = "second update";
  await wait(25);
  assert.equal(changes.length, 1);
});

test("documentElement replacement remains observable", async t => {
  const { document, changes } = setup(t);
  const replacement = document.createElement("html");
  replacement.innerHTML = "<head></head><body><p>replacement</p></body>";
  document.documentElement.replaceWith(replacement);
  await wait(25);
  changes.length = 0;
  replacement.querySelector("p").firstChild.nodeValue = "second update";
  await wait(25);
  assert.equal(changes.length, 1);
});

test("UI, owned stylesheet, overlays and highlight attributes do not refresh", async t => {
  const { document, observer, changes } = setup(t);
  const ui = document.createElement("div");
  ui.id = "regex-search-container";
  ui.textContent = "search";
  document.body.append(ui);
  const sheet = document.createElement("style");
  sheet.id = "rr-dynamic-colors";
  sheet.textContent = ".own { color: red }";
  document.head.append(sheet);
  const mark = document.createElement("mark");
  mark.className = "regex-search-highlight";
  mark.textContent = "hello";
  document.getElementById("text").replaceChildren(mark);
  observer.flush();
  changes.length = 0;
  ui.firstChild.nodeValue = "changed";
  sheet.textContent = ".own { color: blue }";
  mark.classList.add("current");
  mark.style.backgroundColor = "red";
  observer.flush();
  assert.equal(changes.length, 0);
  await wait(35);
  assert.equal(changes.length, 0, "stylesheet polling must also ignore owned sheets");
});

test("legacy wrapping and unwrapping unchanged text is filtered precisely", t => {
  const { document, observer, changes } = setup(t);
  const p = document.getElementById("text");
  const mark = document.createElement("mark");
  mark.className = "regex-search-highlight";
  mark.textContent = "ell";
  p.replaceChildren(document.createTextNode("h"), mark, document.createTextNode("o"));
  observer.flush();
  assert.equal(changes.length, 0);
  mark.replaceWith(document.createTextNode(mark.textContent));
  observer.flush();
  assert.equal(changes.length, 0);
  p.firstChild.nodeValue = "H";
  observer.flush();
  assert.equal(changes.length, 1, "real page edits must remain observable");
});

test("own records do not hide simultaneous page edits", t => {
  const { document, observer, changes } = setup(t);
  const ui = document.createElement("div");
  ui.id = "regex-search-container";
  document.body.append(ui);
  ui.textContent = "own";
  document.getElementById("text").firstChild.nodeValue = "page edit";
  observer.flush();
  assert.equal(changes.length, 1);
});

test("input/change, slotchange and details toggle trigger refresh", async t => {
  const { document, window, observer, changes } = setup(t, "<body><input><details><summary>more</summary>text</details><div id='host'></div></body>");
  const shadow = document.getElementById("host").attachShadow({ mode: "open" });
  shadow.innerHTML = "<slot></slot>";
  observer.updateRoots([document, shadow]);
  document.querySelector("input").dispatchEvent(new window.Event("input", { bubbles: true }));
  document.querySelector("input").dispatchEvent(new window.Event("change", { bubbles: true }));
  shadow.querySelector("slot").dispatchEvent(new window.Event("slotchange", { bubbles: true }));
  document.querySelector("details").dispatchEvent(new window.Event("toggle"));
  observer.flush();
  assert.equal(changes.length, 1);
  for (const reason of ["input", "change", "slotchange", "toggle"]) assert.ok(changes[0].reasons.includes(reason));
  await wait(25);
});

test("open shadow roots attached to existing hosts are discovered without patches", async t => {
  const { document, window, changes } = setup(t, "<body><div id='host'></div></body>");
  const attachShadow = window.Element.prototype.attachShadow;
  const shadow = document.getElementById("host").attachShadow({ mode: "open" });
  shadow.innerHTML = "<p>shadow text</p>";
  await waitFor(() => changes.some(change => change.roots.includes(shadow)));
  assert.equal(window.Element.prototype.attachShadow, attachShadow);
  assert.ok(changes.some(change => change.rootsChanged));
  changes.length = 0;
  shadow.querySelector("p").firstChild.nodeValue = "updated";
  await wait(25);
  assert.equal(changes.length, 1);
});

test("Chrome closed-root discovery observes new closed roots and releases detached hosts", async t => {
  const known = new WeakMap();
  const { document, observer, changes } = setup(t, "<body><div id='host'></div></body>", {
    beforeStart(doc) {
      doc.defaultView.chrome = { dom: { openOrClosedShadowRoot(element) { return known.get(element) || null; } } };
    }
  });
  const host = document.getElementById("host");
  const shadow = host.attachShadow({ mode: "closed" });
  known.set(host, shadow);
  shadow.innerHTML = "<p>closed text</p>";
  assert.equal(host.shadowRoot, null);
  await waitFor(() => changes.some(change => change.roots.includes(shadow)));
  changes.length = 0;
  observer.updateRoots([document, shadow]);
  await wait(60);
  assert.equal(changes.length, 0, "connected closed roots must not be pruned because host.shadowRoot is null");
  shadow.querySelector("p").firstChild.nodeValue = "updated closed text";
  observer.flush();
  assert.equal(changes.length, 1);
  changes.length = 0;
  host.remove();
  observer.flush();
  changes.length = 0;
  shadow.querySelector("p").textContent = "detached closed update";
  await wait(35);
  assert.equal(changes.length, 0);
});

test("shared shadow-root helper is used without exposing native controls or frame internals", async t => {
  const known = new WeakMap(), queried = [];
  const { document, changes } = setup(t, "<body><div id='host'></div><input type='password'><textarea></textarea><select></select><iframe></iframe></body>", {
    beforeStart(doc) {
      const host = doc.getElementById("host");
      const shadow = host.attachShadow({ mode: "closed" });
      shadow.innerHTML = "<p>closed via shared helper</p>";
      known.set(host, shadow);
      doc.defaultView.RRPageVisibility = { getShadowRoot(element) { queried.push(element.tagName); return known.get(element) || element.shadowRoot; } };
      doc.defaultView.chrome = { dom: { openOrClosedShadowRoot() { throw new Error("shared helper must take priority"); } } };
    }
  });
  await wait(60);
  const shadow = known.get(document.getElementById("host"));
  shadow.querySelector("p").textContent = "updated shared-helper root";
  await waitFor(() => changes.some(change => change.roots.includes(shadow)));
  for (const tag of ["INPUT", "TEXTAREA", "SELECT", "IFRAME"]) assert.ok(!queried.includes(tag));
});

test("detached shadows are disconnected and cannot continue refreshing", async t => {
  const { document, observer, changes } = setup(t, "<body><div id='host'></div></body>");
  const host = document.getElementById("host");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = "<p>old shadow</p>";
  observer.updateRoots([document, shadow]);
  host.remove();
  observer.flush();
  changes.length = 0;
  shadow.querySelector("p").textContent = "detached update";
  await wait(35);
  assert.equal(changes.length, 0);
});

test("same-origin frames are observed and detached frame Documents released", async t => {
  const { document, observer, changes } = setup(t, "<body><iframe></iframe></body>");
  const frame = document.querySelector("iframe");
  const childDocument = frame.contentDocument;
  childDocument.body.innerHTML = "<p>frame text</p>";
  observer.flush();
  assert.ok(changes.some(change => change.roots.includes(childDocument)));
  changes.length = 0;
  childDocument.querySelector("p").firstChild.nodeValue = "updated frame";
  await wait(25);
  assert.equal(changes.length, 1);
  frame.remove();
  observer.flush();
  changes.length = 0;
  assert.equal(childDocument.isConnected, true, "jsdom detached frame document demonstrates why document.isConnected is insufficient");
  childDocument.body.textContent = "detached frame update";
  await wait(35);
  assert.equal(changes.length, 0);
});

test("inaccessible frame reads are contained and load requests recollection", t => {
  const { document, window, observer, changes } = setup(t, "<body><iframe></iframe></body>");
  const frame = document.querySelector("iframe");
  Object.defineProperty(frame, "contentDocument", { get() { throw new window.DOMException("cross origin", "SecurityError"); } });
  assert.doesNotThrow(() => frame.dispatchEvent(new window.Event("load")));
  assert.doesNotThrow(() => observer.flush());
  assert.ok(changes.some(change => change.reasons.includes("frame-load")));
});

test("frame cleanup survives a WindowProxy becoming inaccessible after navigation", t => {
  const { document, observer } = setup(t, "<body><iframe></iframe></body>");
  const frame = document.querySelector("iframe");
  const childWindow = frame.contentDocument.defaultView;
  const original = childWindow.removeEventListener;
  childWindow.removeEventListener = function () { throw new childWindow.DOMException("cross origin", "SecurityError"); };
  frame.remove();
  assert.doesNotThrow(() => observer.flush());
  assert.doesNotThrow(() => observer.stop());
  childWindow.removeEventListener = original;
});

test("nested pause retains real dirty changes until the final one-shot resume", async t => {
  const { document, observer, changes } = setup(t);
  const resume1 = observer.pause();
  const resume2 = observer.pause();
  document.getElementById("text").firstChild.nodeValue = "paused edit";
  await wait(25);
  assert.equal(observer.flush(), false);
  resume1(); resume1();
  await wait(25);
  assert.equal(changes.length, 0);
  resume2();
  await wait(25);
  assert.equal(changes.length, 1);
});

test("real page edits inside legacy highlights remain observable", t => {
  const { document, observer, changes } = setup(t);
  const mark = document.createElement("mark");
  mark.className = "regex-search-highlight";
  mark.textContent = "hello";
  document.getElementById("text").replaceChildren(mark);
  observer.flush();
  assert.equal(changes.length, 0);
  mark.firstChild.nodeValue = "changed";
  observer.flush();
  assert.equal(changes.length, 1);
});

test("container removal discovered during pause cannot leave a restarted observer paused", async t => {
  let container;
  const { document, observer, changes } = setup(t, "<body><div id='regex-search-container'></div><p id='text'>hello</p></body>", {
    getContainer() { return container; }
  });
  container = document.getElementById("regex-search-container");
  document.getElementById("text").firstChild.nodeValue = "before removal";
  observer.flush();
  changes.length = 0;
  container.remove();
  const resume = observer.pause();
  container = document.createElement("div");
  container.id = "regex-search-container";
  document.body.append(container);
  observer.start();
  resume();
  document.getElementById("text").textContent = "after restart";
  await wait(30);
  assert.equal(changes.length, 1);
});

test("stop clears timers/listeners and stale resume tokens cannot revive a restart", async t => {
  const { document, window, observer, changes } = setup(t, "<body><input><p id='text'>hello</p></body>");
  const staleResume = observer.pause();
  observer.stop();
  observer.start();
  const currentResume = observer.pause();
  document.getElementById("text").textContent = "restart edit";
  staleResume();
  await wait(25);
  assert.equal(changes.length, 0);
  currentResume();
  await wait(25);
  assert.equal(changes.length, 1);
  changes.length = 0;
  document.getElementById("text").textContent = "pending";
  observer.flush();
  changes.length = 0;
  document.getElementById("text").textContent = "pending timer";
  await wait(1);
  observer.stop();
  document.querySelector("input").dispatchEvent(new window.Event("input", { bubbles: true }));
  await wait(100);
  assert.equal(changes.length, 0);
});

test("container removal stops monitoring even when the removal record is owned", async t => {
  let container, removals = 0;
  const { document, observer, changes } = setup(t, "<body><div id='regex-search-container'></div><p id='text'>hello</p></body>", {
    getContainer() { return container; },
    onContainerRemoved() { removals++; }
  });
  container = document.getElementById("regex-search-container");
  document.getElementById("text").firstChild.nodeValue = "first";
  observer.flush();
  changes.length = 0;
  container.remove();
  observer.flush();
  assert.equal(removals, 1);
  document.getElementById("text").textContent = "after removal";
  await wait(35);
  assert.equal(changes.length, 0);
});

test("continuous changes cannot postpone refresh beyond maxWait", async t => {
  const { document, changes } = setup(t, undefined, { debounceMs: 70, maxWaitMs: 95 });
  const text = document.getElementById("text").firstChild;
  for (let i = 0; i < 8; i++) {
    text.nodeValue = "change " + i;
    await wait(20);
  }
  assert.ok(changes.length >= 1, "trailing debounce alone would not yet have fired");
});

test("programmatic form values and CSSOM rule count changes are polled", async t => {
  const { document, observer, changes } = setup(t, "<head><style>p { color: red }</style></head><body><input value='old'><p>text</p></body>", { discoveryBudgetMs: 16 });
  // Give the bounded initial pass time to establish the control baseline,
  // including when other integration suites are consuming the CPU.
  await wait(80);
  observer.flush();
  changes.length = 0;
  document.querySelector("input").value = "new";
  document.styleSheets[0].insertRule("p { display: none }", 1);
  await waitFor(() => changes.some(change => change.reasons.includes("control-value")) &&
    changes.some(change => change.reasons.includes("stylesheet")));
  assert.ok(changes.some(change => change.reasons.includes("control-value")));
  assert.ok(changes.some(change => change.reasons.includes("stylesheet")));
});

test("CSS rule declaration edits and grouped-rule edits are hashed in bounded slices", async t => {
  const { document, changes } = setup(t, "<head><style>p { color: red } @media all { p { display: block } }</style></head><body><p>text</p></body>");
  await wait(45);
  changes.length = 0;
  document.styleSheets[0].cssRules[0].style.color = "blue";
  document.styleSheets[0].cssRules[1].cssRules[0].style.display = "none";
  await wait(85);
  assert.ok(changes.some(change => change.reasons.includes("cssom")));
});

test("CSSOM polling descends into accessible imported stylesheets", async t => {
  const { document, changes } = setup(t, "<head><style>@import url(nested.css);</style></head><body><p>text</p></body>");
  const imported = document.styleSheets[0].cssRules[0].styleSheet;
  await wait(60);
  changes.length = 0;
  imported.insertRule("p { display: none }", 0);
  await waitFor(() => changes.some(change => change.reasons.includes("cssom")));
  changes.length = 0;
  imported.cssRules[0].style.display = "block";
  await waitFor(() => changes.some(change => change.reasons.includes("cssom")));
});

test("modern style rules with cssRules still hash their own declarations and selectors", async t => {
  let reads = 0;
  const { document, changes } = setup(t, "<head><style>p { color: red }</style></head><body><p>text</p></body>", {
    beforeStart(doc) {
      const rule = doc.styleSheets[0].cssRules[0];
      // jsdom does not implement CSSStyleRule's modern nested cssRules
      // interface. Supply the interface Chromium uses before the first pass.
      Object.defineProperty(rule, "cssRules", { value: [] });
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(rule.style), "cssText");
      Object.defineProperty(rule.style, "cssText", {
        get() { reads++; return descriptor.get.call(this); },
        set(value) { descriptor.set.call(this, value); }
      });
    }
  });
  const rule = document.styleSheets[0].cssRules[0];
  await waitFor(() => reads >= 2);
  changes.length = 0;
  rule.style.setProperty("display", "none");
  await waitFor(() => changes.some(change => change.reasons.includes("cssom")));
  changes.length = 0;
  rule.selectorText = "div";
  await waitFor(() => changes.some(change => change.reasons.includes("cssom")));
});

test("explicit input events synchronize control polling without a second refresh", async t => {
  const { document, window, observer, changes } = setup(t, "<body><input value='old'></body>", { discoveryBudgetMs: 16 });
  const input = document.querySelector("input");
  input.value = "updated";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  observer.flush();
  assert.equal(changes.length, 1);
  await wait(80);
  assert.equal(changes.length, 1, "polling must not rediscover a value already delivered by an input event");
});

test("streaming addRoot observes a new search boundary immediately", t => {
  const { document, observer, changes } = setup(t, "<body><div></div></body>");
  const shadow = document.querySelector("div").attachShadow({ mode: "open" });
  shadow.innerHTML = "<p>before</p>";
  assert.equal(observer.addRoot(shadow), observer);
  shadow.querySelector("p").firstChild.nodeValue = "after";
  observer.flush();
  assert.equal(changes.length, 1);
  assert.ok(changes[0].roots.includes(shadow));
});

test("newly inserted shadow hosts are registered from the bounded mutation batch", t => {
  const { document, observer, changes } = setup(t);
  const host = document.createElement("div");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = "<p>new boundary</p>";
  document.body.append(host);
  observer.flush();
  assert.ok(changes.some(change => change.roots.includes(shadow)));
  changes.length = 0;
  shadow.querySelector("p").textContent = "updated";
  observer.flush();
  assert.equal(changes.length, 1);
});

test("oversized legacy marks fall back to invalidation without reading nested textContent", t => {
  const { document, observer, changes } = setup(t);
  const mark = document.createElement("mark");
  mark.className = "regex-search-highlight";
  mark.innerHTML = "<span>nested page node</span>";
  Object.defineProperty(mark, "textContent", { get() { throw new Error("must not traverse nested marks"); } });
  document.getElementById("text").replaceChildren(mark);
  assert.doesNotThrow(() => observer.flush());
  assert.equal(changes.length, 1);
});

test("callback errors and invalid configuration do not break future observation", async t => {
  let calls = 0;
  const { document, observer } = setup(t, undefined, {
    onChange() { calls++; throw new Error("consumer failed"); },
    debounceMs: Number.NaN,
    maxWaitMs: Infinity
  });
  observer.setDebounce(1, 20);
  document.getElementById("text").textContent = "one";
  await waitFor(() => calls === 1);
  document.getElementById("text").textContent = "two";
  await waitFor(() => calls === 2);
  assert.equal(calls, 2);
  observer.dispose();
  observer.start();
  document.getElementById("text").textContent = "three";
  assert.equal(observer.flush(), false);
  assert.equal(calls, 2, "dispose is terminal");
});

test("root polling remains fair beyond the bounded discovery queue", async t => {
  const { document, observer, changes } = setup(t, "<body></body>", { discoveryBatchSize: 1000, discoveryBudgetMs: 16 });
  const roots = [];
  for (let i = 0; i < 75; i++) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = "<span></span>";
    roots.push(root);
  }
  observer.updateRoots([document, ...roots]);
  observer.flush();
  changes.length = 0;
  const lateShadow = roots[74].querySelector("span").attachShadow({ mode: "open" });
  lateShadow.innerHTML = "<p>late boundary</p>";
  await waitFor(() => changes.some(change => change.roots.includes(lateShadow)));
  assert.ok(changes.some(change => change.roots.includes(lateShadow)));
});

test("partial collector root snapshots retain live hidden boundaries without discovery churn", async t => {
  const { document, observer, changes } = setup(t, "<body><iframe style='display:none'></iframe><div hidden id='host'></div></body>", {
    discoveryBudgetMs: 16
  });
  const childDocument = document.querySelector("iframe").contentDocument;
  const shadow = document.getElementById("host").attachShadow({ mode: "open" });
  shadow.innerHTML = "<p>hidden shadow</p>";
  await waitFor(() => changes.some(change => change.roots.includes(childDocument) && change.roots.includes(shadow)));
  changes.length = 0;
  for (let i = 0; i < 5; i++) {
    // A search of the visible page or a selection omits both live roots.
    observer.updateRoots([]);
    await wait(25);
    observer.flush();
  }
  assert.equal(changes.length, 0, "retained roots must not be rediscovered as new on every pass");
  childDocument.body.textContent = "updated hidden frame";
  shadow.querySelector("p").firstChild.nodeValue = "updated hidden shadow";
  observer.flush();
  assert.equal(changes.length, 1, "both retained boundaries remain observed for later visibility changes");
  assert.ok(changes[0].roots.includes(childDocument));
  assert.ok(changes[0].roots.includes(shadow));
});

test("equal-length programmatic edits beyond the exact control baseline are detected", async t => {
  const { document, observer, changes } = setup(t, "<body><textarea></textarea></body>", {
    beforeStart(doc) { doc.querySelector("textarea").value = "A".repeat(131073); }
  });
  await wait(180);
  observer.flush();
  changes.length = 0;
  const control = document.querySelector("textarea");
  control.value = "A".repeat(131072) + "B";
  await waitFor(() => changes.some(change => change.reasons.includes("control-value")), 3000);
  changes.length = 0;
  await wait(180);
  observer.flush();
  assert.equal(changes.length, 0, "an unchanged large value must not cause repeated refreshes");
});

test("equal-length eventless edits in an actual 9 Mi-character control remain observable", async t => {
  const length = 9 * 1024 * 1024;
  const { document, observer, changes } = setup(t, "<body><input></body>", {
    discoveryBudgetMs: 16,
    beforeStart(doc) { doc.querySelector("input").value = "A".repeat(length); }
  });
  const input = document.querySelector("input"), started = Date.now();
  // The first bounded hash owns the original immutable value. A later pass
  // must still notice this same-length edit beyond the former 4 Mi cutoff.
  input.value = "A".repeat(length - 1) + "B";
  assert.equal(input.value.length, length);
  await waitFor(() => changes.some(change => change.reasons.includes("control-value")), 15000);
  assert.equal(changes.length, 1);
  t.diagnostic(`9 Mi-character eventless edit detected in ${Date.now() - started} ms with bounded fingerprint slices`);
  observer.stop();
});

test("large-control fingerprint polling stays fair across more than one work batch", async t => {
  const { document, observer, changes } = setup(t, "<body></body>", {
    discoveryBudgetMs: 16,
    beforeStart(doc) {
      for (let i = 0; i < 21; i++) {
        const control = doc.createElement("textarea");
        control.value = "A".repeat(131073);
        doc.body.append(control);
      }
    }
  });
  const control = document.querySelectorAll("textarea")[20], prefix = "A".repeat(131063);
  let revision = 0;
  const edits = setInterval(() => { control.value = prefix + String(++revision).padStart(10, "0"); }, 50);
  t.after(() => clearInterval(edits));
  await waitFor(() => changes.some(change => change.reasons.includes("control-value")), 10000);
  clearInterval(edits);
  observer.stop();
});

test("fingerprint polling reaches every registered long control beyond the former tracking cutoff", t => {
  const shared = "A".repeat(131073), pending = new Map(), controls = [];
  let timerId = 0, shortenEarlierControls = false, lastValue = shared, lastReads = 0;
  const { observer, changes } = setup(t, "<body></body>", {
    beforeStart(doc) {
      // This fixture isolates fingerprint polling. A DOM discovery read must
      // not make an untracked final control appear to have been fingerprinted.
      doc.createTreeWalker = () => ({ nextNode() { return null; } });
      doc.defaultView.setTimeout = callback => {
        const id = ++timerId;
        pending.set(id, callback);
        return id;
      };
      doc.defaultView.clearTimeout = id => { pending.delete(id); };
      const fragment = doc.createDocumentFragment();
      for (let index = 0; index < 4097; index++) {
        const control = doc.createElement("input");
        Object.defineProperty(control, "value", { get() {
          if (index === 4096) { lastReads++; return lastValue; }
          return shortenEarlierControls ? "A" : shared;
        } });
        controls.push(control);
        fragment.append(control);
      }
      doc.body.append(fragment);
    }
  });
  for (const control of controls) observer.syncControl(control, { value: shared });
  assert.equal(lastReads, 0, "observed samples establish the baseline without another getter read");
  // Earlier values cease to need a fingerprint. They can leave the rotating
  // queue in cheap slices; only the final control needs real character hashing.
  shortenEarlierControls = true;
  function advanceUntil(predicate, message) {
    for (let step = 0; step < 3000 && !predicate(); step++) {
      const next = pending.entries().next().value;
      assert.ok(next, "active observation must keep a discovery callback queued");
      pending.delete(next[0]);
      next[1]();
      observer.flush();
    }
    assert.ok(predicate(), message);
  }
  advanceUntil(() => lastReads > 0, "the final long control must enter fingerprint polling");
  lastValue = shared.slice(0, -1) + "B";
  advanceUntil(() => changes.some(change => change.reasons.includes("control-value")),
    "a same-length eventless edit must remain observable after 4096 other long controls");
  observer.stop();
  assert.equal(pending.size, 0, "stopping observation must release scheduled callbacks");
});

test("password polling observes only public placeholder visibility", async t => {
  const { document, observer, changes } = setup(t, "<body><input type='password' placeholder='public placeholder'></body>");
  const input = document.querySelector("input");
  let shown = true, privateReads = 0;
  // jsdom does not update :placeholder-shown after value edits. Supply that
  // browser-owned public state here; real Chromium tests cover native edits.
  input.matches = selector => { assert.equal(selector, ":placeholder-shown"); return shown; };
  Object.defineProperty(input, "value", { get() { privateReads++; throw new Error("password value must not be read"); } });
  shown = false;
  await waitFor(() => changes.some(change => change.reasons.includes("control-value")));
  changes.length = 0;
  await wait(80);
  observer.flush();
  assert.equal(changes.length, 0, "an unchanged hidden placeholder cannot request another refresh");
  shown = true;
  await waitFor(() => changes.some(change => change.reasons.includes("control-value")));
  assert.equal(privateReads, 0);
});

test("actual collection synchronizes a control read between polling passes", async t => {
  const { document, window, observer, changes } = setup(t,
    "<body><input placeholder='public placeholder'></body>",
    { discoveryIntervalMs: 200, discoveryBudgetMs: 16 });
  window.eval(await readFile("infra/page_visibility.js", "utf8"));
  window.eval(await readFile("infra/text_collector.js", "utf8"));
  const input = document.querySelector("input");
  // Focus can request a search before the low-frequency value poll runs.
  input.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));
  input.value = "intermediate value";
  observer.flush();
  assert.equal(changes.length, 1);
  assert.ok(changes[0].reasons.includes("focusin"));
  assert.ok(!changes[0].reasons.includes("control-value"));
  const reads = [];
  const entries = window.RRTextCollector.collect({
    onControlRead(element, observed) { reads.push(element); observer.syncControl(element, observed); }
  });
  assert.deepEqual(reads, [input]);
  assert.equal(entries.stats.placeholderEntries, 0);
  assert.equal(entries[0].text, "intermediate value");
  assert.equal(observer.flush(), false, "content just consumed by a search must not request a duplicate refresh");
  changes.length = 0;
  input.value = "";
  await waitFor(() => changes.some(change => change.reasons.includes("control-value")));
  const restored = window.RRTextCollector.collect({ onControlRead: (element, observed) => observer.syncControl(element, observed) });
  assert.equal(restored.stats.placeholderEntries, 1);
  assert.equal(restored[0].text, "public placeholder");
  await wait(250);
  observer.flush();
  assert.equal(changes.length, 1, "the restored occupancy must also become a stable baseline");
});

test("synchronizing consumed control values is quiet and preserves paused changes", async t => {
  const { document, observer, changes } = setup(t, "<body><input value='old'><p>text</p></body>");
  const input = document.querySelector("input");
  input.value = "already searched";
  assert.equal(observer.syncControl(input), observer);
  assert.equal(observer.flush(), false);
  await wait(80);
  assert.equal(changes.length, 0);
  const resume = observer.pause();
  document.querySelector("p").textContent = "pending page edit";
  input.value = "searched while paused";
  observer.syncControl(input);
  assert.equal(observer.flush(), false);
  resume();
  await waitFor(() => changes.length === 1);
  assert.ok(changes[0].reasons.includes("mutation"));
  assert.ok(!changes[0].reasons.includes("control-value"), "synchronization must neither add nor clear pending changes");
  changes.length = 0;
  input.value = "subsequent eventless edit";
  await waitFor(() => changes.some(change => change.reasons.includes("control-value")));
});

test("control read samples avoid repeated value reads and keep password state public", t => {
  const { document, observer, changes } = setup(t,
    "<body><input id='text'><textarea></textarea><input id='password' type='password' placeholder='public'></body>");
  let valueReads = 0, publicReads = 0;
  const text = document.querySelector("#text"), textarea = document.querySelector("textarea"), password = document.querySelector("#password");
  for (const control of [text, textarea, password]) Object.defineProperty(control, "value", {
    get() { valueReads++; throw new Error("already read by the collector"); }
  });
  password.matches = selector => { assert.equal(selector, ":placeholder-shown"); publicReads++; return false; };
  observer.syncControl(text, { value: "searched text" });
  observer.syncControl(textarea, { value: "A".repeat(131073) });
  observer.syncControl(password, { empty: false });
  observer.syncControl(password, { empty: true });
  assert.equal(valueReads, 0);
  assert.equal(publicReads, 0, "the public state already read by the collector is reused");
  observer.syncControl(password, { value: "password samples cannot contain searchable values" });
  assert.equal(valueReads, 0, "a password never falls back to reading its value");
  assert.equal(publicReads, 1, "without a public sample only :placeholder-shown may be read");
  assert.equal(observer.flush(), false);
  assert.equal(changes.length, 0);
});

test("synchronizing large controls preserves in-flight fingerprint progress", async t => {
  const { document, observer, changes } = setup(t, "<body><textarea></textarea></body>", {
    beforeStart(doc) { doc.querySelector("textarea").value = "A".repeat(131073); }
  });
  const control = document.querySelector("textarea");
  const synchronizations = setInterval(() => observer.syncControl(control), 5);
  t.after(() => clearInterval(synchronizations));
  await wait(180);
  observer.flush();
  assert.equal(changes.length, 0, "unchanged search reads must not reset the fingerprint baseline");
  control.value = "A".repeat(131072) + "B";
  await waitFor(() => changes.some(change => change.reasons.includes("control-value")), 3000);
  clearInterval(synchronizations);
  changes.length = 0;
  await wait(180);
  observer.flush();
  assert.equal(changes.length, 0, "the completed fingerprint remains stable after synchronization");
});

test("large text controls that become passwords are removed from fingerprint polling", async t => {
  const { document, window, observer, changes } = setup(t, "<body><input placeholder='public placeholder'></body>", {
    discoveryBudgetMs: 16,
    beforeStart(doc) { doc.querySelector("input").value = "A".repeat(9 * 1024 * 1024); }
  });
  // The initial 131,072-character slice cannot finish this 9 Mi public value, so
  // changing the type must also cancel a fingerprint already in flight.
  const input = document.querySelector("input");
  input.type = "password";
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, "private text");
  let privateReads = 0;
  Object.defineProperty(input, "value", { get() { privateReads++; throw new Error("password value must not be read"); } });
  observer.syncControl(input);
  await wait(180);
  observer.flush();
  assert.equal(privateReads, 0, "neither an old hash job nor a tracked control may read the new password value");
  assert.equal(changes.length, 1, "the type mutation still requests one normal refresh");
  changes.length = 0;
  for (let i = 0; i < 4; i++) { observer.syncControl(input); await wait(40); }
  observer.flush();
  assert.equal(privateReads, 0);
  assert.equal(changes.length, 0, "discarded fingerprints cannot create a refresh loop");
});

test("control synchronization ignores owned, detached, stopped and disposed inputs", t => {
  const { document, observer } = setup(t, "<body><input><div id='regex-search-container'><input></div></body>");
  let reads = 0;
  const owned = document.querySelector("#regex-search-container input"), detached = document.createElement("input");
  for (const input of [owned, detached]) Object.defineProperty(input, "value", { get() { reads++; return ""; } });
  observer.syncControl(owned); observer.syncControl(detached);
  assert.equal(reads, 0);
  const input = document.querySelector("body > input");
  observer.stop();
  Object.defineProperty(input, "value", { get() { reads++; return ""; } });
  observer.syncControl(input);
  observer.dispose();
  observer.syncControl(input);
  assert.equal(reads, 0, "inactive synchronization must not read or retain page control state");
});

test("programmatic indeterminate and custom validity states are observed", async t => {
  const { document, observer, changes } = setup(t, "<body><input type='checkbox'><input type='text'></body>");
  await wait(80);
  document.querySelector("input[type=checkbox]").indeterminate = true;
  await waitFor(() => changes.some(change => change.reasons.includes("control-value")));
  changes.length = 0;
  document.querySelector("input[type=text]").setCustomValidity("invalid");
  await waitFor(() => changes.some(change => change.reasons.includes("control-value")));
  observer.stop();
});

test("URL target, animation cancellation, resource loads and fonts can invalidate visible content", t => {
  let fonts;
  const { document, window, observer, changes } = setup(t, "<body><img><p id='text'>hello</p></body>", {
    beforeStart(doc) {
      fonts = new doc.defaultView.EventTarget();
      Object.defineProperty(doc, "fonts", { value: fonts });
    }
  });
  window.dispatchEvent(new window.Event("hashchange"));
  window.dispatchEvent(new window.Event("popstate"));
  document.getElementById("text").dispatchEvent(new window.Event("animationcancel", { bubbles: true }));
  document.getElementById("text").dispatchEvent(new window.Event("animationiteration", { bubbles: true }));
  document.getElementById("text").dispatchEvent(new window.Event("transitioncancel", { bubbles: true }));
  document.querySelector("img").dispatchEvent(new window.Event("load"));
  fonts.dispatchEvent(new window.Event("loadingdone"));
  observer.flush();
  assert.equal(changes.length, 1);
  for (const reason of ["hashchange", "popstate", "animationcancel", "animationiteration", "transitioncancel", "layout-load", "font-load"]) {
    assert.ok(changes[0].reasons.includes(reason), reason);
  }
  changes.length = 0;
  observer.stop();
  window.dispatchEvent(new window.Event("hashchange"));
  fonts.dispatchEvent(new window.Event("loadingdone"));
  assert.equal(observer.flush(), false);
  assert.equal(changes.length, 0);
});

test("CSSOM changes in sheets beyond the first 64 remain observable", async t => {
  const { document, observer, changes } = setup(t, "<body><p>text</p></body>", {
    beforeStart(doc) {
      for (let i = 0; i < 65; i++) {
        const style = doc.createElement("style");
        style.textContent = "p { color: red }";
        doc.head.append(style);
      }
    }
  });
  await wait(1700);
  observer.flush();
  changes.length = 0;
  document.styleSheets[64].insertRule("p { display: none }", 1);
  await waitFor(() => changes.some(change => change.reasons.includes("stylesheet")), 2500);
  await wait(1700);
  changes.length = 0;
  document.styleSheets[64].cssRules[0].style.color = "blue";
  await waitFor(() => changes.some(change => change.reasons.includes("cssom")), 3500);
});

function fakeMedia(doc, registry) {
  doc.defaultView.matchMedia = query => {
    if (registry.has(query)) return registry.get(query);
    const list = new doc.defaultView.EventTarget();
    const add = list.addEventListener.bind(list), remove = list.removeEventListener.bind(list);
    list.activeListeners = new Set();
    list.addEventListener = (type, listener, ...options) => {
      if (type === "change") list.activeListeners.add(listener);
      add(type, listener, ...options);
    };
    list.removeEventListener = (type, listener, ...options) => {
      if (type === "change") list.activeListeners.delete(listener);
      remove(type, listener, ...options);
    };
    list.media = query;
    list.matches = false;
    registry.set(query, list);
    return list;
  };
}

test("system media-query changes refresh without DOM edits or a window resize", async t => {
  const registry = new Map();
  const { document, window, observer, changes } = setup(t,
    "<head><style>@media (prefers-color-scheme: dark) { p { display:none } }</style></head><body><p>text</p></body>", {
      beforeStart(doc) { fakeMedia(doc, registry); }
    });
  await waitFor(() => registry.has("(prefers-color-scheme: dark)"));
  changes.length = 0;
  const list = registry.get("(prefers-color-scheme: dark)");
  list.matches = true;
  list.dispatchEvent(new window.Event("change"));
  observer.flush();
  assert.equal(changes.length, 1);
  assert.ok(changes[0].reasons.includes("media-query"));
  changes.length = 0;
  document.querySelector("style").remove();
  observer.flush();
  await wait(120);
  observer.flush();
  changes.length = 0;
  list.dispatchEvent(new window.Event("change"));
  observer.flush();
  assert.equal(changes.length, 0, "removed stylesheet must release its media listeners");
});

test("stylesheet media changes observe every condition and clean up listeners", async t => {
  const registry = new Map(), media = { mediaText: "screen" };
  const { document, window, observer, changes } = setup(t,
    "<head><style>@media (prefers-color-scheme: dark) { p { color:red } } @media (prefers-reduced-motion: reduce) { p { color:blue } }</style></head><body><p>text</p></body>", {
      maxMediaQueries: 1, maxMediaReferences: 1, maxCSSStateSheets: 1,
      beforeStart(doc) {
        fakeMedia(doc, registry);
        Object.defineProperty(doc.styleSheets[0], "media", { value: media });
      }
    });
  await waitFor(() => registry.size === 3);
  await wait(50);
  observer.flush();
  changes.length = 0;
  media.mediaText = "print";
  await waitFor(() => changes.some(change => change.reasons.includes("stylesheet")));
  await waitFor(() => registry.has("print"));
  assert.equal(Array.from(registry.values()).reduce((count, list) => count + list.activeListeners.size, 0), 3,
    "legacy count options cannot omit any live media condition");
  changes.length = 0;
  registry.get("(prefers-reduced-motion: reduce)").dispatchEvent(new window.Event("change"));
  observer.flush();
  assert.ok(changes.some(change => change.reasons.includes("media-query")));
  observer.stop();
  assert.equal(Array.from(registry.values()).reduce((count, list) => count + list.activeListeners.size, 0), 0);
  changes.length = 0;
  document.querySelector("style").remove();
  observer.start();
  for (const list of registry.values()) list.dispatchEvent(new window.Event("change"));
  observer.flush();
  assert.equal(changes.length, 0, "old media listeners cannot invalidate the restarted observer");
});

test("all connected roots remain observed without eviction or a root count quota", async t => {
  const { document, observer, changes } = setup(t, "<body><div id='old'></div><div id='fresh'></div></body>", {
    maxRoots: 1, discoveryBudgetMs: 16
  });
  const old = document.getElementById("old").attachShadow({ mode: "open" });
  old.innerHTML = "<p>old boundary</p>";
  observer.updateRoots([document, old]);
  observer.flush();
  document.getElementById("old").hidden = true;
  const fresh = document.getElementById("fresh").attachShadow({ mode: "open" });
  fresh.innerHTML = "<p>new boundary</p>";
  observer.updateRoots([document, fresh]);
  observer.flush();
  changes.length = 0;
  fresh.querySelector("p").firstChild.nodeValue = "new update";
  observer.flush();
  assert.equal(changes.length, 1);
  assert.ok(changes[0].roots.includes(fresh));
  assert.ok(changes[0].roots.includes(old));
  changes.length = 0;
  await wait(100);
  observer.flush();
  assert.equal(changes.length, 0, "discovery must not churn connected roots");
  old.querySelector("p").textContent = "still observed old update";
  observer.flush();
  assert.equal(changes.length, 1);
  assert.ok(changes[0].roots.includes(old));
});

test("roots share one observer per Document and cleanup preserves the remaining roots", async t => {
  let observersCreated = 0;
  const { document, observer, changes } = setup(t, "<body><div id='first'></div><div id='last'></div></body>", {
    maxRoots: 1,
    beforeStart(doc) {
      const NativeObserver = doc.defaultView.MutationObserver;
      doc.defaultView.MutationObserver = class extends NativeObserver {
        constructor(callback) { super(callback); observersCreated += 1; }
      };
    }
  });
  const first = document.getElementById("first").attachShadow({ mode: "open" });
  const last = document.getElementById("last").attachShadow({ mode: "open" });
  first.innerHTML = "<p>first</p>";
  last.innerHTML = "<p>last</p>";
  observer.updateRoots([first, last]);
  assert.equal(observersCreated, 1, "shadow roots use the owning document's observer");
  document.getElementById("first").remove();
  observer.flush();
  await wait(80);
  observer.flush();
  changes.length = 0;
  last.querySelector("p").firstChild.nodeValue = "still observed";
  observer.flush();
  assert.equal(changes.length, 1);
  assert.ok(changes[0].roots.includes(last));
  assert.ok(!changes[0].roots.includes(first));
  document.body.dataset.stillObserved = "yes";
  observer.flush();
  assert.equal(changes.length, 2, "reconnecting shared observers retains Document observation");
});

test("stylesheet count options cannot hide later sheets from CSSOM polling", async t => {
  const { document, observer, changes } = setup(t,
    "<head><style>p{color:red}</style><style>p{color:green}</style><style>p{color:blue}</style></head><body><p>text</p></body>",
    { maxStylesheets: 1 });
  await wait(160);
  observer.flush();
  changes.length = 0;
  document.styleSheets[2].insertRule("p{display:none}", 1);
  await waitFor(() => changes.some(change => change.reasons.includes("stylesheet")));
  await wait(160);
  observer.flush();
  changes.length = 0;
  document.styleSheets[2].cssRules[0].style.color = "orange";
  await waitFor(() => changes.some(change => change.reasons.includes("cssom")));
});

test("deep CSS grouping rules and long media conditions remain observable", async t => {
  const registry = new Map();
  const query = "(min-width: 0px)" + " and (min-width: 0px)".repeat(150);
  let declaration = "p:hover{color:red}";
  const leaf = { type: 1, selectorText: "p:hover", get cssText() { return declaration; } };
  let nested = { type: 4, conditionText: query, cssRules: [leaf] };
  for (let i = 0; i < 160; i++) {
    nested = { type: 12, conditionText: "(display: block)", cssText: "unchanged group text", cssRules: [nested] };
  }
  const sheet = { cssRules: [nested], disabled: false };
  const { document, window, observer, changes } = setup(t, "<body><p id='text'>hello</p></body>", {
    maxStylesheets: 1, maxMediaQueries: 1, maxMediaReferences: 1, maxCSSStateSheets: 1,
    beforeStart(doc) {
      fakeMedia(doc, registry);
      Object.defineProperty(doc, "adoptedStyleSheets", { value: [sheet] });
    }
  });
  await waitFor(() => registry.has(query));
  observer.flush();
  changes.length = 0;
  registry.get(query).dispatchEvent(new window.Event("change"));
  document.getElementById("text").dispatchEvent(new window.Event("pointerover", { bubbles: true }));
  observer.flush();
  assert.ok(changes.some(change => change.reasons.includes("media-query")));
  assert.ok(changes.some(change => change.reasons.includes("pointerover")));
  changes.length = 0;
  declaration = "p:hover{color:blue}";
  await waitFor(() => changes.some(change => change.reasons.includes("cssom")));
});

test("shared media and hover subscriptions survive removal of another root", async t => {
  const registry = new Map();
  const sheet = { cssRules: [{ type: 4, conditionText: "(min-width: 1px)", cssRules: [
    { type: 1, selectorText: "p:hover", cssText: "p:hover{color:red}" }
  ] }], disabled: false };
  const { document, window, observer, changes } = setup(t, "<body><div id='first'></div><div id='last'></div></body>", {
    maxRoots: 1, maxMediaReferences: 1, maxCSSStateSheets: 1,
    beforeStart(doc) { fakeMedia(doc, registry); }
  });
  const first = document.getElementById("first").attachShadow({ mode: "open" });
  const last = document.getElementById("last").attachShadow({ mode: "open" });
  for (const root of [first, last]) {
    root.innerHTML = "<p>text</p>";
    Object.defineProperty(root, "adoptedStyleSheets", { value: [sheet] });
  }
  observer.updateRoots([first, last]);
  await wait(180);
  assert.ok(registry.has("(min-width: 1px)"));
  document.getElementById("first").remove();
  observer.flush();
  await wait(120);
  observer.flush();
  changes.length = 0;
  registry.get("(min-width: 1px)").dispatchEvent(new window.Event("change"));
  last.querySelector("p").dispatchEvent(new window.Event("pointerover", { bubbles: true, composed: true }));
  observer.flush();
  assert.ok(changes.some(change => change.reasons.includes("media-query")));
  assert.ok(changes.some(change => change.reasons.includes("pointerover")));
});

test("pointer states refresh pages with hover/active selectors and release removed styles", async t => {
  const { document, window, observer, changes } = setup(t,
    "<head><style>p:hover, p:has(button:active) { display:none }</style></head><body><p id='text'>hello<button>button</button></p></body>");
  await wait(100);
  observer.flush();
  changes.length = 0;
  const p = document.getElementById("text");
  p.dispatchEvent(new window.Event("pointerover", { bubbles: true }));
  p.querySelector("button").dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
  observer.flush();
  assert.equal(changes.length, 1);
  assert.ok(changes[0].reasons.includes("pointerover"));
  assert.ok(changes[0].reasons.includes("pointerdown"));
  document.querySelector("style").remove();
  await wait(100);
  observer.flush();
  changes.length = 0;
  p.dispatchEvent(new window.Event("pointerout", { bubbles: true }));
  p.querySelector("button").dispatchEvent(new window.Event("pointerup", { bubbles: true }));
  observer.flush();
  assert.equal(changes.length, 0);
});

test("pointer movement on a page without CSS state selectors does not trigger Auto", async t => {
  const { document, window, observer, changes } = setup(t,
    "<head><style>p { display:block }</style></head><body><p id='text'>hello</p></body>");
  await wait(80);
  const p = document.getElementById("text");
  for (const type of ["pointerover", "pointerout", "pointerdown", "pointerup", "pointercancel"]) {
    p.dispatchEvent(new window.Event(type, { bubbles: true }));
  }
  observer.flush();
  assert.equal(changes.length, 0);
});

test("custom-element definitions invalidate :defined styles without DOM mutations", async t => {
  const { window, observer, changes } = setup(t,
    "<head><style>x-searchable:defined { display:none }</style></head><body><x-searchable>hello</x-searchable></body>");
  await wait(80);
  window.customElements.define("x-searchable", class extends window.HTMLElement {});
  await waitFor(() => changes.some(change => change.reasons.includes("custom-definition")));
  changes.length = 0;
  await wait(80);
  observer.flush();
  assert.equal(changes.length, 0, "an already upgraded custom element must remain stable");
});
