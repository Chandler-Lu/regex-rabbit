import assert from 'node:assert/strict';
import test from 'node:test';
import { readRuntimeSourceSync as readFileSync } from '../fixtures/runtime_source.mjs';
import { JSDOM } from 'jsdom';

const KEY = 'regexRabbitToolbarPosition';
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

function setup(t, { saved, visual = false } = {}) {
  const dom = new JSDOM('<p>Page</p>', { url: 'https://example.com', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, frames = new Map(), writes = [], reads = [], pendingReads = [], pendingWrites = [], commits = [];
  const state = { scale: 1, width: 200, height: 40, hidden: false, deferReads: false, deferWrites: false, error: null, values: saved ? { [KEY]: clone(saved) } : {} };
  Object.defineProperty(w, 'innerWidth', { value: 1000, writable: true });
  Object.defineProperty(w, 'innerHeight', { value: 600, writable: true });
  Object.defineProperty(w.document, 'hidden', { get: () => state.hidden });
  if (visual) {
    const viewport = new w.EventTarget(); Object.assign(viewport, { width: 800, height: 400, offsetLeft: 50, offsetTop: 20 });
    Object.defineProperty(w, 'visualViewport', { value: viewport });
  }
  let nextFrame = 1, moved = 0, started = 0;
  w.requestAnimationFrame = callback => { const id = nextFrame++; frames.set(id, callback); return id; };
  w.cancelAnimationFrame = id => frames.delete(id);
  w.chrome = { runtime: {}, storage: { local: {
    get(key, callback) {
      if (state.error === 'get') throw Error('Extension context invalidated');
      reads.push(key); const reply = () => callback(clone(state.values));
      if (state.deferReads) pendingReads.push(reply); else reply();
    },
    set(values, callback) {
      if (state.error === 'set') throw Error('Storage failed');
      writes.push({ type: 'set', value: clone(values[KEY]) });
      const finish = () => { Object.assign(state.values, clone(values)); callback(); };
      if (state.deferWrites) pendingWrites.push(finish); else finish();
    },
    remove(key, callback) {
      if (state.error === 'remove') throw Error('Storage failed');
      writes.push({ type: 'remove', key });
      const finish = () => { delete state.values[key]; callback(); };
      if (state.deferWrites) pendingWrites.push(finish); else finish();
    }
  } } };
  function elements() {
    const container = w.document.createElement('div'), handle = w.document.createElement('button'), input = w.document.createElement('input');
    handle.type = 'button'; container.append(handle, input); w.document.body.append(container);
    const captures = new Set();
    handle.setPointerCapture = id => captures.add(id); handle.hasPointerCapture = id => captures.has(id);
    handle.releasePointerCapture = id => { captures.delete(id); pointer(handle, 'lostpointercapture', { pointerId: id }); };
    container.getBoundingClientRect = () => {
      const width = state.width * state.scale, height = state.height * state.scale;
      const x = container.style.getPropertyValue('--rr-left'), y = container.style.getPropertyValue('--rr-top');
      const left = x ? parseFloat(x) * state.scale : w.innerWidth - 12 * state.scale - width;
      const top = y ? parseFloat(y) * state.scale : 8 * state.scale;
      return { left, top, right: left + width, bottom: top + height, width, height };
    };
    return { container, handle, input, captures };
  }
  function pointer(target, type, fields = {}) {
    const event = new w.Event(type, { bubbles: true, cancelable: true });
    Object.entries({ pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: 20, clientY: 20, ...fields })
      .forEach(([name, value]) => Object.defineProperty(event, name, { value }));
    target.dispatchEvent(event); return event;
  }
  function key(target, name, fields = {}) {
    const event = new w.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...fields }); target.dispatchEvent(event); return event;
  }
  function tick() { const callbacks = Array.from(frames.values()); frames.clear(); callbacks.forEach(callback => callback(0)); }
  function dragTo(handle, x, y, type = 'mouse') {
    pointer(handle, 'pointerdown', { pointerType: type });
    pointer(w.document, 'pointermove', { clientX: x, clientY: y, pointerType: type });
    pointer(w.document, 'pointerup', { clientX: x, clientY: y, pointerType: type, buttons: 0 });
  }
  const first = elements(); w.eval(readFileSync('infra/toolbar_position.js', 'utf8'));
  const position = w.RRToolbarPosition.create({ ...first, onCommit: value => commits.push(clone(value)), onMove: () => moved++, onDragStart: () => started++ });
  t.after(() => { position.dispose(); dom.window.close(); });
  position.show();
  return { w, state, ...first, position, frames, writes, reads, pendingReads, pendingWrites, commits, elements, pointer, key, tick, dragTo,
    rect: () => first.container.getBoundingClientRect(), moved: () => moved, started: () => started };
}

