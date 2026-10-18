import assert from "node:assert/strict";
import { readRuntimeSource as readFile } from "../fixtures/runtime_source.mjs";
import { test as nodeTest } from "node:test";
import { createContext, runInContext } from "node:vm";
import { Worker as ThreadWorker } from "node:worker_threads";
import { JSDOM } from "jsdom";

const filenames = ["background.js", "offscreen.js", "infra/worker_transport.js", "infra/worker_manager.js", "infra/page_visibility.js", "infra/text_collector.js", "domain/pattern_analyzer.js", "domain/literal_matcher.js", "search_worker.js"];
const sources = Object.fromEntries(await Promise.all(filenames.map(async filename => [
  filename, await readFile(new URL(`../../${filename}`, import.meta.url), "utf8")
])));
const extensionId = "test-extension";
const extensionURL = filename => `chrome-extension://${extensionId}/${filename}`;
const contentSender = (tabId = 1) => ({
  id: extensionId, tab: { id: tabId }, frameId: 0,
  documentId: `doc${tabId}`, url: "https://example.com"
});
const hostSender = { id: extensionId, url: extensionURL("offscreen.html") };
const tick = () => new Promise(resolve => setImmediate(resolve));
const test = (name, body) => nodeTest(name, { timeout: 10000 }, body);

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

