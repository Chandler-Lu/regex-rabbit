import assert from "node:assert/strict";
import test from "node:test";
import { readRuntimeSourceSync as readFileSync } from "../fixtures/runtime_source.mjs";
import { Worker } from "node:worker_threads";
import { JSDOM } from "jsdom";

const workerSource = readFileSync("search_worker.js", "utf8");
const workerDependencies = ["domain/pattern_analyzer.js", "domain/literal_matcher.js"]
  .map(file => readFileSync(file, "utf8")).join("\n");
const adaptedWorker = `
const { parentPort } = require("node:worker_threads");
const { performance } = require("node:perf_hooks");
const self = {
  postMessage(data) { parentPort.postMessage(data); },
  set onmessage(handler) { parentPort.on("message", data => handler({ data })); }
};
${workerDependencies}
${workerSource}
`;
const files = ["domain/runtime_config.js", "domain/pattern_analyzer.js", "infra/task_scheduler.js", "infra/page_visibility.js",
  "infra/selection_capture.js", "infra/text_mapping.js", "infra/text_collector.js", "infra/highlight_engine.js", "infra/worker_manager.js", "infra/search_controller.js"];
const sources = new Map(files.map(file => [file, readFileSync(file, "utf8")]));

function setup(t, text, config = {}) {
  const dom = new JSDOM("<p id='content'></p>", {
    url: "https://example.com/", runScripts: "outside-only", pretendToBeVisual: true
  });
  const w = dom.window;
  w.document.querySelector("#content").textContent = text;
  const originalNode = w.document.querySelector("#content").firstChild;
  const workers = [], states = [], results = [], batches = [];
  const rect = { left: 10, top: 10, right: 100, bottom: 30, width: 90, height: 20, x: 10, y: 10 };
  // jsdom has no layout engine. Matching, budgets, segment maps, DOM Ranges,
  // highlight registration and cleanup still use the actual source modules.
  w.Range.prototype.getClientRects = function () { return this.toString().length ? [rect] : []; };
  w.Range.prototype.getBoundingClientRect = () => rect;
  w.Element.prototype.getClientRects = () => [rect];
  w.Element.prototype.getBoundingClientRect = () => rect;
  w.CSS = { highlights: new Map() };
  w.Highlight = class Highlight extends Set {};
  w.chrome = { runtime: { getURL: file => file } };
  w.fetch = async file => ({ ok: true, text: async () => readFileSync(file, "utf8") });
  w.URL.createObjectURL = () => "blob:test-worker";
  w.URL.revokeObjectURL = () => {};
  w.Worker = class BrowserWorker {
    constructor() {
      this.inner = new Worker(adaptedWorker, { eval: true });
      this.inner.on("message", data => this.onmessage?.({ data }));
      this.inner.on("error", error => this.onerror?.({ error, message: error.message }));
      workers.push(this);
    }
    postMessage(message) {
      if (message.type === "chunks") batches.push(Array.from(message.chunks, chunk => chunk.text.length));
      this.inner.postMessage(message);
    }
    terminate() { this.terminated = true; return this.inner.terminate(); }
  };
  for (const file of files) w.eval(sources.get(file));
  const controller = w.RRSearchController.create({
    getConfig: () => ({ workerTimeoutMs: 10000, ...config }),
    onState: state => states.push(state), onResults: marks => results.push(marks)
  });
  t.after(async () => {
    controller.dispose();
    w.close();
    await Promise.all(workers.map(worker => worker.inner.terminate()));
  });
  return { w, controller, states, results, batches, workers, originalNode };
}

test("300 KiB visible text run survives collector, manager and real worker budgets", { timeout: 15000 }, async t => {
  const text = "x".repeat(300 * 1024) + "needle";
  const s = setup(t, text, { mode: "literal", caseSensitive: true });
  await s.controller.search("needle");
  const state = s.states.at(-1), marks = s.results.at(-1);
  assert.equal(state.status, "done", JSON.stringify(state));
  assert.equal(state.limited, false);
  assert.equal(state.renderedMatches, 1);
  assert.equal(state.scannedChars, text.length);
  assert.equal(state.stats.characters, text.length);
  assert.ok(s.batches.flat().every(length => length <= 16 * 1024 * 1024));
  assert.equal(marks[0].range.toString(), "needle");
  assert.equal(marks[0].range.startOffset, 300 * 1024);
  assert.equal(s.w.document.querySelector("#content").firstChild, s.originalNode);
  assert.equal(s.workers[0].terminated, true);
  s.controller.clear();
  assert.equal(s.w.CSS.highlights.size, 0);
});