test('default placement stays unchanged until the handle is moved and never reads or writes storage', t => {
  const h = setup(t, { saved: { version: 1, x: .1, y: .8 } });
  assert.equal(h.container.style.getPropertyValue('--rr-left'), '');
  h.dragTo(h.handle, -480, 220);
  assert.equal(h.rect().left, 288); assert.equal(h.rect().top, 208);
  assert.deepEqual(h.reads, []); assert.deepEqual(h.writes, []);
  assert.equal(h.commits.length, 1); assert.equal(h.started(), 1);
  assert.equal(h.container.style.getPropertyValue('--rr-right'), 'auto');
});

test('closing, reopening and replacing a toolbar in the same document retain the position', t => {
  const h = setup(t); h.dragTo(h.handle, -480, 220); h.position.hide(); h.position.show();
  assert.equal(h.rect().left, 288); assert.equal(h.rect().top, 208);
  const next = h.elements(); h.container.remove(); h.position.attach(next.container, next.handle); h.position.refresh();
  assert.equal(next.container.getBoundingClientRect().left, 288); assert.equal(next.container.getBoundingClientRect().top, 208);
  h.pointer(h.handle, 'pointerdown'); assert.equal(h.started(), 1);
  h.dragTo(next.handle, -80, 20); assert.equal(next.container.getBoundingClientRect().left, 188);
});

test('a fresh document returns to initial placement when permanent memory is disabled', t => {
  const first = setup(t); first.dragTo(first.handle, -480, 220);
  const next = setup(t); assert.equal(next.rect().left, 788); assert.equal(next.rect().top, 8);
  assert.equal(next.container.style.getPropertyValue('--rr-left'), '');
});

test('movement is coalesced per animation frame and pointerup applies its final coordinates', t => {
  const h = setup(t); h.position.setConfig({ rememberPosition: true });
  h.pointer(h.handle, 'pointerdown');
  h.pointer(h.w.document, 'pointermove', { clientX: -80, clientY: 120 });
  h.pointer(h.w.document, 'pointermove', { clientX: -180, clientY: 180 });
  assert.equal(h.frames.size, 1); assert.equal(h.rect().left, 788); assert.equal(h.writes.length, 0);
  const beforeMove = h.moved(); h.tick(); assert.equal(h.rect().left, 588); assert.equal(h.moved(), beforeMove + 1);
  h.pointer(h.w.document, 'pointermove', { clientX: -280, clientY: 200 });
  h.pointer(h.w.document, 'pointerup', { clientX: -380, clientY: 240, buttons: 0 });
  assert.equal(h.rect().left, 388); assert.equal(h.rect().top, 228); assert.equal(h.frames.size, 0);
  assert.equal(h.writes.length, 1); assert.equal(h.commits.length, 1);
  assert.equal(h.writes[0].value.version, 1); assert.ok(h.writes[0].value.x >= 0 && h.writes[0].value.x <= 1);
  h.pointer(h.handle, 'lostpointercapture'); assert.equal(h.writes.length, 1);
});

