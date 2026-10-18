import assert from "node:assert/strict";
import { readRuntimeSource as readFile } from "../fixtures/runtime_source.mjs";
import test from "node:test";
import { JSDOM } from "jsdom";

const source = await readFile("infra/text_collector.js", "utf8");
const visibilitySource = await readFile("infra/page_visibility.js", "utf8");
const mappingSource = await readFile("infra/text_mapping.js", "utf8");

function setup(html, chrome) {
  const dom = new JSDOM(html, { url: "https://test.com" });
  const scope = { chrome };
  globalThis.document = dom.window.document;
  globalThis.NodeFilter = dom.window.NodeFilter;
  new Function("globalThis", visibilitySource)(scope);
  new Function("globalThis", mappingSource)(scope);
  new Function("globalThis", source)(scope);
  scope.RRTextCollector.document = dom.window.document;
  scope.RRTextCollector.visibility = scope.RRPageVisibility;
  scope.RRTextCollector.mapping = scope.RRTextMapping;
  return scope.RRTextCollector;
}

test("collect text from simple page", () => {
  const tc = setup('<body><p>hello</p><p>world</p></body>');
  const nodes = tc.collect();
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].id, 0);
  assert.equal(nodes[0].text, "hello");
  assert.equal(nodes[1].id, 1);
  assert.equal(nodes[1].text, "world");
});

test("exclude script tags", () => {
  const tc = setup('<body><script>var x=1;</script><p>visible</p></body>');
  const nodes = tc.collect();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].text, "visible");
});

test("exclude style tags", () => {
  const tc = setup('<body><style>body{}</style><p>text</p></body>');
  const nodes = tc.collect();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].text, "text");
});

test("exclude noscript tags", () => {
  const tc = setup('<body><noscript>no js</noscript><p>text</p></body>');
  const nodes = tc.collect();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].text, "text");
});

test("collect current textarea value once", () => {
  const tc = setup('<body><textarea>editable</textarea><p>text</p></body>');
  tc.document.querySelector("textarea").value = "current value";
  const nodes = tc.collect();
  assert.deepEqual(nodes.map(n => n.text), ["current value", "text"]);
  assert.equal(nodes[0].kind, "control");
});

test("collect contenteditable visible text", () => {
  const tc = setup('<body><div contenteditable="true">edit me</div><p>text</p></body>');
  const nodes = tc.collect();
  assert.deepEqual(nodes.map(n => n.text), ["edit me", "text"]);
});

test("exclude own UI container", () => {
  const tc = setup('<body><div id="regex-search-container">search</div><p>text</p></body>');
  const nodes = tc.collect();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].text, "text");
});

test("skip whitespace-only nodes", () => {
  const tc = setup('<body><p>   \n  </p><p>real</p></body>');
  const nodes = tc.collect();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].text, "real");
});

test("collect deeply nested text", () => {
  const tc = setup('<body><div><div><div><p>deep</p></div></div></div></body>');
  const nodes = tc.collect();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].text, "deep");
});

test("empty body returns no nodes", () => {
  const tc = setup('<body></body>');
  const nodes = tc.collect();
  assert.equal(nodes.length, 0);
});

test("ids increment sequentially", () => {
  const tc = setup('<body><p>a</p><p>b</p><p>c</p></body>');
  const nodes = tc.collect();
  for (let i = 0; i < nodes.length; i++) {
    assert.equal(nodes[i].id, i);
  }
});

test("collectBatched returns same text order as collect", async () => {
  const tc = setup('<body><p>a</p><p>b</p><script>skip</script><p>c</p></body>');
  const syncNodes = tc.collect().map(n => n.text);
  const batchedNodes = await tc.collectBatched({ batchSize: 1, budgetMs: 1 });
  assert.deepEqual(batchedNodes.map(n => n.text), syncNodes);
});

test("collect skips excluded subtrees", () => {
  const tc = setup('<body><script><span>skip</span></script><style>.x{}</style><p>keep</p></body>');
  const nodes = tc.collect();
  assert.deepEqual(nodes.map(n => n.text), ["keep"]);
});

test("collectBatched onBatch can stop traversal early", async () => {
  const tc = setup('<body><p>a</p><p>b</p><p>c</p><p>d</p></body>');
  const batches = [];
  const nodes = await tc.collectBatched({
    batchSize: 2,
    budgetMs: 1000,
    onBatch(batch) {
      batches.push(batch.map(n => n.text));
      return false;
    }
  });

  assert.deepEqual(batches, [["a", "b"]]);
  assert.deepEqual(nodes.map(n => n.text), ["a", "b"]);
});

test("collectBatched can stream batches without storing duplicate node list", async () => {
  const tc = setup('<body><p>a</p><p>b</p><p>c</p></body>');
  const streamed = [];
  const nodes = await tc.collectBatched({
    batchSize: 2,
    storeNodes: false,
    onBatch(batch) {
      streamed.push(...batch.map(n => n.text));
      return true;
    }
  });

  assert.deepEqual(streamed, ["a", "b", "c"]);
  assert.deepEqual(nodes, []);
});

test("collect does not depend on selector matching for exclusions", () => {
  const tc = setup('<body><script>skip</script><div id="regex-search-container">ui</div><p>keep</p></body>');
  const oldMatches = globalThis.document.defaultView.Element.prototype.matches;
  globalThis.document.defaultView.Element.prototype.matches = function () {
    throw new Error("matches should not be called");
  };
  try {
    const nodes = tc.collect();
    assert.deepEqual(nodes.map(n => n.text), ["keep"]);
  } finally {
    globalThis.document.defaultView.Element.prototype.matches = oldMatches;
  }
});

test("merge inline text with exact cumulative segment mapping", () => {
  const tc = setup('<body><p>Hello <strong>world</strong>!</p><p>Separate</p></body>');
  const entries = tc.collect();
  assert.deepEqual(entries.map(e => e.text), ["Hello world!", "Separate"]);
  assert.equal(entries[0].segments.length, 3);
  assert.deepEqual(entries[0].segments.map(s => [s.start, s.end, s.nodeStart, s.nodeEnd]), [
    [0, 6, 0, 6], [6, 11, 0, 5], [11, 12, 0, 1]
  ]);
  for (const segment of entries[0].segments) {
    assert.equal(segment.node.nodeValue.slice(segment.nodeStart, segment.nodeEnd), entries[0].text.slice(segment.start, segment.end));
  }
});

test("do not concatenate separate nested blocks or explicit line breaks", () => {
  const tc = setup('<body><div>before<p>middle</p>after<br>last</div><table><tr><td>A</td><td>B</td></tr></table></body>');
  assert.deepEqual(tc.collect().map(e => e.text), ["before", "middle", "after", "last", "A", "B"]);
});

test("hidden subtrees are pruned, while visibility and font size may be restored", () => {
  const tc = setup(`<body>
    <p hidden>hidden attr</p><p style="display:none">display none</p>
    <div style="opacity:0"><span style="opacity:1">transparent ancestor</span></div>
    <div style="content-visibility:hidden">locked</div>
    <div style="visibility:hidden">invisible<span style="visibility:visible">restored</span></div>
    <div style="font-size:0">zero<span style="font-size:16px">readable</span></div>
    <p aria-hidden="true">visually present</p><p inert>inert present</p>
  </body>`);
  assert.deepEqual(tc.collect().map(e => e.text.trim()).filter(Boolean), ["restored", "readable", "visually present", "inert present"]);
});

test("author display rules can make a hidden element visually present", () => {
  const tc = setup('<body><p hidden style="display:block">shown by CSS</p></body>');
  assert.deepEqual(tc.collect().map(e => e.text), ["shown by CSS"]);
});

test("closed details exposes only its first summary, then updates when opened", () => {
  const tc = setup('<body><details>hidden prefix<summary>Shown <em>summary</em></summary><p>Secret</p><summary>Second summary</summary></details></body>');
  assert.deepEqual(tc.collect().map(e => e.text), ["Shown summary"]);
  tc.document.querySelector("details").open = true;
  assert.deepEqual(tc.collect().map(e => e.text), ["hidden prefix", "Shown summary", "Secret", "Second summary"]);
});

test("native controls use displayed current values and omit nontext or password inputs", () => {
  const tc = setup(`<body>
    <input value="initial"><input type="search" value="query"><input type="email" value="a@b.test">
    <input type="password" value="secret"><input type="hidden" value="internal">
    <input type="checkbox" value="checked token"><input type="range" value="3">
    <input type="color" value="#ffffff"><input type="file"><input type="date" value="2026-10-05">
    <textarea>initial text</textarea>
  </body>`);
  tc.document.querySelector("input").value = "current";
  tc.document.querySelector("textarea").value = "current text";
  const entries = tc.collect();
  assert.deepEqual(entries.map(e => e.text), ["current", "query", "a@b.test", "current text"]);
  assert.ok(entries.every(e => e.kind === "control"));
  assert.equal(entries.stats.controlEntries, 4);
  assert.deepEqual(tc.collect({ includeControls: false }).map(e => e.text), []);
});

test("hidden controls and controls inside closed details are excluded", () => {
  const tc = setup('<body><input style="display:none" value="hidden"><textarea style="visibility:hidden">invisible</textarea><details><summary>title</summary><input value="secret"></details></body>');
  assert.deepEqual(tc.collect().map(e => e.text), ["title"]);
});

test("open shadow DOM and assigned slots are traversed in composed order without duplicates", () => {
  const tc = setup('<body><section id="host"><span slot="label">assigned</span><span>unassigned</span></section><p>outside</p></body>');
  const host = tc.document.getElementById("host");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = '<p>shadow <slot name="label">fallback hidden</slot> end</p><p>tail</p>';
  const seenRoots = [];
  const entries = tc.collect({ onRoot: root => seenRoots.push(root) });
  assert.deepEqual(entries.map(e => e.text), ["shadow assigned end", "tail", "outside"]);
  assert.equal(entries.filter(e => e.text.includes("assigned")).length, 1);
  assert.ok(!entries.some(e => e.text.includes("unassigned") || e.text.includes("fallback hidden")));
  assert.deepEqual(entries.roots, [tc.document, shadow]);
  assert.deepEqual(seenRoots, entries.roots);
  assert.equal(entries.stats.shadowRoots, 1);
});

test("slots retain fallback text when nothing is assigned and refresh on assignment", () => {
  const tc = setup('<body><div id="host"></div></body>');
  const host = tc.document.getElementById("host");
  host.attachShadow({ mode: "open" }).innerHTML = '<p>before <slot>fallback</slot> after</p>';
  assert.deepEqual(tc.collect().map(e => e.text), ["before fallback after"]);
  host.textContent = "assigned";
  assert.deepEqual(tc.collect().map(e => e.text), ["before assigned after"]);
});

test("nested slots and nested shadows collect each assigned text node once", () => {
  const tc = setup('<body><div id="outer"><span id="inner">inner light</span></div></body>');
  const outer = tc.document.getElementById("outer");
  outer.attachShadow({ mode: "open" }).innerHTML = '<slot></slot>';
  const inner = tc.document.getElementById("inner");
  inner.attachShadow({ mode: "open" }).innerHTML = '<span>inner shadow</span><slot></slot>';
  const entries = tc.collect();
  assert.deepEqual(entries.map(e => e.text), ["inner shadowinner light"]);
  assert.equal(entries.stats.shadowRoots, 2);
});

