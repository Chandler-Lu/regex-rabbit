(function () {
  "use strict";
  if (window.__regexRabbitLoaded) return;
  window.__regexRabbitLoaded = true;

  var container, input, caseBtn, autoBtn, countEl, prevBtn, nextBtn, closeBtn;
  var marks = [], currentIndex = -1, highlightHandles = null;
  var indexedNodes = [], matchResults = [];
  var debounceTimer = null, isVisible = false, isCaseSensitive = false;
  var autoSearchEnabled = false, autoSearchTimer = null, mutationObserver = null;
  var searchGen = 0, activeWorkerTaskId = 0;
  var scrollRetryTimer = null, scrollFrameId = null, scrollSeq = 0;

  // ── Config (synced from options page via chrome.storage.sync) ──
  var cfg = { scale: 1.0, maxMatches: 1000, highlightColor: "#ffe082", currentColor: "#ff6d00", autoSearchDebounce: 1500 };

  // ── UI ──────────────────────────────────────────────────────
  function createUI() {
    container = document.createElement("div");
    container.id = "regex-search-container";
    container.style.display = "none";

    input = document.createElement("input");
    input.id = "regex-search-input";
    input.type = "text";
    input.placeholder = "Search regex…";
    input.spellcheck = false;
    input.addEventListener("input", onInput);
    input.addEventListener("keydown", onKeyDown);

    caseBtn = document.createElement("button");
    caseBtn.id = "regex-case-toggle";
    caseBtn.textContent = "Aa";
    caseBtn.title = "Match Case (Off)";
    caseBtn.addEventListener("click", toggleCase);

    autoBtn = document.createElement("button");
    autoBtn.id = "regex-auto-toggle";
    autoBtn.textContent = "Auto";
    autoBtn.title = "Auto Search (Off)";
    autoBtn.addEventListener("click", toggleAutoSearch);

    countEl = document.createElement("span");
    countEl.id = "regex-search-count";

    var sep = document.createElement("span");
    sep.id = "regex-search-separator";

    var nav = document.createElement("span");
    nav.id = "regex-nav-button-wrapper";

    prevBtn = document.createElement("button");
    prevBtn.id = "regex-prev-button";
    prevBtn.className = "regex-search-button icon-button";
    prevBtn.title = "Previous (Shift+Enter)";
    prevBtn.disabled = true;
    prevBtn.addEventListener("click", function () { navigate(-1); });

    nextBtn = document.createElement("button");
    nextBtn.id = "regex-next-button";
    nextBtn.className = "regex-search-button icon-button";
    nextBtn.title = "Next (Enter)";
    nextBtn.disabled = true;
    nextBtn.addEventListener("click", function () { navigate(1); });

    nav.appendChild(prevBtn); nav.appendChild(nextBtn);

    closeBtn = document.createElement("button");
    closeBtn.id = "regex-close-button";
    closeBtn.className = "regex-search-button icon-button";
    closeBtn.title = "Close (Esc)";
    closeBtn.addEventListener("click", hide);

    container.appendChild(input);
    container.appendChild(caseBtn);
    container.appendChild(autoBtn);
    container.appendChild(countEl);
    container.appendChild(sep);
    container.appendChild(nav);
    container.appendChild(closeBtn);

    (document.body || document.documentElement).appendChild(container);
    applyScale();
    applyHighlightColors();
  }

  function applyScale() {
    if (container) container.style.zoom = cfg.scale;
  }

  function sanitizeColor(color) {
    if (typeof color !== "string") return null;
    if (/^#[0-9a-fA-F]{3,8}$/.test(color)) return color;
    if (/^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/.test(color)) return color;
    if (/^rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(0|1|0?\.\d+)\s*\)$/.test(color)) return color;
    return null;
  }

  function applyHighlightColors() {
    var hl = sanitizeColor(cfg.highlightColor) || "#ffe082";
    var cur = sanitizeColor(cfg.currentColor) || "#ff6d00";
    var s = document.createElement("style");
    s.id = "rr-dynamic-colors";
    var old = document.getElementById("rr-dynamic-colors");
    if (old) old.remove();
    s.textContent =
      ".regex-search-highlight{background:" + hl + "!important}" +
      ".regex-search-highlight.current{background:" + cur + "!important}";
    document.head.appendChild(s);
  }

  // ── SPA resilience — detect container removal, recreate ──
  function watchContainer() {
    if (!container || !container.isConnected) {
      stopAutoSearch();
      removeHighlights();
      container = null; input = null; caseBtn = null; autoBtn = null;
      countEl = null; prevBtn = null; nextBtn = null; closeBtn = null;
      marks = []; matchResults = []; indexedNodes = []; currentIndex = -1; isVisible = false;
      createUI();
    }
  }

  function show() {
    watchContainer();
    if (!container) createUI();
    container.style.display = "flex";
    isVisible = true;
    requestAnimationFrame(function () {
      if (input) { input.focus(); input.select(); }
      updateCaseStyle();
      updateAutoStyle();
      updateNav();
    });
    document.addEventListener("keydown", onGlobalKey, true);
    if (autoSearchEnabled) startAutoSearch();
    if (input && input.value) performSearch(input.value);
  }

  function hide() {
    if (!container || !isVisible) return;
    container.style.display = "none";
    isVisible = false;
    stopAutoSearch();
    removeHighlights();
    if (input) input.blur();
    document.removeEventListener("keydown", onGlobalKey, true);
  }

  function onGlobalKey(e) {
    if (e.key === "Escape" && isVisible) {
      e.preventDefault(); e.stopPropagation();
      if (input && input.value) { input.value = ""; input.focus(); performSearch(""); }
      else hide();
    }
  }

  function toggleCase() {
    isCaseSensitive = !isCaseSensitive;
    updateCaseStyle();
    if (input && input.value) performSearch(input.value);
  }

  function updateCaseStyle() {
    if (!caseBtn) return;
    caseBtn.classList.toggle("active", isCaseSensitive);
    caseBtn.title = isCaseSensitive ? "Match Case (On)" : "Match Case (Off)";
  }

  function onInput() {
    clearTimeout(autoSearchTimer);
    autoSearchTimer = null;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      if (isVisible && input) performSearch(input.value);
    }, 200);
  }

  function onKeyDown(e) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (marks.length > 0) navigate(e.shiftKey ? -1 : 1);
    else if (input && input.value) performSearch(input.value);
  }

  // ── Search pipeline ─────────────────────────────────────────
  async function performSearch(pattern) {
    removeHighlights();
    if (!pattern) { updateCount(""); updateNav(); return; }
    var gen = ++searchGen;

    var flags = "gu" + (isCaseSensitive ? "" : "i");
    var regex;
    var policy = { ok: true, status: "safe" };

    if (globalThis.RRPatternAnalyzer) {
      policy = globalThis.RRPatternAnalyzer.analyze(pattern, flags);
      if (policy.status === "invalid") { showError("Invalid Regex"); return; }
      if (policy.status === "unsafe")  { showError("Unsafe Regex"); return; }
    }

    try {
      regex = new RegExp(pattern, flags);
      if (input) input.classList.remove("invalid");
    } catch (e) { showError("Invalid Regex"); return; }

    if (!document.body) { updateCount("0"); updateNav(); return; }
    updateCount("Searching");

    matchResults = [];
    marks = [];
    currentIndex = -1;

    if (canStreamToWorker()) {
      await searchWithWorkerStream(gen, pattern, flags, policy);
      return;
    }

    indexedNodes = await collectNodesAsync(gen);
    if (gen !== searchGen) return;

    if (indexedNodes.length === 0) { finishSearch(gen, { limited: false }); return; }

    if (globalThis.RRWorkerManager && typeof globalThis.RRWorkerManager.search === "function") {
      await searchWithWorker(gen, pattern, flags, indexedNodes, policy);
      return;
    }

    matchChunked(0, indexedNodes, regex, gen);
  }

  async function collectNodesAsync(gen) {
    if (globalThis.RRTextCollector && typeof globalThis.RRTextCollector.collectBatched === "function") {
      try {
        return await globalThis.RRTextCollector.collectBatched({
          batchSize: 500,
          budgetMs: 8,
          shouldContinue: function () { return gen === searchGen; }
        });
      } catch (e) {
        if (typeof console !== "undefined") console.debug("[RegexRabbit] TextCollector batched failed:", e.message);
      }
    }
    return collectNodes();
  }

  function canStreamToWorker() {
    return (
      globalThis.RRWorkerManager &&
      typeof globalThis.RRWorkerManager.searchStream === "function" &&
      globalThis.RRTextCollector &&
      typeof globalThis.RRTextCollector.collectBatched === "function"
    );
  }

  function collectNodes() {
    if (globalThis.RRTextCollector) {
      try { return globalThis.RRTextCollector.collect(); }
      catch (e) { if (typeof console !== "undefined") console.debug("[RegexRabbit] TextCollector failed:", e.message); }
    }
    // Inline fallback
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var p = node.parentElement;
        if (!p || p.closest('script,style,noscript,textarea,#regex-search-container,[contenteditable="true"]')) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var nodes = [], n, id = 0;
    while ((n = walker.nextNode())) nodes.push({ id: id++, node: n, text: n.nodeValue });
    return nodes;
  }

  async function searchWithWorker(gen, pattern, flags, nodes, policy) {
    try {
      activeWorkerTaskId = gen;
      updateWorkerConfig();
      var result = await globalThis.RRWorkerManager.search(gen, pattern, flags, nodes, policy);
      if (activeWorkerTaskId === gen) activeWorkerTaskId = 0;
      if (gen !== searchGen) return;
      matchResults = result.matches || [];
      await finishSearch(gen, result);
    } catch (e) {
      if (activeWorkerTaskId === gen) activeWorkerTaskId = 0;
      if (gen !== searchGen || (e && e.name === "AbortError")) return;
      if (typeof console !== "undefined") console.debug("[RegexRabbit] Worker search failed:", e && e.message ? e.message : e);
      matchChunked(0, nodes, new RegExp(pattern, flags), gen);
    }
  }

  async function searchWithWorkerStream(gen, pattern, flags, policy) {
    var streamedNodes = [];
    indexedNodes = streamedNodes;
    try {
      activeWorkerTaskId = gen;
      updateWorkerConfig();
      var result = await globalThis.RRWorkerManager.searchStream(
        gen,
        pattern,
        flags,
        async function (sendBatch, shouldContinue) {
          await globalThis.RRTextCollector.collectBatched({
            batchSize: 256,
            budgetMs: 8,
            storeNodes: false,
            shouldContinue: function () { return gen === searchGen && shouldContinue(); },
            onBatch: async function (batch) {
              if (gen !== searchGen || !shouldContinue()) return false;
              var sent = await sendBatch(batch);
              if (!sent) return false;
              for (var i = 0; i < sent; i++) streamedNodes.push(batch[i]);
              return sent === batch.length;
            }
          });
        },
        policy
      );
      if (activeWorkerTaskId === gen) activeWorkerTaskId = 0;
      if (gen !== searchGen) return;
      matchResults = result.matches || [];
      await finishSearch(gen, result);
    } catch (e) {
      if (activeWorkerTaskId === gen) activeWorkerTaskId = 0;
      if (gen !== searchGen || (e && e.name === "AbortError")) return;
      if (typeof console !== "undefined") console.debug("[RegexRabbit] Streaming worker search failed:", e && e.message ? e.message : e);
      indexedNodes = await collectNodesAsync(gen);
      if (gen !== searchGen) return;
      matchChunked(0, indexedNodes, new RegExp(pattern, flags), gen);
    }
  }

  function updateWorkerConfig() {
    if (!globalThis.RRWorkerManager.updateConfig) return;
    globalThis.RRWorkerManager.updateConfig({
      maxMatches: cfg.maxMatches,
      maxScannedChars: 256 * 1024 * 1024,
      maxChunkMs: 250,
      workerTimeoutMs: 30000,
      batchSize: 256,
      maxBatchChars: 1024 * 1024
    });
  }

  function showError(msg) {
    if (input) input.classList.add("invalid");
    updateCount(msg);
    updateNav();
  }

  function matchChunked(startIdx, nodes, regex, gen) {
    if (gen !== searchGen) return;
    var max = cfg.maxMatches;
    var startedAt = now();
    var i = startIdx;

    for (; i < nodes.length; i++) {
      if (matchResults.length >= max) return finishSearch(gen, { limited: true });
      matchNode(nodes[i], regex, max);
      if (i > startIdx && now() - startedAt >= 8) {
        i += 1;
        break;
      }
    }

    if (i < nodes.length) {
      setTimeout(function () { matchChunked(i, nodes, regex, gen); }, 0);
    } else {
      finishSearch(gen, { limited: false });
    }
  }

  function matchNode(info, regex, max) {
    if (matchResults.length >= max) return;
    var text = info.text;
    var parent = info.node.parentNode;
    if (!parent || !parent.isConnected) return;

    regex.lastIndex = 0;
    var m;
    while ((m = regex.exec(text)) !== null && matchResults.length < max) {
      if (m[0].length > 0) {
        matchResults.push({ chunkId: info.id, start: m.index, end: m.index + m[0].length });
      }
      if (m[0].length === 0) {
        if (regex.lastIndex === m.index) regex.lastIndex += 1;
        if (regex.lastIndex >= text.length) break;
      }
    }
  }

  async function finishSearch(gen, result) {
    if (gen !== searchGen) return;
    if (matchResults.length > 0) {
      await renderResults(gen);
    }
    if (gen !== searchGen) return;
    updateCount(formatCount(marks.length, result && result.limited));
    updateNav();
  }

  async function renderResults(gen) {
    var resumeObserver = pauseAutoSearchObserver();
    try {
      if (globalThis.RRHighlightEngine) {
        try {
          var result;
          if (typeof globalThis.RRHighlightEngine.renderMatchesBatched === "function" && matchResults.length > 100) {
            result = await globalThis.RRHighlightEngine.renderMatchesBatched(indexedNodes, matchResults, {
              batchSize: 50,
              budgetMs: 8,
              shouldContinue: function () { return gen === searchGen; }
            });
          } else {
            result = globalThis.RRHighlightEngine.renderMatches(indexedNodes, matchResults);
          }
          if (result && result.cancelled) return;
          if (gen !== searchGen) {
            if (result && result.handles) globalThis.RRHighlightEngine.removeHighlights(result.handles);
            return;
          }
          marks = result.marks || [];
          highlightHandles = result.handles || null;
          if (marks.length > 0) { currentIndex = 0; highlightCurrent({ scroll: true, gen: gen, reason: "initial" }); }
          return;
        } catch (e) { if (typeof console !== "undefined") console.debug("[RegexRabbit] HighlightEngine failed:", e.message); }
      }
      // Inline fallback rendering
      marks = [];
      for (var i = 0; i < matchResults.length; i++) {
        var mr = matchResults[i];
        var info = findNodeById(mr.chunkId);
        if (!info) continue;
        inlineRenderMatch(info, mr);
      }
      if (marks.length > 0) { currentIndex = 0; highlightCurrent({ scroll: true, gen: gen, reason: "initial" }); }
    } finally {
      resumeAutoSearchObserver(resumeObserver);
    }
  }

  function findNodeById(id) {
    for (var i = 0; i < indexedNodes.length; i++) {
      if (indexedNodes[i].id === id) return indexedNodes[i];
    }
    return null;
  }

  function inlineRenderMatch(info, mr) {
    var text = info.text;
    var tn = info.node;
    var parent = tn.parentNode;
    if (!parent || !parent.isConnected) return;

    var frag = document.createDocumentFragment();
    if (mr.start > 0) frag.appendChild(document.createTextNode(text.substring(0, mr.start)));
    var mark = document.createElement("mark");
    mark.className = "regex-search-highlight";
    mark.textContent = typeof mr.text === "string" ? mr.text : text.substring(mr.start, mr.end);
    frag.appendChild(mark);
    marks.push(mark);
    if (mr.end < text.length) frag.appendChild(document.createTextNode(text.substring(mr.end)));
    try { parent.replaceChild(frag, tn); } catch (e) { if (typeof console !== "undefined") console.debug("[RegexRabbit] inlineRender replaceChild failed:", e.message); }
  }

  function formatCount(total, limited) {
    var suffix = limited ? "+" : "";
    if (total > 0) return (currentIndex >= 0 ? currentIndex + 1 : 0) + "/" + total + suffix;
    return "0";
  }

  function removeHighlights() {
    searchGen += 1;
    cancelActiveWorker();
    cancelPendingScroll();
    var resumeObserver = pauseAutoSearchObserver();
    try {
      if (globalThis.RRHighlightEngine && highlightHandles) {
        try {
          globalThis.RRHighlightEngine.removeHighlights(highlightHandles);
        } catch (e) { if (typeof console !== "undefined") console.debug("[RegexRabbit] removeHighlights failed:", e.message); }
        highlightHandles = null;
      } else {
        // Inline fallback cleanup
        for (var i = marks.length - 1; i >= 0; i--) {
          var m = marks[i], p = m && m.parentNode;
          if (m && m.isConnected && p) {
            try { p.replaceChild(document.createTextNode(m.textContent), m); p.normalize(); } catch (e) { if (typeof console !== "undefined") console.debug("[RegexRabbit] removeHighlight replaceChild failed:", e.message); }
          }
        }
      }
    } finally {
      resumeAutoSearchObserver(resumeObserver);
    }
    marks = []; matchResults = []; indexedNodes = []; currentIndex = -1;
    if (input) input.classList.remove("invalid");
    updateCount(""); updateNav();
  }

  function cancelActiveWorker() {
    if (!activeWorkerTaskId || !globalThis.RRWorkerManager || !globalThis.RRWorkerManager.cancel) return;
    try { globalThis.RRWorkerManager.cancel(activeWorkerTaskId); } catch (e) {}
    activeWorkerTaskId = 0;
  }

  function pauseAutoSearchObserver() {
    if (!mutationObserver) return false;
    mutationObserver.disconnect();
    mutationObserver = null;
    return true;
  }

  function resumeAutoSearchObserver(shouldResume) {
    if (shouldResume && autoSearchEnabled && isVisible) startAutoSearch();
  }

  function navigate(dir) {
    if (marks.length <= 1) return;
    if (currentIndex >= 0 && currentIndex < marks.length) {
      var pm = marks[currentIndex];
      if (pm && pm.isConnected) pm.classList.remove("current");
    }
    currentIndex += dir;
    if (currentIndex < 0) currentIndex = marks.length - 1;
    else if (currentIndex >= marks.length) currentIndex = 0;
    highlightCurrent({ scroll: true, gen: searchGen, reason: "navigation" });
    updateCount((currentIndex + 1) + "/" + marks.length);
  }

  function highlightCurrent(options) {
    if (currentIndex < 0 || currentIndex >= marks.length) return;
    var m = marks[currentIndex];
    if (m && m.isConnected) {
      clearCurrentMarks(m);
      m.classList.add("current");
      if (!options || options.scroll !== false) {
        scheduleScrollToMark(m, options || {});
      }
    }
  }

  function clearCurrentMarks(activeMark) {
    for (var i = 0; i < marks.length; i++) {
      var mark = marks[i];
      if (mark && mark !== activeMark && mark.isConnected) mark.classList.remove("current");
    }
  }

  function scheduleScrollToMark(mark, options) {
    if (!mark || !mark.isConnected) return;
    cancelPendingScroll();
    var seq = ++scrollSeq;
    var gen = typeof options.gen === "number" ? options.gen : searchGen;
    var attempts = options.reason === "initial" ? 4 : 2;

    runAfterFrame(function () {
      scrollMarkIntoView(mark, gen, seq);
      retryScrollIfNeeded(mark, gen, seq, attempts - 1, 90);
    });
  }

  function retryScrollIfNeeded(mark, gen, seq, remaining, delay) {
    if (remaining <= 0) return;
    scrollRetryTimer = setTimeout(function () {
      scrollRetryTimer = null;
      if (!isScrollRequestCurrent(mark, gen, seq)) return;
      if (!isMostlyInViewport(mark)) scrollMarkIntoView(mark, gen, seq);
      retryScrollIfNeeded(mark, gen, seq, remaining - 1, Math.min(delay * 2, 360));
    }, delay);
  }

  function scrollMarkIntoView(mark, gen, seq) {
    if (!isScrollRequestCurrent(mark, gen, seq)) return;
    try {
      mark.scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" });
    } catch (e) {
      try { mark.scrollIntoView(true); } catch (ignored) {}
    }
  }

  function isScrollRequestCurrent(mark, gen, seq) {
    return seq === scrollSeq && gen === searchGen && mark && mark.isConnected;
  }

  function isMostlyInViewport(mark) {
    if (!mark || !mark.isConnected || typeof mark.getBoundingClientRect !== "function") return true;
    var rect = mark.getBoundingClientRect();
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;
    var vw = window.innerWidth || document.documentElement.clientWidth || 0;
    if (vh <= 0 || vw <= 0) return true;
    return rect.bottom >= 0 && rect.top <= vh && rect.right >= 0 && rect.left <= vw;
  }

  function runAfterFrame(fn) {
    if (typeof requestAnimationFrame === "function") {
      scrollFrameId = requestAnimationFrame(function () {
        scrollFrameId = null;
        fn();
      });
    } else {
      scrollRetryTimer = setTimeout(function () {
        scrollRetryTimer = null;
        fn();
      }, 0);
    }
  }

  function cancelPendingScroll() {
    scrollSeq += 1;
    if (scrollRetryTimer !== null) {
      clearTimeout(scrollRetryTimer);
      scrollRetryTimer = null;
    }
    if (scrollFrameId !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(scrollFrameId);
      scrollFrameId = null;
    }
  }

  function updateCount(text) { if (countEl) countEl.textContent = text; }
  function now() {
    if (typeof performance !== "undefined" && performance.now) return performance.now();
    return Date.now();
  }
  function updateNav() {
    var e = marks.length > 1;
    if (prevBtn) prevBtn.disabled = !e;
    if (nextBtn) nextBtn.disabled = !e;
  }

  // ── Auto-search ────────────────────────────────────────────
  function toggleAutoSearch() {
    autoSearchEnabled = !autoSearchEnabled;
    updateAutoStyle();
    if (autoSearchEnabled) {
      if (isVisible) startAutoSearch();
    } else {
      stopAutoSearch();
    }
  }

  function updateAutoStyle() {
    if (!autoBtn) return;
    autoBtn.classList.toggle("active", autoSearchEnabled);
    autoBtn.title = autoSearchEnabled ? "Auto Search (On)" : "Auto Search (Off)";
  }

  function startAutoSearch() {
    if (mutationObserver) return;
    if (!document.body) return;
    try {
      mutationObserver = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var target = mutations[i].target;
          if (target === container || (container && container.contains(target))) continue;
          scheduleAutoSearch();
          return;
        }
      });
      mutationObserver.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: false });
    } catch (e) {
      if (typeof console !== "undefined") console.debug("[RegexRabbit] MutationObserver failed:", e.message);
      mutationObserver = null;
    }
  }

  function stopAutoSearch() {
    if (mutationObserver) { mutationObserver.disconnect(); mutationObserver = null; }
    clearTimeout(autoSearchTimer);
    autoSearchTimer = null;
  }

  function scheduleAutoSearch() {
    clearTimeout(autoSearchTimer);
    if (!input || !input.value) return;
    var debounce = (typeof cfg.autoSearchDebounce === "number" && cfg.autoSearchDebounce >= 500) ? cfg.autoSearchDebounce : 1500;
    autoSearchTimer = setTimeout(function () {
      autoSearchTimer = null;
      if (isVisible && input && input.value) performSearch(input.value);
    }, debounce);
  }

  // ── Config loading ───────────────────────────────────────────
  function loadConfig() {
    chrome.storage.sync.get({ scale: 1.0, maxMatches: 1000, highlightColor: "#ffe082", currentColor: "#ff6d00", caseSensitive: false, autoSearchDebounce: 1500 }, function (items) {
      cfg.scale = items.scale;
      cfg.maxMatches = items.maxMatches;
      cfg.highlightColor = items.highlightColor;
      cfg.currentColor = items.currentColor;
      cfg.autoSearchDebounce = items.autoSearchDebounce;
      isCaseSensitive = items.caseSensitive;
      applyScale();
      applyHighlightColors();
      updateCaseStyle();
    });
  }

  loadConfig();
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === "sync") loadConfig();
  });

  // ── Message listener ─────────────────────────────────────────
  chrome.runtime.onMessage.addListener(function (msg, _, sendResponse) {
    if (msg.action === "toggleSearch") {
      watchContainer();
      if (!container) createUI();
      if (!isVisible) { show(); sendResponse({ status: "shown" }); }
      else { hide(); sendResponse({ status: "hidden" }); }
      return true;
    }
    return false;
  });
})();
