import { test as base, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Optional measurements are appended only to the throwaway extension copy.
// They preserve every protocol message and attach timings for this test runner.
const workerMetricsProbe = `
;(() => {
  const measurements=new Map();let running=null;
  const originalPost=self.postMessage;
  self.postMessage=function(message,...rest){
    const sample=message&&measurements.get(message.taskId);
    if(sample&&message.type!=='error') {
      const current={prepareMs:sample.prepareMs,scanHandlerMs:sample.scanHandlerMs,
        maxScanHandlerMs:sample.maxScanHandlerMs,scanMessages:sample.scanMessages};
      if(running&&running.taskId===message.taskId) {
        const elapsed=performance.now()-running.started;
        if(running.kind==='start')current.prepareMs+=elapsed;
        if(running.kind==='chunks') {current.scanHandlerMs+=elapsed;current.maxScanHandlerMs=Math.max(current.maxScanHandlerMs,elapsed);}
      }
      message={...message,__rrBrowserMetrics:current};
    }
    return originalPost.call(this,message,...rest);
  };
  const originalStart=handleStart,originalChunks=handleChunks,originalMessage=self.onmessage;
  handleStart=function(message){
    const sample={prepareMs:0,scanHandlerMs:0,maxScanHandlerMs:0,scanMessages:0};measurements.set(message.taskId,sample);
    running={taskId:message.taskId,kind:'start',started:performance.now()};
    try{return originalStart(message);}finally{sample.prepareMs+=performance.now()-running.started;running=null;}
  };
  handleChunks=function(message){
    const sample=measurements.get(message.taskId);if(!sample)return originalChunks(message);
    sample.scanMessages++;running={taskId:message.taskId,kind:'chunks',started:performance.now()};
    try{return originalChunks(message);}finally{const elapsed=performance.now()-running.started;sample.scanHandlerMs+=elapsed;sample.maxScanHandlerMs=Math.max(sample.maxScanHandlerMs,elapsed);running=null;}
  };
  self.onmessage=function(event){
    try{return originalMessage(event);}finally{
      const message=event.data;if(message&&(['finish','cancel'].includes(message.type)||!tasks[message.taskId]))measurements.delete(message.taskId);
    }
  };
})();
`;

const markup = `<!doctype html><html><head><meta charset="utf-8"><title>Search fixture</title>
<link rel="stylesheet" href="/fixture.css"><script src="/fixture.js" defer></script></head><body>
<main>
  <p id="inline"><span>needle</span><em>bridge</em></p>
  <p id="visible">visibleBeacon</p>
  <div class="hidden">hiddenBeacon</div><div hidden>hiddenBeacon</div>
  <div style="visibility:hidden">hiddenBeacon</div><div style="opacity:0">hiddenBeacon</div>
  <div style="content-visibility:hidden">hiddenBeacon</div><div style="font-size:0">hiddenBeacon</div>
  <details><summary>Collapsed heading</summary>hiddenBeacon</details>
  <div style="visibility:hidden"><span style="visibility:visible">restoredBeacon</span></div>
  <div style="font-size:0"><span style="font-size:16px">restoredBeacon</span></div>
  <div aria-hidden="true">ariaBeacon</div>
  <div style="overflow:hidden;width:0;height:0">clippedBeacon</div>
  <details><summary>summaryBeacon</summary>collapsedBeacon</details>
  <svg width="200" height="40"><text y="20">svgBeacon</text><defs><text>svgHiddenBeacon</text></defs></svg>
  <svg width="300" height="40"><text id="svg-no-paint" y="20" style="fill:none;stroke:none">paintHiddenMarker</text></svg>
  <svg width="300" height="40"><text id="svg-fill-zero" y="20" style="fill-opacity:0;stroke:none">opacityHiddenMarker</text></svg>
  <svg width="200" height="40"><text id="svg-stroke" y="20" style="fill:none;stroke:black;stroke-width:1">strokeBeacon</text></svg>
  <div id="dynamic-hidden" class="hidden">dynamicBeacon</div>
  <div id="dynamic">dynamicBeacon</div>
  <p id="literal">literal[a]+ literalXa literalZZa</p>
  <p id="words">café caféine CAFÉ 猫 猫咪</p>
  <p id="selection-a">selectedBeacon selectedBeacon</p><p>selectedBeacon</p>
  <label>Input <input id="text-control" value="controlBeacon"></label>
  <textarea id="textarea-control">controlBeacon</textarea>
  <input id="placeholder-control" placeholder="placeholderBeacon"><textarea placeholder="placeholderBeacon"></textarea>
  <select id="label-control"><option value="internalOptionValue">labelBeacon</option><option>unselectedBeacon</option></select>
  <div id="editable" contenteditable="true">controlBeacon</div>
  <input type="password" value="privateBeacon"><input type="hidden" value="privateBeacon">
  <input type="password" placeholder="passwordPlaceholderBeacon">
  <div id="shadow-host"><span slot="provided">slottedBeacon</span><span>unslottedBeacon</span></div>
  <div id="closed-host"><span id="closed-light" slot="provided">closedSlottedBeacon</span></div><div id="late-closed-host"></div>
  <iframe id="same-frame" src="/frame" title="Same origin"></iframe>
  <iframe style="display:none" src="/hidden-frame" title="Hidden"></iframe>
  <iframe id="opaque-frame" sandbox src="/opaque-frame" title="Opaque origin"></iframe>
  <div style="height:1200px"></div><p id="offscreen">visibleBeacon</p>
</main></body></html>`;

const script = `
const root = document.querySelector('#shadow-host').attachShadow({mode:'open'});
root.innerHTML = '<p id="shadow-text">shadowBeacon</p><slot name="provided">fallbackBeacon</slot>';
window.closedFixtureRoot = document.querySelector('#closed-host').attachShadow({mode:'closed'});
window.closedFixtureRoot.innerHTML = '<p id="closed-text">closedBeacon</p><slot name="provided"></slot>';
window.originalInlineNode = document.querySelector('#inline span').firstChild;
window.originalEditableNode = document.querySelector('#editable').firstChild;
window.heartbeat = {ticks:0, maxGap:0, last:performance.now()};
setInterval(() => { const now=performance.now(); heartbeat.maxGap=Math.max(heartbeat.maxGap,now-heartbeat.last); heartbeat.last=now; heartbeat.ticks++; }, 10);
window.fixtureReady = true;
`;

function startServer() {
  const server = createServer((req, res) => {
    // The page cannot spawn any Worker. The real extension must use its own
    // offscreen document rather than relaxing the site's CSP.
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-src 'self'; worker-src 'none'; object-src 'none'");
    if (req.url === '/strict-style') {
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'none'; worker-src 'none'; object-src 'none'");
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><p id="strict-visible">strictBeacon</p><div id="strict-shadow"></div><script src="/strict-style.js" defer></script>');
    } else if (req.url === '/strict-style.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end("document.querySelector('#strict-shadow').attachShadow({mode:'open'}).innerHTML='<p>strictBeacon</p>'; window.fixtureReady=true;");
    } else if (req.url === '/fixture.js') {
      res.setHeader('Content-Type', 'text/javascript'); res.end(script);
    } else if (req.url === '/fixture.css') {
      res.setHeader('Content-Type', 'text/css'); res.end('.hidden{display:none}iframe{width:320px;height:100px}body{font:16px sans-serif}');
    } else if (req.url === '/frame') {
      res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><p id="frame-text">frameBeacon</p>');
    } else if (req.url === '/frame-next') {
      res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><p id="frame-text">dynamicBeacon</p>');
    } else if (req.url === '/hidden-frame') {
      res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><p>hiddenBeacon</p>');
    } else if (req.url === '/opaque-frame') {
      res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><p>opaqueBeacon</p>');
    } else if (req.url === '/favicon.ico') {
      res.statusCode = 204; res.end();
    } else {
      res.setHeader('Content-Type', 'text/html'); res.end(markup);
    }
  });
  return new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveServer({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

export const test = base.extend({
  extension: [async ({}, use) => {
    await mkdir(join(project, '.tmp'), { recursive: true });
    const directory = await mkdtemp(join(project, '.tmp/browser-'));
    const extensionPath = join(directory, 'extension');
    await mkdir(extensionPath);
    const manifest = JSON.parse(await readFile(join(project, 'manifest.json'), 'utf8'));
    // Test-only host access lets the background action inject without a human
    // click granting activeTab. Production permissions are left untouched.
    manifest.host_permissions = ['http://127.0.0.1/*'];
    await writeFile(join(extensionPath, 'manifest.json'), JSON.stringify(manifest, null, 2));
    for (const name of ['background.js', 'content_script.js', 'search_worker.js', 'style.css',
      'options.html', 'options.js', 'options.css', 'offscreen.html', 'offscreen.js', 'domain', 'infra', 'icons', '_locales']) {
      await cp(join(project, name), join(extensionPath, name), { recursive: true });
    }
    if (process.env.RR_BROWSER_ENGINE_BASELINE_PATH) {
      await cp(process.env.RR_BROWSER_ENGINE_BASELINE_PATH, join(extensionPath, 'infra/highlight_engine.js'));
    }
    if (process.env.RR_BROWSER_PHASE_METRICS === '1') {
      const workerSource=await readFile(join(extensionPath,'search_worker.js'),'utf8');
      await writeFile(join(extensionPath,'search_worker.js'),workerSource+workerMetricsProbe);
    }
    const { server, url } = await startServer();
    let context;
    try {
      context = await chromium.launchPersistentContext(join(directory, 'profile'), {
        channel: 'chromium', headless: true,
        args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
      });
      const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
      await use({ context, worker, url });
    } finally {
      if (context) await context.close();
      await new Promise((done) => server.close(done));
      await rm(directory, { recursive: true, force: true });
    }
  }, { scope: 'worker' }],
  app: async ({ extension }, use) => {
    const { context, worker, url } = extension;
    await worker.evaluate(async () => {
      await chrome.storage.sync.clear();
      await chrome.storage.local.clear();
      await chrome.storage.sync.set({ autoSearchDebounce: 500, workerTimeoutMs: 10_000, uiLanguage:'zh-CN', characterBudgetVersion:1 });
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(() => window.fixtureReady === true);
    await expect(page.locator('#same-frame')).toBeVisible();
    await expect.poll(() => page.frames().length).toBe(4);
    const tabId = await worker.evaluate(async (pageUrl) => {
      const tabs = await chrome.tabs.query({ url: pageUrl + '/*' });
      const tab = tabs.find((item) => item.url === pageUrl + '/');
      if (!tab) throw new Error('Fixture tab missing');
      return tab.id;
    }, url);
    const toggle = () => worker.evaluate(async (id) => {
      if (!await injectScripts(id)) throw new Error('Extension injection failed');
      await sendToggle(id);
    }, tabId);
    await toggle();
    await expect(page.locator('#regex-search-container')).toBeVisible();
    await page.bringToFront();
    await use({ page, worker, tabId, toggle, pageErrors, url });
    await page.close();
  },
});

export { expect, startServer as startFixtureServer };

export async function search(page, query, expectedTotal) {
  await page.locator('#regex-search-input').fill(query);
  await page.locator('#regex-search-input').press('Enter');
  if (expectedTotal !== undefined) await expectTotal(page, expectedTotal);
}

export async function expectTotal(page, total) {
  // Failed locator polls serialize the entire page's ARIA tree. Read only the
  // count while waiting, then verify the actual primitive after completion.
  await page.waitForFunction(total=>{
    const toolbar=document.querySelector('#regex-search-container'),count=document.querySelector('#regex-search-count');
    if(!toolbar||!count||toolbar.getAttribute('aria-busy')!=='false')return false;
    return total?new RegExp('^\\d+/'+total+'$').test(count.textContent):count.textContent==='0';
  },total,{timeout:10000});
  const value=await page.locator('#regex-search-count').textContent();
  if(total)expect(value).toMatch(new RegExp(`^\\d+/${total}$`));else expect(value).toBe('0');
}

export async function highlightSnapshot(page) {
  return page.evaluate(() => {
    const own = Array.from(CSS.highlights.entries()).filter(([name]) => name.startsWith('rr-find-'));
    return own.map(([name, values]) => ({ name, texts: Array.from(values, (range) => range.toString()) }));
  });
}

export async function allHighlightSnapshots(page) {
  return page.evaluate(() => {
    const snapshots=[], documents=[document], seen=new Set();
    while (documents.length) {
      const current=documents.pop();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      if (!current.defaultView) continue;
      for (const [name,ranges] of current.defaultView.CSS.highlights) {
        if (name.startsWith('rr-find-')) snapshots.push({url:current.URL,name,texts:Array.from(ranges,range=>range.toString())});
      }
      for (const frame of current.querySelectorAll('iframe,frame')) {
        try {if (frame.contentDocument) documents.push(frame.contentDocument);} catch (_) {}
      }
    }
    return snapshots;
  });
}

export async function isolated(app, source, argument) {
  // DevTools evaluates this test-authored function in the service worker. The
  // injected function itself does not call eval or relax any production CSP.
  return app.worker.evaluate(`(async () => {
    const result = await chrome.scripting.executeScript({ target: { tabId: ${JSON.stringify(app.tabId)} }, world: 'ISOLATED',
      func: ${source}, args: [${JSON.stringify(argument ?? null)}] });
    return result[0].result;
  })()`);
}


export async function openAdvanced(page) {
  const toggle=page.locator('#regex-advanced-toggle');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await expect(page.locator('#regex-advanced-panel')).toBeVisible();
}

export async function chooseScope(page, scope) {
  const button=page.locator(`#regex-scope-${scope}`);
  if (!await button.isVisible()) await openAdvanced(page);
  await button.click();
  await expect(button).toHaveAttribute('aria-checked','true');
}

export async function chooseMode(page, mode) {
  const button=page.locator(`#regex-mode-${mode}`);
  const quick=page.locator('#regex-mode-toggle');
  if (await quick.isVisible()) {
    if (await quick.getAttribute('aria-pressed') !== String(mode==='regex')) await quick.click();
  } else {
    if (!await button.isVisible()) await openAdvanced(page);
    await button.click();
  }
  await expect(button).toHaveAttribute('aria-checked','true');
}

export async function clickSearchOption(page, id) {
  let button=page.locator(`#${id}`);
  if (!await button.isVisible()) await openAdvanced(page);
  if (id==='regex-case-toggle'&&!await button.isVisible()) button=page.locator('#regex-case-menu-toggle');
  await button.click();
}

export async function locateCurrent(page) {
  await page.locator('#regex-locate-button').click();
  await page.locator('#regex-jump-input').press('Enter');
}

export async function openFixtureDocument(extension, path='/position-new-document') {
  const {context,worker,url}=extension;
  const page=await context.newPage();
  await page.setViewportSize({width:1280,height:900});
  await page.goto(url+path);
  await page.waitForFunction(()=>window.fixtureReady===true);
  const tabId=await worker.evaluate(async pageUrl=>{
    const tabs=await chrome.tabs.query({url:pageUrl});
    if(!tabs[0])throw new Error('New fixture tab missing');return tabs[0].id;
  },page.url());
  const toggle=()=>worker.evaluate(async id=>{
    if(!await injectScripts(id))throw new Error('Extension injection failed');await sendToggle(id);
  },tabId);
  await toggle();
  await expect(page.locator('#regex-search-container')).toBeVisible();
  await page.bringToFront();
  return {page,tabId,toggle};
}