test("standard DOM access cannot expose closed shadows when the extension binding is absent", () => {
  const tc = setup('<body><div id="host"></div><p>outside</p></body>');
  tc.document.getElementById("host").attachShadow({ mode: "closed" }).textContent = "inaccessible shadow";
  const entries = tc.collect();
  assert.deepEqual(entries.map(e => e.text), ["outside"]);
  assert.equal(entries.stats.shadowRoots, 0);
});

test("nested same-origin frames are collected with separate text runs and roots", () => {
  const tc = setup('<body><p>before</p><iframe></iframe><p>after</p></body>');
  const frame = tc.document.querySelector("iframe");
  frame.contentDocument.body.innerHTML = '<p>frame</p><iframe></iframe>';
  frame.contentDocument.querySelector("iframe").contentDocument.body.innerHTML = '<p>nested</p>';
  const entries = tc.collect();
  assert.deepEqual(entries.map(e => e.text), ["before", "frame", "nested", "after"]);
  assert.equal(entries.stats.frames, 2);
  assert.equal(entries.roots.length, 3);
});

test("inaccessible frames are counted and iframe fallback text is never searched", () => {
  const tc = setup('<body><iframe>fallback invisible</iframe><p>outside</p></body>');
  const frame = tc.document.querySelector("iframe");
  Object.defineProperty(frame, "contentDocument", { get() { throw new Error("SecurityError"); } });
  const entries = tc.collect();
  assert.deepEqual(entries.map(e => e.text), ["outside"]);
  assert.equal(entries.stats.frames, 1);
  assert.equal(entries.stats.inaccessibleFrames, 1);
});

test("a hidden frame cannot be restored by visibility rules in its document", () => {
  const tc = setup('<body><iframe style="visibility:hidden"></iframe><p>outside</p></body>');
  const frame = tc.document.querySelector("iframe");
  frame.contentDocument.body.innerHTML = '<p style="visibility:visible">still invisible</p>';
  const entries = tc.collect();
  assert.deepEqual(entries.map(e => e.text), ["outside"]);
  assert.equal(entries.stats.hiddenFrames, 1);
  assert.equal(tc.visibility.isVisible(frame.contentDocument.querySelector("p")), false);
});

test("selected roots restrict traversal and include inherited ancestor visibility", () => {
  const tc = setup('<body><section id="chosen"><p>inside</p></section><p>outside</p><div hidden><p id="invisible">hidden</p></div></body>');
  assert.deepEqual(tc.collect({ root: tc.document.getElementById("chosen") }).map(e => e.text), ["inside"]);
  assert.deepEqual(tc.collect({ root: tc.document.getElementById("invisible") }).map(e => e.text), []);
});

test("elements outside the viewport remain searchable", () => {
  const tc = setup('<body><p style="position:absolute;top:100000px">scroll to this</p></body>');
  assert.deepEqual(tc.collect().map(e => e.text), ["scroll to this"]);
});

test("extension-owned nodes and non-rendered canvas/SVG definition content are excluded", () => {
  const tc = setup('<body><div data-regex-rabbit-owned="true">overlay</div><canvas>fallback</canvas><svg><defs><text>definition</text></defs><text>actual svg text</text><desc>description</desc></svg></body>');
  assert.deepEqual(tc.collect().map(e => e.text), ["actual svg text"]);
});

test("oversized runs are omitted whole rather than creating false boundary matches", () => {
  const tc = setup('<body><p>abcd<span>efgh</span></p><p>ok</p><textarea>toolong</textarea></body>');
  const entries = tc.collect({ maxRunChars: 4 });
  assert.deepEqual(entries.map(e => e.text), ["ok"]);
  assert.equal(entries.stats.oversizedRuns, 2);
  assert.equal(entries.stats.oversizedCharacters, 15);
  assert.equal(entries.stats.truncated, true);
});

test("segment budgets omit deeply fragmented runs without losing subsequent blocks", () => {
  const tc = setup('<body><p>a<span>b</span><em>c</em></p><p>ok</p></body>');
  const entries = tc.collect({ maxRunSegments: 2 });
  assert.deepEqual(entries.map(e => e.text), ["ok"]);
  assert.equal(entries.stats.oversizedRuns, 1);
  assert.deepEqual(entries.stats.reasons, ["run-segments"]);
});

test("total budgets do not cut text and report which limit ended traversal", () => {
  const tc = setup('<body><p>one</p><p>two</p><p>three</p></body>');
  const byChars = tc.collect({ maxChars: 5 });
  assert.deepEqual(byChars.map(e => e.text), ["one"]);
  assert.deepEqual(byChars.stats.reasons, ["characters"]);
  const byEntries = tc.collect({ maxEntries: 1 });
  assert.deepEqual(byEntries.map(e => e.text), ["one"]);
  assert.deepEqual(byEntries.stats.reasons, ["entries"]);
  const byNodes = tc.collect({ maxVisitedNodes: 2 });
  assert.ok(byNodes.stats.visitedNodes <= 2);
  assert.deepEqual(byNodes.stats.reasons, ["nodes"]);
});

test("streaming emits unchanged entries, metadata is non-enumerable, and IDs stay sequential", async () => {
  const tc = setup('<body><p>A <span>B</span></p><input value="C"><p>D</p></body>');
  const streamed = [];
  const entries = await tc.collectBatched({ batchSize: 1, storeNodes: false, onBatch: batch => streamed.push(...batch) });
  assert.deepEqual(entries, []);
  assert.equal(entries.stats.entries, 3);
  assert.deepEqual(streamed.map(e => [e.id, e.text]), [[0, "A B"], [1, "C"], [2, "D"]]);
  assert.ok(entries.roots.includes(tc.document));
  assert.deepEqual(Object.keys(entries), []);
});

test("empty-element traversal yields and cancellation discards its incomplete run", async () => {
  const tc = setup('<body><p>partial<span></span><span></span><span></span><span></span><span>tail</span></p></body>');
  let yields = 0;
  const entries = await tc.collectBatched({ batchSize: 2, shouldContinue: () => yields < 2,
    onStats(stats) { if (!stats.aborted) yields++; } });
  assert.equal(yields, 2);
  assert.deepEqual(entries.map(e => e.text), []);
  assert.equal(entries.stats.aborted, true);
  assert.deepEqual(entries.stats.reasons, ["cancelled"]);
});

test("AbortSignal cancellation before collection avoids DOM reads and reports cancellation", async () => {
  const tc = setup('<body><p>text</p></body>');
  const controller = new AbortController();
  controller.abort();
  const entries = await tc.collectBatched({ signal: controller.signal });
  assert.deepEqual(entries.map(e => e.text), []);
  assert.equal(entries.stats.visitedNodes, 0);
  assert.equal(entries.stats.aborted, true);
  assert.deepEqual(entries.stats.reasons, ["signal"]);
});

test("a fresh scan recomputes visibility after dynamic style and editable changes", () => {
  const tc = setup('<body><p id="p">initial</p><input value="old"></body>');
  assert.deepEqual(tc.collect().map(e => e.text), ["initial", "old"]);
  tc.document.querySelector("p").style.display = "none";
  tc.document.querySelector("input").value = "new";
  assert.deepEqual(tc.collect().map(e => e.text), ["new"]);
});

test("normal whitespace is collapsed across inline nodes with source offset maps", () => {
  const tc = setup('<body><p>  a     <span>  b\n\t</span> c  </p></body>');
  const entries = tc.collect();
  assert.deepEqual(entries.map(e => e.text), ["a b c"]);
  assert.ok(entries[0].segments.some(s => s.end - s.start === 1 && s.nodeEnd - s.nodeStart > 1));
  for (const s of entries[0].segments) assert.equal(s.node.nodeValue.slice(s.nodeStart, s.nodeEnd), s.sourceText);
  assert.equal(entries.stats.characters, 5);
  assert.equal(entries.stats.sourceCharacters, 17);
});

test("preformatted whitespace is preserved through inline descendants", () => {
  const tc = setup('<body><pre> a  <span>b\n c </span> </pre><p style="white-space:pre-wrap"> d  e </p><p style="white-space:pre-line"> f  g\n h </p></body>');
  assert.deepEqual(tc.collect().map(e => e.text), [" a  b\n c  ", " d  e ", "f g\nh"]);
});

test("single ordinary spaces do not allocate a separate segment per word", () => {
  const tc = setup('<body><p>one two three four five</p></body>');
  const entry = tc.collect()[0];
  assert.equal(entry.segments.length, 1);
  assert.equal(entry.text, "one two three four five");
});

test("ASCII CSS upper/lower case search text retains original source snapshots", () => {
  const tc = setup('<body><p style="text-transform:uppercase">hello <span>world</span></p><p style="text-transform:lowercase">UPPER</p></body>');
  const entries = tc.collect();
  assert.deepEqual(entries.map(e => e.text), ["HELLO WORLD", "upper"]);
  assert.equal(entries[0].segments[0].sourceText, "hello ");
  assert.equal(entries[1].segments[0].sourceText, "UPPER");
});

test("transparent text may be restored by children and ordinary black is visible", () => {
  const tc = setup('<body><p style="color:transparent">invisible<span style="color:rgb(0,0,0)">visible black</span></p><p style="color:rgba(0,0,0,0)">transparent alpha</p><p style="color:rgb(0,0,0)">black</p></body>');
  assert.deepEqual(tc.collect().map(e => e.text), ["visible black", "black"]);
  assert.equal(tc.visibility.transparentColor("rgb(0, 0, 0)"), false);
  assert.equal(tc.visibility.transparentColor("rgba(0, 0, 0, 0)"), true);
  assert.equal(tc.visibility.transparentColor("rgb(0 0 0 / 0)"), true);
});

test("a frame's zero font size or transparent color does not hide its own document", () => {
  const tc = setup('<body><iframe style="font-size:0;color:transparent"></iframe></body>');
  const frame = tc.document.querySelector("iframe");
  frame.contentDocument.body.innerHTML = '<p>frame visible</p>';
  assert.deepEqual(tc.collect().map(e => e.text), ["frame visible"]);
  assert.equal(tc.visibility.isVisible(frame.contentDocument.querySelector("p").firstChild), true);
});

test("nested fallback slots respect each intervening slot's visibility", () => {
  const tc = setup('<body><div id="host"></div></body>');
  tc.document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = '<p>before<slot><slot style="display:none">hidden</slot><slot style="visibility:hidden">invisible</slot></slot>after</p>';
  assert.deepEqual(tc.collect().map(e => e.text), ["beforeafter"]);
});

test("visibility checks exclude unassigned light DOM and replaced fallback content", () => {
  const tc = setup('<body><div id="host"><span slot="show">assigned</span><span id="unassigned">unassigned</span></div></body>');
  const shadow = tc.document.getElementById("host").attachShadow({ mode: "open" });
  shadow.innerHTML = '<slot name="show"><span id="fallback">fallback</span></slot>';
  assert.equal(tc.visibility.isVisible(tc.document.getElementById("unassigned")), false);
  assert.equal(tc.visibility.isVisible(shadow.getElementById("fallback")), false);
  assert.equal(tc.visibility.isVisible(tc.document.querySelector('[slot="show"]')), true);
});

