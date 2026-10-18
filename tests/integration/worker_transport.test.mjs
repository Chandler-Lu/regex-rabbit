import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { readRuntimeSource as readFile } from "../fixtures/runtime_source.mjs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const source = await readFile(new URL("../../infra/worker_transport.js", import.meta.url), "utf8");

class PortEvent {
  listeners = new Set();

  addListener(listener) {
    this.listeners.add(listener);
  }

  removeListener(listener) {
    this.listeners.delete(listener);
  }

  emit(...args) {
    for (const listener of [...this.listeners]) listener(...args);
  }
}

class FakePort {
  onMessage = new PortEvent();
  onDisconnect = new PortEvent();
  sent = [];
  disconnectCalls = 0;
  disconnected = false;
  sendError = null;

  postMessage(message) {
    if (this.sendError) throw this.sendError;
    if (this.disconnected) throw new Error("Attempting to use a disconnected port object");
    this.sent.push(structuredClone(message));
  }

  disconnect() {
    this.disconnectCalls += 1;
    if (this.disconnected) return;
    this.disconnected = true;
    this.onDisconnect.emit(this);
  }

  receive(message) {
    this.onMessage.emit(structuredClone(message), this);
  }

  loseConnection() {
    this.disconnected = true;
    this.onDisconnect.emit(this);
  }
}