async function waitFor(predicate, description, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

class ChromeEvent {
  listeners = new Set();
  addListener(listener) { this.listeners.add(listener); }
  removeListener(listener) { this.listeners.delete(listener); }
  emit(...args) { for (const listener of [...this.listeners]) listener(...args); }
}

// All extension contexts execute their production sources. Only Chrome ports,
// offscreen document creation and the Web Worker/worker_threads boundary are mocked.
function fixture(options = {}) {
  const contexts = [];
  const timers = new Set();
  const pairs = [];
  const workers = [];
  const log = [];
  const managers = [];
  const onConnect = new ChromeEvent();
  let offscreenMessages = null;
  let documentExists = false;
  let creates = 0;
  let closes = 0;
  let contextCalls = 0;
  let createActive = 0;
  let maxConcurrentCreates = 0;
  let maxLiveWorkers = 0;
  let createError = options.createError;
  let contextsError = options.contextsError;

  function timerFunctions(owner) {
    function register(callback, delay, args, interval) {
      const entry = { owner, callback, delay, args, interval, handle: null };
      const run = () => {
        if (!interval) timers.delete(entry);
        callback(...args);
      };
      entry.handle = options.deferContentTimeouts && owner.startsWith("content-") && !interval ? null :
        interval ? setInterval(run, delay) : setTimeout(run, delay);
      timers.add(entry);
      return entry;
    }
    function clear(entry) {
      if (!entry) return;
      timers.delete(entry);
      if (entry.interval) clearInterval(entry.handle);
      else clearTimeout(entry.handle);
    }
    return {
      setTimeout: (callback, delay = 0, ...args) => register(callback, delay, args, false),
      setInterval: (callback, delay = 0, ...args) => register(callback, delay, args, true),
      clearTimeout: clear,
      clearInterval: clear
    };
  }

  function connect(name, sender, role) {
    const state = { disconnected: false };
    const makePort = side => ({
      name, sender: side === "background" ? sender : undefined,
      onMessage: new ChromeEvent(), onDisconnect: new ChromeEvent(),
      get disconnected() { return state.disconnected; },
      postMessage(message) {
        if (state.disconnected) throw new Error("Attempting to use a disconnected port object");
        const data = structuredClone(message);
        log.push({ role, side, pair, data });
        const other = side === "background" ? pair.client : pair.background;
        // Chrome preserves queued message order ahead of the disconnect event.
        queueMicrotask(() => other.onMessage.emit(data, other));
      },
      disconnect() {
        if (state.disconnected) return;
        state.disconnected = true;
        queueMicrotask(() => {
          pair.client.onDisconnect.emit(pair.client);
          pair.background.onDisconnect.emit(pair.background);
        });
      }
    });
    const pair = { role, sender, state, client: makePort("client"), background: makePort("background") };
    pairs.push(pair);
    queueMicrotask(() => onConnect.emit(pair.background));
    return pair.client;
  }

  const adaptedWorker = `
    const { parentPort } = require("node:worker_threads");
    const { performance } = require("node:perf_hooks");
    parentPort.on("message", message => {
      if (message && message.__relayTestCrash) throw new Error("Injected worker process crash");
    });
    const self = {
      postMessage(message) { parentPort.postMessage(message); },
      set onmessage(listener) { parentPort.on("message", data => listener({ data })); }
    };
    ${sources["domain/pattern_analyzer.js"]}
    ${sources["domain/literal_matcher.js"]}
    ${sources["search_worker.js"]}
  `;

  class BrowserWorker {
    constructor(url) {
      assert.equal(url, extensionURL("search_worker.js"));
      this.terminated = false;
      this.sent = [];
      this.received = [];
      this.thread = new ThreadWorker(adaptedWorker, { eval: true });
      this.exited = new Promise(resolve => this.thread.once("exit", resolve));
      workers.push(this);
      maxLiveWorkers = Math.max(maxLiveWorkers, workers.filter(worker => !worker.terminated).length);
      this.thread.on("message", data => {
        this.received.push(structuredClone(data));
        if (!this.terminated && this.onmessage) this.onmessage({ data });
      });
      this.thread.on("error", error => {
        if (!this.terminated && this.onerror) this.onerror({ message: error.message, error });
      });
    }
    postMessage(data) {
      assert.equal(this.terminated, false, "relay must not post after terminating its worker");
      this.sent.push(structuredClone(data));
      this.thread.postMessage(data);
    }
    terminate() {
      if (this.terminated) return;
      this.terminated = true;
      this.thread.terminate();
    }
  }

  function scope(owner, chrome, extra = {}) {
    const context = createContext({
      chrome, console, URL, AbortController, performance: owner === "offscreen" && options.offscreenClock ? { now: options.offscreenClock } : performance,
      ...timerFunctions(owner), ...extra
    });
    contexts.push(context);
    return context;
  }

  function runOffscreen() {
    offscreenMessages = new ChromeEvent();
    const context = scope("offscreen", {
      runtime: {
        id: extensionId, getURL: extensionURL, onMessage: offscreenMessages,
        connect: ({ name }) => connect(name, hostSender, "host")
      }
    }, { Worker: BrowserWorker });
    runInContext(sources["offscreen.js"], context, { filename: "offscreen.js" });
  }

  async function closeDocument() {
    const attempt = ++closes;
    if (options.closeGate) await options.closeGate.promise;
    if (options.closeGates?.[attempt - 1]) await options.closeGates[attempt - 1].promise;
    documentExists = false;
    for (const pair of pairs.filter(pair => pair.role === "host" && !pair.state.disconnected)) pair.client.disconnect();
    await tick();
  }

  const background = scope("background", {
    runtime: {
      id: extensionId, getURL: extensionURL, onConnect,
      getContexts: async () => {
        const attempt = ++contextCalls;
        if (contextsError) throw contextsError;
        const found = documentExists ? [{ contextType: "OFFSCREEN_DOCUMENT", documentUrl: extensionURL("offscreen.html") }] : [];
        if (attempt === 1 && options.firstContextsGate) await options.firstContextsGate.promise;
        return found;
      },
      sendMessage: async message => offscreenMessages?.emit(message, { id: extensionId })
    },
    offscreen: {
      async createDocument(params) {
        assert.equal(params.url, "offscreen.html");
        assert.deepEqual(Array.from(params.reasons), ["WORKERS"]);
        const attempt = ++creates;
        maxConcurrentCreates = Math.max(maxConcurrentCreates, ++createActive);
        try {
          if (attempt === 1 && options.firstCreateGate) await options.firstCreateGate.promise;
          if (options.createGate) await options.createGate.promise;
          if (createError) throw createError;
          assert.equal(documentExists, false, "createDocument calls must be serialized");
          documentExists = true;
          runOffscreen();
          if (attempt === 1 && options.firstCreateCompletionGate) await options.firstCreateCompletionGate.promise;
        } finally { createActive--; }
      },
      closeDocument
    },
    action: { onClicked: new ChromeEvent() },
    commands: { onCommand: new ChromeEvent() },
    tabs: { sendMessage: async () => null, query: async () => [] },
    scripting: { removeCSS: async () => {}, insertCSS: async () => {}, executeScript: async () => {} }
  });
  runInContext(sources["background.js"], background, { filename: "background.js" });

  return {
    workers, pairs, log, timers, background,
    get creates() { return creates; },
    get closes() { return closes; },
    get contextCalls() { return contextCalls; },
    get maxConcurrentCreates() { return maxConcurrentCreates; },
    get clientCount() { return runInContext("clients.size", background); },
    get liveWorkerCount() { return workers.filter(worker => !worker.terminated).length; },
    get maxLiveWorkerCount() { return maxLiveWorkers; },
    client(sender = contentSender(), { fixedIdentity = false } = {}) {
      const extra = {
        // The production manager must use the offscreen transport without fetching
        // source or attempting a page Worker, whose creation can be blocked by CSP.
        fetch() { throw new Error("Unexpected page fetch"); },
        Worker: class { constructor() { throw new Error("Unexpected page Worker"); } }
      };
      if (fixedIdentity) {
        extra.Date = class extends Date { static now() { return 1700000000000; } };
        extra.Math = Object.assign(Object.create(Math), { random: () => 0.5 });
      }
      const context = scope(`content-${sender.tab?.id}`, {
        runtime: { connect: ({ name }) => connect(name, sender, "content") }
      }, extra);
      runInContext(sources["infra/worker_transport.js"], context, { filename: "infra/worker_transport.js" });
      runInContext(sources["infra/worker_manager.js"], context, { filename: "infra/worker_manager.js" });
      managers.push(context.RRWorkerManager);
      return { transport: context.RRWorkerTransport, manager: context.RRWorkerManager };
    },
    rawPort(sender, name = "regex-rabbit-worker-v1") {
      return connect(name, sender, name === "regex-rabbit-offscreen-v1" ? "host" : "content");
    },
    clearCreateError() { createError = null; },
    clearContextsError() { contextsError = null; },
    crashOffscreen() {
      documentExists = false;
      const pair = pairs.findLast(pair => pair.role === "host" && !pair.state.disconnected);
      assert.ok(pair, "offscreen host must be connected before simulating its crash");
      pair.client.disconnect();
    },
    fireTimeout(owner, delay, callbackText) {
      const entry = [...timers].find(entry => entry.owner === owner && entry.delay === delay && !entry.interval &&
        (!callbackText || entry.callback.toString().includes(callbackText)));
      assert.ok(entry, `expected a ${delay} ms ${owner} timeout`);
      clearTimeout(entry.handle);
      timers.delete(entry);
      entry.callback(...entry.args);
    },
    async dispose() {
      for (const manager of managers) manager.dispose();
      for (const pair of pairs) pair.client.disconnect();
      await tick();
      for (const worker of workers) worker.terminate();
      await Promise.all(workers.map(worker => worker.exited));
      for (const entry of timers) {
        if (entry.interval) clearInterval(entry.handle);
        else clearTimeout(entry.handle);
      }
      timers.clear();
    }
  };
}

function useFixture(t, options) {
  const h = fixture(options);
  t.after(() => h.dispose());
  return h;
}

function fromHost(h, kind) {
  return h.log.filter(entry => entry.role === "host" && entry.side === "client" && (!kind || entry.data.kind === kind));
}

async function assertWorkersReleased(h) {
  await waitFor(() => h.clientCount === 0 && h.liveWorkerCount === 0, "client and worker cleanup");
  await Promise.all(h.workers.map(worker => worker.exited));
  assert.equal([...h.timers].filter(entry => entry.interval).length, 0, "idle hosts must stop their heartbeat");
}

test("manager streams real batches through the authenticated offscreen relay and receives sequence and batch ACKs", async t => {
  const h = useFixture(t);
  const { manager } = h.client();
  manager.updateConfig({ batchSize: 2, maxBatchChars: 20 });
  const result = await manager.searchStream(0, "rabbit", "gi", async (send, keepGoing) => {
    assert.equal(keepGoing(), true);
    assert.equal(await send([{ id: 7, text: "Rabbit rabbit" }, { id: 8, text: "no match" }]), 2);
    assert.equal(await send([{ id: 9, text: "rabbit" }]), 1);
  }, { status: "safe" });
  assert.equal(result.type, "complete");
  assert.equal(result.taskId, 0);
  assert.equal(result.totalMatches, 3);
  assert.equal(result.scannedNodes, 3);
  assert.deepEqual(result.matches, [
    { chunkId: 7, start: 0, end: 6 }, { chunkId: 7, start: 7, end: 13 },
    { chunkId: 9, start: 0, end: 6 }
  ]);
  assert.equal(h.creates, 1);
  const sent = h.workers[0].sent;
  assert.deepEqual(sent.map(message => message.type), ["start", "chunks", "chunks", "chunks", "finish"]);
  assert.deepEqual(sent.map(message => message.sequence), [1, 2, 3, 4, 5]);
  assert.deepEqual(fromHost(h, "ack").map(entry => entry.data.sequence), [1, 2, 3, 4, 5]);
  assert.deepEqual(fromHost(h, "message").filter(entry => entry.data.data.type === "ack").map(entry => entry.data.data.batchId), [1, 2, 3]);
  const terminal = fromHost(h).findIndex(entry => entry.data.data?.type === "complete");
  const finishAck = fromHost(h).findIndex(entry => entry.data.kind === "ack" && entry.data.sequence === 5);
  assert.ok(finishAck >= 0 && finishAck < terminal, "finish delivery ACK must precede terminal result");
  await assertWorkersReleased(h);
});

test("the relay accepts the worker protocol's 2000-node maximum batch without imposing a narrower limit", async t => {
  const h = useFixture(t);
  const adapter = await h.client().transport.create();
  const completed = deferred();
  adapter.onmessage = event => { if (event.data.type === "complete") completed.resolve(event.data); };
  const nodes = Array.from({ length: 2000 }, (_, id) => ({ id, text: "hay" }));
  await adapter.postMessage({ type: "start", taskId: 1, pattern: "needle", flags: "g", acknowledged: true, maxBatchNodes: 2000 });
  await adapter.postMessage({ type: "chunks", taskId: 1, batchId: 1, chunks: nodes });
  await adapter.postMessage({ type: "finish", taskId: 1 });
  const result = await completed.promise;
  assert.equal(result.scannedNodes, 2000);
  assert.equal(h.workers[0].sent.filter(message => message.type === "chunks").length, 1);
  adapter.terminate();
  await assertWorkersReleased(h);
});

test("two concurrent transport sends are serialized through one in-flight sequence with bounded backpressure", async t => {
  const h = useFixture(t);
  const adapter = await h.client().transport.create();
  const completed = deferred();
  adapter.onmessage = event => { if (event.data.type === "complete") completed.resolve(event.data); };
  const first = adapter.postMessage({ type: "start", taskId: 1, pattern: "x", flags: "g" });
  const second = adapter.postMessage({ type: "chunks", taskId: 1, chunks: [{ id: 0, text: "x x" }] });
  await assert.rejects(adapter.postMessage({ type: "finish", taskId: 1 }), { code: "worker-backpressure" });
  await Promise.all([first, second]);
  assert.deepEqual(h.workers[0].sent.map(message => message.sequence), [1, 2]);
  assert.deepEqual(fromHost(h, "ack").map(entry => entry.data.sequence), [1, 2]);
  await adapter.postMessage({ type: "finish", taskId: 1 });
  assert.equal((await completed.promise).totalMatches, 2);
  adapter.terminate();
  await assertWorkersReleased(h);
});

test("early match-limit completion delivers batch and sequence ACKs before settling and stopping the producer", async t => {
  const h = useFixture(t);
  const { manager } = h.client();
  manager.updateConfig({ maxMatches: 1, batchSize: 1 });
  let settled = 0;
  const result = await manager.searchStream(1, "a", "g", async (send, keepGoing) => {
    await send([{ id: 0, text: "aaa" }]);
    assert.equal(keepGoing(), false);
    assert.equal(await send([{ id: 1, text: "aaa" }]), 0);
  }).then(value => { settled++; return value; });
  assert.equal(settled, 1);
  assert.equal(result.totalMatches, 1);
  assert.equal(result.limitReason, "max-matches");
  assert.deepEqual(h.workers[0].sent.map(message => message.type), ["start", "chunks"]);
  const raw = h.workers[0].received;
  assert.ok(raw.findIndex(message => message.type === "complete") < raw.findIndex(message => message.sequence === 2), "real worker emits terminal before the final sequence ACK");
  const host = fromHost(h);
  assert.ok(host.findIndex(entry => entry.data.kind === "ack" && entry.data.sequence === 2) < host.findIndex(entry => entry.data.data?.type === "complete"), "offscreen must buffer terminal until the final sequence ACK");
  await assertWorkersReleased(h);
});

test("early completion settles a queued finish immediately without reporting a later transport error", async t => {
  const h = useFixture(t);
  const adapter = await h.client().transport.create();
  const completed = deferred();
  const errors = [];
  adapter.onmessage = event => { if (event.data.type === "complete") completed.resolve(event.data); };
  adapter.onerror = event => errors.push(event.error.code);
  await adapter.postMessage({ type: "start", taskId: 1, pattern: "a", flags: "g", maxMatches: 1 });
  const batch = adapter.postMessage({ type: "chunks", taskId: 1, chunks: [{ id: 0, text: "aa" }] });
  let finishResult = null;
  const finish = adapter.postMessage({ type: "finish", taskId: 1 }).then(
    () => { finishResult = "acknowledged"; },
    error => { finishResult = error.code; }
  );
  await batch;
  assert.equal((await completed.promise).totalMatches, 1);
  await tick();
  assert.equal(finishResult, "worker-disconnected", "the terminal response must settle the undelivered finish");
  await finish;
  assert.deepEqual(errors, []);
  assert.deepEqual(h.workers[0].sent.map(message => message.type), ["start", "chunks"]);
  assert.equal([...h.timers].filter(entry => entry.owner === "content-1" && entry.delay === 9000).length, 0);
  await assert.rejects(adapter.postMessage({ type: "finish", taskId: 1 }), { code: "worker-disconnected" });
  await assertWorkersReleased(h);
});

test("worker syntax and unsafe-pattern errors survive the full relay without waiting for a missing sequence ACK", async t => {
  for (const [pattern, policy, code, numericCode] of [
    ["[bad", { status: "safe" }, "pattern-invalid-syntax", 400],
    ["(a+)+$", { status: "unsafe" }, "engine-unsafe-fallback-blocked", 452]
  ]) {
    const h = useFixture(t);
    const { manager } = h.client();
    await assert.rejects(manager.search(2, pattern, "g", [{ id: 0, text: "aaa" }], policy), error => error.code === code && error.numericCode === numericCode);
    assert.deepEqual(h.workers[0].sent.map(message => message.type), ["start"]);
    assert.equal(fromHost(h, "ack")[0].data.sequence, 1);
    assert.equal(fromHost(h, "message")[0].data.data.type, "error");
    await assertWorkersReleased(h);
  }
});

test("tabs with identical task and transport identities stay isolated throughout concurrent searches", async t => {
  const h = useFixture(t);
  const first = h.client(contentSender(1), { fixedIdentity: true });
  const second = h.client(contentSender(2), { fixedIdentity: true });
  const [one, two] = await Promise.all([
    first.manager.search(3, "one", "g", [{ id: 10, text: "one one" }]),
    second.manager.search(3, "two", "g", [{ id: 20, text: "two" }])
  ]);
  const opened = h.log.filter(entry => entry.role === "content" && entry.side === "client" && entry.data.kind === "open");
  assert.equal(opened[0].data.clientId, opened[1].data.clientId, "fixture must exercise a real client identity collision across tabs");
  assert.equal(one.totalMatches, 2);
  assert.equal(two.totalMatches, 1);
  assert.deepEqual(one.matches.map(match => match.chunkId), [10, 10]);
  assert.deepEqual(two.matches.map(match => match.chunkId), [20]);
  assert.equal(h.creates, 1);
  await assertWorkersReleased(h);
});

test("all tabs become ready and queued starts acquire the four Worker slots in FIFO order", async t => {
  const createGate = deferred();
  const h = useFixture(t, { createGate });
  t.after(() => createGate.resolve());
  const clients = Array.from({ length: 6 }, (_, i) => h.client(contentSender(i + 1)));
  const creating = clients.map(client => client.transport.create());
  await waitFor(() => h.creates === 1 && h.clientCount === 6, "six clients sharing a pending offscreen creation");
  assert.equal(h.maxConcurrentCreates, 1);
  assert.equal(h.creates, 1);
  createGate.resolve();
  const adapters = await Promise.all(creating);
  assert.equal(h.liveWorkerCount, 0, "ready routes must not reserve idle Workers");
  const started = adapters.map((adapter, index) => adapter.postMessage({ type: "start", taskId: index + 1, pattern: "x", flags: "g" }));
  await Promise.all(started.slice(0, 4));
  assert.equal(h.liveWorkerCount, 4);
  assert.equal(h.workers.length, 4);
  await adapters[0].postMessage({ type: "finish", taskId: 1 });
  await started[4];
  assert.equal(h.workers[4].sent[0].taskId, 5);
  await adapters[1].postMessage({ type: "finish", taskId: 2 });
  await started[5];
  assert.equal(h.workers[5].sent[0].taskId, 6);
  assert.ok(h.workers[4].sent[0].workerTimeoutMs < 5000, "the queued start must subtract its wait");
  assert.equal(h.liveWorkerCount, 4);
  assert.equal(h.creates, 1);
  await Promise.all(adapters.slice(2).map((adapter, index) => adapter.postMessage({ type: "finish", taskId: index + 3 })));
  await assertWorkersReleased(h);
  assert.equal(h.maxLiveWorkerCount, 4);
});

test("a queued query expires at its original deadline without spawning and the following query can proceed", async t => {
  let clock = 0;
  const h = useFixture(t, { offscreenClock: () => clock, deferContentTimeouts: true });
  const adapters = await Promise.all(Array.from({ length: 6 }, (_, index) => h.client(contentSender(index + 1)).transport.create()));
  await Promise.all(adapters.slice(0, 4).map((adapter, index) => adapter.postMessage({ type: "start", taskId: index + 1, pattern: "x", flags: "g", workerTimeoutMs: 100000 })));
  const queued = adapters[4].postMessage({ type: "start", taskId: 5, pattern: "x", flags: "g", workerTimeoutMs: 33333 });
  const rejected = assert.rejects(queued, { code: "search-timeout", numericCode: 504 });
  const timeout = deferred();
  adapters[4].onmessage = event => { if (event.data.type === "error") timeout.resolve(event.data); };
  const following = adapters[5].postMessage({ type: "start", taskId: 6, pattern: "x", flags: "g", workerTimeoutMs: 100000 });
  await waitFor(() => [...h.timers].some(entry => entry.owner === "offscreen" && entry.delay === 33333), "queued query timer");
  assert.equal(h.workers.length, 4);
  clock = 40000;
  h.fireTimeout("offscreen", 33333);
  assert.equal((await timeout.promise).numericCode, 504);
  await rejected;
  assert.equal(h.workers.length, 4, "an expired queued task must never create a Worker");
  await adapters[0].postMessage({ type: "finish", taskId: 1 });
  await following;
  assert.equal(h.workers[4].sent[0].taskId, 6);
  assert.equal(h.workers[4].sent[0].workerTimeoutMs, 60000);
  assert.equal(h.maxLiveWorkerCount, 4);
  for (const adapter of adapters) adapter.terminate();
  await assertWorkersReleased(h);
});

test("Manager cancellation removes a queued start without admitting it or disturbing the next page", async t => {
  const h = useFixture(t);
  const blockers = await Promise.all(Array.from({ length: 4 }, (_, index) => h.client(contentSender(index + 1)).transport.create()));
  await Promise.all(blockers.map((adapter, index) => adapter.postMessage({ type: "start", taskId: index + 1, pattern: "x", flags: "g" })));
  const cancelledClient = h.client(contentSender(5)), nextClient = h.client(contentSender(6));
  let cancelledProducer = false, nextProducer = false, proceed;
  const canProceed = new Promise(resolve => { proceed = resolve; });
  const cancelled = cancelledClient.manager.searchStream(5, "x", "g", async send => {
    cancelledProducer = true;
    await send([{ id: 0, text: "x" }]);
  });
  const rejected = assert.rejects(cancelled, { code: "search-cancelled" });
  const next = nextClient.manager.searchStream(6, "x", "g", async send => {
    nextProducer = true;
    await canProceed;
    await send([{ id: 0, text: "x" }]);
  });
  await waitFor(() => h.clientCount === 6 && h.log.filter(entry => entry.role === "host" && entry.side === "background" && entry.data.data?.type === "start").length === 6, "two queued start messages");
  assert.equal(h.workers.length, 4);
  cancelledClient.manager.cancel(5);
  await rejected;
  await waitFor(() => h.clientCount === 5, "cancelled queued route cleanup");
  assert.equal(cancelledProducer, false);
  await blockers[0].postMessage({ type: "finish", taskId: 1 });
  await waitFor(() => nextProducer, "following queued producer admission");
  assert.equal(h.workers[4].sent[0].taskId, 6);
  proceed();
  assert.equal((await next).totalMatches, 1);
  for (const adapter of blockers) adapter.terminate();
  await assertWorkersReleased(h);
  assert.equal(h.maxLiveWorkerCount, 4);
});

test("foreign extensions, subframes, missing document identities and restricted pages cannot create search hosts", async t => {
  const h = useFixture(t);
  for (const sender of [
    { ...contentSender(), id: "other-extension" },
    { ...contentSender(), frameId: 1 },
    { ...contentSender(), documentId: "" },
    { ...contentSender(), documentId: undefined },
    { ...contentSender(), url: "chrome://settings" },
    { ...contentSender(), url: "https://chromewebstore.google.com/detail/app" },
    { ...contentSender(), tab: undefined }
  ]) await assert.rejects(h.client(sender).transport.create(), { code: "worker-busy" });
  assert.equal(h.creates, 0);
  assert.equal(h.clientCount, 0);
  assert.equal(h.workers.length, 0);
});

test("spoofed offscreen connections are rejected before a genuine host connects", async t => {
  const h = useFixture(t);
  for (const sender of [
    { ...hostSender, id: "other-extension" },
    { ...hostSender, url: extensionURL("options.html") },
    { ...hostSender, tab: { id: 1 } }
  ]) {
    const port = h.rawPort(sender, "regex-rabbit-offscreen-v1");
    await tick();
    assert.equal(port.disconnected, true);
  }
  const { manager } = h.client();
  const result = await manager.search(1, "valid", "g", [{ id: 0, text: "valid" }]);
  assert.equal(result.totalMatches, 1);
  await assertWorkersReleased(h);
});

test("a duplicate authenticated host connection is rejected without interrupting the current worker", async t => {
  const h = useFixture(t);
  const adapter = await h.client().transport.create();
  await adapter.postMessage({ type: "start", taskId: 1, pattern: "x", flags: "g" });
  const duplicate = h.rawPort(hostSender, "regex-rabbit-offscreen-v1");
  await tick();
  assert.equal(duplicate.disconnected, true);
  assert.equal(h.clientCount, 1);
  assert.equal(h.liveWorkerCount, 1);
  const completed = deferred();
  adapter.onmessage = event => { if (event.data.type === "complete") completed.resolve(event.data); };
  await adapter.postMessage({ type: "chunks", taskId: 1, chunks: [{ id: 0, text: "x" }] });
  await adapter.postMessage({ type: "finish", taskId: 1 });
  assert.equal((await completed.promise).totalMatches, 1);
  adapter.terminate();
  await assertWorkersReleased(h);
});

test("changing task identity is rejected before the malformed message reaches the worker", async t => {
  const h = useFixture(t);
  const adapter = await h.client().transport.create();
  await adapter.postMessage({ type: "start", taskId: 7, pattern: "x", flags: "g" });
  const errors = [];
  adapter.onerror = event => errors.push(event.error.code);
  await assert.rejects(adapter.postMessage({ type: "chunks", taskId: 8, chunks: [{ id: 0, text: "x" }] }), { code: "worker-protocol-error" });
  assert.deepEqual(errors, ["worker-protocol-error"]);
  assert.deepEqual(h.workers[0].sent.map(message => message.type), ["start"]);
  await assertWorkersReleased(h);
});

test("transport rejects oversized and malformed chunks before serialization while leaving the current route usable", async t => {
  const h = useFixture(t);
  for (const chunks of [
    [{ id: 0, text: "x".repeat(16 * 1024 * 1024 + 1) }],
    Array.from({ length: 2001 }, (_, id) => ({ id, text: "" })),
    [{ id: -1, text: "x" }], [{ id: 0, text: 1 }]
  ]) {
    const adapter = await h.client().transport.create();
    await adapter.postMessage({ type: "start", taskId: 1, pattern: "x", flags: "g" });
    const worker = h.workers.at(-1);
    const envelopeCount = h.log.filter(entry => entry.role === "content" && entry.side === "client" && entry.data.kind === "message").length;
    await assert.rejects(adapter.postMessage({ type: "chunks", taskId: 1, chunks }), { code: "worker-protocol-error" });
    assert.equal(h.log.filter(entry => entry.role === "content" && entry.side === "client" && entry.data.kind === "message").length, envelopeCount);
    assert.deepEqual(worker.sent.map(message => message.type), ["start"]);
    const completed = deferred();
    adapter.onmessage = event => { if (event.data.type === "complete") completed.resolve(event.data); };
    await adapter.postMessage({ type: "finish", taskId: 1 });
    assert.equal((await completed.promise).scannedNodes, 0);
    adapter.terminate();
    await assertWorkersReleased(h);
  }
});

test("the service worker independently rejects oversized chunks from a client bypassing transport validation", async t => {
  const h = useFixture(t);
  for (const chunks of [
    [{ id: 0, text: "x".repeat(16 * 1024 * 1024 + 1) }],
    Array.from({ length: 2001 }, (_, id) => ({ id, text: "" }))
  ]) {
    const adapter = await h.client().transport.create();
    await adapter.postMessage({ type: "start", taskId: 1, pattern: "x", flags: "g" });
    const pair = h.pairs.findLast(pair => pair.role === "content");
    const clientId = h.log.find(entry => entry.pair === pair && entry.side === "client" && entry.data.kind === "open").data.clientId;
    const rejected = deferred();
    adapter.onerror = event => rejected.resolve(event.error);
    pair.client.postMessage({ kind: "message", clientId, sequence: 2, data: { type: "chunks", taskId: 1, chunks } });
    assert.equal((await rejected.promise).code, "worker-protocol-error");
    assert.deepEqual(h.workers.at(-1).sent.map(message => message.type), ["start"]);
    await assertWorkersReleased(h);
  }
});

test("replaying a previously acknowledged sequence closes the offending client", async t => {
  const h = useFixture(t);
  const adapter = await h.client().transport.create();
  await adapter.postMessage({ type: "start", taskId: 1, pattern: "x", flags: "g" });
  const pair = h.pairs.find(pair => pair.role === "content");
  const envelope = h.log.find(entry => entry.pair === pair && entry.side === "client" && entry.data.kind === "message").data;
  const disconnected = deferred();
  adapter.onerror = event => disconnected.resolve(event.error);
  pair.client.postMessage(envelope);
  assert.equal((await disconnected.promise).code, "worker-protocol-error");
  assert.equal(h.workers[0].sent.length, 1);
  await assertWorkersReleased(h);
});

test("manager cancellation disconnects the route, terminates its actual worker and suppresses later producer input", async t => {
  const h = useFixture(t);
  const { manager } = h.client();
  const producerReady = deferred();
  const resumeProducer = deferred();
  t.after(() => resumeProducer.resolve());
  const searching = manager.searchStream(9, "x", "g", async (send, keepGoing) => {
    await send([{ id: 0, text: "x" }]);
    producerReady.resolve();
    await resumeProducer.promise;
    assert.equal(keepGoing(), false);
    assert.equal(await send([{ id: 1, text: "x" }]), 0);
  });
  const rejected = assert.rejects(searching, { name: "AbortError", code: "search-cancelled" });
  await producerReady.promise;
  manager.cancel(9);
  await rejected;
  await assertWorkersReleased(h);
  resumeProducer.resolve();
  await tick();
  assert.deepEqual(h.workers[0].sent.map(message => message.type), ["start", "chunks"]);
});

test("direct transport cancellation releases its worker slot after the ACK without explicit termination", async t => {
  const h = useFixture(t);
  const { transport, manager } = h.client();
  const adapter = await transport.create();
  const errors = [];
  adapter.onerror = event => errors.push(event.error.code);
  await adapter.postMessage({ type: "start", taskId: 1, pattern: "x", flags: "g" });
  await adapter.postMessage({ type: "cancel", taskId: 1 });
  await assertWorkersReleased(h);
  assert.deepEqual(h.workers[0].sent.map(message => message.type), ["start", "cancel"]);
  assert.deepEqual(fromHost(h, "ack").map(entry => entry.data.sequence), [1, 2]);
  assert.deepEqual(errors, []);
  const result = await manager.search(2, "recovered", "g", [{ id: 0, text: "recovered" }]);
  assert.equal(result.totalMatches, 1);
  assert.deepEqual(errors, []);
  await assertWorkersReleased(h);
});

test("transport termination during handshake releases a late-created offscreen worker instead of leaking it", async t => {
  const createGate = deferred();
  const h = useFixture(t, { createGate });
  t.after(() => createGate.resolve());
  const abort = new AbortController();
  const creating = h.client().transport.create({ signal: abort.signal });
  const rejected = assert.rejects(creating, { name: "AbortError", code: "search-cancelled" });
  await waitFor(() => h.creates === 1, "offscreen startup");
  abort.abort();
  await rejected;
  createGate.resolve();
  await tick();
  await tick();
  assert.equal(h.workers.length, 0, "abandoned handshake must never send host open");
  await assertWorkersReleased(h);
});

test("an abandoned slow offscreen creation still closes its late host after the idle deadline", async t => {
  const createGate = deferred();
  t.after(() => createGate.resolve());
  const h = useFixture(t, { createGate });
  const abort = new AbortController();
  const creating = h.client().transport.create({ signal: abort.signal });
  const rejected = assert.rejects(creating, { name: "AbortError", code: "search-cancelled" });
  await waitFor(() => h.creates === 1, "pending offscreen creation");
  abort.abort();
  await rejected;
  await waitFor(() => h.clientCount === 0, "abandoned client cleanup");
  h.fireTimeout("background", 9000);
  await tick();
  h.fireTimeout("background", 15000);
  await waitFor(() => h.closes === 1, "idle cleanup after the abandoned startup deadline");
  createGate.resolve();
  await waitFor(() => h.pairs.some(pair => pair.role === "host" && !pair.state.disconnected) && [...h.timers].some(entry => entry.owner === "background" && entry.delay === 15000), "renewed idle deadline for the late host");
  assert.equal(h.clientCount, 0);
  assert.equal(h.workers.length, 0);
  assert.equal(h.pairs.filter(pair => pair.role === "host" && !pair.state.disconnected).length, 1);
  h.fireTimeout("background", 15000);
  await waitFor(() => h.closes === 2 && h.pairs.every(pair => pair.role !== "host" || pair.state.disconnected), "late idle host closure");
});

test("a stalled getContexts call expires at the startup deadline and cannot create a document after recovery", async t => {
  const firstContextsGate = deferred();
  const h = useFixture(t, { firstContextsGate });
  const creating = h.client().transport.create();
  const rejected = assert.rejects(creating, { code: "worker-spawn-failed" });
  await waitFor(() => h.contextCalls === 1, "stalled context lookup");
  h.fireTimeout("background", 9000, "Worker host startup timed out.");
  await rejected;
  assert.equal(runInContext("offscreenJob === null", h.background), true);
  assert.equal(runInContext("hostWaiters.length", h.background), 0);
  assert.equal([...h.timers].filter(entry => entry.owner === "background" && entry.delay === 9000).length, 0);
  const result = await h.client(contentSender(2)).manager.search(2, "recovered", "g", [{ id: 0, text: "recovered" }]);
  assert.equal(result.totalMatches, 1);
  assert.equal(h.creates, 1);
  firstContextsGate.resolve();
  await tick();
  assert.equal(h.creates, 1, "the expired lookup must not start another document creation");
  await assertWorkersReleased(h);
});

test("a stalled createDocument call expires without retaining the job used by later searches", async t => {
  const firstCreateGate = deferred();
  const h = useFixture(t, { firstCreateGate });
  const creating = h.client().transport.create();
  const rejected = assert.rejects(creating, { code: "worker-spawn-failed" });
  await waitFor(() => h.creates === 1, "stalled document creation");
  h.fireTimeout("background", 9000, "Worker host startup timed out.");
  await rejected;
  assert.equal(runInContext("offscreenJob === null", h.background), true);
  assert.equal(runInContext("hostWaiters.length", h.background), 0);
  assert.equal([...h.timers].filter(entry => entry.owner === "background" && entry.delay === 9000).length, 0);
  const result = await h.client(contentSender(2)).manager.search(2, "recovered", "g", [{ id: 0, text: "recovered" }]);
  assert.equal(result.totalMatches, 1);
  assert.equal(h.creates, 2, "a later search must retry rather than join the expired startup promise");
  await assertWorkersReleased(h);
});

test("the overall startup deadline also expires when the host connects before createDocument settles", async t => {
  const firstCreateCompletionGate = deferred();
  const h = useFixture(t, { firstCreateCompletionGate });
  const creating = h.client().transport.create();
  const rejected = assert.rejects(creating, { code: "worker-spawn-failed", message: "Worker host startup timed out." });
  await waitFor(() => h.pairs.some(pair => pair.role === "host" && !pair.state.disconnected) && runInContext("hostWaiters.length", h.background) === 0, "connected host with a stalled creation response");
  h.fireTimeout("background", 9000, "Worker host startup timed out.");
  await rejected;
  assert.equal(runInContext("offscreenJob === null", h.background), true);
  assert.equal([...h.timers].filter(entry => entry.owner === "background" && entry.delay === 9000).length, 0);
  const result = await h.client(contentSender(2)).manager.search(2, "recovered", "g", [{ id: 0, text: "recovered" }]);
  assert.equal(result.totalMatches, 1);
  assert.equal(h.creates, 1, "the later search must reuse the authenticated host");
  await assertWorkersReleased(h);
  h.fireTimeout("background", 15000);
  await waitFor(() => h.closes === 1, "idle closure despite the old unresolved API response");
});

test("losing the offscreen host fails all active transports, stops their workers and allows a fresh host", async t => {
  const h = useFixture(t);
  const adapters = await Promise.all([h.client(contentSender(1)).transport.create(), h.client(contentSender(2)).transport.create()]);
  await Promise.all(adapters.map((adapter, i) => adapter.postMessage({ type: "start", taskId: i + 1, pattern: "x", flags: "g" })));
  const errors = adapters.map(() => deferred());
  adapters.forEach((adapter, i) => { adapter.onerror = event => errors[i].resolve(event.error); });
  h.crashOffscreen();
  assert.deepEqual((await Promise.all(errors.map(value => value.promise))).map(error => error.code), ["worker-disconnected", "worker-disconnected"]);
  await assertWorkersReleased(h);
  const result = await h.client(contentSender(3)).manager.search(3, "recovery", "g", [{ id: 0, text: "recovery" }]);
  assert.equal(result.totalMatches, 1);
  assert.equal(h.creates, 2);
  await assertWorkersReleased(h);
});

test("a real worker process crash releases only its route while another tab keeps searching", async t => {
  const h = useFixture(t);
  const first = await h.client(contentSender(1)).transport.create();
  const second = await h.client(contentSender(2)).transport.create();
  await Promise.all([first.postMessage({ type: "start", taskId: 1, pattern: "x", flags: "g" }), second.postMessage({ type: "start", taskId: 1, pattern: "y", flags: "g" })]);
  const crashed = deferred();
  first.onerror = event => crashed.resolve(event.error);
  h.workers[0].thread.postMessage({ __relayTestCrash: true });
  assert.equal((await crashed.promise).code, "worker-crashed");
  assert.equal(h.clientCount, 1);
  const completed = deferred();
  second.onmessage = event => { if (event.data.type === "complete") completed.resolve(event.data); };
  await second.postMessage({ type: "chunks", taskId: 1, chunks: [{ id: 2, text: "y y" }] });
  await second.postMessage({ type: "finish", taskId: 1 });
  assert.equal((await completed.promise).totalMatches, 2);
  second.terminate();
  await assertWorkersReleased(h);
});

test("the manager deadline terminates a genuinely stuck regex worker and the relay recovers", async t => {
  const h = useFixture(t);
  const { manager } = h.client();
  manager.updateConfig({ workerTimeoutMs: 1000, allowUnsafeEcmascript: true });
  const searching = manager.search(1, "(a+)+$", "g", [{ id: 0, text: `${"a".repeat(45)}!` }], { status: "unsafe" });
  await assert.rejects(searching, { code: "search-timeout", numericCode: 504 });
  assert.equal(h.workers.length, 1);
  assert.ok(h.workers[0].sent.some(message => message.type === "chunks"), "test must reach real RegExp execution rather than only timing out startup");
  assert.equal(h.workers[0].received.some(message => message.sequence === 2), false, "catastrophic regex must still be executing when terminated");
  await assertWorkersReleased(h);
  manager.updateConfig({ workerTimeoutMs: 3000 });
  assert.equal((await manager.search(2, "safe", "g", [{ id: 0, text: "safe" }])).totalMatches, 1);
  await assertWorkersReleased(h);
});

test("an unstarted route has an idle watchdog while active queries use their own deadline", async t => {
  for (const owner of ["background", "offscreen"]) {
    const h = useFixture(t);
    const adapter = await h.client().transport.create();
    if (owner === "background") await adapter.postMessage({ type: "start", taskId: 1, pattern: "x", flags: "g" });
    const lifetimeTimers = [...h.timers].filter(entry => entry.delay === 120000);
    assert.deepEqual(lifetimeTimers.map(entry => entry.owner).sort(), owner === "background" ? ["background"] : ["background", "offscreen"]);
    assert.equal([...h.timers].filter(entry => entry.owner === "background" && entry.delay === 9000).length, 0, "ready must clear the handshake deadline");
    const failed = deferred();
    adapter.onerror = event => failed.resolve(event.error);
    h.fireTimeout(owner, 120000);
    const error = await failed.promise;
    assert.equal(error.code, "search-timeout");
    assert.equal(error.numericCode, 504);
    await assertWorkersReleased(h);
    assert.equal([...h.timers].filter(entry => entry.delay === 120000).length, 0);
  }
});

test("long literal queries are analyzed only in the real Worker and return validated ACK intervals", async t => {
  const h = useFixture(t);
  const { manager } = h.client();
  const pattern = "A".repeat(10000);
  let acknowledged;
  const result = await manager.searchStream(1, pattern, "giu", async (send, keepGoing, getIds, getMatches) => {
    await send([{ id: 7, text: "--" + "a".repeat(10000) + "--" }]);
    acknowledged = structuredClone(getMatches());
    assert.deepEqual(structuredClone(getIds()), [7]);
    assert.equal(keepGoing(), true);
  }, { mode: "literal", status: "deferred", analyzeInWorker: true });
  assert.deepEqual(acknowledged, [{ chunkId: 7, start: 2, end: 10002 }]);
  assert.deepEqual(result.matches, acknowledged);
  assert.equal(result.scannedChars, 10004);
  assert.equal(h.workers[0].sent[0].analyzeInWorker, true);
  assert.equal(h.workers[0].sent[0].pattern, pattern);
  await assertWorkersReleased(h);
});

test("a real regex scan taking more than 250 ms completes within its single whole-query deadline", async t => {
  const h = useFixture(t);
  const { manager } = h.client();
  manager.updateConfig({ workerTimeoutMs: 5000, maxChunkMs: 1, maxNodeChars: 1 });
  const startedAt = performance.now();
  const result = await manager.search(1, "a(?=[a-z]{200}b)", "g", [{ id: 0, text: "a".repeat(1000000) }]);
  assert.ok(performance.now() - startedAt > 250, "the real scan must exceed the former per-chunk deadline");
  assert.equal(result.scannedChars, 1000000);
  assert.equal(result.limited, false);
  assert.equal(result.totalMatches, 0);
  assert.equal("maxChunkMs" in h.workers[0].sent[0], false);
  assert.equal("maxNodeChars" in h.workers[0].sent[0], false);
  await assertWorkersReleased(h);
});

test("a window larger than the logical scan budget is accepted when ownership stays within that budget", async t => {
  const h = useFixture(t);
  const { manager } = h.client();
  manager.updateConfig({ maxScannedChars: 4, maxScannedNodes: 1 });
  const result = await manager.searchStream(1, "cde", "gu", async send => {
    await send([{ id: 0, text: "abcdef", stream: {
      runId: 0, offset: 0, ownedStart: 0, ownedEnd: 4, first: true, last: true
    } }]);
    return { limitReason: "max-scanned-chars" };
  }, { mode: "literal" });
  assert.equal(result.scannedChars, 4);
  assert.equal(result.scannedNodes, 1);
  assert.deepEqual(result.matches, [{ chunkId: 0, start: 2, end: 5 }]);
  assert.equal(result.limitReason, "max-scanned-chars");
  await assertWorkersReleased(h);
});

test("removed cumulative node limits do not truncate packets, separate logical nodes or empty text", async t => {
  const h = useFixture(t);
  const { manager } = h.client();
  manager.updateConfig({ maxScannedChars: 100, maxScannedNodes: 1, batchSize: 1 });
  const result = await manager.search(1, "cde", "gu", [
    { id: 0, text: "abcdef", stream: { runId: 0, offset: 0, ownedStart: 0, ownedEnd: 2, first: true, last: true } },
    { id: 1, text: "abcdef", stream: { runId: 0, offset: 0, ownedStart: 2, ownedEnd: 4, first: false, last: true } },
    { id: 2, text: "cdef", stream: { runId: 0, offset: 2, ownedStart: 4, ownedEnd: 6, first: false, last: true } },
    { id: 3, text: "another cde" },
    { id: 4, text: "" },
    { id: 5, text: "last cde" }
  ], { mode: "literal" });
  assert.equal(result.scannedChars, 25);
  assert.equal(result.scannedNodes, 4);
  assert.equal(result.limited, false);
  assert.deepEqual(result.matches, [{ chunkId: 1, start: 2, end: 5 }, { chunkId: 3, start: 8, end: 11 }, { chunkId: 5, start: 5, end: 8 }]);
  assert.equal(h.workers[0].sent.filter(message => message.type === "chunks").length, 6);
  assert.equal("maxScannedNodes" in h.workers[0].sent[0], false);
  await assertWorkersReleased(h);
});

test("native regex source fragments preserve a complete run beyond one physical window", async t => {
  const h = useFixture(t);
  const { manager } = h.client();
  const piece = 8 * 1024 * 1024, prefix = 17 * 1024 * 1024, text = "a".repeat(prefix) + "needle";
  const chunks = [];
  for (let offset = 0; offset < text.length; offset += piece) {
    chunks.push({ id: chunks.length + 10, text: text.slice(offset, offset + piece), source: {
      runId: 10, offset, first: offset === 0, last: offset + piece >= text.length
    } });
  }
  let completed, intervals;
  const result = await manager.searchStream(1, "(?<=a)needle$", "gu", async (send, keepGoing, getIds, getMatches, getCompleted) => {
    for (const chunk of chunks) {
      await send([chunk]);
      if (!chunk.source.last) {
        assert.deepEqual(structuredClone(getCompleted()), []);
        assert.deepEqual(structuredClone(getMatches()), []);
      }
    }
    completed = structuredClone(getCompleted()); intervals = structuredClone(getMatches());
    assert.deepEqual(structuredClone(getIds()), [10]);
  });
  assert.equal(result.scannedChars, text.length);
  assert.equal(result.scannedNodes, 1);
  assert.equal(result.limited, false);
  assert.deepEqual(completed, [10]);
  assert.deepEqual(intervals, [{ chunkId: 10, start: prefix, end: text.length }]);
  assert.deepEqual(result.matches, intervals);
  assert.equal(h.workers[0].sent.filter(message => message.type === "chunks").length, chunks.length);
  await assertWorkersReleased(h);
});

test("native source matches spanning more than 32 Mi characters remain one complete match", async t => {
  const h = useFixture(t);
  const { manager } = h.client();
  const total = 33 * 1024 * 1024, piece = "a".repeat(8 * 1024 * 1024);
  let id = 0, offset = 0, completed;
  const result = await manager.searchStream(1, "^a+$", "g", async (send, keepGoing, getIds, getMatches, getCompleted) => {
    while (offset < total) {
      const text = total - offset >= piece.length ? piece : "a".repeat(total - offset);
      const source = { runId: 0, offset, first: offset === 0, last: offset + text.length === total };
      await send([{ id: id++, text, source }]);
      offset += text.length;
    }
    completed = structuredClone(getCompleted());
  });
  assert.equal(result.limited, false);
  assert.equal(result.scannedChars, total);
  assert.deepEqual(result.matches, [{ chunkId: 0, start: 0, end: total }]);
  assert.deepEqual(completed, [0]);
  await assertWorkersReleased(h);
});

test("source EOF without a hit releases completion metadata and preserves native captures across later fragments", async t => {
  const h = useFixture(t);
  const { manager } = h.client();
  const completed = [], intervals = [];
  const result = await manager.searchStream(1, "(?<=ab)(cd)\\1$", "g", async (send, keepGoing, getIds, getMatches, getCompleted) => {
    await send([{ id: 0, text: "none", source: { runId: 0, offset: 0, first: true, last: true } }]);
    completed.push(structuredClone(getCompleted()));
    assert.deepEqual(structuredClone(getMatches()), []);
    await send([{ id: 1, text: "abc", source: { runId: 1, offset: 0, first: true, last: false } }]);
    assert.deepEqual(structuredClone(getCompleted()), []);
    await send([{ id: 2, text: "dcd", source: { runId: 1, offset: 3, first: false, last: false } }]);
    await send([{ id: 3, text: "", source: { runId: 1, offset: 6, first: false, last: true } }]);
    completed.push(structuredClone(getCompleted()));
    intervals.push(...structuredClone(getMatches()));
  });
  assert.deepEqual(completed, [[0], [1]]);
  assert.deepEqual(intervals, [{ chunkId: 1, start: 2, end: 6 }]);
  assert.deepEqual(result.matches, intervals);
  assert.equal(result.scannedNodes, 2);
  await assertWorkersReleased(h);
});

test("a match limit may finish the first EOF while leaving a later queued source unprocessed", async t => {
  const h = useFixture(t);
  const { manager } = h.client();
  manager.updateConfig({ maxMatches: 1 });
  let completed, done;
  const producerDone = new Promise(resolve => { done = resolve; });
  const result = await manager.searchStream(1, "a+", "g", async (send, keepGoing, getIds, getMatches, getCompleted) => {
    await send([
      { id: 0, text: "aa", source: { runId: 0, offset: 0, first: true, last: true } },
      { id: 1, text: "aa", source: { runId: 1, offset: 0, first: true, last: true } }
    ]);
    completed = structuredClone(getCompleted());
    assert.equal(keepGoing(), false);
    done();
  });
  await producerDone;
  assert.equal(result.limitReason, "max-matches");
  assert.deepEqual(result.matches, [{ chunkId: 0, start: 0, end: 2 }]);
  assert.deepEqual(completed, [0]);
  await assertWorkersReleased(h);
});

test("cancelling an unfinished source frees its Worker and allows a new source with the same logical ID", async t => {
  const h = useFixture(t);
  const { manager } = h.client();
  let ready;
  const sourceStarted = new Promise(resolve => { ready = resolve; });
  const searching = manager.searchStream(1, "a+", "g", async (send, keepGoing) => {
    await send([{ id: 0, text: "a".repeat(128 * 1024), source: { runId: 0, offset: 0, first: true, last: false } }]);
    ready();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(keepGoing(), false);
  });
  const rejected = assert.rejects(searching, { code: "search-cancelled" });
  await sourceStarted;
  manager.cancel(1);
  await rejected;
  await assertWorkersReleased(h);
  const result = await manager.search(2, "a+", "g", [{ id: 0, text: "aa", source: { runId: 0, offset: 0, first: true, last: true } }]);
  assert.deepEqual(result.matches, [{ chunkId: 0, start: 0, end: 2 }]);
  await assertWorkersReleased(h);
});

test("the offscreen deadline kills a genuinely stuck regex while all content timers are delayed", async t => {
  const h = useFixture(t, { deferContentTimeouts: true });
  const { manager } = h.client();
  manager.updateConfig({ workerTimeoutMs: 1500, allowUnsafeEcmascript: true });
  const searching = manager.search(1, "(a+)+$", "g", [{ id: 0, text: "a".repeat(45) + "!" }], { status: "unsafe" });
  await assert.rejects(searching, { code: "search-timeout", numericCode: 504 });
  assert.ok(h.workers[0].sent.some(message => message.type === "chunks"), "the test must reach genuine native RegExp execution");
  assert.equal(h.workers[0].received.some(message => message.sequence === 2), false);
  const terminal = fromHost(h, "message").find(entry => entry.data.data?.type === "error");
  assert.equal(terminal.data.data.code, "search-timeout");
  assert.equal(terminal.data.data.numericCode, 504);
  assert.equal(fromHost(h, "failure").length, 0);
  assert.equal(h.workers[0].terminated, true);
  await assertWorkersReleased(h);
  manager.updateConfig({ workerTimeoutMs: 5000 });
  assert.equal((await manager.search(2, "recovered", "g", [{ id: 0, text: "recovered" }])).totalMatches, 1);
  await assertWorkersReleased(h);
});

test("late Worker replies fail at the offscreen deadline and cannot revive a released task", async t => {
  let clock = 0;
  const h = useFixture(t, { offscreenClock: () => clock, deferContentTimeouts: true });
  const adapter = await h.client().transport.create();
  await adapter.postMessage({ type: "start", taskId: 1, pattern: "x", flags: "g", workerTimeoutMs: 100000 });
  const callback = h.workers[0].onmessage, done = deferred();
  adapter.onmessage = event => { if (event.data.type === "error") done.resolve(event.data); };
  clock = 100001;
  callback({ data: { type: "complete", taskId: 1, matches: [], totalMatches: 0 } });
  assert.equal((await done.promise).numericCode, 504);
  await assertWorkersReleased(h);
  const count = fromHost(h, "message").length;
  callback({ data: { type: "complete", taskId: 1, matches: [], totalMatches: 0 } });
  callback({ data: { type: "ack", taskId: 1, sequence: 2 } });
  await tick();
  assert.equal(fromHost(h, "message").length, count);
  assert.equal([...h.timers].filter(entry => entry.owner === "offscreen" && !entry.interval).length, 0);
});

test("successful completion clears the independent offscreen deadline and ignores late callbacks", async t => {
  const h = useFixture(t);
  const adapter = await h.client().transport.create();
  await adapter.postMessage({ type: "start", taskId: 1, pattern: "x", flags: "g", workerTimeoutMs: 5000 });
  const queryTimers = [...h.timers].filter(entry => entry.owner === "offscreen" && entry.delay === 5000);
  assert.equal(queryTimers.length, 1);
  const callback = h.workers[0].onmessage;
  await adapter.postMessage({ type: "chunks", taskId: 1, chunks: [{ id: 0, text: "x" }] });
  assert.deepEqual([...h.timers].filter(entry => entry.owner === "offscreen" && entry.delay === 5000), queryTimers);
  const done = deferred();
  adapter.onmessage = event => { if (event.data.type === "complete") done.resolve(event.data); };
  await adapter.postMessage({ type: "finish", taskId: 1 });
  assert.equal((await done.promise).totalMatches, 1);
  await assertWorkersReleased(h);
  assert.equal([...h.timers].filter(entry => entry.owner === "offscreen" && !entry.interval).length, 0);
  const count = fromHost(h, "message").length;
  callback({ data: { type: "complete", taskId: 1, matches: [], totalMatches: 0 } });
  callback({ data: { type: "error", taskId: 1, code: "worker-crashed", numericCode: 503 } });
  await tick();
  assert.equal(fromHost(h, "message").length, count);
});

test("logical runs larger than one transfer window cross ownership boundaries without duplicate hits", async t => {
  const h = useFixture(t);
  const { manager } = h.client();
  const step = 6 * 1024 * 1024, needle = "needle", hit = step - 3;
  const text = "x".repeat(hit) + needle + "x".repeat(3 * step - hit - needle.length);
  const chunks = [];
  for (let ownedStart = 0; ownedStart < text.length; ownedStart += step) {
    const ownedEnd = Math.min(text.length, ownedStart + step);
    const offset = Math.max(0, ownedStart - 2);
    const end = Math.min(text.length, ownedEnd + needle.length + 2);
    chunks.push({ id: chunks.length, text: text.slice(offset, end), stream: {
      runId: 0, offset, ownedStart, ownedEnd, first: ownedStart === 0, last: ownedEnd === text.length
    } });
  }
  manager.updateConfig({ maxBatchChars: 8 * 1024 * 1024, maxScannedChars: text.length, workerTimeoutMs: 5000 });
  let acknowledged;
  const result = await manager.searchStream(1, needle, "gu", async (send, keepGoing, getIds, getMatches) => {
    assert.equal(await send(chunks), chunks.length);
    acknowledged = structuredClone(getMatches());
    assert.deepEqual(structuredClone(getIds()), [0]);
  }, { mode: "literal" });
  assert.equal(result.scannedChars, text.length);
  assert.equal(result.scannedNodes, 1);
  assert.equal(result.limited, false);
  assert.deepEqual(acknowledged, [{ chunkId: 0, start: hit, end: hit + needle.length }]);
  assert.deepEqual(result.matches, acknowledged);
  assert.equal(h.workers[0].sent.filter(message => message.type === "chunks").length, 3);
  assert.ok(h.workers[0].sent.filter(message => message.type === "chunks").every(message =>
    message.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0) <= 16 * 1024 * 1024));
  await assertWorkersReleased(h);
});

