import assert from "node:assert/strict";
import { readRuntimeSource as readFile } from "../fixtures/runtime_source.mjs";
import test from "node:test";
import vm from "node:vm";

const source = await readFile("background.js", "utf8");

function harness({ loaded = false, failInjection = false, failSettings = false, clock } = {}) {
  const calls = [];
  let messageListener;
  const chrome = {
    runtime: { id: "extension", onConnect: { addListener() {} },
      onMessage: { addListener(listener) { messageListener = listener; } },
      async openOptionsPage() { calls.push({ type: "settings" }); if (failSettings) throw new Error("unavailable"); },
      getURL(path) { return "chrome-extension://extension/" + path; } },
    action: { onClicked: { addListener() {} } },
    commands: { onCommand: { addListener() {} } },
    tabs: {
      async sendMessage(tabId, message, options) { calls.push({ type: "message", tabId, message, options }); return message.action === "regexRabbitPing" ? { loaded } : {}; },
      async query() { return [{ id: 7, url: "https://example.com" }]; }
    },
    scripting: {
      async removeCSS(args) { calls.push({ type: "removeCSS", args }); },
      async insertCSS(args) { calls.push({ type: "insertCSS", args }); },
      async executeScript(args) { calls.push({ type: "executeScript", args }); if (failInjection) throw new Error("injection failed"); }
    }
  };
  const context = vm.createContext({ chrome, URL, console: { warn() {} },
    setTimeout: clock ? clock.setTimeout : setTimeout, clearTimeout: clock ? clock.clearTimeout : clearTimeout });
  vm.runInContext(source + "\n globalThis.api = {isInjectable, injectScripts, sendToggle, toggle, validMessage, routeMessage, connectHost, connectContent};", context);
  return { api: context.api, calls, onMessage: (...args) => messageListener(...args) };
}

test("actual background URL policy accepts permitted schemes and blocks browser/restricted URLs", () => {
  const { api } = harness();
  for (const value of [null, undefined, "", 123, {}, "https:invalid URL", "javascript:alert(1)", "data:text/html,test", "ftp://example.com", "about:blank", "chrome://settings", "edge://settings", "chrome-extension://other/index.html", "https://chrome.google.com/webstore", "https://chrome.google.com/webstore/a", "https://chromewebstore.google.com/detail/a"]) {
    assert.equal(api.isInjectable(value), false, String(value));
  }
  for (const value of ["https://example.com", "http://localhost", "file:///tmp/page.html", "https://chrome.google.com/webstore-example", "https://chromewebstore.google.com.example.com"]) {
    assert.equal(api.isInjectable(value), true, value);
  }
});

test("loaded top-frame content avoids reinjection and repeated stylesheet insertion", async () => {
  const { api, calls } = harness({ loaded: true });
  assert.equal(await api.injectScripts(7), true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ type: "message", tabId: 7, message: { action: "regexRabbitPing" }, options: { frameId: 0 } }]);
});

test("concurrent injection is serialized per tab and includes modules in dependency order", async () => {
  const { api, calls } = harness();
  assert.deepEqual(await Promise.all([api.injectScripts(7), api.injectScripts(7)]), [true, true]);
  const execute = calls.filter(call => call.type === "executeScript");
  assert.equal(execute.length, 1);
  const files = Array.from(execute[0].args.files);
  assert.ok(files.indexOf("domain/runtime_config.js") < files.indexOf("infra/worker_manager.js"));
  assert.ok(files.indexOf("infra/page_visibility.js") < files.indexOf("infra/text_collector.js"));
  assert.equal(files.indexOf("infra/selection_capture.js"), files.indexOf("infra/page_visibility.js") + 1);
  assert.equal(files.indexOf("infra/text_mapping.js"), files.indexOf("infra/text_collector.js") - 1);
  assert.ok(files.indexOf("infra/selection_capture.js") < files.indexOf("infra/search_controller.js"));
  assert.ok(files.indexOf("infra/worker_transport.js") < files.indexOf("infra/worker_manager.js"));
  assert.ok(files.indexOf("infra/dynamic_observer.js") < files.indexOf("infra/search_controller.js"));
  assert.equal(files.at(-1), "content_script.js");
  assert.deepEqual(Array.from(execute[0].args.target.frameIds), [0]);
  assert.equal(calls.filter(call => call.type === "insertCSS").length, 1);
  assert.equal(calls.find(call => call.type === "insertCSS").args.origin, "USER");
  assert.deepEqual(calls.filter(call => call.type === "removeCSS").map(call => call.args.origin), ["AUTHOR", "USER"]);
  assert.ok(calls.findIndex(call => call.type === "removeCSS") < calls.findIndex(call => call.type === "insertCSS"));
});