test("real worker early completion reports the match cap and releases resources", { timeout: 15000 }, async t => {
  const s = setup(t, "needle ".repeat(200), { mode: "literal", caseSensitive: true, maxMatches: 100 });
  await s.controller.search("needle");
  const state = s.states.at(-1), marks = s.results.at(-1);
  assert.equal(state.status, "limited");
  assert.equal(state.limitReason, "max-matches");
  assert.equal(state.renderedMatches, 100);
  assert.equal(marks.length, 100);
  assert.ok(marks.every(mark => mark.range.toString() === "needle"));
  assert.equal(s.workers[0].terminated, true);
  s.controller.clear();
  assert.equal(s.w.CSS.highlights.size, 0);
  assert.equal(s.w.document.querySelector("#content").firstChild, s.originalNode);
});

test("clearing results releases previously collected detached shadow roots", { timeout: 15000 }, async t => {
  const s = setup(t, "", { mode: "literal", caseSensitive: true });
  const host = s.w.document.createElement("div");
  s.w.document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = "<p>needle</p>";
  await s.controller.search("needle");
  assert.equal(s.states.at(-1).renderedMatches, 1);
  assert.ok(s.controller.getState().roots.includes(shadow));
  host.remove();
  s.controller.clear();
  assert.equal(s.controller.getState().status, "idle");
  assert.equal(s.controller.getState().roots?.includes(shadow) || false, false);
  assert.equal(s.w.CSS.highlights.size, 0);
});

test("a legacy per-block setting does not restrict literal coverage after the single-budget update", { timeout: 15000 }, async t => {
  const text = "x".repeat(1280 * 1024) + "needle";
  const s = setup(t, text, { mode: "literal", caseSensitive: true, maxScannedChars: 32 * 1024 * 1024, maxBlockChars: 1024 * 1024 });
  await s.controller.search("needle");
  const state = s.states.at(-1), marks = s.results.at(-1);
  assert.equal(state.status, "done", JSON.stringify(state));
  assert.equal(state.scannedChars, text.length);
  assert.equal(state.renderedMatches, 1);
  assert.ok(s.batches.flat().every(length => length <= 16 * 1024 * 1024));
  assert.equal(marks[0].range.startOffset, 1280 * 1024);
  assert.equal(marks[0].range.toString(), "needle");
});

test("default literal coverage streams beyond the physical regex block budget", { timeout: 20000 }, async t => {
  const prefixLength = 17 * 1024 * 1024;
  const s = setup(t, "x".repeat(prefixLength) + "needle", { mode: "literal", caseSensitive: true, workerTimeoutMs: 15000 });
  await s.controller.search("needle");
  const state = s.states.at(-1);
  assert.equal(state.status, "done", JSON.stringify(state));
  assert.equal(state.renderedMatches, 1);
  assert.equal(state.scannedChars, prefixLength + 6);
  assert.ok(s.batches.flat().length > 100);
  assert.ok(s.batches.flat().every(length => length <= 16 * 1024 * 1024));
  assert.equal(s.results.at(-1)[0].range.startOffset, prefixLength);
  assert.equal(s.results.at(-1)[0].range.toString(), "needle");
});

test("complex regexes scan complete large sources without introducing physical-window anchors", { timeout: 20000 }, async t => {
  const s = setup(t, "x".repeat(17 * 1024 * 1024) + "needle", { caseSensitive: true, workerTimeoutMs: 15000 });
  await s.controller.search("^needle$");
  const state = s.states.at(-1);
  assert.equal(state.status, "done", JSON.stringify(state));
  assert.equal(state.renderedMatches, 0);
  assert.equal(state.limitReason, "");
  assert.equal(state.scannedChars, 17 * 1024 * 1024 + 6);
  assert.ok(s.batches.flat().every(length => length <= 16 * 1024 * 1024));
});

test("a native anchored match can span the complete source beyond one physical packet", { timeout: 20000 }, async t => {
  const text = 'x'.repeat(17 * 1024 * 1024) + 'needle';
  const s = setup(t, text, { caseSensitive: true, workerTimeoutMs: 15000 });
  await s.controller.search('^x+needle$');
  const state = s.states.at(-1), mark = s.results.at(-1)[0];
  assert.equal(state.status, 'done', JSON.stringify(state));
  assert.equal(state.renderedMatches, 1);
  assert.equal(state.scannedChars, text.length);
  assert.equal(mark.range.startOffset, 0);
  assert.equal(mark.range.endOffset, text.length);
  assert.ok(s.batches.flat().length > 1);
  assert.ok(s.batches.flat().every(length => length <= 16 * 1024 * 1024));
  assert.equal(typeof Object.getOwnPropertyDescriptor(mark, 'textContent').get, 'function');
  assert.equal(mark.textContent, text);
});

