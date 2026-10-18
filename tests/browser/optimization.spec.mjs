import { test, expect, expectTotal, isolated, locateCurrent } from './fixtures.mjs';

test('explicit location centers visible, offscreen and edge matches on both axes', async ({ app }) => {
  const { page } = app;
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.evaluate(() => {
    document.querySelector('main').innerHTML = '<div style="height:2400px;width:2600px;position:relative">' +
      '<span id="center-hit" style="position:absolute;top:1100px;left:1500px">centerBeacon</span>' +
      '<span id="edge-hit" style="position:absolute;bottom:0;right:0">centerBeacon</span></div>';
    scrollTo({ left: 1200, top: 1000, behavior: 'instant' });
  });
  await page.locator('#regex-search-input').fill('centerBeacon');
  await expectTotal(page, 2);
  const geometry = () => page.evaluate(() => {
    const rect = document.querySelector('#center-hit').getBoundingClientRect();
    return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
  });
  expect((await geometry()).y).toBeLessThan(200);
  await page.locator('#regex-search-input').press('Enter');
  await expect.poll(async () => Math.abs((await geometry()).x - 500)).toBeLessThanOrEqual(1);
  await expect.poll(async () => Math.abs((await geometry()).y - 350)).toBeLessThanOrEqual(1);
  await page.evaluate(() => scrollBy({ left: -100, top: -100, behavior: 'instant' }));
  await locateCurrent(page);
  await expect.poll(async () => Math.abs((await geometry()).y - 350)).toBeLessThanOrEqual(1);
  await page.locator('#regex-next-button').click();
  await expect.poll(() => page.evaluate(() => {
    const root = document.scrollingElement;
    return Math.abs(scrollY - (root.scrollHeight - innerHeight));
  })).toBeLessThanOrEqual(1);
  await expect.poll(() => page.evaluate(() => {
    const root = document.scrollingElement;
    return Math.abs(scrollX - (root.scrollWidth - innerWidth));
  })).toBeLessThanOrEqual(1);
  expect(app.pageErrors).toEqual([]);
});

test('nested scrollers and scaled frames center the selected text through the embedding chain', async ({ app }) => {
  const { page } = app;
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.evaluate(() => {
    document.querySelector('main').innerHTML = '<div style="height:900px"></div>' +
      '<div id="outer" style="width:700px;height:400px;overflow:auto"><div style="height:1800px;padding-top:600px;box-sizing:border-box">' +
      '<div id="inner" style="width:500px;height:200px;overflow:auto"><div style="height:1200px;padding-top:700px;box-sizing:border-box">nestedCenterBeacon</div></div>' +
      '</div></div><div style="height:1400px"></div>';
  });
  await page.locator('#regex-search-input').fill('nestedCenterBeacon');
  await expectTotal(page, 1);
  await page.locator('#regex-search-input').press('Enter');
  await expect.poll(() => page.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('#inner > div'));
    const rect = range.getBoundingClientRect(); return Math.abs((rect.top + rect.bottom) / 2 - innerHeight / 2);
  })).toBeLessThanOrEqual(1);
  const nested = await page.evaluate(() => ['inner', 'outer'].map(id => document.getElementById(id).scrollTop));
  expect(nested.every(value => value > 0)).toBe(true);
  await page.locator('#regex-search-input').fill('');
  await page.evaluate(() => {
    document.querySelector('main').innerHTML = '<div style="height:1000px"></div><iframe id="center-frame" style="width:600px;height:300px;transform:scale(.8);transform-origin:top left"></iframe><div style="height:1400px"></div>';
    const frame = document.querySelector('iframe');
    frame.contentDocument.body.innerHTML = '<div style="height:2200px;padding-top:1000px;box-sizing:border-box"><span id="frame-hit">frameCenterBeacon</span></div>';
  });
  await page.locator('#regex-search-input').fill('frameCenterBeacon');
  await expectTotal(page, 1);
  await page.locator('#regex-search-input').press('Enter');
  await expect.poll(() => page.evaluate(() => {
    const frame = document.querySelector('#center-frame'), box = frame.getBoundingClientRect();
    const rect = frame.contentDocument.querySelector('#frame-hit').getBoundingClientRect();
    const scale = box.height / frame.offsetHeight;
    return Math.abs(box.top + (frame.clientTop + (rect.top + rect.bottom) / 2) * scale - innerHeight / 2);
  })).toBeLessThanOrEqual(1);
  expect(app.pageErrors).toEqual([]);
});

