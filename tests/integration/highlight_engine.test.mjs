import assert from "node:assert/strict";
import { readRuntimeSource as readFile } from "../fixtures/runtime_source.mjs";
import test from "node:test";
import { JSDOM } from "jsdom";

const source = await readFile("infra/highlight_engine.js", "utf8");
const visibilitySource = await readFile("infra/page_visibility.js", "utf8");
const mappingSource = await readFile("infra/text_mapping.js", "utf8");
const rect = (left = 20, top = 20, width = 80, height = 20) => ({
  left, top, right: left + width, bottom: top + height, width, height, x: left, y: top
});

function installGeometry(win) {
  win.Range.prototype.getClientRects = function () { return this.toString().length ? [rect()] : []; };
  win.Range.prototype.getBoundingClientRect = () => rect();
  win.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  win.Element.prototype.getBoundingClientRect = () => rect();
  win.Element.prototype.scrollIntoView = function () {};
  win.scrollBy = function () {};
}

function setup({ native = true, html = '<p id="t">hello world</p>', timers = null, clock = performance } = {}) {
  const dom = new JSDOM(`<body>${html}</body>`, { url: "https://test.com", pretendToBeVisual: true });
  const doc = dom.window.document;
  installGeometry(dom.window);
  const registry = new Map();
  if (native) {
    dom.window.CSS = { highlights: registry };
    dom.window.Highlight = class Highlight extends Set {};
  }
  const scope = { document: doc };
  new Function("globalThis", visibilitySource)(scope);
  new Function("globalThis", mappingSource)(scope);
  new Function("globalThis", "setTimeout", "clearTimeout", "performance", source)(scope,
    timers ? timers.setTimeout : setTimeout, timers ? timers.clearTimeout : clearTimeout, clock);
  const engine = scope.RRHighlightEngine;
  const entries = () => [{ id: 0, node: doc.getElementById("t").firstChild, text: doc.getElementById("t").textContent }];
  const render = (matches = [{ chunkId: 0, start: 0, end: 5 }]) => engine.renderMatches(entries(), matches);
  return { dom, doc, engine, entries, registry, render, scope };
}

function dispose(env, result) {
  env.engine.removeHighlights(result.handles);
  env.dom.window.close();
}

test("native highlights preserve text-node identity, DOM and existing page registry", () => {
  const env = setup();
  const node = env.entries()[0].node;
  const html = env.doc.body.innerHTML;
  const ownHighlight = new env.dom.window.Highlight();
  env.registry.set("page-owned", ownHighlight);
  const result = env.render();
  assert.equal(result.marks.length, 1);
  assert.equal(result.marks[0].textContent, "hello");
  assert.equal(env.entries()[0].node, node);
  assert.equal(env.doc.body.innerHTML, html);
  assert.equal(env.registry.size, 3);
  assert.equal(env.registry.get("page-owned"), ownHighlight);
  dispose(env, result);
  assert.equal(env.registry.size, 1);
  assert.equal(env.registry.get("page-owned"), ownHighlight);
});

test("cross-inline matches map to one DOM Range without wrapping page nodes", () => {
  const env = setup({ html: '<p id="t">hello <strong>wo</strong>rld</p>' });
  const parent = env.doc.getElementById("t");
  const first = parent.firstChild, middle = parent.children[0].firstChild, last = parent.lastChild;
  const result = env.engine.renderMatches([{
    id: 0, node: first, text: "hello world", segments: [
      { node: first, start: 0, end: 6 }, { node: middle, start: 6, end: 8 }, { node: last, start: 8, end: 11 }
    ]
  }], [{ chunkId: 0, start: 3, end: 10 }]);
  assert.equal(result.marks.length, 1);
  const ranges = result.marks[0].ranges;
  assert.equal(ranges.map(range => range.toString()).join(""), "lo worl");
  assert.equal(ranges[0].startContainer, first);
  assert.equal(ranges[0].startOffset, 3);
  assert.equal(ranges.at(-1).endContainer, last);
  assert.equal(ranges.at(-1).endOffset, 2);
  dispose(env, result);
  assert.equal(parent.firstChild, first);
  assert.equal(parent.children[0].firstChild, middle);
  assert.equal(parent.lastChild, last);
});

test("collector slices address original text using nodeStart and nodeEnd", () => {
  const env = setup();
  const node = env.entries()[0].node;
  const result = env.engine.renderMatches([{
    id: 0, node, text: "world", segments: [{ node, start: 0, end: 5, nodeStart: 6, nodeEnd: 11 }]
  }], [{ chunkId: 0, start: 1, end: 4 }]);
  assert.equal(result.marks[0].range.toString(), "orl");
  assert.equal(result.marks[0].range.startOffset, 7);
  assert.equal(result.marks[0].range.endOffset, 10);
  dispose(env, result);
});

test("bound matches keep immutable source references and read displayed text only on demand", () => {
  const env = setup({ html: '<p id="t">before hello    world after</p>' });
  const node = env.entries()[0].node, raw = node.nodeValue;
  env.dom.window.Range.prototype.getClientRects = () => [rect()];
  env.dom.window.Range.prototype.toString = () => { throw new Error("rendering must not materialize a bound match"); };
  let reads = 0;
  const originalRead = env.scope.RRTextMapping.readBoundText;
  env.scope.RRTextMapping.readBoundText = spans => { reads++; return originalRead(spans); };
  const spans = [
    { nodeStart: 7, nodeEnd: 12, start: 0, end: 5 },
    { nodeStart: 12, nodeEnd: 16, start: 5, end: 6 },
    { nodeStart: 16, nodeEnd: 21, start: 6, end: 11 }
  ].map(part => ({ node, rawSnapshot: raw, snapshotStart: part.nodeStart, snapshotEnd: part.nodeEnd, whiteSpace: "normal", textTransform: "none", collapseMode: "collapse", actualTransform: "none", ...part }));
  const result = env.engine.renderMatches([{ id: 0, kind: "bound-text", node, boundSpans: spans, displayLength: 11 }], [{ chunkId: 0, start: 0, end: 11 }]);
  assert.equal(result.marks.length, 1);
  const mark = result.marks[0];
  assert.equal(reads, 0);
  assert.equal(mark.ranges.length, 1);
  assert.equal(mark.range.startOffset, 7);
  assert.equal(mark.range.endOffset, 21);
  assert.equal(mark.boundSpans[0].rawSnapshot, raw);
  assert.equal(Object.getOwnPropertyDescriptor(mark, "textContent").value, undefined);
  assert.equal(mark.textContent, "hello world");
  assert.equal(reads, 1);
  assert.equal(mark.isConnected, true);
  assert.equal(reads, 1);
  dispose(env, result);
});

test("bound source maps support selected snapshots with different raw and node bases", () => {
  const env = setup();
  const node = env.entries()[0].node;
  const result = env.engine.renderMatches([{
    id: 0, kind: "bound-text", node, displayLength: 5, boundSpans: [{ node, nodeStart: 6, nodeEnd: 11,
      rawSnapshot: "world", snapshotStart: 0, snapshotEnd: 5, start: 0, end: 5, whiteSpace: "normal", textTransform: "none" }]
  }], [{ chunkId: 0, start: 0, end: 5 }]);
  assert.equal(result.marks.length, 1);
  assert.equal(result.marks[0].textContent, "world");
  assert.equal(result.marks[0].range.startOffset, 6);
  node.nodeValue = "hello changed";
  assert.equal(result.marks[0].isConnected, false);
  dispose(env, result);
});

test("bound source coverage rejects gaps, invalid offsets and stale source snapshots", () => {
  const env = setup(), node = env.entries()[0].node;
  const good = { node, nodeStart: 0, nodeEnd: 5, rawSnapshot: "hello world", snapshotStart: 0, snapshotEnd: 5, start: 0, end: 5 };
  for (const changes of [{ start: 1 }, { end: 4 }, { nodeStart: -1 }, { snapshotEnd: 4 }, { rawSnapshot: "stale world" }, { nodeEnd: 100 }]) {
    const result = env.engine.renderMatches([{ id: 0, kind: "bound-text", node, displayLength: 5, boundSpans: [{ ...good, ...changes }] }], [{ chunkId: 0, start: 0, end: 5 }]);
    assert.equal(result.marks.length, 0, JSON.stringify(changes));
    assert.equal(env.registry.size, 0);
  }
  env.dom.window.close();
});

test("bound display mappings invalidate when only white-space-collapse changes", () => {
  const env = setup({ html: '<p id="t">hello world</p>' }), node = env.entries()[0].node;
  const result = env.engine.renderMatches([{ id: 0, kind: "bound-text", node, displayLength: 5,
    boundSpans: [{ node, nodeStart: 0, nodeEnd: 5, rawSnapshot: node.nodeValue, snapshotStart: 0, snapshotEnd: 5,
      start: 0, end: 5, whiteSpace: "normal", textTransform: "none", collapseMode: "collapse" }] }], [{ chunkId: 0, start: 0, end: 5 }]);
  assert.equal(result.marks.length, 1);
  env.doc.getElementById("t").style.setProperty("white-space-collapse", "preserve");
  assert.equal(result.marks[0].isConnected, false);
  dispose(env, result);
});

test("nonbreaking spaces cannot be submitted as collapsed ordinary whitespace", () => {
  const env = setup({ html: '<p id="t">\u00a0\u00a0</p>' }), node = env.entries()[0].node;
  const result = env.engine.renderMatches([{ id: 0, node, text: " ", segments: [{ node, start: 0, end: 1,
    nodeStart: 0, nodeEnd: 2, sourceText: node.nodeValue }] }], [{ chunkId: 0, start: 0, end: 1 }]);
  assert.equal(result.marks.length, 0);
  dispose(env, result);
});

test("bound controls preserve absolute selection without storing a displayed value copy", () => {
  const env = setup({ html: '<textarea id="control" style="text-transform:uppercase">before public after</textarea>' });
  const node = env.doc.getElementById("control"), raw = node.value;
  const result = env.engine.renderMatches([{ id: 0, kind: "control", node, displayLength: 6,
    controlOffset: 7, snapshotStart: 7, snapshotEnd: 13, displayTextSnapshot: raw,
    textTransform: "uppercase", controlTransform: "uppercase" }], [{ chunkId: 0, start: 0, end: 6 }]);
  assert.equal(result.marks.length, 1);
  assert.equal(result.marks[0].displaySnapshot, null);
  assert.equal(result.marks[0].valueSnapshot, raw);
  assert.equal(result.marks[0].textContent, "PUBLIC");
  assert.equal(env.engine.navigate(result.marks[0]), true);
  assert.equal(node.selectionStart, 7);
  assert.equal(node.selectionEnd, 13);
  node.value = "changed";
  assert.equal(result.marks[0].isConnected, false);
  dispose(env, result);
});

test("bound match validation yields inside long source spans and cancels without publication", async () => {
  const env = setup({ html: '<p id="t"></p>' }), node = env.doc.createTextNode(" ".repeat(1_100_000));
  env.doc.getElementById("t").appendChild(node);
  let checkpoints = 0;
  const result = await env.engine.renderMatchesBatched([{ id: 0, kind: "bound-text", node, displayLength: 1,
    boundSpans: [{ node, nodeStart: 0, nodeEnd: node.length, rawSnapshot: node.nodeValue, snapshotStart: 0, snapshotEnd: node.length,
      start: 0, end: 1, whiteSpace: "normal", textTransform: "none", collapseMode: "collapse" }] }], [{ chunkId: 0, start: 0, end: 1 }],
  { batchSize: 1, shouldContinue: () => ++checkpoints < 3 });
  assert.equal(result.cancelled, true);
  assert.equal(env.registry.size, 0);
  assert.equal(env.doc.querySelectorAll("[data-regex-rabbit-owned]").length, 0);
  env.dom.window.close();
});

test("malformed, disjoint and stale segment maps are rejected", () => {
  const env = setup();
  const node = env.entries()[0].node;
  for (const entry of [
    { id: 0, node, text: "outdated" },
    { id: 0, node, text: "hello world", segments: [{ node, start: 1, end: 11 }] },
    { id: 0, node, text: "hello world", segments: [{ node, start: 0, end: 11, nodeStart: -1 }] }
  ]) {
    const result = env.engine.renderMatches([entry], [{ chunkId: 0, start: 0, end: 5 }]);
    assert.equal(result.marks.length, 0);
    assert.equal(env.registry.size, 0);
  }
  env.dom.window.close();
});

test("invalid worker offsets and overlapping matches do not create results", () => {
  const env = setup();
  const result = env.render([
    { chunkId: 0, start: -1, end: 3 }, { chunkId: 0, start: 0, end: 5 },
    { chunkId: 0, start: 2, end: 7 }, { chunkId: 0, start: 7, end: 999 },
    { chunkId: 0, start: 5, end: 5 }, { chunkId: 0, start: 0.5, end: 3 }
  ]);
  assert.equal(result.marks.length, 1);
  dispose(env, result);
});

test("result order follows entries even when worker matches are reversed", async () => {
  for (const batched of [false, true]) {
    const env = setup({ html: "<p>first</p><p>second</p><p>third</p>" });
    const entries = Array.from(env.doc.querySelectorAll("p"), (element, id) => ({ id, node: element.firstChild, text: element.textContent }));
    const matches = [2, 1, 0].map(id => ({ chunkId: id, start: 0, end: entries[id].text.length }));
    const result = batched ? await env.engine.renderMatchesBatched(entries, matches, { batchSize: 1 }) : env.engine.renderMatches(entries, matches);
    assert.deepEqual(result.marks.map(mark => mark.textContent), ["first", "second", "third"]);
    dispose(env, result);
  }
});