test("successive windows whose context reaches the genuine run tail still scan each owned partition", async t => {
  const h = useFixture(t);
  const { manager } = h.client();
  const result = await manager.search(1, "cde", "gu", [
    { id: 0, text: "abcdef", stream: { runId: 0, offset: 0, ownedStart: 0, ownedEnd: 3, first: true, last: true } },
    { id: 1, text: "bcdef", stream: { runId: 0, offset: 1, ownedStart: 3, ownedEnd: 6, first: false, last: true } },
    { id: 2, text: "unrelated" }
  ], { mode: "literal" });
  assert.deepEqual(result.matches, [{ chunkId: 0, start: 2, end: 5 }]);
  assert.equal(result.scannedChars, 15);
  assert.equal(result.scannedNodes, 2);
  await assertWorkersReleased(h);
});

test("actual collection preserves a long Ruby base across independent annotations through the whole Worker relay", async t => {
  const h = useFixture(t);
  const dom = new JSDOM('<head><style>ruby{display:ruby}rt{display:ruby-text}</style></head><body><p><ruby></ruby></p></body>', { url: "https://example.com" });
  t.after(() => dom.window.close());
  const document = dom.window.document, ruby = document.querySelector("ruby"), core = 128 * 1024;
  const left = document.createTextNode("x".repeat(core * 2)), right = document.createTextNode("y".repeat(core * 2));
  const annotation = document.createElement("rt"); annotation.textContent = "reading";
  ruby.append(left, annotation, right);
  const collectorContext = createContext({ document, NodeFilter: dom.window.NodeFilter, performance, setTimeout, clearTimeout });
  runInContext(sources["infra/page_visibility.js"], collectorContext, { filename: "infra/page_visibility.js" });
  runInContext(sources["infra/text_collector.js"], collectorContext, { filename: "infra/text_collector.js" });
  const collector = collectorContext.RRTextCollector;
  collector.document = document;
  for (const [index, pattern] of ["xy", "reading"].entries()) {
    const { manager } = h.client(contentSender(index + 1));
    const byId = new Map();
    const result = await manager.searchStream(index + 1, pattern, "gu", async (send, keepGoing) => {
      await collector.collectBatched({ streamLiterals: true, literalQueryLength: pattern.length,
        storeNodes: false, maxDurationMs: 3000, batchSize: 1,
        shouldContinue: keepGoing,
        onBatch: async batch => {
          batch.forEach(entry => byId.set(entry.id, entry));
          await send(batch);
          return keepGoing();
        }
      });
    }, { mode: "literal" });
    assert.equal(result.limited, false);
    assert.equal(result.scannedChars, core * 4 + 7);
    assert.equal(result.scannedNodes, 2);
    assert.equal(result.matches.length, 1);
    const match = result.matches[0], entry = byId.get(match.chunkId);
    assert.equal(entry.text.slice(match.start, match.end), pattern);
    const nodes = Array.from(entry.segments).filter(segment => segment.start < match.end && segment.end > match.start).map(segment => segment.node);
    if (pattern === "xy") assert.deepEqual(nodes, [left, right]);
    else assert.deepEqual(nodes, [annotation.firstChild]);
    const chunks = h.workers.at(-1).sent.filter(message => message.type === "chunks").flatMap(message => message.chunks);
    const entries = [...byId.values()];
    const baseRun = entries.find(entry => entry.segments.some(segment => segment.node === left)).stream.runId;
    const annotationRun = entries.find(entry => entry.segments.some(segment => segment.node === annotation.firstChild)).stream.runId;
    const firstBase = chunks.findIndex(chunk => chunk.stream.runId === baseRun);
    const reading = chunks.findIndex(chunk => chunk.stream.runId === annotationRun);
    assert.ok(firstBase < reading && chunks.some((chunk, position) => position > reading && chunk.stream.runId === baseRun), "the emitted base must genuinely pause and resume around its annotation");
    await assertWorkersReleased(h);
  }
});

