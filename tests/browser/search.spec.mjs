import { test, expect, search, expectTotal, highlightSnapshot, allHighlightSnapshots, isolated, openAdvanced, chooseScope, chooseMode, clickSearchOption, locateCurrent, openFixtureDocument, startFixtureServer } from './fixtures.mjs';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';

test('real extension searches composed visible text under restrictive page CSP', async ({ app }) => {
  const { page } = app;
  await search(page, 'needlebridge', 1);
  const ranges = (await highlightSnapshot(page)).filter((item) => !item.name.endsWith('-current')).flatMap((item) => item.texts);
  expect(ranges.join('')).toBe('needlebridge');
  await search(page, 'visibleBeacon', 2); // Includes rendered text below the viewport.
  await search(page, 'hiddenBeacon', 0);
  await search(page, 'shadowBeacon', 1);
  await search(page, 'closedBeacon', 1);
  expect(await page.evaluate(() => document.querySelector('#closed-host').shadowRoot)).toBeNull();
  await search(page, 'closedSlottedBeacon', 1);
  expect(await page.evaluate(() => document.querySelector('#closed-light').assignedSlot)).toBeNull();
  await search(page, '^slottedBeacon$', 1);
  await search(page, 'fallbackBeacon|unslottedBeacon', 0);
  await search(page, 'frameBeacon', 1);
  const frame = page.frames().find((item) => item.url().endsWith('/frame'));
  expect(await frame.evaluate(() => Array.from(CSS.highlights.values()).some((values) => Array.from(values).some((range) => range.toString() === 'frameBeacon')))).toBe(true);
  await search(page, 'controlBeacon', 3);
  await search(page, '^placeholderBeacon$', 2);
  await search(page, 'labelBeacon', 1);
  await search(page, 'unselectedBeacon|internalOptionValue', 0);
  await search(page, 'privateBeacon', 0);
  await search(page, 'passwordPlaceholderBeacon', 1);
  await search(page, 'visibleBeacon|shadowBeacon|slottedBeacon|closedBeacon|closedSlottedBeacon|frameBeacon', 7);
  await expect(page.locator('#regex-prev-button')).toHaveAccessibleName(/上一个/);
  await expect(page.locator('#regex-next-button')).toHaveAccessibleName(/下一个/);
  await expect(page.locator('#regex-close-button')).toHaveAccessibleName(/关闭/);
  await expect(page.locator('#regex-close-button')).toHaveAttribute('aria-label', /关闭/);
  await page.locator('#regex-next-button').click();
  await expect(page.locator('#regex-search-count')).toHaveText('2/7');
  await page.locator('#regex-prev-button').click();
  await expect(page.locator('#regex-search-count')).toHaveText('1/7');
  await page.locator('#regex-prev-button').click();
  await expect(page.locator('#regex-search-count')).toHaveText('7/7');
  await page.locator('#regex-next-button').click();
  await expect(page.locator('#regex-search-count')).toHaveText('1/7');
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: fileURLToPath(new URL('../../.tmp/browser-scope-verification.png', import.meta.url)) });
  expect(app.pageErrors).toEqual([]);
});

test('closed shadow roots are searched, painted and dynamically discovered through Chrome DOM access', async ({ app }) => {
  const { page }=app;
  await search(page, 'closedDynamicBeacon', 0);
  await clickSearchOption(page,'regex-auto-toggle');
  await page.evaluate(() => {window.closedFixtureRoot.querySelector('#closed-text').textContent='closedDynamicBeacon';});
  await expectTotal(page, 1);
  // Attaching a closed root to an existing host emits no parent mutation.
  await page.evaluate(() => {
    window.lateClosedFixtureRoot=document.querySelector('#late-closed-host').attachShadow({mode:'closed'});
    window.lateClosedFixtureRoot.innerHTML='<p>closedDynamicBeacon</p>';
  });
  await expectTotal(page, 2);
  const paint=await page.evaluate(() => {
    const name=Array.from(CSS.highlights.keys()).find(key=>key.startsWith('rr-find-') && !key.endsWith('-current'));
    return {exposed:document.querySelector('#closed-host').shadowRoot,
      initial:getComputedStyle(window.closedFixtureRoot.querySelector('#closed-text'),`::highlight(${name})`).backgroundColor,
      late:getComputedStyle(window.lateClosedFixtureRoot.querySelector('p'),`::highlight(${name})`).backgroundColor};
  });
  expect(paint.exposed).toBeNull();
  expect(paint.initial).toBe('rgb(255, 224, 130)');
  expect(paint.late).toBe('rgb(255, 224, 130)');
  await page.locator('#regex-close-button').click();
  expect(await allHighlightSnapshots(page)).toEqual([]);
  expect(app.pageErrors).toEqual([]);
});

test('thousands of matches in one text run render without monopolizing the page', async ({ app }, testInfo) => {
  const { page } = app;
  await app.worker.evaluate(async () => { await chrome.storage.sync.set({ maxMatches:5000 }); });
  await page.evaluate(async () => {
    const p = document.createElement('p'); p.textContent='bulkBeacon '.repeat(3000);
    document.querySelector('main').replaceChildren(p);
    void document.body.offsetHeight;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    heartbeat.maxGap=0; heartbeat.last=performance.now();
  });
  const started=performance.now();
  await search(page, 'bulkBeacon', 3000);
  const measurement={matches:3000, elapsedMs:performance.now()-started,
    ...await page.evaluate(() => ({maxHeartbeatGapMs:heartbeat.maxGap,
      ranges:Array.from(CSS.highlights.entries()).filter(([name]) => name.startsWith('rr-find-') && !name.endsWith('-current')).reduce((sum,[,ranges]) => sum+ranges.size,0)}))};
  expect(measurement.ranges).toBe(3000);
  expect(measurement.maxHeartbeatGapMs).toBeLessThan(1500);
  await testInfo.attach('many-match-measurement', {body:JSON.stringify(measurement,null,2),contentType:'application/json'});
  await page.locator('#regex-close-button').click();
  expect(await highlightSnapshot(page)).toEqual([]);
  expect(app.pageErrors).toEqual([]);
});

test('composed slot text and CSS whitespace/case transformations preserve source nodes', async ({ app }) => {
  const { page } = app;
  await page.evaluate(() => {
    const host = document.createElement('div'); host.id = 'composed-host';
    host.innerHTML = '<span slot="middle">middle</span>';
    host.attachShadow({mode:'open'}).innerHTML = '<span>cross</span><slot name="middle"></slot><span>rootBeacon</span>';
    const text = document.createElement('p'); text.id='normalized-text'; text.textContent='spaced   \n   Beacon';
    const preline=document.createElement('p'); preline.style.whiteSpace='pre-line'; preline.textContent='first \n second';
    const upper = document.createElement('p'); upper.id='transformed-text'; upper.style.textTransform='uppercase'; upper.textContent='capitalBeacon';
    document.querySelector('main').append(host, text, preline, upper);
    window.composedSource = host.firstChild.firstChild;
    window.normalizedSource = text.firstChild;
  });
  await search(page, 'crossmiddlerootBeacon', 1);
  const texts = (await highlightSnapshot(page)).flatMap((item) => item.texts);
  expect(texts).toEqual(expect.arrayContaining(['cross', 'middle', 'rootBeacon']));
  await search(page, 'spaced Beacon', 1);
  await search(page, 'first\\nsecond', 1);
  await clickSearchOption(page,'regex-case-toggle');
  await search(page, 'CAPITALBEACON', 1);
  await search(page, 'capitalBeacon', 0);
  await page.evaluate(async () => {
    const range=document.createRange(); range.setStart(window.normalizedSource,7); range.setEnd(window.normalizedSource,window.normalizedSource.length);
    const selection=getSelection(); selection.removeAllRanges(); selection.addRange(range);
    await new Promise(done=>requestAnimationFrame(done));
  });
  await chooseScope(page,'selection');
  await search(page, '^Beacon$', 1);
  await page.locator('#regex-close-button').click();
  expect(await page.evaluate(() => document.querySelector('#composed-host span').firstChild === window.composedSource &&
    document.querySelector('#normalized-text').firstChild === window.normalizedSource && document.querySelector('#transformed-text').textContent === 'capitalBeacon')).toBe(true);
  expect(app.pageErrors).toEqual([]);
});

test('strict style CSP still paints document and shadow highlights', async ({ app }) => {
  const { page } = app;
  await page.goto(app.url + '/strict-style');
  await page.waitForFunction(() => window.fixtureReady === true);
  await app.toggle();
  await search(page, 'strictBeacon', 2);
  const paint = await page.evaluate(() => {
    const name = Array.from(CSS.highlights.keys()).find((key) => key.startsWith('rr-find-') && !key.endsWith('-current'));
    const shadow = document.querySelector('#strict-shadow').shadowRoot.querySelector('p');
    return {document:getComputedStyle(document.querySelector('#strict-visible'), `::highlight(${name})`).backgroundColor,
      shadow:getComputedStyle(shadow, `::highlight(${name})`).backgroundColor};
  });
  expect(paint.document).toBe('rgb(255, 224, 130)');
  expect(paint.shadow).toBe('rgb(255, 224, 130)');
  expect(app.pageErrors).toEqual([]);
});

test('rendered boundaries, inaccessible frames and query flags report actual visible results', async ({ app }) => {
  const { page } = app;
  await search(page, 'restoredBeacon', 2);
  await search(page, 'ariaBeacon', 1); // Accessibility hiding does not hide pixels.
  await search(page, 'clippedBeacon|collapsedBeacon|svgHiddenBeacon|opaqueBeacon', 0);
  await expect(page.locator('#regex-search-count')).toHaveAttribute('title', /有 1 个内嵌页面无法(?:访问|读取)/);
  await search(page, 'summaryBeacon|svgBeacon', 2);
  const svgPaint=await page.evaluate(() => ['svg-no-paint','svg-fill-zero','svg-stroke'].map(id => {
    const element=document.getElementById(id), style=getComputedStyle(element), rect=element.getBoundingClientRect();
    return {id,fill:style.fill,stroke:style.stroke,fillOpacity:style.fillOpacity,strokeOpacity:style.strokeOpacity,width:rect.width,height:rect.height};
  }));
  console.log('SVG paint geometry:',JSON.stringify(svgPaint));
  await search(page, 'paintHiddenMarker|opacityHiddenMarker', 0);
  await search(page, 'strokeBeacon', 1);
  await search(page, 'svgBeacon', 1);
  await page.screenshot({path:fileURLToPath(new URL('../../.tmp/browser-svg-verification.png',import.meta.url))});
  await page.evaluate(() => {
    const section = document.createElement('section');
    section.innerHTML = '<p>blockStart</p><p>blockEnd</p><pre>lineStart\nlineEnd</pre>';
    document.querySelector('main').appendChild(section);
  });
  await search(page, 'blockStartblockEnd', 0);
  await search(page, '^lineEnd$', 0);
  await clickSearchOption(page,'regex-multiline-toggle');
  await expectTotal(page, 1);
  await search(page, 'lineStart.lineEnd', 0);
  await clickSearchOption(page,'regex-dotall-toggle');
  await expectTotal(page, 1);
  expect(app.pageErrors).toEqual([]);
});

test('auto search discovers late shadow roots, CSSOM changes and eventless control values', async ({ app }) => {
  const { page } = app;
  await page.evaluate(() => {
    const host = document.createElement('div'); host.id = 'late-shadow-host'; document.querySelector('main').appendChild(host);
    const css = document.createElement('style'); css.id = 'author-style'; css.textContent = '.cssom-hidden{display:none}'; document.head.appendChild(css);
    const hidden = document.createElement('p'); hidden.className = 'cssom-hidden'; hidden.textContent = 'lateBeacon'; document.querySelector('main').appendChild(hidden);
    document.querySelector('#dynamic').textContent = 'lateBeacon';
  });
  await search(page, 'lateBeacon', 1);
  await clickSearchOption(page,'regex-auto-toggle');
  // Test each eventless change independently; another DOM mutation must not
  // hide a missing discovery path for CSSOM or programmatic form values.
  await page.evaluate(() => {
    document.querySelector('#late-shadow-host').attachShadow({mode:'open'}).innerHTML = '<p>lateBeacon</p>';
  });
  await expectTotal(page, 2);
  await page.evaluate(() => {
    document.querySelector('#text-control').value = 'lateBeacon';
  });
  await expectTotal(page, 3);
  await page.evaluate(() => {
    document.querySelector('#author-style').sheet.cssRules[0].style.display = 'block';
  });
  await expectTotal(page, 4);
  expect(app.pageErrors).toEqual([]);
});

test('literal, case, Unicode whole words and selection scope use the visible UI', async ({ app }) => {
  const { page } = app;
  await chooseMode(page,'literal');
  await search(page, 'literal[a]+', 1);
  await search(page, 'café', 3);
  await clickSearchOption(page,'regex-word-toggle');
  await expectTotal(page, 2);
  await clickSearchOption(page,'regex-case-toggle');
  await expectTotal(page, 1);
  await search(page, '猫', 1);

  await page.evaluate(() => {
    const node = document.querySelector('#selection-a').firstChild;
    const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 'selectedBeacon'.length);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  // Let the extension remember the page selection before focusing its UI.
  await page.waitForTimeout(50);
  await chooseScope(page,'selection');
  await search(page, 'selectedBeacon', 1);
});

test('auto search follows body, shadow, frame, visibility and control changes without self loops', async ({ app }) => {
  const { page } = app;
  await search(page, 'dynamicBeacon', 1);
  await clickSearchOption(page,'regex-auto-toggle');
  await page.evaluate(() => {
    const p = document.createElement('p'); p.textContent = 'dynamicBeacon'; document.querySelector('main').appendChild(p);
  });
  await expectTotal(page, 2);
  await page.evaluate(() => {
    document.querySelector('#shadow-host').shadowRoot.querySelector('#shadow-text').textContent = 'dynamicBeacon';
  });
  await expectTotal(page, 3);
  await page.evaluate(() => {
    document.querySelector('#same-frame').contentDocument.querySelector('#frame-text').textContent = 'dynamicBeacon';
  });
  await expectTotal(page, 4);
  await page.evaluate(() => {
    document.querySelector('#dynamic-hidden').classList.remove('hidden');
  });
  await expectTotal(page, 5);
  await page.evaluate(() => {
    document.querySelector('#text-control').value = 'dynamicBeacon';
    document.querySelector('#text-control').dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expectTotal(page, 6);
  const beforeNavigation = (await highlightSnapshot(page)).map((item) => item.name);
  await page.evaluate(() => { document.querySelector('#same-frame').src = '/frame-next'; });
  await expect.poll(() => page.frames().some((frame) => frame.url().endsWith('/frame-next'))).toBe(true);
  await expect.poll(async () => {
    const names = (await highlightSnapshot(page)).map((item) => item.name);
    return names.length > 0 && JSON.stringify(names) !== JSON.stringify(beforeNavigation);
  }).toBe(true);
  await expectTotal(page, 6);
  // Each new session gets a new registry name. A stable name across multiple
  // debounce periods proves that highlighting does not trigger a search loop.
  await page.waitForTimeout(800);
  const names = (await highlightSnapshot(page)).map((item) => item.name);
  await page.waitForTimeout(1_600);
  expect((await highlightSnapshot(page)).map((item) => item.name)).toEqual(names);
  expect(app.pageErrors).toEqual([]);
});

test('closing preserves text identity and page highlights; auto search recovers after SPA body replacement', async ({ app }) => {
  const { page } = app;
  await page.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('#visible'));
    CSS.highlights.set('page-owned', new Highlight(range));
  });
  await search(page, 'needlebridge|frameBeacon', 2);
  await page.locator('#regex-close-button').click();
  expect(await allHighlightSnapshots(page)).toEqual([]);
  expect(await page.evaluate(() => document.querySelector('#inline span').firstChild === window.originalInlineNode &&
    document.querySelector('#editable').firstChild === window.originalEditableNode && CSS.highlights.has('page-owned'))).toBe(true);
  await app.toggle();
  await search(page, 'needlebridge', 1);
  await clickSearchOption(page,'regex-auto-toggle');
  await page.evaluate(() => {
    const body = document.createElement('body'); body.innerHTML = '<main><p>spaBeacon</p></main>';
    document.body.replaceWith(body);
  });
  await expect.poll(() => highlightSnapshot(page)).toEqual([]);
  await expect(page.locator('#regex-search-container')).toBeVisible();
  await expect(page.locator('#regex-search-input')).toHaveValue('needlebridge');
  expect(await page.evaluate(() => document.activeElement?.id === 'regex-search-input')).toBe(false);
  await search(page, 'spaBeacon', 1);
  expect(app.pageErrors).toEqual([]);
});

test('invalid and screened queries stay responsive; watchdog terminates an uninterruptible worker', async ({ app }) => {
  const { page } = app;
  await search(page, '[');
  await expect(page.locator('#regex-search-status')).toHaveText('正则有误');
  await search(page, '(a+)+$');
  await expect(page.locator('#regex-search-status')).toHaveText('表达式可能卡顿');
  await search(page, 'visibleBeacon', 2); // Warm the real offscreen host.
  const before = await page.evaluate(() => heartbeat.ticks);
  // Deliberately exercise the watchdog below the analyzer: screening rules are
  // heuristic, so execution safety must not depend on recognizing this regex.
  const result = await isolated(app, `(async () => {
    RRWorkerManager.updateConfig({ workerTimeoutMs: 1000, allowUnsafeEcmascript:true });
    const start = performance.now();
    try {
      await RRWorkerManager.searchStream(900001, '^a+a+a+a+a+a+a+a+a+$', 'gu', async (send) => {
        await send([{id:0, text:'a'.repeat(12000)+'!'}]);
      }, {ok:true, status:'safe'});
      return {unexpectedSuccess:true};
    } catch (error) {
      return {code:error.code, message:error.message, elapsedMs:performance.now()-start};
    }
  })`);
  expect(result.code).toBe('search-timeout');
  expect(result.elapsedMs).toBeLessThan(5_000);
  expect(await page.evaluate(() => heartbeat.ticks)).toBeGreaterThan(before + 10);
  expect(await page.evaluate(() => heartbeat.maxGap)).toBeLessThan(1_000);
  await search(page, 'visibleBeacon', 2); // A fresh worker works after timeout.
  expect(app.pageErrors).toEqual([]);
});

test('rapid input cancels stale results and closing cancels an active search', async ({ app }) => {
  const { page } = app;
  const input = page.locator('#regex-search-input');
  await input.fill('shadowBeacon'); await input.press('Enter');
  await input.fill('missingBeacon'); await input.press('Enter');
  await input.fill('frameBeacon'); await input.press('Enter');
  await expectTotal(page, 1);
  const texts = (await highlightSnapshot(page)).flatMap((item) => item.texts);
  expect(texts).not.toContain('shadowBeacon');
  await expect.poll(async () => (await allHighlightSnapshots(page)).some((item) => item.texts.includes('frameBeacon'))).toBe(true);
  await page.evaluate(() => {
    const p=document.createElement('p'); p.textContent='a'.repeat(20000)+'!';
    document.querySelector('main').replaceChildren(p);
  });
  await input.fill('a*a*a*a*a*a*a*a*b'); await input.press('Enter');
  await expect(page.locator('#regex-search-status')).toHaveText('查找中');
  // Confirm chunks reached a real offscreen client before closing. A tiny
  // ordinary query could otherwise finish before the Close click arrives.
  await expect.poll(() => app.worker.evaluate(() => Array.from(clients.values()).some(client => client.ready && client.sequence>=2))).toBe(true);
  await page.locator('#regex-close-button').click();
  await expect.poll(() => app.worker.evaluate(() => clients.size)).toBe(0);
  expect(await allHighlightSnapshots(page)).toEqual([]);
  await expect(page.locator('#regex-search-container')).toBeHidden();
  await page.evaluate(() => {document.querySelector('main').textContent='recoveredBeacon';});
  await app.toggle();
  await search(page, 'recoveredBeacon', 1);
  expect(app.pageErrors).toEqual([]);
});

test('records bounded 20,000-node collection and heartbeat measurements', async ({ app }, testInfo) => {
  test.setTimeout(70000);
  const { page } = app;
  await app.worker.evaluate(async()=>{await chrome.storage.sync.set({workerTimeoutMs:30000});});
  await page.evaluate(() => {
    const main = document.querySelector('main'); main.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < 20000; i++) { const p = document.createElement('p'); p.textContent = `row ${i} benchmark content`; fragment.appendChild(p); }
    const target = document.createElement('p'); target.textContent = 'benchmarkBeacon'; fragment.appendChild(target);
    main.appendChild(fragment);
  });
  // Flush the initial document layout before measuring the search itself.
  await page.evaluate(async () => {
    void document.body.offsetHeight;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    heartbeat.maxGap=0; heartbeat.last=performance.now();
  });
  const started = performance.now();
  await search(page, 'benchmarkBeacon');
  await expect(page.locator('#regex-search-count')).toHaveText(/^\d+\/1$/,{timeout:35000});
  const measurement = {
    nodes: 20001, elapsedMs: performance.now() - started,
    ...await page.evaluate(() => ({ maxHeartbeatGapMs: heartbeat.maxGap, status: document.querySelector('#regex-search-count').title })),
  };
  Object.assign(measurement, await isolated(app, `(async () => {
    // Settle pending paint/scroll work before starting a local heartbeat; IPC
    // before this function and after its result cannot enter the measurement.
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
    await new Promise(done => setTimeout(done,20));
    let emittedEntries=0, maxGap=0, last=performance.now(), ticks=0;
    const interval=setInterval(() => {const now=performance.now(); maxGap=Math.max(maxGap,now-last); last=now; ticks++;},10);
    const started=performance.now();
    try {
      const entries=await RRTextCollector.collectBatched({batchSize:128,budgetMs:6,storeNodes:false,
        onBatch(batch) {emittedEntries += batch.length;}});
      const elapsed=performance.now()-started;
      await new Promise(done => setTimeout(done,20));
      return {collectionElapsedMs:elapsed,collectedEntries:emittedEntries,
        collectedCharacters:entries.stats.characters,visitedNodes:entries.stats.visitedNodes,
        collectionMaxHeartbeatGapMs:maxGap,collectionHeartbeatTicks:ticks};
    } finally {clearInterval(interval);}
  })`));
  expect(measurement.status).toMatch(/已扫描 [\d,]+ 个字符/);
  expect(measurement.collectedEntries).toBeGreaterThanOrEqual(20001);
  expect(measurement.collectionElapsedMs).toBeLessThan(10000);
  expect(measurement.collectionMaxHeartbeatGapMs).toBeLessThan(250);
  expect(measurement.collectionHeartbeatTicks).toBeGreaterThan(3);
  expect(measurement.elapsedMs).toBeLessThan(30_000);
  expect(measurement.maxHeartbeatGapMs).toBeLessThan(2_000);
  await testInfo.attach('large-dom-measurement', { body: JSON.stringify(measurement, null, 2), contentType: 'application/json' });
  console.log('Large DOM measurement:', JSON.stringify(measurement));
  await page.locator('#regex-close-button').click();
  const cancellation=await isolated(app, `(async () => {
    const p=document.createElement('p'); p.textContent='a  '.repeat(40000)+'z'; document.querySelector('main').replaceChildren(p);
    await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
    await new Promise(done=>setTimeout(done,20));
    const abortController=new AbortController();
    let cancelledAt=null,cancelledState=null,emittedEntries=0,statsCallbacks=0,ticks=0,maxGap=0,last=performance.now();
    const heartbeat=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now;ticks++;},10);
    const started=performance.now();
    try {
      // Request cancellation at an observed partial normalization checkpoint.
      // A 1ms timer can legitimately fire after a fast collection completes.
      const entries=await RRTextCollector.collectBatched({batchSize:128,budgetMs:1,storeNodes:false,maxRunSegments:100000,
        maxDurationMs:5000,signal:abortController.signal,
        onStats(stats) {
          statsCallbacks++;
          if(!abortController.signal.aborted&&stats.peakBufferedSegments>0&&stats.entries===0) {
            cancelledState={entries:stats.entries,peakBufferedSegments:stats.peakBufferedSegments,scannedSourceCharacters:stats.scannedSourceCharacters};
            cancelledAt=performance.now();abortController.abort();
          }
        },
        onBatch(batch){emittedEntries+=batch.length;return true;}});
      const collectionFinished=performance.now();
      await new Promise(done=>setTimeout(done,20));
      return {aborted:entries.stats.aborted,elapsedMs:performance.now()-started,
        collectionElapsedMs:collectionFinished-started,cancelled:abortController.signal.aborted,cancelledAtMs:cancelledAt===null?null:cancelledAt-started,
        cancelledDuringCollection:cancelledAt!==null&&cancelledAt<=collectionFinished,cancelledState,emittedEntries,statsCallbacks,stats:entries.stats,
        ownHighlightRanges:Array.from(CSS.highlights.entries()).filter(([name])=>name.startsWith('rr-find-')).reduce((sum,[,ranges])=>sum+ranges.size,0),
        maxHeartbeatGapMs:maxGap,ticks};
    } finally {clearInterval(heartbeat);}
  })`);
  console.log('Single text cancellation:',JSON.stringify(cancellation));
  expect(cancellation.aborted).toBe(true);
  expect(cancellation.cancelled).toBe(true);
  expect(cancellation.cancelledDuringCollection).toBe(true);
  expect(cancellation.cancelledState.entries).toBe(0);
  expect(cancellation.cancelledState.peakBufferedSegments).toBeGreaterThan(0);
  expect(cancellation.stats.entries).toBe(0);
  expect(cancellation.stats.reasons).toContain('signal');
  expect(cancellation.emittedEntries).toBe(0);
  expect(cancellation.ownHighlightRanges).toBe(0);
  expect(cancellation.elapsedMs).toBeLessThan(1000);
  expect(cancellation.maxHeartbeatGapMs).toBeLessThan(250);
  // A fast cancellation may finish before a second heartbeat is due.
  await testInfo.attach('single-text-cancellation', {body:JSON.stringify(cancellation,null,2),contentType:'application/json'});
});