test("current highlight updates registry without DOM or selection mutations", () => {
  const env = setup();
  const selection = env.dom.window.getSelection();
  const initial = env.doc.createRange();
  initial.selectNodeContents(env.doc.getElementById("t"));
  selection.addRange(initial);
  const result = env.render([{ chunkId: 0, start: 0, end: 5 }, { chunkId: 0, start: 6, end: 11 }]);
  const [first, second] = result.marks;
  first.classList.add("current");
  assert.equal(first.classList.contains("current"), true);
  second.classList.add("current");
  assert.equal(first.classList.contains("current"), false);
  assert.equal(second.classList.contains("current"), true);
  assert.deepEqual(Array.from(second.state.current), [second.range]);
  assert.equal(selection.toString(), "hello world");
  second.classList.remove("current");
  assert.equal(second.state.current.size, 0);
  dispose(env, result);
});

test("hidden elements and zero-area ranges are not counted", () => {
  for (const style of ["display:none", "visibility:hidden", "opacity:0", "content-visibility:hidden"]) {
    const env = setup({ html: `<p id="t" style="${style}">hello world</p>` });
    const result = env.render();
    assert.equal(result.marks.length, 0, style);
    dispose(env, result);
  }
  const env = setup();
  env.dom.window.Range.prototype.getClientRects = () => [rect(20, 20, 0, 20)];
  const result = env.render();
  assert.equal(result.marks.length, 0);
  dispose(env, result);
});

test("ranges fully outside overflow:hidden clipping are not counted", () => {
  const env = setup({ html: '<p id="t" style="overflow:hidden">hello world</p>' });
  env.doc.getElementById("t").getBoundingClientRect = () => rect(0, 0, 10, 10);
  const result = env.render();
  assert.equal(result.marks.length, 0);
  dispose(env, result);
});

test("offscreen ranges remain searchable for later navigation", () => {
  const env = setup();
  env.dom.window.Range.prototype.getClientRects = () => [rect(20, 3000)];
  const result = env.render();
  assert.equal(result.marks.length, 1);
  dispose(env, result);
});

test("painted rectangles after the former 512-rectangle boundary can be counted and located", async () => {
  const env = setup();
  env.dom.window.Range.prototype.getClientRects = () => [...Array.from({ length: 600 }, () => rect(0, 0, 0, 0)), rect()];
  const result = await env.engine.renderMatchesBatched(env.entries(), [{ chunkId: 0, start: 0, end: 5 }], { batchSize: 1 });
  assert.equal(result.marks.length, 1);
  assert.equal(env.engine.navigate(result.marks[0]), true);
  dispose(env, result);
});

test("nested navigation reaches scroll ancestors beyond 256 levels", () => {
  const env = setup({ html: '<div id="outer" style="overflow:auto"></div>' });
  const outer = env.doc.getElementById("outer");
  let parent = outer;
  for (let i = 0; i < 280; i++) { const child = env.doc.createElement("span"); parent.appendChild(child); parent = child; }
  parent.textContent = "hello";
  for (const [name, value] of Object.entries({ clientWidth: 200, offsetWidth: 200, clientHeight: 100, offsetHeight: 100, scrollHeight: 1000 }))
    Object.defineProperty(outer, name, { configurable: true, value });
  outer.getBoundingClientRect = () => rect(0, 0, 200, 100);
  const scrolls = [];
  outer.scrollBy = options => { scrolls.push(options); outer.scrollTop += options.top; };
  env.dom.window.Range.prototype.getClientRects = () => [rect(20, 700 - outer.scrollTop)];
  const result = env.engine.renderMatches([{ id: 0, node: parent.firstChild, text: "hello" }], [{ chunkId: 0, start: 0, end: 5 }]);
  assert.equal(result.marks.length, 1);
  assert.equal(env.engine.navigate(result.marks[0]), true);
  assert.equal(scrolls.length, 1);
  assert.ok(scrolls[0].top > 500);
  dispose(env, result);
});

test("more than 512 composed roots share one observer per document and remain searchable", () => {
  const env = setup({ html: '<div id="roots"></div>' });
  const OriginalObserver = env.dom.window.MutationObserver;
  let created = 0, disconnected = 0;
  env.dom.window.MutationObserver = class extends OriginalObserver {
    constructor(callback) { super(callback); created++; }
    disconnect() { disconnected++; super.disconnect(); }
  };
  const guard = env.engine.createCollectionGuard();
  const roots = [];
  for (let i = 0; i < 520; i++) {
    const host = env.doc.createElement("span");
    env.doc.getElementById("roots").appendChild(host);
    const root = host.attachShadow({ mode: "closed" }); root.textContent = "hello";
    roots.push(root);
  }
  roots.forEach(root => guard.addRoot(root));
  const entry = { id: 0, node: roots.at(-1).firstChild, text: "hello" };
  assert.equal(created, 1);
  assert.equal(guard.isEntryCurrent(entry), true);
  const result = env.engine.renderMatches([entry], [{ chunkId: 0, start: 0, end: 5 }], { collectionGuard: guard });
  assert.equal(result.marks.length, 1);
  assert.equal(created, 2, "rendering and collection each reuse their own document observer");
  guard.dispose(); dispose(env, result);
  assert.equal(disconnected, 2);
});

test("composed observation follows shadow ancestry beyond 256 roots", () => {
  const env = setup({ html: '<div id="outer"></div>' });
  let host = env.doc.getElementById("outer"), root;
  for (let i = 0; i < 270; i++) {
    root = host.attachShadow({ mode: "closed" });
    host = env.doc.createElement("span"); root.appendChild(host);
  }
  host.textContent = "hello";
  const guard = env.engine.createCollectionGuard(); guard.addRoot(root);
  const entry = { id: 0, node: host.firstChild, text: "hello" };
  assert.equal(guard.isEntryCurrent(entry), true);
  const result = env.engine.renderMatches([entry], [{ chunkId: 0, start: 0, end: 5 }], { collectionGuard: guard });
  assert.equal(result.marks.length, 1);
  guard.dispose(); dispose(env, result);
});

test("control results select exact offsets only when navigated and never assign values", () => {
  const env = setup({ html: '<textarea id="control">hello world</textarea>' });
  const control = env.doc.getElementById("control");
  control.setSelectionRange(0, 0);
  const result = env.engine.renderMatches([{ id: 0, kind: "control", node: control, text: control.value }], [{ chunkId: 0, start: 6, end: 11 }]);
  assert.equal(result.marks.length, 1);
  assert.equal(control.selectionStart, 0);
  assert.equal(control.selectionEnd, 0);
  assert.equal(result.marks[0].range, null);
  assert.equal(env.engine.navigate(result.marks[0]), true);
  assert.equal(control.selectionStart, 6);
  assert.equal(control.selectionEnd, 11);
  assert.equal(control.value, "hello world");
  assert.equal(env.doc.activeElement, control);
  dispose(env, result);
});

test("nearest text navigation preserves viewport, page CSS, focus and selection", () => {
  const env = setup({ html: '<input id="focus"><div style="overflow:auto;scroll-behavior:smooth"><p id="t" tabindex="0">hello world</p></div>' });
  const input = env.doc.getElementById("focus");
  input.focus();
  const selection = env.dom.window.getSelection();
  const selected = env.doc.createRange();
  selected.selectNodeContents(env.doc.getElementById("t"));
  selection.addRange(selected);
  const before = { anchor: selection.anchorNode, anchorOffset: selection.anchorOffset, focus: selection.focusNode, focusOffset: selection.focusOffset };
  env.doc.documentElement.style.scrollBehavior = "smooth";
  let scrolls = 0;
  env.dom.window.scrollBy = () => { scrolls++; };
  env.doc.getElementById("t").scrollIntoView = () => { throw new Error("must navigate the match, not the paragraph"); };
  const result = env.render();
  assert.equal(env.engine.navigate(result.marks[0], { block: "nearest", inline: "nearest", behavior: "smooth" }), true);
  assert.equal(env.engine.navigate(result.marks[0], { block: "nearest", inline: "nearest" }), true);
  assert.equal(scrolls, 0);
  assert.equal(env.doc.activeElement, input);
  assert.deepEqual({ anchor: selection.anchorNode, anchorOffset: selection.anchorOffset, focus: selection.focusNode, focusOffset: selection.focusOffset }, before);
  assert.equal(env.doc.documentElement.style.scrollBehavior, "smooth");
  dispose(env, result);
});

test("center navigation moves an already visible match once on both axes", () => {
  const env = setup();
  let x = 0, y = 0;
  env.dom.window.Range.prototype.getClientRects = () => [rect(200 - x, 150 - y)];
  const calls = [];
  env.dom.window.scrollBy = options => { calls.push(options); x += options.left; y += options.top; };
  const result = env.render();
  const options = { block: "center", inline: "center" };
  assert.equal(env.engine.navigate(result.marks[0], options), true);
  assert.equal(calls.length, 1);
  assert.equal(240 - x, env.dom.window.innerWidth / 2);
  assert.equal(160 - y, env.dom.window.innerHeight / 2);
  assert.equal(env.engine.navigate(result.marks[0], options), true);
  assert.equal(calls.length, 1);
  dispose(env, result);
});

test("offscreen text scrolls once to the matched line with instant behavior", () => {
  const env = setup();
  env.doc.documentElement.style.scrollBehavior = "smooth";
  Object.defineProperty(env.dom.window, "scrollY", { configurable: true, writable: true, value: 0 });
  env.dom.window.Range.prototype.getClientRects = () => [rect(20, 3000 - env.dom.window.scrollY)];
  // A paragraph's union box need not resemble the actual matched line.
  env.dom.window.Range.prototype.getBoundingClientRect = () => rect(20, 0, 80, 4000);
  const calls = [];
  env.dom.window.scrollBy = options => { calls.push(options); env.dom.window.scrollY += options.top; };
  env.doc.getElementById("t").scrollIntoView = () => { throw new Error("paragraph scrolling would jump twice"); };
  const result = env.render();
  assert.equal(env.engine.navigate(result.marks[0]), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].behavior, "instant");
  assert.equal(calls[0].top, 3000 + 10 - env.dom.window.innerHeight / 2);
  assert.equal(env.engine.navigate(result.marks[0]), true);
  assert.equal(calls.length, 1);
  assert.equal(env.doc.documentElement.style.scrollBehavior, "smooth");
  dispose(env, result);
});

test("nested smooth scrollers each move once and already visible matches stay put", () => {
  const env = setup({ html: '<div id="outer" style="overflow:auto;scroll-behavior:smooth"><div id="inner" style="overflow:auto;scroll-behavior:smooth"><p id="t">hello world</p></div></div>' });
  const outer = env.doc.getElementById("outer"), inner = env.doc.getElementById("inner");
  for (const [element, height] of [[outer, 200], [inner, 80]]) {
    for (const [name, value] of Object.entries({ clientWidth: 200, offsetWidth: 200, clientHeight: height, offsetHeight: height, scrollHeight: 1000 })) {
      Object.defineProperty(element, name, { configurable: true, value });
    }
  }
  outer.getBoundingClientRect = () => rect(20, 20, 200, 200);
  inner.getBoundingClientRect = () => rect(20, 380 - outer.scrollTop, 200, 80);
  env.dom.window.Range.prototype.getClientRects = () => [rect(20, 700 - outer.scrollTop - inner.scrollTop)];
  const calls = [];
  for (const element of [inner, outer]) element.scrollBy = options => {
    calls.push({ element, ...options });
    element.scrollTop += options.top;
    element.scrollLeft += options.left;
  };
  env.dom.window.scrollBy = () => { throw new Error("no viewport scroll is needed"); };
  const result = env.render();
  assert.equal(env.engine.navigate(result.marks[0], { block: "nearest", inline: "nearest" }), true);
  assert.deepEqual(calls.map(call => call.element.id), ["inner", "outer"]);
  assert.ok(calls.every(call => call.behavior === "instant"));
  assert.equal(env.engine.navigate(result.marks[0], { block: "nearest", inline: "nearest" }), true);
  assert.equal(calls.length, 2);
  assert.equal(outer.style.scrollBehavior, "smooth");
  assert.equal(inner.style.scrollBehavior, "smooth");
  dispose(env, result);
});

test("navigation maps iframe match coordinates and borders without scrolling the frame twice", () => {
  const env = setup({ html: '<iframe id="frame"></iframe>' });
  const frame = env.doc.getElementById("frame"), child = frame.contentWindow;
  child.document.body.innerHTML = '<p id="child">hello world</p>';
  installGeometry(child);
  Object.defineProperty(child, "innerHeight", { configurable: true, value: 150 });
  Object.defineProperty(child, "scrollY", { configurable: true, writable: true, value: 0 });
  Object.defineProperty(env.dom.window, "scrollY", { configurable: true, writable: true, value: 0 });
  for (const [name, value] of Object.entries({ offsetWidth: 308, offsetHeight: 158, clientWidth: 300, clientHeight: 150, clientLeft: 4, clientTop: 4 })) {
    Object.defineProperty(frame, name, { configurable: true, value });
  }
  frame.getBoundingClientRect = () => rect(20, 2200 - env.dom.window.scrollY, 616, 316);
  frame.scrollIntoView = () => { throw new Error("the frame box itself is not the matched text"); };
  child.Range.prototype.getClientRects = () => [rect(20, 900 - child.scrollY)];
  const calls = [];
  child.scrollBy = options => { calls.push({ doc: "child", ...options }); child.scrollY += options.top; };
  env.dom.window.scrollBy = options => { calls.push({ doc: "parent", ...options }); env.dom.window.scrollY += options.top; };
  const node = child.document.getElementById("child").firstChild;
  const result = env.engine.renderMatches([{ id: 0, node, text: node.data }], [{ chunkId: 0, start: 0, end: 5 }]);
  assert.equal(result.marks.length, 1);
  assert.equal(env.engine.navigate(result.marks[0]), true);
  assert.deepEqual(calls.map(call => call.doc), ["child", "parent"]);
  assert.ok(calls.every(call => call.behavior === "instant"));
  assert.equal(calls[1].top, 2200 + 8 + 75 * 2 - env.dom.window.innerHeight / 2);
  assert.equal(env.engine.navigate(result.marks[0]), true);
  assert.equal(calls.length, 2);
  dispose(env, result);
});