test("a producer budget stops an unfinished logical run with validated partial results", async t => {
  for (const limitReason of ["collection-budget", "max-scanned-chars"]) {
    const h = useFixture(t);
    const { manager } = h.client();
    const result = await manager.searchStream(1, "needle", "gu", async send => {
      await send([{ id: 0, text: "needlexxxxxxxxxx", stream: {
        runId: 0, offset: 0, ownedStart: 0, ownedEnd: 6, first: true, last: false
      } }]);
      return { limitReason };
    }, { mode: "literal" });
    assert.deepEqual(result.matches, [{ chunkId: 0, start: 0, end: 6 }]);
    assert.equal(result.limited, true);
    assert.equal(result.limitReason, limitReason);
    await assertWorkersReleased(h);
  }
});

test("extended queries retain the original host deadline and background recovery watchdog", async t => {
  for (const owner of ["background", "offscreen"]) {
    const h = useFixture(t);
    const adapter = await h.client().transport.create();
    await adapter.postMessage({ type: "start", taskId: 1, pattern: "x", flags: "g", workerTimeoutMs: 900000 });
    const lifetimes = [...h.timers].filter(entry => entry.delay === 910000);
    const queryTimers = [...h.timers].filter(entry => entry.owner === "offscreen" && entry.delay === 900000);
    assert.deepEqual(lifetimes.map(entry => entry.owner).sort(), ["background"]);
    assert.equal(queryTimers.length, 1);
    assert.equal([...h.timers].filter(entry => entry.delay === 120000).length, 0);
    await adapter.postMessage({ type: "chunks", taskId: 1, chunks: [{ id: 0, text: "safe" }] });
    assert.deepEqual([...h.timers].filter(entry => entry.delay === 910000), lifetimes, "chunks must retain the original timer objects");
    assert.deepEqual([...h.timers].filter(entry => entry.owner === "offscreen" && entry.delay === 900000), queryTimers, "chunks must not postpone the query deadline");
    const failed = deferred();
    adapter.onerror = event => failed.resolve(event.error);
    adapter.onmessage = event => { if (event.data.type === "error") failed.resolve(event.data); };
    h.fireTimeout(owner, owner === "background" ? 910000 : 900000);
    assert.equal((await failed.promise).code, "search-timeout");
    await assertWorkersReleased(h);
    assert.equal([...h.timers].filter(entry => entry.delay === 910000).length, 0);
  }
});

