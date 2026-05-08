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
  assert.ok(!doc.getElementById("t").innerHTML.includes("regex-rabbit-highlight"));
});