test("long case-insensitive plain regex text uses the real literal matcher", { timeout: 15000 }, async t => {
  const text = "prefix " + "a".repeat(65536) + "z suffix";
  const pattern = "A".repeat(65536) + "Z";
  const s = setup(t, text);
  await s.controller.search(pattern);
  const state = s.states.at(-1), marks = s.results.at(-1);
  assert.equal(state.status, "done");
  assert.equal(state.renderedMatches, 1);
  assert.equal(marks[0].range.startOffset, 7);
  assert.equal(marks[0].range.toString(), "a".repeat(65536) + "z");
});

test("the complete 4,096,000 character query is searchable through the real worker", { timeout: 15000 }, async t => {
  const pattern = 'a'.repeat(4096000);
  const s = setup(t, 'prefix ' + pattern + ' suffix', { mode: 'literal', caseSensitive: true });
  await s.controller.search(pattern);
  const state = s.states.at(-1), marks = s.results.at(-1);
  assert.equal(state.status, 'done', JSON.stringify(state));
  assert.equal(state.renderedMatches, 1);
  assert.equal(state.scannedChars, pattern.length + 14);
  assert.ok(s.batches.flat().every(length => length <= 16 * 1024 * 1024));
  assert.equal(marks[0].range.startOffset, 7);
  assert.equal(marks[0].range.endOffset, pattern.length + 7);
  assert.equal(marks[0].range.toString(), pattern);
});

test("a literal match spanning a collector window keeps exact original DOM offsets", { timeout: 15000 }, async t => {
  const prefixLength = 128 * 1024 - 3;
  const s = setup(t, "x".repeat(prefixLength) + "needle" + " y".repeat(10000), { mode: "literal", caseSensitive: true });
  await s.controller.search("needle");
  assert.equal(s.states.at(-1).status, "done");
  assert.equal(s.states.at(-1).renderedMatches, 1);
  const mark = s.results.at(-1)[0];
  assert.equal(mark.range.startOffset, prefixLength);
  assert.equal(mark.range.endOffset, prefixLength + 6);
  assert.equal(mark.range.toString(), "needle");
});

test("dense collapsed-whitespace maps emit short windows and report the original scanned characters", { timeout: 15000 }, async t => {
  const text = 'a  '.repeat(60000) + 'needle';
  const s = setup(t, text, { mode: 'literal', caseSensitive: true });
  await s.controller.search('needle');
  const state = s.states.at(-1);
  assert.equal(state.status, 'done', JSON.stringify(state));
  assert.equal(state.renderedMatches, 1);
  assert.equal(state.scannedChars, text.length);
  assert.equal(state.scanLimitChars, 33554432000);
  assert.equal(state.stats.characters, 120006);
  const mark = s.results.at(-1)[0];
  assert.equal(mark.range.startOffset, 180000);
  assert.equal(mark.range.toString(), 'needle');
});

test("real streamed cross-inline selections use the selection boundary and exact source offsets", { timeout: 15000 }, async t => {
  const s = setup(t, "", { mode: "literal", caseSensitive: true });
  const p = s.w.document.querySelector('#content');
  p.innerHTML = 'prefix foo<b>bar suffix</b>';
  const selection = s.w.document.createRange();
  selection.setStart(p.firstChild, 7); selection.setEnd(p.querySelector('b').firstChild, 3);
  await s.controller.search('foobar', { scope: 'selection', selection });
  const state = s.states.at(-1);
  assert.equal(state.status, 'done', JSON.stringify(state));
  assert.equal(state.renderedMatches, 1);
  assert.equal(state.scannedChars, 6);
  assert.equal(state.stats.characters, 6);
  const mark = s.results.at(-1)[0];
  assert.equal(mark.ranges.map(range => range.toString()).join(''), 'foobar');
  assert.equal(mark.ranges[0].startOffset, 7);
  assert.equal(mark.ranges.at(-1).endOffset, 3);
});