test('only the primary left pointer on the handle starts movement', t => {
  const h = setup(t);
  h.pointer(h.input, 'pointerdown'); h.pointer(h.handle, 'pointerdown', { button: 2 });
  h.pointer(h.handle, 'pointerdown', { isPrimary: false }); h.pointer(h.handle, 'pointerdown', { clientX: Infinity });
  assert.equal(h.started(), 0); assert.equal(h.frames.size, 0);
  h.pointer(h.handle, 'pointerdown'); h.pointer(h.w.document, 'pointermove', { pointerId: 2, clientX: -480, clientY: 220 }); h.tick();
  assert.equal(h.rect().left, 788); h.pointer(h.w.document, 'pointercancel');
  h.handle.disabled = true; h.pointer(h.handle, 'pointerdown'); assert.equal(h.started(), 1);
});

test('touch movement prevents scrolling and clamps extreme coordinates into the viewport', t => {
  const h = setup(t); assert.equal(h.pointer(h.handle, 'pointerdown', { pointerType: 'touch' }).defaultPrevented, true);
  const move = h.pointer(h.w.document, 'pointermove', { pointerType: 'touch', clientX: 20000, clientY: 20000 });
  assert.equal(move.defaultPrevented, true); h.tick();
  assert.equal(h.rect().left, 796); assert.equal(h.rect().top, 556);
  h.pointer(h.w.document, 'pointerup', { pointerType: 'touch', clientX: -20000, clientY: -20000 });
  assert.equal(h.rect().left, 4); assert.equal(h.rect().top, 4);
});

test('cancel, capture loss, hidden page and hiding discard pending frames without saving', t => {
  const h = setup(t); h.position.setConfig({ rememberPosition: true });
  for (const reason of ['cancel', 'capture', 'hidden', 'hide']) {
    h.state.hidden = false; h.position.show(); h.pointer(h.handle, 'pointerdown');
    h.pointer(h.w.document, 'pointermove', { clientX: -480, clientY: 220 });
    if (reason === 'cancel') h.pointer(h.w.document, 'pointercancel');
    if (reason === 'capture') h.pointer(h.handle, 'lostpointercapture');
    if (reason === 'hidden') { h.state.hidden = true; h.w.document.dispatchEvent(new h.w.Event('visibilitychange')); }
    if (reason === 'hide') h.position.hide();
    assert.equal(h.frames.size, 0); assert.equal(h.captures.size, 0); assert.equal(h.container.hasAttribute('data-rr-dragging'), false);
    h.tick(); assert.equal(h.rect().left, 788); assert.equal(h.writes.length, 0);
  }
});

test('a cancelled drag retains the rendered page position but does not persist it', t => {
  const h = setup(t); h.position.setConfig({ rememberPosition: true }); h.pointer(h.handle, 'pointerdown');
  h.pointer(h.w.document, 'pointermove', { clientX: -480, clientY: 220 }); h.tick(); h.pointer(h.w.document, 'pointercancel');
  h.position.hide(); h.position.show(); assert.equal(h.rect().left, 288); assert.equal(h.rect().top, 208);
  assert.equal(h.writes.length, 0);
});

test('loss of the primary mouse button cancels a drag without waiting for all buttons to release', t => {
  const h = setup(t); h.pointer(h.handle, 'pointerdown');
  h.pointer(h.w.document, 'pointermove', { buttons: 2, clientX: -480, clientY: 220 });
  assert.equal(h.frames.size, 0); assert.equal(h.captures.size, 0); assert.equal(h.rect().left, 788);
});

test('permanent memory restores legal relative coordinates and reads the latest value when reopened', t => {
  const h = setup(t, { saved: { version: 1, x: .5, y: .5 } }); h.position.setConfig({ rememberPosition: true });
  assert.equal(h.rect().left, 400); assert.equal(h.rect().top, 280);
  h.position.hide(); h.state.values[KEY] = { version: 1, x: 1, y: 0 }; h.position.show();
  assert.equal(h.rect().left, 796); assert.equal(h.rect().top, 4); assert.equal(h.writes.length, 0);
});