test("search panel overlap causes one bounded adjustment and no later recentering", () => {
  const env = setup();
  Object.defineProperty(env.dom.window, "scrollY", { configurable: true, writable: true, value: 100 });
  Object.defineProperty(env.doc.documentElement, "scrollHeight", { configurable: true, value: 3000 });
  env.dom.window.Range.prototype.getClientRects = () => [rect(20, 180 - env.dom.window.scrollY)];
  const calls = [];
  env.dom.window.scrollBy = options => { calls.push(options); env.dom.window.scrollY += options.top; };
  const result = env.render();
  const options = { block: "nearest", avoidRect: rect(0, 0, 500, 120) };
  assert.equal(env.engine.navigate(result.marks[0], options), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].top, -48);
  assert.equal(calls[0].behavior, "instant");
  assert.equal(result.marks[0].range.getClientRects()[0].top, 128);
  assert.equal(env.engine.navigate(result.marks[0], options), true);
  assert.equal(calls.length, 1);
  dispose(env, result);
});

test("fixed text covered by the panel does not cause unrelated document scrolling", () => {
  const env = setup({ html: '<p id="t" style="position:fixed">hello world</p>' });
  Object.defineProperty(env.dom.window, "scrollY", { configurable: true, value: 100 });
  Object.defineProperty(env.doc.documentElement, "scrollHeight", { configurable: true, value: 3000 });
  let scrolls = 0;
  env.dom.window.scrollBy = () => { scrolls++; };
  const result = env.render();
  assert.equal(env.engine.navigate(result.marks[0], { avoidRect: rect(0, 0, 500, 120) }), true);
  assert.equal(scrolls, 0);
  dispose(env, result);
});

test("navigation skips permanently clipped first lines instead of hiding the visible match", () => {
  const env = setup({ html: '<p id="t" style="overflow:clip">hello world</p>' });
  env.doc.getElementById("t").getBoundingClientRect = () => rect(0, 80, 200, 30);
  env.dom.window.Range.prototype.getClientRects = () => [rect(20, -400), rect(20, 90)];
  let scrolls = 0;
  env.dom.window.scrollBy = () => { scrolls++; };
  const result = env.render();
  assert.equal(result.marks.length, 1);
  assert.equal(env.engine.navigate(result.marks[0], { block: "nearest" }), true);
  assert.equal(scrolls, 0);
  dispose(env, result);
});

test("fixed text in a transformed containing block can be located by document scrolling", () => {
  const env = setup({ html: '<div style="transform:translateX(0)"><p id="t" style="position:fixed">hello world</p></div>' });
  Object.defineProperty(env.dom.window, "scrollY", { configurable: true, writable: true, value: 0 });
  env.dom.window.Range.prototype.getClientRects = () => [rect(20, 3000 - env.dom.window.scrollY)];
  const calls = [];
  env.dom.window.scrollBy = options => { calls.push(options); env.dom.window.scrollY += options.top; };
  const result = env.render();
  assert.equal(env.engine.navigate(result.marks[0]), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].behavior, "instant");
  assert.equal(env.engine.navigate(result.marks[0]), true);
  assert.equal(calls.length, 1);
  dispose(env, result);
});

test("stale and password control values cannot be rendered", () => {
  const env = setup({ html: '<input id="control" type="password" value="hello world">' });
  const control = env.doc.getElementById("control");
  for (const text of ["hello world", "stale"]) {
    const result = env.engine.renderMatches([{ id: 0, kind: "control", node: control, text }], [{ chunkId: 0, start: 0, end: 5 }]);
    assert.equal(result.marks.length, 0);
  }
  env.dom.window.close();
});

test("cleanup preserves page edits and never normalizes the parent", () => {
  const env = setup();
  const node = env.entries()[0].node;
  let normalizeCalls = 0;
  env.doc.getElementById("t").normalize = () => { normalizeCalls++; };
  const result = env.render();
  node.nodeValue = "page updated while search was open";
  assert.equal(result.marks[0].isConnected, false);
  assert.equal(env.engine.navigate(result.marks[0]), false);
  dispose(env, result);
  assert.equal(node.nodeValue, "page updated while search was open");
  assert.equal(normalizeCalls, 0);
});

test("cleanup preserves a registry entry replaced by the page", () => {
  const env = setup();
  const result = env.render();
  const state = result.marks[0].state;
  const page = new env.dom.window.Highlight();
  env.registry.set(state.name, page);
  dispose(env, result);
  assert.equal(env.registry.get(state.name), page);
});