function harness({ connectError = null } = {}) {
  let now = 0;
  let nextTimer = 1;
  let nextClient = 1;
  const timers = new Map();
  const ports = [];
  const connections = [];
  const runtime = {
    lastError: undefined,
    connect(options) {
      connections.push(structuredClone(options));
      if (connectError) throw connectError;
      const port = new FakePort();
      ports.push(port);
      return port;
    }
  };
  const context = createContext({
    chrome: { runtime },
    crypto: { randomUUID: () => `transport-test-${nextClient++}` },
    console,
    performance: { now: () => now },
    setTimeout(callback, delay = 0, ...args) {
      const id = nextTimer++;
      timers.set(id, { callback, args, due: now + Number(delay) });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    }
  });
  runInContext(source, context, { filename: "infra/worker_transport.js" });

  return {
    transport: context.RRWorkerTransport,
    runtime,
    ports,
    connections,
    timers,
    advance(milliseconds) {
      const end = now + milliseconds;
      for (;;) {
        let next = null;
        for (const entry of timers) {
          if (entry[1].due <= end && (!next || entry[1].due < next[1].due)) next = entry;
        }
        if (!next) break;
        now = next[1].due;
        timers.delete(next[0]);
        next[1].callback(...next[1].args);
      }
      now = end;
    }
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

async function beginConnection(h, options) {
  const pending = h.transport.create(options);
  await flushPromises();
  const port = h.ports.at(-1);
  assert.ok(port, "create must open a Chrome runtime port");
  const open = port.sent.find(message => message.kind === "open");
  assert.ok(open, "create must send the open handshake");
  assert.equal(typeof open.clientId, "string");
  assert.ok(open.clientId.length > 0);
  return { pending, port, clientId: open.clientId };
}

async function readyConnection(h, options) {
  const connection = await beginConnection(h, options);
  connection.port.receive({ kind: "ready", clientId: connection.clientId });
  return { ...connection, worker: await connection.pending };
}

function assertReleased(h, port) {
  assert.equal(port.onMessage.listeners.size, 0, "message listeners must be removed");
  assert.equal(port.onDisconnect.listeners.size, 0, "disconnect listeners must be removed");
  assert.equal(h.timers.size, 0, "transport timers must be cleared");
}

test("an already aborted signal rejects create without opening a port", async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.transport.create({ signal: controller.signal }), error => {
    assert.equal(error.name, "AbortError");
    assert.equal(error.code, "search-cancelled");
    return true;
  });
  assert.equal(h.connections.length, 0);
  assert.equal(h.ports.length, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("availability detects missing runtime.connect and invalid signals never open ports", async () => {
  const h = harness();
  assert.equal(h.transport.isAvailable(), true);
  const connect = h.runtime.connect;
  delete h.runtime.connect;
  assert.equal(h.transport.isAvailable(), false);
  h.runtime.connect = connect;
  for (const signal of [{}, { addEventListener() {} }, { removeEventListener() {} }]) {
    await assert.rejects(h.transport.create({ signal }), error => error.code === "worker-protocol-error");
  }
  assert.equal(h.connections.length, 0);
  assert.equal(h.ports.length, 0);
  assert.equal(h.timers.size, 0);
});

test("aborting during handshake immediately rejects create and removes all listeners", async () => {
  const h = harness();
  const controller = new AbortController();
  const { pending, port, clientId } = await beginConnection(h, { signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  const rejected = assert.rejects(pending, error => {
    assert.equal(error.name, "AbortError");
    assert.equal(error.code, "search-cancelled");
    return true;
  });
  controller.abort();
  assert.equal(port.disconnected, true, "abort must disconnect synchronously without waiting for the handshake timeout");
  assert.equal(port.disconnectCalls, 1);
  assertReleased(h, port);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await rejected;
  port.receive({ kind: "ready", clientId });
  h.advance(10000);
  assertReleased(h, port);
});

test("aborting after ready silently terminates the worker and rejects outstanding sends", async () => {
  const h = harness();
  const controller = new AbortController();
  const { worker, port, clientId } = await readyConnection(h, { signal: controller.signal });
  const errors = [];
  const messages = [];
  worker.onerror = event => { errors.push(event); };
  worker.onmessage = event => { messages.push(event.data); };
  const pending = worker.postMessage({ type: "chunks", taskId: 1, chunks: [{ id: 0, text: "abc" }] });
  const rejected = assert.rejects(pending, error => error.name === "AbortError" && error.code === "search-cancelled");
  controller.abort();
  await rejected;
  assert.equal(port.disconnectCalls, 1);
  assertReleased(h, port);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.deepEqual(errors, []);
  await assert.rejects(Promise.resolve().then(() => worker.postMessage({ type: "finish", taskId: 1 })));
  port.receive({ kind: "message", clientId, data: { type: "complete", taskId: 1 } });
  port.receive({ kind: "ack", clientId, sequence: 1 });
  port.onDisconnect.emit(port);
  controller.abort();
  worker.terminate();
  assert.equal(port.disconnectCalls, 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(messages, []);
});

test("acknowledged cancel releases its dedicated route and rejects queued input without a transport error", async () => {
  const h = harness();
  const { worker, port, clientId } = await readyConnection(h);
  const errors = [];
  worker.onerror = event => errors.push(event);
  const cancelling = worker.postMessage({ type: "cancel", taskId: 1 });
  const queued = worker.postMessage({ type: "finish", taskId: 1 });
  const rejected = assert.rejects(queued, error => error.code === "search-cancelled" && error.name === "AbortError");
  port.receive({ kind: "ack", clientId, sequence: 1 });
  await cancelling;
  await rejected;
  assert.equal(port.disconnectCalls, 1);
  assert.equal(port.sent.filter(message => message.kind === "message").length, 1, "queued finish must never be sent after cancellation");
  assertReleased(h, port);
  h.advance(120000);
  assert.deepEqual(errors, []);
  await assert.rejects(worker.postMessage({ type: "start", taskId: 2, pattern: "x" }), { code: "worker-disconnected" });
  worker.terminate();
  assert.equal(port.disconnectCalls, 1);
});

test("transport connects to the extension worker port and waits for its own ready handshake", async () => {
  const h = harness();
  assert.equal(typeof h.transport.create, "function");
  const { pending, port, clientId } = await beginConnection(h);
  assert.deepEqual(h.connections, [{ name: "regex-rabbit-worker-v1" }]);

  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  port.receive({ kind: "ready", clientId: `${clientId}-other` });
  await flushPromises();
  assert.equal(settled, false);

  port.receive({ kind: "ready", clientId });
  const worker = await pending;
  assert.equal(typeof worker.postMessage, "function");
  assert.equal(typeof worker.terminate, "function");
  assert.equal(h.timers.size, 0, "ready must cancel the handshake timeout");
  worker.terminate();
  assertReleased(h, port);
});

test("transport forwards worker messages as onmessage events and ignores other clients", async () => {
  const h = harness();
  const { worker, port, clientId } = await readyConnection(h);
  const received = [];
  worker.onmessage = event => { received.push(event.data); };
  port.receive({ kind: "message", clientId: "unrelated-client", data: { type: "complete", taskId: 1 } });
  port.receive({ kind: "message", clientId, data: { type: "complete", taskId: 2, matches: [] } });
  assert.deepEqual(received, [{ type: "complete", taskId: 2, matches: [] }]);
  worker.terminate();
});

test("terminal replies reject queued sends before notifying callers and never report a later timeout", async () => {
  for (const type of ["complete", "error"]) {
    const h = harness();
    const controller = new AbortController();
    const { worker, port, clientId } = await readyConnection(h, { signal: controller.signal });
    const received = [];
    const errors = [];
    let sendFromCallback;
    worker.onerror = event => { errors.push(event); };
    worker.onmessage = event => {
      assertReleased(h, port);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      received.push(event.data);
      sendFromCallback = worker.postMessage({ type: "finish", taskId: 1 });
    };
    const batch = worker.postMessage({ type: "chunks", taskId: 1, chunks: [{ id: 0, text: "aa" }] });
    const finish = worker.postMessage({ type: "finish", taskId: 1 });
    const finishRejected = assert.rejects(finish, { code: "worker-disconnected" });
    port.receive({ kind: "ack", clientId, sequence: 1 });
    await batch;
    assert.deepEqual(port.sent.filter(message => message.kind === "message").map(message => message.sequence), [1, 2]);
    const terminal = { type, taskId: 1, matches: [] };
    port.receive({ kind: "message", clientId, data: terminal });
    await Promise.all([finishRejected, assert.rejects(sendFromCallback, { code: "worker-disconnected" })]);
    assert.deepEqual(received, [terminal]);
    assert.equal(port.disconnectCalls, 1);
    port.receive({ kind: "ack", clientId, sequence: 2 });
    port.receive({ kind: "message", clientId, data: terminal });
    port.onDisconnect.emit(port);
    h.advance(10000);
    controller.abort();
    worker.terminate();
    assertReleased(h, port);
    assert.equal(port.disconnectCalls, 1);
    assert.deepEqual(received, [terminal]);
    assert.deepEqual(errors, []);
  }
});

test("a terminal reply also settles sends that have not received a sequence ACK", async () => {
  const h = harness();
  const { worker, port, clientId } = await readyConnection(h);
  const first = worker.postMessage({ type: "start", taskId: 1, pattern: "[" });
  const second = worker.postMessage({ type: "chunks", taskId: 1, chunks: [] });
  const firstRejected = assert.rejects(first, { code: "worker-disconnected" });
  const secondRejected = assert.rejects(second, { code: "worker-disconnected" });
  port.receive({ kind: "message", clientId, data: { type: "error", taskId: 1, code: "pattern-invalid-syntax" } });
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(port.sent.filter(message => message.kind === "message").length, 1);
  assertReleased(h, port);
});

test("terminal cleanup does not require an onmessage handler or an awaited send", async () => {
  const h = harness();
  const { worker, port, clientId } = await readyConnection(h);
  worker.postMessage({ type: "finish", taskId: 1 });
  port.receive({ kind: "message", clientId, data: { type: "complete", taskId: 1, matches: [] } });
  assertReleased(h, port);
  await assert.rejects(worker.postMessage({ type: "finish", taskId: 1 }), { code: "worker-disconnected" });
  h.advance(10000);
  assertReleased(h, port);
});

test("transport sends in FIFO order and ignores acknowledgements for messages not yet sent", async () => {
  const h = harness();
  const { worker, port, clientId } = await readyConnection(h);
  const firstData = { type: "start", taskId: 12, pattern: "needle", flags: "g" };
  const first = worker.postMessage(firstData);
  const second = worker.postMessage({ type: "chunks", taskId: 12, chunks: [{ id: 0, text: "needle" }] });
  assert.equal(typeof first?.then, "function", "postMessage must expose acknowledgement backpressure");
  assert.equal(typeof second?.then, "function");
  let sent = port.sent.filter(message => message.kind === "message");
  assert.deepEqual(sent.map(message => message.sequence), [1]);
  assert.deepEqual(sent[0], { kind: "message", clientId, sequence: 1, data: firstData });
  assert.equal(h.timers.size, 1, "queued messages must not start acknowledgement timers");

  let firstSettled = false;
  let secondSettled = false;
  first.then(() => { firstSettled = true; });
  second.then(() => { secondSettled = true; });
  port.receive({ kind: "ack", clientId: "unrelated-client", sequence: 1 });
  port.receive({ kind: "ack", clientId, sequence: 99 });
  port.receive({ kind: "ack", clientId, sequence: 2 });
  await flushPromises();
  assert.equal(firstSettled, false);
  assert.equal(secondSettled, false);
  assert.equal(port.sent.filter(message => message.kind === "message").length, 1);

  port.receive({ kind: "ack", clientId, sequence: 1 });
  await first;
  sent = port.sent.filter(message => message.kind === "message");
  assert.deepEqual(sent.map(message => message.sequence), [1, 2]);
  assert.deepEqual(sent[1].data.chunks, [{ id: 0, text: "needle" }]);
  assert.equal(secondSettled, false);
  assert.equal(h.timers.size, 1);
  port.receive({ kind: "ack", clientId, sequence: 1 });
  await flushPromises();
  assert.equal(secondSettled, false, "a duplicate first acknowledgement must not release the second send");
  port.receive({ kind: "ack", clientId, sequence: 2 });
  await second;
  assert.equal(firstSettled, true);
  assert.equal(secondSettled, true);
  assert.equal(h.timers.size, 0);
  worker.terminate();
});

test("acknowledgements are internal control messages and do not reach onmessage", async () => {
  const h = harness();
  const { worker, port, clientId } = await readyConnection(h);
  const messages = [];
  worker.onmessage = event => { messages.push(event.data); };
  const pending = worker.postMessage({ type: "finish", taskId: 1 });
  port.receive({ kind: "ack", clientId, sequence: 1 });
  await pending;
  assert.deepEqual(messages, []);
  worker.terminate();
});

test("unacknowledged sends are bounded and an acknowledgement makes room for the next batch", async () => {
  const h = harness();
  const { worker, port, clientId } = await readyConnection(h);
  const first = worker.postMessage({ type: "chunks", taskId: 1, chunks: [{ id: 0, text: "first" }] });
  const second = worker.postMessage({ type: "chunks", taskId: 1, chunks: [{ id: 1, text: "second" }] });
  await assert.rejects(worker.postMessage({ type: "chunks", taskId: 1, chunks: [{ id: 2, text: "rejected" }] }), error => error.code === "worker-backpressure");
  assert.equal(port.sent.filter(message => message.kind === "message").length, 1);
  assert.equal(h.timers.size, 1, "only the sent message may retain an acknowledgement timer");

  port.receive({ kind: "ack", clientId, sequence: 1 });
  await first;
  const third = worker.postMessage({ type: "chunks", taskId: 1, chunks: [{ id: 2, text: "third" }] });
  assert.deepEqual(port.sent.filter(message => message.kind === "message").map(message => message.sequence), [1, 2]);
  assert.equal(h.timers.size, 1);
  port.receive({ kind: "ack", clientId, sequence: 2 });
  await second;
  assert.deepEqual(port.sent.filter(message => message.kind === "message").map(message => message.sequence), [1, 2, 3]);
  port.receive({ kind: "ack", clientId, sequence: 3 });
  await Promise.all([second, third]);
  assert.equal(h.timers.size, 0);
  worker.terminate();
});

test("queued acknowledgement waits remain bounded by the configured task deadline", async () => {
  const h = harness();
  const { worker, port, clientId } = await readyConnection(h);
  const errors = [];
  worker.onerror = event => { errors.push(event); };
  const first = worker.postMessage({ type: "start", taskId: 1, workerTimeoutMs: 30000 });
  const second = worker.postMessage({ type: "chunks", taskId: 1, chunks: [{ id: 0, text: "abc" }] });
  assert.equal(h.timers.size, 1);
  h.advance(9999);
  port.receive({ kind: "ack", clientId, sequence: 1 });
  await first;
  assert.deepEqual(port.sent.filter(message => message.kind === "message").map(message => message.sequence), [1, 2]);
  assert.equal(h.timers.size, 1);
  h.advance(9999);
  await flushPromises();
  assert.deepEqual(errors, []);
  assert.equal(port.disconnected, false);
  port.receive({ kind: "ack", clientId, sequence: 2 });
  await second;
  assert.equal(h.timers.size, 0);
  worker.terminate();
});

test("lost acknowledgements terminate the transport instead of retaining pending messages", async () => {
  const h = harness();
  const { worker, port, clientId } = await readyConnection(h);
  const errors = [];
  worker.onerror = event => { errors.push(event); };
  const first = worker.postMessage({ type: "chunks", taskId: 1, chunks: [{ id: 0, text: "first" }] });
  const second = worker.postMessage({ type: "chunks", taskId: 1, chunks: [{ id: 1, text: "second" }] });
  const firstRejected = assert.rejects(first, error => error.code === "search-timeout");
  const secondRejected = assert.rejects(second, error => error.code === "search-timeout");
  assert.equal(port.sent.filter(message => message.kind === "message").length, 1);
  assert.equal(h.timers.size, 1);
  h.advance(9999);
  await flushPromises();
  assert.equal(errors.length, 0);
  h.advance(1);
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(errors.length, 1);
  assert.equal(port.disconnectCalls, 1);
  assertReleased(h, port);
  port.receive({ kind: "ack", clientId, sequence: 1 });
  assertReleased(h, port);
});

test("handshake failures retain server error details and release the port", async () => {
  const h = harness();
  const { pending, port, clientId } = await beginConnection(h);
  const rejected = assert.rejects(pending, error => {
    assert.equal(error.code, "worker-unavailable");
    assert.equal(error.message, "Cannot create extension worker");
    return true;
  });
  port.receive({ kind: "failure", clientId, code: "worker-unavailable", message: "Cannot create extension worker" });
  await rejected;
  assert.equal(port.disconnectCalls, 1);
  assertReleased(h, port);
});

test("failures from another client do not abort an active handshake", async () => {
  const h = harness();
  const { pending, port, clientId } = await beginConnection(h);
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  port.receive({ kind: "failure", clientId: "unrelated-client", code: "worker-unavailable", message: "Another worker failed" });
  await flushPromises();
  assert.equal(settled, false);
  port.receive({ kind: "ready", clientId });
  const worker = await pending;
  worker.terminate();
});

test("handshake times out at 9000 ms and rejects late replies after releasing resources", async () => {
  const h = harness();
  const { pending, port, clientId } = await beginConnection(h);
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(pending, error => typeof error.message === "string" && error.message.length > 0);
  h.advance(8999);
  await flushPromises();
  assert.equal(settled, false);
  h.advance(1);
  await rejected;
  assert.equal(port.disconnectCalls, 1);
  assertReleased(h, port);
  port.receive({ kind: "ready", clientId });
  assertReleased(h, port);
});

test("disconnect during handshake rejects create and cancels the timeout", async () => {
  const h = harness();
  const { pending, port } = await beginConnection(h);
  const rejected = assert.rejects(pending, error => typeof error.message === "string" && error.message.length > 0);
  port.loseConnection();
  await rejected;
  assertReleased(h, port);
});

test("runtime connect exceptions reject create without leaving timers", async () => {
  const h = harness({ connectError: new Error("Extension context invalidated") });
  await assert.rejects(h.transport.create(), /Extension context invalidated/);
  assert.equal(h.timers.size, 0);
  assert.equal(h.ports.length, 0);
});

test("disconnect after ready reports one error and rejects outstanding acknowledgements", async () => {
  const h = harness();
  const { worker, port } = await readyConnection(h);
  const errors = [];
  worker.onerror = event => { errors.push(event); };
  const pending = worker.postMessage({ type: "chunks", taskId: 1, chunks: [{ id: 0, text: "abc" }] });
  const rejected = assert.rejects(pending);
  port.loseConnection();
  await rejected;
  assert.equal(errors.length, 1);
  assert.equal(typeof errors[0].message, "string");
  assert.ok(errors[0].message.length > 0);
  port.onDisconnect.emit(port);
  assert.equal(errors.length, 1);
  assertReleased(h, port);
  await assert.rejects(Promise.resolve().then(() => worker.postMessage({ type: "finish", taskId: 1 })));
});

test("terminate is idempotent, suppresses errors and rejects all outstanding sends", async () => {
  const h = harness();
  const { worker, port, clientId } = await readyConnection(h);
  const errors = [];
  const messages = [];
  worker.onerror = event => { errors.push(event); };
  worker.onmessage = event => { messages.push(event.data); };
  const first = worker.postMessage({ type: "start", taskId: 1 });
  const second = worker.postMessage({ type: "finish", taskId: 1 });
  const firstRejected = assert.rejects(first);
  const secondRejected = assert.rejects(second);
  worker.terminate();
  worker.terminate();
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(port.disconnectCalls, 1);
  assert.deepEqual(errors, []);
  assertReleased(h, port);

  const sentCount = port.sent.length;
  await assert.rejects(Promise.resolve().then(() => worker.postMessage({ type: "cancel", taskId: 1 })));
  assert.equal(port.sent.length, sentCount);
  port.receive({ kind: "message", clientId, data: { type: "complete", taskId: 1 } });
  port.receive({ kind: "ack", clientId, sequence: 1 });
  port.onDisconnect.emit(port);
  assert.deepEqual(messages, []);
  assert.deepEqual(errors, []);
});

test("concurrent clients retain independent handshakes, messages and acknowledgements", async () => {
  const h = harness();
  const first = await beginConnection(h);
  const second = await beginConnection(h);
  assert.notEqual(first.clientId, second.clientId);
  assert.notEqual(first.port, second.port);
  first.port.receive({ kind: "ready", clientId: second.clientId });
  second.port.receive({ kind: "ready", clientId: first.clientId });
  first.port.receive({ kind: "ready", clientId: first.clientId });
  second.port.receive({ kind: "ready", clientId: second.clientId });
  const firstWorker = await first.pending;
  const secondWorker = await second.pending;
  const firstMessages = [];
  const secondMessages = [];
  firstWorker.onmessage = event => { firstMessages.push(event.data); };
  secondWorker.onmessage = event => { secondMessages.push(event.data); };
  first.port.receive({ kind: "message", clientId: second.clientId, data: "wrong" });
  second.port.receive({ kind: "message", clientId: first.clientId, data: "wrong" });
  first.port.receive({ kind: "message", clientId: first.clientId, data: "first" });
  second.port.receive({ kind: "message", clientId: second.clientId, data: "second" });
  assert.deepEqual(firstMessages, ["first"]);
  assert.deepEqual(secondMessages, ["second"]);

  const firstSend = firstWorker.postMessage({ type: "finish", taskId: 1 });
  const secondSend = secondWorker.postMessage({ type: "finish", taskId: 2 });
  first.port.receive({ kind: "ack", clientId: first.clientId, sequence: 1 });
  second.port.receive({ kind: "ack", clientId: second.clientId, sequence: 1 });
  await Promise.all([firstSend, secondSend]);
  firstWorker.terminate();
  assert.equal(second.port.disconnected, false);
  secondWorker.terminate();
  assertReleased(h, first.port);
  assertReleased(h, second.port);
});

test("a synchronous send exception rejects the send and permits cleanup", async () => {
  const h = harness();
  const { worker, port } = await readyConnection(h);
  port.sendError = new Error("Disconnected while sending a chunk");
  await assert.rejects(Promise.resolve().then(() => worker.postMessage({ type: "chunks", taskId: 1, chunks: [] })), /Disconnected while sending a chunk/);
  worker.terminate();
  assertReleased(h, port);
});

test("valid batches discard unknown fields and cyclic objects before port serialization", async () => {
  const h = harness();
  const { worker, port, clientId } = await readyConnection(h);
  const cycle = {};
  cycle.self = cycle;
  const chunk = { id: 0, text: "needle", node: cycle, unknown: cycle };
  const data = { type: "chunks", taskId: 0, batchId: 7, chunks: [chunk], unknown: cycle };
  Object.defineProperty(data, "unsafeGetter", { enumerable: true, get() { throw new Error("Unknown fields must not be read"); } });
  Object.defineProperty(chunk, "unsafeGetter", { enumerable: true, get() { throw new Error("Unknown chunk fields must not be read"); } });
  const pending = worker.postMessage(data);
  const sent = port.sent.find(message => message.kind === "message");
  assert.deepEqual(sent.data, { type: "chunks", taskId: 0, batchId: 7, chunks: [{ id: 0, text: "needle" }] });
  assert.equal(sent.sequence, 1);
  port.receive({ kind: "ack", clientId, sequence: 1 });
  await pending;
  worker.terminate();
  assertReleased(h, port);
});

test("queued batches retain a snapshot of approved fields instead of mutable caller objects", async () => {
  const h = harness();
  const { worker, port, clientId } = await readyConnection(h);
  const first = worker.postMessage({ type: "start", taskId: 8, pattern: "needle", flags: "g" });
  const chunk = { id: 1, text: "original" };
  const data = { type: "chunks", taskId: 8, batchId: 1, chunks: [chunk] };
  const second = worker.postMessage(data);
  assert.equal(port.sent.filter(message => message.kind === "message").length, 1);
  chunk.id = 99;
  chunk.text = "mutated";
  data.taskId = 99;
  data.batchId = 99;
  data.chunks.push({ id: 2, text: "appended after enqueue" });
  port.receive({ kind: "ack", clientId, sequence: 1 });
  await first;
  const sent = port.sent.filter(message => message.kind === "message");
  assert.deepEqual(sent[1].data, { type: "chunks", taskId: 8, batchId: 1, chunks: [{ id: 1, text: "original" }] });
  port.receive({ kind: "ack", clientId, sequence: 2 });
  await second;
  worker.terminate();
});

async function assertRejectedBeforeSend(h, worker, port, data, label) {
  const sentCount = port.sent.length;
  await assert.rejects(worker.postMessage(data), error => error.code === "worker-protocol-error", label);
  assert.equal(port.sent.length, sentCount, `${label}: rejected input must not reach the port`);
  assert.equal(h.timers.size, 0, `${label}: rejected input must not retain a timer`);
  assert.equal(port.disconnected, false, `${label}: rejecting an input must preserve the usable transport`);
}

test("invalid task IDs and scalar fields are rejected without consuming sequences", async () => {
  const h = harness();
  const { worker, port, clientId } = await readyConnection(h);
  for (const taskId of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null, undefined]) {
    await assertRejectedBeforeSend(h, worker, port, { type: "start", taskId, pattern: "a" }, `taskId ${String(taskId)}`);
  }
  const invalid = [
    [null, "missing message"],
    [{ type: "search", taskId: 0 }, "unsupported message type"],
    [{ type: "start", taskId: 0, pattern: {} }, "object pattern"],
    [{ type: "start", taskId: 0, flags: ["g"] }, "array flags"],
    [{ type: "start", taskId: 0, mode: () => "regex" }, "function mode"],
    [{ type: "start", taskId: 0, wholeWord: { value: true } }, "object wholeWord"],
    [{ type: "start", taskId: 0, pattern: Symbol("pattern") }, "symbol pattern"],
    [{ type: "start", taskId: 0, maxMatches: 1n }, "bigint maxMatches"],
    [{ type: "start", taskId: 0, maxMatches: NaN }, "NaN maxMatches"],
    [{ type: "start", taskId: 0, maxMatches: Infinity }, "infinite maxMatches"],
    [{ type: "start", taskId: 0, maxMatches: -Infinity }, "negative infinite maxMatches"],
    [{ type: "start", taskId: 0, pattern: "a".repeat(4096001) }, "oversized pattern"],
    [{ type: "start", taskId: 0, mode: "a".repeat(129) }, "oversized scalar string"]
  ];
  for (const [data, label] of invalid) await assertRejectedBeforeSend(h, worker, port, data, label);
  const pending = worker.postMessage({ type: "start", taskId: 0, pattern: "a", flags: "g" });
  assert.equal(port.sent.at(-1).sequence, 1, "invalid inputs must not consume a sequence");
  port.receive({ kind: "ack", clientId, sequence: 1 });
  await pending;
  worker.terminate();
  assertReleased(h, port);
});

test("malformed and oversized batches are rejected before sending or retaining resources", async () => {
  const h = harness();
  const { worker, port, clientId } = await readyConnection(h);
  const invalid = [
    [{ type: "chunks", taskId: 0 }, "missing chunks"],
    [{ type: "chunks", taskId: 0, chunks: {} }, "non-array chunks"],
    [{ type: "chunks", taskId: 0, chunks: [null] }, "null chunk"],
    [{ type: "chunks", taskId: 0, chunks: [{ id: -1, text: "a" }] }, "negative chunk id"],
    [{ type: "chunks", taskId: 0, chunks: [{ id: 1.5, text: "a" }] }, "fractional chunk id"],
    [{ type: "chunks", taskId: 0, chunks: [{ id: Number.MAX_SAFE_INTEGER + 1, text: "a" }] }, "unsafe chunk id"],
    [{ type: "chunks", taskId: 0, chunks: [{ id: "1", text: "a" }] }, "string chunk id"],
    [{ type: "chunks", taskId: 0, chunks: [{ id: 0, text: {} }] }, "non-string chunk text"],
    [{ type: "chunks", taskId: 0, chunks: Array.from({ length: 2001 }, (_, id) => ({ id, text: "a" })) }, "too many nodes"],
    [{ type: "chunks", taskId: 0, chunks: [{ id: 0, text: "a".repeat(16 * 1024 * 1024 + 1) }] }, "too many characters in one node"],
    [{ type: "chunks", taskId: 0, chunks: [{ id: 0, text: "a".repeat(8 * 1024 * 1024) }, { id: 1, text: "b".repeat(8 * 1024 * 1024 + 1) }] }, "too many aggregate characters"]
  ];
  for (const [data, label] of invalid) await assertRejectedBeforeSend(h, worker, port, data, label);
  const pending = worker.postMessage({ type: "chunks", taskId: 0, chunks: [{ id: 0, text: "accepted" }] });
  assert.equal(port.sent.at(-1).sequence, 1);
  port.receive({ kind: "ack", clientId, sequence: 1 });
  await pending;
  worker.terminate();
  assertReleased(h, port);
});

test("batches and patterns exactly at the documented limits remain accepted", async () => {
  const h = harness();
  const { worker, port, clientId } = await readyConnection(h);
  const start = worker.postMessage({ type: "start", taskId: 0, pattern: "a".repeat(4096000), flags: "g" });
  assert.equal(port.sent.at(-1).data.pattern.length, 4096000);
  port.receive({ kind: "ack", clientId, sequence: 1 });
  await start;
  const chunks = Array.from({ length: 2000 }, (_, id) => ({ id, text: id === 0 ? "a".repeat(16 * 1024 * 1024) : "" }));
  const batch = worker.postMessage({ type: "chunks", taskId: 0, chunks });
  assert.equal(port.sent.at(-1).data.chunks.length, 2000);
  assert.equal(port.sent.at(-1).data.chunks[0].text.length, 16 * 1024 * 1024);
  assert.equal(port.sent.at(-1).data.pattern, undefined, "large query is not copied into each text batch");
  assert.equal(port.sent.at(-1).sequence, 2);
  port.receive({ kind: "ack", clientId, sequence: 2 });
  await batch;
  worker.terminate();
  assertReleased(h, port);
});

test("a pattern cannot be repeated in chunk, finish, or cancel messages", async () => {
  const h = harness();
  const { worker, port } = await readyConnection(h);
  for (const type of ["chunks", "finish", "cancel"]) {
    await assertRejectedBeforeSend(h, worker, port, { type, taskId: 0, pattern: "a".repeat(10000), chunks: [] }, type);
  }
  worker.terminate();
  assertReleased(h, port);
});

test("stream ranges accept absolute positions beyond 32-bit offsets and discard unrelated metadata", async () => {
  const h = harness();
  const { worker, port, clientId } = await readyConnection(h);
  const offset = 40 * 1024 * 1024 * 1024;
  const stream = { runId: 123, offset, ownedStart: offset + 1, ownedEnd: offset + 3, first: false, last: true,
    junk: "x".repeat(1000000) };
  const batch = worker.postMessage({ type: "chunks", taskId: 0, chunks: [{ id: 3, text: "abcd", stream, junk: stream.junk }] });
  assert.deepEqual(port.sent.at(-1).data.chunks[0], { id: 3, text: "abcd", stream: {
    runId: 123, offset, ownedStart: offset + 1, ownedEnd: offset + 3, first: false, last: true
  } });
  port.receive({ kind: "ack", clientId, sequence: 1 });
  await batch;
  worker.terminate();
  assertReleased(h, port);
});

test("malformed stream ranges are rejected before cloning or allocating a transport sequence", async () => {
  const h = harness();
  const { worker, port } = await readyConnection(h);
  const valid = { runId: 0, offset: 10, ownedStart: 11, ownedEnd: 13, first: false, last: false };
  const invalid = [null, [], "stream", {},
    { ...valid, runId: -1 }, { ...valid, runId: "1" }, { ...valid, runId: 1.5 },
    { ...valid, offset: -1 }, { ...valid, offset: NaN }, { ...valid, offset: Infinity },
    { ...valid, ownedStart: 9 }, { ...valid, ownedStart: 1.5 }, { ...valid, ownedEnd: 10 },
    { ...valid, ownedEnd: 15 }, { ...valid, first: 0 }, { ...valid, last: undefined },
    { ...valid, offset: Number.MAX_SAFE_INTEGER - 2, ownedStart: Number.MAX_SAFE_INTEGER - 1, ownedEnd: Number.MAX_SAFE_INTEGER }
  ];
  for (const stream of invalid) {
    await assertRejectedBeforeSend(h, worker, port, { type: "chunks", taskId: 0, chunks: [{ id: 0, text: "abcd", stream }] }, JSON.stringify(stream));
  }
  worker.terminate();
  assertReleased(h, port);
});

test("a configured long start permits validation beyond ten seconds and caps every ACK wait", async () => {
  const h = harness();
  const { worker, port, clientId } = await readyConnection(h);
  for (const workerTimeoutMs of [0, -1, 1.5, NaN, Infinity, 900001, "900000", null]) {
    await assertRejectedBeforeSend(h, worker, port, { type: "start", taskId: 0, pattern: "a", workerTimeoutMs }, String(workerTimeoutMs));
  }
  await assertRejectedBeforeSend(h, worker, port, { type: "start", taskId: 0, pattern: "a", analyzeInWorker: "true" }, "non-boolean worker analysis");
  const start = worker.postMessage({ type: "start", taskId: 0, pattern: "a", workerTimeoutMs: 900000, analyzeInWorker: true, policyStatus: "deferred" });
  assert.equal([...h.timers.values()][0].due, 900000, "an individual ACK wait is capped at fifteen minutes");
  h.advance(12000);
  assert.equal(port.disconnected, false, "large source validation is not cut off at the old ten-second transport deadline");
  port.receive({ kind: "ack", clientId, sequence: 1 });
  await start;
  const batch = worker.postMessage({ type: "chunks", taskId: 0, chunks: [] });
  assert.equal([...h.timers.values()][0].due, 900000, "later ACK uses the original deadline remaining without a grace period or restart");
  const rejected = assert.rejects(batch, error => error.code === "search-timeout");
  h.advance(887999);
  assert.equal(port.disconnected, false);
  h.advance(1);
  await rejected;
  assertReleased(h, port);
});

test("default start uses a bounded deadline and later messages cannot replace its timeout", async () => {
  const h = harness();
  const { worker, port, clientId } = await readyConnection(h);
  const start = worker.postMessage({ type: "start", taskId: 0, pattern: "a" });
  assert.equal([...h.timers.values()][0].due, 5000);
  h.advance(1000);
  port.receive({ kind: "ack", clientId, sequence: 1 });
  await start;
  await assertRejectedBeforeSend(h, worker, port, { type: "chunks", taskId: 0, chunks: [], workerTimeoutMs: 900000 }, "late timeout change");
  const batch = worker.postMessage({ type: "chunks", taskId: 0, chunks: [] });
  assert.equal([...h.timers.values()][0].due, 5000);
  const rejected = assert.rejects(batch, error => error.code === "search-timeout");
  h.advance(4000);
  await rejected;
  assertReleased(h, port);
});

test("one millisecond of remaining task time is accepted without increasing the deadline", async () => {
  const h = harness();
  const { worker, port, clientId } = await readyConnection(h);
  const start = worker.postMessage({ type: "start", taskId: 0, pattern: "a", workerTimeoutMs: 1 });
  assert.equal([...h.timers.values()][0].due, 1);
  port.receive({ kind: "ack", clientId, sequence: 1 });
  await start;
  const batch = worker.postMessage({ type: "chunks", taskId: 0, chunks: [] });
  assert.equal([...h.timers.values()][0].due, 1);
  const rejected = assert.rejects(batch, error => error.code === "search-timeout");
  h.advance(1);
  await rejected;
  assertReleased(h, port);
});

test("old node and chunk limits are ignored while other start options cannot change mid-task", async () => {
  const h = harness();
  const { worker, port, clientId } = await readyConnection(h);
  const start = worker.postMessage({ type: "start", taskId: 0, pattern: "a", workerTimeoutMs: 1000,
    maxChunkMs: 0, maxNodeChars: "obsolete", maxScannedNodes: 1, extra: "x".repeat(1000000) });
  assert.deepEqual(port.sent.at(-1).data, { type: "start", taskId: 0, pattern: "a", workerTimeoutMs: 1000 });
  port.receive({ kind: "ack", clientId, sequence: 1 });
  await start;
  for (const changed of [{ flags: "i" }, { mode: "literal" }, { maxScannedChars: 1 }, { acknowledged: true }, { analyzeInWorker: true }]) {
    await assertRejectedBeforeSend(h, worker, port, { type: "chunks", taskId: 0, chunks: [], ...changed }, JSON.stringify(changed));
  }
  const batch = worker.postMessage({ type: "chunks", taskId: 0, chunks: [], maxChunkMs: 1, maxNodeChars: 1 });
  assert.deepEqual(port.sent.at(-1).data, { type: "chunks", taskId: 0, chunks: [] });
  port.receive({ kind: "ack", clientId, sequence: 2 });
  await batch;
  worker.terminate();
  assertReleased(h, port);
});

test("complete-source fragments preserve four range fields and forward canonical source ACKs", async () => {
  const h = harness();
  const { worker, port, clientId } = await readyConnection(h);
  const received = [];
  worker.onmessage = event => { received.push(event.data); };
  const first = worker.postMessage({ type: "chunks", taskId: 0, batchId: 0, chunks: [{ id: 3, text: "ab",
    source: { runId: 3, offset: 0, first: true, last: false, junk: "x".repeat(1000000) }, junk: "discard" }] });
  assert.deepEqual(port.sent.at(-1).data.chunks, [{ id: 3, text: "ab", source: { runId: 3, offset: 0, first: true, last: false } }]);
  port.receive({ kind: "ack", clientId, sequence: 1 });
  await first;
  const last = worker.postMessage({ type: "chunks", taskId: 0, batchId: 1, chunks: [{ id: 4, text: "cd",
    source: { runId: 3, offset: 2, first: false, last: true } }] });
  assert.deepEqual(port.sent.at(-1).data.chunks, [{ id: 4, text: "cd", source: { runId: 3, offset: 2, first: false, last: true } }]);
  port.receive({ kind: "ack", clientId, sequence: 2 });
  await last;
  const sourceAck = { type: "ack", taskId: 0, batchId: 1, matchedChunkIds: [3],
    matchedIntervals: [{ chunkId: 3, start: 1, end: 4 }], completedSourceIds: [3], scannedChars: 4 };
  port.receive({ kind: "message", clientId, data: sourceAck });
  assert.deepEqual(received, [sourceAck], "a source ACK may identify the first fragment from an earlier batch");
  worker.terminate();
  assertReleased(h, port);
});

test("malformed or conflicting complete-source ranges never reach the port", async () => {
  const h = harness();
  const { worker, port, clientId } = await readyConnection(h);
  const valid = { runId: 3, offset: 0, first: true, last: false };
  const invalid = [null, [], {}, "source", { ...valid, runId: -1 }, { ...valid, runId: "3" },
    { ...valid, runId: 4 }, { ...valid, offset: 1 }, { ...valid, offset: -1 },
    { ...valid, offset: 1.5 }, { ...valid, first: 1 }, { ...valid, last: undefined },
    { ...valid, first: false, offset: Infinity }, { ...valid, first: false, offset: Number.MAX_SAFE_INTEGER - 1 }];
  for (const source of invalid) {
    await assertRejectedBeforeSend(h, worker, port, { type: "chunks", taskId: 0, chunks: [{ id: 3, text: "abcd", source }] }, JSON.stringify(source));
  }
  await assertRejectedBeforeSend(h, worker, port, { type: "chunks", taskId: 0, chunks: [{ id: 3, text: "abcd", source: valid,
    stream: { runId: 3, offset: 0, ownedStart: 0, ownedEnd: 4, first: true, last: true } }] }, "source and stream cannot coexist");
  const offset = 40 * 1024 * 1024 * 1024;
  const continuation = worker.postMessage({ type: "chunks", taskId: 0, chunks: [{ id: 4, text: "abcd",
    source: { runId: 3, offset, first: false, last: true } }] });
  assert.equal(port.sent.at(-1).data.chunks[0].source.offset, offset, "protocol positions are safe integers rather than 32-bit counters");
  port.receive({ kind: "ack", clientId, sequence: 1 });
  await continuation;
  worker.terminate();
  assertReleased(h, port);
});

test("a terminal timeout rejects in-flight and queued ACK promises with the same 504 cause", async () => {
  for (const fields of [{ code: "search-timeout" }, { numericCode: 504 }]) {
    const h = harness();
    const { worker, port, clientId } = await readyConnection(h);
    const received = [];
    worker.onmessage = event => { received.push(event.data); };
    const start = worker.postMessage({ type: "start", taskId: 1, pattern: "a", workerTimeoutMs: 30000 });
    const chunks = worker.postMessage({ type: "chunks", taskId: 1, chunks: [{ id: 0, text: "a" }] });
    const rejectedStart = assert.rejects(start, error => error.code === "search-timeout" && error.numericCode === 504);
    const rejectedChunks = assert.rejects(chunks, error => error.code === "search-timeout" && error.numericCode === 504);
    const terminal = { type: "error", taskId: 1, message: "Search timed out.", ...fields };
    port.receive({ kind: "message", clientId, data: terminal });
    await Promise.all([rejectedStart, rejectedChunks]);
    assert.deepEqual(received, [terminal]);
    assert.equal(port.disconnectCalls, 1);
    assert.equal(port.sent.filter(message => message.kind === "message").length, 1, "the queued batch is never sent after timeout");
    assertReleased(h, port);
  }
});
