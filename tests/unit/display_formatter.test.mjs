import assert from "node:assert/strict";
import { readRuntimeSource as readFile } from "../fixtures/runtime_source.mjs";
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
test("limited scans with no matches remain visibly incomplete", () => {
  assert.equal(fmt.format({ status: "limited", renderedMatches: 0, limited: true }).count, "0+");
});
test("unknown prototype status names do not render functions or error badges", () => {
  for (const status of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
    const result = fmt.format({ status, errorCode: 503 });
    assert.equal(result.status, "");
    assert.equal(result.isError, false);
    assert.equal(result.code, "");
  }
});
test("invalid counts are omitted and stale navigation indices cannot exceed the total", () => {
  for (const totalMatches of [Infinity, NaN, -1, 1.5, "50"]) assert.equal(fmt.format({ totalMatches }).count, "");
  assert.equal(fmt.format({ totalMatches: 5, currentIndex: 20 }).count, "5 / 5");
  assert.equal(fmt.format({ totalMatches: 5, currentIndex: "2" }).count, "0 / 5");
});

const translations = {
  "display.invalid": "正则有误",
  "display.invalidDetail": "检查括号和转义，或改用普通文本。",
  "display.error": "查找失败",
  "display.errorDetail": "请重试，或重新加载扩展并刷新页面。",
  "display.searching": "查找中",
  "display.countPosition": "第 {current} 处，共 {total} 处",
  "display.countPositionLimited": "第 {current} 处，至少 {total} 处",
  "display.countNone": "未找到",
  "display.countNoneLimited": "已扫描区域内未找到",
  "display.limitDetail": "已标记 {count} 处。可在设置中提高上限。",
  "display.engineDetail": "匹配引擎：{engine}"
};
const translate = (key, params = {}) => {
  const template = translations[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_match, name) => String(params[name] ?? ""));
};

test("localized count titles preserve exact and incomplete result meanings", () => {
  const complete = fmt.format({ status: "done", totalMatches: 27, currentIndex: 2 }, translate);
  assert.equal(complete.count, "3 / 27");
  assert.equal(complete.countTitle, "第 3 处，共 27 处");
  const limited = fmt.format({ status: "limited", totalMatches: 50, currentIndex: 999, limited: true }, translate);
  assert.equal(limited.countTitle, "第 50 处，至少 50 处");
  assert.equal(fmt.format({ status: "done", totalMatches: 0 }, translate).countTitle, "未找到");
  assert.equal(fmt.format({ status: "limited", totalMatches: 0, limited: true }, translate).countTitle, "已扫描区域内未找到");
  assert.equal(fmt.format({ status: "idle" }, translate).countTitle, "");
});

test("localized error and transient UI does not expose internal English diagnostics", () => {
  const invalid = fmt.format({ status: "invalid", message: "Invalid Regex", detail: "Invalid group: (?bad" }, translate);
  assert.equal(invalid.status, "正则有误");
  assert.equal(invalid.detail, "检查括号和转义，或改用普通文本。");
  const failure = fmt.format({ status: "error", detail: "CSP denied" }, translate);
  assert.equal(failure.status, "查找失败");
  assert.equal(failure.detail, "请重试，或重新加载扩展并刷新页面。");
  assert.equal(fmt.format({ status: "searching", message: "Scanning nodes" }, translate).status, "查找中");
  assert.equal(fmt.format({ status: "searching", message: "Scanning nodes" }).status, "Scanning nodes");
  assert.equal(fmt.format({ status: "error", detail: "CSP denied" }).detail, "CSP denied");
});

test("localized limit and engine descriptions receive validated count values", () => {
  assert.equal(fmt.format({ status: "limited", renderedMatches: 5, limited: true }, translate).detail, "已标记 5 处。可在设置中提高上限。");
  assert.equal(fmt.format({ status: "limited", renderedMatches: "untrusted" }, translate).detail, "");
  assert.equal(fmt.format({ status: "done", engine: "ecmascript-dev" }, translate).detail, "匹配引擎：ecmascript-dev");
});

test("translator failure cannot hide errors or replace count strings", () => {
  for (const broken of [key => key, () => null, () => "", () => { throw new Error("unavailable"); }]) {
    const display = fmt.format({ status: "invalid", totalMatches: 5, currentIndex: 0, detail: "internal failure" }, broken);
    assert.equal(display.status, "Invalid Regex");
    assert.equal(display.detail, "Check parentheses and escapes, or use plain text.");
    assert.equal(display.count, "1 / 5");
    assert.equal(display.countTitle, "Match 1 of 5");
  }
});