test("failed injection clears its lock so a retry can run", async () => {
  const { api, calls } = harness({ failInjection: true });
  assert.equal(await api.injectScripts(7), false);
  assert.equal(await api.injectScripts(7), false);
  assert.equal(calls.filter(call => call.type === "executeScript").length, 2);
});

test("toggle addresses only the top frame after successful injection", async () => {
  const { api, calls } = harness();
  await api.toggle();
  const message = calls.find(call => call.type === "message" && call.message.action === "toggleSearch");
  assert.equal(message.tabId, 7);
  assert.equal(message.options.frameId, 0);
});

test("toolbar opens settings only for authenticated top-frame content senders", async () => {
  const { calls, onMessage } = harness();
  const sender = { id: "extension", tab: { id: 7 }, frameId: 0, documentId: "document", url: "https://example.com" };
  for (const invalid of [{}, { ...sender, id: "other" }, { ...sender, frameId: 2 }, { ...sender, documentId: undefined }]) {
    assert.equal(onMessage({ action: "regexRabbitOpenOptions" }, invalid, () => assert.fail("invalid request replied")), false);
  }
  const response = await new Promise(resolve => {
    assert.equal(onMessage({ action: "regexRabbitOpenOptions" }, sender, resolve), true);
  });
  assert.equal(response.ok, true); assert.equal(calls.filter(call => call.type === "settings").length, 1);
});

test("settings-open errors settle with a failure response", async () => {
  const { onMessage } = harness({ failSettings: true });
  const response = await new Promise(resolve => onMessage({ action: "regexRabbitOpenOptions" }, {
    id: "extension", tab: { id: 7 }, frameId: 0, documentId: "document", url: "https://example.com"
  }, resolve));
  assert.equal(response.ok, false);
});

test("authenticated worker routes accept the enlarged query only in the initial message", () => {
  const { api } = harness();
  const client = () => ({ clientId: "test", sequence: 0, awaiting: 0, taskId: null });
  const message = data => ({ kind: "message", clientId: "test", sequence: 1, data });
  const route = client();
  assert.equal(api.validMessage(route, message({ type: "start", taskId: 7, pattern: "x".repeat(4096000), flags: "gi" })), true);
  assert.equal(route.taskId, 7);
  assert.equal(api.validMessage(client(), message({ type: "start", taskId: 7, pattern: "x".repeat(4096001) })), false);
  for (const type of ["chunks", "finish", "cancel"]) {
    assert.equal(api.validMessage(route, message({ type, taskId: 7, pattern: "x", chunks: [] })), false);
  }
  assert.equal(api.validMessage(route, message({ type: "chunks", taskId: 7, chunks: [{ id: 0, text: "x".repeat(16 * 1024 * 1024) }] })), true);
  assert.equal(api.validMessage(route, message({ type: "chunks", taskId: 7, chunks: [{ id: 0, text: "x".repeat(16 * 1024 * 1024 + 1) }] })), false);
});