test("inline hosts and slots can form one run across multiple tree scopes", () => {
  const tc = setup('<body><p>before<span id="host">middle</span>after</p></body>');
  const shadow = tc.document.getElementById("host").attachShadow({ mode: "open" });
  shadow.innerHTML = '<span>shadow<slot></slot>end</span>';
  const entries = tc.collect();
  assert.deepEqual(entries.map(e => e.text), ["beforeshadowmiddleendafter"]);
  assert.ok(entries[0].segments.some(s => s.node.getRootNode() === shadow));
  assert.ok(entries[0].segments.some(s => s.node.getRootNode() === tc.document));
});

test("select searches the displayed label and not option values or inactive labels", () => {
  const tc = setup('<body><select><option value="internal">First</option><option value="secret" label="Shown label" selected>Hidden option text</option></select></body>');
  const entry = tc.collect()[0];
  assert.equal(entry.kind, "label");
  assert.equal(entry.text, "Shown label");
  assert.equal(entry.displayTextSnapshot, "Shown label");
  tc.document.querySelector("select").selectedIndex = 0;
  assert.deepEqual(tc.collect().map(e => e.text), ["First"]);
});

test("empty supported controls expose placeholders but never password values", () => {
  const tc = setup('<body><input placeholder="hint"><textarea placeholder="textarea hint"></textarea><input type="password" placeholder="password hint"><input type="color" value="#112233" placeholder="not shown"><input type="date" placeholder="not shown"><input value="filled" placeholder="not shown"></body>');
  const entries = tc.collect();
  assert.deepEqual(entries.map(e => [e.kind, e.text]), [["placeholder", "hint"], ["placeholder", "textarea hint"], ["placeholder", "password hint"], ["control", "filled"]]);
  tc.document.querySelector('input[type="password"]').value = "secret";
  // jsdom does not recompute :placeholder-shown after changing the value.
  tc.document.querySelector('input[type="password"]').matches = () => false;
  assert.ok(!tc.collect().some(e => e.text === "secret" || e.text === "password hint"));
});

test("root budgets skip inaccessible extra roots and continue in the main document", () => {
  const tc = setup('<body><div id="a"></div><div id="b"></div><p>outside</p></body>');
  tc.document.getElementById("a").attachShadow({ mode: "open" }).innerHTML = '<p>first shadow</p>';
  tc.document.getElementById("b").attachShadow({ mode: "open" }).innerHTML = '<p>second shadow</p>';
  const entries = tc.collect({ maxRoots: 2 });
  assert.deepEqual(entries.map(e => e.text), ["first shadow", "outside"]);
  assert.equal(entries.roots.length, 2);
  assert.equal(entries.stats.truncated, true);
  assert.deepEqual(entries.stats.reasons, ["root-limit"]);
});

test("normalized whitespace cannot bypass source character budgets", () => {
  const tc = setup('<body><p>a     b</p><p>ok</p></body>');
  const entries = tc.collect({ maxChars: 5 });
  assert.deepEqual(entries.map(e => e.text), []);
  assert.deepEqual(entries.stats.reasons, ["characters"]);
});

test("global segment budgets bound metadata separately from character budgets", () => {
  const tc = setup('<body><p>A <span>B</span></p><p>C <span>D</span></p></body>');
  const entries = tc.collect({ maxSegments: 3 });
  assert.deepEqual(entries.map(e => e.text), ["A B"]);
  assert.equal(entries.stats.segments, 2);
  assert.deepEqual(entries.stats.reasons, ["segments"]);
});

test("selection cropping keeps collapsed space and source snapshots aligned", () => {
  const tc = setup('<body><p>prefix a     b suffix</p></body>');
  const text = tc.document.querySelector("p").firstChild;
  const range = tc.document.createRange();
  range.setStart(text, 7);
  range.setEnd(text, 14);
  const cropped = tc.normalizeSelection(tc.collect()[0], range);
  assert.equal(cropped.text, "a b");
  assert.equal(cropped.sourceLength, 7);
  for (const s of cropped.segments) assert.equal(s.sourceText, text.nodeValue.slice(s.nodeStart, s.nodeEnd));
  assert.deepEqual(cropped.segments.map(s => [s.start, s.end]), [[0, 1], [1, 2], [2, 3]]);
});

test("selection cropping preserves transformed display text and exact endpoint offsets", () => {
  const tc = setup('<body><p style="text-transform:uppercase">hello world</p></body>');
  const text = tc.document.querySelector("p").firstChild;
  const range = tc.document.createRange();
  range.setStart(text, 2);
  range.setEnd(text, 8);
  const cropped = tc.normalizeSelection(tc.collect()[0], range);
  assert.equal(cropped.text, "LLO WO");
  assert.equal(cropped.segments[0].sourceText, "llo wo");
  assert.equal(cropped.segments[0].nodeStart, 2);
  assert.equal(cropped.segments[0].nodeEnd, 8);
});

test("stream batches are bounded by original characters and segment metadata", async () => {
  const tc = setup('<body><p>one</p><p>two</p><p>tri</p><p>four</p></body>');
  const batches = [];
  await tc.collectBatched({ batchSize: 100, budgetMs: 50, maxBatchSourceChars: 6, maxBatchSegments: 2,
    onBatch(batch) { batches.push(batch); } });
  assert.deepEqual(batches.flat().map(e => e.text), ["one", "two", "tri", "four"]);
  for (const batch of batches) {
    assert.ok(batch.reduce((sum, e) => sum + e.sourceLength, 0) <= 6);
    assert.ok(batch.reduce((sum, e) => sum + e.segments.length, 0) <= 2);
  }
});

test("control transforms preserve original values and display snapshots", () => {
  const tc = setup('<body><input style="text-transform:uppercase" value="value"><input style="text-transform:lowercase" placeholder="HINT"><select style="text-transform:uppercase"><option>label</option></select></body>');
  const entries = tc.collect();
  assert.deepEqual(entries.map(e => e.text), ["VALUE", "hint", "LABEL"]);
  assert.deepEqual(entries.map(e => e.displayTextSnapshot), ["value", "HINT", "label"]);
  assert.equal(tc.document.querySelector("input").value, "value");
});

test("time budgets end empty-node traversal and report a partial scan", () => {
  const tc = setup('<body><div></div><div></div><div></div></body>');
  const oldPerformance = globalThis.performance;
  let time = 0;
  globalThis.performance = { now: () => ++time };
  try {
    const entries = tc.collect({ maxDurationMs: 3 });
    assert.deepEqual(entries.map(e => e.text), []);
    assert.ok(entries.stats.visitedNodes <= 1);
    assert.equal(entries.stats.truncated, true);
    assert.deepEqual(entries.stats.reasons, ["duration"]);
  } finally { globalThis.performance = oldPerformance; }
});

test("finding a late summary in closed details shares traversal yields and cancellation", async () => {
  const tc = setup('<body><details>' + '<div>hidden</div>'.repeat(30) + '<summary>late visible</summary></details></body>');
  let yields = 0;
  const entries = await tc.collectBatched({ batchSize: 2, shouldContinue: () => yields < 3,
    onStats(stats) { if (!stats.aborted) yields++; } });
  assert.equal(yields, 3);
  assert.ok(entries.stats.visitedNodes <= 6);
  assert.equal(entries.stats.aborted, true);
  assert.deepEqual(entries.map(e => e.text), []);
  assert.deepEqual(tc.collect().map(e => e.text), ["late visible"]);
});

test("normalization of a fragmented single Text yields and cancels without a partial entry", async () => {
  const tc = setup('<body><p></p></body>');
  tc.document.querySelector("p").textContent = "a  ".repeat(40000) + "z";
  const previousScheduler = globalThis.scheduler;
  let checks = 0;
  globalThis.scheduler = { yield() { return Promise.resolve(); } };
  try {
    const entries = await tc.collectBatched({ budgetMs: 1, batchSize: 1,
      shouldContinue() { return ++checks < 12; } });
    assert.equal(entries.stats.aborted, true);
    assert.deepEqual(entries.map(e => e.text), []);
    assert.ok(checks <= 12);
  } finally { globalThis.scheduler = previousScheduler; }
});

test("selection beginning inside collapsed-away whitespace omits the invisible tail", () => {
  const tc = setup('<body><p>a     b</p></body>');
  const text = tc.document.querySelector("p").firstChild;
  const entry = tc.collect()[0];
  const range = tc.document.createRange();
  range.setStart(text, 2);
  range.setEnd(text, 7);
  assert.equal(tc.normalizeSelection(entry, range).text, "b");
  range.setEnd(text, 6);
  assert.equal(tc.normalizeSelection(entry, range), null);
  range.setStart(text, 1);
  range.setEnd(text, 2);
  assert.equal(tc.normalizeSelection(entry, range).text, " ");
});

test("pre-line removes spaces around explicit newlines, including across inline nodes", () => {
  const tc = setup('<body><p style="white-space:pre-line">a <span>\n </span>b</p><p style="white-space:pre-line">a \n b</p></body>');
  assert.deepEqual(tc.collect().map(e => e.text), ["a\nb", "a\nb"]);
});

test("skipping an inaccessible inline root cannot fabricate joined text or anchor matches", () => {
  const tc = setup('<body><p>before<span id="host">light</span>after</p><p>complete</p></body>');
  tc.document.getElementById("host").attachShadow({ mode: "open" }).textContent = "middle";
  assert.deepEqual(tc.collect().map(e => e.text), ["beforemiddleafter", "complete"]);
  const entries = tc.collect({ maxRoots: 1 });
  assert.deepEqual(entries.map(e => e.text), ["complete"]);
  assert.equal(entries.stats.incompleteRuns, 1);
  assert.equal(entries.stats.truncated, true);
  assert.deepEqual(entries.stats.reasons, ["root-limit"]);
});

test("Chrome extension DOM API makes closed shadow text and assigned slots searchable", () => {
  const closed = new WeakMap();
  const chrome = { dom: { openOrClosedShadowRoot: host => closed.get(host) || null } };
  const tc = setup('<body><p>before<span id="host"><span slot="label">assigned</span><span id="unused">unused</span></span>after</p></body>', chrome);
  const host = tc.document.getElementById("host");
  const root = host.attachShadow({ mode: "closed" });
  closed.set(host, root);
  root.innerHTML = 'shadow<slot name="label">fallback</slot>end';
  const assigned = tc.document.querySelector('[slot="label"]');
  assert.equal(host.shadowRoot, null);
  assert.equal(assigned.assignedSlot, null);
  const entries = tc.collect();
  assert.deepEqual(entries.map(e => e.text), ["beforeshadowassignedendafter"]);
  assert.equal(entries.stats.shadowRoots, 1);
  assert.equal(entries.stats.closedShadowRoots, 1);
  assert.ok(entries.roots.includes(root));
  assert.equal(tc.visibility.isVisible(assigned), true);
  assert.equal(tc.visibility.isVisible(tc.document.getElementById("unused")), false);
  assert.equal(tc.visibility.composedParent(assigned), root.querySelector("slot"));
});