test("named limit feedback only reports the basic user budgets", () => {
  const cases = [
    ["duration", "status.timeout", "status.timeoutHint"],
    ["max-matches", "status.matchLimit", "status.limitHint"]
  ];
  for (const [limitReason, status, detail] of cases) {
    assert.deepEqual(fmt.limitFeedback({ status: "limited", limitReason }, key => "translated:" + key), {
      status: "translated:" + status, detail: "translated:" + detail
    });
  }
  for (const limitReason of ["max-chunk-ms", "regex-block-limit", "max-retained-chars", "max-retained-segments", "max-retained-control-chars", "nodes", "root-limit", "run-size"]) {
    assert.equal(fmt.limitFeedback({ limitReason }, key => "translated:" + key).status, "translated:status.partialResults");
  }
});

test("only an actual character-budget reason displays the scan limit and validated scan counts", () => {
  for (const limitReason of ["characters", "max-scanned-chars"]) {
    const calls = [];
    const display = fmt.limitFeedback({ limitReason, scannedChars: 33_554_432_000, scanLimitChars: 67_108_864_000 }, (key, params) => {
      calls.push([key, params]);
      return "translated:" + key;
    });
    assert.equal(display.status, "translated:status.scanLimit");
    assert.deepEqual(calls[1], ["status.scanBudgetHint", { scanned: 33_554_432_000, limit: 67_108_864_000 }]);
  }
  const fallback = fmt.limitFeedback({ limitReason: "characters", scannedChars: 12, scanLimitChars: 20 });
  assert.equal(fallback.detail, "12 / 20 characters scanned. Raise the scan budget in settings or narrow the scope");
});

test("multiple limit reasons select a consistent priority and retain actual collector reasons", () => {
  const translated = key => "translated:" + key;
  assert.equal(fmt.limitFeedback({ limitReason: "characters, max-matches, duration" }, translated).status, "translated:status.timeout");
  assert.equal(fmt.limitFeedback({ limitReason: "entries,characters, regex-block-limit" }, translated).status, "translated:status.scanLimit");
  assert.equal(fmt.limitFeedback({ limitReason: "max-matches, max-retained-segments" }, translated).status, "translated:status.matchLimit");
  assert.equal(fmt.limitFeedback({ limitReason: "characters, max-matches" }, translated).status, "translated:status.matchLimit");
  assert.equal(fmt.limitFeedback({ limitReason: "collection-budget", stats: { reasons: ["segments"] } }, translated).status, "translated:status.partialResults");
});

test("limit feedback keeps meaningful reasons beyond the former 32-item prefix", () => {
  const reasons = [...Array(64).fill('unknown-internal-reason'), 'characters', 'duration'];
  assert.equal(fmt.limitFeedback({ stats: { reasons } }).status, 'Search timed out');
  assert.equal(fmt.limitFeedback({ limitReason: [...Array(40).fill('unknown'), 'characters'].join(',') }).status, 'Scan limit');
});

test("unknown or malformed reasons show partial results without exposing diagnostic slugs", () => {
  for (const limitReason of [undefined, null, "", "collection-budget", "unknown-internal-error", "constructor", "__proto__", "toString", "CHARACTERS", { toString: () => "characters" }, "characters," + "x".repeat(2000)]) {
    const display = fmt.limitFeedback({ limitReason });
    assert.equal(display.status, "Partial results");
    assert.equal(display.detail, "Some page content was not searched; narrow the scope or try again");
  }
});

test("invalid scan counts stay unknown rather than becoming false zero values", () => {
  for (const bad of [undefined, "20", -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    let seen;
    fmt.limitFeedback({ limitReason: "max-scanned-chars", scannedChars: bad, scanLimitChars: bad }, (key, params) => {
      if (key === "status.scanBudgetHint") seen = params;
      return "translated:" + key;
    });
    assert.deepEqual(seen, { scanned: "?", limit: "?" });
  }
});

test("limited feedback remains useful when the translator fails", () => {
  for (const translate of [key => key, () => null, () => "", () => { throw new Error("unavailable"); }]) {
    assert.deepEqual(fmt.limitFeedback({ limitReason: "duration" }, translate), {
      status: "Search timed out", detail: "Narrow the scope or use a more specific query"
    });
  }
});
