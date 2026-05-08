import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const source = await readFile("infra/text_collector.js", "utf8");

function setup(html) {
  const dom = new JSDOM(html, { url: "https://test.com" });
  const scope = {};
  globalThis.document = dom.window.document;
  globalThis.NodeFilter = dom.window.NodeFilter;
  new Function("globalThis", source)(scope);
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

test("exclude textarea", () => {
  const tc = setup('<body><textarea>editable</textarea><p>text</p></body>');
  const nodes = tc.collect();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].text, "text");
});

test("exclude contenteditable", () => {
  const tc = setup('<body><div contenteditable="true">edit me</div><p>text</p></body>');
  const nodes = tc.collect();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].text, "text");
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