test("throwing or unavailable closed-shadow bindings do not break ordinary text", () => {
  const tc = setup('<body><div id="host"></div><p>visible</p></body>',
    { dom: { openOrClosedShadowRoot() { throw new Error("unsupported"); } } });
  tc.document.getElementById("host").attachShadow({ mode: "closed" }).textContent = "unavailable";
  const entries = tc.collect();
  assert.deepEqual(entries.map(e => e.text), ["visible"]);
  assert.equal(entries.stats.closedShadowRoots, 0);
});

test("native controls never expose user-agent shadow roots through the extension binding", () => {
  const calls = [];
  const tc = setup('<body><input type="password" value="secret"><input value="visible"><textarea>textarea</textarea><select><option>label</option></select></body>',
    { dom: { openOrClosedShadowRoot(host) { calls.push(host.tagName); return null; } } });
  assert.deepEqual(tc.collect().map(e => e.text), ["visible", "textarea", "label"]);
  assert.ok(!calls.includes("INPUT") && !calls.includes("TEXTAREA") && !calls.includes("SELECT"));
});

test("filled password values are excluded before reading their strings", () => {
  const tc = setup('<body><input type="password" value="secret"><p>visible</p></body>');
  const password = tc.document.querySelector("input");
  // Simulate the browser's native pseudo-class test, which reads internal state.
  password.matches = selector => { assert.equal(selector, ":placeholder-shown"); return false; };
  let reads = 0;
  Object.defineProperty(password, "value", { get() { reads++; throw new Error("private value must not be read"); } });
  assert.deepEqual(tc.collect().map(e => e.text), ["visible"]);
  assert.equal(reads, 0);
});

test("SVG text needs a painted fill or stroke, while descendants may restore paint", () => {
  const tc = setup(`<body>
    <p><svg><text style="fill:none;stroke:none">unpainted</text></svg></p>
    <p><svg><text style="fill-opacity:0;stroke:none">transparent fill</text></svg></p>
    <p><svg><text style="fill:none;stroke:black;stroke-opacity:0">transparent stroke</text></svg></p>
    <p><svg><text style="fill:none;stroke:black;stroke-width:0">zero stroke</text></svg></p>
    <p><svg><text style="fill:none;stroke:black;stroke-width:1">outline</text></svg></p>
    <p><svg><text style="fill:none;stroke:none">hidden<tspan style="fill:black">restored</tspan></text></svg></p>
    <p><svg><g fill-opacity="0"><text>hidden inherited fill</text><text fill-opacity="1">restored opacity</text></g></svg></p>
  </body>`);
  assert.deepEqual(tc.collect().map(e => e.text), ["outline", "restored", "restored opacity"]);
});

test("modern whitespace longhands preserve newlines and spaces independently of wrapping", () => {
  const tc = setup(`<body>
    <p style="white-space:preserve-breaks nowrap"> a  <span>b\n c</span> </p>
    <p style="white-space:break-spaces nowrap"> d  <span>e\n f</span> </p>
    <p style="white-space-collapse:preserve-breaks;text-wrap-mode:nowrap"> g  <span>h\n i</span> </p>
  </body>`);
  const entries = tc.collect();
  assert.deepEqual(entries.map(e => e.text), ["a b\nc", " d  e\n f ", "g h\ni"]);
  for (const entry of entries) {
    for (const segment of entry.segments) {
      assert.equal(segment.node.nodeValue.slice(segment.nodeStart, segment.nodeEnd), segment.sourceText);
    }
  }
});

test("script-created carriage returns collapse as spaces rather than line breaks in pre-line", () => {
  const tc = setup('<body><p style="white-space:pre-line"></p></body>');
  const node = tc.document.querySelector("p");
  node.textContent = "a\r b\r\n c\r d";
  const entry = tc.collect()[0];
  assert.equal(entry.text, "a b\nc d");
  for (const segment of entry.segments) {
    assert.equal(segment.sourceText, segment.node.nodeValue.slice(segment.nodeStart, segment.nodeEnd));
  }
  assert.equal(node.textContent, "a\r b\r\n c\r d");
});

test("form feed remains a visible control character instead of becoming an ordinary space", () => {
  const tc = setup('<body><p></p><p></p></body>');
  tc.document.querySelectorAll("p")[0].textContent = "a\fb";
  tc.document.querySelectorAll("p")[1].textContent = "\f";
  assert.deepEqual(tc.collect().map(e => e.text), ["a\fb", "\f"]);
});

test("oversized and whitespace-only runs consume the same scan character budget as accepted text", () => {
  const tc = setup('<body><p>oversized</p><p>   </p><p>visible</p></body>');
  const entries = tc.collect({ maxRunChars: 8, maxChars: 15 });
  assert.deepEqual(entries.map(e => e.text), []);
  assert.equal(entries.stats.sourceCharacters, 0);
  assert.equal(entries.stats.scannedSourceCharacters, 12);
  assert.equal(entries.stats.oversizedRuns, 1);
  assert.equal(entries.stats.truncated, true);
  assert.deepEqual(entries.stats.reasons, ["run-size", "characters"]);
});

test("oversized controls cannot bypass the scan character budget", () => {
  const tc = setup('<body><textarea>oversized</textarea><p>visible</p></body>');
  const entries = tc.collect({ maxRunChars: 8, maxChars: 12 });
  assert.deepEqual(entries.map(e => e.text), []);
  assert.equal(entries.stats.scannedSourceCharacters, 9);
  assert.deepEqual(entries.stats.reasons, ["run-size", "characters"]);
});

test("display contents ignores its absent box opacity and positioning but keeps inherited text styles", () => {
  const tc = setup(`<body>
    <p>before<span style="display:contents;opacity:0;position:absolute">middle</span>after</p>
    <p style="display:contents;color:transparent">hidden<span style="color:black">restored</span></p>
  </body>`);
  assert.deepEqual(tc.collect().map(e => e.text), ["beforemiddleafter", "restored"]);
  assert.equal(tc.visibility.isVisible(tc.document.querySelector("span").firstChild), true);
});

test("SVG container strings and orphan text-content elements are never searchable", () => {
  const tc = setup(`<body><svg>raw svg<g>raw group</g><a>raw link</a>
    <tspan>orphan span</tspan><textPath>orphan path</textPath>
    <text>alpha<g>invisible group</g><tspan>beta</tspan><a>link</a></text>
    <foreignObject><p>HTML text</p></foreignObject>
  </svg></body>`);
  assert.deepEqual(tc.collect().map(e => e.text), ["alphabetalink", "HTML text"]);
  assert.equal(tc.visibility.isVisible(tc.document.querySelector("svg").firstChild), false);
  assert.equal(tc.visibility.isVisible(tc.document.querySelector("tspan").firstChild), false);
  assert.equal(tc.visibility.isVisible(tc.document.querySelector("text").firstChild), true);
});

test("ruby annotations remain searchable without splitting the surrounding base word", () => {
  // jsdom's legacy UA sheet uses block rt boxes; use the browser's ruby types.
  const tc = setup('<head><style>ruby{display:ruby}rt{display:ruby-text}</style></head><body><p>prefix<ruby>first<rt>reading one</rt>second<rt>reading two</rt></ruby>suffix</p></body>');
  const entries = tc.collect();
  assert.deepEqual(entries.map(e => e.text), ["reading one", "reading two", "prefixfirstsecondsuffix"]);
  assert.deepEqual(entries[2].segments.map(s => s.sourceText), ["prefix", "first", "second", "suffix"]);
  assert.equal(entries.stats.scannedSourceCharacters, entries.stats.sourceCharacters);
});

test("inline-styled ruby annotations participate in the normal displayed text run", () => {
  const tc = setup('<body><p><ruby>first<rt style="display:inline">reading</rt>second</ruby></p></body>');
  assert.deepEqual(tc.collect().map(e => e.text), ["firstreadingsecond"]);
});

test("content visibility on non-containing boxes does not hide painted descendants", () => {
  const tc = setup(`<body>
    <p>before<span style="display:contents;content-visibility:hidden">contents</span>after</p>
    <p>before<span style="display:inline;content-visibility:hidden">inline</span>after</p>
    <p><span style="display:inline-block;content-visibility:hidden">hidden atomic</span>shown</p>
    <table style="content-visibility:hidden"><tbody style="content-visibility:hidden"><tr style="content-visibility:hidden"><td>visible table cell</td></tr></tbody></table>
    <p><svg><text style="content-visibility:hidden">visible svg</text></svg></p>
  </body>`);
  assert.deepEqual(tc.collect().map(e => e.text), ["beforecontentsafter", "beforeinlineafter", "shown", "visible table cell", "visible svg"]);
});

test("metadata budget stops mapping before an oversized intermediate map can be allocated", () => {
  const tc = setup('<body><p></p></body>');
  tc.document.querySelector("p").textContent = "a  ".repeat(10000) + "end";
  const entries = tc.collect({ maxTotalSegments: 1 });
  assert.deepEqual(entries.map(e => e.text), []);
  assert.equal(entries.stats.peakBufferedSegments, 1);
  assert.equal(entries.stats.segments, 0);
  assert.deepEqual(entries.stats.reasons, ["segments"]);
});

test("metadata budget includes suspended ruby base maps as well as the current annotation", () => {
  const tc = setup('<head><style>ruby{display:ruby}rt{display:ruby-text}</style></head><body><p><ruby>base<rt>reading</rt>end</ruby></p></body>');
  const limited = tc.collect({ maxTotalSegments: 2 });
  assert.deepEqual(limited.map(e => e.text), ["reading"]);
  assert.equal(limited.stats.peakBufferedSegments, 2);
  assert.deepEqual(limited.stats.reasons, ["segments"]);
  const complete = tc.collect({ maxTotalSegments: 3 });
  assert.deepEqual(complete.map(e => e.text), ["reading", "baseend"]);
  assert.equal(complete.stats.segments, 3);
  assert.ok(complete.stats.peakBufferedSegments <= 3);
});

test("zero-opacity filters hide the whole rendered subtree while contents ignores box filters", () => {
  const tc = setup(`<body>
    <div style="filter:blur(1px) opacity(0)"><span style="filter:opacity(1)">hidden filtered</span></div>
    <p style="filter:opacity(0%)">hidden percent</p>
    <p>before<span style="display:contents;filter:opacity(0)">contents</span>after</p>
    <p style="filter:opacity(.5)">visible filtered</p>
  </body>`);
  assert.deepEqual(tc.collect().map(e => e.text), ["beforecontentsafter", "visible filtered"]);
});

test("transparent fill needs a painted shadow, stroke or text-clipped background", () => {
  const tc = setup(`<body>
    <p style="color:transparent;text-shadow:0 0 1px transparent">hidden shadow</p>
    <p style="color:transparent;text-shadow:rgba(0,0,0,0) 0 0 1px, transparent 1px 1px">hidden shadows</p>
    <p style="color:transparent;text-shadow:0 0 1px black">painted shadow</p>
    <p style="color:transparent;-webkit-text-stroke-width:1px;-webkit-text-stroke-color:transparent">hidden stroke</p>
    <p style="color:transparent;-webkit-text-stroke-width:1px;-webkit-text-stroke-color:black">painted stroke</p>
    <p style="color:transparent;background-clip:text;background:none">hidden background</p>
    <p style="color:transparent;background-clip:text;background-color:black">painted background</p>
  </body>`);
  assert.deepEqual(tc.collect().map(e => e.text), ["painted shadow", "painted stroke", "painted background"]);
});