test("batched cancellation removes owned registry entries and styles", async () => {
  const env = setup();
  const page = new env.dom.window.Highlight();
  env.registry.set("page", page);
  let calls = 0;
  const result = await env.engine.renderMatchesBatched(env.entries(), [{ chunkId: 0, start: 0, end: 5 }], {
    batchSize: 1, shouldContinue() { return ++calls < 2; }
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.marks.length, 0);
  assert.equal(env.registry.size, 1);
  assert.equal(env.registry.get("page"), page);
  assert.equal(env.doc.querySelectorAll("[data-regex-rabbit-owned]").length, 0);
  env.dom.window.close();
});

test("end-of-batch validation removes text changed after rendering", async () => {
  const env = setup();
  const entries = env.entries();
  let calls = 0;
  const result = await env.engine.renderMatchesBatched(entries, [{ chunkId: 0, start: 0, end: 5 }], {
    batchSize: 1, shouldContinue() {
      if (++calls === 2) entries[0].node.nodeValue = "changed";
      return true;
    }
  });
  assert.equal(result.marks.length, 0);
  assert.equal(env.registry.size, 0);
  assert.equal(env.doc.getElementById("t").textContent, "changed");
  env.dom.window.close();
});

test("open-shadow matches get root-scoped styling and preserve shadow node identity", () => {
  const env = setup({ html: '<div id="host"></div>' });
  const shadow = env.doc.getElementById("host").attachShadow({ mode: "open" });
  shadow.innerHTML = "<span>hello world</span>";
  const node = shadow.querySelector("span").firstChild;
  const result = env.engine.renderMatches([{ id: 0, node, text: node.nodeValue }], [{ chunkId: 0, start: 0, end: 5 }]);
  assert.equal(result.marks.length, 1);
  assert.equal(shadow.querySelectorAll("style[data-regex-rabbit-owned]").length, 1);
  dispose(env, result);
  assert.equal(shadow.querySelectorAll("style").length, 0);
  assert.equal(shadow.querySelector("span").firstChild, node);
});

test("frame results use the frame document's registry and style owner", () => {
  const env = setup({ html: '<iframe id="frame"></iframe>' });
  const frame = env.doc.getElementById("frame");
  const doc = frame.contentDocument;
  doc.body.innerHTML = "<p>hello world</p>";
  installGeometry(frame.contentWindow);
  const registry = new Map();
  frame.contentWindow.CSS = { highlights: registry };
  frame.contentWindow.Highlight = class extends Set {};
  const node = doc.querySelector("p").firstChild;
  const result = env.engine.renderMatches([{ id: 0, node, text: node.nodeValue }], [{ chunkId: 0, start: 0, end: 5 }]);
  assert.equal(result.marks.length, 1);
  assert.equal(registry.size, 2);
  assert.equal(env.registry.size, 0);
  assert.equal(doc.querySelectorAll("style[data-regex-rabbit-owned]").length, 1);
  dispose(env, result);
  assert.equal(registry.size, 0);
});

test("non-native fallback draws owned overlays while preserving page text", () => {
  const env = setup({ native: false });
  const node = env.entries()[0].node;
  const result = env.render();
  assert.equal(result.marks.length, 1);
  assert.equal(env.doc.getElementById("t").firstChild, node);
  assert.equal(env.doc.querySelectorAll("mark").length, 0);
  const host = env.doc.querySelector("[data-regex-rabbit-owned]");
  assert.ok(host);
  assert.equal(host.style.pointerEvents, "none");
  assert.equal(env.engine.isOwnNode(host), true);
  dispose(env, result);
  assert.equal(env.doc.querySelectorAll("[data-regex-rabbit-owned]").length, 0);
  assert.equal(node.nodeValue, "hello world");
});

test("configuration updates owned styles and rejects CSS text injection", () => {
  const env = setup();
  env.engine.updateConfig({ highlightColor: "#abc", currentColor: "#123456" });
  const result = env.render();
  const style = env.doc.querySelector("style[data-regex-rabbit-owned]");
  assert.match(style.textContent, /background-color:#abc/);
  env.engine.updateConfig({ highlightColor: "red;}body{display:none", currentColor: "#456789" });
  assert.match(style.textContent, /background-color:#abc/);
  assert.match(style.textContent, /background-color:#456789/);
  assert.equal(style.textContent.includes("display:none"), false);
  dispose(env, result);
});

test("a large single run yields and can be cancelled before all matches are rendered", async () => {
  const text = "x".repeat(1000);
  const env = setup({ html: `<p id="t">${text}</p>` });
  const detached = [], OriginalHighlight = env.dom.window.Highlight;
  env.dom.window.Highlight = class extends OriginalHighlight { constructor() { super(); detached.push(this); } };
  const matches = Array.from({ length: text.length }, (_, start) => ({ chunkId: 0, start, end: start + 1 }));
  let calls = 0, renderedBeforeCancellation = 0;
  const result = await env.engine.renderMatchesBatched(env.entries(), matches, {
    batchSize: 20, budgetMs: 1000,
    shouldContinue() {
      if (++calls === 2) {
        renderedBeforeCancellation = Math.max(0, ...detached.map(highlight => highlight.size));
        assert.equal(env.registry.size, 0, "partial ranges must not be published");
        return false;
      }
      return true;
    }
  });
  assert.equal(result.cancelled, true);
  assert.ok(renderedBeforeCancellation > 0);
  assert.ok(renderedBeforeCancellation < 1000);
  assert.equal(env.registry.size, 0);
  assert.equal(env.doc.querySelectorAll("[data-regex-rabbit-owned]").length, 0);
  env.dom.window.close();
});

test("result revalidation also yields inside a large single run", async () => {
  const text = "x".repeat(200);
  const env = setup({ html: `<p id="t">${text}</p>` });
  const matches = Array.from({ length: text.length }, (_, start) => ({ chunkId: 0, start, end: start + 1 }));
  let heartbeat = 0;
  const timer = setInterval(() => { heartbeat++; }, 0);
  const result = await env.engine.renderMatchesBatched(env.entries(), matches, { batchSize: 20, budgetMs: 2 });
  clearInterval(timer);
  assert.equal(result.marks.length, text.length);
  assert.ok(heartbeat >= 10);
  dispose(env, result);
});

test("default rendering uses the elapsed budget while explicit batch sizes still force page turns", async () => {
  const text = 'x'.repeat(200);
  const env = setup({ html: `<p id="t">${text}</p>`, clock: { now: () => 0 } });
  let turns = 0;
  env.scope.RRTaskScheduler = { yield() { turns++; return Promise.resolve(); } };
  const matches = Array.from({ length: text.length }, (_, start) => ({ chunkId: 0, start, end: start + 1 }));
  const result = await env.engine.renderMatchesBatched(env.entries(), matches, { budgetMs: 6 });
  assert.equal(result.marks.length, text.length);
  assert.equal(turns, 0, 'work inside its time budget must not request extra tasks');
  env.engine.removeHighlights(result.handles);
  const batched = await env.engine.renderMatchesBatched(env.entries(), matches, { batchSize: 20, budgetMs: 6 });
  assert.equal(batched.marks.length, text.length);
  assert.ok(turns >= 20, 'explicit small batches retain their scheduling contract');
  dispose(env, batched);
});

test("select labels use the displayed option label and focus without changing the option", () => {
  const env = setup({ html: '<select id="control"><option value="internal" label="Visible label">Other text</option><option value="next">Next</option></select>' });
  const control = env.doc.getElementById("control");
  const result = env.engine.renderMatches([{ id: 0, kind: "label", node: control, text: "Visible label" }], [{ chunkId: 0, start: 0, end: 7 }]);
  assert.equal(result.marks.length, 1);
  assert.equal(env.engine.navigate(result.marks[0]), true);
  assert.equal(control.value, "internal");
  assert.equal(control.selectedIndex, 0);
  control.selectedIndex = 1;
  assert.equal(result.marks[0].isConnected, false);
  dispose(env, result);
});

test("placeholder descriptors become stale as soon as a control has a value", () => {
  const env = setup({ html: '<input id="control" placeholder="Search names">' });
  const control = env.doc.getElementById("control");
  const result = env.engine.renderMatches([{ id: 0, kind: "placeholder", node: control, text: "Search names" }], [{ chunkId: 0, start: 0, end: 6 }]);
  assert.equal(result.marks.length, 1);
  assert.equal(env.engine.navigate(result.marks[0]), true);
  assert.equal(control.value, "");
  control.value = "name";
  assert.equal(result.marks[0].isConnected, false);
  dispose(env, result);
});

test("visibility restored on an inline descendant and aria-hidden text remain searchable", () => {
  const env = setup({ html: '<p style="visibility:hidden"><span id="t" aria-hidden="true" style="visibility:visible">hello world</span></p>' });
  const result = env.render();
  assert.equal(result.marks.length, 1);
  dispose(env, result);
});

test("a newly hidden middle segment invalidates a cross-node result", () => {
  const env = setup({ html: '<p id="t">hello <strong>wo</strong>rld</p>' });
  const parent = env.doc.getElementById("t");
  const first = parent.firstChild, middle = parent.children[0].firstChild, last = parent.lastChild;
  const result = env.engine.renderMatches([{
    id: 0, node: first, text: "hello world", segments: [
      { node: first, start: 0, end: 6 }, { node: middle, start: 6, end: 8 }, { node: last, start: 8, end: 11 }
    ]
  }], [{ chunkId: 0, start: 0, end: 11 }]);
  assert.equal(result.marks.length, 1);
  middle.parentElement.style.display = "none";
  assert.equal(result.marks[0].isConnected, false);
  assert.equal(env.engine.navigate(result.marks[0]), false);
  dispose(env, result);
});

test("a match across a visually hidden DOM gap highlights only collected visible pieces", () => {
  const env = setup({ html: '<p id="t">foo<span hidden>hidden</span>bar</p>' });
  const parent = env.doc.getElementById("t");
  const first = parent.firstChild, last = parent.lastChild;
  const result = env.engine.renderMatches([{
    id: 0, node: first, text: "foobar", segments: [
      { node: first, start: 0, end: 3 }, { node: last, start: 3, end: 6 }
    ]
  }], [{ chunkId: 0, start: 0, end: 6 }]);
  assert.equal(result.marks.length, 1);
  assert.deepEqual(result.marks[0].ranges.map(range => range.toString()), ["foo", "bar"]);
  assert.equal(result.marks[0].state.normal.size, 2);
  assert.equal(result.marks[0].isConnected, true);
  dispose(env, result);
  assert.equal(parent.textContent, "foohiddenbar");
});

test("one logical match can cross shadow, assigned-light and shadow text roots", () => {
  const env = setup({ html: '<div id="host"><span>middle</span></div>' });
  const host = env.doc.getElementById("host");
  const middle = host.firstChild.firstChild;
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = "before<slot></slot>after";
  const first = shadow.firstChild, last = shadow.lastChild;
  const result = env.engine.renderMatches([{
    id: 0, node: first, text: "beforemiddleafter", segments: [
      { node: first, start: 0, end: 6 }, { node: middle, start: 6, end: 12 }, { node: last, start: 12, end: 17 }
    ]
  }], [{ chunkId: 0, start: 0, end: 17 }]);
  assert.equal(result.marks.length, 1);
  assert.equal(result.marks[0].ranges.length, 3);
  assert.equal(result.marks[0].ranges.map(range => range.toString()).join(""), "beforemiddleafter");
  assert.equal(shadow.querySelectorAll("style[data-regex-rabbit-owned]").length, 1);
  assert.equal(env.doc.head.querySelectorAll("style[data-regex-rabbit-owned]").length, 1);
  env.engine.setCurrent(result.marks[0]);
  assert.equal(result.marks[0].state.current.size, 3);
  dispose(env, result);
});

test("collapsed visible whitespace maps its single logical character to the original source span", () => {
  const env = setup({ html: '<p id="t">a   \t\n b</p>' });
  const node = env.entries()[0].node;
  const sourceSpace = node.nodeValue.slice(1, -1);
  const result = env.engine.renderMatches([{
    id: 0, node, text: "a b", segments: [
      { node, start: 0, end: 1, nodeStart: 0, nodeEnd: 1, sourceText: "a" },
      { node, start: 1, end: 2, nodeStart: 1, nodeEnd: node.length - 1, sourceText: sourceSpace },
      { node, start: 2, end: 3, nodeStart: node.length - 1, nodeEnd: node.length, sourceText: "b" }
    ]
  }], [{ chunkId: 0, start: 0, end: 3 }]);
  assert.equal(result.marks.length, 1);
  assert.equal(result.marks[0].textContent, "a b");
  assert.equal(result.marks[0].ranges.length, 1);
  assert.equal(result.marks[0].range.toString(), "a" + sourceSpace + "b");
  assert.equal(result.marks[0].isConnected, true);
  node.nodeValue = "a changed b";
  assert.equal(result.marks[0].isConnected, false);
  dispose(env, result);
});

test("one match with many segments can cancel while building a detached native highlight", async () => {
  const env = setup({ html: '<p id="t"></p>' });
  const detached = [], OriginalHighlight = env.dom.window.Highlight;
  env.dom.window.Highlight = class extends OriginalHighlight { constructor() { super(); detached.push(this); } };
  const parent = env.doc.getElementById("t");
  for (let i = 0; i < 256; i++) {
    const span = env.doc.createElement("span");
    span.textContent = "x";
    parent.appendChild(span);
  }
  const nodes = Array.from(parent.children, span => span.firstChild);
  const entry = { id: 0, node: nodes[0], text: "x".repeat(nodes.length), segments: nodes.map((node, start) => ({ node, start, end: start + 1 })) };
  let partialRanges = 0;
  const result = await env.engine.renderMatchesBatched([entry], [{ chunkId: 0, start: 0, end: entry.text.length }], {
    batchSize: 1, budgetMs: 1,
    shouldContinue() {
      partialRanges = Math.max(partialRanges, 0, ...detached.map(highlight => highlight.size));
      assert.equal(env.registry.size, 0, "partial ranges must not be published");
      return partialRanges === 0;
    }
  });
  assert.equal(result.cancelled, true);
  assert.ok(partialRanges > 0 && partialRanges < nodes.length);
  assert.equal(env.registry.size, 0);
  assert.equal(env.doc.querySelectorAll("[data-regex-rabbit-owned]").length, 0);
  assert.deepEqual(Array.from(parent.children, span => span.firstChild), nodes);
  env.dom.window.close();
});

test("control text-transform uses displayed text while validating the original value", () => {
  const env = setup({ html: '<input id="control" style="text-transform:uppercase" value="hello world">' });
  const control = env.doc.getElementById("control");
  const result = env.engine.renderMatches([{
    id: 0, kind: "control", node: control, text: "HELLO WORLD", displayTextSnapshot: "hello world"
  }], [{ chunkId: 0, start: 6, end: 11 }]);
  assert.equal(result.marks.length, 1);
  assert.equal(env.engine.navigate(result.marks[0]), true);
  assert.equal(control.value, "hello world");
  assert.equal(control.selectionStart, 6);
  assert.equal(control.selectionEnd, 11);
  control.style.textTransform = "lowercase";
  assert.equal(result.marks[0].isConnected, false);
  dispose(env, result);
});

test("streamed control fragments navigate using absolute source offsets and reject stale full values", () => {
  const env = setup({ html: '<textarea id="control"></textarea>' });
  const control = env.doc.getElementById("control");
  const prefix = "x".repeat(1_100_000);
  control.value = prefix + "hello world";
  control.setSelectionRange(0, 0);
  const snapshot = control.value;
  const result = env.engine.renderMatches([{
    id: 0, node: control, kind: "control", text: "world", displayTextSnapshot: snapshot,
    controlOffset: prefix.length + 6, textTransform: "none", controlTransform: "none"
  }], [{ chunkId: 0, start: 1, end: 4 }]);
  assert.equal(result.marks.length, 1);
  const mark = result.marks[0];
  assert.equal(mark.textContent, "orl");
  assert.equal(mark.start, prefix.length + 7);
  assert.equal(mark.end, prefix.length + 10);
  assert.equal(mark.displaySnapshot, "world");
  assert.equal(mark.valueSnapshot, snapshot);
  assert.equal(control.selectionStart, 0);
  assert.equal(env.engine.navigate(mark), true);
  assert.equal(control.selectionStart, mark.start);
  assert.equal(control.selectionEnd, mark.end);
  assert.equal(control.value, snapshot);
  control.value = "y" + snapshot.slice(1);
  assert.equal(mark.isConnected, false, "equal-length edits outside the fragment invalidate it");
  assert.equal(env.engine.navigate(mark), false);
  dispose(env, result);
});

test("streamed control offsets are validated without coercion or clamping", () => {
  const env = setup({ html: '<input id="control" value="hello world">' });
  const control = env.doc.getElementById("control");
  for (const controlOffset of [null, -1, 0.5, "6", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 7]) {
    const result = env.engine.renderMatches([{
      id: 0, node: control, kind: "control", text: "world", displayTextSnapshot: control.value,
      controlOffset, textTransform: "none", controlTransform: "none"
    }], [{ chunkId: 0, start: 0, end: 5 }]);
    assert.equal(result.marks.length, 0, String(controlOffset));
    assert.equal(env.registry.size, 0);
  }
  env.dom.window.close();
});

test("streamed control display validation only transforms the retained fragment", () => {
  const env = setup({ html: '<textarea id="control" style="text-transform:uppercase"></textarea>' });
  const control = env.doc.getElementById("control");
  control.value = "x".repeat(1_100_000) + "hello world";
  const raw = control.value;
  const originalTest = RegExp.prototype.test;
  const originalUpper = String.prototype.toUpperCase;
  let fullAsciiChecks = 0, fullTransforms = 0;
  RegExp.prototype.test = function (value) {
    if (this.source === "^[\\x00-\\x7f]*$" && value === raw) fullAsciiChecks++;
    return originalTest.call(this, value);
  };
  String.prototype.toUpperCase = function () {
    if (String(this) === raw) fullTransforms++;
    return originalUpper.call(this);
  };
  let result;
  try {
    result = env.engine.renderMatches([{
      id: 0, node: control, kind: "control", text: "WORLD", displayTextSnapshot: raw,
      controlOffset: raw.length - 5, textTransform: "uppercase", controlTransform: "uppercase"
    }], [{ chunkId: 0, start: 0, end: 5 }]);
    assert.equal(result.marks.length, 1);
    assert.equal(result.marks[0].isConnected, true);
    assert.equal(env.engine.navigate(result.marks[0]), true);
    assert.equal(fullAsciiChecks, 0);
    assert.equal(fullTransforms, 0);
    control.style.textTransform = "lowercase";
    assert.equal(result.marks[0].isConnected, false);
  } finally {
    RegExp.prototype.test = originalTest;
    String.prototype.toUpperCase = originalUpper;
    if (result) dispose(env, result); else env.dom.window.close();
  }
});

test("streamed controls preserve a collector's whole-value Unicode transform decision", () => {
  const env = setup({ html: '<textarea id="control" style="text-transform:uppercase">é hello</textarea>' });
  const control = env.doc.getElementById("control");
  const result = env.engine.renderMatches([{
    id: 0, node: control, kind: "control", text: "hello", displayTextSnapshot: control.value,
    controlOffset: 2, textTransform: "uppercase", controlTransform: "none"
  }], [{ chunkId: 0, start: 0, end: 5 }]);
  assert.equal(result.marks.length, 1);
  assert.equal(env.engine.navigate(result.marks[0]), true);
  assert.equal(control.selectionStart, 2);
  assert.equal(control.selectionEnd, 7);
  dispose(env, result);
});

test("streamed selected control fragments retain original offsets and visibility guards", () => {
  const env = setup({ html: '<input id="control" value="before selected after">' });
  const control = env.doc.getElementById("control");
  const entry = {
    id: 0, node: control, kind: "control", text: "selected", displayTextSnapshot: control.value,
    controlOffset: 7, selectionProcessed: true, textTransform: "none", controlTransform: "none"
  };
  const result = env.engine.renderMatches([entry], [{ chunkId: 0, start: 0, end: 8 }]);
  assert.equal(result.marks.length, 1);
  assert.equal(env.engine.navigate(result.marks[0]), true);
  assert.equal(control.selectionStart, 7);
  assert.equal(control.selectionEnd, 15);
  control.style.display = "none";
  assert.equal(result.marks[0].isConnected, false);
  assert.equal(env.engine.renderMatches([entry], [{ chunkId: 0, start: 0, end: 8 }]).marks.length, 0);
  dispose(env, result);
});

test("streamed labels and placeholders validate the original public source rather than control values", () => {
  for (const kind of ["label", "placeholder"]) {
    const env = setup({ html: kind === "label" ? '<select id="control"><option value="private" label="before public label"></option></select>' : '<input id="control" placeholder="before public label">' });
    const control = env.doc.getElementById("control");
    const entry = {
      id: 0, node: control, kind, text: "public", displayTextSnapshot: "before public label",
      controlOffset: 7, textTransform: "none", controlTransform: "none"
    };
    const result = env.engine.renderMatches([entry], [{ chunkId: 0, start: 0, end: 6 }]);
    assert.equal(result.marks.length, 1, kind);
    assert.equal(env.engine.navigate(result.marks[0]), true);
    assert.equal(control.value, kind === "label" ? "private" : "");
    if (kind === "label") control.options[0].label = "changed public label";
    else control.value = "changed";
    assert.equal(result.marks[0].isConnected, false, kind);
    dispose(env, result);
  }
});

test("password placeholders never read private values and disappear when the public placeholder is hidden", () => {
  const env = setup({ html: '<input id="control" type="password" placeholder="Enter password">' });
  const control = env.doc.getElementById("control");
  const matches = control.matches.bind(control);
  let shown = true, valueReads = 0;
  control.matches = selector => selector === ":placeholder-shown" ? shown : matches(selector);
  Object.defineProperty(control, "value", { configurable: true, get() { valueReads++; throw new Error("private value must not be read"); } });
  const result = env.engine.renderMatches([{
    id: 0, node: control, kind: "placeholder", text: "password", displayTextSnapshot: "Enter password",
    controlOffset: 6, textTransform: "none", controlTransform: "none"
  }], [{ chunkId: 0, start: 0, end: 8 }]);
  assert.equal(result.marks.length, 1);
  assert.equal(result.marks[0].isConnected, true);
  assert.equal(env.engine.navigate(result.marks[0]), true);
  assert.equal(env.engine.renderMatches([{ id: 1, node: control, kind: "control", text: "secret", displayTextSnapshot: "secret", controlOffset: 0, textTransform: "none", controlTransform: "none" }], [{ chunkId: 1, start: 0, end: 6 }]).marks.length, 0);
  assert.equal(valueReads, 0);
  shown = false;
  assert.equal(result.marks[0].isConnected, false);
  assert.equal(env.engine.navigate(result.marks[0]), false);
  assert.equal(valueReads, 0);
  dispose(env, result);
});

test("streamed placeholder results recheck pseudo-element visibility and display transforms", () => {
  const env = setup({ html: '<input id="control" placeholder="before public label">' });
  const control = env.doc.getElementById("control");
  const originalStyle = env.dom.window.getComputedStyle.bind(env.dom.window);
  const pseudo = { visibility: "visible", display: "inline", opacity: "1", fontSize: "12px", color: "rgb(0, 0, 0)", textTransform: "uppercase" };
  env.dom.window.CSS.supports = value => value === "selector(::placeholder)";
  env.dom.window.getComputedStyle = (node, selector) => selector === "::placeholder" ? pseudo : originalStyle(node);
  const entry = {
    id: 0, node: control, kind: "placeholder", text: "PUBLIC", displayTextSnapshot: control.placeholder,
    controlOffset: 7, textTransform: "uppercase", controlTransform: "uppercase"
  };
  const result = env.engine.renderMatches([entry], [{ chunkId: 0, start: 0, end: 6 }]);
  assert.equal(result.marks.length, 1);
  for (const [property, value] of [["opacity", "0.0"], ["fontSize", "0.00px"], ["visibility", "collapse"], ["color", "rgba(0, 0, 0, 0)"], ["textTransform", "lowercase"]]) {
    const before = pseudo[property];
    pseudo[property] = value;
    assert.equal(result.marks[0].isConnected, false, property);
    assert.equal(env.engine.renderMatches([entry], [{ chunkId: 0, start: 0, end: 6 }]).marks.length, 0, property);
    pseudo[property] = before;
  }
  dispose(env, result);
});

test("final batched control validation refreshes CSS after yielding", async () => {
  const env = setup({ html: '<textarea id="control" style="text-transform:uppercase">hello world</textarea>' });
  const control = env.doc.getElementById("control");
  let rectReads = 0;
  control.getClientRects = () => {
    if (++rectReads === 3) {
      // The first result is temporarily unpainted during final validation. The
      // page changes display mapping in the microtask before the next result.
      queueMicrotask(() => { control.style.textTransform = "lowercase"; });
      return [];
    }
    return [rect()];
  };
  const result = await env.engine.renderMatchesBatched([{
    id: 0, node: control, kind: "control", text: "HELLO WORLD", displayTextSnapshot: control.value,
    controlOffset: 0, textTransform: "uppercase", controlTransform: "uppercase"
  }], [{ chunkId: 0, start: 0, end: 5 }, { chunkId: 0, start: 6, end: 11 }], { batchSize: 1 });
  assert.equal(control.style.textTransform, "lowercase");
  assert.equal(result.marks.length, 0);
  assert.equal(env.registry.size, 0);
  dispose(env, result);
});

test("large collapsed source spans yield while validating before native registration", async () => {
  const env = setup({ html: '<p id="t"></p>' });
  const node = env.doc.createTextNode(" ".repeat(1_100_000));
  env.doc.getElementById("t").appendChild(node);
  let checks = 0;
  const result = await env.engine.renderMatchesBatched([{
    id: 0, node, text: " ", segments: [{ node, start: 0, end: 1, nodeStart: 0, nodeEnd: node.length, sourceText: node.nodeValue }]
  }], [{ chunkId: 0, start: 0, end: 1 }], { batchSize: 1, shouldContinue: () => ++checks < 3 });
  assert.equal(result.cancelled, true);
  assert.equal(env.registry.size, 0);
  assert.equal(env.doc.querySelectorAll("[data-regex-rabbit-owned]").length, 0);
  env.dom.window.close();
});

test("empty password placeholders are searchable without exposing password values", () => {
  const env = setup({ html: '<input id="control" type="password" placeholder="Enter password">' });
  const control = env.doc.getElementById("control");
  const result = env.engine.renderMatches([{
    id: 0, kind: "placeholder", node: control, text: "Enter password"
  }], [{ chunkId: 0, start: 0, end: 5 }]);
  assert.equal(result.marks.length, 1);
  assert.equal(env.engine.navigate(result.marks[0]), true);
  assert.equal(control.value, "");
  control.value = "secret";
  assert.equal(result.marks[0].isConnected, false);
  assert.equal(env.engine.renderMatches([{ id: 1, kind: "control", node: control, text: "secret" }], [{ chunkId: 1, start: 0, end: 6 }]).marks.length, 0);
  dispose(env, result);
});

test("a control changed to an unsupported non-text type invalidates its result", () => {
  const env = setup({ html: '<input id="control" value="hello world">' });
  const control = env.doc.getElementById("control");
  const result = env.engine.renderMatches([{ id: 0, kind: "control", node: control, text: control.value }], [{ chunkId: 0, start: 0, end: 5 }]);
  assert.equal(result.marks.length, 1);
  control.type = "hidden";
  assert.equal(result.marks[0].isConnected, false);
  dispose(env, result);
});

test("white-space changes invalidate normalized matches before navigation or counting", () => {
  const env = setup({ html: '<p id="t" style="white-space:normal">a   b</p>' });
  const node = env.entries()[0].node;
  const entry = {
    id: 0, node, text: "a b", segments: [
      { node, start: 0, end: 1, nodeStart: 0, nodeEnd: 1, sourceText: "a", whiteSpace: "normal", textTransform: "none" },
      { node, start: 1, end: 2, nodeStart: 1, nodeEnd: 4, sourceText: "   ", whiteSpace: "normal", textTransform: "none" },
      { node, start: 2, end: 3, nodeStart: 4, nodeEnd: 5, sourceText: "b", whiteSpace: "normal", textTransform: "none" }
    ]
  };
  const matches = [{ chunkId: 0, start: 0, end: 3 }];
  const result = env.engine.renderMatches([entry], matches);
  assert.equal(result.marks.length, 1);
  node.parentElement.style.whiteSpace = "pre";
  assert.equal(result.marks[0].isConnected, false);
  assert.equal(env.engine.navigate(result.marks[0]), false);
  assert.equal(env.engine.renderMatches([entry], matches).marks.length, 0);
  dispose(env, result);
});

test("text-transform changes invalidate a displayed-text snapshot with unchanged DOM text", () => {
  const env = setup({ html: '<p id="t" style="text-transform:uppercase">foo</p>' });
  const node = env.entries()[0].node;
  const entry = { id: 0, node, text: "FOO", segments: [
    { node, start: 0, end: 3, sourceText: "foo", whiteSpace: "normal", textTransform: "uppercase" }
  ] };
  const matches = [{ chunkId: 0, start: 0, end: 3 }];
  const result = env.engine.renderMatches([entry], matches);
  assert.equal(result.marks.length, 1);
  node.parentElement.style.textTransform = "none";
  assert.equal(node.nodeValue, "foo");
  assert.equal(result.marks[0].isConnected, false);
  assert.equal(env.engine.renderMatches([entry], matches).marks.length, 0);
  dispose(env, result);
});

test("zero-width newline pieces do not discard a visible cross-line match", () => {
  const env = setup({ html: '<p id="t" style="white-space:pre-line">a\nb</p>' });
  const node = env.entries()[0].node;
  env.dom.window.Range.prototype.getClientRects = function () {
    return this.toString() === "\n" ? [rect(20, 20, 0, 20)] : [rect()];
  };
  const result = env.engine.renderMatches([{
    id: 0, node, text: "a\nb", segments: [
      { node, start: 0, end: 1, nodeStart: 0, nodeEnd: 1, sourceText: "a", whiteSpace: "pre-line" },
      { node, start: 1, end: 2, nodeStart: 1, nodeEnd: 2, sourceText: "\n", whiteSpace: "pre-line" },
      { node, start: 2, end: 3, nodeStart: 2, nodeEnd: 3, sourceText: "b", whiteSpace: "pre-line" }
    ]
  }], [{ chunkId: 0, start: 0, end: 3 }]);
  assert.equal(result.marks.length, 1);
  assert.equal(result.marks[0].isConnected, true);
  assert.equal(result.marks[0].ranges.length, 1);
  assert.equal(result.marks[0].range.toString(), "a\nb");
  dispose(env, result);
});

test("closed-root assigned text is clipped by its composed shadow ancestors", () => {
  const env = setup({ html: '<div id="host"><span id="t">hello world</span></div>' });
  const host = env.doc.getElementById("host");
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = '<div style="overflow:hidden"><slot></slot></div>';
  root.firstChild.getBoundingClientRect = () => rect(0, 0, 10, 10);
  env.scope.chrome = { dom: { openOrClosedShadowRoot: element => element === host ? root : null } };
  const result = env.render();
  assert.equal(result.marks.length, 0);
  dispose(env, result);
});

test("ordinary page timers run even when scheduler continuations resolve immediately", async () => {
  const previousScheduler = globalThis.scheduler;
  globalThis.scheduler = { yield: () => Promise.resolve() };
  const text = "x".repeat(500);
  const env = setup({ html: `<p id="t">${text}</p>` });
  const matches = Array.from({ length: text.length }, (_, start) => ({ chunkId: 0, start, end: start + 1 }));
  let heartbeat = 0;
  const timer = setInterval(() => { heartbeat++; }, 0);
  let result;
  try {
    result = await env.engine.renderMatchesBatched(env.entries(), matches, { batchSize: 10, budgetMs: 4 });
    assert.equal(result.marks.length, text.length);
    assert.ok(heartbeat > 0);
  } finally {
    clearInterval(timer);
    globalThis.scheduler = previousScheduler;
    if (result) dispose(env, result); else env.dom.window.close();
  }
});

test("nonzero SVG glyph rectangles do not make unpainted text a visible match", () => {
  for (const style of ["fill:none;stroke:none", "fill-opacity:0;stroke:none", "fill:none;stroke:black;stroke-width:0", "fill:none;stroke:black;stroke-opacity:0"]) {
    const env = setup({ html: `<svg><text id="t" style="${style}">hello</text></svg>` });
    const result = env.render();
    assert.equal(result.marks.length, 0, style);
    dispose(env, result);
  }
});

test("SVG stroked text and a tspan restoring fill remain visible", () => {
  const outline = setup({ html: '<svg><text id="t" style="fill:none;stroke:black;stroke-width:1">hello</text></svg>' });
  const outlineResult = outline.render();
  assert.equal(outlineResult.marks.length, 1);
  dispose(outline, outlineResult);
  const restored = setup({ html: '<svg><text style="fill:none;stroke:none"><tspan id="t" style="fill:black">hello</tspan></text></svg>' });
  const restoredResult = restored.render();
  assert.equal(restoredResult.marks.length, 1);
  restored.doc.getElementById("t").style.fill = "none";
  assert.equal(restored.engine.isValid(restoredResult.marks[0]), false);
  dispose(restored, restoredResult);
});

test("initial name collisions preserve both page-owned highlight entries", () => {
  const originalNow = Date.now;
  Date.now = () => 123;
  const env = setup();
  const pageNormal = new env.dom.window.Highlight();
  const pageCurrent = new env.dom.window.Highlight();
  env.registry.set("rr-find-3f-1", pageNormal);
  env.registry.set("rr-find-3f-1-current", pageCurrent);
  try {
    const result = env.render();
    assert.equal(result.marks.length, 1);
    assert.notEqual(result.marks[0].state.name, "rr-find-3f-1");
    assert.equal(env.registry.get("rr-find-3f-1"), pageNormal);
    assert.equal(env.registry.get("rr-find-3f-1-current"), pageCurrent);
    dispose(env, result);
    assert.equal(env.registry.size, 2);
  } finally { Date.now = originalNow; env.dom.window.close(); }
});

test("geometry checks see no partial native highlight before the final commit", async () => {
  const text = "x".repeat(200);
  const env = setup({ html: `<p id="t">${text}</p>` });
  const page = new env.dom.window.Highlight();
  env.registry.set("page-owned", page);
  const geometry = env.dom.window.Range.prototype.getClientRects;
  let geometryReads = 0;
  env.dom.window.Range.prototype.getClientRects = function () {
    geometryReads++;
    assert.equal(env.registry.size, 1, "native registry must stay unchanged through both validation passes");
    assert.equal(env.registry.get("page-owned"), page);
    return geometry.call(this);
  };
  const registrations = [], originalSet = env.registry.set.bind(env.registry);
  env.registry.set = (name, value) => { registrations.push({ name, size: value.size }); return originalSet(name, value); };
  const result = await env.engine.renderMatchesBatched(env.entries(), Array.from({ length: text.length }, (_, start) => ({ chunkId: 0, start, end: start + 1 })),
    { batchSize: 20, budgetMs: 2 });
  assert.equal(result.marks.length, 200);
  assert.equal(geometryReads, 400, "keep both visibility validation passes");
  assert.equal(env.registry.size, 3);
  assert.deepEqual(registrations.map(item => item.size), [200, 0]);
  assert.equal(env.registry.get("page-owned"), page);
  dispose(env, result);
});

test("final commit renames a highlight when the page takes its names during a yielded render", async () => {
  const text = "x".repeat(80);
  const env = setup({ html: `<p id="t">${text}</p>` });
  const pageNormal = new env.dom.window.Highlight(), pageCurrent = new env.dom.window.Highlight();
  let originalName = null;
  const result = await env.engine.renderMatchesBatched(env.entries(), Array.from({ length: text.length }, (_, start) => ({ chunkId: 0, start, end: start + 1 })), {
    batchSize: 10, budgetMs: 1000,
    shouldContinue() {
      const style = env.doc.querySelector("style[data-regex-rabbit-owned]");
      if (style && !originalName) {
        originalName = /::highlight\(([^)]+)\)/.exec(style.textContent)[1];
        env.registry.set(originalName, pageNormal);
        env.registry.set(`${originalName}-current`, pageCurrent);
      }
      return true;
    }
  });
  assert.ok(originalName);
  const state = result.marks[0].state;
  assert.notEqual(state.name, originalName);
  assert.equal(env.registry.get(originalName), pageNormal);
  assert.equal(env.registry.get(`${originalName}-current`), pageCurrent);
  assert.equal(env.registry.get(state.name), state.normal);
  assert.equal(env.registry.get(state.currentName), state.current);
  for (const style of state.styles.values()) {
    assert.ok(style.textContent.includes(`::highlight(${state.name})`));
    assert.equal(style.textContent.includes(`::highlight(${originalName})`), false);
  }
  dispose(env, result);
  assert.equal(env.registry.size, 2);
});

test("final commit uses colors changed while its native highlight was still detached", async () => {
  const text = "x".repeat(80);
  const env = setup({ html: `<p id="t">${text}</p>` });
  let changed = false;
  const result = await env.engine.renderMatchesBatched(env.entries(), Array.from({ length: text.length }, (_, start) => ({ chunkId: 0, start, end: start + 1 })), {
    batchSize: 10, budgetMs: 1000,
    shouldContinue() {
      if (!changed && env.doc.querySelector("style[data-regex-rabbit-owned]")) {
        assert.equal(env.registry.size, 0);
        env.engine.configure({ highlightColor: "#123456", currentColor: "#654321" });
        changed = true;
      }
      return true;
    }
  });
  assert.equal(changed, true);
  for (const style of result.marks[0].state.styles.values()) {
    assert.ok(style.textContent.includes("background-color:#123456"));
    assert.ok(style.textContent.includes("background-color:#654321"));
  }
  dispose(env, result);
});

test("partial native registration failure cleans owned values and paints the rectangle fallback", () => {
  const env = setup();
  const page = new env.dom.window.Highlight();
  env.registry.set("page-owned", page);
  const originalSet = env.registry.set.bind(env.registry);
  let sets = 0;
  env.registry.set = (name, value) => {
    sets++;
    if (sets === 2) throw new Error("native registration rejected");
    return originalSet(name, value);
  };
  const result = env.render();
  assert.equal(result.marks.length, 1);
  assert.equal(result.marks[0].state.native, false);
  assert.equal(env.registry.size, 1);
  assert.equal(env.registry.get("page-owned"), page);
  assert.ok(result.marks[0].state.overlay);
  assert.equal(env.engine.navigate(result.marks[0]), true);
  dispose(env, result);
  assert.equal(env.registry.size, 1);
  assert.equal(env.doc.querySelectorAll("[data-regex-rabbit-owned]").length, 0);
});

test("a Text adopted into another document invalidates its old registry descriptor", () => {
  const env = setup({ html: '<p id="t">hello world</p><iframe></iframe>' });
  const result = env.render();
  const node = env.entries()[0].node;
  const frame = env.doc.querySelector("iframe");
  installGeometry(frame.contentWindow);
  frame.contentDocument.body.appendChild(node);
  assert.equal(node.isConnected, true);
  assert.equal(env.engine.isValid(result.marks[0]), false);
  assert.equal(env.engine.navigate(result.marks[0]), false);
  dispose(env, result);
});

test("moving a Text into a different shadow styling root invalidates its old result", () => {
  const env = setup({ html: '<p id="t">hello world</p><div id="host"></div>' });
  const result = env.render();
  const shadow = env.doc.getElementById("host").attachShadow({ mode: "open" });
  shadow.appendChild(env.entries()[0].node);
  assert.equal(result.marks[0].node.isConnected, true);
  assert.equal(env.engine.isValid(result.marks[0]), false);
  dispose(env, result);
});

test("a detached frame document cannot keep its old text result connected", () => {
  const { env, frame, render } = frameFixture({ parentStyle: "" });
  const result = render();
  assert.equal(result.marks.length, 1);
  const node = result.marks[0].node;
  frame.remove();
  // Chromium may retain a connected subtree in the orphaned old Document;
  // jsdom closes it eagerly, so retain that observable condition explicitly.
  Object.defineProperty(node, "isConnected", { configurable: true, get: () => true });
  assert.equal(env.engine.isValid(result.marks[0]), false);
  assert.equal(env.engine.navigate(result.marks[0]), false);
  dispose(env, result);
});

test("changes outside the matched substring invalidate regex context before the observer callback", () => {
  const env = setup({ html: '<p id="t"> foo </p>' });
  const result = env.render([{ chunkId: 0, start: 1, end: 4 }]);
  env.entries()[0].node.insertData(4, "a");
  assert.equal(result.marks[0].range.toString(), "foo");
  assert.equal(env.engine.isValid(result.marks[0]), false);
  assert.equal(env.engine.navigate(result.marks[0]), false);
  dispose(env, result);
});

test("inserting visible text between collected pieces invalidates the composed match", () => {
  const env = setup({ html: '<p id="t">foo<span>bar</span></p>' });
  const parent = env.doc.getElementById("t");
  const first = parent.firstChild, last = parent.lastChild.firstChild;
  const result = env.engine.renderMatches([{
    id: 0, node: first, text: "foobar", segments: [
      { node: first, start: 0, end: 3 }, { node: last, start: 3, end: 6 }
    ]
  }], [{ chunkId: 0, start: 0, end: 6 }]);
  parent.insertBefore(env.doc.createTextNode("X"), parent.lastChild);
  assert.equal(result.marks[0].ranges.map(range => range.toString()).join(""), "foobar");
  assert.equal(env.engine.isValid(result.marks[0]), false);
  dispose(env, result);
});

test("a formerly hidden gap becoming visible invalidates the old joined text", () => {
  const env = setup({ html: '<p id="t">foo<span hidden>X</span>bar</p>' });
  const parent = env.doc.getElementById("t");
  const first = parent.firstChild, last = parent.lastChild;
  const result = env.engine.renderMatches([{
    id: 0, node: first, text: "foobar", segments: [
      { node: first, start: 0, end: 3 }, { node: last, start: 3, end: 6 }
    ]
  }], [{ chunkId: 0, start: 0, end: 6 }]);
  parent.children[0].hidden = false;
  assert.equal(env.engine.isValid(result.marks[0]), false);
  dispose(env, result);
});

test("unrelated blocks and owned style changes keep unaffected snapshots valid", () => {
  const env = setup({ html: '<p id="t">hello world</p><p id="other">second</p>' });
  const other = env.doc.getElementById("other").firstChild;
  const result = env.engine.renderMatches(env.entries().concat([{ id: 1, node: other, text: other.nodeValue }]), [
    { chunkId: 0, start: 0, end: 5 }, { chunkId: 1, start: 0, end: 6 }
  ]);
  env.engine.updateConfig({ highlightColor: "#abc" });
  assert.equal(env.engine.isValid(result.marks[0]), true);
  other.insertData(6, " changed");
  assert.equal(env.engine.isValid(result.marks[0]), true);
  assert.equal(env.engine.isValid(result.marks[1]), false);
  dispose(env, result);
});

test("slot assignment changes invalidate shadow-only text context", () => {
  const env = setup({ html: '<div id="host"></div>' });
  const host = env.doc.getElementById("host");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = "foo<slot></slot>bar";
  const first = root.firstChild, last = root.lastChild;
  const result = env.engine.renderMatches([{
    id: 0, node: first, text: "foobar", segments: [
      { node: first, start: 0, end: 3 }, { node: last, start: 3, end: 6 }
    ]
  }], [{ chunkId: 0, start: 0, end: 6 }]);
  host.textContent = "X";
  assert.equal(env.engine.isValid(result.marks[0]), false);
  dispose(env, result);
});

test("all results in one document share one snapshot observer and cleanup disconnects it", () => {
  const env = setup({ html: '<p id="t">hello world</p><p>second</p>' });
  const Original = env.dom.window.MutationObserver;
  let created = 0, disconnected = 0;
  env.dom.window.MutationObserver = class extends Original {
    constructor(callback) { super(callback); created++; }
    disconnect() { disconnected++; super.disconnect(); }
  };
  const entries = Array.from(env.doc.querySelectorAll("p"), (p, id) => ({ id, node: p.firstChild, text: p.textContent }));
  const result = env.engine.renderMatches(entries, entries.map(entry => ({ chunkId: entry.id, start: 0, end: 2 })));
  assert.equal(result.marks.length, 2);
  assert.equal(created, 1);
  dispose(env, result);
  assert.equal(disconnected, 1);
});

test("fallback source validation includes the full entry when MutationObserver is unavailable", () => {
  const env = setup({ html: '<p id="t"> foo </p>' });
  env.dom.window.MutationObserver = undefined;
  const result = env.render([{ chunkId: 0, start: 1, end: 4 }]);
  env.entries()[0].node.insertData(4, "a");
  assert.equal(result.marks[0].range.toString(), "foo");
  assert.equal(env.engine.isValid(result.marks[0]), false);
  dispose(env, result);
});

function frameFixture({ parentStyle = "overflow:hidden", frameRect = rect(100, 100, 100, 100), frameStyle = "" } = {}) {
  const env = setup({ html: `<div id="clip" style="${parentStyle}"><iframe style="${frameStyle}"></iframe></div>` });
  env.doc.getElementById("clip").getBoundingClientRect = () => rect(0, 0, 20, 20);
  const frame = env.doc.querySelector("iframe");
  frame.getBoundingClientRect = () => frameRect;
  const doc = frame.contentDocument;
  doc.body.innerHTML = "<p>hello world</p>";
  installGeometry(frame.contentWindow);
  const node = doc.querySelector("p").firstChild;
  const render = () => env.engine.renderMatches([{ id: 0, node, text: node.nodeValue }], [{ chunkId: 0, start: 0, end: 5 }]);
  return { env, frame, render };
}

test("a frame fully clipped by its parent document does not create a result", () => {
  const { env, render } = frameFixture();
  const result = render();
  assert.equal(result.marks.length, 0);
  dispose(env, result);
});

test("a display:contents ancestor cannot clip the embedded frame", () => {
  const { env, render } = frameFixture({ parentStyle: "display:contents;overflow:hidden" });
  const result = render();
  assert.equal(result.marks.length, 1);
  dispose(env, result);
});

test("a frame's text color and font size do not hide its independent document", () => {
  const { env, render } = frameFixture({ parentStyle: "", frameStyle: "font-size:0;color:transparent" });
  const result = render();
  assert.equal(result.marks.length, 1);
  dispose(env, result);
});

test("zero-area frames and zero-size child viewports cannot count internal glyph rectangles", () => {
  for (const viewport of [false, true]) {
    const { env, frame, render } = frameFixture({ parentStyle: "", frameRect: viewport ? rect() : rect(20, 20, 0, 0) });
    if (viewport) Object.defineProperty(frame.contentWindow, "innerWidth", { value: 0, configurable: true });
    const result = render();
    assert.equal(result.marks.length, 0);
    dispose(env, result);
  }
});

test("nested frames inherit the geometry visibility of every embedding frame", () => {
  const { env, frame } = frameFixture();
  frame.contentDocument.body.innerHTML = "<iframe></iframe>";
  const inner = frame.contentDocument.querySelector("iframe");
  inner.contentDocument.body.innerHTML = "<p>hello</p>";
  installGeometry(inner.contentWindow);
  const node = inner.contentDocument.querySelector("p").firstChild;
  const result = env.engine.renderMatches([{ id: 0, node, text: node.nodeValue }], [{ chunkId: 0, start: 0, end: 5 }]);
  assert.equal(result.marks.length, 0);
  dispose(env, result);
});

test("thousands of contiguous normalization segments create one native Range", async () => {
  const text = "x".repeat(4096);
  const env = setup({ html: `<p id="t">${text}</p>` });
  const node = env.entries()[0].node;
  const originalCreateRange = env.doc.createRange.bind(env.doc);
  let created = 0;
  env.doc.createRange = () => { created++; return originalCreateRange(); };
  const entry = { id: 0, node, text, segments: Array.from({ length: text.length }, (_, start) => ({ node, start, end: start + 1, nodeStart: start, nodeEnd: start + 1 })) };
  const result = await env.engine.renderMatchesBatched([entry], [{ chunkId: 0, start: 0, end: text.length }], { batchSize: 10, budgetMs: 4 });
  assert.equal(result.marks.length, 1);
  assert.equal(result.marks[0].ranges.length, 1);
  assert.equal(created, 1);
  assert.equal(result.marks[0].range.toString(), text);
  assert.equal(result.marks[0].state.normal.size, 1);
  dispose(env, result);
});

test("twenty thousand matches share full-source validation instead of rescanning the run", () => {
  const text = "x".repeat(20000);
  const env = setup({ html: `<p id="t">${text}</p>` });
  const entries = env.entries();
  const original = String.prototype.slice;
  let fullSourceReads = 0;
  String.prototype.slice = function (start, end) {
    if (String(this) === text && end - start === text.length) fullSourceReads++;
    return original.call(this, start, end);
  };
  const matches = Array.from({ length: text.length }, (_, start) => ({ chunkId: 0, start, end: start + 1 }));
  let result;
  try {
    result = env.engine.renderMatches(entries, matches);
    assert.equal(result.marks.length, matches.length);
    assert.equal(fullSourceReads, 3, "one entry snapshot and two full-source checks are shared by all matches");
    for (const mark of [result.marks[0], result.marks[15000], result.marks.at(-1)]) assert.equal(env.engine.isValid(mark), true);
    assert.equal(fullSourceReads, 3);
  } finally {
    String.prototype.slice = original;
    if (result) dispose(env, result); else env.dom.window.close();
  }
});

test("unrelated mutation floods preserve snapshots while real source edits invalidate them", () => {
  const env = setup();
  const result = env.render();
  const outside = env.doc.createElement("div");
  env.doc.body.appendChild(outside);
  for (let i = 0; i < 2100; i++) outside.setAttribute("data-pulse", String(i));
  assert.equal(env.engine.isValid(result.marks[0]), true);
  env.entries()[0].node.nodeValue = "changed source";
  assert.equal(env.engine.isValid(result.marks[0]), false);
  dispose(env, result);
});

test("published native highlights drain mutation records without navigation and cancel cleanup on disposal", async () => {
  const callbacks = new Map(); let id = 0, elapsed = 0;
  const env = setup({ timers: {
    setTimeout(callback) { callbacks.set(++id, callback); return id; },
    clearTimeout(timer) { callbacks.delete(timer); }
  }, clock: { now() { elapsed += 7; return elapsed; } } });
  const result = env.render(), session = result.handles[0];
  const outside = env.doc.createElement('div'); env.doc.body.appendChild(outside);
  for (let i = 0; i < 200; i++) outside.setAttribute('data-pulse', String(i));
  await Promise.resolve();
  assert.equal(callbacks.size, 1);
  function tick() {
    const [timer, callback] = callbacks.entries().next().value;
    callbacks.delete(timer); callback();
  }
  tick();
  assert.ok(session.mutationSteps, 'large mutation batches are processed in slices');
  assert.equal(callbacks.size, 1);
  // A navigation between slices must finish the same batch, including records
  // that were delivered after the first slice.
  env.entries()[0].node.nodeValue = 'changed source';
  assert.equal(env.engine.isValid(result.marks[0]), false);
  assert.equal(session.mutationSteps, null);
  assert.equal(session.mutationQueue.length, 0);
  tick();
  assert.equal(callbacks.size, 0);
  for (let i = 0; i < 200; i++) outside.textContent = String(i);
  await Promise.resolve();
  for (let rounds = 0; callbacks.size && rounds < 100; rounds++) tick();
  assert.equal(session.mutationQueue.length, 0);
  assert.equal(session.mutationSteps, null);
  assert.equal(session.mutationValidation, null);
  assert.equal(callbacks.size, 0);
  outside.textContent = 'dispose pending'; await Promise.resolve();
  assert.equal(callbacks.size, 1);
  dispose(env, result);
  assert.equal(callbacks.size, 0);
  assert.equal(session.mutationSteps, null);
});

test("attribute invalidation checks a shared block once for dense bound results", () => {
  const env = setup({ html: '<p id="t">' + 'x'.repeat(500) + '</p><aside id="other"></aside>' });
  const node = env.doc.getElementById('t').firstChild, raw = node.nodeValue;
  const entries = Array.from({ length: 500 }, (_, id) => ({ id, node, kind: 'bound-text', displayLength: 1,
    boundSpans: [{ node, nodeStart: id, nodeEnd: id + 1, rawSnapshot: raw,
      snapshotStart: id, snapshotEnd: id + 1, start: 0, end: 1 }] }));
  const result = env.engine.renderMatches(entries, entries.map(({ id }) => ({ chunkId: id, start: 0, end: 1 })));
  assert.equal(result.marks.length, 500);
  const other = env.doc.getElementById('other'), originalContains = other.contains;
  let checks = 0;
  other.contains = function (target) { checks++; return originalContains.call(this, target); };
  other.setAttribute('data-pulse', '1');
  assert.equal(env.engine.isValid(result.marks[0]), true);
  assert.ok(checks < 10, `one unrelated attribute caused ${checks} ancestor checks`);
  env.doc.getElementById('t').setAttribute('style', 'display:none');
  assert.equal(env.engine.isValid(result.marks[499]), false);
  dispose(env, result);
});

test("inset clip paths that remove the whole painting area cannot create matches", () => {
  for (const clip of ["inset(100%)", "inset(50%)", "inset(0 100%)", "inset(100% 0 0)", "inset(10px 40px)", "inset(100% round 5px)"]) {
    const env = setup({ html: `<p id="t" style="clip-path:${clip}">hello world</p>` });
    const result = env.render();
    assert.equal(result.marks.length, 0, clip);
    dispose(env, result);
  }
});

test("partially visible inset clip paths and display:contents preserve visible matches", () => {
  for (const style of ["clip-path:inset(10%)", "clip-path:inset(0 0 0 5px)", "display:contents;clip-path:inset(100%)"]) {
    const env = setup({ html: `<p id="t" style="${style}">hello world</p>` });
    const result = env.render();
    assert.equal(result.marks.length, 1, style);
    dispose(env, result);
  }
});

test("DOM fallback draws every visible result beyond 1000 and prioritizes the current result", async () => {
  const text = "x".repeat(1001);
  const env = setup({ native: false, html: `<p id="t">${text}</p>` });
  env.dom.window.requestAnimationFrame = callback => env.dom.window.setTimeout(callback, 0);
  env.dom.window.cancelAnimationFrame = id => env.dom.window.clearTimeout(id);
  const originalAttach = env.dom.window.Element.prototype.attachShadow;
  let overlayRoot;
  env.dom.window.Element.prototype.attachShadow = function (options) {
    const root = originalAttach.call(this, options);
    if (this.hasAttribute("data-regex-rabbit-owned")) overlayRoot = root;
    return root;
  };
  const result = env.engine.renderMatches(env.entries(), Array.from({ length: text.length }, (_, start) => ({ chunkId: 0, start, end: start + 1 })));
  assert.equal(result.marks.length, text.length);
  assert.equal(env.engine.setCurrent(result.marks.at(-1)), true);
  for (let i = 0; i < 300; i++) {
    if (overlayRoot && Array.from(overlayRoot.firstChild.children).some(box => box.style.background === "rgb(255, 109, 0)")) break;
    await new Promise(resolve => env.dom.window.setTimeout(resolve, 10));
  }
  assert.ok(overlayRoot, JSON.stringify({ native: result.marks[0].state.native, frame: result.marks[0].state.frame,
    index: result.marks[0].state.paintJob && result.marks[0].state.paintJob.index, overlays: env.doc.querySelectorAll("[data-regex-rabbit-owned]").length }));
  for (let i = 0; i < 300 && result.marks[0].state.paintJob; i++) await new Promise(resolve => env.dom.window.setTimeout(resolve, 10));
  const boxes = Array.from(overlayRoot.firstChild.children);
  assert.equal(boxes.length, 1001);
  assert.ok(boxes.some(box => box.style.background === "rgb(255, 109, 0)"));
  dispose(env, result);
});

test("Canvas fallback draws all viewport rectangles using two layers and updates current colors", async () => {
  const env = setup({ native: false });
  env.dom.window.requestAnimationFrame = callback => env.dom.window.setTimeout(callback, 0);
  env.dom.window.cancelAnimationFrame = id => env.dom.window.clearTimeout(id);
  Object.defineProperty(env.dom.window, "devicePixelRatio", { configurable: true, value: 2 });
  env.dom.window.CanvasRenderingContext2D = class {};
  const contexts = [];
  env.dom.window.HTMLCanvasElement.prototype.getContext = function () {
    const calls = [];
    const context = { canvas: this, globalAlpha: 1, fillStyle: "", setTransform(...args) { this.transform = args; }, clearRect() { calls.length = 0; },
      fillRect(...args) { calls.push({ rect: args, color: this.fillStyle }); } };
    contexts.push({ context, calls });
    return context;
  };
  const rectangles = Array.from({ length: 1201 }, (_, index) => rect(20 + index % 100, 20 + index % 200, 1, 1));
  env.dom.window.Range.prototype.getClientRects = () => rectangles;
  const result = env.render();
  const state = result.marks[0].state;
  for (let i = 0; i < 300 && state.paintJob; i++) await new Promise(resolve => env.dom.window.setTimeout(resolve, 10));
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0].calls.length, rectangles.length);
  assert.equal(contexts[1].calls.length, 0);
  assert.equal(contexts[0].context.canvas.width, env.dom.window.innerWidth * 2);
  assert.deepEqual(contexts[0].context.transform, [2, 0, 0, 2, 0, 0]);
  assert.equal(contexts[0].context.globalAlpha, 0.5);
  assert.equal(state.layer.children.length, 2);
  assert.equal(env.engine.setCurrent(result.marks[0]), true);
  env.engine.updateConfig({ currentColor: "#e53935" });
  for (let i = 0; i < 300; i++) {
    if (contexts.at(-1).calls.length === rectangles.length && !state.paintJob && state.frame === null) break;
    await new Promise(resolve => env.dom.window.setTimeout(resolve, 10));
  }
  assert.equal(contexts.length, 2, "current/color changes reuse the two viewport buffers");
  assert.equal(contexts[0].calls.length, 0);
  assert.equal(contexts[1].calls.length, rectangles.length);
  assert.ok(contexts[1].calls.every(call => call.color === "#e53935"));
  assert.equal(state.layer.children.length, 2);
  const canvases = Array.from(state.layer.children);
  env.dom.window.dispatchEvent(new env.dom.window.Event("scroll"));
  for (let i = 0; i < 300 && (state.frame !== null || state.paintJob); i++) await new Promise(resolve => env.dom.window.setTimeout(resolve, 10));
  assert.equal(contexts.length, 2, "scroll redraws reuse the same canvases");
  assert.deepEqual(Array.from(state.layer.children), canvases);
  env.dom.window.innerWidth = 900;
  Object.defineProperty(env.dom.window, "devicePixelRatio", { configurable: true, value: 2.5 });
  env.dom.window.dispatchEvent(new env.dom.window.Event("resize"));
  for (let i = 0; i < 300 && (state.frame !== null || state.paintJob); i++) await new Promise(resolve => env.dom.window.setTimeout(resolve, 10));
  assert.equal(contexts.length, 2, "viewport changes resize existing buffers");
  assert.deepEqual(Array.from(state.layer.children), canvases);
  assert.equal(canvases[0].width, 2250);
  assert.equal(canvases[0].style.width, "900px");
  assert.equal(canvases[0].style.getPropertyPriority("width"), "important");
  assert.deepEqual(contexts[0].context.transform, [2.5, 0, 0, 2.5, 0, 0]);
  dispose(env, result);
  assert.ok(canvases.every(canvas => !canvas.isConnected));
  assert.ok(canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  assert.equal(state.canvasLayers, null);
});

test("Canvas allocation or drawing failure resumes an uncapped DOM cursor", async () => {
  const env = setup({ native: false });
  env.dom.window.requestAnimationFrame = callback => env.dom.window.setTimeout(callback, 0);
  env.dom.window.cancelAnimationFrame = id => env.dom.window.clearTimeout(id);
  env.dom.window.CanvasRenderingContext2D = class {};
  let allocations = 0;
  env.dom.window.HTMLCanvasElement.prototype.getContext = function () {
    allocations++;
    return { setTransform() {}, clearRect() {}, fillRect() { throw new Error("actual drawing resource failure"); } };
  };
  env.dom.window.Range.prototype.getClientRects = () => Array.from({ length: 1001 }, () => rect());
  const node = env.entries()[0].node, result = env.render(), state = result.marks[0].state;
  for (let i = 0; i < 300; i++) {
    if (state.layer && state.layer.children.length === 1001 && !state.paintJob) break;
    await new Promise(resolve => env.dom.window.setTimeout(resolve, 10));
  }
  assert.equal(allocations, 2);
  assert.equal(state.canvasFailed, true);
  assert.equal(state.layer.children.length, 1001);
  assert.ok(Array.from(state.layer.children).every(element => element.tagName === "DIV"));
  assert.equal(env.entries()[0].node, node);
  assert.equal(result.marks.length, 1);
  dispose(env, result);
});

function hiddenGapEntry(env) {
  const parent = env.doc.getElementById("t");
  return { id: 0, node: parent.firstChild, text: "ab", segments: [
    { node: parent.firstChild, start: 0, end: 1 }, { node: parent.lastChild, start: 1, end: 2 }
  ] };
}

test("a static collection guard skips anchor style reads but preserves part connection and root checks", () => {
  const env = setup({ html: `${Array.from({ length: 100 }, (_, index) => `<p id="t${index}">row ${index}</p>`).join("")}<div id="host"></div>` });
  const shadow = env.doc.getElementById("host").attachShadow({ mode: "open" });
  shadow.textContent = "untracked shadow text";
  const entries = Array.from(env.doc.querySelectorAll("p"), (parent, id) => ({ id, node: parent.firstChild, text: parent.textContent }));
  const originalStyle = env.dom.window.getComputedStyle.bind(env.dom.window);
  let styleReads = 0;
  env.dom.window.getComputedStyle = (...args) => { styleReads++; return originalStyle(...args); };
  const guard = env.engine.createCollectionGuard();
  guard.addRoot(env.doc);
  for (const entry of entries) assert.equal(guard.isEntryCurrent(entry), true);
  assert.equal(guard.isEntryCurrent({ node: entries[0].node, segments: [{ node: entries[0].node }, { node: env.doc.createTextNode("detached") }] }), false);
  assert.equal(guard.isEntryCurrent({ node: entries[0].node, segments: [{ node: entries[0].node }, { node: shadow.firstChild }] }), false);
  assert.equal(styleReads, 0, "no mutation needs a styled anchor");
  env.doc.body.classList.add("changed-ancestor");
  assert.equal(guard.isEntryCurrent(entries[0]), false, "the first ancestor mutation must invalidate a cached static entry");
  assert.ok(styleReads > 0, "real changes still use the full anchor path");
  guard.dispose(); env.dom.window.close();
});

test("a static collection guard detects the first inserted gap after its fast path", () => {
  const env = setup({ html: '<p id="t">a<span hidden>x</span>b</p>' });
  const guard = env.engine.createCollectionGuard();
  guard.addRoot(env.doc);
  const entry = hiddenGapEntry(env);
  assert.equal(guard.isEntryCurrent(entry), true);
  const parent = env.doc.getElementById("t");
  parent.insertBefore(env.doc.createTextNode("X"), parent.lastChild);
  assert.equal(guard.isEntryCurrent(entry), false);
  guard.dispose(); env.dom.window.close();
});

test("ancestor class and custom-property changes invalidate descendant text context", () => {
  for (const change of [doc => { doc.body.className = "show"; }, doc => { doc.body.style.setProperty("--gap-display", "inline"); }]) {
    const env = setup({ html: '<style>.gap{display:none}.show .gap{display:inline}</style><p id="t">a<span class="gap">x</span>b</p>' });
    const result = env.engine.renderMatches([hiddenGapEntry(env)], [{ chunkId: 0, start: 0, end: 2 }]);
    assert.equal(result.marks.length, 1);
    change(env.doc);
    assert.equal(env.engine.isValid(result.marks[0]), false);
    dispose(env, result);
  }
});

test("page stylesheet DOM changes invalidate joined context while owned styles do not", () => {
  const env = setup({ html: '<style>.gap{display:none}</style><p id="t">a<span class="gap">x</span>b</p>' });
  const result = env.engine.renderMatches([hiddenGapEntry(env)], [{ chunkId: 0, start: 0, end: 2 }]);
  env.engine.updateConfig({ highlightColor: "#def" });
  assert.equal(env.engine.isValid(result.marks[0]), true);
  env.doc.querySelector("style:not([data-regex-rabbit-owned])").textContent = ".gap{display:inline}";
  assert.equal(env.engine.isValid(result.marks[0]), false);
  dispose(env, result);
});

test("collection guard rejects visible gap insertions between collection and rendering", async () => {
  const env = setup({ html: '<p id="t">a<span hidden>x</span>b</p>' });
  const guard = env.engine.createCollectionGuard();
  guard.addRoot(env.doc);
  const entry = hiddenGapEntry(env);
  const parent = env.doc.getElementById("t");
  parent.insertBefore(env.doc.createTextNode("X"), parent.lastChild);
  assert.equal(guard.isEntryCurrent(entry), false);
  const result = await env.engine.renderMatchesBatched([entry], [{ chunkId: 0, start: 0, end: 2 }], { collectionGuard: guard });
  assert.equal(result.marks.length, 0);
  assert.equal(env.registry.size, 0);
  guard.dispose();
  dispose(env, result);
});

test("collection guard keeps unrelated blocks and extension UI changes readable", () => {
  const env = setup({ html: '<p id="t">hello world</p><p id="other">second</p>' });
  const guard = env.engine.createCollectionGuard();
  guard.addRoot(env.doc);
  const entries = env.entries();
  const other = env.doc.getElementById("other").firstChild;
  other.nodeValue = "changed";
  const ui = env.doc.createElement("div");
  ui.setAttribute("data-regex-rabbit-owned", "true");
  env.doc.body.appendChild(ui);
  ui.textContent = "query text";
  assert.equal(guard.isEntryCurrent(entries[0]), true);
  const result = env.engine.renderMatches(entries, [{ chunkId: 0, start: 0, end: 5 }], { collectionGuard: guard });
  assert.equal(result.marks.length, 1);
  guard.dispose();
  assert.equal(guard.isEntryCurrent(entries[0]), false);
  dispose(env, result);
});

test("collection guard rejects ancestor attribute and stylesheet changes", () => {
  for (const change of [doc => { doc.body.className = "show"; }, doc => { doc.querySelector("style").textContent = ".gap{display:inline}"; }]) {
    const env = setup({ html: '<style>.gap{display:none}</style><p id="t">a<span class="gap">x</span>b</p>' });
    const guard = env.engine.createCollectionGuard();
    guard.addRoot(env.doc);
    const entry = hiddenGapEntry(env);
    change(env.doc);
    assert.equal(guard.isEntryCurrent(entry), false);
    guard.dispose();
    env.dom.window.close();
  }
});

test("collection guard watches closed roots and ignores untracked documents", () => {
  const env = setup({ html: '<div id="host"></div><iframe></iframe>' });
  const host = env.doc.getElementById("host");
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = "hello";
  env.scope.chrome = { dom: { openOrClosedShadowRoot: element => element === host ? root : null } };
  const guard = env.engine.createCollectionGuard();
  guard.addRoot(env.doc); guard.addRoot(root); guard.addRoot(root);
  const entry = { id: 0, node: root.firstChild, text: "hello" };
  assert.equal(guard.isEntryCurrent(entry), true);
  root.firstChild.insertData(5, " changed");
  assert.equal(guard.isEntryCurrent(entry), false);
  const frameDoc = env.doc.querySelector("iframe").contentDocument;
  frameDoc.body.textContent = "other";
  assert.equal(guard.isEntryCurrent({ id: 1, node: frameDoc.body.firstChild, text: "other" }), false);
  guard.dispose(); env.dom.window.close();
});

test("collection guard processes unrelated mutation floods and releases shared observers", () => {
  const env = setup({ html: '<p id="t">hello world</p><div id="outside"></div>' });
  const Original = env.dom.window.MutationObserver;
  let disconnected = 0;
  env.dom.window.MutationObserver = class extends Original {
    disconnect() { disconnected++; super.disconnect(); }
  };
  const guard = env.engine.createCollectionGuard();
  guard.addRoot(env.doc); guard.addRoot(env.doc);
  for (let i = 0; i < 2100; i++) env.doc.getElementById("outside").setAttribute("data-pulse", String(i));
  assert.equal(guard.isEntryCurrent(env.entries()[0]), true);
  env.entries()[0].node.nodeValue = "changed source";
  assert.equal(guard.isEntryCurrent(env.entries()[0]), false);
  guard.dispose(); guard.dispose();
  assert.equal(disconnected, 1);
  env.dom.window.close();
});

test("mutation revalidation yields and honors cancellation instead of dropping results by record count", async () => {
  const env = setup({ html: '<p id="t">hello world</p><div id="outside"></div>' });
  const guard = env.engine.createCollectionGuard(); guard.addRoot(env.doc);
  for (let i = 0; i < 5000; i++) env.doc.getElementById("outside").setAttribute("data-pulse", String(i));
  let checks = 0;
  const result = await env.engine.renderMatchesBatched(env.entries(), [{ chunkId: 0, start: 0, end: 5 }],
    { collectionGuard: guard, batchSize: 1, shouldContinue: () => ++checks < 3 });
  assert.equal(result.cancelled, true);
  assert.equal(env.registry.size, 0);
  guard.dispose(); env.dom.window.close();
});

test("large unrelated child-list records and inserted subtrees do not reject matches", () => {
  for (const subtree of [false, true]) {
    const env = setup({ html: '<p id="t">hello world</p><div id="outside"></div>' });
    const guard = env.engine.createCollectionGuard();
    guard.addRoot(env.doc);
    const entries = env.entries();
    const result = env.engine.renderMatches(entries, [{ chunkId: 0, start: 0, end: 5 }]);
    const fragment = env.doc.createDocumentFragment();
    const root = subtree ? env.doc.createElement("div") : fragment;
    for (let i = 0; i < 3000; i++) root.appendChild(env.doc.createElement("span"));
    if (subtree) fragment.appendChild(root);
    env.doc.getElementById("outside").appendChild(fragment);
    assert.equal(guard.isEntryCurrent(entries[0]), true);
    assert.equal(env.engine.isValid(result.marks[0]), true);
    guard.dispose(); dispose(env, result);
  }
});

test("control display transforms scan full values only once per validation context", () => {
  const originalTest = RegExp.prototype.test;
  const raw = "x".repeat(2000);
  for (const transform of ["none", "uppercase"]) {
    const env = setup({ html: `<input id="control" style="text-transform:${transform}" value="${raw}">` });
    const control = env.doc.getElementById("control");
    let fullAsciiChecks = 0;
    RegExp.prototype.test = function (value) {
      if (this.source === "^[\\x00-\\x7f]*$" && value === raw) fullAsciiChecks++;
      return originalTest.call(this, value);
    };
    let result;
    try {
      result = env.engine.renderMatches([{ id: 0, node: control, kind: "control", text: transform === "uppercase" ? raw.toUpperCase() : raw, displayTextSnapshot: raw }],
        Array.from({ length: raw.length }, (_, start) => ({ chunkId: 0, start, end: start + 1 })));
      assert.equal(result.marks.length, raw.length);
      assert.equal(fullAsciiChecks, transform === "uppercase" ? 2 : 0);
    } finally {
      RegExp.prototype.test = originalTest;
      if (result) dispose(env, result); else env.dom.window.close();
    }
  }
});

test("collection guard drains only roots related to each entry", () => {
  const env = setup({ html: '<p id="t">hello world</p>' });
  const docs = [env.doc];
  for (let i = 0; i < 24; i++) {
    const frame = env.doc.createElement("iframe");
    env.doc.body.appendChild(frame);
    docs.push(frame.contentDocument);
  }
  let drains = 0;
  for (const doc of docs) {
    const Original = doc.defaultView.MutationObserver;
    doc.defaultView.MutationObserver = class extends Original {
      takeRecords() { drains++; return super.takeRecords(); }
    };
  }
  const guard = env.engine.createCollectionGuard();
  docs.forEach(doc => guard.addRoot(doc));
  const entry = env.entries()[0];
  assert.equal(guard.isEntryCurrent(entry), true);
  assert.equal(drains, 1);
  assert.equal(guard.isEntryCurrent(entry), true);
  assert.equal(drains, 2);
  guard.dispose(); env.dom.window.close();
});

test("outer closed shadow attributes invalidate inner-root context", () => {
  const env = setup({ html: '<div id="outer"></div>' });
  const outer = env.doc.getElementById("outer");
  const outerRoot = outer.attachShadow({ mode: "closed" });
  const inner = env.doc.createElement("div");
  outerRoot.appendChild(inner);
  const innerRoot = inner.attachShadow({ mode: "closed" });
  innerRoot.innerHTML = '<p>a<span hidden>x</span>b</p>';
  env.scope.chrome = { dom: { openOrClosedShadowRoot: element => element === outer ? outerRoot : element === inner ? innerRoot : null } };
  const p = innerRoot.querySelector("p");
  const entry = { id: 0, node: p.firstChild, text: "ab", segments: [
    { node: p.firstChild, start: 0, end: 1 }, { node: p.lastChild, start: 1, end: 2 }
  ] };
  const result = env.engine.renderMatches([entry], [{ chunkId: 0, start: 0, end: 2 }]);
  assert.equal(result.marks.length, 1);
  inner.className = "show-gap";
  assert.equal(env.engine.isValid(result.marks[0]), false);
  dispose(env, result);
});

test("a guard started from only a child Document observes its embedding documents", () => {
  const { env, frame } = frameFixture({ parentStyle: "" });
  const doc = frame.contentDocument;
  const node = doc.querySelector("p").firstChild;
  const entry = { id: 0, node, text: node.nodeValue };
  const guard = env.engine.createCollectionGuard();
  guard.addRoot(doc);
  assert.equal(guard.isEntryCurrent(entry), true);
  const result = env.engine.renderMatches([entry], [{ chunkId: 0, start: 0, end: 5 }], { collectionGuard: guard });
  assert.equal(result.marks.length, 1);
  env.doc.body.className = "page-theme";
  assert.equal(guard.isEntryCurrent(entry), false);
  guard.dispose(); dispose(env, result);
});

test("a guard started from only an inner closed root observes its full shadow ancestry", () => {
  const env = setup({ html: '<div id="outer"></div>' });
  const outer = env.doc.getElementById("outer");
  const outerRoot = outer.attachShadow({ mode: "closed" });
  const inner = env.doc.createElement("div"); outerRoot.appendChild(inner);
  const innerRoot = inner.attachShadow({ mode: "closed" }); innerRoot.innerHTML = "hello world";
  env.scope.chrome = { dom: { openOrClosedShadowRoot: element => element === outer ? outerRoot : element === inner ? innerRoot : null } };
  const entry = { id: 0, node: innerRoot.firstChild, text: "hello world" };
  const guard = env.engine.createCollectionGuard(); guard.addRoot(innerRoot);
  assert.equal(guard.isEntryCurrent(entry), true);
  inner.className = "changed-style-context";
  assert.equal(guard.isEntryCurrent(entry), false);
  guard.dispose(); env.dom.window.close();
});
