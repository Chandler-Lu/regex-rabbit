import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

// ── MutationObserver debounce integration test ──

function setup() {
  const dom = new JSDOM('<body><p id="content">hello</p></body>', { url: "https://test.com" });
  return { document: dom.window.document, MutationObserver: dom.window.MutationObserver };
}

test("MutationObserver fires on text insertion", async () => {
  const { document, MutationObserver } = setup();
  const changes = [];

  const observer = new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      changes.push(mutations[i].type);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  // Insert new text node
  const p = document.createElement("p");
  p.textContent = "new text";
  document.body.appendChild(p);

  // Need to wait for microtask for observer to fire
  await new Promise(function (r) { setTimeout(r, 10); });

  assert.ok(changes.includes("childList"), "should detect childList mutation");
  observer.disconnect();
});

test("MutationObserver fires on text content change", async () => {
  const { document, MutationObserver } = setup();
  const changes = [];

  const observer = new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      changes.push(mutations[i].type);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  // Change existing text
  var textNode = document.getElementById("content").firstChild;
  textNode.nodeValue = "updated text";

  await new Promise(function (r) { setTimeout(r, 10); });

  assert.ok(changes.includes("characterData"), "should detect characterData mutation");
  observer.disconnect();
});

test("MutationObserver: disconnect stops observing", async () => {
  const { document, MutationObserver } = setup();
  var fired = false;

  const observer = new MutationObserver(function () { fired = true; });
  observer.observe(document.body, { childList: true, subtree: true });
  observer.disconnect();

  const p = document.createElement("p");
  p.textContent = "should not fire";
  document.body.appendChild(p);

  await new Promise(function (r) { setTimeout(r, 20); });
  assert.equal(fired, false);
});

test("MutationObserver: attributes: false skips attribute changes", async () => {
  const { document, MutationObserver } = setup();
  var fired = false;

  const observer = new MutationObserver(function () { fired = true; });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: false });

  document.body.setAttribute("data-test", "value");

  await new Promise(function (r) { setTimeout(r, 10); });
  assert.equal(fired, false, "should not fire for attribute changes when attributes:false");
  observer.disconnect();
});

test("debounced search: multiple rapid mutations yield single call", async () => {
  const { document, MutationObserver } = setup();
  var searchCount = 0;
  var timer = null;

  function scheduleSearch(debounceMs) {
    clearTimeout(timer);
    timer = setTimeout(function () { timer = null; searchCount++; }, debounceMs);
  }

  const observer = new MutationObserver(function () { scheduleSearch(100); });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  // Rapid mutations
  for (var i = 0; i < 10; i++) {
    var p = document.createElement("p");
    p.textContent = "text " + i;
    document.body.appendChild(p);
    await new Promise(function (r) { setTimeout(r, 5); });
  }

  // Wait for debounce timeout
  await new Promise(function (r) { setTimeout(r, 200); });

  assert.equal(searchCount, 1, "should debounce multiple mutations into single search");
  observer.disconnect();
});