test('selection scope captures native controls, nested frames and accessible shadow selections before opening', async ({ app }) => {
  const {page}=app;
  // An unrelated occurrence must never leak into a captured selection.
  await page.evaluate(() => {
    const p=document.createElement('p');p.textContent='controlSelectionBeacon frameSelectionBeacon shadowSelectionBeacon';document.querySelector('main').append(p);
    document.querySelector('#text-control').value='prefix controlSelectionBeacon suffix controlSelectionBeacon';
    document.querySelector('#textarea-control').value='prefix controlSelectionBeacon suffix controlSelectionBeacon';
    const frame=document.querySelector('#same-frame');
    frame.contentDocument.querySelector('#frame-text').textContent='prefix frameSelectionBeacon suffix frameSelectionBeacon';
    document.querySelector('#shadow-host').shadowRoot.querySelector('#shadow-text').textContent='prefix shadowSelectionBeacon suffix shadowSelectionBeacon';
    window.closedFixtureRoot.querySelector('#closed-text').textContent='prefix shadowSelectionBeacon suffix shadowSelectionBeacon';
  });
  for (const controlId of ['text-control','textarea-control']) {
    await page.locator('#regex-close-button').click();
    await page.evaluate((id)=>{
      const node=document.getElementById(id);node.focus();node.setSelectionRange(7,7+'controlSelectionBeacon'.length);
    },controlId);
    await app.toggle();
    await chooseScope(page,'selection');
    await search(page,'^controlSelectionBeacon$',1);
    expect(await page.evaluate(id=>document.getElementById(id).value,controlId)).toBe('prefix controlSelectionBeacon suffix controlSelectionBeacon');
  }
  await page.locator('#regex-close-button').click();
  await page.evaluate(()=>{
    const doc=document.querySelector('#same-frame').contentDocument;
    const p=doc.querySelector('#frame-text');p.tabIndex=0;p.focus();
    const range=doc.createRange();range.setStart(p.firstChild,7);range.setEnd(p.firstChild,7+'frameSelectionBeacon'.length);
    const selection=doc.getSelection();selection.removeAllRanges();selection.addRange(range);
  });
  await app.toggle();
  await chooseScope(page,'selection');
  await search(page,'^frameSelectionBeacon$',1);
  await page.locator('#regex-close-button').click();
  await page.evaluate(()=>{
    const doc=document.querySelector('#same-frame').contentDocument;
    const frame=doc.createElement('iframe');frame.id='selection-nested-frame';frame.srcdoc='<p id="nested-selection">prefix nestedSelectionBeacon suffix nestedSelectionBeacon</p>';doc.body.append(frame);
  });
  await page.waitForFunction(()=>document.querySelector('#same-frame').contentDocument?.querySelector('#selection-nested-frame')?.contentDocument?.querySelector('#nested-selection'));
  await page.evaluate(()=>{
    const doc=document.querySelector('#same-frame').contentDocument.querySelector('#selection-nested-frame').contentDocument;
    const p=doc.querySelector('#nested-selection');p.tabIndex=0;p.focus();
    const range=doc.createRange();range.setStart(p.firstChild,7);range.setEnd(p.firstChild,7+'nestedSelectionBeacon'.length);
    const selection=doc.getSelection();selection.removeAllRanges();selection.addRange(range);
  });
  await app.toggle();
  await chooseScope(page,'selection');
  await search(page,'^nestedSelectionBeacon$',1);
  for (const mode of ['open','closed']) {
    await page.locator('#regex-close-button').click();
    await page.evaluate((which)=>{
      const root=which==='open'?document.querySelector('#shadow-host').shadowRoot:window.closedFixtureRoot;
      const p=root.querySelector('p');p.tabIndex=0;p.focus();
      const range=document.createRange();range.setStart(p.firstChild,7);range.setEnd(p.firstChild,7+'shadowSelectionBeacon'.length);
      const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
    },mode);
    await app.toggle();
    await chooseScope(page,'selection');
    await search(page,'^shadowSelectionBeacon$',1);
  }
  await page.locator('#regex-close-button').click();
  expect(await allHighlightSnapshots(page)).toEqual([]);
  expect(app.pageErrors).toEqual([]);
});

test('auto search follows nested frames inside open and closed shadow roots and releases detached results', async ({ app }) => {
  const {page}=app;
  await page.evaluate(()=>{
    for(const mode of ['open','closed']) {
      const host=document.createElement('div');host.id=`recursive-${mode}-host`;
      const root=host.attachShadow({mode});
      root.innerHTML='<iframe srcdoc="<iframe srcdoc=\'&lt;p id=recursive-text&gt;recursiveFrameBeacon&lt;/p&gt;\'></iframe>"></iframe>';
      window[`recursive${mode}Root`]=root;document.querySelector('main').prepend(host);
    }
  });
  await page.waitForFunction(()=>['open','closed'].every(mode=>window[`recursive${mode}Root`].querySelector('iframe').contentDocument?.querySelector('iframe')?.contentDocument?.querySelector('#recursive-text')));
  await search(page,'recursiveFrameBeacon',2);
  await clickSearchOption(page,'regex-auto-toggle');
  await search(page,'recursiveChangedBeacon',0);
  for(const [index,mode] of ['open','closed'].entries()) {
    await page.evaluate(which=>{
      window[`recursive${which}Root`].querySelector('iframe').contentDocument.querySelector('iframe').contentDocument.querySelector('#recursive-text').textContent='recursiveChangedBeacon';
    },mode);
    await expectTotal(page,index+1);
  }
  await page.evaluate(()=>{
    window.retainedRecursiveRegistries={};
    for(const mode of ['open','closed']) window.retainedRecursiveRegistries[mode]=window[`recursive${mode}Root`].querySelector('iframe').contentDocument.querySelector('iframe').contentDocument.defaultView.CSS.highlights;
  });
  await page.evaluate(()=>document.querySelector('#recursive-closed-host').remove());
  await expectTotal(page,1);
  expect(await page.evaluate(()=>Array.from(window.retainedRecursiveRegistries.closed.keys()).filter(name=>name.startsWith('rr-find-')))).toEqual([]);
  await page.evaluate(()=>document.querySelector('#recursive-open-host').remove());
  await expectTotal(page,0);
  expect(await page.evaluate(()=>Array.from(window.retainedRecursiveRegistries.open.keys()).filter(name=>name.startsWith('rr-find-')))).toEqual([]);
  expect(app.pageErrors).toEqual([]);
});

test('selection scope rejects changed control values and private password selections', async ({ app }) => {
  const {page}=app;
  await page.locator('#regex-close-button').click();
  await page.evaluate(()=>{
    const node=document.querySelector('#text-control');node.value='controlSelectionBeacon';node.focus();node.select();
  });
  await app.toggle();
  await chooseScope(page,'selection');
  await search(page,'^controlSelectionBeacon$',1);
  await page.evaluate(()=>{document.querySelector('#text-control').value='controlSelectionBeacon changed';});
  await search(page,'^controlSelectionBeacon$');
  await expect(page.locator('#regex-search-status')).toHaveText('先选文字');
  await page.locator('#regex-close-button').click();
  await page.evaluate(()=>{
    getSelection().removeAllRanges();
    const node=document.querySelector('input[type="password"]');node.focus();node.select();
  });
  await app.toggle();
  await chooseScope(page,'selection');
  await search(page,'privateBeacon');
  await expect(page.locator('#regex-search-status')).toHaveText('先选文字');
  expect(app.pageErrors).toEqual([]);
});

test('selection scope updates from a discovered iframe while the toolbar remains open', async ({ app }) => {
  const {page}=app;
  await search(page,'frameBeacon',1); // Discover and track the child Document.
  await page.evaluate(()=>{
    const node=document.querySelector('#selection-a').firstChild;
    const range=document.createRange();range.setStart(node,0);range.setEnd(node,'selectedBeacon'.length);
    const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
  });
  await page.waitForTimeout(50);
  await chooseScope(page,'selection');
  await search(page,'^selectedBeacon$',1);
  await page.evaluate(()=>{
    const doc=document.querySelector('#same-frame').contentDocument;
    const p=doc.querySelector('#frame-text');p.tabIndex=0;p.focus();
    const range=doc.createRange();range.setStart(p.firstChild,5);range.setEnd(p.firstChild,11);
    const selection=doc.getSelection();selection.removeAllRanges();selection.addRange(range);
  });
  await page.waitForTimeout(50);
  await search(page,'^Beacon$',1);
  const frame=page.frames().find(item=>item.url().endsWith('/frame'));
  expect(await frame.evaluate(()=>Array.from(CSS.highlights.entries()).filter(([name])=>name.startsWith('rr-find-')&&!name.endsWith('-current')).flatMap(([,ranges])=>Array.from(ranges,range=>({text:range.toString(),start:range.startOffset,end:range.endOffset}))))).toEqual([{text:'Beacon',start:5,end:11}]);
  expect(app.pageErrors).toEqual([]);
});

test('selection scope rejects retained controls and shadow controls after their iframe detaches', async ({ app }) => {
  const {page}=app;
  for(const shadow of [false,true]) {
    await page.locator('#regex-close-button').click();
    await page.evaluate(()=>{
      const frame=document.createElement('iframe');frame.id='detached-selection-frame';frame.srcdoc='<main></main>';document.querySelector('main').prepend(frame);
    });
    await page.waitForFunction(()=>document.querySelector('#detached-selection-frame').contentDocument?.querySelector('main'));
    await page.evaluate(useShadow=>{
      const frame=document.querySelector('#detached-selection-frame'),doc=frame.contentDocument;
      let target=doc.querySelector('main');
      if(useShadow) {
        const host=doc.createElement('div');target.append(host);target=host.attachShadow({mode:'closed'});
      }
      const input=doc.createElement('input');input.value='detachedControlBeacon';target.append(input);input.focus();input.select();
      window.retainedDetachedControl=input;window.retainedDetachedFrame=frame;
    },shadow);
    await app.toggle();
    await chooseScope(page,'selection');
    await search(page,'^detachedControlBeacon$',1);
    const detached=await page.evaluate(()=>{
      window.retainedDetachedFrame.remove();
      return {nodeConnected:window.retainedDetachedControl.isConnected,frameConnected:window.retainedDetachedFrame.isConnected,value:window.retainedDetachedControl.value};
    });
    expect(detached).toEqual({nodeConnected:true,frameConnected:false,value:'detachedControlBeacon'});
    await search(page,'^detachedControlBeacon$');
    await expect(page.locator('#regex-search-status')).toHaveText('先选文字');
    expect(await allHighlightSnapshots(page)).toEqual([]);
  }
  expect(app.pageErrors).toEqual([]);
});

test('selection trackers release all child-document and shadow listeners when an outer iframe detaches', async ({ app }) => {
  const result=await isolated(app, `(async()=>{
    const frame=document.createElement('iframe');
    frame.srcdoc='<div id="tracked-host"></div><iframe id="tracked-inner" srcdoc="<p>trackedFrame</p>"></iframe>';
    document.querySelector('main').append(frame);
    const wait=async()=>{
      for(let attempt=0;attempt<100;attempt++) {
        const doc=frame.contentDocument,nested=doc?.querySelector('#tracked-inner')?.contentDocument;
        if(doc?.querySelector('#tracked-host')&&nested?.querySelector('p')) return {doc,nested};
        await new Promise(done=>setTimeout(done,10));
      }
      throw new Error('Tracked child documents did not load');
    };
    let tracker;
    const records=[],events=new Set(['selectionchange','select','pointerup','keyup','pointerdown','wheel','touchstart','keydown']);
    try {
      const {doc,nested}=await wait();
      const host=doc.querySelector('#tracked-host'),shadow=host.attachShadow({mode:'closed'});
      shadow.innerHTML='<p>trackedShadow</p>';
      for(const [name,root] of [['document',doc],['nestedDocument',nested],['closedShadow',shadow]]) {
        const record={name,root,added:[],removed:[],addDescriptor:Object.getOwnPropertyDescriptor(root,'addEventListener'),removeDescriptor:Object.getOwnPropertyDescriptor(root,'removeEventListener')};
        records.push(record);
        const originalAdd=root.addEventListener,originalRemove=root.removeEventListener;
        root.addEventListener=function(type,listener,options){if(events.has(type))record.added.push({type,listener});return originalAdd.call(this,type,listener,options);};
        root.removeEventListener=function(type,listener,options){if(events.has(type))record.removed.push({type,listener});return originalRemove.call(this,type,listener,options);};
      }
      tracker=RRSelectionCapture.createTracker({document});tracker.start(records.map(record=>record.root));
      frame.remove();tracker.prune();
      return records.map(record=>({name:record.name,added:record.added.map(item=>item.type),removed:record.removed.map(item=>item.type),
        listenersMatch:record.added.every(added=>record.removed.some(removed=>removed.type===added.type&&removed.listener===added.listener)),
        nodeStillConnected:record.root.nodeType===9?record.root.documentElement.isConnected:record.root.host.isConnected}));
    } finally {
      if(tracker)tracker.dispose();frame.remove();
      for(const record of records) {
        if(record.addDescriptor)Object.defineProperty(record.root,'addEventListener',record.addDescriptor);else delete record.root.addEventListener;
        if(record.removeDescriptor)Object.defineProperty(record.root,'removeEventListener',record.removeDescriptor);else delete record.root.removeEventListener;
      }
    }
  })`);
  expect(result).toHaveLength(3);
  for(const record of result) {
    expect(record.added).toEqual(record.name === 'closedShadow' ? ['selectionchange','select'] :
      ['selectionchange','select','pointerup','keyup','pointerdown','wheel','touchstart','keydown']);
    expect(record.removed).toEqual(record.added);
    expect(record.listenersMatch).toBe(true);
    expect(record.nodeStillConnected).toBe(true);
  }
  expect(app.pageErrors).toEqual([]);
});

test('IME Escape and Enter preserve composing input and do not close the toolbar', async ({ app }) => {
  const {page}=app;
  await search(page,'visibleBeacon',2);
  const composing=await page.evaluate(()=>{
    const input=document.querySelector('#regex-search-input');
    input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'拼'}));
    input.value='draftBeacon';input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'拼',isComposing:true}));
    const escaped=input.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Escape',code:'Escape',isComposing:true}));
    const entered=input.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Enter',code:'Enter',isComposing:true}));
    return {escaped,entered,value:input.value,display:document.querySelector('#regex-search-container').style.display};
  });
  expect(composing).toEqual({escaped:true,entered:true,value:'draftBeacon',display:'flex'});
  await expect(page.locator('#regex-search-container')).toBeVisible();
  await expect(page.locator('#regex-search-input')).toHaveValue('draftBeacon');
  await page.evaluate(()=>document.querySelector('#regex-search-input').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'拼'})));
  await search(page,'visibleBeacon',2);
  expect(app.pageErrors).toEqual([]);
});

test('author CSS cannot hide or restyle the search toolbar controls', async ({ app }) => {
  const {page}=app;
  await page.evaluate(()=>{
    const style=document.createElement('style');
    style.textContent='button,input,select{display:none!important;visibility:hidden!important;opacity:0!important;font-size:0!important} button::before,button::after,#regex-search-container::before,#regex-search-container::after{content:"外部字样"!important;display:inline!important;font-size:50px!important;color:red!important} #regex-search-container{position:static!important;opacity:0!important;transform:scale(0)!important}';
    document.head.append(style);
  });
  await expect(page.locator('#regex-search-container')).toBeVisible();
  await expect(page.locator('#regex-search-input')).toBeVisible();
  await expect(page.locator('#regex-next-button')).toBeVisible();
  await openAdvanced(page);
  await expect(page.locator('#regex-search-scope')).toBeVisible();
  const styles=await page.evaluate(()=>Array.from(document.querySelectorAll('#regex-search-container button,#regex-search-container input,#regex-search-container select')).filter(element=>!element.closest('[hidden]')&&!element.closest('#regex-search-mode,.rr-menu-nav')&&element.id!=='regex-case-menu-toggle').map(element=>{
    const style=getComputedStyle(element),rect=element.getBoundingClientRect();
    return {id:element.id,display:style.display,visibility:style.visibility,opacity:style.opacity,fontSize:style.fontSize,width:rect.width,height:rect.height,before:getComputedStyle(element,'::before').content,after:getComputedStyle(element,'::after').content};
  }));
  expect(styles.every(style=>style.display!=='none'&&style.visibility==='visible'&&parseFloat(style.opacity)>0&&parseFloat(style.fontSize)>0&&style.width>0&&style.height>0)).toBe(true);
  expect(styles.every(style=>['none','normal'].includes(style.before)&&['none','normal'].includes(style.after))).toBe(true);
  expect(await page.locator('#regex-search-container').evaluate(element=>[getComputedStyle(element,'::before').content,getComputedStyle(element,'::after').content])).toEqual(['none','none']);
  await search(page,'shadowBeacon',1);
  await page.locator('#regex-close-button').click();
  await expect(page.locator('#regex-search-container')).toBeHidden();
  expect(app.pageErrors).toEqual([]);
});

test('whole-word alternations and overlapping candidates retain full visible matches and UTF-16 boundaries', async ({ app }) => {
  const {page}=app;
  await page.evaluate(()=>{
    const section=document.createElement('section');section.innerHTML='<p>cater</p><p>xa a a</p><p>🧪</p><p>foo\u200Dbar</p><p>foo\u200Cbar</p><p>foo\u200Bbar</p>';document.querySelector('main').prepend(section);
  });
  await clickSearchOption(page,'regex-word-toggle');
  await search(page,'cat|cater',1);
  expect((await highlightSnapshot(page)).filter(item=>!item.name.endsWith('-current')).flatMap(item=>item.texts)).toEqual(['cater']);
  await chooseMode(page,'literal');
  await search(page,'a a',1);
  expect((await highlightSnapshot(page)).filter(item=>!item.name.endsWith('-current')).flatMap(item=>item.texts)).toEqual(['a a']);
  const matchedRange=await page.evaluate(()=>{
    for(const [name,ranges] of CSS.highlights) if(name.startsWith('rr-find-')&&!name.endsWith('-current')) {
      const range=Array.from(ranges)[0];if(range) return {start:range.startOffset,end:range.endOffset,source:range.startContainer.data};
    }
  });
  expect(matchedRange).toEqual({start:3,end:6,source:'xa a a'});
  await clickSearchOption(page,'regex-case-toggle');
  for(const value of ['\uD83E','\uDDEA']) {
    await page.evaluate(query=>{
      const input=document.querySelector('#regex-search-input');input.value=query;input.dispatchEvent(new Event('input',{bubbles:true}));
    },value);
    await page.locator('#regex-search-input').press('Enter');
    await expectTotal(page,0);
  }
  await search(page,'🧪',1);
  await search(page,'bar',1); // Zero-width space separates words; joiners do not.
  await search(page,'foo\u200Dbar',1);
  await search(page,'foo\u200Cbar',1);
  expect(app.pageErrors).toEqual([]);
});

test('boxless inline layout and ruby base text remain searchable while nonpainted SVG text is excluded', async ({ app }) => {
  const {page}=app;
  await page.evaluate(()=>{
    const section=document.createElement('section');
    section.innerHTML=`
      <p><span style="display:contents;opacity:0">contentsOpacityBeacon</span></p>
      <p>contentsStart<span style="display:contents;position:absolute">Middle</span>EndBeacon</p>
      <p><span style="display:contents;overflow:hidden">contentsClipBeacon</span></p>
      <p><span style="display:contents;content-visibility:hidden">contentsCvBeacon</span></p>
      <p><span style="content-visibility:hidden">inlineCvBeacon</span></p>
      <p style="content-visibility:hidden">blockCvBeacon</p>
      <ruby>rubyFirst<rt>annotationA</rt>SecondBeacon<rt>annotationB</rt></ruby>
      <svg width="400" height="60"><text y="25">svgFirst<g>svgGhost</g>LastBeacon</text></svg>`;
    document.querySelector('main').prepend(section);
  });
  for(const query of ['contentsOpacityBeacon','contentsStartMiddleEndBeacon','contentsClipBeacon','contentsCvBeacon','inlineCvBeacon','rubyFirstSecondBeacon','svgFirstLastBeacon']) await search(page,query,1);
  await search(page,'blockCvBeacon|svgFirstsvgGhostLastBeacon',0);
  await search(page,'rubyFirstSecondBeacon',1);
  const ranges=(await highlightSnapshot(page)).filter(item=>!item.name.endsWith('-current')).flatMap(item=>item.texts);
  expect(ranges.join('')).toBe('rubyFirstSecondBeacon');
  expect(ranges.join('')).not.toContain('annotation');
  expect(app.pageErrors).toEqual([]);
});

test('frame visibility excludes zero-sized and fully clipped viewports without inheriting frame typography', async ({ app }) => {
  const {page}=app;
  await page.evaluate(()=>{
    const section=document.createElement('section');
    section.innerHTML=`
      <iframe id="review-zero-frame" style="width:0;height:0;border:0" srcdoc="<p>zeroFrameBeacon</p>"></iframe>
      <div style="width:0;height:0;overflow:hidden"><iframe id="review-clipped-frame" srcdoc="<p>clippedFrameBeacon</p>"></iframe></div>
      <iframe id="review-typography-frame" style="font-size:0;color:transparent" srcdoc="<p>fontFrameBeacon</p>"></iframe>`;
    document.querySelector('main').prepend(section);
  });
  await page.waitForFunction(()=>['review-zero-frame','review-clipped-frame','review-typography-frame'].every(id=>document.getElementById(id).contentDocument?.querySelector('p')));
  await search(page,'zeroFrameBeacon|clippedFrameBeacon',0);
  await search(page,'fontFrameBeacon',1);
  expect(app.pageErrors).toEqual([]);
});

