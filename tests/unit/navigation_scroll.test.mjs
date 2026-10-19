import assert from 'node:assert/strict';
import { readRuntimeSourceSync as readFileSync } from '../fixtures/runtime_source.mjs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

function setup(t) {
  const dom = new JSDOM('<input id="page-control"><p>first</p><p>second</p>', { url: 'https://example.com', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window, frames = new Map(), searches = [], scrolls = [];
  let nextFrame = 0, onMessage, generation = 0, busy = false, holdNext = false, finishHeld;
  w.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
  w.cancelAnimationFrame = id => frames.delete(id);
  w.chrome = { runtime: { id: 'extension', lastError: null, onMessage: { addListener(listener) { onMessage = listener; } } },
    storage: { sync: { get(defaults, callback) { callback({ ...defaults, uiLanguage: "zh-CN" }); } }, onChanged: { addListener() {} } } };
  w.RRWorkerManager = { dispose() {} };
  w.RRHighlightEngine = { configure() {}, setCurrent(mark) { return mark.isConnected; } };
  let marks = Array.from(w.document.querySelectorAll('p'), (p, index) => ({ node: p.firstChild, start: 0, end: p.textContent.length,
    isConnected: true, classList: { add() {}, remove() {} }, scrollIntoView(options) { scrolls.push({ index, options }); } }));
  w.RRSearchController = { create(options) {
    function clear() { generation++; busy = false; options.onResults([], { reason: 'clear' }); }
    return { clear, dispose: clear, isBusy: () => busy, getGeneration: () => generation, getState: () => ({ status: 'idle' }),
      async search(pattern, query) {
        searches.push({ pattern, reason: query.reason }); clear(); busy = !!pattern;
        const currentGeneration = generation;
        if (holdNext) { holdNext = false; await new Promise(resolve => { finishHeld = resolve; }); }
        if (generation !== currentGeneration) return;
        busy = false;
        options.onResults(pattern ? marks : [], { reason: query.reason, limited: false });
        options.onState({ status: pattern ? 'done' : 'idle', renderedMatches: pattern ? marks.length : 0 });
      } };
  } };
  for (const file of ['infra/ui_i18n.js', 'infra/toolbar_position.js', 'domain/runtime_config.js', 'domain/display_formatter.js', 'infra/page_visibility.js', 'infra/selection_capture.js', 'infra/search_toolbar.js', 'content_script.js']) w.eval(readFileSync(file, 'utf8'));
  function toggle() { onMessage({ action: 'toggleSearch' }, { id: 'extension' }, () => {}); }
  function flushFrames() { const pending = Array.from(frames.values()); frames.clear(); pending.forEach(callback => callback()); }
  w.document.querySelector('#page-control').focus(); toggle(); flushFrames();
  const input = w.document.querySelector('#regex-search-input');
  return { w, input, frames, scrolls, searches, toggle, flushFrames,
    invalidateSecond(shrink = false) {
      const first = marks[0], second = marks[1]; second.isConnected = false;
      if (shrink) { marks = [first]; return; }
      const prefix = w.document.createElement('p'); prefix.textContent = 'prefix'; w.document.body.prepend(prefix);
      marks = [{ ...first, node: prefix.firstChild, scrollIntoView(options) { scrolls.push({ index: 2, options }); } }, first, { ...second, isConnected: true }];
    },
    holdNextSearch() { holdNext = true; }, finishSearch() { finishHeld(); },
    type() { input.value = 'query'; input.dispatchEvent(new w.Event('input', { bubbles: true })); },
    enter() { input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); } };
}
async function waitUntil(predicate) {
  const limit = Date.now() + 2000;
  while (!predicate()) { assert.ok(Date.now() < limit, 'UI operation did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('typing and changing query options mark results without moving the page', async t => {
  const s = setup(t); s.type(); await waitUntil(() => s.searches.length === 1); s.flushFrames();
  assert.equal(s.searches[0].reason, 'typing'); assert.equal(s.scrolls.length, 0);
  s.w.document.querySelector('#regex-mode-literal').click(); await waitUntil(() => s.searches.length === 2); s.flushFrames();
  assert.equal(s.searches[1].reason, 'options'); assert.equal(s.scrolls.length, 0);
});

test('Enter locates the first ready result once, then navigates to the next result', async t => {
  const s = setup(t); s.type(); await waitUntil(() => s.searches.length === 1);
  s.enter(); s.flushFrames(); assert.equal(s.scrolls.length, 1); assert.equal(s.scrolls[0].index, 0);
  assert.equal(s.scrolls[0].options.behavior, 'instant');
  assert.equal(s.scrolls[0].options.block, 'center');
  assert.equal(s.scrolls[0].options.inline, 'center');
  s.enter(); s.flushFrames(); assert.equal(s.scrolls.length, 2); assert.equal(s.scrolls[1].index, 1);
  await new Promise(resolve => setTimeout(resolve, 220)); s.flushFrames(); assert.equal(s.scrolls.length, 2);
});

test('refreshing an unchanged current match preserves the next Enter navigation', async t => {
  const s = setup(t); s.type(); await waitUntil(() => s.searches.length === 1);
  s.enter(); s.flushFrames(); assert.equal(s.scrolls[0].index, 0);
  s.w.document.querySelector('#regex-mode-literal').click(); await waitUntil(() => s.searches.length === 2);
  s.flushFrames(); assert.equal(s.scrolls.length, 1);
  s.enter(); s.flushFrames(); assert.equal(s.scrolls[1].index, 1);
  s.type(); await waitUntil(() => s.searches.length === 3);
  s.enter(); s.flushFrames(); assert.equal(s.scrolls[2].index, 0);
});

test('changing an option consumes the pending typing query once', async t => {
  const s = setup(t); s.type(); s.w.document.querySelector('#regex-mode-literal').click();
  await waitUntil(() => s.searches.length === 1);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(s.searches.length, 1); assert.equal(s.searches[0].reason, 'options');
});

test('Enter during a passive refresh waits for its next match instead of restarting at the first', async t => {
  const s = setup(t); s.type(); await waitUntil(() => s.searches.length === 1);
  s.enter(); s.flushFrames(); assert.equal(s.scrolls[0].index, 0);
  s.holdNextSearch(); s.w.document.querySelector('#regex-mode-literal').click();
  await waitUntil(() => s.searches.length === 2);
  s.enter(); assert.equal(s.searches.length, 2); assert.equal(s.scrolls.length, 1);
  s.finishSearch(); await new Promise(resolve => setImmediate(resolve)); s.flushFrames();
  assert.equal(s.scrolls.length, 2); assert.equal(s.scrolls[1].index, 1);
});

test('a user wheel gesture cancels a queued location instead of pulling the page back', async t => {
  const s = setup(t); s.type(); await waitUntil(() => s.searches.length === 1);
  s.w.document.querySelector('#regex-locate-button').click(); s.w.document.querySelector('#regex-jump-input').dispatchEvent(new s.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); assert.equal(s.frames.size, 1);
  s.w.document.body.dispatchEvent(new s.w.WheelEvent('wheel', { bubbles: true })); s.flushFrames();
  assert.equal(s.scrolls.length, 0);
});

test('closing cancels queued location and restores the original page focus', async t => {
  const s = setup(t); s.type(); await waitUntil(() => s.searches.length === 1);
  s.w.document.querySelector('#regex-locate-button').click(); s.w.document.querySelector('#regex-jump-input').dispatchEvent(new s.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); s.toggle(); s.flushFrames();
  assert.equal(s.scrolls.length, 0); assert.equal(s.w.document.activeElement.id, 'page-control');
});


test('numeric jump selects the exact result and the next Enter continues from it', async t => {
  const s = setup(t); s.type(); await waitUntil(() => s.searches.length === 1);
  s.w.document.querySelector('#regex-locate-button').click();
  const jump = s.w.document.querySelector('#regex-jump-input'); jump.value = '2';
  jump.dispatchEvent(new s.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  s.flushFrames(); assert.equal(s.scrolls.length, 1); assert.equal(s.scrolls[0].index, 1);
  assert.equal(s.w.document.querySelector('#regex-search-count').textContent, '2/2');
  s.enter(); s.flushFrames(); assert.equal(s.scrolls[1].index, 0); assert.equal(s.searches.length, 1);
});

test('invalid numeric jump and cancelling it neither change the query nor scroll', async t => {
  const s = setup(t); s.type(); await waitUntil(() => s.searches.length === 1);
  s.w.document.querySelector('#regex-locate-button').click();
  const jump = s.w.document.querySelector('#regex-jump-input'); jump.value = '3';
  jump.dispatchEvent(new s.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(jump.getAttribute('aria-invalid'), 'true'); assert.equal(jump.hidden, false);
  jump.dispatchEvent(new s.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  s.flushFrames(); assert.equal(jump.hidden, true); assert.equal(s.input.value, 'query');
  assert.equal(s.scrolls.length, 0); assert.equal(s.searches.length, 1);
});

test('a stale numeric target is queried again by its new ordinal instead of its old node identity', async t => {
  const s = setup(t); s.type(); await waitUntil(() => s.searches.length === 1); s.invalidateSecond();
  s.w.document.querySelector('#regex-locate-button').click();
  const jump = s.w.document.querySelector('#regex-jump-input'); jump.value = '2';
  jump.dispatchEvent(new s.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await waitUntil(() => s.searches.length === 2); s.flushFrames();
  assert.equal(s.searches[1].reason, 'jump'); assert.equal(s.scrolls.length, 1); assert.equal(s.scrolls[0].index, 0);
  assert.equal(s.w.document.querySelector('#regex-search-count').textContent, '2/3');
});

test('a numeric target lost during requery reports its missing ordinal and does not scroll to another result', async t => {
  const s = setup(t); s.type(); await waitUntil(() => s.searches.length === 1); s.invalidateSecond(true);
  s.w.document.querySelector('#regex-locate-button').click();
  const jump = s.w.document.querySelector('#regex-jump-input'); jump.value = '2';
  jump.dispatchEvent(new s.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await waitUntil(() => s.searches.length === 2); s.flushFrames();
  assert.equal(s.scrolls.length, 0); assert.equal(s.w.document.querySelector('#regex-search-status').textContent, '该序号已失效');
});

test('a wheel gesture cancels numeric navigation that is still waiting for a stale-target requery', async t => {
  const s = setup(t); s.type(); await waitUntil(() => s.searches.length === 1); s.invalidateSecond(); s.holdNextSearch();
  s.w.document.querySelector('#regex-locate-button').click();
  const jump = s.w.document.querySelector('#regex-jump-input'); jump.value = '2';
  jump.dispatchEvent(new s.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await waitUntil(() => s.searches.length === 2);
  s.w.document.body.dispatchEvent(new s.w.WheelEvent('wheel', { bubbles: true })); s.finishSearch();
  await new Promise(resolve => setImmediate(resolve)); s.flushFrames(); assert.equal(s.scrolls.length, 0);
});

for (const action of ['wheel', 'drag']) test(`a ${action} gesture during a still-running explicit query prevents its later result from scrolling`, async t => {
  const s = setup(t); s.holdNextSearch(); s.input.value = 'query'; s.enter();
  await waitUntil(() => s.searches.length === 1);
  if (action === 'wheel') s.w.document.body.dispatchEvent(new s.w.WheelEvent('wheel', { bubbles: true }));
  else {
    const container = s.w.document.querySelector('#regex-search-container'), handle = s.w.document.querySelector('#regex-drag-handle');
    container.getBoundingClientRect = () => ({ left: 300, top: 8, right: 780, bottom: 50, width: 480, height: 42 });
    const event = new s.w.Event('pointerdown', { bubbles: true, cancelable: true });
    Object.assign(event, { button: 0, pointerId: 1, isPrimary: true, clientX: 305, clientY: 20 }); handle.dispatchEvent(event);
    assert.equal(container.getAttribute('data-rr-dragging'), 'true');
  }
  s.finishSearch();
  await new Promise(resolve => setImmediate(resolve)); s.flushFrames(); assert.equal(s.scrolls.length, 0);
  assert.equal(s.w.document.querySelector('#regex-search-count').textContent, '1/2');
  s.enter(); s.flushFrames(); assert.equal(s.scrolls.length, 1); assert.equal(s.scrolls[0].index, 0);
});