test("unselected CSS context cannot exhaust the selected-source coverage budget", { timeout: 15000 }, async t => {
  const s = setup(t, '', { mode: 'literal', caseSensitive: true, maxScannedChars: 1024 });
  const p = s.w.document.querySelector('#content');
  p.innerHTML = 'x'.repeat(2000) + 'foo<b>bar' + 'y'.repeat(3000) + '</b>';
  const selection = s.w.document.createRange();
  selection.setStart(p.firstChild, 2000); selection.setEnd(p.querySelector('b').firstChild, 3);
  await s.controller.search('foobar', { scope: 'selection', selection });
  const state = s.states.at(-1);
  assert.equal(state.status, 'done', JSON.stringify(state));
  assert.equal(state.renderedMatches, 1);
  assert.equal(state.scannedChars, 6);
  assert.equal(state.scanLimitChars, 1024);
  const mark = s.results.at(-1)[0];
  assert.equal(mark.ranges.map(range => range.toString()).join(''), 'foobar');
  assert.equal(mark.ranges[0].startOffset, 2000);
  assert.equal(mark.ranges.at(-1).endOffset, 3);
});

test("a small complex-regex selection does not inherit the size of unselected DOM context", { timeout: 15000 }, async t => {
  const s = setup(t, '', { mode: 'regex', caseSensitive: true, maxScannedChars: 1024 });
  const p = s.w.document.querySelector('#content'), prefixLength = 20 * 1024 * 1024;
  p.textContent = 'x'.repeat(prefixLength) + 'foo';
  const inline = s.w.document.createElement('b'); inline.textContent = 'bar suffix'; p.appendChild(inline);
  const selection = s.w.document.createRange();
  selection.setStart(p.firstChild, prefixLength); selection.setEnd(inline.firstChild, 3);
  await s.controller.search('^foobar$', { scope: 'selection', selection });
  const state = s.states.at(-1);
  assert.equal(state.status, 'done', JSON.stringify(state));
  assert.equal(state.renderedMatches, 1);
  assert.equal(state.scannedChars, 6);
  assert.equal(state.scanLimitChars, 1024);
  const mark = s.results.at(-1)[0];
  assert.equal(mark.ranges.map(range => range.toString()).join(''), 'foobar');
  assert.equal(mark.ranges[0].startOffset, prefixLength);
  assert.equal(mark.ranges.at(-1).endOffset, 3);
});

test("excluded reordered-slot text cannot consume the selected-source coverage budget", { timeout: 15000 }, async t => {
  const s = setup(t, '', { mode: 'literal', caseSensitive: true, maxScannedChars: 1024 });
  const host = s.w.document.createElement('x-host');
  host.innerHTML = '<span slot="b"></span><span slot="a"></span><span slot="c"></span>';
  host.attachShadow({ mode: 'open' }).innerHTML = '<slot name="a"></slot><slot name="b"></slot><slot name="c"></slot>';
  const left = host.querySelector('[slot="a"]'), right = host.querySelector('[slot="c"]');
  left.textContent = 'A'.repeat(500); right.textContent = 'C'.repeat(500);
  host.querySelector('[slot="b"]').textContent = 'B'.repeat(1000);
  s.w.document.body.appendChild(host);
  const selection = s.w.document.createRange();
  selection.setStart(left.firstChild, 0); selection.setEnd(right.firstChild, 500);
  await s.controller.search('AACC', { scope: 'selection', selection });
  const state = s.states.at(-1);
  assert.equal(state.status, 'done', JSON.stringify(state));
  assert.equal(state.renderedMatches, 1);
  assert.equal(state.scannedChars, 1000);
  assert.equal(state.scanLimitChars, 1024);
  const mark = s.results.at(-1)[0];
  assert.equal(mark.ranges.map(range => range.toString()).join(''), 'AACC');
  assert.equal(mark.ranges[0].startOffset, 498);
  assert.equal(mark.ranges.at(-1).endOffset, 2);
});