test('enabling permanent memory saves an existing page placement instead of restoring an older one', t => {
  const h = setup(t, { saved: { version: 1, x: 1, y: 1 } }); h.dragTo(h.handle, -480, 220);
  h.position.setConfig({ rememberPosition: true });
  assert.equal(h.rect().left, 288); assert.equal(h.rect().top, 208); assert.equal(h.writes.length, 1); assert.equal(h.reads.length, 0);
});

test('invalid stored coordinates are ignored without unsafe CSS values', t => {
  const h = setup(t); h.position.setConfig({ rememberPosition: true });
  for (const saved of [null, 'x', { version: 2, x: 0, y: 0 }, { version: 1, x: -1, y: 0 }, { version: 1, x: 0, y: 1.1 },
    { version: 1, x: '0', y: 0 }, { version: 1, x: Infinity, y: NaN }]) {
    h.position.hide(); h.state.values[KEY] = saved; h.position.show();
    assert.equal(h.container.style.getPropertyValue('--rr-left'), ''); assert.equal(h.rect().left, 788);
  }
});

test('delayed saved positions cannot overwrite movement, reset or disabled memory', t => {
  const h = setup(t, { saved: { version: 1, x: 1, y: 1 } }); h.state.deferReads = true;
  h.position.setConfig({ rememberPosition: true }); h.dragTo(h.handle, -480, 220); h.pendingReads.shift()();
  assert.equal(h.rect().left, 288); assert.equal(h.rect().top, 208);
  h.position.hide(); h.position.show(); h.position.reset(); h.pendingReads.shift()();
  assert.equal(h.container.style.getPropertyValue('--rr-left'), '');
  h.position.hide(); h.position.show(); h.position.setConfig({ rememberPosition: false }); h.pendingReads.shift()();
  assert.equal(h.container.style.getPropertyValue('--rr-left'), '');
});

test('pending writes are bounded and disabling memory removes storage after the current write', t => {
  const h = setup(t); h.state.deferWrites = true; h.position.setConfig({ rememberPosition: true });
  h.dragTo(h.handle, -80, 120); h.dragTo(h.handle, -80, 120); h.dragTo(h.handle, -80, 120);
  assert.equal(h.writes.length, 1); assert.equal(h.pendingWrites.length, 1);
  const pageLeft = h.rect().left; h.position.setConfig({ rememberPosition: false });
  assert.equal(h.rect().left, pageLeft); h.pendingWrites.shift()();
  assert.equal(h.writes.length, 2); assert.equal(h.writes[1].type, 'remove'); h.pendingWrites.shift()();
  assert.equal(h.state.values[KEY], undefined); assert.equal(h.pendingWrites.length, 0);
  h.position.hide(); h.position.show(); assert.ok(Math.abs(h.rect().left - pageLeft) < .00001);
});

test('reopening while a write is pending keeps the latest page placement', t => {
  const h = setup(t, { saved: { version: 1, x: 1, y: 1 } }); h.position.setConfig({ rememberPosition: true }); h.state.deferWrites = true;
  h.dragTo(h.handle, -480, 220); const rect = h.rect(), reads = h.reads.length;
  h.position.hide(); h.position.show(); assert.equal(h.reads.length, reads); assert.equal(h.rect().left, rect.left);
  h.pendingWrites.shift()();
});

test('viewport changes and CSS zoom keep the physical toolbar visible using relative placement', t => {
  const h = setup(t); h.dragTo(h.handle, 20000, 20000); h.w.innerWidth = 600; h.w.innerHeight = 300;
  h.w.dispatchEvent(new h.w.Event('resize')); assert.equal(h.rect().right, 596); assert.equal(h.rect().bottom, 296);
  h.state.scale = 2.5; h.position.setConfig({ scale: 2.5 });
  assert.equal(h.rect().right, 596); assert.equal(h.rect().bottom, 296);
  assert.equal(parseFloat(h.container.style.getPropertyValue('--rr-left')), h.rect().left / 2.5);
  h.state.width = 1000; h.state.height = 1000; h.position.refresh();
  assert.equal(h.rect().left, 0); assert.equal(h.rect().top, 0);
  assert.ok(Number.isFinite(parseFloat(h.container.style.getPropertyValue('--rr-left'))));
});

