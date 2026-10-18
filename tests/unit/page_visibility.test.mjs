import assert from 'node:assert/strict';
import test from 'node:test';
import { readRuntimeSourceSync as readFileSync } from '../fixtures/runtime_source.mjs';
import { runInNewContext } from 'node:vm';

function setup() {
  const document = { nodeType: 9 };
  const context = { document };
  runInNewContext(readFileSync('infra/page_visibility.js', 'utf8'), context);
  return { document, api: context.RRPageVisibility };
}

function nestedDocuments(main, depth) {
  const frames = [];
  let document = main;
  for (let i = 0; i < depth; i++) {
    const parent = document; document = { nodeType: 9 };
    const frame = { isConnected: true, contentDocument: document, ownerDocument: parent };
    document.defaultView = { frameElement: frame }; frames.push(frame);
  }
  return { document, frames };
}

test('connected documents beyond 2048 embedding frames remain attached', () => {
  const { document: main, api } = setup();
  const { document, frames } = nestedDocuments(main, 3000);
  assert.equal(api.isDocumentAttached(document), true);
  frames[1500].isConnected = false;
  assert.equal(api.isDocumentAttached(document), false);
  frames[1500].isConnected = true;
  assert.equal(api.isDocumentAttached(document), true);
  frames[1500].contentDocument = { nodeType: 9 };
  assert.equal(api.isDocumentAttached(document), false);
});

test('document attachment rejects cycles and inaccessible embedding frames', () => {
  const { document: main, api } = setup();
  const { document, frames } = nestedDocuments(main, 3);
  frames[0].ownerDocument = document;
  assert.equal(api.isDocumentAttached(document), false);
  Object.defineProperty(document.defaultView, 'frameElement', { get() { throw new Error('Cross-origin'); } });
  assert.equal(api.isDocumentAttached(document), false);
  assert.equal(api.isDocumentAttached(main), true);
  assert.equal(api.isDocumentAttached(null), false);
});

test('composed ancestor cycles are rejected without treating depth as visibility', () => {
  const { document, api } = setup();
  const element = {
    nodeType: 1, tagName: 'SPAN', ownerDocument: document, isConnected: true,
    parentNode: document, getAttribute: () => null, hasAttribute: () => false
  };
  assert.equal(api.createContext().isVisible(element), true);
  element.parentNode = element;
  assert.equal(api.createContext().isVisible(element), false);
});
