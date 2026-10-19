import assert from 'node:assert/strict';
import test from 'node:test';
import { readRuntimeSourceSync as readFileSync } from '../fixtures/runtime_source.mjs';
import { JSDOM } from 'jsdom';

function setup(t) {
  const dom = new JSDOM('<p>Page</p>', { url: 'https://example.com', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window, modes = [], navigation = [], located = [];
  w.eval(readFileSync('infra/ui_i18n.js', 'utf8')); w.RRi18n.setLanguage('zh-CN');
  w.eval(readFileSync('infra/search_toolbar.js', 'utf8'));
  const ui = w.RRSearchToolbar.create({ onMode: value => modes.push(value), onNavigate: value => navigation.push(value),
    onJump: index => located.push(index) });
  w.document.body.appendChild(ui.container);
  ui.updateOptions({ mode: 'regex', wholeWord: false, multiline: false, dotAll: false }, false, false); ui.idle();
  return { w, ui, modes, navigation, located };
}

test('mode group has one keyboard stop and switches with arrow keys', t => {
  const { w, ui, modes } = setup(t), literal = w.document.querySelector('#regex-mode-literal'), regex = w.document.querySelector('#regex-mode-regex');
  w.document.querySelector('#regex-advanced-toggle').click();
  assert.equal(literal.tabIndex, -1); assert.equal(regex.tabIndex, 0);
  regex.focus(); regex.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
  assert.deepEqual(modes, ['literal']); assert.equal(w.document.activeElement, literal);
  assert.equal(literal.getAttribute('aria-checked'), 'true'); assert.equal(regex.tabIndex, -1);

});

test('advanced controls stay hidden until requested and close cleanly', t => {
  const { w, ui } = setup(t), toggle = w.document.querySelector('#regex-advanced-toggle');
  assert.equal(w.document.querySelector('#regex-advanced-panel').hidden, true);
  toggle.click(); assert.equal(toggle.getAttribute('aria-expanded'), 'true'); assert.equal(ui.isDetailsOpen(), true);
  assert.equal(w.document.querySelector('#regex-advanced-panel').getAttribute('role'), 'dialog');
  ui.closeDetails(true); assert.equal(toggle.getAttribute('aria-expanded'), 'false'); assert.equal(ui.isDetailsOpen(), false);
  assert.equal(w.document.activeElement, toggle);
  toggle.click();
  w.document.body.dispatchEvent(new w.Event('pointerdown', { bubbles: true }));
  assert.equal(ui.isDetailsOpen(), false);
});

test('active options remain legible while folded and regex-only settings hide in text mode', t => {
  const { w, ui } = setup(t);
  ui.updateOptions({ mode: 'regex', wholeWord: true, multiline: true, dotAll: false }, true, true);
  assert.equal(w.document.querySelector('#regex-advanced-toggle').getAttribute('data-active-options'), 'true');
  assert.equal(w.document.querySelector('#regex-mode-toggle').getAttribute('aria-pressed'), 'true');
  assert.equal(w.document.querySelector('#regex-word-toggle').getAttribute('aria-pressed'), 'true');
  ui.updateOptions({ mode: 'literal', wholeWord: true, multiline: true, dotAll: true }, true, true);
  assert.equal(w.document.querySelector('.rr-regex-options').hidden, true); assert.equal(ui.multilineBtn.disabled, true);
  assert.equal(w.document.querySelector('#regex-mode-toggle').getAttribute('aria-pressed'), 'false');
  assert.equal(ui.input.placeholder, '查找');
  ui.updateOptions({ mode: 'literal', wholeWord: false, multiline: true, dotAll: true }, false, false);
  assert.equal(w.document.querySelector('#regex-advanced-toggle').getAttribute('data-active-options'), 'false');
  assert.equal(w.document.querySelector('#regex-case-menu-toggle').getAttribute('aria-pressed'), 'false');
});

test('count edits the numeric position and short feedback safely exposes detail', t => {
  const { w, ui, located } = setup(t);
  assert.equal(w.document.querySelector('#regex-clear-button'), null);
  ui.countEl.textContent = '2/3'; ui.locateBtn.disabled = false; ui.syncCount(); ui.locateBtn.click();
  assert.equal(ui.countEl.classList.contains('rr-count-long'), false);
  assert.equal(ui.jumpInput.hidden, false); ui.jumpInput.value = '3';
  ui.jumpInput.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.deepEqual(located, [3]);
  assert.equal(ui.locateBtn.getAttribute('aria-label'), '定位第 2 处，共 3 处');
  ui.setStatus('<b>error</b>', '<script>unsafe</script>', 'error');
  assert.equal(w.document.querySelector('#regex-search-status').textContent, '<b>error</b>');
  assert.equal(w.document.querySelector('#regex-search-status').children.length, 0);
  const feedback = w.document.querySelector('.rr-feedback');
  assert.equal(feedback.hidden, false); assert.equal(feedback.title, '<script>unsafe</script>');
  assert.equal(feedback.textContent, '<b>error</b>'); assert.equal(feedback.querySelector('b'), null);
  w.document.querySelector('#regex-advanced-toggle').click();
  assert.equal(feedback.parentElement.id, 'regex-advanced-panel');
  ui.closeDetails(); assert.equal(feedback.parentElement, ui.container);
  ui.idle(); assert.equal(feedback.hidden, true);
  ui.countEl.textContent = '20000/20000+'; ui.syncCount();
  assert.equal(ui.countEl.classList.contains('rr-count-long'), true);
  ui.countEl.textContent = '1/2'; ui.syncCount();
  assert.equal(ui.countEl.classList.contains('rr-count-long'), false);
});


test('language refresh preserves SVG controls, checkboxes, values and numeric editing', t => {
  const { w, ui } = setup(t);
  ui.input.value = 'query'; ui.countEl.textContent = '2/3'; ui.locateBtn.disabled = false; ui.syncCount();
  ui.locateBtn.click(); ui.jumpInput.value = '3';
  w.RRi18n.setLanguage('en'); ui.refreshLanguage();
  assert.equal(ui.input.placeholder, 'Find'); assert.equal(ui.input.value, 'query');
  assert.equal(ui.jumpInput.value, '3'); assert.equal(ui.jumpInput.hidden, false);
  assert.equal(w.document.querySelector('#regex-settings-button').textContent, 'Settings');
  assert.equal(ui.modeBtn.textContent, '.*'); assert.equal(ui.caseBtn.textContent, 'Aa');
  assert.ok(ui.wordBtn.querySelector('svg path')); assert.ok(ui.prevBtn.querySelector('svg path'));
});

test('numeric editing validates bounds, composing Enter and cancels when results change', t => {
  const { w, ui, located } = setup(t);
  ui.countEl.textContent = '1/9999'; ui.locateBtn.disabled = false; ui.syncCount(); ui.locateBtn.click();
  for (const value of ['0', '-1', '10000', '1e3', '<script>', '999999999999']) {
    ui.jumpInput.value = value; ui.jumpInput.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(ui.jumpInput.getAttribute('aria-invalid'), 'true');
  }
  assert.equal(located.length, 0);
  ui.jumpInput.value = '9999'; ui.jumpInput.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
  assert.equal(ui.jumpInput.hidden, false); assert.equal(located.length, 0);
  ui.jumpInput.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); assert.deepEqual(located, [9999]);
  ui.locateBtn.click(); ui.countEl.textContent = ''; ui.syncCount(); assert.equal(ui.jumpInput.hidden, true);
});

test('active invalid numeric input updates its validation language without changing the query', t => {
  const { w, ui } = setup(t);
  ui.input.value = 'query'; ui.countEl.textContent = '1/3'; ui.locateBtn.disabled = false; ui.syncCount(); ui.locateBtn.click();
  ui.jumpInput.value = '4'; ui.jumpInput.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const previousMessage = ui.jumpInput.validationMessage;
  w.RRi18n.setLanguage('en'); ui.refreshLanguage();
  assert.notEqual(ui.jumpInput.validationMessage, previousMessage);
  assert.match(ui.jumpInput.validationMessage, /1.*3/); assert.match(ui.jumpInput.title, /Enter/);
  assert.equal(ui.jumpInput.hidden, false); assert.equal(ui.input.value, 'query');
});


test('main scope button changes once per activation and restores silently', t => {
  const { w, ui } = setup(t), changes = [];
  ui.scopeEl.addEventListener('change', () => changes.push(ui.scopeEl.value));
  assert.equal(ui.scopeEl.tagName, 'BUTTON');
  assert.equal(ui.scopeEl.previousElementSibling, ui.caseBtn);
  assert.equal(ui.scopeEl.nextElementSibling.contains(ui.countEl), true);
  assert.equal(ui.scopeEl.closest('#regex-advanced-panel'), null);
  assert.equal(ui.scopeEl.value, 'page'); assert.equal(ui.scopeEl.textContent, '');
  const svg = ui.scopeEl.querySelector('svg'), path = svg.firstChild, pagePath = path.getAttribute('d');
  assert.equal(svg.getAttribute('aria-hidden'), 'true');
  assert.match(ui.scopeEl.getAttribute('aria-label'), /全局.*选区/);
  ui.scopeEl.focus(); ui.scopeEl.click();
  assert.equal(w.document.activeElement, ui.scopeEl);
  assert.notEqual(path.getAttribute('d'), pagePath);
  const selectionPath = path.getAttribute('d');
  assert.match(ui.scopeEl.getAttribute('aria-label'), /选区.*全局/);
  assert.equal(ui.scopeEl.getAttribute('data-scope'), 'selection');
  ui.scopeEl.click(); assert.deepEqual(changes, ['selection', 'page']);
  assert.equal(path.getAttribute('d'), pagePath);
  ui.scopeEl.value = 'selection'; ui.scopeEl.value = 'invalid';
  assert.equal(ui.scopeEl.value, 'selection'); assert.equal(changes.length, 2);
  ui.updateOptions({ mode: 'regex', multiline: false, dotAll: false }, false, false);
  assert.equal(w.document.querySelector('#regex-advanced-toggle').getAttribute('data-active-options'), 'false');
  ui.scopeEl.setAttribute('aria-invalid', 'true');
  for (const language of w.RRi18n.supportedLanguages) {
    w.RRi18n.setLanguage(language); ui.refreshLanguage();
    assert.equal(ui.scopeEl.textContent, '');
    assert.equal(ui.scopeEl.querySelector('svg'), svg);
    assert.equal(path.getAttribute('d'), selectionPath);
    assert.ok(ui.scopeEl.getAttribute('aria-label').includes(w.RRi18n.t('toolbar.selection')));
    assert.ok(ui.scopeEl.title.includes(w.RRi18n.t('toolbar.page')));
    assert.equal(ui.scopeEl.getAttribute('aria-invalid'), 'true');
  }
  assert.equal(changes.length, 2);
  assert.equal(ui.scopeEl.getAttribute('aria-describedby'), 'regex-search-status regex-search-status-detail');
  ui.idle(); assert.equal(ui.scopeEl.getAttribute('aria-invalid'), 'false');
});
