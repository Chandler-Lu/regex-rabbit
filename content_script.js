(function () {
  "use strict";
  var POLICY = globalThis.RRRuntimePolicy;
  var INPUT_DEBOUNCE_MS = 200;
  var COMPOSITION_KEY_CODE = 229;
  var AUTO_REFRESH_MAX_WAIT_MS = 3000;
  var AUTO_REFRESH_WAIT_MULTIPLIER = 3;
  var RECOVERY_QUIET_PERIOD_MS = 10000;
  var INITIAL_RECOVERY_DELAY_MS = 50;
  var MAX_RECOVERY_DELAY_MS = 2000;
  if (window.__regexRabbitLoaded) return;
  window.__regexRabbitLoaded = true;

  var container, input, caseBtn, autoBtn, countEl, prevBtn, nextBtn, closeBtn;
  var modeBtn, wordBtn, multilineBtn, dotAllBtn, scopeEl, toolbar, toolbarPosition;
  function t(key, params) { return globalThis.RRi18n.t(key, params); }
  var marks = [], currentIndex = -1;
  var debounceTimer = null, isVisible = false, isCaseSensitive = false;
  var autoSearchEnabled = false, observer = null, rerunPending = false;
  var searchGen = 0, resultLimited = false, lastSelection = null, composing = false;
  var recoveryDelay = 0, lastRecovery = 0, recoveryTimer = null, autoRerunTimer = null, autoAnchor = null;
  var scrollFrameId = null, scrollTaskTimer = null, scrollSeq = 0;
  var cfg = globalThis.RRRuntimeConfig.normalize({});
  var uiRequest = 0, pageSuspended = false, configRequest = 0, storedConfig = null;
  var initialOptionEdits = new Set();
  var previousFocus = null;
  var pendingLocation = false;
  var pendingNavigation = null;
  var pendingJump = null, jumpUnavailable = false;
  var pendingExplicitScroll = null;
  var needsVisibleRefresh = false;
  var configReadyResolve;
  var configReady = new Promise(function (resolve) { configReadyResolve = resolve; });
  var selectionTracker = globalThis.RRSelectionCapture && globalThis.RRSelectionCapture.createTracker({
    getExcluded: function () { return container; },
    onInteraction: cancelOnPageInteraction,
    onSelection: function (selected, event) {
      // Result navigation selects control text too. Keep the user's original
      // control scope unless a pointer or keyboard action selected a new range.
      if (selected.kind === "control-selection" && lastSelection && lastSelection.kind === "control-selection" &&
          selected.node === lastSelection.node && scopeEl && scopeEl.value === "selection" &&
          event.type !== "pointerup" && event.type !== "keyup") return;
      lastSelection = selected;
    }
  });
  var controller = globalThis.RRSearchController.create({
    getConfig: function () { return Object.assign({}, cfg, { caseSensitive: isCaseSensitive }); },
    onRoot: function (root) {
      if (isVisible && selectionTracker) selectionTracker.addRoot(root);
      if (observer && autoSearchEnabled && isVisible) observer.addRoot ? observer.addRoot(root) : null;
    },
    onControlRead: function (node, observed) {
      if (observer && autoSearchEnabled && isVisible && typeof observer.syncControl === "function") observer.syncControl(node, observed);
    },
    onState: onSearchState,
    onResults: function (results, meta) {
      var previousIndex = currentIndex;
      var jump = meta.reason === "jump" && pendingJump && pendingJump.request === uiRequest ? pendingJump : null;
      var explicitScroll = meta.reason !== "clear" && pendingExplicitScroll && pendingExplicitScroll.request === uiRequest;
      if (meta.reason !== "clear") { pendingJump = null; pendingExplicitScroll = null; }
      var passive = !explicitScroll;
      var queued = meta.reason !== "clear" && pendingNavigation && pendingNavigation.request === uiRequest ? pendingNavigation : null;
      pendingNavigation = null;
      marks = results;
      resultLimited = !!meta.limited;
      searchGen = controller.getGeneration();
      var retainPosition = meta.reason !== "manual" && meta.reason !== "typing" && meta.reason !== "jump";
      var retainedCurrent = false;
      jumpUnavailable = !!jump && jump.index >= marks.length;
      currentIndex = -1;
      if (marks.length) {
        currentIndex = 0;
        if (jump && !jumpUnavailable) currentIndex = jump.index;
        else if (retainPosition) {
          var previousPosition = autoAnchor ? autoAnchor.index : previousIndex;
          currentIndex = Math.min(Math.max(previousPosition, 0), marks.length - 1);
        }
      }
      if (retainPosition && autoAnchor) {
        var retained = marks.findIndex(function (mark) { return matchesAnchor(mark, autoAnchor); });
        if (retained >= 0) { currentIndex = retained; retainedCurrent = true; }
      }
      pendingLocation = (passive || jumpUnavailable) && marks.length > 0 && !(retainedCurrent && !autoAnchor.pendingLocation);
      if (queued && marks.length) {
        currentIndex = (currentIndex + queued.offset % marks.length + marks.length) % marks.length;
        pendingLocation = false;
      }
      if (marks.length) highlightCurrent({ scroll: !passive && !jumpUnavailable || !!queued, gen: searchGen, reason: "initial" });
      updateNav();
    }
  });

  // ── UI ──────────────────────────────────────────────────────
  function createUI() {
    if (toolbar) { toolbar.closeDetails(); toolbar.cancelJump(false); }
    toolbar = globalThis.RRSearchToolbar.create({
      onNavigate: navigate, onJump: jumpToMatch, onClose: hide, onCase: toggleCase, onAuto: toggleAutoSearch,
      onMode: function (mode) { if (cfg.mode !== mode) changeQueryOption("mode", mode); },
      onWord: function () { changeQueryOption("wholeWord", !cfg.wholeWord); },
      onMultiline: function () { changeQueryOption("multiline", !cfg.multiline); },
      onDotAll: function () { changeQueryOption("dotAll", !cfg.dotAll); },
      onSettings: function () {
        var requestedToolbar = toolbar;
        try {
          chrome.runtime.sendMessage({ action: "regexRabbitOpenOptions" }, function (response) {
            var failed = chrome.runtime.lastError || !response || !response.ok;
            if (failed && requestedToolbar === toolbar && isVisible) toolbar.setStatus(t("status.settingsFailed"), t("status.settingsHint"), "warning");
          });
        } catch (_) { toolbar.setStatus(t("status.settingsFailed"), t("status.settingsHint"), "warning"); }
      }
    });
    container = toolbar.container; input = toolbar.input; caseBtn = toolbar.caseBtn; autoBtn = toolbar.autoBtn;
    countEl = toolbar.countEl; prevBtn = toolbar.prevBtn; nextBtn = toolbar.nextBtn; closeBtn = toolbar.closeBtn;
    modeBtn = toolbar.modeBtn; wordBtn = toolbar.wordBtn; multilineBtn = toolbar.multilineBtn;
    dotAllBtn = toolbar.dotAllBtn; scopeEl = toolbar.scopeEl;
    input.addEventListener("compositionstart", function () { composing = true; clearTimeout(debounceTimer); });
    input.addEventListener("compositionend", function () { composing = false; onInput(); });
    input.addEventListener("input", onInput); input.addEventListener("keydown", onKeyDown);
    scopeEl.addEventListener("change", function () {
      updateQueryStyle();
      if (input && input.value) performSearch(input.value, "scope"); else toolbar.idle();
    });
    (document.body || document.documentElement).appendChild(container);
    if (toolbarPosition) toolbarPosition.attach(container, toolbar.dragHandle);
    else toolbarPosition = globalThis.RRToolbarPosition.create({ container: container, handle: toolbar.dragHandle,
      onMove: function () { if (toolbar) toolbar.reposition(); },
      onDragStart: function () { cancelPendingScroll(); pendingNavigation = null; pendingJump = null; pendingExplicitScroll = null; if (toolbar) { toolbar.closeDetails(); toolbar.cancelJump(false); } }
    });
    applyScale(); applyHighlightColors(); updateQueryStyle(); toolbar.idle();
  }

  function applyScale() {
    if (container) container.style.setProperty("--regex-rabbit-scale", String(cfg.scale), "important");
    if (toolbarPosition) toolbarPosition.setConfig(cfg);
  }

  function applyHighlightColors() {
    if (globalThis.RRHighlightEngine.configure) globalThis.RRHighlightEngine.configure(cfg);
  }

  function updateQueryStyle() {
    if (toolbar) {
      toolbar.updateOptions(cfg, isCaseSensitive, autoSearchEnabled);
      if (!input.value) toolbar.idle();
    }
  }

  function refreshQueryOptions() {
    updateQueryStyle();
    if (input && input.value) performSearch(input.value, "options");
  }
  function changeQueryOption(key, value) {
    cfg[key] = value;
    if (!storedConfig) initialOptionEdits.add(key);
    refreshQueryOptions();
  }

  function rememberSelection() {
    if (globalThis.RRSelectionCapture) {
      var captured = globalThis.RRSelectionCapture.capture({ exclude: container });
      if (captured) lastSelection = captured;
      return;
    }
    var selected = window.getSelection();
    if (!selected || selected.rangeCount === 0 || selected.isCollapsed) return;
    var range = selected.getRangeAt(0);
    if (container && container.contains(range.commonAncestorContainer)) return;
    lastSelection = range.cloneRange();
  }

  // ── SPA resilience — detect container removal, recreate ──
  function watchContainer() {
    if (!container || !container.isConnected) {
      stopAutoSearch();
      if (selectionTracker) selectionTracker.stop();
      removeHighlights();
      container = null; input = null; caseBtn = null; autoBtn = null;
      composing = false;
      countEl = null; prevBtn = null; nextBtn = null; closeBtn = null;
      marks = []; currentIndex = -1; isVisible = false;
      createUI();
    }
  }

  function show(recovered) {
    clearTimeout(recoveryTimer); recoveryTimer = null;
    if (!recovered) { recoveryDelay = 0; lastRecovery = 0; }
    rememberSelection();
    if (!recovered) previousFocus = lastSelection && lastSelection.kind === "control-selection" ? lastSelection.node : document.activeElement;
    watchContainer();
    if (!container) createUI();
    container.style.display = "flex";
    container.setAttribute("data-regex-rabbit-visible", "true");
    isVisible = true;
    if (toolbarPosition && !document.hidden && !pageSuspended) toolbarPosition.show();
    requestAnimationFrame(function () {
      if (!isVisible || pageSuspended || !container || !container.isConnected) return;
      if (input && !recovered) { input.focus(); input.select(); }
      updateCaseStyle();
      updateAutoStyle();
      updateNav();
    });
    document.addEventListener("keydown", onGlobalKey, true);
    if (!selectionTracker) document.addEventListener("selectionchange", rememberSelection);
    if (selectionTracker) selectionTracker.start(controller.getState().roots);
    if (autoSearchEnabled) startAutoSearch();
    if (input && input.value) performSearch(input.value, "restore");
  }

  function hide() {
    if (!container || !isVisible && recoveryTimer === null) return;
    var restoreFocus = container.contains(document.activeElement);
    if (toolbarPosition) toolbarPosition.hide();
    if (toolbar) toolbar.cancelJump(false);
    container.style.display = "none";
    container.removeAttribute("data-regex-rabbit-visible");
    isVisible = false;
    composing = false;
    needsVisibleRefresh = false;
    if (toolbar) toolbar.closeDetails();
    stopAutoSearch();
    clearTimeout(recoveryTimer); recoveryTimer = null;
    clearTimeout(debounceTimer);
    removeHighlights();
    document.removeEventListener("selectionchange", rememberSelection);
    if (selectionTracker) selectionTracker.stop();
    lastSelection = null; autoAnchor = null;
    if (input) input.blur();
    if (restoreFocus && previousFocus && previousFocus.isConnected && !container.contains(previousFocus) &&
        globalThis.RRPageVisibility.isDocumentAttached(previousFocus.ownerDocument)) {
      try { previousFocus.focus({ preventScroll: true }); } catch (_) {}
    }
    previousFocus = null;
    document.removeEventListener("keydown", onGlobalKey, true);
  }

  function onGlobalKey(e) {
    if (e.key === "Escape" && recoveryTimer !== null && !e.isComposing && !composing && e.keyCode !== COMPOSITION_KEY_CODE) {
      e.preventDefault(); e.stopPropagation(); hide(); return;
    }
    if (e.key === "Escape" && isVisible && !e.isComposing && !composing && e.keyCode !== COMPOSITION_KEY_CODE) {
      e.preventDefault(); e.stopPropagation();
      if (toolbar && toolbar.isJumpOpen()) { toolbar.cancelJump(true); return; }
      if (toolbar && toolbar.isDetailsOpen()) { toolbar.closeDetails(true); return; }
      if (input && input.value) { input.value = ""; input.focus(); performSearch(""); }
      else hide();
    }
  }

  function toggleCase() {
    isCaseSensitive = !isCaseSensitive;
    if (!storedConfig) initialOptionEdits.add("caseSensitive");
    updateCaseStyle();
    if (input && input.value) performSearch(input.value, "options");
  }

  function updateCaseStyle() { updateQueryStyle(); }

  function onInput() {
    rerunPending = false;
    clearTimeout(autoRerunTimer); autoRerunTimer = null;
    clearTimeout(debounceTimer);
    removeHighlights();
    if (composing) return;
    debounceTimer = setTimeout(function () {
      debounceTimer = null;
      if (isVisible && input) performSearch(input.value, "typing");
    }, INPUT_DEBOUNCE_MS);
  }

  function onKeyDown(e) {
    if (e.key !== "Enter" || e.isComposing || composing) return;
    e.preventDefault();
    clearTimeout(debounceTimer); debounceTimer = null;
    if (marks.length > 0) { if (pendingLocation && !e.shiftKey) locateCurrent(); else navigate(e.shiftKey ? -1 : 1); }
    else if (controller.isBusy() && autoAnchor) {
      if (!pendingNavigation) pendingNavigation = { request: uiRequest, offset: e.shiftKey ? -1 : autoAnchor.pendingLocation ? 0 : 1 };
      else pendingNavigation.offset = Math.max(-cfg.maxMatches, Math.min(cfg.maxMatches, pendingNavigation.offset + (e.shiftKey ? -1 : 1)));
    }
    else if (input && input.value) performSearch(input.value);
  }

  async function performSearch(pattern, reason, preferredIndex) {
    var request = ++uiRequest;
    pendingJump = reason === "jump" && Number.isSafeInteger(preferredIndex) && preferredIndex >= 0 ? { request: request, index: preferredIndex } : null;
    pendingExplicitScroll = !reason || reason === "manual" || reason === "navigation" || reason === "jump" ? { request: request } : null;
    jumpUnavailable = false;
    pendingNavigation = null;
    await configReady;
    if (request !== uiRequest || pageSuspended || composing || !isVisible || !input || input.value !== pattern) return;
    clearTimeout(debounceTimer); debounceTimer = null;
    if (document.hidden && pattern) { needsVisibleRefresh = true; return; }
    needsVisibleRefresh = false;
    clearTimeout(autoRerunTimer); autoRerunTimer = null;
    rerunPending = false;
    cancelPendingScroll();
    var anchorIndex = typeof preferredIndex === "number" ? preferredIndex : currentIndex;
    if (reason && reason !== "manual" && reason !== "jump") autoAnchor = anchorIndex >= 0 && marks[anchorIndex] ? matchAnchor(marks[anchorIndex], anchorIndex) : null;
    else autoAnchor = null;
    try {
      await controller.search(pattern, { reason: reason || "manual", scope: scopeEl ? scopeEl.value : "page", selection: scopeEl && scopeEl.value === "selection" ? lastSelection : null });
    } finally {
      if (request === uiRequest && !pageSuspended && rerunPending && isVisible && autoSearchEnabled && !controller.isBusy()) {
        rerunPending = false;
        clearTimeout(autoRerunTimer);
        autoRerunTimer = setTimeout(function () {
          autoRerunTimer = null;
          if (input && input.value && isVisible && autoSearchEnabled) performSearch(input.value, "auto");
        }, cfg.autoSearchDebounce);
      }
    }
  }

  function matchAnchor(mark, index) {
    var last = mark.ranges && mark.ranges.length ? mark.ranges[mark.ranges.length - 1] : mark.range;
    return { node: mark.range ? mark.range.startContainer : mark.node,
      start: mark.range ? mark.range.startOffset : mark.start,
      endNode: last ? last.endContainer : mark.node,
      end: last ? last.endOffset : mark.end,
      index: index, pendingLocation: pendingLocation };
  }

  function matchesAnchor(mark, anchor) {
    var first = mark.range, last = mark.ranges && mark.ranges.length ? mark.ranges[mark.ranges.length - 1] : first;
    return (first ? first.startContainer : mark.node) === anchor.node &&
      (first ? first.startOffset : mark.start) === anchor.start &&
      (last ? last.endContainer : mark.node) === anchor.endNode &&
      (last ? last.endOffset : mark.end) === anchor.end;
  }

  function onSearchState(state) {
    searchGen = controller.getGeneration();
    if (state.status !== "searching" && state.status !== "rendering") pendingNavigation = null;
    var patternError = state.status === "invalid" || state.status === "unsafe" || [POLICY.errors.invalidPattern, POLICY.errors.patternTooLarge, POLICY.errors.unsafePattern, POLICY.errors.unsafeEngine].indexOf(state.errorCode) !== -1;
    var selectionError = state.status === "error" && state.message === "Select page text first";
    if (input) { input.classList.toggle("invalid", patternError); input.setAttribute("aria-invalid", String(patternError)); }
    if (scopeEl) scopeEl.setAttribute("aria-invalid", String(selectionError));
    if (container) container.setAttribute("aria-busy", String(state.status === "searching" || state.status === "rendering"));
    if (state.status === "done" || state.status === "limited") {
      resultLimited = !!state.limited;
      updateCount(formatCount(state.renderedMatches, state.limited));
      var detail = [];
      if (state.inaccessibleFrames) detail.push(t("count.inaccessible", { count: globalThis.RRi18n.formatNumber(state.inaccessibleFrames) }));
      if (state.skippedMatches) detail.push(t("count.skipped", { count: globalThis.RRi18n.formatNumber(state.skippedMatches) }));
      if (state.scannedChars !== undefined) detail.push(t("count.scanned", { count: globalThis.RRi18n.formatNumber(state.scannedChars) }));
      if (countEl) countEl.title = detail.join("\n");
      var limitFeedback = globalThis.RRDisplayFormatter.limitFeedback(state, function (key, params) {
        if (params && key === "status.scanBudgetHint") {
          params = Object.assign({}, params);
          ["scanned", "limit"].forEach(function (name) {
            if (typeof params[name] === "number") params[name] = globalThis.RRi18n.formatNumber(params[name]);
          });
        }
        return t(key, params);
      });
      if (toolbar) toolbar.setStatus(state.limited ? limitFeedback.status : state.renderedMatches ? t("status.marked") : t("status.noMatches"),
        state.limited ? limitFeedback.detail : state.inaccessibleFrames ? t("count.inaccessibleHint", { count: globalThis.RRi18n.formatNumber(state.inaccessibleFrames) }) : "", state.limited ? "warning" : "neutral");
      if (toolbar && jumpUnavailable) toolbar.setStatus(t("status.jumpUnavailable"), state.renderedMatches ? t("toolbar.jumpRange", { total: state.renderedMatches }) : t("status.noMatches"), "warning");
      if (observer && autoSearchEnabled && isVisible) observer.updateRoots(state.roots);
      if (selectionTracker) selectionTracker.prune();
    } else {
      updateCount("");
      if (countEl) countEl.title = state.status === "idle" ? "" : t("status.failureHint");
      if (toolbar) {
        if (state.status === "idle") toolbar.idle();
        else if (selectionError) toolbar.setStatus(t("status.selectionRequired"), t("status.selectionHint"), "warning");
        else if (state.errorCode === POLICY.errors.patternTooLarge) toolbar.setStatus(t("status.queryEngineLimit"), t("status.queryEngineHint"), "error");
        else if (state.errorCode === POLICY.errors.textTooLarge) toolbar.setStatus(t("status.textEngineLimit"), t("status.textEngineHint"), "warning");
        else if (state.errorCode === POLICY.errors.invalidPattern) toolbar.setStatus(t("status.invalidPattern"), t("status.invalidHint"), "error");
        else if (state.status === "invalid") {
          var queryLimit = globalThis.RRPatternAnalyzer.MAX_PATTERN_LENGTH;
          var queryTooLong = state.message === "Query exceeds " + queryLimit + " characters";
          toolbar.setStatus(t(queryTooLong ? "status.queryTooLong" : "status.invalidPattern"),
            queryTooLong ? t("status.queryLimit", { limit: globalThis.RRi18n.formatNumber(queryLimit) }) : t("status.invalidHint"), "error");
        }
        else if (state.status === "unsafe" || state.errorCode === POLICY.errors.unsafePattern || state.errorCode === POLICY.errors.unsafeEngine) toolbar.setStatus(t("status.unsafePattern"), t("status.unsafeHint"), "error");
        else if (state.status === "timeout") toolbar.setStatus(t("status.timeout"), t("status.timeoutHint"), "warning");
        else if (state.status === "searching" || state.status === "rendering") toolbar.setStatus(state.status === "searching" ? t("status.searching") : t("status.rendering"), "", "neutral");
        else toolbar.setStatus(t("status.failed"), t("status.failureHint"), "error");
      }
    }
    updateNav();
  }

  function formatCount(total, limited) {
    if (total > 0) return (currentIndex >= 0 ? currentIndex + 1 : 0) + "/" + total + (limited ? "+" : "");
    return limited ? "0+" : "0";
  }

  function removeHighlights() {
    uiRequest++;
    pendingNavigation = null;
    pendingJump = null; jumpUnavailable = false; pendingExplicitScroll = null;
    cancelPendingScroll();
    controller.clear();
    searchGen = controller.getGeneration();
    marks = []; currentIndex = -1; resultLimited = false;
    if (container) container.setAttribute("aria-busy", "false");
    if (input) input.classList.remove("invalid");
    updateCount(""); updateNav();
    if (toolbar) toolbar.idle();
  }

  function navigate(dir) {
    if (!marks.length) return;
    if (toolbar && toolbar.isDetailsOpen()) { toolbar.closeDetails(); input.focus({ preventScroll: true }); }
    pendingLocation = false;
    if (toolbar) toolbar.confirmLocation();
    var candidate = (currentIndex + dir + marks.length) % marks.length;
    if (!highlightCurrent({ index: candidate, scroll: true, gen: searchGen })) {
      if (input && input.value) performSearch(input.value, "navigation", candidate);
      return;
    }
    updateCount(formatCount(marks.length, resultLimited));
  }

  function locateCurrent() {
    if (!marks.length) return;
    if (toolbar && toolbar.isDetailsOpen()) { toolbar.closeDetails(); input.focus({ preventScroll: true }); }
    if (!highlightCurrent({ scroll: true, gen: searchGen })) {
      if (input && input.value) performSearch(input.value, "navigation", currentIndex);
      return;
    }
    pendingLocation = false;
    if (toolbar) toolbar.confirmLocation();
  }

  function jumpToMatch(index) {
    if (!Number.isSafeInteger(index) || index < 1 || index > marks.length || controller.isBusy()) return false;
    var candidate = index - 1;
    if (toolbar) toolbar.closeDetails();
    input.focus({ preventScroll: true });
    if (!highlightCurrent({ index: candidate, scroll: true, gen: searchGen })) {
      if (input && input.value) performSearch(input.value, "jump", candidate);
      return true;
    }
    var wasUnavailable = jumpUnavailable;
    jumpUnavailable = false;
    pendingNavigation = null; pendingLocation = false;
    updateCount(formatCount(marks.length, resultLimited)); updateNav();
    if (wasUnavailable) onSearchState(controller.getState());
    return true;
  }

  function highlightCurrent(options) {
    options = options || {};
    var index = options.index === undefined ? currentIndex : options.index;
    if (index < 0 || index >= marks.length || !activateMark(marks[index])) return false;
    currentIndex = index;
    if (options.scroll !== false) scheduleScrollToMark(marks[index], options);
    return true;
  }

  function activateMark(activeMark) {
    if (!activeMark) return false;
    // The engine owns source/visibility validation and switching its previous
    // highlight. The coordinator only commits an index after activation works.
    if (globalThis.RRHighlightEngine.setCurrent) return globalThis.RRHighlightEngine.setCurrent(activeMark) !== false;
    if (!activeMark.isConnected) return false;
    for (var i = 0; i < marks.length; i++) {
      var mark = marks[i];
      if (mark && mark !== activeMark) mark.classList.remove("current");
    }
    activeMark.classList.add("current");
    return true;
  }

  function scheduleScrollToMark(mark, options) {
    cancelPendingScroll();
    var seq = ++scrollSeq;
    var gen = typeof options.gen === "number" ? options.gen : searchGen;
    runAfterFrame(function () {
      scrollMarkIntoView(mark, gen, seq);
    });
  }

  function scrollMarkIntoView(mark, gen, seq) {
    if (!isScrollRequestCurrent(mark, gen, seq)) return;
    try {
      var options = { behavior: "instant", block: "center", inline: "center",
        avoidRect: toolbar && isVisible ? toolbar.getAvoidRect() : null };
      // The animation frame is a new page turn: validate again inside navigate,
      // but do not repeat that full engine check via the descriptor getter.
      if (globalThis.RRHighlightEngine.navigate) globalThis.RRHighlightEngine.navigate(mark, options);
      else if (mark.isConnected) mark.scrollIntoView(options);
    } catch (e) {
      try { mark.scrollIntoView(true); } catch (ignored) {}
    }
  }

  function isScrollRequestCurrent(mark, gen, seq) {
    return seq === scrollSeq && gen === searchGen && isVisible && !pageSuspended && !!mark;
  }

  function runAfterFrame(fn) {
    if (typeof requestAnimationFrame === "function") {
      scrollFrameId = requestAnimationFrame(function () {
        scrollFrameId = null;
        fn();
      });
    } else {
      scrollTaskTimer = setTimeout(function () {
        scrollTaskTimer = null;
        fn();
      }, 0);
    }
  }

  function cancelPendingScroll() {
    scrollSeq += 1;
    if (scrollTaskTimer !== null) { clearTimeout(scrollTaskTimer); scrollTaskTimer = null; }
    if (scrollFrameId !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(scrollFrameId);
      scrollFrameId = null;
    }
  }

  function cancelOnPageInteraction(event) {
    if (!event || container && container.contains(event.target)) return;
    if (event.type === "keydown" && ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].indexOf(event.key) === -1) return;
    pendingNavigation = null;
    pendingJump = null;
    pendingExplicitScroll = null;
    if (toolbar && (event.type === "pointerdown" || event.type === "touchstart")) toolbar.closeDetails();
    cancelPendingScroll();
  }

  function updateCount(text) { if (countEl) countEl.textContent = text; if (toolbar) toolbar.syncCount(); }
  function updateNav() {
    var e = marks.length > 1;
    if (prevBtn) prevBtn.disabled = !e;
    if (nextBtn) nextBtn.disabled = !e;
    if (toolbar) toolbar.locateBtn.disabled = !marks.length;
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

  function updateAutoStyle() { updateQueryStyle(); }

  function startAutoSearch() {
    if (document.hidden || pageSuspended) return;
    if (!observer) {
      observer = globalThis.RRDynamicObserver.create({
        debounceMs: cfg.autoSearchDebounce, maxWaitMs: Math.max(AUTO_REFRESH_MAX_WAIT_MS, cfg.autoSearchDebounce * AUTO_REFRESH_WAIT_MULTIPLIER),
        getContainer: function () { return container; },
        onContainerRemoved: function () {
          if (!isVisible) return;
          var value = input ? input.value : "", area = scopeEl ? scopeEl.value : "page";
          var time = Date.now();
          if (time - lastRecovery >= RECOVERY_QUIET_PERIOD_MS) recoveryDelay = 0;
          var delay = recoveryDelay;
          lastRecovery = time;
          recoveryDelay = Math.min(MAX_RECOVERY_DELAY_MS, recoveryDelay ? recoveryDelay * 2 : INITIAL_RECOVERY_DELAY_MS);
          removeHighlights(); stopAutoSearch(); isVisible = false;
          if (selectionTracker) selectionTracker.stop();
          clearTimeout(recoveryTimer);
          recoveryTimer = setTimeout(function () {
            recoveryTimer = null;
            if (!autoSearchEnabled) return;
            container = null; createUI(); input.value = value; scopeEl.value = area; show(true);
          }, delay);
        },
        onChange: function () {
          if (!isVisible || !autoSearchEnabled || !input || !input.value || composing || debounceTimer) return;
          if (controller.isBusy()) { rerunPending = true; return; }
          performSearch(input.value, "auto");
        }
      });
    }
    observer.start(controller.getState().roots);
  }

  function stopAutoSearch() {
    if (observer) observer.stop();
    clearTimeout(autoRerunTimer); autoRerunTimer = null;
    rerunPending = false;
  }

  // ── Config loading ───────────────────────────────────────────
  function loadConfig(refreshSearch) {
    var request = ++configRequest;
    chrome.storage.sync.get(globalThis.RRRuntimeConfig.storageKeys, function (items) {
      if (request !== configRequest) return;
      if (chrome.runtime.lastError) { configReadyResolve(); return; }
      var loaded = globalThis.RRRuntimeConfig.migrateStored(items).values;
      var previousConfig = Object.assign({}, cfg, { caseSensitive: isCaseSensitive });
      if (!storedConfig) {
        Object.keys(loaded).forEach(function (key) { if (!initialOptionEdits.has(key)) cfg[key] = loaded[key]; });
        if (!initialOptionEdits.has("caseSensitive")) isCaseSensitive = cfg.caseSensitive;
        initialOptionEdits.clear();
      }
      else Object.keys(globalThis.RRRuntimeConfig.defaults).forEach(function (key) {
        if (loaded[key] !== storedConfig[key]) {
          cfg[key] = loaded[key];
          if (key === "caseSensitive") isCaseSensitive = loaded[key];
        }
      });
      storedConfig = loaded;
      var previousLanguage = globalThis.RRi18n.getLanguage();
      globalThis.RRi18n.setLanguage(cfg.uiLanguage);
      applyScale(); applyHighlightColors(); updateCaseStyle(); updateQueryStyle();
      if (toolbar) { toolbar.refreshLanguage(); if (previousLanguage !== globalThis.RRi18n.getLanguage()) onSearchState(controller.getState()); }
      if (observer) observer.setDebounce(cfg.autoSearchDebounce, Math.max(AUTO_REFRESH_MAX_WAIT_MS, cfg.autoSearchDebounce * AUTO_REFRESH_WAIT_MULTIPLIER));
      configReadyResolve();
      var matchingChanged = ["caseSensitive", "mode", "wholeWord", "multiline", "dotAll", "includeControls", "maxMatches", "workerTimeoutMs", "maxScannedChars"].some(function (key) {
        return previousConfig[key] !== (key === "caseSensitive" ? isCaseSensitive : cfg[key]);
      });
      if (refreshSearch && matchingChanged && isVisible && input && input.value) performSearch(input.value, "config");
    });
  }

  loadConfig();
  chrome.storage.onChanged.addListener(function (changes, area) {
    var keys = Object.keys(changes || {});
    if (area === "sync" && (!keys.length || keys.some(function (key) {
      return key === globalThis.RRRuntimeConfig.characterBudgetVersionKey || Object.prototype.hasOwnProperty.call(globalThis.RRRuntimeConfig.defaults, key);
    }))) loadConfig(true);
  });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      if (toolbarPosition) toolbarPosition.hide();
      pendingNavigation = null; pendingJump = null; pendingExplicitScroll = null;
      if ((debounceTimer || autoSearchEnabled) && isVisible && input && input.value) needsVisibleRefresh = true;
      clearTimeout(debounceTimer); debounceTimer = null;
      stopAutoSearch(); cancelPendingScroll();
      if (controller.isBusy()) {
        needsVisibleRefresh = !!(isVisible && input && input.value);
        controller.clear();
      }
    } else if (isVisible && !pageSuspended) {
      if (toolbarPosition) toolbarPosition.show();
      if (autoSearchEnabled) startAutoSearch();
      if (needsVisibleRefresh && input && input.value && !composing) {
        performSearch(input.value, "restore");
      }
    }
  });

  window.addEventListener("pagehide", function () {
    pageSuspended = true;
    if (toolbarPosition) toolbarPosition.hide();
    composing = false;
    clearTimeout(debounceTimer); debounceTimer = null;
    clearTimeout(recoveryTimer); recoveryTimer = null;
    stopAutoSearch(); removeHighlights();
    if (selectionTracker) selectionTracker.stop();
    lastSelection = null; autoAnchor = null;
    previousFocus = null;
    globalThis.RRWorkerManager.dispose();
  });
  window.addEventListener("pageshow", function (event) {
    pageSuspended = false;
    if (!isVisible) return;
    if (toolbarPosition && !document.hidden) toolbarPosition.show();
    if (selectionTracker) selectionTracker.start(controller.getState().roots);
    if (autoSearchEnabled) startAutoSearch();
    if (event.persisted && input && input.value) { rememberSelection(); performSearch(input.value, "restore"); }
  });

  // ── Message listener ─────────────────────────────────────────
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || sender && sender.id && sender.id !== chrome.runtime.id) return false;
    if (msg.action === "regexRabbitPing") { sendResponse({ loaded: true }); return false; }
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
