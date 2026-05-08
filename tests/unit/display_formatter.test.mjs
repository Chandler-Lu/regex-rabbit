import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile("domain/display_formatter.js", "utf8");
const scope = {};
new Function("globalThis", source)(scope);
const fmt = scope.RRDisplayFormatter;

test("idle → empty", () => {
  const d = fmt.format({});
  assert.equal(d.count, ""); assert.equal(d.status, ""); assert.equal(d.isError, false);
});
test("done with matches", () => {
  const d = fmt.format({ status: "done", totalMatches: 27, currentIndex: 2 });
  assert.equal(d.count, "3 / 27");
});
test("limited → + suffix", () => {
  const d = fmt.format({ status: "limited", totalMatches: 50, limited: true });
  assert.equal(d.count, "0 / 50+");
});
test("error + code", () => {
  const d = fmt.format({ status: "error", errorCode: 503, errorSlug: "worker-crashed" });
  assert.equal(d.code, "RR503 worker-crashed"); assert.equal(d.isError, true);
});
test("invalid", () => {
  const d = fmt.format({ status: "invalid", errorCode: 400, errorSlug: "pattern-invalid-syntax" });
  assert.equal(d.status, "Invalid Regex"); assert.equal(d.isError, true);
});
test("unsafe", () => assert.equal(fmt.format({ status: "unsafe", errorCode: 451 }).status, "Unsafe Regex"));
test("timeout", () => assert.equal(fmt.format({ status: "timeout", errorCode: 504 }).status, "Timeout"));
test("engine detail", () => assert.ok(fmt.format({ status: "done", engine: "ecmascript-dev" }).detail.includes("Engine:")));
test("renderedMatches fallback", () => {
  assert.equal(fmt.format({ status: "done", renderedMatches: 5 }).count, "0 / 5");
});
