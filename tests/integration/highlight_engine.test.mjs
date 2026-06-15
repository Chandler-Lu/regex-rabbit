import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const source = await readFile("infra/highlight_engine.js", "utf8");

function setup() {
  const dom = new JSDOM('<body><p id="t">hello world</p></body>', { url: "https://test.com" });
  const doc = dom.window.document;
  globalThis.document = doc;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.Text = dom.window.Text;
  globalThis.scheduler = undefined;
  globalThis.performance = { now: () => Date.now() };
  const scope = {};
  new Function("globalThis", source)(scope);
  return scope.RRHighlightEngine;
}

test("render creates mark for valid match", () => {
  const eng = setup();
  const doc = globalThis.document;
  const tn = doc.getElementById("t").firstChild;
  const r = eng.renderMatches([{ id: 0, node: tn, text: "hello world" }], [{ chunkId: 0, start: 0, end: 5, text: "hello" }]);
  assert.equal(r.marks.length, 1);
  assert.equal(r.marks[0].textContent, "hello");
});

test("param order: (indexedNodes, matches) correct", () => {
  const eng = setup();
  const doc = globalThis.document;
  const tn = doc.getElementById("t").firstChild;
  const r = eng.renderMatches([{ id: 0, node: tn, text: "hello world" }], [{ chunkId: 0, start: 6, end: 11, text: "world" }]);
  assert.equal(r.marks[0].textContent, "world");
});

test("render preserves DOM order even when worker matches are out of order", () => {
  const eng = setup();
  const doc = globalThis.document;
  doc.body.innerHTML = "<p id='a'>first</p><p id='b'>second</p><p id='c'>third</p>";
  const first = doc.getElementById("a").firstChild;
  const second = doc.getElementById("b").firstChild;
  const third = doc.getElementById("c").firstChild;

  const r = eng.renderMatches(
    [
      { id: 0, node: first, text: "first" },
      { id: 1, node: second, text: "second" },
      { id: 2, node: third, text: "third" }
    ],
    [
      { chunkId: 2, start: 0, end: 5 },
      { chunkId: 1, start: 0, end: 6 },
      { chunkId: 0, start: 0, end: 5 }
    ]
  );

  assert.deepEqual(r.marks.map(mark => mark.textContent), ["first", "second", "third"]);
});

test("batched render preserves DOM order even when worker matches are out of order", async () => {
  const eng = setup();
  const doc = globalThis.document;
  doc.body.innerHTML = "<p id='a'>first</p><p id='b'>second</p><p id='c'>third</p>";
  const first = doc.getElementById("a").firstChild;
  const second = doc.getElementById("b").firstChild;
  const third = doc.getElementById("c").firstChild;

  const r = await eng.renderMatchesBatched(
    [
      { id: 0, node: first, text: "first" },
      { id: 1, node: second, text: "second" },
      { id: 2, node: third, text: "third" }
    ],
    [
      { chunkId: 2, start: 0, end: 5 },
      { chunkId: 1, start: 0, end: 6 },
      { chunkId: 0, start: 0, end: 5 }
    ],
    { batchSize: 1, budgetMs: 1 }
  );

  assert.deepEqual(r.marks.map(mark => mark.textContent), ["first", "second", "third"]);
});

test("out-of-bounds match filtered", () => {
  const eng = setup();
  const doc = globalThis.document;
  const tn = doc.getElementById("t").firstChild;
  const r = eng.renderMatches([{ id: 0, node: tn, text: "hi" }], [{ chunkId: 0, start: 0, end: 100 }]);
  assert.equal(r.marks.length, 0);
});

test("overlap → first wins", () => {
  const eng = setup();
  const doc = globalThis.document;
  const tn = doc.getElementById("t").firstChild;
  const r = eng.renderMatches([{ id: 0, node: tn, text: "abcdefgh" }], [
    { chunkId: 0, start: 0, end: 5 }, { chunkId: 0, start: 2, end: 7 }
  ]);
  assert.equal(r.marks.length, 1);
});

test("removeHighlights restores text", () => {
  const eng = setup();
  const doc = globalThis.document;
  const tn = doc.getElementById("t").firstChild;
  const r = eng.renderMatches([{ id: 0, node: tn, text: "hello" }], [{ chunkId: 0, start: 0, end: 5 }]);
  eng.removeHighlights(r.handles);
  assert.ok(!doc.getElementById("t").innerHTML.includes("regex-search-highlight"));
});

test("removeHighlights restores rendered ranges without parent normalize", () => {
  const eng = setup();
  const doc = globalThis.document;
  const parent = doc.getElementById("t");
  const tn = parent.firstChild;
  let normalizeCalls = 0;
  parent.normalize = function () { normalizeCalls += 1; };

  const r = eng.renderMatches(
    [{ id: 0, node: tn, text: "hello world" }],
    [
      { chunkId: 0, start: 0, end: 5 },
      { chunkId: 0, start: 6, end: 11 }
    ]
  );

  eng.removeHighlights(r.handles);

  assert.equal(parent.textContent, "hello world");
  assert.equal(parent.querySelectorAll(".regex-search-highlight").length, 0);
  assert.equal(normalizeCalls, 0);
});

test("renderMatchesBatched cancellation rolls back rendered marks", async () => {
  const eng = setup();
  const doc = globalThis.document;
  doc.body.innerHTML = "<p id='a'>alpha</p><p id='b'>bravo</p>";
  const first = doc.getElementById("a").firstChild;
  const second = doc.getElementById("b").firstChild;
  let calls = 0;

  const r = await eng.renderMatchesBatched(
    [
      { id: 0, node: first, text: "alpha" },
      { id: 1, node: second, text: "bravo" }
    ],
    [
      { chunkId: 0, start: 0, end: 5 },
      { chunkId: 1, start: 0, end: 5 }
    ],
    {
      batchSize: 1,
      budgetMs: 1,
      shouldContinue() {
        calls += 1;
        return calls < 2;
      }
    }
  );

  assert.equal(r.cancelled, true);
  assert.ok(!doc.body.innerHTML.includes("regex-search-highlight"));
  assert.equal(doc.getElementById("a").textContent, "alpha");
});
