import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile("content_script.js", "utf8");

test("initial result is scrolled into view after rendering", () => {
  assert.ok(source.includes('reason: "initial"'));
  assert.equal(source.includes("highlightCurrent(false)"), false);
});

test("result navigation uses deterministic scroll with retry", () => {
  assert.ok(source.includes('behavior: "auto"'));
  assert.ok(source.includes("retryScrollIfNeeded"));
  assert.ok(source.includes("isMostlyInViewport"));
});

test("pending scroll work is cancelled when highlights are removed", () => {
  assert.ok(source.includes("function cancelPendingScroll()"));
  assert.ok(source.includes("cancelPendingScroll();"));
});

test("only one current mark is kept active before scrolling", () => {
  assert.ok(source.includes("function clearCurrentMarks(activeMark)"));
  assert.ok(source.includes("clearCurrentMarks(m);"));
});