test('fully transparent filters, empty clips and transparent text shadows do not become visible results', async ({ app }) => {
  const {page}=app;
  await page.evaluate(()=>{
    const section=document.createElement('section');
    section.innerHTML=`
      <p style="filter:opacity(0)">filterZeroBeacon</p>
      <p style="clip-path:inset(100%)">clipZeroBeacon</p>
      <p style="color:transparent;text-shadow:0 0 1px transparent">shadowZeroBeacon</p>
      <p style="filter:opacity(0.5)">filterVisibleBeacon</p>
      <p style="color:transparent;text-shadow:0 0 1px black">shadowVisibleBeacon</p>`;
    document.querySelector('main').prepend(section);
  });
  await search(page,'filterZeroBeacon|clipZeroBeacon|shadowZeroBeacon',0);
  await search(page,'filterVisibleBeacon|shadowVisibleBeacon',2);
  expect(app.pageErrors).toEqual([]);
});

test('toolbar controls remain inside a narrow viewport at the largest supported scale', async ({ app }) => {
  const {page}=app;
  await app.worker.evaluate(async()=>{await chrome.storage.sync.set({scale:2.5});});
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('#regex-search-container')).zoom==='2.5');
  for(const viewport of [{width:480,height:640},{width:360,height:320}]) {
    await page.setViewportSize(viewport);
    const geometry=await page.evaluate(()=>{
      const rect=document.querySelector('#regex-search-container').getBoundingClientRect();
      return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,viewportWidth:innerWidth,viewportHeight:innerHeight};
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
  }
  await page.locator('#regex-search-input').scrollIntoViewIfNeeded();
  await expect(page.locator('#regex-search-input')).toBeInViewport();
  await page.locator('#regex-close-button').scrollIntoViewIfNeeded();
  await expect(page.locator('#regex-close-button')).toBeInViewport();
  await search(page,'shadowBeacon',1);
  await openAdvanced(page);
  await chooseMode(page,'literal');
  await expect(page.locator('#regex-mode-toggle')).toHaveAttribute('aria-pressed','false');
  await clickSearchOption(page,'regex-case-toggle');
  await expect(page.locator('#regex-case-menu-toggle')).toHaveAttribute('aria-pressed','true');
  await search(page,'visibleBeacon',2);
  await openAdvanced(page);
  await expect(page.locator('#regex-menu-prev-button')).toBeEnabled();
  await expect(page.locator('#regex-menu-next-button')).toBeEnabled();
  await page.locator('#regex-menu-next-button').click();
  await expect(page.locator('#regex-search-count')).toHaveText('2/2');
  await openAdvanced(page);
  await page.locator('#regex-menu-prev-button').click();
  await expect(page.locator('#regex-search-count')).toHaveText('1/2');
  await page.locator('#regex-close-button').click();
  await expect(page.locator('#regex-search-container')).toBeHidden();
  expect(app.pageErrors).toEqual([]);
});

test('options preserve alpha colors, reject invalid values and restore defaults only after saving', async ({ app }) => {
  const {page,worker}=app;
  await search(page,'visibleBeacon',2);
  const options=await page.context().newPage(),errors=[];
  options.on('pageerror',error=>errors.push(error.message));
  try {
    await options.goto(new URL('options.html',worker.url()).href);
    await expect(options.locator('#save')).toBeEnabled();
    const before=await worker.evaluate(async()=>chrome.storage.sync.get(['highlightColor','currentColor']));
    await options.locator('#highlightColor').fill('red;}body{display:none}');
    await expect(options.locator('#highlightColor')).toHaveJSProperty('validationMessage','请输入有效的十六进制、rgb() 或 rgba() 颜色。');
    await options.locator('#save').click();
    expect(await worker.evaluate(async()=>chrome.storage.sync.get(['highlightColor','currentColor']))).toEqual(before);
    await options.locator('#highlightColor').fill('rgba(12,34,56,0.5)');
    await options.locator('#currentColor').fill('#13579b80');
    expect(await options.locator('#colorPreview').evaluate(element=>getComputedStyle(element).backgroundColor)).toBe('rgba(12, 34, 56, 0.5)');
    await options.locator('#save').click();
    await expect(options.locator('#status')).toHaveText('设置已保存。');
    expect(await worker.evaluate(async()=>chrome.storage.sync.get(['highlightColor','currentColor']))).toEqual({highlightColor:'rgba(12,34,56,0.5)',currentColor:'#13579b80'});
    await expect.poll(()=>page.evaluate(()=>{
      const name=Array.from(CSS.highlights.keys()).find(key=>key.startsWith('rr-find-')&&!key.endsWith('-current'));
      return name?getComputedStyle(document.querySelector('#visible'),`::highlight(${name})`).backgroundColor:null;
    })).toBe('rgba(12, 34, 56, 0.5)');
    await options.reload();
    await expect(options.locator('#save')).toBeEnabled();
    await expect(options.locator('#highlightColor')).toHaveValue('rgba(12,34,56,0.5)');
    await expect(options.locator('#currentColor')).toHaveValue('#13579b80');
    await options.locator('#reset').click();
    await expect(options.locator('#uiLanguage')).toHaveValue('auto');
    await expect(options.locator('#highlightColor')).toHaveValue('#ffe082');
    await expect(options.locator('#currentColor')).toHaveValue('#ff6d00');
    expect(await worker.evaluate(async()=>chrome.storage.sync.get(['highlightColor','currentColor']))).toEqual({highlightColor:'rgba(12,34,56,0.5)',currentColor:'#13579b80'});
    await options.locator('#save').click();
    await expect(options.locator('#status')).toHaveText('Settings saved.');
    expect(await worker.evaluate(async()=>chrome.storage.sync.get(['highlightColor','currentColor']))).toEqual({highlightColor:'#ffe082',currentColor:'#ff6d00'});
  } finally {await options.close();}
  expect(errors).toEqual([]);
  expect(app.pageErrors).toEqual([]);
});

test('auto search responds independently to media, hover, URL state, password placeholders and long eventless values', async ({ app }) => {
  const {page}=app;
  await page.emulateMedia({colorScheme:'light'});
  await page.evaluate(()=>{
    const style=document.createElement('style');style.textContent='@media(prefers-color-scheme:dark){#media-state{display:none}} #hover-state{display:none} #hover-trigger:hover #hover-state{display:block} #hash-state{display:none} #hash-state:target{display:block}';document.head.append(style);
    const section=document.createElement('section');section.innerHTML='<p id="media-state">mediaStateBeacon</p><div id="hover-trigger" style="width:200px;height:80px;background:#ddd"><p id="hover-state">hoverStateBeacon</p></div><p id="hash-state">targetStateBeacon</p><input id="password-state" type="password" placeholder="passwordDynamicBeacon"><input id="long-control">';document.querySelector('main').prepend(section);
    document.querySelector('#long-control').value='z'.repeat(150000)+'longMatchBeacon';
  });
  await search(page,'mediaStateBeacon',1);
  await clickSearchOption(page,'regex-auto-toggle');
  await page.emulateMedia({colorScheme:'dark'});
  await expectTotal(page,0);
  await page.emulateMedia({colorScheme:'light'});
  await expectTotal(page,1);
  await search(page,'hoverStateBeacon',0);
  await page.locator('#hover-trigger').hover();
  await expectTotal(page,1);
  await page.mouse.move(0,0);
  await expectTotal(page,0);
  await search(page,'targetStateBeacon',0);
  await page.evaluate(()=>{location.hash='hash-state';});
  await expectTotal(page,1);
  await page.evaluate(()=>{location.hash='';});
  await expectTotal(page,0);
  await search(page,'passwordDynamicBeacon',1);
  await page.evaluate(()=>{document.querySelector('#password-state').value='privateNeverSearchBeacon';});
  await expectTotal(page,0);
  await page.evaluate(()=>{document.querySelector('#password-state').value='';});
  await expectTotal(page,1);
  await search(page,'privateNeverSearchBeacon',0);
  await search(page,'longMatchBeacon',1);
  await page.evaluate(()=>{document.querySelector('#long-control').value='z'.repeat(150000)+'longOtherBeacon';});
  await expectTotal(page,0);
  await search(page,'longOtherBeacon',1);
  expect(app.pageErrors).toEqual([]);
});

test('modern whitespace collapse modes preserve painted spaces and newlines independently of wrapping', async ({ app }) => {
  const {page}=app;
  await page.evaluate(()=>{
    const section=document.createElement('section');
    const breaks=document.createElement('p');breaks.style.cssText='white-space-collapse:preserve-breaks;text-wrap-mode:nowrap';breaks.textContent='whiteFirst\nwhiteSecond';
    const preserved=document.createElement('p');preserved.style.cssText='white-space-collapse:break-spaces;text-wrap-mode:nowrap';preserved.textContent='double  Beacon\n tail';
    const preline=document.createElement('p');preline.style.whiteSpace='pre-line';preline.textContent='carriageA\rcarriageB\r\ncarriageC';
    section.append(breaks,preserved,preline);document.querySelector('main').prepend(section);
  });
  await search(page,'^whiteFirst\\nwhiteSecond$',1);
  await search(page,'whiteFirst whiteSecond',0);
  await search(page,'^double  Beacon\\n tail$',1);
  await search(page,'^double Beacon tail$',0);
  await search(page,'^carriageA carriageB\\ncarriageC$',1);
  expect(app.pageErrors).toEqual([]);
});

test('small selection budgets search six characters inside two-megabyte text and textarea sources', async ({ app }) => {
  const {page}=app,offset=1024*1024;
  await app.worker.evaluate(async()=>{await chrome.storage.sync.set({maxScannedChars:1024,characterBudgetVersion:1});});
  for(const kind of ['text','textarea']) {
    await page.locator('#regex-close-button').click();
    await page.evaluate(({type,start})=>{
      const main=document.querySelector('main');main.replaceChildren();
      const value='x'.repeat(start)+'needle'+'y'.repeat(start);
      if(type==='textarea') {
        const textarea=document.createElement('textarea');textarea.id='large-selection-source';textarea.value=value;main.append(textarea);textarea.focus();textarea.setSelectionRange(start,start+6);
      } else {
        const p=document.createElement('p');p.id='large-selection-source';p.textContent=value;main.append(p);
        const range=document.createRange();range.setStart(p.firstChild,start);range.setEnd(p.firstChild,start+6);
        const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
      }
    },{type:kind,start:offset});
    await app.toggle();
    await chooseScope(page,'selection');
    await search(page,'^needle$',1);
    await expect(page.locator('#regex-search-count')).toHaveAttribute('title',/已扫描 6 个字符/);
    if(kind==='text') {
      const range=await page.evaluate(()=>{
        const name=Array.from(CSS.highlights.keys()).find(key=>key.startsWith('rr-find-')&&!key.endsWith('-current'));
        const match=Array.from(CSS.highlights.get(name))[0];return {text:match.toString(),start:match.startOffset,end:match.endOffset};
      });
      expect(range).toEqual({text:'needle',start:offset,end:offset+6});
    } else {
      expect(await page.evaluate(()=>document.querySelector('#large-selection-source').value.length)).toBe(2*offset+6);
    }
  }
  expect(app.pageErrors).toEqual([]);
});

// These exercises run the injected extension, including its real offscreen
// transport. Screenshots are review artifacts; behavioral checks remain useful
// across platforms with different font rendering.
test('Chinese toolbar groups are explicit, keyboard operable and collapsed options leave the tab order', async ({ app }) => {
  const {page}=app;
  const toolbar=page.locator('#regex-search-container'),input=page.locator('#regex-search-input');
  await expect(toolbar).toHaveAccessibleName(/查找|搜索/);
  await expect(input).toHaveAccessibleName(/查找|搜索/);
  await expect(page.locator('#regex-search-scope')).toHaveRole('button');
  await expect(page.locator('#regex-search-scope')).toHaveJSProperty('value', 'page');
  await expect(page.locator('#regex-search-scope')).toHaveAccessibleName('搜索范围：全局；点击切换至选区');
  await expect(page.locator('#regex-search-scope svg')).toBeVisible();
  await expect(page.locator('#regex-mode-regex')).toHaveAttribute('role','radio');
  await expect(page.locator('#regex-mode-literal')).toHaveText('文本');
  await expect(page.locator('#regex-mode-regex')).toHaveText('正则');
  await expect(page.locator('#regex-mode-toggle')).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('#regex-mode-toggle')).toBeVisible();
  await expect(page.locator('#regex-advanced-toggle')).toHaveAttribute('aria-expanded','false');
  await expect(page.locator('#regex-advanced-panel')).toBeHidden();
  await expect(page.locator('#regex-case-toggle')).toBeVisible();
  await expect(page.locator('#regex-auto-toggle')).toBeHidden();
  await input.focus();
  const reached=[];
  for(let index=0;index<12;index++) {
    await page.keyboard.press('Tab');
    const focus=await page.evaluate(()=>({id:document.activeElement?.id,inToolbar:!!document.activeElement?.closest('#regex-search-container')}));
    reached.push(focus.id);if(!focus.inToolbar)break;
  }
  expect(reached.filter(id => ['regex-mode-literal','regex-mode-regex','regex-word-toggle','regex-multiline-toggle','regex-dotall-toggle','regex-auto-toggle','regex-settings-button'].includes(id))).toEqual([]);
  await openAdvanced(page);
  await expect(page.locator('#regex-advanced-panel')).toHaveAttribute('role','dialog');
  await expect(page.locator('#regex-search-mode')).toBeHidden();
  await expect(page.locator('#regex-case-menu-toggle')).toBeHidden();
  await page.locator('#regex-advanced-toggle').click();
  await page.locator('#regex-advanced-toggle').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#regex-word-toggle')).toBeFocused();
  await page.setViewportSize({width:320,height:844});
  await expect(page.locator('#regex-mode-toggle')).toBeHidden();
  await expect(page.locator('#regex-search-mode')).toBeVisible();
  await expect(page.locator('#regex-case-menu-toggle')).toBeVisible();
  await page.locator('#regex-advanced-toggle').click();
  await page.locator('#regex-advanced-toggle').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#regex-mode-regex')).toBeFocused();
  await page.locator('#regex-mode-literal').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#regex-mode-regex')).toBeFocused();
  await expect(page.locator('#regex-mode-regex')).toHaveAttribute('aria-checked','true');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#regex-mode-literal')).toBeFocused();
  await expect(page.locator('#regex-mode-literal')).toHaveAttribute('aria-checked','true');
  await expect(page.locator('#regex-mode-toggle')).toHaveAttribute('aria-pressed','false');
  await page.locator('#regex-search-scope').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#regex-search-scope')).toBeFocused();
  await expect(page.locator('#regex-search-scope')).toHaveJSProperty('value', 'selection');
  await expect(page.locator('#regex-advanced-panel')).toBeHidden();
  await page.keyboard.press('Space');
  await expect(page.locator('#regex-search-scope')).toBeFocused();
  await expect(page.locator('#regex-search-scope')).toHaveJSProperty('value', 'page');
  await search(page,'literal[a]+',1);
  await openAdvanced(page);
  await expect(page.locator('#regex-multiline-toggle')).toBeDisabled();
  await expect(page.locator('#regex-dotall-toggle')).toBeDisabled();
  await chooseMode(page,'regex');
  await expect(page.locator('#regex-multiline-toggle')).toBeEnabled();
  await expect(page.locator('#regex-dotall-toggle')).toBeEnabled();
  await expect(page.locator('#regex-mode-toggle')).toHaveAttribute('aria-pressed','true');
  await page.locator('#regex-case-menu-toggle').click();
  await expect(page.locator('#regex-case-menu-toggle')).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('#regex-case-toggle')).toHaveAttribute('aria-pressed','true');
  await page.locator('#regex-advanced-toggle').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#regex-advanced-panel')).toBeHidden();
  await expect(page.locator('#regex-advanced-toggle')).toBeFocused();
  const focusStyle=await page.locator('#regex-advanced-toggle').evaluate(element=>({outline:getComputedStyle(element).outlineStyle,shadow:getComputedStyle(element).boxShadow}));
  expect(focusStyle.outline!=='none'||focusStyle.shadow!=='none').toBe(true);
  await openAdvanced(page);
  await page.locator('#regex-mode-regex').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('#regex-advanced-panel')).toBeHidden();
  await expect(page.locator('#regex-advanced-toggle')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(input).toHaveValue('');
  await expect(toolbar).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(toolbar).toBeHidden();
  expect(app.pageErrors).toEqual([]);
});

test('empty, missing, invalid and selection states give a visible explanation without putting errors in the count', async ({ app }) => {
  const {page}=app, input=page.locator('#regex-search-input'),status=page.locator('#regex-search-status');
  await expect(page.locator('.rr-feedback')).toBeHidden();
  await expect(status).toHaveAttribute('role','status');
  await expect(status).toHaveAttribute('aria-live','polite');
  await expect(status).not.toHaveText('');
  await expect(page.locator('#regex-prev-button')).toBeDisabled();
  await expect(page.locator('#regex-next-button')).toBeDisabled();
  await search(page,'notPresentAnywhereBeacon',0);
  await expect(status).toContainText(/没有|未找到/);
  await search(page,'[');
  await expect(status).toHaveText('正则有误');
  await expect(page.locator('.rr-feedback')).toBeVisible();
  await expect(page.locator('.rr-feedback')).toHaveAttribute('title',/括号|转义/);
  await expect(input).toHaveAttribute('aria-invalid','true');
  await expect(page.locator('#regex-search-count')).toHaveText('');
  await search(page,'visibleBeacon',2);
  await expect(input).not.toHaveAttribute('aria-invalid','true');
  await chooseScope(page,'selection');
  await expect(status).toHaveText('先选文字');
  await expect(page.locator('#regex-search-count')).toHaveText('');
  await chooseScope(page,'page');
  await expectTotal(page,2);
  await input.focus();
  await input.press('Escape');
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await expect(status).not.toHaveText('');
  await expect(page.locator('#regex-search-count')).toHaveText('');
  expect(await highlightSnapshot(page)).toEqual([]);
  await search(page,'visibleBeacon',2);
  await input.press('Escape');
  await expect(input).toHaveValue('');
  await expect(page.locator('#regex-search-container')).toBeVisible();
  await input.press('Escape');
  await expect(page.locator('#regex-search-container')).toBeHidden();
  await app.toggle();
  await expect(page.locator('#regex-search-container')).toHaveAttribute('aria-busy','false');
  await isolated(app,'(() => {window.__rrEscOriginalSearch=RRWorkerManager.searchStream;window.__rrEscMatchingComplete=false;window.__rrEscLateComplete=false;const gate=new Promise(resolve=>{window.__rrEscReleaseSearch=resolve;});RRWorkerManager.searchStream=async function(...args){const result=await window.__rrEscOriginalSearch.apply(this,args);window.__rrEscMatchingComplete=true;await gate;window.__rrEscLateComplete=true;return result;};return true;})');
  try {
    await input.fill('visibleBeacon');
    await expect.poll(()=>isolated(app,'(() => window.__rrEscMatchingComplete)')).toBe(true);
    await expect(page.locator('#regex-search-container')).toHaveAttribute('aria-busy','true');
    await input.press('Escape');
    await input.press('Escape');
    await expect(page.locator('#regex-search-container')).toBeHidden();
    await app.toggle();
    await expect(input).toHaveValue('');
    await expect(page.locator('#regex-search-container')).toHaveAttribute('aria-busy','false');
    await isolated(app,'(() => {window.__rrEscReleaseSearch();return true;})');
    await expect.poll(()=>isolated(app,'(() => window.__rrEscLateComplete)')).toBe(true);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
    await expect(page.locator('#regex-search-container')).toHaveAttribute('aria-busy','false');
  } finally {
    await isolated(app,'(() => {window.__rrEscReleaseSearch();RRWorkerManager.searchStream=window.__rrEscOriginalSearch;delete window.__rrEscOriginalSearch;delete window.__rrEscReleaseSearch;return true;})');
  }
  expect(app.pageErrors).toEqual([]);
});

async function designDocument(page) {
  await page.evaluate(()=>{
    const style=document.createElement('style');
    style.textContent=`body{margin:0;background:#f5f6fa;color:#232a38;font-family:system-ui,"Noto Sans CJK SC",sans-serif;line-height:1.8}main{max-width:760px;margin:80px auto;padding:0 40px}h1{font-size:36px;letter-spacing:-1px;margin:12px 0}h2{font-size:20px;margin-top:36px}p{color:#596477}small{font-size:12px;letter-spacing:2px;color:#68758b}article{padding:40px;background:white;border:1px solid #e5e8ef;border-radius:20px}code{background:#f0f1f7;border-radius:5px;padding:3px 6px}@media(prefers-color-scheme:dark){body{background:#11131a;color:#edf0f6}article{background:#191d27;border-color:#2a3040}p{color:#a4afc2}small{color:#92a1ba}code{background:#2a3040}}@media(max-width:600px){main{margin:48px auto;padding:0 16px}article{padding:24px}h1{font-size:28px}}`;
    document.head.append(style);
    document.querySelector('main').innerHTML='<article><small>REGEX RABBIT · 使用说明</small><h1>在网页中快速找到内容</h1><p>输入文字即可查找。需要处理不同格式时，可以使用正则表达式；选择范围后，只查询选中的部分。</p><h2>动态搜索</h2><p>动态搜索会在网页内容更新后重新查找，保留当前结果的位置。开启前先完成一次普通查询。</p><h2>表达式示例</h2><p><code>\\b\\d{4}\\b</code> 查找四位数字。遇到没有匹配结果的查询，搜索栏会显示具体状态。</p><h2>保持阅读位置</h2><p>动态搜索更新结果时不会反复跳转。使用上下箭头可以逐个查看结果，按 Escape 清空查询。</p></article>';
    scrollTo(0,0);
  });
}

async function saveUIShot(page, name, locator) {
  const path=fileURLToPath(new URL(`../../.tmp/${name}.png`,import.meta.url));
  if(!locator) {await page.screenshot({path});return;}
  // The compact toolbar keeps its menu and feedback out of the main line's
  // layout. Include visible floating content without inflating the toolbar.
  const clip=await locator.evaluate(root=>{
    const nodes=[root,...root.querySelectorAll('#regex-advanced-panel,.rr-feedback')];
    const rects=nodes.filter(node=>!node.closest('[hidden]')&&getComputedStyle(node).visibility==='visible')
      .map(node=>node.getBoundingClientRect()).filter(rect=>rect.width>1&&rect.height>1);
    const left=Math.max(0,Math.min(...rects.map(rect=>rect.left))),top=Math.max(0,Math.min(...rects.map(rect=>rect.top)));
    const right=Math.min(innerWidth,Math.max(...rects.map(rect=>rect.right))),bottom=Math.min(innerHeight,Math.max(...rects.map(rect=>rect.bottom)));
    return {x:left,y:top,width:right-left,height:bottom-top};
  });
  await page.screenshot({path,clip});
}