function fakeClock() {
  let now = 0, next = 0;
  const timers = new Map();
  return {
    timers,
    setTimeout(callback, delay) { const id = ++next; timers.set(id, { callback, delay, due: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(milliseconds) {
      const end = now + milliseconds;
      for (;;) {
        let nextTimer;
        for (const entry of timers) if (entry[1].due <= end && (!nextTimer || entry[1].due < nextTimer[1].due)) nextTimer = entry;
        if (!nextTimer) break;
        now = nextTimer[1].due;
        timers.delete(nextTimer[0]);
        nextTimer[1].callback();
      }
      now = end;
    }
  };
}

function fakePort(sender) {
  const event = () => ({ listeners: new Set(), addListener(listener) { this.listeners.add(listener); },
    removeListener(listener) { this.listeners.delete(listener); }, emit(message) { for (const listener of [...this.listeners]) listener(message); } });
  return { sender, onMessage: event(), onDisconnect: event(), sent: [], disconnected: false,
    postMessage(message) { this.sent.push(structuredClone(message)); },
    disconnect() { this.disconnected = true; this.onDisconnect.emit(); },
    receive(message) { this.onMessage.emit(message); } };
}

test("background validates absolute stream ranges and strips unrelated chunk metadata", () => {
  const { api } = harness();
  const client = { clientId: "test", sequence: 0, awaiting: 0, taskId: 7 };
  const message = stream => ({ kind: "message", clientId: "test", sequence: 1,
    data: { type: "chunks", taskId: 7, chunks: [{ id: 0, text: "abcd", stream }] } });
  const offset = 40 * 1024 * 1024 * 1024;
  const valid = { runId: 0, offset, ownedStart: offset + 1, ownedEnd: offset + 3, first: false, last: true };
  assert.equal(api.validMessage(client, message(valid)), true);
  const invalid = [null, [], {}, { ...valid, runId: -1 }, { ...valid, runId: "1" },
    { ...valid, offset: -1 }, { ...valid, offset: Infinity }, { ...valid, ownedStart: offset - 1 },
    { ...valid, ownedEnd: offset + 5 }, { ...valid, ownedEnd: offset }, { ...valid, first: 1 },
    { ...valid, last: undefined }, { ...valid, ownedEnd: offset + 1.5 },
    { ...valid, offset: Number.MAX_SAFE_INTEGER - 1, ownedStart: Number.MAX_SAFE_INTEGER, ownedEnd: Number.MAX_SAFE_INTEGER }
  ];
  for (const stream of invalid) assert.equal(api.validMessage(client, message(stream)), false, JSON.stringify(stream));
  const data = message({ ...valid, junk: "x".repeat(1000000) }).data;
  data.chunks[0].junk = data.chunks[0].stream.junk;
  assert.deepEqual(structuredClone(api.routeMessage(data).chunks[0]), { id: 0, text: "abcd", stream: valid });
});

test("background starts the enlarged lifetime once and later batches cannot renew it", async () => {
  const clock = fakeClock();
  const { api } = harness({ clock });
  const host = fakePort({ id: "extension", url: "chrome-extension://extension/offscreen.html" });
  const content = fakePort({ id: "extension", tab: { id: 1 }, frameId: 0, documentId: "doc1", url: "https://example.com" });
  api.connectHost(host);
  api.connectContent(content);
  content.receive({ kind: "open", clientId: "test" });
  await Promise.resolve();
  await Promise.resolve();
  const routeId = host.sent.find(message => message.kind === "open").clientId;
  host.receive({ kind: "ready", clientId: routeId });
  assert.deepEqual([...clock.timers.values()].map(timer => timer.delay), [120000]);
  content.receive({ kind: "message", clientId: "test", sequence: 1,
    data: { type: "start", taskId: 7, pattern: "x", workerTimeoutMs: 900000, analyzeInWorker: true, policyStatus: "deferred" } });
  assert.deepEqual([...clock.timers.values()].map(timer => timer.due), [910000]);
  host.receive({ kind: "ack", clientId: routeId, sequence: 1 });
  clock.advance(100000);
  content.receive({ kind: "message", clientId: "test", sequence: 2, data: { type: "chunks", taskId: 7, chunks: [] } });
  host.receive({ kind: "ack", clientId: routeId, sequence: 2 });
  assert.deepEqual([...clock.timers.values()].map(timer => timer.due), [910000], "each batch must not extend the route lifetime");
  clock.advance(809999);
  assert.equal(content.disconnected, false);
  clock.advance(1);
  assert.equal(content.disconnected, true);
  assert.equal(content.sent.at(-1).code, "search-timeout");
  assert.equal(host.sent.at(-1).kind, "close");
});

test("background rejects malformed timeout options without assigning a task identity", () => {
  const { api } = harness();
  const client = () => ({ clientId: "test", sequence: 0, awaiting: 0, taskId: null });
  const message = fields => ({ kind: "message", clientId: "test", sequence: 1, data: { type: "start", taskId: 7, pattern: "x", ...fields } });
  for (const workerTimeoutMs of [0, -1, 1.5, NaN, Infinity, 900001, "900000", null]) {
    const route = client();
    assert.equal(api.validMessage(route, message({ workerTimeoutMs })), false, String(workerTimeoutMs));
    assert.equal(route.taskId, null);
  }
  assert.equal(api.validMessage(client(), message({ analyzeInWorker: "true" })), false);
  assert.equal(api.validMessage(client(), message({ workerTimeoutMs: 900000, analyzeInWorker: false })), true);
  assert.equal(api.validMessage(client(), message({ workerTimeoutMs: 1 })), true, "the remaining time is not raised to a configured minimum");
  const route = { ...client(), taskId: 7 };
  assert.equal(api.validMessage(route, { kind: "message", clientId: "test", sequence: 1,
    data: { type: "chunks", taskId: 7, chunks: [], workerTimeoutMs: 900000 } }), false);
});

test("background discards obsolete chunk and node limits and rejects later start metadata", () => {
  const { api } = harness();
  const data = { type: "start", taskId: 7, pattern: "x", workerTimeoutMs: 1,
    maxChunkMs: 0, maxNodeChars: "obsolete", maxScannedNodes: 1, extra: "x".repeat(1000000) };
  assert.deepEqual(structuredClone(api.routeMessage(data)), { type: "start", taskId: 7, pattern: "x", workerTimeoutMs: 1 });
  const client = { clientId: "test", sequence: 0, awaiting: 0, taskId: 7 };
  for (const changed of [{ flags: "i" }, { mode: "literal" }, { maxScannedChars: 1 }, { acknowledged: true }, { analyzeInWorker: true }]) {
    assert.equal(api.validMessage(client, { kind: "message", clientId: "test", sequence: 1,
      data: { type: "chunks", taskId: 7, chunks: [], ...changed } }), false, JSON.stringify(changed));
  }
});

test("background content handshake remains bounded at nine seconds", () => {
  const clock = fakeClock();
  const { api } = harness({ clock });
  const content = fakePort({ id: "extension", tab: { id: 1 }, frameId: 0, documentId: "doc1", url: "https://example.com" });
  api.connectContent(content);
  clock.advance(8999);
  assert.equal(content.disconnected, false);
  clock.advance(1);
  assert.equal(content.disconnected, true);
  assert.equal(content.sent.at(-1).code, "worker-spawn-failed");
});

test("background validates and sanitizes four-field complete-source fragments", () => {
  const { api } = harness();
  const client = { clientId: "test", sequence: 0, awaiting: 0, taskId: 7 };
  const message = source => ({ kind: "message", clientId: "test", sequence: 1,
    data: { type: "chunks", taskId: 7, chunks: [{ id: 3, text: "abcd", source }] } });
  const valid = { runId: 3, offset: 0, first: true, last: false };
  assert.equal(api.validMessage(client, message(valid)), true);
  const invalid = [null, [], {}, "source", { ...valid, runId: -1 }, { ...valid, runId: "3" },
    { ...valid, runId: 4 }, { ...valid, offset: 1 }, { ...valid, offset: -1 },
    { ...valid, offset: 1.5 }, { ...valid, first: 1 }, { ...valid, last: undefined },
    { ...valid, first: false, offset: Infinity }, { ...valid, first: false, offset: Number.MAX_SAFE_INTEGER - 1 }];
  for (const source of invalid) assert.equal(api.validMessage(client, message(source)), false, JSON.stringify(source));
  const conflict = message(valid);
  conflict.data.chunks[0].stream = { runId: 3, offset: 0, ownedStart: 0, ownedEnd: 4, first: true, last: true };
  assert.equal(api.validMessage(client, conflict), false);
  const offset = 40 * 1024 * 1024 * 1024;
  assert.equal(api.validMessage(client, message({ runId: 3, offset, first: false, last: true })), true);
  const data = message({ ...valid, junk: "x".repeat(1000000) }).data;
  data.chunks[0].junk = data.chunks[0].source.junk;
  assert.deepEqual(structuredClone(api.routeMessage(data).chunks[0]), { id: 3, text: "abcd", source: valid });
});

test("seven authenticated tabs can queue independent routes and finish without an admission cap", async () => {
  const clock = fakeClock();
  const { api } = harness({ clock });
  const host = fakePort({ id: "extension", url: "chrome-extension://extension/offscreen.html" });
  api.connectHost(host);
  const contents = Array.from({ length: 7 }, (_, index) => fakePort({ id: "extension", tab: { id: index + 1 },
    frameId: 0, documentId: "doc" + (index + 1), url: "https://example.com/page" + (index + 1) }));
  contents.forEach((content, index) => {
    api.connectContent(content);
    content.receive({ kind: "open", clientId: "query-" + index });
  });
  await Promise.resolve();
  await Promise.resolve();
  const routes = host.sent.filter(message => message.kind === "open");
  assert.equal(routes.length, 7, "every authenticated tab is admitted for offscreen scheduling");
  assert.equal(new Set(routes.map(message => message.clientId)).size, 7);
  routes.forEach((route, index) => {
    // The offscreen scheduler acknowledges the route while its actual Worker
    // may be queued. Its own concurrency limit does not reject this route.
    host.receive({ kind: "ready", clientId: route.clientId });
    assert.equal(contents[index].sent.at(-1).kind, "ready");
    contents[index].receive({ kind: "message", clientId: "query-" + index, sequence: 1,
      data: { type: "start", taskId: index + 1, pattern: "needle-" + index, workerTimeoutMs: 30000 } });
  });
  const starts = host.sent.filter(message => message.kind === "message" && message.data.type === "start");
  assert.equal(starts.length, 7);
  clock.advance(10000);
  assert.ok(contents.every(content => !content.disconnected), "queued routes survive the original nine-second handshake window after ready");
  assert.ok(contents.every(content => !content.sent.some(message => message.kind === "failure")), "excess routes must not receive worker-busy");
  routes.forEach((route, index) => {
    host.receive({ kind: "ack", clientId: route.clientId, sequence: 1 });
    contents[index].receive({ kind: "message", clientId: "query-" + index, sequence: 2,
      data: { type: "chunks", taskId: index + 1, batchId: 0, chunks: [{ id: 0, text: "needle-" + index }] } });
    const forwarded = host.sent.at(-1);
    assert.equal(forwarded.clientId, route.clientId);
    assert.equal(forwarded.data.chunks[0].text, "needle-" + index);
    host.receive({ kind: "ack", clientId: route.clientId, sequence: 2 });
    contents[index].receive({ kind: "message", clientId: "query-" + index, sequence: 3,
      data: { type: "finish", taskId: index + 1 } });
    host.receive({ kind: "ack", clientId: route.clientId, sequence: 3 });
    host.receive({ kind: "message", clientId: route.clientId,
      data: { type: "complete", taskId: index + 1, matches: [{ chunkId: 0, start: 0, end: 8 }], totalMatches: 1 } });
    assert.equal(contents[index].sent.at(-1).data.type, "complete");
    assert.equal(contents[index].onMessage.listeners.size, 0, "finished routes release their content listener");
    assert.equal(host.sent.at(-1).kind, "close");
  });
  assert.deepEqual([...clock.timers.values()].map(timer => timer.delay), [15000], "all route timers are released; only host idle cleanup remains");
});

test("disconnecting one of several queued tabs releases only its own route", async () => {
  const clock = fakeClock();
  const { api } = harness({ clock });
  const host = fakePort({ id: "extension", url: "chrome-extension://extension/offscreen.html" });
  api.connectHost(host);
  const contents = Array.from({ length: 6 }, (_, index) => fakePort({ id: "extension", tab: { id: index + 1 },
    frameId: 0, documentId: "doc" + (index + 1), url: "https://example.com" }));
  contents.forEach((content, index) => {
    api.connectContent(content);
    content.receive({ kind: "open", clientId: "query-" + index });
  });
  await Promise.resolve();
  await Promise.resolve();
  const routes = host.sent.filter(message => message.kind === "open");
  routes.forEach(route => host.receive({ kind: "ready", clientId: route.clientId }));
  contents[4].disconnect();
  assert.equal(host.sent.at(-1).kind, "close");
  assert.equal(host.sent.at(-1).clientId, routes[4].clientId);
  assert.equal(contents[4].onMessage.listeners.size, 0);
  assert.equal(clock.timers.size, 5);
  host.receive({ kind: "ready", clientId: routes[4].clientId });
  assert.equal(clock.timers.size, 5, "a late queued ready cannot revive the cancelled route");
  contents[5].receive({ kind: "message", clientId: "query-5", sequence: 1,
    data: { type: "start", taskId: 7, pattern: "still-valid", workerTimeoutMs: 30000 } });
  assert.equal(host.sent.at(-1).data.pattern, "still-valid");
  contents.forEach(content => { if (!content.disconnected) content.disconnect(); });
  assert.deepEqual([...clock.timers.values()].map(timer => timer.delay), [15000]);
});