for (const large of [false, true]) {
  test(`real ${large ? 'multi-window' : 'small'} selected slots exclude reordered middle text without breaking ownership`, { timeout: 15000 }, async t => {
    const s = setup(t, '', { mode: 'literal', caseSensitive: true });
    const host = s.w.document.createElement('x-host');
    host.innerHTML = '<span slot="b">BB</span><span slot="a"></span><span slot="c"></span>';
    host.attachShadow({ mode: 'open' }).innerHTML = '<slot name="a"></slot><slot name="b"></slot><slot name="c"></slot>';
    const left = host.querySelector('[slot="a"]'), right = host.querySelector('[slot="c"]');
    left.textContent = large ? 'A'.repeat(2 * 128 * 1024 - 1) + ' ' : 'AA';
    right.textContent = large ? ' C' + 'C'.repeat(2 * 128 * 1024) : 'CC';
    s.w.document.body.appendChild(host);
    const selection = s.w.document.createRange();
    selection.setStart(left.firstChild, 0); selection.setEnd(right.firstChild, right.firstChild.length);
    const pattern = large ? 'A  C' : 'AACC';
    await s.controller.search(pattern, { scope: 'selection', selection });
    const state = s.states.at(-1);
    assert.equal(state.status, 'done', JSON.stringify(state));
    assert.equal(state.renderedMatches, 1);
    const mark = s.results.at(-1)[0];
    assert.equal(mark.ranges.map(range => range.toString()).join(''), pattern);
    assert.equal(mark.ranges[0].startOffset, large ? left.textContent.length - 2 : 0);
    assert.equal(mark.ranges.at(-1).endOffset, 2);
  });
}

test("a short selected substring in a 20 MiB control never sends the complete value", { timeout: 15000 }, async t => {
  const s = setup(t, "", { mode: "literal", caseSensitive: true, maxBlockChars: 1024 });
  const control = s.w.document.createElement('textarea');
  const prefixLength = 20 * 1024 * 1024;
  control.value = 'x'.repeat(prefixLength) + 'needle tail';
  s.w.document.body.appendChild(control);
  control.focus(); control.setSelectionRange(prefixLength, prefixLength + 6);
  const selection = s.w.RRSelectionCapture.capture();
  await s.controller.search('needle', { scope: 'selection', selection });
  const state = s.states.at(-1);
  assert.equal(state.status, 'done', JSON.stringify(state));
  assert.equal(state.renderedMatches, 1);
  assert.equal(state.scannedChars, 6);
  assert.deepEqual(s.batches, [[6]]);
  const mark = s.results.at(-1)[0];
  assert.equal(mark.start, prefixLength);
  assert.equal(mark.end, prefixLength + 6);
  assert.equal(mark.displaySnapshot, null);
  assert.equal(mark.boundDisplayLength, 6);
  assert.equal(typeof Object.getOwnPropertyDescriptor(mark, 'textContent').get, 'function');
  assert.equal(mark.textContent, 'needle');
});

test("a budget-truncated native source never turns its fragment end into an anchor", { timeout: 15000 }, async t => {
  const s = setup(t, 'x'.repeat(2048) + 'tail', { caseSensitive: true, maxScannedChars: 1024 });
  await s.controller.search('^x+$');
  const state = s.states.at(-1);
  assert.equal(state.status, 'limited', JSON.stringify(state));
  assert.match(state.limitReason, /characters/);
  assert.equal(state.scannedChars, 1024);
  assert.equal(state.renderedMatches, 0);
  assert.equal(s.w.CSS.highlights.size, 0);
});

test("a partial streamed scan completes with confirmed hits and an explicit coverage limit", { timeout: 15000 }, async t => {
  const s = setup(t, 'needle' + 'x'.repeat(2 * 1024 * 1024), {
    mode: 'literal', caseSensitive: true, maxScannedChars: 1024 * 1024
  });
  await s.controller.search('needle');
  const state = s.states.at(-1);
  assert.equal(state.status, 'limited', JSON.stringify(state));
  assert.match(state.limitReason, /characters/);
  assert.equal(state.renderedMatches, 1);
  assert.ok(state.scannedChars <= 1024 * 1024);
  assert.equal(s.results.at(-1)[0].range.startOffset, 0);
  assert.equal(s.results.at(-1)[0].range.toString(), 'needle');
  s.controller.clear();
  assert.equal(s.w.CSS.highlights.size, 0);
});

test("DOM changes between collection and rendering cannot create a stale cross-node result", { timeout: 15000 }, async t => {
  const s = setup(t, "", { mode: "literal", caseSensitive: true });
  const p = s.w.document.querySelector('#content');
  p.innerHTML = 'a<span style="display:none">x</span>b';
  const searchStream = s.w.RRWorkerManager.searchStream;
  s.w.RRWorkerManager.searchStream = async (...args) => {
    const result = await searchStream(...args);
    p.querySelector('span').style.display = 'inline';
    return result;
  };
  await s.controller.search('ab');
  assert.equal(s.states.at(-1).renderedMatches, 0);
  assert.equal(s.states.at(-1).skippedMatches, 1);
  assert.equal(s.w.CSS.highlights.size, 0);
  await s.controller.search('axb');
  assert.equal(s.states.at(-1).renderedMatches, 1);
});