test("idle hosts close without retained heartbeat timers and new searches recreate their document", async t => {
  const h = useFixture(t);
  const { manager } = h.client();
  await manager.search(1, "x", "g", [{ id: 0, text: "x" }]);
  await assertWorkersReleased(h);
  h.fireTimeout("background", 15000);
  await waitFor(() => h.closes === 1, "offscreen idle close");
  await tick();
  const result = await manager.search(2, "y", "g", [{ id: 0, text: "y" }]);
  assert.equal(result.totalMatches, 1);
  assert.equal(h.creates, 2);
  await assertWorkersReleased(h);
});

test("offscreen creation failure rejects all concurrent clients and a later attempt can recover", async t => {
  const h = useFixture(t, { createError: new Error("Offscreen API unavailable") });
  const attempts = [h.client(contentSender(1)).transport.create(), h.client(contentSender(2)).transport.create()];
  await Promise.all(attempts.map(promise => assert.rejects(promise, { code: "worker-spawn-failed", message: "Offscreen API unavailable" })));
  assert.equal(h.creates, 1);
  assert.equal(h.clientCount, 0);
  assert.equal(runInContext("hostWaiters.length", h.background), 0);
  assert.equal([...h.timers].filter(entry => entry.delay === 9000).length, 0);
  h.clearCreateError();
  const result = await h.client(contentSender(3)).manager.search(3, "x", "g", [{ id: 0, text: "x" }]);
  assert.equal(result.totalMatches, 1);
  await assertWorkersReleased(h);
});

