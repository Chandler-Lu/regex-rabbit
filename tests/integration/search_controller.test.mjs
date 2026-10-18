import assert from "node:assert/strict";
import test from "node:test";
import { readRuntimeSourceSync as readFileSync } from "../fixtures/runtime_source.mjs";
import { JSDOM } from "jsdom";

function setup(html = '<p>foo<b>bar</b></p>', config = {}) {
  const dom = new JSDOM(html, { url: 'https://example.com', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  for (const file of ['domain/runtime_config.js', 'domain/pattern_analyzer.js', 'infra/task_scheduler.js', 'infra/page_visibility.js', 'infra/selection_capture.js', 'infra/text_mapping.js', 'infra/text_collector.js', 'infra/search_controller.js']) {
    w.eval(readFileSync(file, 'utf8'));
  }
  const states = [], results = [], rendered = [], received = [], roots = [];
  w.RRHighlightEngine = {
    renderMatchesBatched: async (entries, matches, options) => {
      if (!options.shouldContinue()) return { cancelled: true, handles: [], marks: [] };
      rendered.push(entries);
      return { handles: [{}], marks: matches.map(m => ({ ...m, isConnected: true })) };
    },
    removeHighlights: () => {}
  };
  w.RRWorkerManager = {
    updateConfig: cfg => { received.push(cfg); }, cancel: () => {}, dispose: () => {},
    searchStream: async (id, pattern, flags, stream, policy) => {
      const entries = [];
      await stream(async batch => { entries.push(...batch); return batch.length; }, () => true);
      received.push({ id, pattern, flags, policy, entries });
      return { matches: entries.map(entry => ({ chunkId: entry.id, start: 0, end: entry.text.length })), scannedChars: entries.reduce((a,e) => a+e.text.length, 0) };
    }
  };
  const controller = w.RRSearchController.create({ getConfig: () => config, onState: state => states.push(state), onResults: (marks,meta) => results.push({marks,meta}), onRoot: root => roots.push(root) });
  return { dom, w, controller, states, results, rendered, received, roots };
}

test('worker failure cannot execute a main-thread matching fallback', async () => {
  const s = setup('<p id="p">searchable</p>');
  const original = s.w.document.querySelector('#p').firstChild;
  s.w.RRWorkerManager.searchStream = async () => { throw { code: 'worker-spawn-failed', numericCode: 531, message: 'CSP denied' }; };
  await s.controller.search('searchable');
  assert.equal(s.states.at(-1).status, 'error');
  assert.equal(s.states.at(-1).detail, 'CSP denied');
  assert.equal(s.rendered.length, 0);
  assert.equal(s.w.document.querySelector('#p').firstChild, original);
  s.dom.window.close();
});

test('selection is clipped to exact cross-inline UTF16 offsets', async () => {
  const s = setup('<p>prefix foo<b>bar suffix</b></p><p>unrelated</p>');
  const p = s.w.document.querySelector('p'), selection = s.w.document.createRange();
  selection.setStart(p.firstChild, 7);
  selection.setEnd(p.querySelector('b').firstChild, 3);
  await s.controller.search('foobar', { scope: 'selection', selection });
  const entries = s.rendered[0];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, 'foobar');
  assert.equal(entries[0].segments[0].nodeStart, 7);
  assert.equal(entries[0].segments[1].nodeEnd, 3);
  assert.equal(s.states.at(-1).renderedMatches, 1);
  s.dom.window.close();
});

test('selection searches cannot silently become page searches', async () => {
  const s = setup();
  await s.controller.search('foo', { scope: 'selection' });
  assert.equal(s.states.at(-1).message, 'Select page text first');
  assert.equal(s.rendered.length, 0);
  s.dom.window.close();
});

test('literal mode accepts regex metacharacters and passes word policy and flags', async () => {
  const s = setup('<p>[a+(</p>', { mode: 'literal', wholeWord: true, caseSensitive: true });
  await s.controller.search('[a+(');
  const request = s.received.at(-1);
  assert.equal(request.policy.mode, 'literal');
  assert.equal(request.policy.wholeWord, true);
  assert.equal(request.flags, 'gu');
  assert.equal(s.states.at(-1).status, 'done');
  s.dom.window.close();
});

test('unsafe or overlong query never starts a worker', async () => {
  const s = setup();
  await s.controller.search('(a+)+$');
  assert.equal(s.states.at(-1).status, 'unsafe');
  await s.controller.search('x'.repeat(4096001));
  assert.equal(s.states.at(-1).status, 'invalid');
  assert.equal(s.received.length, 0);
  s.dom.window.close();
});

test('long queries are deferred to the worker and never compiled on the page', async () => {
  const s = setup('<p>needle</p>');
  const NativeRegExp = s.w.RegExp;
  s.w.RegExp = new Proxy(NativeRegExp, {
    construct(target, args) {
      assert.ok(String(args[0]).length <= 8192, 'a long expression was compiled on the page');
      return Reflect.construct(target, args);
    }
  });
  const pattern = '[' + 'x'.repeat(8192);
  await s.controller.search(pattern);
  const request = s.received.at(-1);
  assert.equal(request.pattern, pattern);
  assert.equal(request.policy.status, 'deferred');
  assert.equal(request.policy.analyzeInWorker, true);
  assert.equal(Object.hasOwn(s.received[0], 'maxNodeChars'), false);
  assert.equal(Object.hasOwn(s.received[0], 'maxChunkMs'), false);
  assert.equal(s.received[0].maxBatchChars, 16 * 1024 * 1024);
  s.dom.window.close();
});

test('a query cancelled during deferred preparation never starts a worker', async () => {
  const s = setup('<p>needle</p>');
  const searching = s.controller.search('x'.repeat(4096000));
  s.controller.clear();
  await searching;
  assert.equal(s.received.length, 0);
  assert.equal(s.controller.isBusy(), false);
  assert.equal(s.controller.getState().status, 'idle');
  s.dom.window.close();
});

function installIntervalManager(s, matcher) {
  s.w.RRWorkerManager.searchStream = async (id, pattern, flags, stream) => {
    const matches = [], entries = [];
    let intervals = [], scannedChars = 0;
    await stream(async batch => {
      entries.push(...batch);
      intervals = batch.flatMap(entry => matcher(entry, pattern));
      matches.push(...intervals);
      scannedChars += batch.reduce((sum, entry) => sum + (entry.stream ? entry.stream.ownedEnd - entry.stream.ownedStart : entry.text.length), 0);
    }, () => true, () => [...new Set(intervals.map(match => match.chunkId))], () => intervals);
    s.received.push({ entries });
    return { matches, scannedChars };
  };
}

function literalIntervals(entry, pattern) {
  const matches = [];
  for (let start = entry.text.indexOf(pattern); start !== -1; start = entry.text.indexOf(pattern, start + pattern.length)) {
    if (!entry.stream || (start + entry.stream.offset >= entry.stream.ownedStart && start + entry.stream.offset < entry.stream.ownedEnd)) {
      matches.push({ chunkId: entry.id, start, end: start + pattern.length });
    }
  }
  return matches;
}

test('interval acknowledgements retain only each hit and its exact cross-inline map', async () => {
  const s = setup('<p>prefix foo<b>bar</b> gap foo<b>bar</b> suffix</p>', { mode: 'literal', caseSensitive: true });
  installIntervalManager(s, literalIntervals);
  await s.controller.search('foobar');
  const entries = s.rendered[0], marks = s.results.at(-1).marks;
  assert.equal(entries.length, 2);
  assert.ok(entries.every(entry => entry.kind === 'bound-text' && entry.displayLength === 6 && !Object.hasOwn(entry, 'text') && !entry.stream));
  assert.equal(entries[0].boundSpans[0].nodeStart, 7);
  assert.equal(entries[0].boundSpans[0].rawSnapshot.slice(entries[0].boundSpans[0].snapshotStart, entries[0].boundSpans[0].snapshotEnd), 'foo');
  assert.equal(entries[0].boundSpans[1].nodeEnd, 3);
  assert.notEqual(entries[0].id, entries[1].id);
  assert.ok(marks.every(mark => mark.start === 0 && mark.end === 6));
  s.dom.window.close();
});

test('cropped acknowledgements preserve raw collapsed whitespace for real ranges', async () => {
  const s = setup('<p>prefix a    <b>b</b> suffix</p>', { mode: 'literal', caseSensitive: true });
  installIntervalManager(s, literalIntervals);
  installRealHighlights(s.w);
  await s.controller.search('a b');
  assert.equal(s.states.at(-1).renderedMatches, 1);
  const mark = s.results.at(-1).marks[0];
  assert.equal(mark.ranges.map(range => range.toString()).join(''), 'a    b');
  assert.equal(mark.range.startOffset, 7);
  assert.equal(mark.ranges.at(-1).endOffset, 1);
  s.dom.window.close();
});

test('modern control selection acknowledgements keep absolute native navigation offsets', async () => {
  const s = setup('<textarea>prefix needle suffix</textarea>', { mode: 'literal', caseSensitive: true });
  installIntervalManager(s, literalIntervals);
  installRealHighlights(s.w);
  const control = s.w.document.querySelector('textarea');
  control.focus(); control.setSelectionRange(7, 13);
  const selection = s.w.RRSelectionCapture.capture();
  await s.controller.search('needle', { scope: 'selection', selection });
  assert.equal(s.states.at(-1).renderedMatches, 1);
  assert.equal(s.results.at(-1).marks[0].start, 7);
  assert.equal(s.results.at(-1).marks[0].end, 13);
  s.dom.window.close();
});

test('several control hits share the original snapshot and retain only numeric bounds', async () => {
  const s = setup('<textarea>needle needle</textarea><input value="needle">', { mode: 'literal', caseSensitive: true });
  installIntervalManager(s, literalIntervals);
  await s.controller.search('needle');
  assert.equal(s.states.at(-1).status, 'done');
  assert.equal(s.states.at(-1).renderedMatches, 3);
  assert.equal(s.rendered[0][0].displayTextSnapshot, 'needle needle');
  assert.equal(s.rendered[0][1].displayTextSnapshot, 'needle needle');
  assert.ok(s.rendered[0].every(entry => !Object.hasOwn(entry, 'text') && entry.displayLength === 6));
  assert.equal(s.rendered[0][0].controlOffset, 0);
  assert.equal(s.rendered[0][1].controlOffset, 7);
  s.dom.window.close();
});

test('clearing control results releases the previous source bindings before another query', async () => {
  const s = setup('<textarea>needle needle</textarea><input value="needle">', { mode: 'literal', caseSensitive: true });
  installIntervalManager(s, literalIntervals);
  await s.controller.search('needle');
  assert.equal(s.states.at(-1).status, 'done');
  assert.equal(s.states.at(-1).renderedMatches, 3);
  s.controller.clear();
  await s.controller.search('absent');
  assert.equal(s.states.at(-1).renderedMatches, 0);
  assert.equal(s.rendered.at(-1).length, 0);
  s.dom.window.close();
});

test('large acknowledged results retain source bounds without a copied-text quota', async () => {
  const s = setup('', { mode: 'regex', caseSensitive: true });
  const sourceText = 'x'.repeat(17 * 1024 * 1024);
  const nodes = [s.w.document.createTextNode(sourceText), s.w.document.createTextNode(sourceText)];
  nodes.forEach(node => s.w.document.body.appendChild(node));
  let productionContinued = true;
  s.w.RRTextCollector.collectBatched = async options => {
    productionContinued = await options.onBatch(nodes.map((node, index) => ({ id: index + 1, node, kind: 'text', text: sourceText, root: s.w.document,
      segments: [{ node, start: 0, end: sourceText.length, nodeStart: 0, nodeEnd: sourceText.length, sourceText }] })));
    return { stats: { truncated: false }, roots: [] };
  };
  installIntervalManager(s, entry => [{ chunkId: entry.id, start: 0, end: entry.text.length }]);
  await s.controller.search('x+');
  assert.equal(productionContinued, true);
  assert.equal(s.states.at(-1).status, 'done');
  assert.equal(s.states.at(-1).renderedMatches, 2);
  assert.ok(s.rendered[0].every(entry => !Object.hasOwn(entry, 'text') && entry.displayLength === sourceText.length));
  assert.equal(s.rendered[0][0].boundSpans[0].rawSnapshot, sourceText);
  assert.equal(s.rendered[0][1].boundSpans[0].nodeEnd, sourceText.length);
  s.dom.window.close();
});

test('budget truncation stays visible when zero matches were found', async () => {
  const s = setup('<p>'+'x'.repeat(2048)+'</p><p>foo</p>', { maxScannedChars: 1024 });
  installIntervalManager(s, literalIntervals);
  await s.controller.search('foo');
  assert.equal(s.states.at(-1).status, 'limited');
  assert.equal(s.states.at(-1).renderedMatches, 0);
  assert.ok(s.states.at(-1).limitReason.includes('characters'));
  s.dom.window.close();
});

test('superseded worker completion cannot overwrite a newer search', async () => {
  const s = setup();
  let oldResolve, startResolve;
  const started = new Promise(resolve => { startResolve=resolve; });
  const realSearch = s.w.RRWorkerManager.searchStream;
  s.w.RRWorkerManager.searchStream = (...args) => args[1] === 'old' ? new Promise(resolve => { oldResolve=resolve; startResolve(); }) : realSearch(...args);
  const old = s.controller.search('old');
  await started;
  await s.controller.search('new');
  const count = s.states.length;
  oldResolve({ matches: [{chunkId:0,start:0,end:3}] });
  await old;
  assert.equal(s.states.length,count);
  assert.equal(s.rendered.length,1);
  assert.equal(s.received.at(-1).pattern,'new');
  s.dom.window.close();
});

test('control selection scans only the selected substring and restores native offsets for navigation', async () => {
  const s = setup('<textarea>prefix needle suffix</textarea><p>needle</p>', { mode: 'literal', caseSensitive: true, maxBlockChars: 1024 });
  installIntervalManager(s, literalIntervals);
  installRealHighlights(s.w);
  const control = s.w.document.querySelector('textarea'); control.focus(); control.setSelectionRange(7, 13);
  const selection = s.w.RRSelectionCapture.capture();
  await s.controller.search('needle', { scope: 'selection', selection });
  const request = s.received.at(-1), result = s.results.at(-1).marks[0];
  assert.equal(request.entries.length, 1);
  assert.equal(request.entries[0].text, 'needle');
  assert.equal(result.start, 7); assert.equal(result.end, 13);
  assert.equal(s.states.at(-1).scannedChars, 6);
  s.dom.window.close();
});

test('control selection cannot reuse offsets after the value changes', async () => {
  const s = setup('<input value="prefix needle suffix">');
  const input = s.w.document.querySelector('input'); input.focus(); input.setSelectionRange(7, 13);
  const selection = s.w.RRSelectionCapture.capture(); input.value = 'different needle';
  await s.controller.search('needle', { scope: 'selection', selection });
  assert.equal(s.states.at(-1).status, 'error');
  assert.equal(s.received.length, 0); s.dom.window.close();
});

test('page scope ignores a stale selection passed by the caller', async () => {
  const s = setup('<p>needle</p><p>needle</p>');
  await s.controller.search('needle', { scope: 'page', selection: s.w.document.createRange() });
  assert.equal(s.received.at(-1).entries.length, 2);
  assert.equal(s.states.at(-1).renderedMatches, 2); s.dom.window.close();
});

function installRealHighlights(w) {
  const rect = () => ({ left: 20, top: 20, right: 100, bottom: 40, width: 80, height: 20 });
  w.Range.prototype.getClientRects = function () { return this.toString() ? [rect()] : []; };
  w.Range.prototype.getBoundingClientRect = rect;
  w.Element.prototype.getBoundingClientRect = rect;
  w.Element.prototype.getClientRects = () => [rect()];
  w.CSS = { highlights: new Map() }; w.Highlight = class extends Set {};
  w.eval(readFileSync('infra/highlight_engine.js', 'utf8'));
}

test('the search deadline cancels real range construction and allows the next query', async () => {
  const s = setup('<p>foo</p><p>foo</p><p>foo</p>', { workerTimeoutMs: 500 });
  installRealHighlights(s.w);
  let clock = 1000, slow = true, checks = 0;
  s.w.performance.now = () => clock;
  const original = s.w.Range.prototype.getClientRects;
  s.w.Range.prototype.getClientRects = function () {
    checks++; if (slow) clock += 150;
    return original.call(this);
  };
  await s.controller.search('foo');
  assert.ok(checks >= 4);
  assert.equal(s.states.at(-1).status, 'timeout');
  assert.equal(s.states.at(-1).errorCode, 504);
  assert.equal(s.controller.isBusy(), false);
  assert.equal(s.w.CSS.highlights.size, 0);
  assert.equal(s.w.document.querySelectorAll('[data-regex-rabbit-owned]').length, 0);
  assert.equal(s.results.at(-1).marks.length, 0);
  slow = false;
  await s.controller.search('foo');
  assert.equal(s.states.at(-1).status, 'done');
  assert.equal(s.states.at(-1).renderedMatches, 3);
  s.controller.dispose(); s.dom.window.close();
});

test('matching time reduces the remaining rendering deadline', async () => {
  const s = setup('<p>foo</p>', { workerTimeoutMs: 500 });
  installRealHighlights(s.w);
  let clock = 1000;
  s.w.performance.now = () => clock;
  const search = s.w.RRWorkerManager.searchStream;
  s.w.RRWorkerManager.searchStream = async (...args) => {
    const result = await search(...args); clock += 600; return result;
  };
  let geometry = 0;
  const rects = s.w.Range.prototype.getClientRects;
  s.w.Range.prototype.getClientRects = function () { geometry++; return rects.call(this); };
  await s.controller.search('foo');
  assert.equal(s.states.at(-1).status, 'timeout');
  assert.equal(geometry, 0);
  assert.equal(s.w.CSS.highlights.size, 0);
  s.controller.dispose(); s.dom.window.close();
});

test('query preparation consumes the worker budget instead of starting a fresh timeout', async () => {
  const s = setup('<p>foo</p>', { workerTimeoutMs: 500 });
  let clock = 1000;
  s.w.performance.now = () => clock;
  const analyze = s.w.RRPatternAnalyzer.analyze;
  s.w.RRPatternAnalyzer.analyze = (...args) => {
    const policy = analyze(...args); clock += 200; return policy;
  };
  const search = s.w.RRWorkerManager.searchStream;
  s.w.RRWorkerManager.searchStream = async (...args) => {
    const result = await search(...args); clock += 350; return result;
  };
  await s.controller.search('foo');
  assert.equal(s.received[0].workerTimeoutMs, 300);
  assert.equal(s.states.at(-1).status, 'timeout');
  assert.equal(s.states.at(-1).errorCode, 504);
  assert.equal(s.rendered.length, 0);
  s.dom.window.close();
});

for (const [workerTimeoutMs, collectionClock] of [[5000, 5600], [30000, 21000]]) {
  test(`collection uses the shared ${workerTimeoutMs} ms deadline without an earlier collector timer`, async () => {
    const s = setup('<p>needle</p>', { mode: 'literal', workerTimeoutMs });
    let clock = 1000;
    s.w.performance.now = () => clock;
    const collect = s.w.RRTextCollector.collectBatched;
    s.w.RRTextCollector.collectBatched = options => collect({ ...options, onRoot(root, meta) {
      options.onRoot?.(root, meta);
      clock = collectionClock;
    } });
    await s.controller.search('needle');
    assert.equal(s.states.at(-1).status, 'done');
    assert.equal(s.states.at(-1).renderedMatches, 1);
    assert.equal(s.states.at(-1).limited, false);
    s.dom.window.close();
  });
}

test('the shared collection deadline reports timeout rather than incomplete scanning or a protocol error', async () => {
  const s = setup('<p>needle</p>', { mode: 'literal', workerTimeoutMs: 500 });
  let clock = 1000;
  s.w.performance.now = () => clock;
  const collect = s.w.RRTextCollector.collectBatched;
  s.w.RRTextCollector.collectBatched = options => collect({ ...options, onRoot(root, meta) {
    options.onRoot?.(root, meta);
    clock = 1501;
  } });
  await s.controller.search('needle');
  assert.equal(s.states.at(-1).status, 'timeout');
  assert.equal(s.states.at(-1).errorCode, 504);
  assert.equal(s.rendered.length, 0);
  assert.equal(s.controller.isBusy(), false);
  s.dom.window.close();
});

test('frame-only selected text passes the real collection guard and rendering', async () => {
  const s = setup('<iframe></iframe><p>unrelated needle</p>');
  installRealHighlights(s.w);
  const frame = s.w.document.querySelector('iframe');
  const fw = frame.contentWindow;
  fw.document.body.innerHTML = '<p>prefix needle suffix</p>';
  fw.Range.prototype.getClientRects = s.w.Range.prototype.getClientRects;
  fw.Range.prototype.getBoundingClientRect = s.w.Range.prototype.getBoundingClientRect;
  fw.Element.prototype.getClientRects = s.w.Element.prototype.getClientRects;
  fw.Element.prototype.getBoundingClientRect = s.w.Element.prototype.getBoundingClientRect;
  fw.CSS = { highlights: new Map() }; fw.Highlight = class extends Set {};
  const node = fw.document.querySelector('p').firstChild;
  const selection = fw.document.createRange(); selection.setStart(node, 7); selection.setEnd(node, 13);
  await s.controller.search('needle', { scope: 'selection', selection });
  assert.equal(s.states.at(-1).status, 'done');
  assert.equal(s.states.at(-1).renderedMatches, 1);
  assert.equal(s.results.at(-1).marks[0].textContent, 'needle');
  assert.ok(s.roots.includes(fw.document));
  assert.equal(s.roots.includes(s.w.document), false);
  s.controller.dispose(); s.dom.window.close();
});

test('shadow-only selected text passes the real collection guard and rendering', async () => {
  const s = setup('<div id="host"></div><p>unrelated needle</p>');
  installRealHighlights(s.w);
  const root = s.w.document.getElementById('host').attachShadow({ mode: 'open' });
  root.innerHTML = '<p>prefix needle suffix</p>';
  const node = root.querySelector('p').firstChild;
  const selection = s.w.document.createRange(); selection.setStart(node, 7); selection.setEnd(node, 13);
  await s.controller.search('needle', { scope: 'selection', selection });
  assert.equal(s.states.at(-1).status, 'done');
  assert.equal(s.states.at(-1).renderedMatches, 1);
  assert.equal(s.results.at(-1).marks[0].textContent, 'needle');
  assert.ok(s.roots.includes(root));
  assert.equal(s.roots.includes(s.w.document), false);
  s.controller.dispose(); s.dom.window.close();
});