test('centering avoids a moved toolbar even when the page edge prevents the requested center', async ({ app }) => {
  const { page } = app;
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.evaluate(() => {
    document.querySelector('main').innerHTML = '<div style="height:2400px;position:relative"><span id="covered-hit" style="position:absolute;left:420px;top:1000px">coveredCenterBeacon</span></div>';
  });
  await page.locator('#regex-search-input').fill('coveredCenterBeacon'); await expectTotal(page, 1);
  async function moveToolbarTo(y) {
    const bar = await page.locator('#regex-search-container').boundingBox();
    const handle = await page.locator('#regex-drag-handle').boundingBox();
    const x = handle.x + handle.width / 2, top = handle.y + handle.height / 2;
    await page.mouse.move(x, top); await page.mouse.down();
    await page.mouse.move(x + 500 - bar.x - bar.width / 2, top + y - bar.y - bar.height / 2);
    await page.mouse.up();
  }
  const geometry = () => page.evaluate(() => {
    const rect = document.querySelector('#covered-hit').getBoundingClientRect();
    const bar = document.querySelector('#regex-search-container').getBoundingClientRect();
    return { clear: rect.bottom <= bar.top || rect.top >= bar.bottom || rect.right <= bar.left || rect.left >= bar.right,
      distance: Math.abs((rect.top + rect.bottom) / 2 - innerHeight / 2), allowance: bar.height / 2 + rect.height / 2 + 9 };
  });
  await moveToolbarTo(350); await locateCurrent(page);
  await expect.poll(async () => (await geometry()).clear).toBe(true);
  const centered = await geometry(); expect(centered.distance).toBeLessThanOrEqual(centered.allowance);
  await page.locator('#regex-search-input').fill('');
  await page.evaluate(() => { document.querySelector('#covered-hit').style.top = '80px'; scrollTo({ top: 0, behavior: 'instant' }); });
  await moveToolbarTo(100);
  await page.locator('#regex-search-input').fill('coveredCenterBeacon'); await expectTotal(page, 1);
  await locateCurrent(page);
  await expect.poll(async () => (await geometry()).clear).toBe(true);
});

test('dense bound highlights retain lazy text and release their resources', async ({ app }, testInfo) => {
  const cdp = await app.page.context().newCDPSession(app.page);
  const samples = [];
  for (let round = 0; round < 3; round++) {
    await isolated(app, `(() => {
      const main = document.querySelector('main'); main.textContent = 'denseBeacon '.repeat(3000);
      return true;
    })`);
    await cdp.send('HeapProfiler.collectGarbage');
    const before = await cdp.send('Runtime.getHeapUsage');
    const sample = await isolated(app, `(async () => {
      const node = document.querySelector('main').firstChild, raw = node.nodeValue;
      const entries = [], matches = [];
      for (let i = 0; i < 3000; i++) {
        entries.push({ id: i, kind: 'bound-text', node, displayLength: 11, boundSpans: [{
          node, nodeStart: i * 12, nodeEnd: i * 12 + 11, rawSnapshot: raw,
          snapshotStart: i * 12, snapshotEnd: i * 12 + 11, start: 0, end: 11
        }] });
        matches.push({ chunkId: i, start: 0, end: 11 });
      }
      let styleReads = 0, yields = 0; const original = window.getComputedStyle, originalYield = RRTaskScheduler.yield;
      window.getComputedStyle = function (...args) { styleReads++; return original.apply(this, args); };
      RRTaskScheduler.yield = function () { yields++; return originalYield(); };
      const started = performance.now();
      try {
        window.__rrDenseResult = await RRHighlightEngine.renderMatchesBatched(entries, matches, { budgetMs: 6 });
        return { elapsedMs: performance.now() - started, styleReads, yields, marks: __rrDenseResult.marks.length,
          text: __rrDenseResult.marks[2999].textContent };
      } finally { window.getComputedStyle = original; RRTaskScheduler.yield = originalYield; }
    })`);
    await cdp.send('HeapProfiler.collectGarbage');
    sample.retainedHeapBytes = (await cdp.send('Runtime.getHeapUsage')).usedSize - before.usedSize;
    expect(sample.marks).toBe(3000); expect(sample.text).toBe('denseBeacon');
    expect(await isolated(app, `(() => {
      const result = window.__rrDenseResult; RRHighlightEngine.removeHighlights(result.handles);
      const released = result.handles[0].documents.size === 0 && result.handles[0].snapshots.size === 0;
      delete window.__rrDenseResult; return released;
    })`)).toBe(true);
    samples.push(sample);
  }
  await cdp.detach();
  console.log('Dense highlight measurements:', JSON.stringify(samples));
  await testInfo.attach('dense-highlight-measurements', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' });
});

test('navigation validates the selected result and its frame without repeated activation scans', async ({ app }, testInfo) => {
  const { page } = app;
  await page.evaluate(() => {
    document.querySelector('main').innerHTML = '<p>navigationProbe</p><div style="height:2000px"></div><p>navigationProbe</p><div style="height:1200px"></div>';
  });
  await page.locator('#regex-search-input').fill('navigationProbe'); await expectTotal(page, 2);
  await isolated(app, `(() => {
    const original = Range.prototype.getClientRects;
    window.__rrNavigationProbe = { reads: 0, original };
    Range.prototype.getClientRects = function () { __rrNavigationProbe.reads++; return original.call(this); };
  })`);
  try {
    await page.locator('#regex-next-button').click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('#regex-search-count')).toHaveText('2/2');
    const sample = await isolated(app, '(() => ({ rangeReads: __rrNavigationProbe.reads }))');
    expect(sample.rangeReads).toBeLessThanOrEqual(6);
    console.log('Navigation measurements:', JSON.stringify(sample));
    await testInfo.attach('navigation-measurements', { body: JSON.stringify(sample), contentType: 'application/json' });
    expect(await page.evaluate(() => {
      const range = [...CSS.highlights.entries()].find(([name]) => name.endsWith('-current'))?.[1]?.values().next().value;
      const rect = range.getBoundingClientRect();
      return Math.abs((rect.top + rect.bottom) / 2 - innerHeight / 2);
    })).toBeLessThanOrEqual(1);
  } finally {
    await isolated(app, '(() => { Range.prototype.getClientRects = __rrNavigationProbe.original; delete window.__rrNavigationProbe; })');
  }
});