test('records actual redesigned toolbar in light, dark, advanced, error and narrow layouts', async ({ app }) => {
  const {page}=app;
  await page.setViewportSize({width:1280,height:900});
  await designDocument(page);
  await page.locator('#regex-search-input').fill('');
  await page.locator('#regex-search-input').press('Enter');
  await expect(page.locator('#regex-search-status')).not.toHaveText('');
  await saveUIShot(page,'ui-search-empty',page.locator('#regex-search-container'));
  await search(page,'动态搜索',3);
  await page.evaluate(()=>scrollTo(0,0));
  const toolbar=page.locator('#regex-search-container');
  await saveUIShot(page,'ui-search-light',toolbar);
  await saveUIShot(page,'ui-search-context-light');
  await openAdvanced(page);
  await saveUIShot(page,'ui-search-advanced',toolbar);
  await search(page,'[');
  await expect(page.locator('#regex-search-status')).toHaveText('正则有误');
  await saveUIShot(page,'ui-search-error',toolbar);
  await search(page,'动态搜索',3);
  await chooseScope(page,'selection');
  await expect(page.locator('#regex-search-status')).toHaveText('先选文字');
  await expect(page.locator('#regex-search-scope')).toHaveAttribute('aria-invalid','true');
  await expect(page.locator('#regex-search-input')).toHaveAttribute('aria-invalid','false');
  await saveUIShot(page,'ui-search-selection',toolbar);
  await chooseScope(page,'page');
  await expectTotal(page,3);
  await page.locator('#regex-advanced-toggle').click();
  await page.emulateMedia({colorScheme:'dark'});
  await saveUIShot(page,'ui-search-dark',toolbar);
  await saveUIShot(page,'ui-search-context-dark');
  await page.emulateMedia({colorScheme:'light'});
  await page.setViewportSize({width:390,height:844});
  const geometry=await toolbar.boundingBox();
  expect(geometry.x).toBeGreaterThanOrEqual(0);
  expect(geometry.x+geometry.width).toBeLessThanOrEqual(390);
  const narrowLayout=await page.evaluate(()=>{
    const close=document.querySelector('#regex-close-button'),nav=document.querySelector('#regex-next-button');
    const input=document.querySelector('#regex-search-input'),toolbar=document.querySelector('#regex-search-container');
    const closeRect=close.getBoundingClientRect(),navRect=nav.getBoundingClientRect(),inputRect=input.getBoundingClientRect();
    return {closeSharesRow:Math.abs(closeRect.top-navRect.top)<8,
      inputSharesRow:Math.abs(inputRect.top-closeRect.top)<8,
      toolbarHeight:toolbar.getBoundingClientRect().height,
      hasBrandHeader:!!toolbar.querySelector('.rr-header,.rr-brand'),hasClearButton:!!toolbar.querySelector('#regex-clear-button')};
  });
  expect(narrowLayout.closeSharesRow).toBe(true);
  expect(narrowLayout.inputSharesRow).toBe(true);
  expect(narrowLayout.toolbarHeight).toBeLessThanOrEqual(56);
  expect(narrowLayout.hasBrandHeader).toBe(false);
  expect(narrowLayout.hasClearButton).toBe(false);
  await saveUIShot(page,'ui-search-narrow',toolbar);
  await page.locator('#regex-next-button').click();
  await expect(page.locator('#regex-search-count')).toHaveText('2/3');
  await expect(page.locator('#regex-next-button')).toBeInViewport();
  await expect(page.locator('#regex-close-button')).toBeInViewport();
  expect(app.pageErrors).toEqual([]);
});

test('redesigned settings use native accessible choices, preserve saved data and fit light, dark and narrow screens', async ({ extension }) => {
  const {context,worker}=extension;
  await worker.evaluate(async()=>{await chrome.storage.sync.clear();await chrome.storage.sync.set({autoSearchDebounce:500,workerTimeoutMs:10000,uiLanguage:'zh-CN'});});
  const options=await context.newPage(),errors=[];
  options.on('pageerror',error=>errors.push(error.message));
  try {
    await options.setViewportSize({width:1280,height:1000});
    await options.goto(new URL('options.html',worker.url()).href);
    await expect(options.locator('#save')).toBeEnabled();
    await expect(options.locator('html')).toHaveAttribute('lang','zh-CN');
    await expect(options.getByRole('heading',{name:/设置/,level:1})).toBeVisible();
    expect((await options.locator('.page').boundingBox()).height).toBeLessThanOrEqual(650);
    await expect(options.locator('#advancedSettings')).not.toHaveAttribute('open','');
    await expect(options.locator('#workerTimeoutMs')).toBeHidden();
    const literal=options.locator('input[name=searchMode][value=literal]'),regex=options.locator('input[name=searchMode][value=regex]');
    await expect(regex).toBeChecked();
    await literal.check();
    await expect(literal).toBeChecked();
    await expect(options.locator('#mode')).toHaveValue('literal');
    await expect(options.locator('#multiline')).toBeDisabled();
    await literal.focus();
    await options.keyboard.press('ArrowRight');
    await expect(regex).toBeFocused();
    await expect(regex).toBeChecked();
    await expect(options.locator('#mode')).toHaveValue('regex');
    await expect(options.locator('#multiline')).toBeEnabled();
    const focusStyle=await regex.evaluate(element=>getComputedStyle(element).outlineStyle);
    expect(focusStyle).not.toBe('none');
    await options.locator('#caseSensitive').check();
    await options.locator('button[data-scale="1.25"]').click();
    await expect(options.locator('#scale')).toHaveValue('1.25');
    await expect(options.locator('#scaleVal')).toHaveText('125%');
    await expect(options.locator('#status')).toHaveText('有未保存的修改。');
    await options.locator('#save').click();
    await expect(options.locator('#status')).toHaveText('设置已保存。');
    expect(await worker.evaluate(async()=>chrome.storage.sync.get(['caseSensitive','scale','mode']))).toEqual({caseSensitive:true,scale:1.25,mode:'regex'});
    await options.reload();
    await expect(options.locator('#save')).toBeEnabled();
    await expect(options.locator('#caseSensitive')).toBeChecked();
    await expect(options.locator('#scaleVal')).toHaveText('125%');
    await options.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));
    await options.screenshot({path:fileURLToPath(new URL('../../.tmp/ui-options-light.png',import.meta.url)),fullPage:true});
    await options.locator('#advancedSettings summary').click();
    await expect(options.locator('#workerTimeoutMs')).toBeVisible();
    await options.locator('button[data-budget="light"]').click();
    await expect(options.locator('button[data-budget="light"]')).toHaveAttribute('aria-pressed','true');
    await options.locator('#workerTimeoutMs').fill('7000');
    await expect(options.locator('button[data-budget="light"]')).toHaveAttribute('aria-pressed','false');
    await options.locator('#save').click();
    await expect(options.locator('#status')).toHaveText('设置已保存。');
    expect(await worker.evaluate(async()=>chrome.storage.sync.get(['workerTimeoutMs']))).toEqual({workerTimeoutMs:7000});
    await options.locator('#advancedSettings').screenshot({path:fileURLToPath(new URL('../../.tmp/ui-options-advanced.png',import.meta.url))});
    await options.locator('#advancedSettings summary').click();
    await options.emulateMedia({colorScheme:'dark'});
    await options.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));
    await options.screenshot({path:fileURLToPath(new URL('../../.tmp/ui-options-dark.png',import.meta.url)),fullPage:true});
    await options.emulateMedia({colorScheme:'light'});
    await options.setViewportSize({width:390,height:844});
    const overflow=await options.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth}));
    expect(overflow.width).toBeLessThanOrEqual(overflow.viewport);
    await options.locator('#save').scrollIntoViewIfNeeded();
    await expect(options.locator('#save')).toBeInViewport();
    await options.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));
    await options.screenshot({path:fileURLToPath(new URL('../../.tmp/ui-options-narrow.png',import.meta.url)),fullPage:true});
    await options.setViewportSize({width:320,height:568});
    expect(await options.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await literal.focus();
    const focusChecks=[];
    for(let index=0;index<20;index++) {
      await options.keyboard.press('Tab');
      const check=await options.evaluate(()=>{
        const node=document.activeElement;if(!node?.closest('#settings'))return null;
        const rect=node.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2;
        const hit=document.elementFromPoint(x,y),label=node.closest('label');
        return {id:node.id||node.name||node.tagName,inViewport:x>=0&&x<=innerWidth&&y>=0&&y<=innerHeight,
          unobstructed:!!hit&&(hit===node||node.contains(hit)||hit.contains(node)||!!label?.contains(hit))};
      });
      if(!check)break;focusChecks.push(check);
    }
    expect(focusChecks.length).toBeGreaterThan(10);
    expect(focusChecks.every(check=>check.inViewport&&check.unobstructed)).toBe(true);
  } finally {await options.close();}
  expect(errors).toEqual([]);
});

test('settings recover from a failed storage read without overwriting local edits', async ({ extension }) => {
  const {context,worker}=extension;
  await worker.evaluate(async()=>{await chrome.storage.sync.clear();await chrome.storage.sync.set({highlightColor:'#13579b',currentColor:'#ffeedd',scale:1.25,uiLanguage:'zh-CN'});});
  const options=await context.newPage(),errors=[];
  options.on('pageerror',error=>errors.push(error.message));
  await options.addInitScript(()=>{
    const original=chrome.storage.sync.get.bind(chrome.storage.sync);let failed=false;
    chrome.storage.sync.get=function(...args){if(!failed){failed=true;throw new Error('Fixture read unavailable');}return original(...args);};
  });
  try {
    await options.goto(new URL('options.html',worker.url()).href);
    await expect(options.locator('#status')).toContainText('Fixture read unavailable');
    await expect(options.locator('#save')).toBeDisabled();
    await expect(options.locator('#retryLoad')).toBeVisible();
    await options.locator('#highlightColor').fill('rgba(12,34,56,0.5)');
    await expect(options.locator('#save')).toBeDisabled();
    await options.locator('#retryLoad').click();
    await expect(options.locator('#save')).toBeEnabled();
    await expect(options.locator('#retryLoad')).toBeHidden();
    await expect(options.locator('#highlightColor')).toHaveValue('rgba(12,34,56,0.5)');
    await expect(options.locator('#currentColor')).toHaveValue('#ffeedd');
    await expect(options.locator('#scale')).toHaveValue('1.25');
    await expect(options.locator('#status')).toHaveText('有未保存的修改。');
    await options.locator('#save').click();
    await expect(options.locator('#status')).toHaveText('设置已保存。');
    expect(await worker.evaluate(async()=>chrome.storage.sync.get(['highlightColor','currentColor','scale']))).toEqual({highlightColor:'rgba(12,34,56,0.5)',currentColor:'#ffeedd',scale:1.25});
  } finally {await options.close();}
  expect(errors).toEqual([]);
});

test('the toolbar settings action opens the actual options page and preserves the current query', async ({ app }) => {
  const {page,worker}=app;
  await search(page,'visibleBeacon',2);
  const address=new URL('options.html',worker.url()).href;
  await openAdvanced(page);
  await page.locator('#regex-settings-button').click();
  await expect.poll(()=>page.context().pages().filter(item=>item.url()===address).length).toBe(1);
  const options=page.context().pages().find(item=>item.url()===address);
  try {
    await expect(options.getByRole('heading',{name:/设置/,level:1})).toBeVisible();
    await expect(options.locator('#save')).toBeEnabled();
    await expect(page.locator('#regex-search-input')).toHaveValue('visibleBeacon');
    await expectTotal(page,2);
  } finally {await options.close();}
  expect(app.pageErrors).toEqual([]);
});

async function navigationDocument(page,{smooth=false}={}) {
  await page.evaluate(useSmooth=>{
    const style=document.createElement('style');
    style.textContent=`html{scroll-behavior:${useSmooth?'smooth':'auto'}}body{margin:0;overflow-anchor:none}main{margin:0;padding:0}main p{font:18px/28px sans-serif;margin:0;padding-left:32px}`;
    document.head.append(style);
    document.querySelector('main').innerHTML='<div style="height:80px"></div><p id="navigation-first">steadyBeacon</p><div style="height:1720px"></div><p id="navigation-middle">steadyBeacon</p><div style="height:1720px"></div><p id="navigation-last">steadyBeacon</p><div style="height:1400px"></div>';
    scrollTo({top:1200,behavior:'instant'});
  },smooth);
  await expect.poll(()=>page.evaluate(()=>scrollY)).toBe(1200);
}

async function currentRangeGeometry(page) {
  return page.evaluate(()=>{
    const current=Array.from(CSS.highlights.entries()).find(([name])=>name.startsWith('rr-find-')&&name.endsWith('-current'));
    const range=current&&Array.from(current[1])[0];if(!range)return null;
    const rect=range.getBoundingClientRect(),toolbar=document.querySelector('#regex-search-container').getBoundingClientRect();
    const x=(rect.left+rect.right)/2,y=(rect.top+rect.bottom)/2;
    return {text:range.toString(),top:rect.top,bottom:rect.bottom,centerX:x,centerY:y,
      inViewport:x>=0&&x<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight,
      underToolbar:x>=toolbar.left&&x<=toolbar.right&&y>=toolbar.top&&y<=toolbar.bottom};
  });
}

test('typing, query options, configuration and automatic updates preserve the reading viewport until explicit locate', async ({ app }) => {
  const {page,worker}=app;
  await page.setViewportSize({width:1280,height:900});
  await navigationDocument(page);
  await page.locator('#regex-search-input').fill('steadyBeacon');
  await expectTotal(page,3); // The debounced query completes without Enter.
  expect(await page.evaluate(()=>scrollY)).toBe(1200);
  await clickSearchOption(page,'regex-case-toggle');
  await expectTotal(page,3);
  expect(await page.evaluate(()=>scrollY)).toBe(1200);
  await clickSearchOption(page,'regex-word-toggle');
  await expectTotal(page,3);
  expect(await page.evaluate(()=>scrollY)).toBe(1200);
  await worker.evaluate(async()=>{await chrome.storage.sync.set({highlightColor:'#89cda5'});});
  await expect.poll(()=>page.evaluate(()=>{
    const name=Array.from(CSS.highlights.keys()).find(key=>key.startsWith('rr-find-')&&!key.endsWith('-current'));
    return name?getComputedStyle(document.querySelector('#navigation-first'),`::highlight(${name})`).backgroundColor:null;
  })).toBe('rgb(137, 205, 165)');
  expect(await page.evaluate(()=>scrollY)).toBe(1200);
  await clickSearchOption(page,'regex-auto-toggle');
  await page.evaluate(()=>{document.querySelector('#navigation-first').textContent='steadyBeacon steadyBeacon';});
  await expectTotal(page,4);
  expect(await page.evaluate(()=>scrollY)).toBe(1200);
  await locateCurrent(page);
  await expect.poll(()=>page.evaluate(()=>scrollY)).toBeLessThan(300);
  await expect.poll(async()=>{const range=await currentRangeGeometry(page);return !!range?.inViewport&&!range?.underToolbar;}).toBe(true);
  await expect(page.locator('#regex-search-count')).toHaveText('1/4');
  await page.evaluate(()=>{document.querySelector('#navigation-last').textContent='steadyBeacon steadyBeacon';});
  await expectTotal(page,5);
  await page.locator('#regex-search-input').press('Enter');
  await expect(page.locator('#regex-search-count')).toHaveText('2/5');
  expect(app.pageErrors).toEqual([]);
});

test('explicit navigation ignores author smooth scrolling and never pulls back a user wheel action', async ({ app }) => {
  const {page}=app;
  await page.setViewportSize({width:1280,height:900});
  await navigationDocument(page,{smooth:true});
  await page.locator('#regex-search-input').fill('steadyBeacon');
  await expectTotal(page,3);
  expect(await page.evaluate(()=>scrollY)).toBe(1200);
  // The first Enter locates the current match; the next Enter advances.
  await page.locator('#regex-search-input').press('Enter');
  await expect.poll(()=>page.evaluate(()=>scrollY)).toBeLessThan(300);
  await expect(page.locator('#regex-search-count')).toHaveText('1/3');
  await page.locator('#regex-search-input').press('Enter');
  await expect(page.locator('#regex-search-count')).toHaveText('2/3');
  await page.waitForTimeout(80);
  const firstY=await page.evaluate(()=>scrollY);
  expect((await currentRangeGeometry(page)).inViewport).toBe(true);
  await page.waitForTimeout(220);
  expect(Math.abs(await page.evaluate(()=>scrollY)-firstY)).toBeLessThanOrEqual(1);
  await page.locator('#regex-prev-button').click();
  await expect.poll(()=>page.evaluate(()=>scrollY)).toBeLessThan(300);
  await page.mouse.move(20,600);
  await page.mouse.wheel(0,500);
  await page.waitForTimeout(120);
  const userY=await page.evaluate(()=>scrollY);
  expect(userY).toBeGreaterThan(150);
  await page.waitForTimeout(450);
  expect(Math.abs(await page.evaluate(()=>scrollY)-userY)).toBeLessThanOrEqual(2);
  // Hold the real worker response so the user gesture happens while an
  // accepted explicit query is still busy, before a scroll can be queued.
  for(const gesture of ['wheel','drag']) {
    await page.evaluate(()=>scrollTo({top:1200,behavior:'instant'}));
    await isolated(app,'(() => {window.__rrBusyScrollOriginal=RRWorkerManager.searchStream;window.__rrBusyScrollComplete=false;window.__rrBusyScrollCalls=0;const gate=new Promise(resolve=>{window.__rrBusyScrollRelease=resolve;});RRWorkerManager.searchStream=async function(...args){window.__rrBusyScrollCalls++;const result=await window.__rrBusyScrollOriginal.apply(this,args);window.__rrBusyScrollComplete=true;await gate;return result;};return true;})');
    try {
      await page.locator('#regex-search-input').fill(gesture==='wheel'?'steadyBeacon|steadyBeacon':'steadyBeacon|steadyBeacon|steadyBeacon');
      await page.locator('#regex-search-input').press('Enter');
      await expect.poll(()=>isolated(app,'(() => window.__rrBusyScrollComplete)')).toBe(true);
      await expect(page.locator('#regex-search-container')).toHaveAttribute('aria-busy','true');
      if(gesture==='wheel') {await page.mouse.move(20,600);await page.mouse.wheel(0,400);await page.waitForTimeout(160);}
      else await dragToolbarBy(page,-80,40);
      const gestureY=await page.evaluate(()=>scrollY);
      expect(gestureY).toBeGreaterThan(1000);
      await isolated(app,'(() => {window.__rrBusyScrollRelease();return true;})');await expectTotal(page,3);
      await page.waitForTimeout(220);
      expect(Math.abs(await page.evaluate(()=>scrollY)-gestureY),`busy ${gesture} must cancel the later explicit location`).toBeLessThanOrEqual(2);
      expect(await isolated(app,'(() => window.__rrBusyScrollCalls)')).toBe(1);
    } finally {await isolated(app,'(() => {window.__rrBusyScrollRelease();RRWorkerManager.searchStream=window.__rrBusyScrollOriginal;delete window.__rrBusyScrollOriginal;delete window.__rrBusyScrollRelease;return true;})');}
  }
  expect(app.pageErrors).toEqual([]);
});

test('locating a match in a small viewport keeps its rendered text outside the floating toolbar', async ({ app }) => {
  const {page}=app;
  await page.setViewportSize({width:390,height:480});
  await navigationDocument(page);
  await page.locator('#regex-search-input').fill('steadyBeacon');
  await expectTotal(page,3);
  expect(await page.evaluate(()=>scrollY)).toBe(1200);
  await page.evaluate(()=>{
    const range=document.createRange();range.selectNodeContents(document.querySelector('#navigation-middle'));
    const target=range.getBoundingClientRect(),toolbar=document.querySelector('#regex-search-container').getBoundingClientRect();
    scrollTo({top:scrollY+target.top+target.height/2-toolbar.top-toolbar.height/2,behavior:'instant'});
  });
  const wasCovered=await page.evaluate(()=>{
    const range=document.createRange();range.selectNodeContents(document.querySelector('#navigation-middle'));
    const rect=range.getBoundingClientRect(),toolbar=document.querySelector('#regex-search-container').getBoundingClientRect();
    const x=(rect.left+rect.right)/2,y=(rect.top+rect.bottom)/2;
    return x>=toolbar.left&&x<=toolbar.right&&y>=toolbar.top&&y<=toolbar.bottom;
  });
  expect(wasCovered).toBe(true);
  await page.locator('#regex-next-button').click();
  await expect(page.locator('#regex-search-count')).toHaveText('2/3');
  await expect.poll(async()=>{const range=await currentRangeGeometry(page);return !!range?.inViewport&&!range?.underToolbar;}).toBe(true);
  await saveUIShot(page,'ui-search-small-viewport-location');
  expect(app.pageErrors).toEqual([]);
});

function installLargeRenderProbe() {
  const probe=window.__rrLargeRenderProbe={started:0,finished:0,marks:0,calls:{},originals:[]};
  function wrap(owner,key,label) {
    const original=owner?.[key];if(typeof original!=='function')return;
    probe.originals.push([owner,key,original]);
    owner[key]=function(...args) {
      if(!probe.started||probe.finished)return original.apply(this,args);
      const started=performance.now();
      try{return original.apply(this,args);}
      finally{
        const elapsed=performance.now()-started,stats=probe.calls[label]||(probe.calls[label]={calls:0,totalMs:0,maxMs:0});
        stats.calls++;stats.totalMs+=elapsed;stats.maxMs=Math.max(stats.maxMs,elapsed);
      }
    };
  }
  wrap(Range.prototype,'getClientRects','range.getClientRects');
  wrap(Range.prototype,'getBoundingClientRect','range.getBoundingClientRect');
  wrap(Range.prototype,'toString','range.toString');
  wrap(Highlight.prototype,'add','highlight.add');
  wrap(Element.prototype,'getBoundingClientRect','element.getBoundingClientRect');
  wrap(window,'getComputedStyle','window.getComputedStyle');
  const original=RRHighlightEngine.renderMatchesBatched;
  probe.originals.push([RRHighlightEngine,'renderMatchesBatched',original]);
  RRHighlightEngine.renderMatchesBatched=async function(...args) {
    probe.started=performance.now();
    try {const result=await original.apply(this,args);probe.marks=result.marks.length;return result;}
    finally {probe.finished=performance.now();}
  };
  probe.restore=()=>{for(const [owner,key,method] of probe.originals)owner[key]=method;};
  return true;
}