test("removed iframe documents and their connected shadow nodes are not attached to the page", () => {
  const tc = setup('<body><iframe></iframe><p>outside</p></body>');
  const frame = tc.document.querySelector("iframe"), oldDocument = frame.contentDocument;
  oldDocument.body.innerHTML = '<div id="host"></div><input value="old control">';
  const shadow = oldDocument.getElementById("host").attachShadow({ mode: "open" });
  shadow.textContent = "old shadow";
  const control = oldDocument.querySelector("input");
  assert.equal(tc.visibility.isDocumentAttached(oldDocument), true);
  assert.equal(tc.visibility.isVisible(control), true);
  frame.remove();
  // Unlike Chromium, jsdom closes the window by clearing its body. Restore
  // the retained old nodes to model Chromium's still-connected old tree.
  oldDocument.body.append(shadow.host, control);
  assert.equal(tc.visibility.isDocumentAttached(oldDocument), false);
  assert.equal(tc.visibility.isVisible(control), false);
  assert.equal(tc.visibility.isVisible(shadow.firstChild), false);
  assert.deepEqual(tc.collect({ root: oldDocument }).map(e => e.text), []);
  assert.deepEqual(tc.collect({ root: shadow }).map(e => e.text), []);
  assert.deepEqual(tc.collect().map(e => e.text), ["outside"]);
});

test("nested frames become detached when any outer embedding frame is removed", () => {
  const tc = setup('<body><iframe></iframe></body>');
  const outer = tc.document.querySelector("iframe");
  outer.contentDocument.body.innerHTML = '<iframe></iframe>';
  const nested = outer.contentDocument.querySelector("iframe"), nestedDocument = nested.contentDocument;
  nestedDocument.body.innerHTML = '<p>nested</p>';
  const nestedParagraph = nestedDocument.querySelector("p");
  assert.equal(tc.visibility.isDocumentAttached(nestedDocument), true);
  outer.remove();
  assert.equal(tc.visibility.isDocumentAttached(nestedDocument), false);
  assert.equal(tc.visibility.isVisible(nestedParagraph), false);
});

test("a short selection inside a huge Text uses selected source budgets and original DOM offsets", () => {
  const tc = setup('<body><p></p></body>');
  const paragraph = tc.document.querySelector("p");
  paragraph.textContent = "x".repeat(2 * 1024 * 1024) + "needle" + "y".repeat(1000);
  const node = paragraph.firstChild, start = 2 * 1024 * 1024;
  const selection = tc.document.createRange();
  selection.setStart(node, start); selection.setEnd(node, start + 6);
  const entries = tc.collect({ root: paragraph, selection, maxRunChars: 6, maxChars: 6 });
  assert.deepEqual(entries.map(e => e.text), ["needle"]);
  assert.equal(entries[0].segments[0].nodeStart, start);
  assert.equal(entries[0].segments[0].nodeEnd, start + 6);
  assert.equal(entries[0].segments[0].sourceText, "needle");
  assert.equal(entries.stats.sourceCharacters, 6);
  assert.equal(entries.stats.scannedSourceCharacters, 6);
  assert.equal(entries.stats.truncated, false);
  assert.equal(tc.normalizeSelection(entries[0], selection).text, "needle");
  assert.equal(node.nodeValue.length, start + 1006);
});

test("selection fast path preserves CSS casing and skips unrelated sibling source", () => {
  const tc = setup('<body><p style="text-transform:uppercase">unselected<span>chosen</span><input value="unselected control">unselected tail</p></body>');
  const paragraph = tc.document.querySelector("p"), node = paragraph.querySelector("span").firstChild;
  const selection = tc.document.createRange();
  selection.setStart(node, 1); selection.setEnd(node, 5);
  const entries = tc.collect({ root: paragraph, selection, maxChars: 4, maxRunChars: 4 });
  assert.deepEqual(entries.map(e => e.text), ["HOSE"]);
  assert.equal(entries[0].segments[0].sourceText, "hose");
  assert.equal(entries[0].segments[0].nodeStart, 1);
  assert.equal(entries.stats.sourceCharacters, 4);
  assert.equal(entries.stats.truncated, false);
});

test("selection with collapsed source whitespace keeps its complete contextual mapping path", () => {
  const tc = setup('<body><p>a     b</p></body>');
  const node = tc.document.querySelector("p").firstChild, selection = tc.document.createRange();
  selection.setStart(node, 2); selection.setEnd(node, 7);
  const entries = tc.collect({ selection });
  assert.equal(entries[0].text, "a b");
  assert.equal(tc.normalizeSelection(entries[0], selection).text, "b");
  selection.setStart(node, 1); selection.setEnd(node, 2);
  assert.equal(tc.normalizeSelection(tc.collect({ selection })[0], selection).text, " ");
});

test("a short control selection keeps its full display snapshot while budgeting the selected value", () => {
  const tc = setup('<body><textarea></textarea></body>');
  const node = tc.document.querySelector("textarea"), start = 2 * 1024 * 1024;
  node.value = "x".repeat(start) + "needle" + "tail";
  const selection = { kind: "control-selection", node, start, end: start + 6, valueSnapshot: node.value };
  const entries = tc.collect({ root: node, selection, maxChars: 6, maxRunChars: 6 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, node.value);
  assert.equal(entries[0].displayTextSnapshot, node.value);
  assert.equal(entries[0].sourceLength, 6);
  assert.equal(entries.stats.characters, 6);
  assert.equal(entries.stats.scannedSourceCharacters, 6);
  assert.equal(entries.stats.truncated, false);
});

test("a short control selection is allowed beyond the former four MiB snapshot cap", () => {
  const tc = setup('<body><textarea></textarea></body>');
  const node = tc.document.querySelector("textarea");
  node.value = "x".repeat(4 * 1024 * 1024 + 1);
  const selection = { kind: "control-selection", node, start: 1, end: 2, valueSnapshot: node.value };
  const entries = tc.collect({ root: node, selection });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].displayTextSnapshot, node.value);
  assert.equal(entries[0].sourceLength, 1);
  assert.equal(entries.stats.truncated, false);
});

const MiB = 1024 * 1024;
const core = 128 * 1024;
function ownedText(entries) {
  return entries.map(entry => entry.stream ? entry.text.slice(
    entry.stream.ownedStart - entry.stream.offset, entry.stream.ownedEnd - entry.stream.offset) : entry.text).join("");
}
function assertStreamMaps(entries) {
  for (const entry of entries) {
    const stream = entry.stream;
    assert.ok(stream.offset <= stream.ownedStart);
    assert.ok(stream.ownedStart < stream.ownedEnd);
    assert.ok(stream.ownedEnd <= stream.offset + entry.text.length);
    for (const segment of entry.segments || []) {
      assert.equal(segment.sourceText, segment.node.nodeValue.slice(segment.nodeStart, segment.nodeEnd));
      assert.ok(segment.start >= 0 && segment.end <= entry.text.length);
    }
  }
}

test("literal collection emits bounded windows with continuous ownership and real boundaries", () => {
  const tc = setup('<body><p></p><p>last</p></body>');
  const node = tc.document.querySelector("p");
  node.textContent = "x".repeat(core * 4) + "needle";
  const entries = tc.collect({ streamLiterals: true, literalQueryLength: 6 });
  assert.equal(ownedText(entries), node.textContent + "last");
  const firstRun = entries.filter(entry => entry.stream.runId === entries[0].stream.runId);
  assert.ok(firstRun.length >= 4);
  assert.equal(firstRun[0].stream.first, true);
  assert.equal(firstRun.at(-1).stream.last, true);
  for (let i = 1; i < firstRun.length; i++) {
    assert.equal(firstRun[i].stream.ownedStart, firstRun[i - 1].stream.ownedEnd);
    assert.equal(firstRun[i].stream.first, false);
  }
  assert.ok(entries.every(entry => entry.text.length <= core + 11));
  assert.equal(entries.stats.characters, node.textContent.length + 4);
  assert.equal(entries.stats.scannedSourceCharacters, node.textContent.length + 4);
  assert.equal(entries.stats.logicalEntries, 2);
  assertStreamMaps(entries);
});

test("literal windows include enough true text to match a query crossing an ownership edge", () => {
  const tc = setup('<body><p></p></body>');
  const paragraph = tc.document.querySelector("p");
  paragraph.textContent = "x".repeat(core - 2) + "needle" + "y".repeat(core * 2);
  const entries = tc.collect({ streamLiterals: true, literalQueryLength: 6 });
  const index = entries[0].text.indexOf("needle");
  assert.equal(index, core - 2);
  assert.ok(index < entries[0].stream.ownedEnd);
  assert.equal(ownedText(entries), paragraph.textContent);
  assertStreamMaps(entries);
});

test("stream normalization retains collapsed whitespace across raw chunks and inline nodes", () => {
  const tc = setup('<body><p><span></span><b></b></p></body>');
  const paragraph = tc.document.querySelector("p");
  paragraph.firstChild.textContent = "a".repeat(core - 1) + " ";
  paragraph.lastChild.textContent = " \t\n " + "b".repeat(core * 2) + "  ";
  const entries = tc.collect({ streamLiterals: true, literalQueryLength: 5 });
  assert.equal(ownedText(entries), "a".repeat(core - 1) + " " + "b".repeat(core * 2));
  assertStreamMaps(entries);
});

test("pre-line line starts and pending trailing spaces survive stream boundaries", () => {
  const tc = setup('<body><p style="white-space:pre-line"></p></body>');
  const paragraph = tc.document.querySelector("p");
  paragraph.textContent = "x".repeat(core - 1) + "  \n  " + "y".repeat(core * 2) + "  ";
  const entries = tc.collect({ streamLiterals: true, literalQueryLength: 2 });
  assert.equal(ownedText(entries), "x".repeat(core - 1) + "\n" + "y".repeat(core * 2));
  assertStreamMaps(entries);
});

test("preformatted chunks preserve spaces and complete UTF-16 surrogate pairs", () => {
  const tc = setup('<body><pre></pre></body>');
  const paragraph = tc.document.querySelector("pre");
  paragraph.textContent = "x".repeat(core - 1) + "😀 \n " + "y".repeat(core * 3);
  const entries = tc.collect({ streamLiterals: true, literalQueryLength: 3 });
  assert.equal(ownedText(entries), paragraph.textContent);
  for (const entry of entries) {
    assert.ok(!/^[\uDC00-\uDFFF]/.test(entry.text));
    assert.ok(!/[\uD800-\uDBFF]$/.test(entry.text));
    const owned = entry.text.slice(entry.stream.ownedStart - entry.stream.offset, entry.stream.ownedEnd - entry.stream.offset);
    assert.ok(!/^[\uDC00-\uDFFF]/.test(owned));
    assert.ok(!/[\uD800-\uDBFF]$/.test(owned));
  }
  assertStreamMaps(entries);
});

