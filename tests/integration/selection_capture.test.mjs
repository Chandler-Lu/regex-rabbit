import assert from 'node:assert/strict';
import test from 'node:test';
import { readRuntimeSourceSync as readFileSync } from '../fixtures/runtime_source.mjs';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';

function setup(t, html = '<p>prefix needle suffix</p><input value="prefix needle suffix"><textarea>prefix needle suffix</textarea>') {
  const dom = new JSDOM(html, { url: 'https://example.com', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  for (const file of ['infra/page_visibility.js', 'infra/selection_capture.js']) dom.window.eval(readFileSync(file, 'utf8'));
  return { w: dom.window, api: dom.window.RRSelectionCapture };
}

test('input and textarea capture exact UTF16 selection, rejecting changed values', t => {
  const { w, api } = setup(t);
  for (const control of w.document.querySelectorAll('input,textarea')) {
    control.focus(); control.setSelectionRange(7, 13);
    const selected = api.capture();
    assert.equal(selected.kind, 'control-selection');
    assert.equal(selected.node, control);
    assert.equal(selected.start, 7); assert.equal(selected.end, 13);
    assert.equal(api.rootFor(selected), control);
    assert.equal(api.isValid(selected), true);
    control.value += ' changed';
    assert.equal(api.isValid(selected), false);
  }
});

test('small selections beyond 4 Mi characters remain valid without copying large control values', t => {
  const { w, api } = setup(t, '<input><textarea></textarea>');
  const prefix = 'a'.repeat(4 * 1024 * 1024 + 17) + '\u{1F600}';
  const value = prefix + 'needle suffix';
  for (const control of w.document.querySelectorAll('input,textarea')) {
    const prototype = control.tagName === 'INPUT' ? w.HTMLInputElement.prototype : w.HTMLTextAreaElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    let reads = 0;
    Object.defineProperty(control, 'value', {
      configurable: true,
      get() { reads++; return descriptor.get.call(this); },
      set(next) { descriptor.set.call(this, next); }
    });
    control.value = value;
    control.focus(); control.setSelectionRange(prefix.length, prefix.length + 6);
    reads = 0;
    const selected = api.capture();
    assert.equal(reads, 1);
    assert.equal(selected.node, control);
    assert.equal(selected.start, prefix.length); assert.equal(selected.end, prefix.length + 6);
    assert.equal(selected.valueSnapshot, value);
    assert.equal(selected.valueSnapshot.slice(selected.start, selected.end), 'needle');
    assert.equal(api.isValid(selected), true);
    assert.equal(reads, 2);
    control.value = value + ' changed';
    assert.equal(api.isValid(selected), false);
    assert.equal(reads, 3);
  }
});

test('changing a captured input to password rejects it before reading the value', t => {
  const { w, api } = setup(t, '<input value="prefix needle suffix">');
  const control = w.document.querySelector('input');
  control.focus(); control.setSelectionRange(7, 13);
  const selected = api.capture();
  control.type = 'password';
  let reads = 0;
  Object.defineProperty(control, 'value', {
    configurable: true,
    get() { reads++; throw new Error('Password value must not be read'); }
  });
  assert.equal(api.isValid(selected), false);
  assert.equal(api.capture(), null);
  assert.equal(reads, 0);
});

test('invalid control offsets are rejected before reading the current value', t => {
  const { w, api } = setup(t, '<input value="needle">');
  const control = w.document.querySelector('input');
  let reads = 0;
  Object.defineProperty(control, 'value', {
    configurable: true,
    get() { reads++; throw new Error('Invalid selections must not read the value'); }
  });
  for (const [start, end] of [[-1, 3], [0, 7], [3, 3], [0.5, 3], [0, Number.MAX_SAFE_INTEGER + 1]]) {
    assert.equal(api.isValid({ kind: 'control-selection', node: control, start, end, valueSnapshot: 'needle' }), false);
  }
  assert.equal(reads, 0);
});

test('passwords and unsupported controls never produce control selections', t => {
  const { w, api } = setup(t, '<input type="password" value="private"><input type="email" value="a@b.test">');
  const password = w.document.querySelector('input');
  password.focus(); password.setSelectionRange(0, 7);
  assert.equal(api.capture(), null);
  assert.equal(api.isValid({ kind: 'control-selection', node: password, start: 0, end: 7, valueSnapshot: 'private' }), false);
  w.document.querySelector('input[type=email]').focus();
  assert.equal(api.capture(), null);
});

test('owned toolbar selection does not replace the stored page range', t => {
  const { w, api } = setup(t, '<p>needle</p><div data-regex-rabbit-owned="true"><input value="query"></div>');
  const input = w.document.querySelector('input');
  input.focus(); input.select();
  assert.equal(api.capture(), null);
});

test('focused shadow control is captured without traversing unrelated page nodes', t => {
  const { w, api } = setup(t, '<div id="host"></div>');
  const root = w.document.querySelector('#host').attachShadow({ mode: 'open' });
  root.innerHTML = '<input value="prefix needle suffix">';
  const input = root.querySelector('input'); input.focus(); input.setSelectionRange(7, 13);
  const selected = api.capture();
  assert.equal(selected.node, input); assert.equal(selected.start, 7);
});

test('focused same-origin frame control is captured recursively', t => {
  const { w, api } = setup(t, '<iframe></iframe>');
  const frame = w.document.querySelector('iframe');
  frame.contentDocument.body.innerHTML = '<textarea>prefix needle suffix</textarea>';
  const textarea = frame.contentDocument.querySelector('textarea');
  textarea.focus(); textarea.setSelectionRange(7, 13);
  assert.equal(api.capture().node, textarea);
});

test('DOM selection stays clipped to its original text offsets', t => {
  const { w, api } = setup(t);
  const node = w.document.querySelector('p').firstChild, range = w.document.createRange();
  range.setStart(node, 7); range.setEnd(node, 13);
  w.getSelection().addRange(range);
  const selected = api.capture();
  assert.equal(selected.toString(), 'needle');
  assert.equal(api.isValid(selected), true);
  node.parentNode.remove();
  assert.equal(api.isValid(selected), false);
});

test('tracker observes independent frame selections and releases all listeners on stop', t => {
  const { w, api } = setup(t, '<iframe></iframe>');
  const frame = w.document.querySelector('iframe'), doc = frame.contentDocument;
  doc.body.innerHTML = '<p>prefix needle suffix</p>';
  const received = [];
  const tracker = api.createTracker({ onSelection: selected => received.push(selected.toString()) });
  tracker.start([doc]);
  const range = doc.createRange(); range.setStart(doc.querySelector('p').firstChild, 7); range.setEnd(doc.querySelector('p').firstChild, 13);
  doc.getSelection().addRange(range);
  doc.dispatchEvent(new frame.contentWindow.Event('selectionchange'));
  assert.deepEqual(received, ['needle']);
  tracker.stop(); doc.dispatchEvent(new frame.contentWindow.Event('selectionchange'));
  assert.deepEqual(received, ['needle']);
  tracker.start([doc]); frame.remove(); tracker.prune();
  doc.dispatchEvent(new frame.contentWindow.Event('selectionchange'));
  assert.deepEqual(received, ['needle']); tracker.dispose();
});

test('cross-root composed selections are rejected instead of expanding to host contents', t => {
  const { w, api } = setup(t, '<p>outside</p><div></div>');
  const root = w.document.querySelector('div').attachShadow({ mode: 'open' }); root.textContent = 'inside';
  w.document.getSelection = () => ({ isCollapsed: false, rangeCount: 1,
    anchorNode: root.firstChild,
    getComposedRanges() { return [{ startContainer: w.document.querySelector('p').firstChild, startOffset: 0, endContainer: root.firstChild, endOffset: 6 }]; }
  });
  assert.equal(api.capture(), null);
});

function shadowChain(w, depth, owned = false) {
  const wrapper = w.document.createElement('div');
  if (owned) wrapper.setAttribute('data-regex-rabbit-owned', 'true');
  w.document.body.append(wrapper);
  const roots = [];
  let parent = wrapper;
  for (let i = 0; i < depth; i++) {
    const host = w.document.createElement('div'); parent.append(host);
    const root = host.attachShadow({ mode: 'open' }); roots.push(root); parent = root;
  }
  return { wrapper, roots, leaf: parent };
}

test('focused controls remain capturable beyond 64 nested shadow roots', t => {
  const { w, api } = setup(t, '');
  const { leaf } = shadowChain(w, 100);
  const input = w.document.createElement('input'); input.value = 'prefix needle suffix'; leaf.append(input);
  input.focus(); input.setSelectionRange(7, 13);
  const selected = api.capture();
  assert.equal(selected.node, input);
  assert.equal(selected.start, 7); assert.equal(selected.end, 13);
  assert.equal(api.isValid(selected), true);
});

test('owned ancestors beyond 64 composed steps reject selection before reading a control', t => {
  const { w, api } = setup(t, '');
  const { leaf } = shadowChain(w, 100, true);
  const input = w.document.createElement('input'); input.value = 'needle'; leaf.append(input);
  input.focus(); input.setSelectionRange(0, 6);
  let reads = 0;
  Object.defineProperty(input, 'value', { get() { reads++; throw new Error('Owned controls must not be read'); } });
  assert.equal(api.capture(), null);
  assert.equal(reads, 0);
});

test('composed selection supplies all nested shadow roots without a depth cutoff', t => {
  const { w, api } = setup(t, '');
  const { roots, leaf } = shadowChain(w, 100);
  const text = w.document.createTextNode('prefix needle suffix'); leaf.append(text);
  let supplied = [];
  w.document.getSelection = () => ({
    isCollapsed: false, rangeCount: 1, anchorNode: text,
    getComposedRanges(options) {
      supplied = options.shadowRoots;
      return [{ startContainer: text, startOffset: 7, endContainer: text, endOffset: 13 }];
    }
  });
  const selected = api.capture();
  assert.equal(selected.toString(), 'needle');
  assert.equal(supplied.length, 100);
  for (const root of roots) assert.ok(supplied.includes(root));
});

test('tracker covers more than 512 shadow roots and uses one Document interaction listener', t => {
  const { w, api } = setup(t, '');
  const roots = [], controls = [], received = [], interactions = [];
  for (let i = 0; i < 520; i++) {
    const host = w.document.createElement('div'); w.document.body.append(host);
    const root = host.attachShadow({ mode: 'open' }), input = w.document.createElement('input');
    input.value = 'needle'; root.append(input); input.setSelectionRange(0, 6);
    roots.push(root); controls.push(input);
  }
  let documentAdds = 0, documentRemoves = 0, shadowAdds = 0, shadowRemoves = 0;
  const docAdd = w.document.addEventListener.bind(w.document), docRemove = w.document.removeEventListener.bind(w.document);
  w.document.addEventListener = (...args) => { documentAdds++; return docAdd(...args); };
  w.document.removeEventListener = (...args) => { documentRemoves++; return docRemove(...args); };
  for (const root of roots) {
    const add = root.addEventListener.bind(root), remove = root.removeEventListener.bind(root);
    root.addEventListener = (...args) => { shadowAdds++; return add(...args); };
    root.removeEventListener = (...args) => { shadowRemoves++; return remove(...args); };
  }
  const tracker = api.createTracker({
    onSelection: selected => received.push(selected.node),
    onInteraction: event => interactions.push(event.type)
  });
  tracker.start(roots);
  tracker.start(roots);
  assert.equal(documentAdds, 8); assert.equal(shadowAdds, roots.length * 2);
  controls.at(-1).dispatchEvent(new w.Event('select', { bubbles: true, composed: false }));
  assert.deepEqual(received, [controls.at(-1)]);
  controls.at(-1).dispatchEvent(new w.Event('wheel', { bubbles: true, composed: true }));
  assert.deepEqual(interactions, ['wheel']);
  tracker.stop();
  assert.equal(documentRemoves, documentAdds); assert.equal(shadowRemoves, shadowAdds);
  controls.at(-1).dispatchEvent(new w.Event('select', { bubbles: true, composed: false }));
  controls.at(-1).dispatchEvent(new w.Event('wheel', { bubbles: true, composed: true }));
  assert.equal(received.length, 1); assert.equal(interactions.length, 1);
});

test('nested shadow interactions and composed selections are reported only once', t => {
  const { w, api } = setup(t, '');
  const { roots, leaf, wrapper } = shadowChain(w, 100);
  const input = w.document.createElement('input'); input.value = 'needle'; leaf.append(input);
  input.focus(); input.setSelectionRange(0, 6);
  let selections = 0, interactions = 0;
  const tracker = api.createTracker({ onSelection: () => selections++, onInteraction: () => interactions++ });
  tracker.start(roots);
  input.dispatchEvent(new w.Event('select', { bubbles: true, composed: true }));
  input.dispatchEvent(new w.Event('pointerdown', { bubbles: true, composed: true }));
  assert.equal(selections, 1); assert.equal(interactions, 1);
  wrapper.remove(); tracker.prune();
  input.dispatchEvent(new w.Event('select', { bubbles: true, composed: false }));
  assert.equal(selections, 1);
  tracker.dispose();
});

test('fallback attachment and focused-context traversal terminate on cycles without depth limits', () => {
  const main = { nodeType: 9 };
  const context = { document: main };
  runInNewContext(readFileSync('infra/selection_capture.js', 'utf8'), context);
  let doc = main;
  for (let i = 0; i < 3000; i++) {
    const parent = doc; doc = { nodeType: 9 };
    doc.defaultView = { frameElement: { isConnected: true, contentDocument: doc, ownerDocument: parent } };
  }
  const control = { tagName: 'INPUT', type: 'text', isConnected: true, ownerDocument: doc, value: 'needle' };
  assert.equal(context.RRSelectionCapture.isValid({ kind: 'control-selection', node: control, start: 0, end: 6, valueSnapshot: 'needle' }), true);
  doc.defaultView.frameElement.ownerDocument = doc;
  assert.equal(context.RRSelectionCapture.isValid({ kind: 'control-selection', node: control, start: 0, end: 6, valueSnapshot: 'needle' }), false);
  const host = { nodeType: 1, tagName: 'DIV', getAttribute: () => null };
  const root = { host, activeElement: host }; host.shadowRoot = root;
  assert.equal(context.RRSelectionCapture.capture({ root }), null);
});