test('result counts and query states keep the input, navigation controls and toolbar geometry stable', async ({ app }) => {
  test.setTimeout(70000);
  const {page}=app;
  await page.bringToFront();
  await page.evaluate(()=>document.fonts.ready);
  const snapshot=()=>page.evaluate(()=>{
    const ids=['regex-search-container','regex-search-input','regex-prev-button','regex-close-button','regex-locate-button'];
    return Object.fromEntries(ids.map(id=>{const rect=document.getElementById(id).getBoundingClientRect();return [id,[rect.left,rect.top,rect.width,rect.height]];}));
  });
  for(const viewport of [{width:1280,height:900},{width:390,height:844}]) {
    await page.setViewportSize(viewport);
    await page.locator('#regex-search-input').fill('');await page.locator('#regex-search-input').press('Enter');
    const baseline=await snapshot();
    const viewportY=await page.evaluate(()=>scrollY);
    await openAdvanced(page);
    const withMenu=await snapshot();
    for(const [id,values] of Object.entries(withMenu))for(let index=0;index<values.length;index++) {
      expect(Math.abs(values[index]-baseline[id][index]),`${viewport.width}px menu: ${id} coordinate ${index}`).toBeLessThanOrEqual(1);
    }
    expect(await page.evaluate(()=>scrollY)).toBe(viewportY);
    await page.locator('#regex-advanced-toggle').click();
    for(const [query,count,status] of [['noLayoutMatchBeacon','0',null],['shadowBeacon','1/1',null],['visibleBeacon','1/2',null],['[','', '正则有误']]) {
      await page.evaluate(()=>{
        window.uiLayoutFrames=[];const until=performance.now()+2000;
        function sample(){
          const ids=['regex-search-container','regex-search-input','regex-prev-button','regex-close-button','regex-locate-button'];
          window.uiLayoutFrames.push(Object.fromEntries(ids.map(id=>{const rect=document.getElementById(id).getBoundingClientRect();return [id,[rect.left,rect.top,rect.width,rect.height]];})));
          if(performance.now()<until)window.uiLayoutSampleFrame=requestAnimationFrame(sample);
        }
        window.uiLayoutSampleFrame=requestAnimationFrame(sample);
      });
      await page.locator('#regex-search-input').fill(query);
      if(status)await expect(page.locator('#regex-search-status')).toHaveText(status);
      else await expect(page.locator('#regex-search-count')).toHaveText(count);
      await expect(page.locator('#regex-search-count')).toHaveCSS('font-size','12px');
      const results=await page.evaluate(()=>{cancelAnimationFrame(window.uiLayoutSampleFrame);return window.uiLayoutFrames;});
      results.push(await snapshot());
      const failures=[];
      for(const result of results)for(const [id,values] of Object.entries(result))for(let index=0;index<values.length;index++) {
        const delta=Math.abs(values[index]-baseline[id][index]);if(delta>1)if(!failures.some(failure=>failure.id===id&&failure.index===index&&failure.delta===delta))failures.push({id,index,delta,values,baseline:baseline[id]});
      }
      if(failures.length) {
        const footer=await page.evaluate(()=>Array.from(document.querySelectorAll('#regex-search-container,.rr-query-row,.rr-query-field,.rr-status-box,.rr-status-copy,.rr-status,.rr-status-detail,.rr-footer-actions,#regex-locate-button,#regex-advanced-toggle'),node=>{
          const rect=node.getBoundingClientRect(),style=getComputedStyle(node);
          return {id:node.id,className:node.className,hidden:node.hidden,text:node.textContent.slice(0,120),
            rect:{left:rect.left,top:rect.top,width:rect.width,height:rect.height},display:style.display,
            minHeight:style.minHeight,flex:style.flex,flexWrap:style.flexWrap,fontSize:style.fontSize,lineHeight:style.lineHeight};
        }));
        await writeFile(fileURLToPath(new URL('../../.tmp/ui-layout-failure.json',import.meta.url)),JSON.stringify({viewport,query,baseline,failures:failures.slice(0,20),footer},null,2));
        await saveUIShot(page,'ui-layout-failure',page.locator('#regex-search-container'));
      }
      expect(failures.length,`${viewport.width}px ${query}: geometry moved`).toBe(0);
      expect(await page.evaluate(()=>scrollY),`${viewport.width}px ${query}: passive query scrolled`).toBe(viewportY);
    }
  }
  const largeBaseline=await snapshot();
  await app.worker.evaluate(async()=>{await chrome.storage.sync.set({maxMatches:20000,workerTimeoutMs:30000});});
  // A real visible textarea exercises the supported 20k result/count limit
  // without adding 20k DOM elements just to stress the numeric UI boundary.
  await page.evaluate(()=>{
    const control=document.createElement('textarea');control.id='layout-many';
    control.value='layoutBeacon '.repeat(20005);document.querySelector('main').append(control);
  });
  const probeName=process.env.RR_BROWSER_RENDER_PROBE;
  if(probeName)await isolated(app,installLargeRenderProbe.toString());
  await page.evaluate(()=>{heartbeat.maxGap=0;heartbeat.ticks=0;heartbeat.last=performance.now();});
  const largeStarted=performance.now();
  await page.locator('#regex-search-input').fill('layoutBeacon');
  try {
    await expect(page.locator('#regex-search-count')).toHaveText('1/20000+',{timeout:35000});
  } finally {
    if(probeName) {
      const probe=await isolated(app,'(() => {const probe=window.__rrLargeRenderProbe; const elapsed=probe.started?(probe.finished||performance.now())-probe.started:0; const result={elapsedRenderMs:elapsed,completed:!!probe.finished,marks:probe.marks,calls:probe.calls,nativeRegisteredRanges:Array.from(CSS.highlights.entries()).filter(([name])=>name.startsWith("rr-find-")&&!name.endsWith("-current")).reduce((total,[,ranges])=>total+ranges.size,0)};probe.restore();return result;})');
      const heartbeat=await page.evaluate(()=>({ticks:window.heartbeat.ticks,maxGapMs:window.heartbeat.maxGap,status:document.querySelector('#regex-search-status').textContent,count:document.querySelector('#regex-search-count').textContent}));
      const report={elapsedTotalMs:performance.now()-largeStarted,...probe,heartbeat};
      await writeFile(fileURLToPath(new URL('../../.tmp/ui-render-'+probeName+'.json',import.meta.url)),JSON.stringify(report,null,2));
      console.log('Large rendering probe:',JSON.stringify(report));
    }
  }
  await page.locator('#regex-prev-button').click();
  await expect(page.locator('#regex-search-count')).toHaveText('20000/20000+');
  await expect(page.locator('#regex-search-count')).toHaveCSS('font-size','10px');
  const largeResult=await snapshot();
  for(const [id,values] of Object.entries(largeResult))for(let index=0;index<values.length;index++) {
    expect(Math.abs(values[index]-largeBaseline[id][index]),`20000 result limit: ${id} coordinate ${index}`).toBeLessThanOrEqual(1);
  }
  for(const width of [390,320]) {
    await page.setViewportSize({width,height:844});
    const countWidth=await page.locator('#regex-search-count').evaluate(element=>{
      const style=getComputedStyle(element),canvas=document.createElement('canvas'),context=canvas.getContext('2d');
      context.font=`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      return {ink:context.measureText(element.textContent).width,box:element.getBoundingClientRect().width};
    });
    expect(countWidth.ink).toBeLessThanOrEqual(countWidth.box+1);
  }
  await page.setViewportSize({width:1280,height:900});
  await page.locator('#regex-search-input').fill('shadowBeacon');
  await expectTotal(page,1);
  await expect(page.locator('#regex-search-count')).toHaveCSS('font-size','12px');
  await saveUIShot(page,'ui-compact-readable-count',page.locator('#regex-search-container'));
  expect(app.pageErrors).toEqual([]);
});

test('Enter during a passive query keeps the next-match intent and does not start a second real worker query', async ({ app }) => {
  const {page}=app;
  await page.setViewportSize({width:1280,height:900});
  await navigationDocument(page);
  await page.locator('#regex-search-input').fill('steadyBeacon');
  await expectTotal(page,3);
  await locateCurrent(page);
  await expect.poll(()=>page.evaluate(()=>scrollY)).toBeLessThan(300);
  await isolated(app, '(() => { window.__rrBrowserOriginalSearch=RRWorkerManager.searchStream; window.__rrBrowserQueryCalls=0; window.__rrBrowserWorkerComplete=false; const gate=new Promise(resolve=>{window.__rrBrowserReleaseSearch=resolve;}); RRWorkerManager.searchStream=async function(...args){window.__rrBrowserQueryCalls++; const result=await window.__rrBrowserOriginalSearch.apply(this,args); window.__rrBrowserWorkerComplete=true; await gate; return result;}; return true; })');
  try {
    await clickSearchOption(page,'regex-case-toggle');
    await expect.poll(()=>isolated(app,'(() => window.__rrBrowserWorkerComplete)')).toBe(true);
    await expect(page.locator('#regex-search-container')).toHaveAttribute('aria-busy','true');
    await page.locator('#regex-search-input').press('Enter');
    expect(await isolated(app,'(() => window.__rrBrowserQueryCalls)')).toBe(1);
    await isolated(app,'(() => {window.__rrBrowserReleaseSearch();return true;})');
    await expect(page.locator('#regex-search-count')).toHaveText('2/3');
    expect(await isolated(app,'(() => window.__rrBrowserQueryCalls)')).toBe(1);
    await expect.poll(async()=>{const range=await currentRangeGeometry(page);return !!range?.inViewport&&!range?.underToolbar;}).toBe(true);
  } finally {
    await isolated(app,'(() => {window.__rrBrowserReleaseSearch();RRWorkerManager.searchStream=window.__rrBrowserOriginalSearch;delete window.__rrBrowserOriginalSearch;delete window.__rrBrowserReleaseSearch;return true;})');
  }
  expect(app.pageErrors).toEqual([]);
});

test('a long text rendering timeout stops the whole query, removes its resources and permits a small query afterward', async ({ app },testInfo) => {
  const {page,worker}=app;
  await worker.evaluate(async()=>{await chrome.storage.sync.set({maxMatches:20000,workerTimeoutMs:3000});});
  await page.evaluate(()=>{
    const recovery=document.createElement('p');recovery.id='timeout-recovery';recovery.textContent='timeoutRecoveryBeacon';
    const long=document.createElement('p');long.id='timeout-large';long.style.whiteSpace='pre';long.textContent='denseRenderBeacon '.repeat(15000);
    document.querySelector('main').replaceChildren(recovery,long);
    const range=document.createRange();range.selectNodeContents(recovery);
    CSS.highlights.set('website-timeout-highlight',new Highlight(range));
    heartbeat.maxGap=0;heartbeat.last=performance.now();heartbeat.ticks=0;
  });
  await isolated(app,'(() => {window.__rrTimeoutOriginalSearch=RRWorkerManager.searchStream;window.__rrTimeoutMatchingComplete=false;RRWorkerManager.searchStream=async function(...args){const result=await window.__rrTimeoutOriginalSearch.apply(this,args);window.__rrTimeoutMatchingComplete=true;return result;};return true;})');
  const started=performance.now();
  try {
    await page.locator('#regex-search-input').fill('denseRenderBeacon');
    await expect(page.locator('#regex-search-status')).toHaveText('标记中');
    expect(await isolated(app,'(() => window.__rrTimeoutMatchingComplete)')).toBe(true);
    await expect(page.locator('#regex-search-status')).toHaveText('查询超时',{timeout:7000});
    const elapsedMs=performance.now()-started;
    expect(elapsedMs).toBeLessThan(7000);
    await expect(page.locator('#regex-search-container')).toHaveAttribute('aria-busy','false');
    await expect(page.locator('#regex-locate-button')).toBeDisabled();
    expect(await allHighlightSnapshots(page)).toEqual([]);
    expect(await page.evaluate(()=>CSS.highlights.has('website-timeout-highlight'))).toBe(true);
    expect(await page.evaluate(()=>document.querySelectorAll('[data-regex-rabbit-owned="true"]:not(#regex-search-container)').length)).toBe(0);
    await expect.poll(()=>worker.evaluate(()=>clients.size)).toBe(0);
    await search(page,'timeoutRecoveryBeacon',1);
    expect(await page.evaluate(()=>CSS.highlights.has('website-timeout-highlight'))).toBe(true);
    const measurement={deadlineMs:3000,elapsedMs,matchingCompleted:true,
      ...await page.evaluate(()=>({maxHeartbeatGapMs:heartbeat.maxGap,ticks:heartbeat.ticks}))};
    await testInfo.attach('pipeline-render-timeout',{body:JSON.stringify(measurement,null,2),contentType:'application/json'});
    await writeFile(fileURLToPath(new URL('../../.tmp/ui-render-timeout.json',import.meta.url)),JSON.stringify(measurement,null,2));
  } finally {
    await isolated(app,'(() => {RRWorkerManager.searchStream=window.__rrTimeoutOriginalSearch;delete window.__rrTimeoutOriginalSearch;return true;})');
  }
  expect(app.pageErrors).toEqual([]);
});

const POSITION_STORAGE_KEY='regexRabbitToolbarPosition';

async function toolbarRect(page) {
  return page.locator('#regex-search-container').evaluate(node=>{
    const rect=node.getBoundingClientRect();
    return {left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height,
      viewportWidth:innerWidth,viewportHeight:innerHeight};
  });
}

function expectInsideViewport(rect) {
  expect(Object.values(rect).every(Number.isFinite)).toBe(true);
  expect(rect.left).toBeGreaterThanOrEqual(-1);expect(rect.top).toBeGreaterThanOrEqual(-1);
  expect(rect.right).toBeLessThanOrEqual(rect.viewportWidth+1);
  expect(rect.bottom).toBeLessThanOrEqual(rect.viewportHeight+1);
}

async function expectPosition(page,expected) {
  await expect.poll(async()=>{
    const actual=await toolbarRect(page);
    return Math.max(Math.abs(actual.left-expected.left),Math.abs(actual.top-expected.top));
  }).toBeLessThanOrEqual(2);
}

async function dragToolbarBy(page,dx,dy) {
  const box=await page.locator('#regex-drag-handle').boundingBox();
  expect(box).not.toBeNull();
  const x=box.x+box.width/2,y=box.y+box.height/2;
  await page.mouse.move(x,y);await page.mouse.down();
  try {
    await expect(page.locator('#regex-search-container')).toHaveAttribute('data-rr-dragging','true');
    await page.mouse.move(x+dx,y+dy,{steps:4});
  }
  finally {await page.mouse.up();}
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
}

test('a dragged position survives close and body replacement within a document but resets on a fresh document by default',async({app,extension})=>{
  const {page}=app;
  await page.setViewportSize({width:1280,height:900});
  const initial=await toolbarRect(page);
  await dragToolbarBy(page,-170,160);
  const moved=await toolbarRect(page);
  expect(Math.abs(moved.left-initial.left)+Math.abs(moved.top-initial.top)).toBeGreaterThan(100);
  await page.locator('#regex-close-button').click();await app.toggle();
  await expectPosition(page,moved);
  await page.locator('#regex-close-button').click();
  await page.evaluate(()=>{
    const body=document.createElement('body');body.innerHTML='<main><p>positionBodyBeacon</p></main>';
    document.body.replaceWith(body);
  });
  await app.toggle();await expectPosition(page,moved);
  await page.reload();await page.waitForFunction(()=>window.fixtureReady===true);await app.toggle();
  await expectPosition(page,initial);
  const fresh=await openFixtureDocument(extension);
  try {await expectPosition(fresh.page,initial);}
  finally {await fresh.page.close();}
  expect(await app.worker.evaluate(key=>chrome.storage.local.get(key),POSITION_STORAGE_KEY)).toEqual({});
  expect(app.pageErrors).toEqual([]);
});

test('permanent position is shared across reloads, tabs and origins only while the native setting is enabled',async({app,extension})=>{
  const {page,worker}=app;
  await page.setViewportSize({width:1280,height:900});
  const options=await extension.context.newPage();
  try {
    await options.goto(new URL('options.html',worker.url()).href);await expect(options.locator('#save')).toBeEnabled();
    await expect(options.locator('#rememberPosition')).not.toBeChecked();
    await options.locator('#rememberPosition').check();await options.locator('#save').click();
    await expect.poll(()=>worker.evaluate(async()=>!!(await chrome.storage.sync.get('rememberPosition')).rememberPosition)).toBe(true);
    await page.bringToFront();await dragToolbarBy(page,-180,220);
    const moved=await toolbarRect(page);
    await expect.poll(()=>worker.evaluate(async key=>(await chrome.storage.local.get(key))[key]?.version,POSITION_STORAGE_KEY)).toBe(1);
    await page.reload();await page.waitForFunction(()=>window.fixtureReady===true);await app.toggle();await expectPosition(page,moved);
    const fresh=await openFixtureDocument(extension,'/permanent-position-tab');
    const otherServer=await startFixtureServer();let other;
    try {
      await expectPosition(fresh.page,moved);
      other=await openFixtureDocument({...extension,url:otherServer.url},'/other-origin-position');
      expect(new URL(other.page.url()).origin).not.toBe(new URL(page.url()).origin);
      await expectPosition(other.page,moved);
    } finally {
      if(other)await other.page.close();await fresh.page.close();
      await new Promise(resolve=>otherServer.server.close(resolve));
    }
    await options.bringToFront();await options.locator('#rememberPosition').uncheck();await options.locator('#save').click();
    await expect.poll(()=>worker.evaluate(async key=>(await chrome.storage.local.get(key))[key]??null,POSITION_STORAGE_KEY)).toBeNull();
    await page.bringToFront();await expectPosition(page,moved);
    await dragToolbarBy(page,70,55);
    const sessionPosition=await toolbarRect(page);
    await page.locator('#regex-close-button').click();await app.toggle();await expectPosition(page,sessionPosition);
    expect(await worker.evaluate(key=>chrome.storage.local.get(key),POSITION_STORAGE_KEY)).toEqual({});
  } finally {await options.close();}
  expect(app.pageErrors).toEqual([]);
});

test('native pointer dragging clamps at every scale without changing query, focus, selection, page clicks or reading scroll',async({app})=>{
  const {page,worker}=app;
  await page.setViewportSize({width:1280,height:900});await navigationDocument(page);
  await page.locator('#regex-search-input').fill('steadyBeacon');await expectTotal(page,3);
  await page.evaluate(()=>{
    const input=document.querySelector('#regex-search-input');input.focus();input.setSelectionRange(2,6);
    window.dragPageClicks=0;document.body.addEventListener('click',()=>{window.dragPageClicks++;});
  });
  for(const scale of [.5,1,2.5]) {
    await worker.evaluate(async value=>{await chrome.storage.sync.set({scale:value});},scale);
    await expect.poll(()=>page.locator('#regex-search-container').evaluate(node=>Number(getComputedStyle(node).zoom))).toBe(scale);
    await page.locator('#regex-drag-handle').focus();await page.keyboard.press('Home');
    await page.locator('#regex-search-input').evaluate(node=>{node.focus();node.setSelectionRange(2,6);});
    const before=await toolbarRect(page);await dragToolbarBy(page,40,60);const moved=await toolbarRect(page);
    expect(Math.abs(moved.top-before.top-60)).toBeLessThanOrEqual(2);
    expectInsideViewport(moved);
    expect(await page.locator('#regex-search-container').evaluate(node=>node.style.getPropertyPriority('--rr-left'))).toBe('important');
    await dragToolbarBy(page,-100000,-100000);const minimum=await toolbarRect(page);expectInsideViewport(minimum);
    expect(minimum.left).toBeLessThanOrEqual(5);expect(minimum.top).toBeLessThanOrEqual(5);
    await dragToolbarBy(page,100000,100000);const maximum=await toolbarRect(page);expectInsideViewport(maximum);
    expect(maximum.viewportWidth-maximum.right).toBeLessThanOrEqual(5);expect(maximum.viewportHeight-maximum.bottom).toBeLessThanOrEqual(5);
    await page.setViewportSize({width:390,height:480});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    expectInsideViewport(await toolbarRect(page));
    await page.setViewportSize({width:1280,height:900});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  }
  const state=await page.evaluate(()=>{
    const input=document.querySelector('#regex-search-input');return {query:input.value,start:input.selectionStart,end:input.selectionEnd,
      focused:document.activeElement===input,scroll:scrollY,clicks:window.dragPageClicks,count:document.querySelector('#regex-search-count').textContent};
  });
  expect(state).toEqual({query:'steadyBeacon',start:2,end:6,focused:true,scroll:1200,clicks:0,count:'1/3'});
  expect(app.pageErrors).toEqual([]);
});

test('real touch cancellation stops dragging and relocated menus, feedback and keyboard reset remain usable',async({app})=>{
  const {page}=app;await page.setViewportSize({width:390,height:844});
  await search(page,'[');await expect(page.locator('.rr-feedback')).toBeVisible();
  const first=await toolbarRect(page),handle=await page.locator('#regex-drag-handle').boundingBox();
  expect(await page.locator('#regex-drag-handle').evaluate(node=>getComputedStyle(node).touchAction)).toBe('none');
  const session=await page.context().newCDPSession(page);
  try {
    await session.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
    const x=handle.x+handle.width/2,y=handle.y+handle.height/2;
    await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:7,radiusX:1,radiusY:1,force:1}]});
    await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-80,y:y+170,id:7,radiusX:1,radiusY:1,force:1}]});
    await expect.poll(async()=>Math.abs((await toolbarRect(page)).top-first.top)).toBeGreaterThan(100);
    await session.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
    await expect(page.locator('#regex-search-container')).not.toHaveAttribute('data-rr-dragging','true');
    const cancelled=await toolbarRect(page);await page.mouse.move(300,700);await expectPosition(page,cancelled);
    await dragToolbarBy(page,0,100000);expectInsideViewport(await toolbarRect(page));
    await expect(page.locator('.rr-feedback')).toBeInViewport();
    await openAdvanced(page);await expect(page.locator('#regex-advanced-panel')).toBeInViewport();
    await expect(page.locator('#regex-settings-button')).toBeInViewport();
    await saveUIShot(page,'ui-search-dragged-menu',page.locator('#regex-search-container'));
    await page.locator('#regex-drag-handle').focus();await page.keyboard.press('Home');
    await expectPosition(page,first);
    await page.locator('#regex-search-input').focus();await page.locator('#regex-search-input').press('Escape');
    await expect(page.locator('#regex-search-input')).toHaveValue('');
  } finally {await session.send('Emulation.setTouchEmulationEnabled',{enabled:false});await session.detach();}
  expect(app.pageErrors).toEqual([]);
});

test('automatic Chrome language and saved English, Chinese, Japanese and German translate the UI without another search or scroll',async({app,extension})=>{
  test.setTimeout(70000);
  const {page,worker}=app;await page.setViewportSize({width:1280,height:900});await navigationDocument(page);
  await page.locator('#regex-search-input').fill('steadyBeacon');await expectTotal(page,3);
  const chromeLanguage=await worker.evaluate(()=>chrome.i18n.getUILanguage());expect(chromeLanguage).toMatch(/^en(?:-|$)/i);
  await worker.evaluate(async()=>{await chrome.storage.sync.remove('uiLanguage');});
  await expect(page.locator('#regex-close-button')).toHaveAccessibleName('Close search');
  await expect(page.locator('#regex-search-input')).toHaveAccessibleName('Find');
  await isolated(app,'(() => {window.__rrLocaleOriginalSearch=RRWorkerManager.searchStream;window.__rrLocaleSearchCalls=0;RRWorkerManager.searchStream=function(...args){window.__rrLocaleSearchCalls++;return window.__rrLocaleOriginalSearch.apply(this,args);};return true;})');
  const options=await extension.context.newPage();
  const expected={
    en:{find:'Find',close:'Close search',marked:'Highlighted',invalid:'Invalid regex',title:'Settings · Regex Rabbit',language:'Language',save:'Save'},
    'zh-CN':{find:'查找',close:'关闭查找栏',marked:'已标记',invalid:'正则有误',title:'设置 · Regex Rabbit',language:'语言',save:'保存'},
    ja:{find:'検索',close:'検索バーを閉じる',marked:'強調表示済み',invalid:'正規表現が無効です',title:'設定 · Regex Rabbit',language:'言語',save:'保存'},
    de:{find:'Suchen',close:'Suchleiste schließen',marked:'Markiert',invalid:'Ungültiger Regex',title:'Einstellungen · Regex Rabbit',language:'Sprache',save:'Speichern'},
  };
  try {
    await options.goto(new URL('options.html',worker.url()).href);await expect(options.locator('#save')).toBeEnabled();
    await expect(options.locator('#uiLanguage')).toHaveValue('auto');
    for(const [language,strings] of Object.entries(expected)) {
      await options.locator('#uiLanguage').selectOption(language);
      await expect(options).toHaveTitle(strings.title);await expect(options.locator('label[for=uiLanguage]')).toHaveText(strings.language);
      await expect(options.locator('#save')).toHaveText(strings.save);await options.locator('#save').click();
      await expect(page.locator('#regex-close-button')).toHaveAccessibleName(strings.close);
      await expect(page.locator('#regex-close-button')).toHaveAttribute('title',strings.close);
      await expect(page.locator('#regex-search-status')).toHaveText(strings.marked);
      const placeholder=await page.locator('#regex-search-input').getAttribute('placeholder');expect([null,'',strings.find]).toContain(placeholder);
      await expect(page.locator('#regex-search-input')).toHaveValue('steadyBeacon');await expectTotal(page,3);
      expect(await page.evaluate(()=>scrollY)).toBe(1200);expect(await isolated(app,'(() => window.__rrLocaleSearchCalls)')).toBe(0);
      await page.bringToFront();await openAdvanced(page);
      await expect(page.locator('#regex-settings-button')).toHaveText(language==='de'?'Einstellungen':language==='ja'?'設定':language==='zh-CN'?'设置':'Settings');
      await saveUIShot(page,'ui-search-language-'+language.toLowerCase(),page.locator('#regex-search-container'));
      await page.locator('#regex-advanced-toggle').click();
    }
    await page.locator('#regex-locate-button').click();await page.locator('#regex-jump-input').fill('0');
    await page.locator('#regex-jump-input').press('Enter');
    await expect(page.locator('#regex-jump-input')).toHaveJSProperty('validationMessage','Eine Zahl zwischen 1 und 3 eingeben');
    await worker.evaluate(async()=>{await chrome.storage.sync.set({uiLanguage:'ja'});});
    await expect(page.locator('#regex-jump-input')).toHaveJSProperty('validationMessage','1–3 の番号を入力してください');
    await expect(page.locator('#regex-jump-input')).toHaveValue('0');await expect(page.locator('#regex-jump-input')).toBeVisible();
    await page.locator('#regex-jump-input').press('Escape');
    await page.locator('#regex-search-input').fill('[');await expect(page.locator('#regex-search-status')).toHaveText(expected.ja.invalid);
    await worker.evaluate(async()=>{await chrome.storage.sync.set({uiLanguage:'de'});});
    await expect(page.locator('#regex-search-status')).toHaveText(expected.de.invalid);
    await worker.evaluate(async()=>{await chrome.storage.sync.set({uiLanguage:'ja'});});
    await expect(page.locator('#regex-search-status')).toHaveText(expected.ja.invalid);await expect(page.locator('.rr-feedback')).toHaveText(expected.ja.invalid);
    expect(await isolated(app,'(() => window.__rrLocaleSearchCalls)')).toBe(0);expect(await page.evaluate(()=>scrollY)).toBe(1200);
  } finally {
    await options.close();await isolated(app,'(() => {RRWorkerManager.searchStream=window.__rrLocaleOriginalSearch;delete window.__rrLocaleOriginalSearch;return true;})');
  }
  expect(app.pageErrors).toEqual([]);
});

test('invalid stored positions and unsupported locale values cannot move the toolbar outside the viewport or inject markup',async({app})=>{
  const {page,worker}=app;await page.setViewportSize({width:1280,height:900});const initial=await toolbarRect(page);
  for(const position of [{version:1,x:-1e300,y:1e300},{version:1,x:-Infinity,y:Infinity},{version:1,x:NaN,y:.5},{version:1,x:'0.5',y:{}},{version:99,x:.5,y:.5},null]) {
    await page.locator('#regex-close-button').click();
    await worker.evaluate(async({key,position})=>{
      await chrome.storage.local.set({[key]:position});await chrome.storage.sync.set({rememberPosition:true,uiLanguage:'<img src=x onerror=alert(1)>'});
    },{key:POSITION_STORAGE_KEY,position});
    await page.reload();await page.waitForFunction(()=>window.fixtureReady===true);await app.toggle();
    await expectPosition(page,initial);expectInsideViewport(await toolbarRect(page));
    await expect(page.locator('#regex-close-button')).toHaveAccessibleName('Close search');
    expect(await page.locator('#regex-search-container img').count()).toBe(0);
  }
  expect(app.pageErrors).toEqual([]);
});

test('the true pinch-zoom visual viewport contains the default and dragged toolbar including its close button',async({app})=>{
  const {page}=app;await page.setViewportSize({width:1280,height:900});
  const session=await page.context().newCDPSession(page);
  async function inspectVisibleBounds() {
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const rects=await page.evaluate(()=>{
      const viewport=visualViewport;
      const nodes=['regex-search-container','regex-close-button'].map(id=>document.getElementById(id).getBoundingClientRect());
      return {view:{left:viewport.offsetLeft,top:viewport.offsetTop,right:viewport.offsetLeft+viewport.width,bottom:viewport.offsetTop+viewport.height,scale:viewport.scale},
        nodes:nodes.map(rect=>({left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height}))};
    });
    expect(rects.view.scale).toBe(2);
    for(const rect of rects.nodes) {
      expect(rect.width).toBeGreaterThan(0);expect(rect.height).toBeGreaterThan(0);
      expect(rect.left).toBeGreaterThanOrEqual(rects.view.left-1);expect(rect.top).toBeGreaterThanOrEqual(rects.view.top-1);
      expect(rect.right).toBeLessThanOrEqual(rects.view.right+1);expect(rect.bottom).toBeLessThanOrEqual(rects.view.bottom+1);
    }
  }
  try {
    await session.send('Emulation.setPageScaleFactor',{pageScaleFactor:2});
    await inspectVisibleBounds();
    await dragToolbarBy(page,-70,90);await inspectVisibleBounds();
    await page.locator('#regex-close-button').click();await app.toggle();await inspectVisibleBounds();
    await page.locator('#regex-drag-handle').focus();await page.keyboard.press('Home');await inspectVisibleBounds();
  } finally {await session.send('Emulation.setPageScaleFactor',{pageScaleFactor:1});await session.detach();}
  expect(app.pageErrors).toEqual([]);
});

async function createJumpResults(app) {
  const {page}=app;await page.setViewportSize({width:1280,height:900});
  await page.evaluate(()=>{
    const control=document.createElement('textarea');control.id='jump-results';control.style.cssText='width:600px;height:120px';
    control.value='jumpBeacon '.repeat(10005);document.querySelector('main').replaceChildren(control);
  });
  await page.locator('#regex-search-input').fill('jumpBeacon');
  await expect(page.locator('#regex-search-count')).toHaveText('1/9999+');
}

async function jumpTo(page,index) {
  await page.locator('#regex-locate-button').click();await page.locator('#regex-jump-input').fill(String(index));
  await page.locator('#regex-jump-input').press('Enter');await expect(page.locator('#regex-jump-input')).toBeHidden();
  await expect(page.locator('#regex-search-count')).toHaveText(index+'/9999+');
}

test('a real 9,999-result control query jumps directly to the first, last and middle results in the unchanged toolbar',async({app})=>{
  await createJumpResults(app);const {page}=app,initial=await toolbarRect(page);
  for(const index of [9999,1,4321,7777]) {
    await jumpTo(page,index);
    await expect.poll(()=>page.locator('#jump-results').evaluate(node=>node.selectionStart)).toBe((index-1)*11);
    expect(await page.locator('#jump-results').evaluate(node=>node.selectionEnd)).toBe((index-1)*11+10);
    await expectPosition(page,initial);await expect(page.locator('#regex-search-input')).toHaveValue('jumpBeacon');
  }
  await page.locator('#regex-locate-button').click();
  const selected=await page.locator('#regex-jump-input').evaluate(node=>({value:node.value,start:node.selectionStart,end:node.selectionEnd}));
  expect(selected).toEqual({value:'7777',start:0,end:4});
  await saveUIShot(page,'ui-search-jump-editor',page.locator('#regex-search-container'));
  await page.locator('#regex-jump-input').press('Escape');await expect(page.locator('#regex-search-count')).toHaveText('7777/9999+');
  await page.evaluate(()=>{
    const a=document.createElement('p');a.id='fresh-jump-a';a.textContent='freshJumpBeacon A';
    const b=document.createElement('p');b.id='fresh-jump-b';b.textContent='freshJumpBeacon B';
    document.querySelector('main').replaceChildren(a,b);window.staleJumpText=b.firstChild;
  });
  await page.locator('#regex-search-input').fill('freshJumpBeacon');await expectTotal(page,2);
  await page.evaluate(()=>{
    const host=document.createElement('div');host.id='fresh-jump-host';document.querySelector('main').append(host);
    const root=host.attachShadow({mode:'open'}),holder=document.createElement('p');holder.style.fontSize='19px';
    holder.append(window.staleJumpText);root.append(holder);
    const first=document.createElement('p');first.textContent='freshJumpBeacon inserted';document.querySelector('main').prepend(first);
  });
  await expect(page.locator('#regex-search-count')).toHaveText('1/2');
  await page.locator('#regex-locate-button').click();await page.locator('#regex-jump-input').fill('2');
  await page.locator('#regex-jump-input').press('Enter');await expect(page.locator('#regex-search-count')).toHaveText('2/3');
  expect(await page.evaluate(()=>{
    const current=Array.from(CSS.highlights.entries()).find(([name])=>name.startsWith('rr-find-')&&name.endsWith('-current'));
    return current&&Array.from(current[1])[0]?.startContainer.parentElement.id;
  })).toBe('fresh-jump-a');
  const beforeUnavailable=await page.evaluate(()=>scrollY);
  await page.evaluate(()=>window.staleJumpText.remove());
  await page.locator('#regex-locate-button').click();await page.locator('#regex-jump-input').fill('3');
  await page.locator('#regex-jump-input').press('Enter');
  await expect(page.locator('#regex-search-count')).toHaveText(/^\d+\/2$/);
  await expect(page.locator('#regex-search-status')).toHaveText('该序号已失效');
  expect(await page.evaluate(()=>scrollY)).toBe(beforeUnavailable);
  await isolated(app,'(() => {window.__rrJumpRecoveryOriginal=RRWorkerManager.searchStream;window.__rrJumpRecoveryCalls=0;RRWorkerManager.searchStream=function(...args){window.__rrJumpRecoveryCalls++;return window.__rrJumpRecoveryOriginal.apply(this,args);};return true;})');
  try {
    await page.locator('#regex-locate-button').click();await page.locator('#regex-jump-input').fill('1');
    await page.locator('#regex-jump-input').press('Enter');await expect(page.locator('#regex-search-count')).toHaveText('1/2');
    await expect(page.locator('.rr-feedback')).toBeHidden();await expect(page.locator('#regex-search-status')).toHaveText('已标记');
    expect(await isolated(app,'(() => window.__rrJumpRecoveryCalls)')).toBe(0);
  } finally {await isolated(app,'(() => {RRWorkerManager.searchStream=window.__rrJumpRecoveryOriginal;delete window.__rrJumpRecoveryOriginal;return true;})');}
  expect(app.pageErrors).toEqual([]);
});

test('jump validation, Escape, blur, IME and an automatic refresh cannot navigate to an invalid or stale result',async({app})=>{
  test.setTimeout(60000);await createJumpResults(app);const {page}=app;
  for(const value of ['0','-1','10000','abc','1e3','9'.repeat(100)]) {
    await page.locator('#regex-locate-button').click();await page.locator('#regex-jump-input').fill(value);
    expect((await page.locator('#regex-jump-input').inputValue()).length).toBeLessThanOrEqual(12);
    await page.locator('#regex-jump-input').press('Enter');await expect(page.locator('#regex-search-count')).toHaveText('1/9999+');
    if(await page.locator('#regex-jump-input').isVisible())await page.locator('#regex-jump-input').press('Escape');
    await expect(page.locator('#regex-search-input')).toHaveValue('jumpBeacon');
  }
  await page.locator('#regex-locate-button').click();await page.locator('#regex-jump-input').fill('9999');
  await page.locator('#regex-jump-input').evaluate(node=>{
    node.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'9'}));
    node.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Enter',code:'Enter',isComposing:true}));
  });
  await expect(page.locator('#regex-jump-input')).toBeVisible();await expect(page.locator('#regex-search-count')).toHaveText('1/9999+');
  await page.locator('#regex-jump-input').evaluate(node=>node.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'9'})));
  await page.locator('#regex-search-input').focus();await expect(page.locator('#regex-jump-input')).toBeHidden();
  await expect(page.locator('#regex-search-count')).toHaveText('1/9999+');
  await clickSearchOption(page,'regex-auto-toggle');await expect(page.locator('#regex-search-count')).toHaveText('1/9999+');
  await page.locator('#regex-locate-button').click();await page.locator('#regex-jump-input').fill('7777');
  const scroll=await page.evaluate(()=>scrollY);
  await page.evaluate(()=>{const text=document.createElement('p');text.textContent='jumpBeacon';document.querySelector('main').append(text);});
  await expect(page.locator('#regex-jump-input')).toBeHidden();await expect(page.locator('#regex-search-count')).toHaveText('1/9999+');
  expect(await page.evaluate(()=>scrollY)).toBe(scroll);await expect(page.locator('#regex-search-input')).toHaveValue('jumpBeacon');
  expect(app.pageErrors).toEqual([]);
});

test('an idle automatic query remembers a consumed password placeholder state and detects its restoration between polling passes',async({app})=>{
  const {page}=app;
  await page.evaluate(()=>{
    const field=document.createElement('input');field.type='password';field.id='idle-password';field.placeholder='idlePlaceholderBeacon';
    document.querySelector('main').replaceChildren(field);
  });
  await search(page,'idlePlaceholderBeacon',1);await clickSearchOption(page,'regex-auto-toggle');await expectTotal(page,1);
  // Let the ordinary low-frequency poll establish an empty baseline. No long
  // controls or forced events accelerate polling in this separate scenario.
  await page.waitForTimeout(2300);
  await page.evaluate(()=>{
    document.querySelector('#regex-search-input').focus();const field=document.querySelector('#idle-password');
    field.focus();field.value='privateIdleTestValue';
  });
  await expectTotal(page,0);
  await page.evaluate(()=>{document.querySelector('#idle-password').value='';});
  expect(await page.locator('#idle-password').evaluate(node=>node.matches(':placeholder-shown'))).toBe(true);
  await expectTotal(page,1);
  await page.locator('#regex-search-input').fill('privateIdleTestValue');await expectTotal(page,0);
  expect(app.pageErrors).toEqual([]);
});

const LARGE_REVIEW_DIR=fileURLToPath(new URL('../../.tmp/no-hidden-limits-review/browser/',import.meta.url));
const MIB=1024*1024;

async function beginLargeReview(app,settings={}) {
  await mkdir(LARGE_REVIEW_DIR,{recursive:true});
  await app.worker.evaluate(values=>chrome.storage.sync.set(values),{workerTimeoutMs:5000,...settings});
  app.__rrPhaseSession=await app.page.context().newCDPSession(app.page);
  app.__rrPhaseHeapBefore=await app.__rrPhaseSession.send('Runtime.getHeapUsage');
  await isolated(app,`(() => {
    const state={started:performance.now(),tasks:[],configs:[],collections:[],mappings:[],renders:[],hold:false,entered:false,release:null};
    const originalSearch=RRWorkerManager.searchStream,originalConfig=RRWorkerManager.updateConfig;
    const originalCollect=RRTextCollector.collectBatched,originalMapping=RRTextMapping.resolveMatches,
      originalRender=RRHighlightEngine.renderMatchesBatched,originalTransport=RRWorkerTransport.create;
    RRTextCollector.collectBatched=async function(options){
      const sample={started:performance.now(),callbackMs:0};state.collections.push(sample);
      const originalBatch=options.onBatch,originalStats=options.onStats;
      const wrapped={...options,onStats(stats){sample.stats={...stats};if(originalStats)return originalStats(stats);}};
      if(originalBatch)wrapped.onBatch=async function(...args){const started=performance.now();try{return await originalBatch(...args);}finally{sample.callbackMs+=performance.now()-started;}};
      try{return await originalCollect.call(this,wrapped);}finally{sample.elapsedMs=performance.now()-sample.started;sample.outsideCallbackMs=sample.elapsedMs-sample.callbackMs;}
    };
    RRTextMapping.resolveMatches=async function(...args){
      const sample={started:performance.now(),records:args[0].length,intervals:args[1].length};state.mappings.push(sample);
      try{return await originalMapping.apply(this,args);}finally{sample.elapsedMs=performance.now()-sample.started;}
    };
    RRHighlightEngine.renderMatchesBatched=async function(...args){
      const sample={started:performance.now(),entries:args[0].length,matches:args[1].length};state.renders.push(sample);
      try{const result=await originalRender.apply(this,args);sample.marks=result.marks.length;return result;}finally{sample.elapsedMs=performance.now()-sample.started;}
    };
    RRWorkerTransport.create=async function(...args){
      const adapter=await originalTransport.apply(this,args);let callback=adapter.onmessage;
      const wrapped=function(event){
        const data=event.data,task=data&&state.tasks.find(item=>item.id===data.taskId);
        if(task&&data.__rrBrowserMetrics)task.workerMetrics={...data.__rrBrowserMetrics};
        if(typeof callback==='function')return callback.call(this,event);
      };
      Object.defineProperty(adapter,'onmessage',{configurable:true,get(){return wrapped;},set(value){callback=value;}});
      return adapter;
    };
    RRWorkerManager.updateConfig=function(value){state.configs.push({...value});return originalConfig.apply(this,arguments);};
    RRWorkerManager.searchStream=async function(id,pattern,flags,producer,policy){
      const task={id,length:pattern.length,flags,mode:policy.mode,started:performance.now(),batches:[],streams:[],sources:[]};state.tasks.push(task);
      const wrapped=async function(send,...rest){
        return producer(async function(entries){
          const batch={characters:entries.reduce((sum,entry)=>sum+entry.text.length,0),entries:entries.length};task.batches.push(batch);
          for(const entry of entries)if(entry.stream)task.streams.push({...entry.stream,length:entry.text.length,kind:entry.kind,controlOffset:entry.controlOffset});
          for(const entry of entries)if(entry.source)task.sources.push({...entry.source,length:entry.text.length,kind:entry.kind});
          const sentAt=performance.now();let result;
          try{result=await send(entries);}finally{batch.acknowledgedRoundTripMs=performance.now()-sentAt;}
          if(state.hold&&pattern.length>4096&&!task.held){
            task.held=true;state.entered=true;await new Promise(resolve=>{state.release=resolve;});
          }
          return result;
        },...rest);
      };
      try {const result=await originalSearch.call(this,id,pattern,flags,wrapped,policy);task.result={totalMatches:result.totalMatches,engine:result.engine,limited:result.limited,limitReason:result.limitReason};return result;}
      catch(error){task.error={code:error.code,numericCode:error.numericCode,message:error.message};throw error;}
      finally{task.elapsedMs=performance.now()-task.started;}
    };
    window.__rrLargeReview=state;window.__rrLargeReviewRestore=()=>{
      if(state.release)state.release();RRWorkerManager.searchStream=originalSearch;RRWorkerManager.updateConfig=originalConfig;
      RRTextCollector.collectBatched=originalCollect;RRTextMapping.resolveMatches=originalMapping;
      RRHighlightEngine.renderMatchesBatched=originalRender;RRWorkerTransport.create=originalTransport;
    };
    return true;
  })`);
  await app.page.evaluate(()=>{heartbeat.maxGap=0;heartbeat.ticks=0;heartbeat.last=performance.now();});
}

async function endLargeReview(app,testInfo,name,extra={}) {
  if(extra.source&&typeof extra.source.needle==='string'&&extra.source.needle.length>80){
    extra={...extra,source:{...extra.source,needleLength:extra.source.needle.length}};delete extra.source.needle;
  }
  const report={name,version:await app.worker.evaluate(()=>chrome.runtime.getManifest().version),...extra,
    ...await isolated(app,'(() => {const state=window.__rrLargeReview;return {tasks:state.tasks,configs:state.configs,collections:state.collections,mappings:state.mappings,renders:state.renders};})'),
    ...await app.page.evaluate(()=>({heartbeat:{maxGapMs:heartbeat.maxGap,ticks:heartbeat.ticks},
      count:document.querySelector('#regex-search-count')?.textContent,status:document.querySelector('#regex-search-status')?.textContent,
      scroll:{x:scrollX,y:scrollY}})),
    rendererHeap:{beforeReview:app.__rrPhaseHeapBefore,beforeQuery:app.__rrPhaseHeapQueryStart,
      after:await app.__rrPhaseSession.send('Runtime.getHeapUsage'),scope:'Renderer heap at the sample times; excludes Worker heap and is not a peak measurement.'},
    queryObservation:app.__rrQueryObservation,
    timingScope:'Collection includes callbacks and scheduling. ACK round trips include transfer, Worker handling and reply. Worker timings measure actual start/chunks handlers in the test copy. Phases overlap and must not be added.'};
  await writeFile(`${LARGE_REVIEW_DIR}${name}.json`,JSON.stringify(report,null,2));
  await testInfo.attach(name,{body:JSON.stringify(report,null,2),contentType:'application/json'});
  await isolated(app,'(() => {window.__rrLargeReviewRestore();delete window.__rrLargeReview;delete window.__rrLargeReviewRestore;return true;})');
  await app.__rrPhaseSession.detach();delete app.__rrPhaseSession;delete app.__rrPhaseHeapBefore;delete app.__rrPhaseHeapQueryStart;delete app.__rrQueryObservation;
  return report;
}

async function largeReviewSnapshot(page,name) {
  await saveUIShot(page,`no-hidden-limits-review/browser/${name}`,page.locator('#regex-search-container'));
}

async function resetLargeQueryHeartbeat(app) {
  await app.page.evaluate(async()=>{
    void document.body.offsetHeight;
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    heartbeat.maxGap=0;heartbeat.ticks=0;heartbeat.last=performance.now();
  });
  app.__rrPhaseHeapQueryStart=await app.__rrPhaseSession.send('Runtime.getHeapUsage');
  if(process.env.RR_BROWSER_PROFILE_QUERY==='1') {
    await app.__rrPhaseSession.send('Profiler.enable');
    await app.__rrPhaseSession.send('Profiler.setSamplingInterval',{interval:1000});
    await app.__rrPhaseSession.send('Profiler.start');app.__rrQueryProfiler=true;
  }
}

async function finishLargeQueryObservation(app,name) {
  app.__rrQueryObservation=await app.page.evaluate(()=>({heartbeat:{maxGapMs:heartbeat.maxGap,ticks:heartbeat.ticks},
    scope:'From settled source layout before query input until result count appears; excludes later explicit navigation.'}));
  if(app.__rrQueryProfiler) {
    const {profile}=await app.__rrPhaseSession.send('Profiler.stop');app.__rrQueryProfiler=false;
    await writeFile(`${LARGE_REVIEW_DIR}${name}.cpu.json`,JSON.stringify(profile));
  }
}

async function waitLargeCount(page,value,timeout=35000) {
  // Playwright's failed locator assertions build an ARIA snapshot of the whole
  // page. Poll this small value directly during the performance measurement.
  await page.waitForFunction(value=>document.querySelector('#regex-search-count')?.textContent===value&&
    document.querySelector('#regex-search-container')?.getAttribute('aria-busy')!=='true',value,{timeout});
  await expect(page.locator('#regex-search-count')).toHaveText(value);
}

async function installLargeSource(page,{kind='text',length=20*MIB,needle='streamBoundaryBeacon',offsets=[128*1024-3,19*MIB+5],selectionText=false}={}) {
  return page.evaluate(({kind,length,needle,offsets,selectionText})=>{
    const line='x'.repeat(95)+'\n';let value=line.repeat(Math.ceil(length/line.length)).slice(0,length);
    for(const offset of offsets)value=value.slice(0,offset)+needle+value.slice(offset+needle.length);
    const sliceOffset=18*1024*1024+25;
    if(selectionText)value=value.slice(0,sliceOffset)+'slice!'+value.slice(sliceOffset+6);
    const source=document.createElement(kind==='text'?'pre':'textarea');source.id='large-source';
    source.style.cssText=kind==='text'?'white-space:pre;font:12px/14px monospace;margin:0;width:800px;max-width:100%;':'width:700px;height:160px;font:12px/14px monospace;';
    window.largeSourceNodes=[];
    if(kind==='text')for(let offset=0;offset<value.length;offset+=128*1024){const text=document.createTextNode(value.slice(offset,offset+128*1024));source.append(text);window.largeSourceNodes.push(text);}
    else source.value=value;
    const spacer=document.createElement('div');spacer.style.height='2600px';
    const recovery=document.createElement('p');recovery.id='large-recovery';recovery.textContent='cancelRecoveryBeacon';
    document.querySelector('main').replaceChildren(source,spacer,recovery);
    scrollTo({top:1200,behavior:'instant'});
    return {length:value.length,offsets,needle,sliceOffset,nodes:window.largeSourceNodes.length};
  },{kind,length,needle,offsets,selectionText});
}

test('large query limits accept 4,097 and 4,096,000 literal characters through the real extension Worker',async({app},testInfo)=>{
  test.setTimeout(110000);const {page}=app;let capacities=[];
  await beginLargeReview(app,{workerTimeoutMs:30000});
  try {
    expect(await page.locator('#regex-search-input').evaluate(node=>node.maxLength)).toBe(4096000);
    await page.evaluate(()=>{
      const field=document.createElement('textarea');field.id='large-query-control';field.style.cssText='width:700px;height:160px';
      document.querySelector('main').replaceChildren(field);
    });
    for(const length of [4097,4096000]) {
      if(length===4097)await app.worker.evaluate(()=>chrome.storage.sync.set({workerTimeoutMs:5000}));
      else await app.worker.evaluate(()=>chrome.storage.sync.set({workerTimeoutMs:30000}));
      const query='A'.repeat(length-4)+'😀KZ';
      await page.locator('#large-query-control').evaluate((node,value)=>{node.value=' '+value.toLowerCase()+' ';},query);
      for(const mode of ['regex','literal']) {
        await page.locator('#regex-search-input').fill('');await chooseMode(page,mode);
        const started=performance.now();await page.locator('#regex-search-input').fill(query);
        await expect(page.locator('#regex-search-count')).toHaveText('1/1',{timeout:length===4097?7000:35000});
        expect(await page.locator('#regex-search-input').evaluate(node=>node.value.length)).toBe(length);
        await page.locator('#regex-search-input').press('Enter');
        await expect.poll(()=>page.locator('#large-query-control').evaluate(node=>node.selectionStart)).toBe(1);
        expect(await page.locator('#large-query-control').evaluate(node=>node.selectionEnd)).toBe(length+1);
        capacities.push({length,mode,elapsedMs:performance.now()-started,budgetMs:length===4097?5000:30000});
      }
    }
    await largeReviewSnapshot(page,'query-at-maximum');
    expect(app.pageErrors).toEqual([]);
  } finally {
    const report=await endLargeReview(app,testInfo,'query-limits',{capacities});
    expect(report.configs.every(value=>!Object.hasOwn(value,'maxChunkMs')&&!Object.hasOwn(value,'maxNodeChars'))).toBe(true);
  }
});

test('a real 20Mi continuous text run keeps exact matches across physical windows and locates a distant offset',async({app},testInfo)=>{
  test.setTimeout(90000);const {page}=app;let source;
  // Capacity has a visible, explicit 30-second limit. The default five-second
  // limit remains covered separately by the control and cancellation cases.
  await beginLargeReview(app,{workerTimeoutMs:30000,mode:'literal'});
  try {
    source=await installLargeSource(page);await chooseMode(page,'literal');
    await resetLargeQueryHeartbeat(app);
    const before=await page.evaluate(()=>scrollY),started=performance.now();
    await page.locator('#regex-search-input').fill(source.needle);
    await waitLargeCount(page,'1/2');
    await finishLargeQueryObservation(app,'v4.5.0-continuous-query');
    expect(await page.evaluate(()=>scrollY)).toBe(before);
    const matches=await page.evaluate(()=>{
      const ranges=Array.from(CSS.highlights.entries()).filter(([name])=>name.startsWith('rr-find-')&&!name.endsWith('-current')).flatMap(([,value])=>Array.from(value));
      const positions=ranges.map(range=>({start:window.largeSourceNodes.indexOf(range.startContainer)*128*1024+range.startOffset,
        end:window.largeSourceNodes.indexOf(range.endContainer)*128*1024+range.endOffset,text:range.toString()})).sort((a,b)=>a.start-b.start);
      const merged=[];for(const item of positions){const previous=merged.at(-1);if(previous&&previous.end===item.start){previous.end=item.end;previous.text+=item.text;}else merged.push({...item});}return merged;
    });
    expect(matches).toEqual(source.offsets.map(offset=>({start:offset,end:offset+source.needle.length,text:source.needle})));
    await page.locator('#regex-locate-button').click();await page.locator('#regex-jump-input').fill('2');
    await page.locator('#regex-jump-input').press('Enter');await expect(page.locator('#regex-search-count')).toHaveText('2/2');
    await expect.poll(async()=> (await currentRangeGeometry(page)).inViewport).toBe(true);
    expect(await page.evaluate(()=>scrollY)).toBeGreaterThan(100000);
    await largeReviewSnapshot(page,'distant-text-match');
    source.elapsedMs=performance.now()-started;
    const state=await isolated(app,'(() => window.__rrLargeReview.tasks.find(task=>task.length===20))');
    expect(state.streams.some(stream=>stream.offset>16*MIB)).toBe(true);
    expect(state.streams.every(stream=>stream.length<=16*MIB)).toBe(true);
    expect(state.batches.every(batch=>batch.characters<=16*MIB)).toBe(true);
    expect(app.pageErrors).toEqual([]);
  } finally {await endLargeReview(app,testInfo,'continuous-text',{source});}
});

test('a 20Mi control searches beyond four Mi characters and budgets only a six-character distant selection',async({app},testInfo)=>{
  test.setTimeout(65000);const {page}=app;let source;
  await beginLargeReview(app,{mode:'literal',workerTimeoutMs:30000});
  try {
    source=await installLargeSource(page,{kind:'control',selectionText:true});await chooseMode(page,'literal');
    await resetLargeQueryHeartbeat(app);
    const before=await page.evaluate(()=>scrollY),started=performance.now();
    await page.locator('#regex-search-input').fill(source.needle);
    await expect(page.locator('#regex-search-count')).toHaveText('1/2',{timeout:35000});
    expect(await page.evaluate(()=>scrollY)).toBe(before);
    await page.locator('#regex-locate-button').click();await page.locator('#regex-jump-input').fill('2');await page.locator('#regex-jump-input').press('Enter');
    await expect.poll(()=>page.locator('#large-source').evaluate(node=>node.selectionStart)).toBe(source.offsets[1]);
    expect(await page.locator('#large-source').evaluate(node=>node.selectionEnd)).toBe(source.offsets[1]+source.needle.length);
    source.fullQueryElapsedMs=performance.now()-started;
    await page.locator('#regex-close-button').click();
    await app.worker.evaluate(()=>chrome.storage.sync.set({mode:'regex',workerTimeoutMs:5000,maxScannedChars:1024,characterBudgetVersion:1}));
    await page.locator('#large-source').evaluate((node,offset)=>{node.focus({preventScroll:true});node.setSelectionRange(offset,offset+6);},source.sliceOffset);
    await app.toggle();await chooseScope(page,'selection');await chooseMode(page,'regex');
    await page.locator('#regex-search-input').fill('^slice!$');await expectTotal(page,1);
    await expect(page.locator('#regex-search-count')).toHaveAttribute('title','已扫描 6 个字符');
    await page.locator('#regex-search-input').press('Enter');
    await expect.poll(()=>page.locator('#large-source').evaluate(node=>node.selectionStart)).toBe(source.sliceOffset);
    expect(await page.locator('#large-source').evaluate(node=>node.selectionEnd)).toBe(source.sliceOffset+6);
    await largeReviewSnapshot(page,'distant-control-selection');
    const selected=await isolated(app,'(() => window.__rrLargeReview.tasks.find(task=>task.length===8))');
    expect(selected.batches.reduce((sum,batch)=>sum+batch.characters,0)).toBe(6);
    expect(app.pageErrors).toEqual([]);
  } finally {await endLargeReview(app,testInfo,'control-and-selection',{source});}
});

test('complex regexes match a complete 20Mi source across physical fragments without inventing anchors',async({app},testInfo)=>{
  test.setTimeout(90000);const {page}=app;let source;
  await beginLargeReview(app,{workerTimeoutMs:30000,mode:'regex'});
  try {
    source=await installLargeSource(page,{needle:'crossFragmentBeacon'.repeat(2),offsets:[0,16*MIB-9,19*MIB+5]});
    await page.evaluate(needle=>{const safe=document.createElement('p');safe.id='safe-anchor';safe.textContent=needle;document.querySelector('main').prepend(safe);},source.needle);
    await resetLargeQueryHeartbeat(app);
    const readingY=await page.evaluate(()=>scrollY);
    await chooseMode(page,'regex');await page.locator('#regex-search-input').fill('^'+source.needle+'$');
    await waitLargeCount(page,'1/1');
    await finishLargeQueryObservation(app,'v4.5.0-complex-anchor-query');source.anchorQueryObservation=app.__rrQueryObservation;
    await expect(page.locator('.rr-feedback')).toBeHidden();
    const actual=(await highlightSnapshot(page)).filter(item=>!item.name.endsWith('-current')).flatMap(item=>item.texts);
    expect(actual).toEqual([source.needle]);
    expect(await page.evaluate(()=>scrollY)).toBe(readingY);
    await resetLargeQueryHeartbeat(app);
    await page.locator('#regex-search-input').fill('(?<=x)(crossFragmentBeacon)\\1(?=[x\\n])');
    await waitLargeCount(page,'1/2');
    await finishLargeQueryObservation(app,'v4.5.0-complex-complete-query');
    await expect(page.locator('.rr-feedback')).toBeHidden();
    expect(await page.evaluate(()=>scrollY)).toBe(readingY);
    const ranges=await page.evaluate(()=>{
      const values=Array.from(CSS.highlights.entries()).filter(([name])=>name.startsWith('rr-find-')&&!name.endsWith('-current')).flatMap(([,set])=>Array.from(set));
      const positions=values.map(range=>({start:window.largeSourceNodes.indexOf(range.startContainer)*128*1024+range.startOffset,
        end:window.largeSourceNodes.indexOf(range.endContainer)*128*1024+range.endOffset,text:range.toString()})).sort((a,b)=>a.start-b.start);
      const merged=[];for(const item of positions){const last=merged.at(-1);if(last&&last.end===item.start){last.end=item.end;last.text+=item.text;}else merged.push({...item});}return merged;
    });
    expect(ranges).toEqual(source.offsets.slice(1).map(offset=>({start:offset,end:offset+source.needle.length,text:source.needle})));
    const task=await isolated(app,'(() => window.__rrLargeReview.tasks.at(-1))');
    expect(task.result.limited).toBe(false);expect(task.result.totalMatches).toBe(2);
    expect(task.sources.some(item=>item.offset>=16*MIB)).toBe(true);
    expect(task.sources.every(item=>item.length<=16*MIB)).toBe(true);
    expect(task.batches.every(item=>item.characters<=16*MIB)).toBe(true);
    await page.locator('#regex-locate-button').click();await page.locator('#regex-jump-input').fill('2');await page.locator('#regex-jump-input').press('Enter');
    await expect(page.locator('#regex-search-count')).toHaveText('2/2');
    await expect.poll(async()=>!!(await currentRangeGeometry(page))?.inViewport).toBe(true);
    await largeReviewSnapshot(page,'v4.5.0-complex-complete-source');
    expect(app.pageErrors).toEqual([]);
  } finally {await endLargeReview(app,testInfo,'v4.5.0-complex-complete-source',{source});}
});

test('the native Worker reports its oversized complex-regex compilation limit and immediately accepts a smaller query',async({app},testInfo)=>{
  const {page}=app;await beginLargeReview(app);
  try {
    await page.evaluate(()=>{
      const field=document.createElement('textarea');field.id='engine-limit-control';field.style.cssText='width:700px;height:160px';field.value='a'.repeat(70000)+'b';
      const safe=document.createElement('p');safe.textContent='engineRecoveryBeacon';document.querySelector('main').replaceChildren(field,safe);
    });
    await page.locator('#regex-search-input').fill('a'.repeat(70000)+'.');
    await expect(page.locator('#regex-search-status')).toHaveText('正则过大');
    await expect(page.locator('.rr-feedback')).toHaveAttribute('title','浏览器无法编译此表达式；请改用文本查找或简化正则');
    await expect(page.locator('#regex-search-input')).toHaveAttribute('aria-invalid','true');
    await expect(page.locator('#regex-search-container')).toHaveAttribute('aria-busy','false');
    expect(await highlightSnapshot(page)).toEqual([]);
    const error=await isolated(app,'(() => window.__rrLargeReview.tasks.at(-1).error)');
    expect(error.numericCode).toBe(413);expect(error.code).toBe('engine-pattern-too-large');expect(error.message.length).toBeLessThanOrEqual(512);
    await app.worker.evaluate(()=>chrome.storage.sync.set({uiLanguage:'en'}));
    await expect(page.locator('#regex-search-status')).toHaveText('Regex too large');
    await largeReviewSnapshot(page,'native-engine-limit-en');
    await page.locator('#regex-search-input').fill('engineRecoveryBeacon');await expectTotal(page,1);
    await expect(page.locator('.rr-feedback')).toBeHidden();
    await expect(page.locator('#regex-search-input')).toHaveAttribute('aria-invalid','false');
    expect(app.pageErrors).toEqual([]);
  } finally {await endLargeReview(app,testInfo,'native-engine-limit');}
});

test('large streamed queries keep the default budget and respect typing, wheel and close cancellation',async({app},testInfo)=>{
  test.setTimeout(90000);const {page}=app;const query='Q'.repeat(100000-1)+'Z';let source;
  await beginLargeReview(app,{mode:'literal'});
  try {
    // This default-budget scenario still exceeds the former four-Mi limit.
    // The independent 20Mi capacity case uses an explicit longer deadline.
    source=await installLargeSource(page,{kind:'control',length:5*MIB,needle:query,offsets:[400000]});await chooseMode(page,'literal');
    for(const action of ['typing','wheel','close']) {
      await page.evaluate(()=>scrollTo({top:1200,behavior:'instant'}));
      await isolated(app,'(() => {window.__rrLargeReview.hold=true;window.__rrLargeReview.entered=false;return true;})');
      await page.locator('#regex-search-input').fill(query);await page.locator('#regex-search-input').press('Enter');
      await expect.poll(()=>isolated(app,'(() => window.__rrLargeReview.entered)')).toBe(true);
      await expect(page.locator('#regex-search-container')).toHaveAttribute('aria-busy','true');
      if(action==='typing') {
        await page.locator('#regex-search-input').fill('cancelRecoveryBeacon');await expectTotal(page,1);
      } else if(action==='wheel') {
        await page.mouse.move(20,600);await page.mouse.wheel(0,300);await page.waitForTimeout(150);
      } else {await page.locator('#regex-close-button').click();}
      const currentY=await page.evaluate(()=>scrollY);
      await isolated(app,'(() => {window.__rrLargeReview.hold=false;window.__rrLargeReview.release();return true;})');
      if(action==='close') {
        await expect(page.locator('#regex-search-container')).toBeHidden();await app.toggle();
        await page.locator('#regex-search-input').fill('cancelRecoveryBeacon');await expectTotal(page,1);
      } else await expectTotal(page,1);
      await page.waitForTimeout(200);
      expect(Math.abs(await page.evaluate(()=>scrollY)-currentY),action+' must preserve the user viewport').toBeLessThanOrEqual(2);
      await expect(page.locator('#regex-search-container')).toHaveAttribute('aria-busy','false');
      if(action!=='wheel')await expect(page.locator('#regex-search-input')).toHaveValue('cancelRecoveryBeacon');
      await page.locator('#regex-search-input').fill('');
    }
    const diagnostic=await isolated(app,'(() => ({tasks:window.__rrLargeReview.tasks,configs:window.__rrLargeReview.configs}))');
    expect(diagnostic.configs.every(config=>config.workerTimeoutMs>0&&config.workerTimeoutMs<=5000&&!Object.hasOwn(config,'maxChunkMs')&&!Object.hasOwn(config,'maxNodeChars'))).toBe(true);
    for(const task of diagnostic.tasks)expect(task.batches.every(batch=>batch.characters<=16*MIB)).toBe(true);
    expect(await page.evaluate(()=>heartbeat.ticks)).toBeGreaterThan(10);
    expect(app.pageErrors).toEqual([]);
  } finally {await endLargeReview(app,testInfo,'large-stream-cancellation',{source});}
});

async function reloadSearchApp(app) {
  await app.page.reload();await app.page.waitForFunction(()=>window.fixtureReady===true);
  await app.toggle();await app.page.bringToFront();await expect(app.page.locator('#regex-search-container')).toBeVisible();
}

test('legacy character budgets migrate once and the settings preserve a newly saved small budget without a block-size field',async({app,extension},testInfo)=>{
  test.setTimeout(45000);const {page,worker}=app;let options;
  await worker.evaluate(async()=>{
    await chrome.storage.sync.clear();
    await chrome.storage.sync.set({maxScannedChars:32*1024*1024,maxBlockChars:1024*1024,workerTimeoutMs:5000,uiLanguage:'zh-CN'});
  });
  await reloadSearchApp(app);await beginLargeReview(app);
  try {
    await page.evaluate(()=>{
      const source=document.createElement('textarea');source.id='legacy-budget-source';source.style.cssText='width:700px;height:120px';
      source.value='a'.repeat(2*1024*1024)+'Z';document.querySelector('main').replaceChildren(source);
    });
    await page.locator('#regex-search-input').fill('^a+Z$');await expectTotal(page,1);
    await expect(page.locator('.rr-feedback')).toBeHidden();
    const first=await isolated(app,'(() => window.__rrLargeReview.configs.at(-1))');
    expect(first.maxScannedChars).toBe(32*MIB*1000);expect(Object.hasOwn(first,'maxNodeChars')).toBe(false);
    options=await extension.context.newPage();await options.goto(new URL('options.html',worker.url()).href);
    await expect(options.locator('#save')).toBeEnabled();await options.locator('#advancedSettings summary').click();
    await expect(options.locator('#maxScannedChars')).toHaveValue(String(32*MIB*1000));
    await expect(options.locator('#maxBlockChars')).toHaveCount(0);
    await options.locator('#maxScannedChars').fill('1024');await options.locator('#save').click();
    await expect(options.locator('#status')).toHaveText('设置已保存。');
    expect(await worker.evaluate(()=>chrome.storage.sync.get(['maxScannedChars','characterBudgetVersion']))).toEqual({maxScannedChars:1024,characterBudgetVersion:1});
    await options.reload();await expect(options.locator('#save')).toBeEnabled();
    await expect(options.locator('#maxScannedChars')).toHaveValue('1024');await expect(options.locator('#maxBlockChars')).toHaveCount(0);
    await options.close();options=null;await page.bringToFront();
    await endLargeReview(app,testInfo,'v4.4.1-legacy-migration');
    await reloadSearchApp(app);await beginLargeReview(app);
    await page.evaluate(()=>{
      const short=document.createElement('p');short.textContent='smallBudgetBeacon';
      const long=document.createElement('textarea');long.style.cssText='width:700px;height:120px';long.value='a'.repeat(2048)+'smallBudgetBeacon';
      document.querySelector('main').replaceChildren(short,long);
    });
    await page.locator('#regex-search-input').fill('^smallBudgetBeacon$');
    await expect(page.locator('#regex-search-count')).toHaveText('1/1+');
    await expect(page.locator('#regex-search-status')).toHaveText('扫描上限');
    // Count source characters actually processed, including the unfinished
    // control prefix. A partial source cannot fabricate a new regexp EOF.
    await expect(page.locator('.rr-feedback')).toHaveAttribute('title','已扫描 1,024 / 1,024 字符');
    expect(await isolated(app,'(() => window.__rrLargeReview.configs.at(-1).maxScannedChars)')).toBe(1024);
    expect(await worker.evaluate(()=>chrome.storage.sync.get(['maxScannedChars','characterBudgetVersion']))).toEqual({maxScannedChars:1024,characterBudgetVersion:1});
    await largeReviewSnapshot(page,'v4.4.1-real-character-limit');
    await endLargeReview(app,testInfo,'v4.4.1-small-budget');
    await page.locator('#regex-close-button').click();await beginLargeReview(app,{workerTimeoutMs:30000});
    await page.evaluate(()=>{
      const source=document.createElement('pre');source.id='large-unselected-context';source.style.cssText='white-space:pre;font:12px/14px monospace;width:800px;margin:0';
      const line='x'.repeat(95)+'\n';source.textContent='foobar'+line.repeat(Math.ceil(18*1024*1024/line.length));
      document.querySelector('main').replaceChildren(source);
      const range=document.createRange();range.setStart(source.firstChild,0);range.setEnd(source.firstChild,6);
      const selected=getSelection();selected.removeAllRanges();selected.addRange(range);scrollTo({top:0,behavior:'instant'});
    });
    await app.toggle();await chooseScope(page,'selection');await page.locator('#regex-search-input').fill('^foobar$');
    await expect(page.locator('#regex-search-count')).toHaveText('1/1',{timeout:35000});
    await expect(page.locator('.rr-feedback')).toBeHidden();await expect(page.locator('#regex-search-count')).toHaveAttribute('title','已扫描 6 个字符');
    const selected=await isolated(app,'(() => window.__rrLargeReview.tasks.find(task=>task.length===8))');
    expect(selected.batches.reduce((sum,batch)=>sum+batch.characters,0)).toBe(6);
    expect(await page.locator('#large-unselected-context').evaluate(node=>node.firstChild.length)).toBeGreaterThan(16*MIB);
    expect(app.pageErrors).toEqual([]);
  } finally {
    if(options)await options.close();
    if(await isolated(app,'(() => typeof window.__rrLargeReviewRestore === "function")'))await endLargeReview(app,testInfo,'v4.4.1-selected-large-context');
  }
});

test('a normal complex regex can scan two million characters beyond 250 milliseconds without reporting a scan limit',async({app},testInfo)=>{
  const {page}=app;await beginLargeReview(app);
  try {
    await page.evaluate(()=>{
      const source=document.createElement('textarea');source.id='slow-normal-source';source.style.cssText='width:700px;height:120px';source.value='a'.repeat(2000000);
      const spacer=document.createElement('div');spacer.style.height='2600px';document.querySelector('main').replaceChildren(source,spacer);
      scrollTo({top:1200,behavior:'instant'});
    });
    await page.locator('#regex-search-input').fill('a(?=[a-z]{100}b)');await expectTotal(page,0);
    await expect(page.locator('#regex-search-status')).toHaveText('未找到');await expect(page.locator('.rr-feedback')).toBeHidden();
    await expect(page.locator('#regex-search-count')).toHaveAttribute('title','已扫描 2,000,001 个字符');
    expect(await page.evaluate(()=>scrollY)).toBe(1200);
    const observed=await isolated(app,'(() => ({task:window.__rrLargeReview.tasks.at(-1),config:window.__rrLargeReview.configs.at(-1)}))');
    expect(observed.task.elapsedMs).toBeGreaterThan(250);expect(observed.task.result.limited).toBe(false);expect(observed.task.result.totalMatches).toBe(0);
    expect(Object.hasOwn(observed.config,'maxChunkMs')).toBe(false);expect(Object.hasOwn(observed.config,'maxNodeChars')).toBe(false);
    expect(observed.config.workerTimeoutMs).toBeGreaterThan(0);expect(observed.config.workerTimeoutMs).toBeLessThanOrEqual(5000);
    expect(app.pageErrors).toEqual([]);
  } finally {await endLargeReview(app,testInfo,'v4.4.1-normal-slow-regex');}
});

test('the whole-query deadline allows collection after 4.5 seconds and reports 504 for real expensive matching before recovery',async({app},testInfo)=>{
  test.setTimeout(45000);const {page}=app;let delayed=false;
  await search(page,'visibleBeacon',2);await beginLargeReview(app);
  try {
    await page.evaluate(()=>{
      const first=document.createElement('p');first.textContent='deadlineBoundaryBeacon';
      const nodes=[first];for(let index=0;index<300;index++){const p=document.createElement('p');p.textContent='ordinary filler';nodes.push(p);}
      const last=document.createElement('p');last.textContent='deadlineBoundaryBeacon';nodes.push(last);
      document.querySelector('main').replaceChildren(...nodes);scrollTo({top:1200,behavior:'instant'});
    });
    await isolated(app,`(() => {
      const original=RRWorkerManager.searchStream;window.__rrDeadlineOriginal=original;window.__rrDeadlineHoldMs=0;
      RRWorkerManager.searchStream=function(id,pattern,flags,producer,policy){
        if(pattern!=='deadlineBoundaryBeacon')return original.apply(this,arguments);
        let held=false;
        return original.call(this,id,pattern,flags,async function(send,...rest){
          return producer(async function(entries){const result=await send(entries);if(!held){held=true;const start=performance.now();await new Promise(resolve=>setTimeout(resolve,4550));window.__rrDeadlineHoldMs=performance.now()-start;}return result;},...rest);
        },policy);
      };return true;
    })`);delayed=true;
    await page.locator('#regex-search-input').fill('deadlineBoundaryBeacon');await expectTotal(page,2);
    expect(await isolated(app,'(() => window.__rrDeadlineHoldMs)')).toBeGreaterThanOrEqual(4500);
    await expect(page.locator('.rr-feedback')).toBeHidden();expect(await page.evaluate(()=>scrollY)).toBe(1200);
    await isolated(app,'(() => {RRWorkerManager.searchStream=window.__rrDeadlineOriginal;delete window.__rrDeadlineOriginal;return true;})');delayed=false;
    await page.evaluate(()=>{
      const source=document.createElement('textarea');source.id='query-timeout-source';source.style.cssText='width:700px;height:120px;font:6px/8px monospace';source.value='a'.repeat(12*1024*1024);
      const spacer=document.createElement('div');spacer.style.height='2600px';document.querySelector('main').replaceChildren(source,spacer);
      scrollTo({top:1200,behavior:'instant'});
    });
    // Give native matching ample work on faster engines too; the timeout must
    // interrupt an actual Worker scan rather than depend on a 100-char probe
    // taking longer than five seconds on this particular machine.
    await page.locator('#regex-search-input').fill('a(?=[a-z]{10000}b)');
    await expect(page.locator('#regex-search-status')).toHaveText('查询超时',{timeout:8000});
    await expect(page.locator('#regex-search-container')).toHaveAttribute('aria-busy','false');
    expect(await page.evaluate(()=>scrollY)).toBe(1200);expect(await highlightSnapshot(page)).toEqual([]);
    const failure=await isolated(app,'(() => window.__rrLargeReview.tasks.at(-1).error)');
    expect(failure.numericCode).toBe(504);expect(failure.code).toBe('search-timeout');
    await largeReviewSnapshot(page,'v4.4.1-query-timeout');
    await page.evaluate(()=>{const p=document.createElement('p');p.textContent='deadlineRecoveryBeacon';document.querySelector('main').replaceChildren(p);});
    await page.locator('#regex-search-input').fill('deadlineRecoveryBeacon');await expectTotal(page,1);
    await expect(page.locator('.rr-feedback')).toBeHidden();await expect(page.locator('#regex-search-container')).toHaveAttribute('aria-busy','false');
    expect(app.pageErrors).toEqual([]);
  } finally {
    if(delayed)await isolated(app,'(() => {RRWorkerManager.searchStream=window.__rrDeadlineOriginal;delete window.__rrDeadlineOriginal;return true;})');
    await endLargeReview(app,testInfo,'v4.4.1-unified-deadline');
  }
});

test('dense collapsed whitespace beyond 100,000 mapping pieces retains an exact distant match',async({app},testInfo)=>{
  test.setTimeout(60000);const {page}=app;
  await beginLargeReview(app,{workerTimeoutMs:30000,mode:'regex'});
  try {
    const source=await page.evaluate(()=>{
      const p=document.createElement('p');p.id='dense-whitespace-source';
      p.style.cssText='width:800px;max-width:100%;font:12px/14px monospace;white-space:normal;margin:0';
      const prefix='a \t '.repeat(150000);p.textContent=prefix+'denseTailBeacon';
      document.querySelector('main').replaceChildren(p);window.denseWhitespaceText=p.firstChild;
      scrollTo({top:1200,behavior:'instant'});return {rawOffset:prefix.length,rawLength:p.firstChild.length,pieces:300001};
    });
    await resetLargeQueryHeartbeat(app);
    const readingY=await page.evaluate(()=>scrollY);
    await page.locator('#regex-search-input').fill('(?<=a )denseTailBeacon$');
    await expect(page.locator('#regex-search-count')).toHaveText('1/1',{timeout:35000});
    await expect(page.locator('.rr-feedback')).toBeHidden();expect(await page.evaluate(()=>scrollY)).toBe(readingY);
    const actual=await page.evaluate(()=>Array.from(CSS.highlights.entries())
      .filter(([name])=>name.startsWith('rr-find-')&&!name.endsWith('-current')).flatMap(([,set])=>Array.from(set,range=>
        ({sameNode:range.startContainer===window.denseWhitespaceText&&range.endContainer===window.denseWhitespaceText,
          start:range.startOffset,end:range.endOffset,text:range.toString()}))));
    expect(actual).toEqual([{sameNode:true,start:source.rawOffset,end:source.rawLength,text:'denseTailBeacon'}]);
    const stats=await isolated(app,'(() => window.__rrLargeReview.collections.at(-1).stats)');
    expect(stats.truncated).toBe(false);expect(stats.reasons).toEqual([]);
    expect(stats.peakBufferedSegments).toBeLessThan(20);
    await page.locator('#regex-search-input').press('Enter');
    await expect.poll(async()=>!!(await currentRangeGeometry(page))?.inViewport).toBe(true);
    await largeReviewSnapshot(page,'v4.5.0-dense-whitespace');
    expect(app.pageErrors).toEqual([]);
    await endLargeReview(app,testInfo,'v4.5.0-dense-whitespace',{source});
  } finally {
    if(await isolated(app,'(() => typeof window.__rrLargeReviewRestore === "function")'))await endLargeReview(app,testInfo,'v4.5.0-dense-whitespace-failure');
  }
});

test('six hundred real shadow roots retain the final visible result and its location',async({app},testInfo)=>{
  test.setTimeout(60000);const {page}=app;
  await beginLargeReview(app,{workerTimeoutMs:30000,mode:'literal'});
  try {
    await page.evaluate(()=>{
      const fragment=document.createDocumentFragment();window.manyShadowRoots=[];
      for(let index=0;index<600;index++) {
        const host=document.createElement('div');host.id='many-root-'+index;
        const root=host.attachShadow({mode:index===599?'closed':'open'}),p=document.createElement('p');
        p.style.cssText='margin:0;font:12px/14px monospace';p.textContent=index===599||index===5?'finalRootBeacon':'ordinary root '+index;
        if(index===5)p.style.visibility='hidden';
        p.id='root-text-'+index;root.append(p);window.manyShadowRoots.push(root);fragment.append(host);
      }
      document.querySelector('main').replaceChildren(fragment);scrollTo({top:1200,behavior:'instant'});
    });
    await resetLargeQueryHeartbeat(app);
    const readingY=await page.evaluate(()=>scrollY);await chooseMode(page,'literal');
    await page.locator('#regex-search-input').fill('finalRootBeacon');
    await expect(page.locator('#regex-search-count')).toHaveText('1/1',{timeout:35000});
    await expect(page.locator('.rr-feedback')).toBeHidden();expect(await page.evaluate(()=>scrollY)).toBe(readingY);
    const result=await page.evaluate(()=>{
      const ranges=Array.from(CSS.highlights.entries()).filter(([name])=>name.startsWith('rr-find-')&&!name.endsWith('-current')).flatMap(([,set])=>Array.from(set));
      return ranges.map(range=>({text:range.toString(),rootIndex:window.manyShadowRoots.indexOf(range.startContainer.getRootNode())}));
    });
    expect(result).toEqual([{text:'finalRootBeacon',rootIndex:599}]);
    const stats=await isolated(app,'(() => window.__rrLargeReview.collections.at(-1).stats)');
    expect(stats.shadowRoots).toBe(600);expect(stats.truncated).toBe(false);
    await page.locator('#regex-search-input').press('Enter');
    await expect.poll(async()=>!!(await currentRangeGeometry(page))?.inViewport).toBe(true);
    await largeReviewSnapshot(page,'v4.5.0-six-hundred-roots');expect(app.pageErrors).toEqual([]);
  } finally {await endLargeReview(app,testInfo,'v4.5.0-six-hundred-roots');}
});

test('a real range checks past 512 clipped rectangles to find its painted last line',async({app},testInfo)=>{
  const {page}=app;await beginLargeReview(app,{mode:'regex'});
  try {
    const geometry=await page.evaluate(()=>{
      const spacer=document.createElement('div');spacer.style.height='2000px';
      const clip=document.createElement('div');clip.id='many-rect-clip';clip.style.cssText='height:14px;width:180px;overflow:hidden;position:relative';
      const pre=document.createElement('pre');pre.id='many-rect-source';pre.style.cssText='position:relative;top:-8400px;font:12px/14px monospace;white-space:pre;margin:0';
      pre.textContent='r\n'.repeat(600)+'z';clip.append(pre);
      const tail=document.createElement('div');tail.style.height='1600px';document.querySelector('main').replaceChildren(spacer,clip,tail);
      const range=document.createRange();range.selectNodeContents(pre);
      const rects=Array.from(range.getClientRects()),boundary=clip.getBoundingClientRect();
      const firstPainted=rects.findIndex(rect=>rect.width>0&&rect.height>0&&rect.bottom>boundary.top&&rect.top<boundary.bottom&&rect.right>boundary.left&&rect.left<boundary.right);
      scrollTo({top:1200,behavior:'instant'});return {rectangles:rects.length,firstPainted};
    });
    expect(geometry.rectangles).toBeGreaterThan(512);expect(geometry.firstPainted).toBeGreaterThan(512);
    await resetLargeQueryHeartbeat(app);
    const readingY=await page.evaluate(()=>scrollY);
    await page.locator('#regex-search-input').fill('^(?:r\\n){600}z$');await expectTotal(page,1);
    await expect(page.locator('.rr-feedback')).toBeHidden();expect(await page.evaluate(()=>scrollY)).toBe(readingY);
    const ranges=(await highlightSnapshot(page)).filter(item=>!item.name.endsWith('-current')).flatMap(item=>item.texts);
    expect(ranges).toEqual(['r\n'.repeat(600)+'z']);
    await page.locator('#regex-search-input').press('Enter');
    await expect.poll(()=>page.evaluate(()=>{
      const clip=document.querySelector('#many-rect-clip').getBoundingClientRect(),toolbar=document.querySelector('#regex-search-container').getBoundingClientRect();
      return clip.top>=0&&clip.bottom<=innerHeight&&(clip.bottom<=toolbar.top||clip.top>=toolbar.bottom);
    })).toBe(true);
    await largeReviewSnapshot(page,'v4.5.0-rectangles-after-512');expect(app.pageErrors).toEqual([]);
    await endLargeReview(app,testInfo,'v4.5.0-rectangles-after-512',{geometry});
  } finally {
    if(await isolated(app,'(() => typeof window.__rrLargeReviewRestore === "function")'))await endLargeReview(app,testInfo,'v4.5.0-rectangles-after-512-failure');
  }
});

test('automatic refresh preserves an exact same-node match and survives five body replacements',async({app},testInfo)=>{
  test.setTimeout(60000);const {page}=app;await beginLargeReview(app,{mode:'literal'});
  try {
    const phrase='anchorBeacon filler ';
    await page.evaluate(phrase=>{
      document.body.style.overflowAnchor='none';
      const p=document.createElement('p');p.id='same-node-anchors';p.textContent=phrase.repeat(6);p.style.cssText='font:16px/28px monospace';
      const other=document.createElement('p');other.id='anchor-unrelated';other.textContent='ordinary';
      const spacer=document.createElement('div');spacer.style.height='2400px';document.querySelector('main').replaceChildren(p,other,spacer);
    },phrase);
    await chooseMode(page,'literal');await search(page,'anchorBeacon',6);await clickSearchOption(page,'regex-auto-toggle');
    await page.locator('#regex-locate-button').click();await page.locator('#regex-jump-input').fill('3');await page.locator('#regex-jump-input').press('Enter');
    await expect(page.locator('#regex-search-count')).toHaveText('3/6');
    const located=await page.evaluate(()=>scrollY),beforeTasks=await isolated(app,'(() => window.__rrLargeReview.tasks.length)');
    await page.locator('#anchor-unrelated').evaluate(node=>{node.textContent='unrelated content changed';});
    await expect.poll(()=>isolated(app,'(() => window.__rrLargeReview.tasks.length)')).toBeGreaterThan(beforeTasks);
    await expect(page.locator('#regex-search-container')).toHaveAttribute('aria-busy','false');
    await expect(page.locator('#regex-search-count')).toHaveText('3/6');expect(await page.evaluate(()=>scrollY)).toBe(located);
    expect(await page.evaluate(()=>{
      const item=Array.from(CSS.highlights.entries()).find(([name])=>name.startsWith('rr-find-')&&name.endsWith('-current'));
      const range=item&&Array.from(item[1])[0];return range&&{id:range.startContainer.parentElement.id,start:range.startOffset,end:range.endOffset};
    })).toEqual({id:'same-node-anchors',start:phrase.length*2,end:phrase.length*2+12});
    const replacements=[];
    for(let index=0;index<5;index++) {
      const priorTasks=await isolated(app,'(() => window.__rrLargeReview.tasks.length)');
      await page.evaluate(phrase=>{
        const body=document.createElement('body'),main=document.createElement('main');body.style.overflowAnchor='none';
        const p=document.createElement('p');p.id='same-node-anchors';p.textContent=phrase.repeat(6);
        const button=document.createElement('button');button.id='page-focus';button.textContent='Page control';
        const spacer=document.createElement('div');spacer.style.height='2400px';main.append(p,button,spacer);body.append(main);
        document.body.replaceWith(body);button.focus({preventScroll:true});scrollTo({top:400,behavior:'instant'});
      },phrase);
      await expect(page.locator('#regex-search-container')).toBeVisible();
      await expect(page.locator('#regex-search-input')).toHaveValue('anchorBeacon');await expectTotal(page,6);
      await expect.poll(()=>isolated(app,'(() => window.__rrLargeReview.tasks.length)')).toBeGreaterThan(priorTasks);
      await expect(page.locator('#regex-search-container')).toHaveAttribute('aria-busy','false');
      await expect(page.locator('#regex-auto-toggle')).toHaveAttribute('aria-pressed','true');
      expect(await page.evaluate(()=>document.activeElement.id)).toBe('page-focus');expect(await page.evaluate(()=>scrollY)).toBe(400);
      replacements.push({index:index+1,scrollY:await page.evaluate(()=>scrollY),focused:await page.evaluate(()=>document.activeElement.id)});
    }
    await page.evaluate(()=>{const p=document.createElement('p');p.textContent='anchorBeacon';document.querySelector('main').prepend(p);});
    await expectTotal(page,7);expect(await page.evaluate(()=>scrollY)).toBe(400);
    await largeReviewSnapshot(page,'v4.5.0-repeated-body-recovery');expect(app.pageErrors).toEqual([]);
    await endLargeReview(app,testInfo,'v4.5.0-repeated-body-recovery',{replacements});
  } finally {
    if(await isolated(app,'(() => typeof window.__rrLargeReviewRestore === "function")'))await endLargeReview(app,testInfo,'v4.5.0-repeated-body-recovery-failure');
  }
});

test('the actual canvas fallback paints more than 1,000 viewport rectangles per match and cleans up',async({app},testInfo)=>{
  const {page}=app;await beginLargeReview(app,{mode:'literal'});let installed=false;
  try {
    await page.evaluate(()=>{
      const first=document.createElement('p');first.id='canvas-source-a';first.textContent='canvasBeacon';first.style.cssText='margin:80px 0;font:16px/24px monospace';
      const second=first.cloneNode(true);second.id='canvas-source-b';
      const button=document.createElement('button');button.id='canvas-page-focus';button.textContent='Page control';
      const spacer=document.createElement('div');spacer.style.height='1600px';document.querySelector('main').replaceChildren(first,second,button,spacer);
      scrollTo({top:0,behavior:'instant'});
    });
    await isolated(app,`(() => {
      const descriptor=Object.getOwnPropertyDescriptor(CSS,'highlights'),originalRects=Range.prototype.getClientRects,
        originalFill=CanvasRenderingContext2D.prototype.fillRect;
      const probe=window.__rrCanvasProbe={rectanglesPerMatch:1201,fills:0,colors:{},geometry:'Synthetic viewport rectangles returned for two real DOM Ranges; actual Chrome canvas contexts perform drawing.'};
      Object.defineProperty(CSS,'highlights',{configurable:true,value:undefined});
      Range.prototype.getClientRects=function(){
        const element=this.startContainer.parentElement;
        if(!element||!/^canvas-source-[ab]$/.test(element.id))return originalRects.call(this);
        const actual=Array.from(originalRects.call(this));if(!actual.length)return actual;
        const base=actual[0];return Array.from({length:1201},(_,index)=>new DOMRect(base.left+(index%40)*2,base.top+Math.floor(index/40)*2,1,1));
      };
      CanvasRenderingContext2D.prototype.fillRect=function(...args){probe.fills++;probe.colors[this.fillStyle]=(probe.colors[this.fillStyle]||0)+1;return originalFill.apply(this,args);};
      window.__rrCanvasRestore=()=>{if(descriptor)Object.defineProperty(CSS,'highlights',descriptor);else delete CSS.highlights;Range.prototype.getClientRects=originalRects;CanvasRenderingContext2D.prototype.fillRect=originalFill;};
      return true;
    })`);installed=true;
    await chooseMode(page,'literal');await resetLargeQueryHeartbeat(app);const readingY=await page.evaluate(()=>scrollY);
    await page.locator('#regex-search-input').fill('canvasBeacon');await expectTotal(page,2);
    await page.locator('#canvas-page-focus').evaluate(node=>node.focus({preventScroll:true}));
    await expect.poll(()=>isolated(app,'(() => (window.__rrCanvasProbe.colors["#ffe082"]||0)>=1201&&(window.__rrCanvasProbe.colors["#ff6d00"]||0)>=1201)')).toBe(true);
    const canvas=await isolated(app,`(() => {
      const roots=Array.from(document.querySelectorAll('[data-regex-rabbit-owned="true"]'),element=>{
        try{return element.shadowRoot||chrome.dom.openOrClosedShadowRoot(element);}catch(_){return null;}
      }).filter(Boolean);
      const layers=roots.flatMap(root=>Array.from(root.querySelectorAll('canvas')));
      const points=['canvas-source-b','canvas-source-a'].map(id=>{
        const range=document.createRange();range.selectNodeContents(document.getElementById(id));const rect=range.getClientRects()[0];return {x:Math.round(rect.left),y:Math.round(rect.top)};
      });
      return {layers:layers.length,pixels:layers.map((layer,index)=>{
        const ratio=devicePixelRatio,p=points[index];return Array.from(layer.getContext('2d').getImageData(Math.floor(p.x*ratio),Math.floor(p.y*ratio),1,1).data);
      }),...window.__rrCanvasProbe};
    })`);
    expect(canvas.layers).toBe(2);expect(canvas.pixels.every(value=>value[3]>0)).toBe(true);
    expect(await page.evaluate(()=>scrollY)).toBe(readingY);expect(await page.evaluate(()=>document.activeElement.id)).toBe('canvas-page-focus');
    await largeReviewSnapshot(page,'v4.5.0-canvas-fallback');
    await page.locator('#regex-close-button').click();
    expect(await isolated(app,`(() => Array.from(document.querySelectorAll('[data-regex-rabbit-owned="true"]')).reduce((count,element)=>{
      let root;try{root=element.shadowRoot||chrome.dom.openOrClosedShadowRoot(element);}catch(_){}return count+(root?root.querySelectorAll('canvas').length:0);
    },0))`)).toBe(0);
    expect(await page.evaluate(()=>scrollY)).toBe(readingY);expect(app.pageErrors).toEqual([]);
    await endLargeReview(app,testInfo,'v4.5.0-canvas-fallback',{canvas});
  } finally {
    if(installed)await isolated(app,'(() => {window.__rrCanvasRestore();delete window.__rrCanvasRestore;delete window.__rrCanvasProbe;return true;})');
    if(await isolated(app,'(() => typeof window.__rrLargeReviewRestore === "function")'))await endLargeReview(app,testInfo,'v4.5.0-canvas-fallback-failure');
  }
});

test('a real 4,096,000-character ASCII needle uses exact streamed matches in an eight-Mi source',async({app},testInfo)=>{
  test.setTimeout(90000);const {page}=app;const query='Ab'.repeat(2048000);
  await beginLargeReview(app,{mode:'literal',workerTimeoutMs:30000});
  let measurement;
  try {
    await chooseMode(page,'literal');
    const setupStarted=performance.now();
    const source=await page.evaluate(({query,length})=>{
      const first=128*1024-7,second=first+query.length+96;
      const value='x'.repeat(first)+query.toLowerCase()+'x'.repeat(96)+query.toLowerCase()+'x'.repeat(length-second-query.length);
      const field=document.createElement('textarea');field.id='ascii-large-source';field.style.cssText='width:700px;height:140px;font:6px/8px monospace';field.value=value;
      const spacer=document.createElement('div');spacer.style.height='2600px';document.querySelector('main').replaceChildren(field,spacer);
      scrollTo({top:1200,behavior:'instant'});return {length:value.length,queryLength:query.length,offsets:[first,second]};
    },{query,length:8*MIB});
    const sourceSetupCallMs=performance.now()-setupStarted,layoutStarted=performance.now();
    await resetLargeQueryHeartbeat(app);const sourceLayoutSettleMs=performance.now()-layoutStarted,readingY=await page.evaluate(()=>scrollY);
    const started=performance.now();await page.locator('#regex-search-input').fill(query);const inputFillCallMs=performance.now()-started;
    await waitLargeCount(page,'1/2');
    await finishLargeQueryObservation(app,'v4.5.0-long-ascii-query');
    const countReadySinceFillMs=performance.now()-started;
    expect(await page.evaluate(()=>scrollY)).toBe(readingY);await expect(page.locator('.rr-feedback')).toBeHidden();
    const task=await isolated(app,'(() => window.__rrLargeReview.tasks.at(-1))');
    expect(task.result.totalMatches).toBe(2);expect(task.result.limited).toBe(false);expect(task.result.engine).toBe('literal');
    expect(task.streams.length).toBeGreaterThan(1);expect(task.streams.every(value=>value.length<=16*MIB)).toBe(true);
    expect(task.batches.every(value=>value.characters<=16*MIB)).toBe(true);
    measurement={source,sourceSetupCallMs,sourceLayoutSettleMs,inputFillCallMs,countReadySinceFillMs,
      managerSearchMs:task.elapsedMs,worker:task.workerMetrics,
      physicallyTransferredCharacters:task.batches.reduce((sum,batch)=>sum+batch.characters,0),
      batchCount:task.batches.length,physicalWindows:task.streams.length,
      note:'The fill call and query can overlap. Source setup and browser layout are separate observations. Worker handler time is not the user-visible end-to-end time.'};
    await page.locator('#regex-locate-button').click();await page.locator('#regex-jump-input').fill('2');await page.locator('#regex-jump-input').press('Enter');
    await expect(page.locator('#regex-search-count')).toHaveText('2/2');
    await expect.poll(()=>page.locator('#ascii-large-source').evaluate(node=>node.selectionStart)).toBe(source.offsets[1]);
    expect(await page.locator('#ascii-large-source').evaluate(node=>node.selectionEnd)).toBe(source.offsets[1]+query.length);
    await largeReviewSnapshot(page,'v4.5.0-long-ascii-needle');expect(app.pageErrors).toEqual([]);
  } finally {await endLargeReview(app,testInfo,'v4.5.0-long-ascii-needle',{measurement});}
});