test("one large literal run exceeds the former eight MiB cap without retaining all windows", async () => {
  const tc = setup('<body><p></p></body>');
  const node = tc.document.querySelector("p");
  node.textContent = "x".repeat(20 * MiB) + "needle";
  let total = 0, windows = 0, largest = 0;
  const entries = await tc.collectBatched({ streamLiterals: true, literalQueryLength: 6, storeNodes: false,
    maxDurationMs: 30000, maxRunChars: 1000 * MiB, maxChars: 32000 * MiB,
    onBatch(batch) {
      for (const entry of batch) {
        assert.equal(entry.stream.ownedStart, total);
        total = entry.stream.ownedEnd;
        windows++;
        largest = Math.max(largest, entry.text.length);
      }
      return true;
    } });
  assert.equal(total, node.textContent.length);
  assert.ok(windows > 100);
  assert.ok(largest < MiB);
  assert.equal(entries.length, 0);
  assert.equal(entries.stats.truncated, false);
  assert.ok(entries.stats.peakBufferedSegments < 10);
});

test("large stream query context remains under eight MiB and has no artificial block boundary", () => {
  const tc = setup('<body><p></p></body>');
  const node = tc.document.querySelector("p"), queryLength = 4096000;
  node.textContent = "x".repeat(queryLength * 3);
  const entries = tc.collect({ streamLiterals: true, literalQueryLength: queryLength, maxDurationMs: 30000 });
  assert.equal(ownedText(entries).length, node.textContent.length);
  assert.ok(entries.every(entry => entry.text.length < 8 * MiB));
  assert.ok(entries.slice(0, -1).every(entry => !entry.stream.first || entry.stream.offset === 0));
  assert.equal(entries[0].stream.last, false);
  assertStreamMaps(entries);
});

test("an explicitly requested standalone run budget omits the complete run", () => {
  const tc = setup('<body><pre></pre><p>safe</p></body>');
  tc.document.querySelector("pre").textContent = "x".repeat(16 * MiB + 1);
  const entries = tc.collect({ maxRunChars: 16 * MiB, maxDurationMs: 30000 });
  assert.deepEqual(entries.map(entry => entry.text), ["safe"]);
  assert.equal(entries.stats.oversizedRuns, 1);
  assert.deepEqual(entries.stats.reasons, ["run-size"]);
});

test("a large logical literal budget reports a partial run without pretending its cutoff is a true end", () => {
  const tc = setup('<body><p></p></body>');
  const node = tc.document.querySelector("p");
  node.textContent = "x".repeat(core * 5);
  const entries = tc.collect({ streamLiterals: true, literalQueryLength: 3, maxRunChars: core * 2 + 5 });
  assert.equal(ownedText(entries), "x".repeat(core * 2));
  assert.ok(entries.every(entry => entry.stream.last === false));
  assert.equal(entries.stats.oversizedRuns, 1);
  assert.deepEqual(entries.stats.reasons, ["run-size"]);
});

test("small literal run budgets keep streaming enabled while omitting unsafe truncated edges", () => {
  const tc = setup('<body><p>oversized</p><p>safe</p></body>');
  const entries = tc.collect({ streamLiterals: true, literalQueryLength: 3, maxRunChars: 4 });
  assert.deepEqual(entries.map(entry => entry.text), ["safe"]);
  assert.equal(entries[0].stream.last, true);
  assert.deepEqual(entries.stats.reasons, ["run-size"]);
});

test("a small total scan budget still emits decidable literal ownership", () => {
  const tc = setup('<body><p>abcdefghi</p></body>');
  const entries = tc.collect({ streamLiterals: true, literalQueryLength: 1, maxChars: 6, maxRunChars: 6 });
  assert.equal(ownedText(entries), "abc");
  assert.equal(entries[0].stream.first, true);
  assert.equal(entries[0].stream.last, false);
  assert.equal(entries[0].text, "abcdef");
  assert.deepEqual(entries.stats.reasons, ["characters"]);
});

test("dense literal mappings emit a shorter core before reaching the in-flight segment cap", async () => {
  const tc = setup('<body><p></p></body>');
  tc.document.querySelector("p").textContent = "a  ".repeat(60000) + "end";
  const windows = [];
  const entries = await tc.collectBatched({ streamLiterals: true, literalQueryLength: 3, storeNodes: false,
    maxRunSegments: 100000, maxTotalSegments: 250000,
    onBatch(batch) { windows.push(...batch); return true; } });
  assert.equal(ownedText(windows), "a ".repeat(60000) + "end");
  assert.ok(windows[0].stream.ownedEnd < core);
  assert.ok(entries.stats.peakBufferedSegments < 100000);
  assert.equal(entries.stats.truncated, false);
  assertStreamMaps(windows);
});

test("App compact mapping records stay sparse across hundreds of thousands of collapsed pieces", async () => {
  const tc = setup('<body><p></p></body>');
  const node = tc.document.querySelector("p");
  node.textContent = "a  ".repeat(150000) + "needle";
  const windows = [];
  const entries = await tc.collectBatched({ compactMappings: true, streamLiterals: true, literalQueryLength: 6,
    storeNodes: false, maxDurationMs: 30000, maxRunSegments: 1, maxTotalSegments: 1, maxEntries: 1, maxVisitedNodes: 1,
    onBatch(batch) { windows.push(...batch); return true; } });
  assert.equal(ownedText(windows), "a ".repeat(150000) + "needle");
  assert.equal(entries.stats.truncated, false);
  assert.ok(windows.every(entry => !entry.segments && entry.mappingRecords.length <= 3));
  assert.ok(entries.stats.peakBufferedSegments < 10);
  const last = windows.at(-1), start = last.text.lastIndexOf("needle");
  const [resolved] = await tc.mapping.resolveMatches(last.mappingRecords, [{ start, end: start + 6 }]);
  assert.equal(resolved.spans.length, 1);
  assert.equal(resolved.spans[0].nodeStart, 450000);
  assert.equal(resolved.spans[0].nodeEnd, 450006);
});

test("App compact windows resolve cross-node and cross-window hits at actual raw offsets", async () => {
  const tc = setup('<body><pre><span></span><b></b></pre></body>');
  const paragraph = tc.document.querySelector("pre");
  paragraph.firstChild.textContent = "x".repeat(core - 2) + "nee";
  paragraph.lastChild.textContent = "dle" + "y".repeat(core * 2);
  const entries = tc.collect({ compactMappings: true, streamLiterals: true, literalQueryLength: 6 });
  assert.equal(ownedText(entries), paragraph.textContent);
  const first = entries[0], start = first.text.indexOf("needle");
  const [resolved] = await tc.mapping.resolveMatches(first.mappingRecords, [{ start, end: start + 6 }]);
  assert.equal(resolved.spans.length, 2);
  assert.equal(resolved.spans[0].nodeStart, core - 2);
  assert.equal(resolved.spans[0].nodeEnd, core + 1);
  assert.equal(resolved.spans[1].nodeStart, 0);
  assert.equal(resolved.spans[1].nodeEnd, 3);
  assert.equal(tc.mapping.readBoundText(resolved.spans), "needle");
});

test("App compact pre-line recipes retain a previous-chunk trim across a physical window", async () => {
  const tc = setup('<body><p style="white-space:pre-line"></p></body>');
  const node = tc.document.querySelector("p");
  node.textContent = "x".repeat(core - 1) + " \n  needle" + "y".repeat(core * 2);
  const entries = tc.collect({ compactMappings: true, streamLiterals: true, literalQueryLength: 7 });
  assert.equal(ownedText(entries), "x".repeat(core - 1) + "\nneedle" + "y".repeat(core * 2));
  const first = entries[0], start = first.text.indexOf("\nneedle");
  const [resolved] = await tc.mapping.resolveMatches(first.mappingRecords, [{ start, end: start + 7 }]);
  assert.equal(tc.mapping.readBoundText(resolved.spans), "\nneedle");
});

test("App complex text source fragments preserve a logical run above sixteen MiB", async () => {
  const tc = setup('<body><pre></pre><p>safe</p></body>');
  const node = tc.document.querySelector("pre");
  node.textContent = "x".repeat(17 * MiB) + "needle";
  const fragments = [];
  const entries = await tc.collectBatched({ compactMappings: true, storeNodes: false, maxDurationMs: 30000,
    onBatch(batch) { fragments.push(...batch); return true; } });
  assert.equal(entries.stats.truncated, false);
  const firstRun = fragments.filter(entry => entry.source.runId === fragments[0].id);
  assert.equal(firstRun.map(entry => entry.text).join(""), node.textContent);
  assert.equal(firstRun[0].source.first, true);
  assert.equal(firstRun[0].source.runId, firstRun[0].id);
  assert.equal(firstRun.at(-1).source.last, true);
  assert.ok(firstRun.slice(0, -1).every(entry => !entry.source.last));
  assert.ok(firstRun.every(entry => entry.text.length <= core + 1 && !entry.stream && !entry.segments));
  for (let i = 1; i < firstRun.length; i++) {
    assert.equal(firstRun[i].source.offset, firstRun[i - 1].source.offset + firstRun[i - 1].text.length);
    assert.ok(firstRun[i].id > firstRun[i - 1].id);
  }
});

test("App exact fragment-sized source runs still send a final real EOF fragment", () => {
  const tc = setup('<body><pre></pre></body>');
  tc.document.querySelector("pre").textContent = "x".repeat(core);
  const entries = tc.collect({ compactMappings: true });
  assert.equal(entries.map(entry => entry.text).join(""), "x".repeat(core));
  assert.equal(entries[0].source.first, true);
  assert.equal(entries.at(-1).source.last, true);
});

test("App source-budget truncation does not mark an assembled regex fragment as a real end", () => {
  const tc = setup('<body><pre>abcdefghi</pre></body>');
  const entries = tc.collect({ compactMappings: true, maxChars: 6 });
  assert.equal(entries.map(entry => entry.text).join(""), "abcdef");
  assert.ok(entries.every(entry => !entry.source.last));
  assert.deepEqual(entries.stats.reasons, ["characters"]);
});

test("App compact control fragments keep full raw snapshots and exact value offsets", () => {
  const tc = setup('<body><textarea style="text-transform:uppercase"></textarea></body>');
  const node = tc.document.querySelector("textarea");
  node.value = "a".repeat(core * 3) + "needle";
  const entries = tc.collect({ compactMappings: true });
  assert.equal(entries.map(entry => entry.text).join(""), node.value.toUpperCase());
  assert.equal(entries[0].source.runId, entries[0].id);
  assert.equal(entries.at(-1).source.last, true);
  assert.ok(entries.every(entry => entry.controlOffset === entry.source.offset));
  assert.ok(entries.every(entry => entry.displayTextSnapshot === node.value && entry.controlTransform === "uppercase"));
});