test("getContexts failure removes host waiters immediately and does not prevent a later search", async t => {
  const h = useFixture(t, { contextsError: new Error("Extension context invalidated") });
  await assert.rejects(h.client().transport.create(), { code: "worker-spawn-failed", message: "Extension context invalidated" });
  assert.equal(h.creates, 0);
  assert.equal(h.clientCount, 0);
  assert.equal(runInContext("hostWaiters.length", h.background), 0);
  assert.equal([...h.timers].filter(entry => entry.delay === 9000).length, 0);
  h.clearContextsError();
  const result = await h.client().manager.search(1, "x", "g", [{ id: 0, text: "x" }]);
  assert.equal(result.totalMatches, 1);
  await assertWorkersReleased(h);
});

test("a search arriving while the offscreen document is closing waits for closure before recreating its host", async t => {
  const closeGate = deferred();
  const h = useFixture(t, { closeGate });
  t.after(() => closeGate.resolve());
  const { manager } = h.client();
  await manager.search(1, "x", "g", [{ id: 0, text: "x" }]);
  await assertWorkersReleased(h);
  h.fireTimeout("background", 15000);
  await waitFor(() => h.closes === 1, "pending offscreen document close");
  const searching = manager.search(2, "y", "g", [{ id: 0, text: "y" }]);
  await waitFor(() => h.clientCount === 1, "search route awaiting document closure");
  assert.equal(h.creates, 1);
  closeGate.resolve();
  assert.equal((await searching).totalMatches, 1);
  assert.equal(h.creates, 2);
  await assertWorkersReleased(h);
});

