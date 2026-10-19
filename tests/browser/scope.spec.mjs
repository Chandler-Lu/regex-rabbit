import { test, expect, expectTotal, chooseScope, clickSearchOption } from './fixtures.mjs';

test('main scope switch preserves DOM and control selections, focus and reading position', async ({ app }) => {
  const { page } = app;
  const scope = page.locator('#regex-search-scope');
  await page.locator('#regex-search-input').fill('selectedBeacon');
  await expectTotal(page, 3);
  await page.evaluate(async () => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('#selection-a'));
    getSelection().removeAllRanges(); getSelection().addRange(range);
    scrollTo(0, 400); await new Promise(resolve => requestAnimationFrame(resolve));
  });
  const y = await page.evaluate(() => scrollY);
  await scope.click(); await expectTotal(page, 2);
  await expect(scope).toBeFocused(); await expect(scope).toHaveAttribute('data-scope', 'selection');
  await expect(page.locator('#regex-advanced-panel')).toBeHidden();
  expect(await page.evaluate(() => scrollY)).toBe(y);
  await page.keyboard.press('Space'); await expectTotal(page, 3);
  await page.keyboard.press('Enter'); await expectTotal(page, 2);
  await expect(scope).toBeFocused(); expect(await page.evaluate(() => scrollY)).toBe(y);

  await page.locator('#regex-close-button').click(); await app.toggle();
  await expect(scope).toHaveAttribute('data-scope', 'selection');
  await chooseScope(page, 'page');
  await page.evaluate(() => {
    const control = document.querySelector('#textarea-control');
    control.focus(); control.setSelectionRange(0, control.value.length);
    control.dispatchEvent(new Event('select', { bubbles: true }));
  });
  await scope.click();
  await page.locator('#regex-search-input').fill('controlBeacon');
  await expectTotal(page, 1);
  await chooseScope(page, 'page'); await expectTotal(page, 3);
  await chooseScope(page, 'selection'); await expectTotal(page, 1);

  // Rebuild the toolbar while retaining the actual selected control node.
  await clickSearchOption(page, 'regex-auto-toggle');
  await page.evaluate(() => {
    const old = document.body, next = document.createElement('body');
    for (const child of Array.from(old.children)) if (child.id !== 'regex-search-container') next.append(child);
    old.replaceWith(next);
  });
  await expect(scope).toBeVisible(); await expect(scope).toHaveAttribute('data-scope', 'selection');
  await expectTotal(page, 1);
  expect(app.pageErrors).toEqual([]);
});

test('main scope button stays visible and stable across languages, narrow windows and UI scales', async ({ app }) => {
  test.setTimeout(120_000);
  const { page, worker } = app;
  const scope = page.locator('#regex-search-scope');
  const primaryButtons = ['regex-drag-handle', 'regex-mode-toggle', 'regex-case-toggle', 'regex-search-scope',
    'regex-locate-button', 'regex-prev-button', 'regex-next-button', 'regex-advanced-toggle', 'regex-close-button'];
  expect(await scope.evaluate(node => node.previousElementSibling.id)).toBe('regex-case-toggle');
  await expect(scope.locator('svg')).toHaveAttribute('aria-hidden', 'true');
  await expect(scope).toHaveText('');
  for (const language of ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'de', 'fr', 'es']) {
    await worker.evaluate(async uiLanguage => chrome.storage.sync.set({ uiLanguage }), language);
    await expect(page.locator('#regex-search-container')).toHaveAttribute('lang', language);
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const scale of [.5, 1, 2.5]) {
        await worker.evaluate(async scale => chrome.storage.sync.set({ scale }), scale);
        await expect.poll(() => page.locator('#regex-search-container').evaluate(node => Number(getComputedStyle(node).zoom))).toBe(scale);
        await chooseScope(page, 'page');
        const snapshot = () => page.evaluate(() => {
          const container = document.querySelector('#regex-search-container');
          const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right }; };
          const nodes = Array.from(container.querySelector('.rr-query-row').children).filter(node => node.getBoundingClientRect().width > 0);
          return { toolbar: rect(container), row: nodes.map(rect), input: rect(document.querySelector('#regex-search-input')) };
        });
        const before = await snapshot();
        if (width === 1280 && scale === 1) {
          expect(before.toolbar.width).toBe(400);
          expect(before.input.width).toBeGreaterThanOrEqual(140);
          expect((await scope.boundingBox()).width).toBe(24);
          expect((await scope.locator('svg').boundingBox()).width).toBe(18);
          for (const id of primaryButtons) await expect(page.locator('#' + id)).toBeVisible();
          for (const id of ['regex-mode-toggle', 'regex-case-toggle', 'regex-prev-button', 'regex-next-button', 'regex-advanced-toggle', 'regex-close-button']) {
            expect((await page.locator('#' + id).boundingBox()).width).toBe(22);
          }
          expect(await page.locator('.rr-result-control').evaluate(node => node.getBoundingClientRect().width)).toBe(70);
        }
        const pagePath = await scope.locator('path').getAttribute('d');
        await expect(scope).toBeVisible(); await scope.click();
        expect(await scope.locator('path').getAttribute('d')).not.toBe(pagePath);
        const after = await snapshot();
        expect(after).toEqual(before);
        expect(after.input.width).toBeGreaterThan(10);
        expect(after.toolbar.x).toBeGreaterThanOrEqual(0);
        expect(after.toolbar.right).toBeLessThanOrEqual(width + 1);
        for (let index = 1; index < after.row.length; index++) {
          expect(after.row[index].x).toBeGreaterThanOrEqual(after.row[index - 1].right - 1);
          expect(after.row[index].right).toBeLessThanOrEqual(after.toolbar.right);
        }
      }
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await worker.evaluate(async () => chrome.storage.sync.set({ scale: 1, uiLanguage: 'zh-CN' }));
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(scope).toHaveCSS('color', 'rgb(138, 180, 248)');
  await page.emulateMedia({ forcedColors: 'active' });
  await expect(scope).toBeVisible();
  await page.screenshot({ path: '.tmp/scope-forced-colors.png' });
  await page.emulateMedia({ colorScheme: 'light', forcedColors: 'none' });
  await page.locator('#regex-search-container').screenshot({ path: '.tmp/scope-main-toolbar.png' });
  expect(app.pageErrors).toEqual([]);
});