test("App compact selection recipes charge selected raw bytes and resolve source endpoints lazily", async () => {
  const tc = setup('<body><p>prefix-<b>foo</b><i>bar</i>-suffix</p></body>');
  const paragraph = tc.document.querySelector("p"), selection = tc.document.createRange();
  selection.setStart(paragraph.querySelector("b").firstChild, 0); selection.setEnd(paragraph.querySelector("i").firstChild, 3);
  for (const streamLiterals of [true, false]) {
    const entries = tc.collect({ compactMappings: true, selectionScoped: true, selection, streamLiterals,
      maxChars: 6, literalQueryLength: 6 });
    assert.equal(entries.stats.scannedSourceCharacters, 6);
    assert.equal(entries.stats.truncated, false);
    assert.equal(entries.map(entry => entry.text).join(""), "foobar");
    const [resolved] = await tc.mapping.resolveMatches(entries[0].mappingRecords, [{ start: 0, end: 6 }]);
    assert.equal(tc.mapping.readBoundText(resolved.spans), "foobar");
    assert.equal(resolved.spans.length, 2);
    assert.ok(entries.every(entry => entry.selectionProcessed));
  }
});

test("App compact roots remain searchable beyond the former root count", () => {
  const tc = setup('<body></body>');
  for (let i = 0; i < 600; i++) {
    const host = tc.document.createElement("x-root");
    host.attachShadow({ mode: "open" }).textContent = "x";
    tc.document.body.append(host);
  }
  const entries = tc.collect({ compactMappings: true, streamLiterals: true, literalQueryLength: 1,
    maxRoots: 1, maxEntries: 1, maxVisitedNodes: 1, maxDurationMs: 30000 });
  assert.equal(ownedText(entries), "x".repeat(600));
  assert.equal(entries.stats.roots, 601);
  assert.equal(entries.stats.truncated, false);
});

test("acknowledged nonstream mappings do not accumulate against the active mapping budget", async () => {
  const tc = setup('<body></body>');
  for (let i = 0; i < 50; i++) {
    const paragraph = tc.document.createElement("p");
    for (let j = 0; j < 20; j++) { const span = tc.document.createElement("span"); span.textContent = "x"; paragraph.append(span); }
    tc.document.body.append(paragraph);
  }
  let count = 0;
  const entries = await tc.collectBatched({ storeNodes: false, maxTotalSegments: 30,
    onBatch(batch) { count += batch.length; return true; } });
  assert.equal(count, 50);
  assert.equal(entries.stats.segments, 1000);
  assert.equal(entries.stats.truncated, false);
  assert.equal(entries.length, 0);
  const stored = tc.collect({ maxTotalSegments: 30 });
  assert.equal(stored.length, 1);
  assert.deepEqual(stored.stats.reasons, ["segments"]);
});

test("external deadlines bypass the standalone duration and preserve thrown timeout errors", async () => {
  const tc = setup('<body><p>a</p><p>b</p><p>c</p></body>');
  const previous = globalThis.performance;
  let time = 0;
  globalThis.performance = { now() { return ++time; } };
  try {
    const entries = tc.collect({ externalDeadline: true, maxDurationMs: 1 });
    assert.deepEqual(entries.map(entry => entry.text), ["a", "b", "c"]);
    assert.equal(entries.stats.truncated, false);
    const limited = tc.collect({ maxDurationMs: 1 });
    assert.deepEqual(limited.stats.reasons, ["duration"]);
    const timeout = Object.assign(new Error("Search timed out"), { code: 504 });
    let checks = 0;
    await assert.rejects(tc.collectBatched({ externalDeadline: true,
      shouldContinue() { if (++checks > 5) throw timeout; return true; } }), error => error === timeout);
  } finally { globalThis.performance = previous; }
});

test("tail context touching the real run end marks each applicable window as last", () => {
  const tc = setup('<body><p></p></body>');
  const node = tc.document.querySelector("p"), queryLength = core;
  node.textContent = "x".repeat(core * 3 + 7);
  const entries = tc.collect({ streamLiterals: true, literalQueryLength: queryLength });
  const withTail = entries.filter(entry => entry.stream.last);
  assert.ok(withTail.length >= 2);
  assert.ok(withTail.some(entry => entry.stream.ownedEnd < node.textContent.length));
  assert.ok(withTail.every(entry => entry.stream.offset + entry.text.length === node.textContent.length));
  assert.equal(ownedText(entries), node.textContent);
});

test("a total source budget emits only ownership with enough actual trailing context", () => {
  const tc = setup('<body><p></p></body>');
  const node = tc.document.querySelector("p");
  node.textContent = "x".repeat(core * 4);
  const entries = tc.collect({ streamLiterals: true, literalQueryLength: 6, maxChars: core * 2 + 17 });
  assert.equal(entries.stats.scannedSourceCharacters, core * 2 + 17);
  assert.equal(ownedText(entries).length, core * 2 + 9);
  assert.ok(entries.every(entry => !entry.stream.last));
  assert.ok(entries.every(entry => entry.stream.offset + entry.text.length - entry.stream.ownedEnd >= 8));
  assert.deepEqual(entries.stats.reasons, ["characters"]);
});

test("stream mappings are bounded in flight rather than accumulating a run segment count", () => {
  const tc = setup('<body><pre></pre></body>');
  tc.document.querySelector("pre").textContent = "x".repeat(core * 20);
  const entries = tc.collect({ streamLiterals: true, literalQueryLength: 2, maxRunSegments: 6, maxTotalSegments: 6 });
  assert.equal(ownedText(entries).length, core * 20);
  assert.equal(entries.stats.truncated, false);
  assert.ok(entries.stats.segments > 6);
  assert.ok(entries.stats.peakBufferedSegments <= 6);
});

test("stream controls read one value and preserve original offsets, casing and snapshot", () => {
  const tc = setup('<body><textarea style="text-transform:uppercase"></textarea></body>');
  const node = tc.document.querySelector("textarea"), value = "a".repeat(core * 3) + "needle";
  let reads = 0;
  Object.defineProperty(node, "value", { get() { reads++; return value; } });
  const observed = [];
  const entries = tc.collect({ streamLiterals: true, literalQueryLength: 6,
    onControlRead(_, snapshot) { observed.push(snapshot); } });
  assert.equal(reads, 1);
  assert.deepEqual(observed, [{ value }]);
  assert.equal(ownedText(entries), value.toUpperCase());
  for (const entry of entries) {
    assert.equal(entry.displayTextSnapshot, value);
    assert.equal(entry.controlOffset, entry.stream.offset);
    assert.equal(entry.controlTransform, "uppercase");
    assert.equal(entry.textTransform, "uppercase");
  }
  assert.equal(entries.stats.controlEntries, 1);
});

test("mixed Unicode casing is decided once before any streamed node or control window", () => {
  const tc = setup('<body><p style="text-transform:uppercase"></p><textarea style="text-transform:uppercase"></textarea></body>');
  const value = "a".repeat(core * 3) + "é";
  tc.document.querySelector("p").textContent = value;
  tc.document.querySelector("textarea").value = value;
  const entries = tc.collect({ streamLiterals: true, literalQueryLength: 3 });
  assert.equal(ownedText(entries), value + value);
  assert.ok(entries.filter(entry => entry.kind === "control").every(entry => entry.controlTransform === "none"));
  assertStreamMaps(entries);
});

test("large stream control selections are cropped once with original value offsets", () => {
  const tc = setup('<body><textarea></textarea></body>');
  const node = tc.document.querySelector("textarea"), start = 5 * MiB;
  node.value = "z".repeat(start) + "x".repeat(core * 3) + "needle" + "tail";
  const selection = { kind: "control-selection", node, start, end: start + core * 3 + 6, valueSnapshot: node.value };
  const entries = tc.collect({ root: node, selection, streamLiterals: true, literalQueryLength: 6 });
  assert.equal(ownedText(entries), "x".repeat(core * 3) + "needle");
  assert.ok(entries.every(entry => entry.selectionProcessed));
  assert.ok(entries.every(entry => entry.controlOffset === start + entry.stream.offset));
  assert.equal(entries.stats.scannedSourceCharacters, selection.end - selection.start);
});

test("a short regex selection in a huge control avoids materializing the full transformed value", () => {
  const tc = setup('<body><textarea style="text-transform:uppercase"></textarea></body>');
  const node = tc.document.querySelector("textarea"), start = 17 * MiB;
  node.value = "z".repeat(start) + "needle" + "tail";
  const selection = { kind: "control-selection", node, start, end: start + 6, valueSnapshot: node.value };
  const entries = tc.collect({ root: node, selection, maxRunChars: 6, maxChars: 6, maxDurationMs: 30000 });
  assert.equal(entries[0].text, "NEEDLE");
  assert.equal(entries[0].controlOffset, start);
  assert.equal(entries[0].controlTransform, "uppercase");
  assert.equal(entries[0].displayTextSnapshot, node.value);
  assert.equal(entries[0].selectionProcessed, true);
});

test("stream text selections keep exact source maps and begin ownership at the selection boundary", () => {
  const tc = setup('<body><p></p></body>');
  const paragraph = tc.document.querySelector("p");
  paragraph.textContent = "prefix " + "a".repeat(core * 3) + "  needle  " + "b".repeat(core);
  const node = paragraph.firstChild, selection = tc.document.createRange();
  selection.setStart(node, 9); selection.setEnd(node, core * 3 + 17);
  const ordinary = tc.normalizeSelection(tc.collect()[0], selection).text;
  const entries = tc.collect({ selection, streamLiterals: true, literalQueryLength: 6 });
  assert.equal(ownedText(entries), ordinary);
  assert.ok(entries.every(entry => entry.selectionProcessed));
  assert.equal(entries[0].stream.first, true);
  assert.equal(entries[0].stream.offset, 0);
  assert.equal(entries[0].stream.ownedStart, 0);
  assert.equal(entries.at(-1).stream.last, true);
  assertStreamMaps(entries);
});

test("App cross-inline selections charge only chosen raw characters for literal and regex runs", () => {
  for (const streamLiterals of [false, true]) {
    const tc = setup('<body><p>prefix-<b>foo</b><i>bar</i>-suffix</p></body>');
    const paragraph = tc.document.querySelector("p"), selection = tc.document.createRange();
    selection.setStart(paragraph.querySelector("b").firstChild, 0);
    selection.setEnd(paragraph.querySelector("i").firstChild, 3);
    const entries = tc.collect({ root: paragraph, selection, selectionScoped: true, streamLiterals,
      literalQueryLength: 6, maxChars: 6, maxRunChars: 6 });
    assert.equal(ownedText(entries), "foobar");
    assert.equal(entries[0].selectionProcessed, true);
    assert.equal(entries.stats.scannedSourceCharacters, 6);
    assert.equal(entries.stats.sourceCharacters, 6);
    assert.equal(entries.stats.processedSourceCharacters, 20);
    assert.equal(entries.stats.truncated, false);
    if (streamLiterals) assertStreamMaps(entries);
    else assert.equal(new RegExp("^foobar$", "u").test(entries[0].text), true);
  }
});