test('visual viewport offsets and resizing define the currently visible bounds', t => {
  const h = setup(t, { visual: true }); h.dragTo(h.handle, -20000, -20000);
  assert.equal(h.rect().left, 54); assert.equal(h.rect().top, 24);
  h.w.visualViewport.offsetLeft = 100; h.w.visualViewport.offsetTop = 80;
  h.w.visualViewport.dispatchEvent(new h.w.Event('scroll')); assert.equal(h.rect().left, 104); assert.equal(h.rect().top, 84);
  h.dragTo(h.handle, 20000, 20000); assert.equal(h.rect().right, 896); assert.equal(h.rect().bottom, 476);
});

test('arrow keys move only the handle, Shift uses a larger step and Home restores initial placement', t => {
  const h = setup(t); h.position.setConfig({ rememberPosition: true });
  assert.equal(h.key(h.input, 'ArrowLeft').defaultPrevented, false); assert.equal(h.rect().left, 788);
  assert.equal(h.key(h.handle, 'ArrowLeft').defaultPrevented, true); assert.equal(h.rect().left, 780);
  h.key(h.handle, 'ArrowDown', { shiftKey: true }); assert.equal(h.rect().top, 40);
  assert.equal(h.key(h.handle, 'ArrowLeft', { ctrlKey: true }).defaultPrevented, false); assert.equal(h.rect().left, 780);
  h.key(h.handle, 'Home'); assert.equal(h.rect().left, 788); assert.equal(h.rect().top, 8);
  assert.equal(h.state.values[KEY], undefined); assert.equal(h.container.style.getPropertyValue('--rr-right'), '');
});

test('storage exceptions, callback errors and rejected Promises do not prevent page-local movement', async t => {
  const h = setup(t); h.state.error = 'get'; h.position.setConfig({ rememberPosition: true });
  h.state.error = 'set'; h.dragTo(h.handle, -480, 220); assert.equal(h.rect().left, 288);
  h.state.error = 'remove'; h.position.setConfig({ rememberPosition: false }); assert.equal(h.rect().left, 288);
  h.w.chrome.storage.local.get = (_key, callback) => { h.w.chrome.runtime.lastError = { message: 'failed' }; callback({ [KEY]: { version: 1, x: 1, y: 1 } }); delete h.w.chrome.runtime.lastError; };
  h.position.reset(); h.position.setConfig({ rememberPosition: true }); assert.equal(h.rect().left, 788);
  h.w.chrome.storage.local.set = () => Promise.reject(Error('Quota exceeded')); h.dragTo(h.handle, -480, 220);
  await Promise.resolve(); await Promise.resolve(); assert.equal(h.rect().left, 288);
});

test('dispose detaches old and replacement handles, cancels frames and ignores late storage replies', t => {
  const h = setup(t, { saved: { version: 1, x: 1, y: 1 } }); h.state.deferReads = true;
  h.position.setConfig({ rememberPosition: true }); h.pointer(h.handle, 'pointerdown');
  h.pointer(h.w.document, 'pointermove', { clientX: -480, clientY: 220 }); h.position.dispose();
  assert.equal(h.frames.size, 0); assert.equal(h.captures.size, 0); h.pendingReads.shift()();
  const next = h.elements(); h.position.attach(next.container, next.handle); h.position.show(); h.dragTo(next.handle, -480, 220);
  assert.equal(next.container.style.getPropertyValue('--rr-left'), ''); assert.equal(h.writes.length, 0);
});

test('default viewport changes and resetting notify the host to reposition its floating menu', t => {
  const h = setup(t), first = h.moved(); h.w.dispatchEvent(new h.w.Event('resize'));
  assert.equal(h.moved(), first + 1);
  h.dragTo(h.handle, -480, 220); const dragged = h.moved(); h.position.reset();
  assert.equal(h.moved(), dragged + 1); assert.equal(h.rect().left, 788);
  h.position.hide(); h.w.dispatchEvent(new h.w.Event('resize')); assert.equal(h.moved(), dragged + 1);
});