test("a stalled closeDocument call expires and a waiting search can reuse the still-connected host", async t => {
  const closeGate = deferred();
  const h = useFixture(t, { closeGate });
  const { manager } = h.client();
  await manager.search(1, "x", "g", [{ id: 0, text: "x" }]);
  await assertWorkersReleased(h);
  h.fireTimeout("background", 15000);
  await waitFor(() => h.closes === 1, "stalled document closure");
  const searching = manager.search(2, "recovered", "g", [{ id: 0, text: "recovered" }]);
  await waitFor(() => h.clientCount === 1, "search awaiting the stalled closure");
  h.fireTimeout("background", 9000);
  assert.equal((await searching).totalMatches, 1);
  assert.equal(runInContext("closingJob === null", h.background), true);
  assert.equal(h.creates, 1, "the query must reuse the host whose close never completed");
  assert.equal([...h.timers].filter(entry => entry.owner === "background" && entry.delay === 9000).length, 0);
  await assertWorkersReleased(h);
});

test("a late expired closeDocument response cannot clear the newer close job", async t => {
  const firstCloseGate = deferred();
  const secondCloseGate = deferred();
  t.after(() => { firstCloseGate.resolve(); secondCloseGate.resolve(); });
  const h = useFixture(t, { closeGates: [firstCloseGate, secondCloseGate] });
  const { manager } = h.client();
  await manager.search(1, "x", "g", [{ id: 0, text: "x" }]);
  await assertWorkersReleased(h);
  h.fireTimeout("background", 15000);
  await waitFor(() => h.closes === 1, "first stalled closure");
  h.fireTimeout("background", 9000);
  await waitFor(() => runInContext("closingJob === null", h.background), "expired closure job cleanup");
  assert.equal((await manager.search(2, "recovered", "g", [{ id: 0, text: "recovered" }])).totalMatches, 1);
  await assertWorkersReleased(h);
  h.fireTimeout("background", 15000);
  await waitFor(() => h.closes === 2, "newer stalled closure");
  const newerJob = runInContext("closingJob", h.background);
  assert.ok(newerJob);
  firstCloseGate.resolve();
  await waitFor(() => h.pairs.every(pair => pair.role !== "host" || pair.state.disconnected), "late old document closure");
  await tick();
  assert.equal(runInContext("closingJob", h.background), newerJob, "the late response must preserve the newer closure job");
  assert.equal([...h.timers].filter(entry => entry.owner === "background" && entry.delay === 9000).length, 1);
  secondCloseGate.resolve();
  await waitFor(() => runInContext("closingJob === null", h.background), "newer closure completion");
  assert.equal([...h.timers].filter(entry => entry.owner === "background" && entry.delay === 9000).length, 0);
});