test("App selected source does not charge excluded slotted characters in composed order", () => {
  for (const streamLiterals of [false, true]) {
    const tc = setup('<body><x-host><span slot="b">BB</span><span slot="a">AA</span><span slot="c">CC</span></x-host></body>');
    const host = tc.document.querySelector("x-host");
    host.attachShadow({ mode: "open" }).innerHTML = '<slot name="a"></slot><slot name="b"></slot><slot name="c"></slot>';
    const left = host.querySelector('[slot="a"]').firstChild, right = host.querySelector('[slot="c"]').firstChild;
    const selection = tc.document.createRange(); selection.setStart(left, 0); selection.setEnd(right, 2);
    const entries = tc.collect({ root: host, selection, selectionScoped: true, streamLiterals,
      literalQueryLength: 4, maxChars: 4, maxRunChars: 4 });
    assert.equal(ownedText(entries), "AACC");
    assert.equal(entries.stats.scannedSourceCharacters, 4);
    assert.equal(entries.stats.processedSourceCharacters, 6);
    assert.equal(entries.stats.truncated, false);
    assert.equal(entries[0].selectionProcessed, true);
  }
});

test("App small scan budgets cover short inline selections surrounded by large unselected context", () => {
  const tc = setup('<body><p><span></span><b>foo</b><i>bar</i><em></em></p></body>');
  const paragraph = tc.document.querySelector("p");
  paragraph.querySelector("span").textContent = "x".repeat(2000);
  paragraph.querySelector("em").textContent = "y".repeat(3000);
  const selection = tc.document.createRange();
  selection.setStart(paragraph.querySelector("b").firstChild, 0); selection.setEnd(paragraph.querySelector("i").firstChild, 3);
  const entries = tc.collect({ root: paragraph, selection, selectionScoped: true, streamLiterals: true,
    literalQueryLength: 6, maxChars: 1024, maxRunChars: 1024 });
  assert.equal(ownedText(entries), "foobar");
  assert.equal(entries.stats.scannedSourceCharacters, 6);
  assert.equal(entries.stats.processedSourceCharacters, 5006);
  assert.equal(entries.stats.truncated, false);
});

test("App complex regex selections do not materialize unselected context above sixteen MiB", () => {
  const tc = setup('<body><pre><span></span><b>foo</b><i>bar</i><em></em></pre></body>');
  const paragraph = tc.document.querySelector("pre");
  paragraph.querySelector("span").textContent = "x".repeat(17 * MiB);
  paragraph.querySelector("em").textContent = "y".repeat(3000);
  const selection = tc.document.createRange();
  selection.setStart(paragraph.querySelector("b").firstChild, 0); selection.setEnd(paragraph.querySelector("i").firstChild, 3);
  const entries = tc.collect({ root: paragraph, selection, selectionScoped: true, maxChars: 6, maxRunChars: 6,
    maxDurationMs: 30000 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, "foobar");
  assert.equal(entries[0].segments.length, 2);
  assert.equal(entries[0].selectionProcessed, true);
  assert.equal(entries.stats.scannedSourceCharacters, 6);
  assert.equal(entries.stats.truncated, false);
  assert.equal(new RegExp("^foobar$", "u").test(entries[0].text), true);
});

test("App complex regex selection in one huge Text keeps collapsed whitespace and absolute source offsets", () => {
  const tc = setup('<body><p></p></body>');
  const paragraph = tc.document.querySelector("p"), start = 17 * MiB;
  paragraph.textContent = "x".repeat(start) + "foo  bar" + "y".repeat(3000);
  const node = paragraph.firstChild, selection = tc.document.createRange();
  selection.setStart(node, start); selection.setEnd(node, start + 8);
  const entries = tc.collect({ selection, selectionScoped: true, maxChars: 8, maxRunChars: 8, maxDurationMs: 30000 });
  assert.equal(entries[0].text, "foo bar");
  assert.equal(entries[0].segments[0].nodeStart, start);
  assert.equal(entries[0].segments.at(-1).nodeEnd, start + 8);
  assert.equal(entries[0].selectionProcessed, true);
  assert.equal(entries.stats.scannedSourceCharacters, 8);
  assert.equal(entries.stats.truncated, false);
  assert.equal(new RegExp("^foo bar$", "u").test(entries[0].text), true);
});

test("App selection filtering retains CSS context without charging collapsed-away unselected whitespace", () => {
  const tc = setup('<body><p>a   b   c</p></body>');
  const node = tc.document.querySelector("p").firstChild, selection = tc.document.createRange();
  selection.setStart(node, 2); selection.setEnd(node, 7);
  const ordinary = tc.normalizeSelection(tc.collect()[0], selection).text;
  for (const streamLiterals of [false, true]) {
    const entries = tc.collect({ selection, selectionScoped: true, streamLiterals, maxChars: 5, maxRunChars: 5 });
    assert.equal(ownedText(entries), ordinary);
    assert.equal(entries.stats.scannedSourceCharacters, 5);
    assert.equal(entries.stats.truncated, false);
  }
});

test("composed slot reordering keeps selected ownership continuous after excluded middle text", () => {
  for (const large of [false, true]) {
    const tc = setup('<body><p><x-host><span slot="b">BB</span><span slot="a"></span><span slot="c"></span></x-host></p></body>');
    const host = tc.document.querySelector("x-host");
    host.attachShadow({ mode: "open" }).innerHTML = '<slot name="a"></slot><slot name="b"></slot><slot name="c"></slot>';
    const left = host.querySelector('[slot="a"]'), right = host.querySelector('[slot="c"]');
    left.textContent = large ? "A".repeat(core * 2 - 1) + " " : "AA";
    right.textContent = large ? " C" + "C".repeat(core * 2) : "CC";
    const selection = tc.document.createRange();
    selection.setStart(left.firstChild, 0); selection.setEnd(right.firstChild, right.firstChild.length);
    const ordinary = tc.normalizeSelection(tc.collect()[0], selection).text;
    const entries = tc.collect({ selection, streamLiterals: true, literalQueryLength: 4 });
    assert.equal(ownedText(entries), ordinary);
    assert.equal(entries[0].stream.offset, 0);
    for (let i = 1; i < entries.length; i++) {
      assert.equal(entries[i].stream.ownedStart, entries[i - 1].stream.ownedEnd);
    }
    assertStreamMaps(entries);
  }
});

test("selected inner painted spaces are retained when the original run has later trailing whitespace", () => {
  const tc = setup('<body><p>outside a b end   </p></body>');
  const node = tc.document.querySelector("p").firstChild, selection = tc.document.createRange();
  selection.setStart(node, 7); selection.setEnd(node, 12);
  const ordinary = tc.normalizeSelection(tc.collect()[0], selection).text;
  const entries = tc.collect({ selection, streamLiterals: true, literalQueryLength: 1 });
  assert.equal(ownedText(entries), ordinary);
  assert.equal(ownedText(entries), " a b ");
  assertStreamMaps(entries);
});

test("detached stream sources discard pending maps instead of accumulating future windows", async () => {
  for (const kind of ["pre", "textarea"]) {
    const tc = setup(`<body><${kind}></${kind}><p>safe</p></body>`);
    const node = tc.document.querySelector(kind), value = "x".repeat(core * 20);
    if (kind === "textarea") node.value = value;
    else node.textContent = value;
    const seen = [];
    const entries = await tc.collectBatched({ streamLiterals: true, literalQueryLength: 4, batchSize: 1,
      storeNodes: false, onBatch(batch) { seen.push(...batch); if (node.isConnected) node.remove(); return true; } });
    assert.equal(entries.stats.incompleteRuns, 1);
    assert.equal(seen.filter(entry => entry.node === node || entry.node.parentNode === node).length, 1);
    assert.equal(seen.at(-1).text, "safe");
    assert.ok(entries.stats.peakBufferedSegments < 10);
  }
});

test("ruby suspended base run retains streaming state while annotations stay independent", () => {
  const tc = setup('<head><style>ruby{display:ruby}rt{display:ruby-text}</style></head><body><p><ruby></ruby></p></body>');
  const ruby = tc.document.querySelector("ruby");
  ruby.append(tc.document.createTextNode("x".repeat(core * 2)));
  const annotation = tc.document.createElement("rt"); annotation.textContent = "reading"; ruby.append(annotation);
  ruby.append(tc.document.createTextNode("y".repeat(core * 2)));
  const entries = tc.collect({ streamLiterals: true, literalQueryLength: 3 });
  const runIds = [...new Set(entries.map(entry => entry.stream.runId))];
  assert.equal(runIds.length, 2);
  assert.ok(runIds.some(id => ownedText(entries.filter(entry => entry.stream.runId === id)) === "reading"));
  assert.ok(runIds.some(id => ownedText(entries.filter(entry => entry.stream.runId === id)) === "x".repeat(core * 2) + "y".repeat(core * 2)));
  assertStreamMaps(entries);
});

test("cancellation checkpoints interrupt a large preformatted node and large ASCII value transform", async () => {
  for (const kind of ["pre", "textarea"]) {
    const tc = setup(`<body><${kind} style="text-transform:uppercase"></${kind}></body>`);
    const node = tc.document.querySelector(kind);
    if (kind === "textarea") node.value = "x".repeat(20 * MiB);
    else node.textContent = "x".repeat(20 * MiB);
    let checks = 0;
    const entries = await tc.collectBatched({ streamLiterals: true, literalQueryLength: 3,
      shouldContinue: () => ++checks <= 10, storeNodes: false });
    assert.equal(entries.stats.aborted, true);
    assert.equal(entries.stats.entries, 0);
    assert.equal(entries.stats.truncated, false);
  }
});

test("a large exact Text selection checks its whitespace fast path in cancellable pieces", async () => {
  const tc = setup('<body><pre></pre></body>');
  const paragraph = tc.document.querySelector("pre");
  paragraph.textContent = "x".repeat(20 * MiB);
  const selection = tc.document.createRange();
  selection.selectNodeContents(paragraph.firstChild);
  let checks = 0;
  const entries = await tc.collectBatched({ selection, streamLiterals: true, storeNodes: false,
    shouldContinue: () => ++checks <= 10 });
  assert.equal(entries.stats.aborted, true);
  assert.equal(entries.stats.entries, 0);
});

test("blank-control probing stays within the source portion allowed by a small scan budget", async () => {
  const tc = setup('<body><textarea></textarea></body>');
  tc.document.querySelector("textarea").value = " ".repeat(20 * MiB);
  let checks = 0;
  const entries = await tc.collectBatched({ streamLiterals: true, maxChars: 1,
    shouldContinue: () => ++checks <= 20 });
  assert.equal(entries.stats.aborted, false);
  assert.equal(entries.stats.scannedSourceCharacters, 1);
  assert.deepEqual(entries.stats.reasons, ["characters"]);
  assert.equal(entries.length, 0);
});

test("password placeholders never read the secret value, including empty controls", () => {
  const tc = setup('<body><input type="password" placeholder="hint"></body>');
  const node = tc.document.querySelector("input");
  node.matches = selector => { assert.equal(selector, ":placeholder-shown"); return true; };
  Object.defineProperty(node, "value", { get() { throw new Error("private value getter"); } });
  const observed = [];
  const entries = tc.collect({ streamLiterals: true, onControlRead(_, value) { observed.push(value); } });
  assert.deepEqual(entries.map(entry => entry.text), ["hint"]);
  assert.deepEqual(observed, [{ empty: true }]);
});