test('Promise storage reads work and missing storage still permits dragging', async t => {
  const h = setup(t); h.w.chrome.storage.local.get = () => Promise.resolve({ [KEY]: { version: 1, x: .5, y: .5 } });
  h.position.setConfig({ rememberPosition: true }); await Promise.resolve();
  assert.equal(h.rect().left, 400); assert.equal(h.rect().top, 280);
  delete h.w.chrome; h.dragTo(h.handle, -80, 120); assert.equal(h.rect().left, 300); assert.equal(h.rect().top, 380);
  h.position.setConfig({ rememberPosition: false }); assert.equal(h.rect().left, 300);
});

test('a handle click after dragging does not activate a page click listener', t => {
  const h = setup(t); let clicks = 0; h.w.document.addEventListener('click', () => clicks++);
  h.dragTo(h.handle, -80, 120);
  const event = new h.w.MouseEvent('click', { bubbles: true, cancelable: true }); h.handle.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true); assert.equal(clicks, 0);
});

test('default placement follows the visual viewport without creating a remembered user position', t => {
  const h = setup(t, { visual: true });
  assert.equal(h.container.style.getPropertyValue('--rr-viewport-width'), '800px');
  assert.equal(h.rect().right, 838); assert.equal(h.rect().top, 28);
  assert.ok(h.rect().right <= h.w.visualViewport.offsetLeft + h.w.visualViewport.width);
  h.position.setConfig({ rememberPosition: true });
  assert.equal(h.writes.length, 0); assert.equal(h.commits.length, 0);
  h.position.hide(); const next = h.elements(); h.position.attach(next.container, next.handle); h.position.show();
  assert.equal(next.container.style.getPropertyValue('--rr-viewport-width'), '800px');
  assert.equal(next.container.getBoundingClientRect().right, 838); assert.equal(h.writes.length, 0);
});

test('a narrower visual viewport updates the CSS width constraint before geometry is measured', t => {
  const h = setup(t, { visual: true }); let widthDuringMeasurement;
  const original = h.container.getBoundingClientRect;
  h.container.getBoundingClientRect = () => { widthDuringMeasurement = h.container.style.getPropertyValue('--rr-viewport-width'); return original(); };
  h.state.width = 480; h.w.visualViewport.width = 250; h.w.visualViewport.height = 100;
  h.w.visualViewport.dispatchEvent(new h.w.Event('resize'));
  assert.equal(widthDuringMeasurement, '250px'); assert.equal(h.container.style.getPropertyValue('--rr-viewport-width'), '250px');
  assert.equal(h.rect().left, 50); assert.equal(h.rect().top, 28);
  // jsdom does not lay out max-width; the Chrome test checks the constrained physical width.
  assert.deepEqual(h.writes, []); assert.deepEqual(h.commits, []);
});

test('reset and a return to the ordinary viewport remove only temporary default correction', t => {
  const h = setup(t, { visual: true }); h.dragTo(h.handle, -20000, -20000);
  assert.equal(h.rect().left, 54); h.position.reset(); assert.equal(h.rect().right, 838); assert.equal(h.rect().top, 28);
  Object.assign(h.w.visualViewport, { width: 1000, height: 600, offsetLeft: 0, offsetTop: 0 });
  h.w.visualViewport.dispatchEvent(new h.w.Event('resize'));
  assert.equal(h.container.style.getPropertyValue('--rr-viewport-width'), '1000px');
  assert.equal(h.container.style.getPropertyValue('--rr-left'), ''); assert.equal(h.container.style.getPropertyValue('--rr-top'), '');
  assert.equal(h.rect().right, 988); assert.equal(h.rect().top, 8);
  h.position.setConfig({ rememberPosition: true }); assert.equal(h.writes.length, 0);
});
