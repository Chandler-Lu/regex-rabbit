/** Compact page-search presentation. Execution and navigation belong to the controller. */
(function () {
  "use strict";
  var COMPOSITION_KEY_CODE = 229;
  var FULLWIDTH_ZERO_CODE = 0xff10;
  var COUNT_FULL_SIZE_CHARS = 10;
  var POLICY = globalThis.RRRuntimePolicy;
  function t(key, params) { return globalThis.RRi18n.t(key, params); }
  var SVG = "http://www.w3.org/2000/svg";
  var PATHS = { close: "M6 6l12 12M18 6L6 18", up: "M6 14l6-6 6 6", down: "M6 10l6 6 6-6",
    more: "M12 5h.01M12 12h.01M12 19h.01", drag: "M8 6h.01M16 6h.01M8 12h.01M16 12h.01M8 18h.01M16 18h.01", check: "M5 12l4 4L19 6",
    page: "M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6",
    selection: "M8 4H4v4M16 4h4v4M20 16v4h-4M8 20H4v-4M8 10h8M8 14h8" };
  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) { node.textContent = t(text); node.setAttribute("data-i18n", text); }
    return node;
  }
  function icon(name) {
    var svg = document.createElementNS(SVG, "svg"), path = document.createElementNS(SVG, "path");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
    path.setAttribute("d", PATHS[name]); svg.appendChild(path); return svg;
  }
  function button(id, label, className, action, iconName) {
    var node = element("button", className); node.type = "button";
    if (id) node.id = id;
    node.setAttribute("aria-label", t(label)); node.title = t(label);
    node.setAttribute("data-i18n-aria-label", label); node.setAttribute("data-i18n-title", label);
    if (iconName) node.appendChild(icon(iconName)); else { node.textContent = t(label); node.setAttribute("data-i18n", label); }
    if (action) node.addEventListener("click", action);
    return node;
  }
  function radioGroup(id, label, choices, onChange) {
    var group = element("div", "rr-choice-row"); group.id = id;
    group.setAttribute("role", "radiogroup"); group.setAttribute("aria-label", t(label)); group.setAttribute("data-i18n-aria-label", label);
    group.appendChild(element("span", "rr-group-label", label));
    var track = element("div", "rr-segments"), value = choices[0].value;
    var buttons = choices.map(function (choice) {
      var node = button(choice.id, choice.label, "rr-segment", function () { choose(choice.value); });
      node.setAttribute("role", "radio"); track.appendChild(node); return node;
    });
    function refresh() {
      choices.forEach(function (choice, index) {
        var selected = value === choice.value;
        buttons[index].setAttribute("aria-checked", String(selected)); buttons[index].tabIndex = selected ? 0 : -1;
      });
    }
    function choose(next) {
      if (next === value) return;
      value = next; refresh(); if (onChange) onChange(next);
      group.dispatchEvent(new Event("change", { bubbles: true }));
    }
    group.addEventListener("keydown", function (event) {
      var index = buttons.indexOf(event.target), next = index;
      if (index < 0 || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % buttons.length;
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index + buttons.length - 1) % buttons.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = buttons.length - 1;
      else return;
      event.preventDefault(); choose(choices[next].value); buttons[next].focus();
    });
    Object.defineProperty(group, "value", { get: function () { return value; },
      set: function (next) { if (choices.some(function (choice) { return choice.value === next; })) { value = next; refresh(); } } });
    group.appendChild(track); refresh(); return { group: group, buttons: buttons, choose: choose };
  }
  function toggle(id, label, title, action) {
    var node = button(id, label, "rr-toggle", action); node.textContent = "";
    node.removeAttribute("data-i18n"); node.title = t(title || label); node.setAttribute("data-i18n-title", title || label); node.setAttribute("aria-pressed", "false");
    var check = element("span", "rr-check"); check.appendChild(icon("check"));
    node.append(check, element("span", "", label)); return node;
  }
  function create(actions) {
    actions = actions || {};
    var container = element("div"); container.id = "regex-search-container";
    container.setAttribute("data-regex-rabbit-owned", "true"); container.setAttribute("role", "search");
    container.setAttribute("aria-label", t("toolbar.searchLabel")); container.setAttribute("data-i18n-aria-label", "toolbar.searchLabel"); container.style.display = "none";
    var row = element("div", "rr-query-row"), field = element("div", "rr-query-field");
    var input = element("input"); input.id = "regex-search-input"; input.type = "text";
    input.maxLength = POLICY.search.maxPatternChars;
    input.spellcheck = false; input.autocomplete = "off";
    input.setAttribute("aria-label", t("toolbar.inputLabel")); input.setAttribute("data-i18n-aria-label", "toolbar.inputLabel"); input.setAttribute("data-i18n-placeholder", "toolbar.find"); input.setAttribute("aria-describedby", "regex-search-status regex-search-status-detail");
    var inputHint = t("toolbar.inputHint");
    input.title = inputHint; field.appendChild(input);
    var modeQuick = button("regex-mode-toggle", "toolbar.regex", "rr-quick-toggle rr-mode-quick"); modeQuick.textContent = ".*"; modeQuick.removeAttribute("data-i18n");
    modeQuick.setAttribute("aria-pressed", "true");
    var caseBtn = button("regex-case-toggle", "toolbar.caseSensitive", "rr-quick-toggle rr-case-quick", actions.onCase);
    caseBtn.textContent = "Aa"; caseBtn.removeAttribute("data-i18n"); caseBtn.setAttribute("aria-pressed", "false");
    var count = element("span", "rr-count"); count.id = "regex-search-count";
    count.setAttribute("aria-label", t("toolbar.count")); count.setAttribute("data-i18n-aria-label", "toolbar.count"); count.setAttribute("aria-live", "polite"); count.setAttribute("aria-atomic", "true");
    var locate = button("regex-locate-button", "toolbar.jumpLabel", "rr-locate", startJump); locate.textContent = ""; locate.removeAttribute("data-i18n");
    locate.appendChild(count); locate.disabled = true;
    var resultControl = element("div", "rr-result-control");
    var jumpInput = element("input", "rr-jump-input"); jumpInput.id = "regex-jump-input";
    jumpInput.type = "text"; jumpInput.inputMode = "numeric"; jumpInput.maxLength = 12;
    jumpInput.autocomplete = "off"; jumpInput.spellcheck = false; jumpInput.hidden = true;
    jumpInput.setAttribute("data-i18n-aria-label", "toolbar.jumpLabel"); jumpInput.setAttribute("data-i18n-title", "toolbar.jumpHint");
    resultControl.append(locate, jumpInput);
    var nav = element("div", "rr-nav"); nav.id = "regex-nav-button-wrapper";
    var prev = button("regex-prev-button", "toolbar.previous", "rr-icon-button", function () { actions.onNavigate(-1); }, "up");
    var next = button("regex-next-button", "toolbar.next", "rr-icon-button", function () { actions.onNavigate(1); }, "down");
    prev.disabled = next.disabled = true; nav.append(prev, next);
    var advanced = button("regex-advanced-toggle", "toolbar.more", "rr-icon-button rr-more", null, "more");
    advanced.setAttribute("aria-haspopup", "dialog"); advanced.setAttribute("aria-expanded", "false");
    advanced.setAttribute("aria-controls", "regex-advanced-panel");
    var close = button("regex-close-button", "toolbar.close", "rr-icon-button", actions.onClose, "close");
    var dragHandle = button("regex-drag-handle", "toolbar.drag", "rr-drag-handle", null, "drag");
    var scope = element("button", "rr-scope-toggle"), scopeValue = "page";
    scope.id = "regex-search-scope"; scope.type = "button";
    scope.setAttribute("aria-describedby", "regex-search-status regex-search-status-detail");
    var scopeIcon = icon("page"), scopePath = scopeIcon.firstChild;
    scope.appendChild(scopeIcon);
    function refreshScope() {
      var selected = scopeValue === "selection";
      scopePath.setAttribute("d", PATHS[scopeValue]);
      scope.setAttribute("value", scopeValue);
      scope.setAttribute("data-scope", scopeValue);
      var hint = t("toolbar.scopeSwitch", { current: t(selected ? "toolbar.selection" : "toolbar.page"),
        next: t(selected ? "toolbar.page" : "toolbar.selection") });
      scope.setAttribute("aria-label", hint);
      scope.title = hint + " · " + t("toolbar.selectionHint");
    }
    Object.defineProperty(scope, "value", { get: function () { return scopeValue; },
      set: function (next) { if (next === "page" || next === "selection") { scopeValue = next; refreshScope(); } } });
    scope.addEventListener("click", function () {
      closeDetails(); scope.value = scopeValue === "page" ? "selection" : "page";
      scope.dispatchEvent(new Event("change", { bubbles: true }));
    });
    row.append(dragHandle, field, modeQuick, caseBtn, scope, resultControl, nav, advanced, close); container.appendChild(row);

    var panel = element("div", "rr-menu"); panel.id = "regex-advanced-panel"; panel.hidden = true;
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", t("toolbar.options")); panel.setAttribute("data-i18n-aria-label", "toolbar.options");
    var mode = radioGroup("regex-search-mode", "toolbar.mode", [
      { value: "literal", label: "toolbar.text", id: "regex-mode-literal" }, { value: "regex", label: "toolbar.regexShort", id: "regex-mode-regex" }
    ], actions.onMode);
    modeQuick.addEventListener("click", function () { mode.choose(mode.group.value === "regex" ? "literal" : "regex"); });
    mode.group.classList.add("rr-mode-menu");
    panel.append(mode.group);
    var basics = element("div", "rr-menu-toggles");
    var caseMenu = toggle("regex-case-menu-toggle", "toolbar.caseShort", "toolbar.caseSensitive", actions.onCase);
    caseMenu.classList.add("rr-case-menu");
    var wordBtn = toggle("regex-word-toggle", "toolbar.wholeWord", "toolbar.wholeWordHint", actions.onWord);
    var autoBtn = toggle("regex-auto-toggle", "toolbar.auto", "toolbar.autoHint", actions.onAuto);
    basics.append(caseMenu, wordBtn, autoBtn); panel.appendChild(basics);
    var regexOptions = element("div", "rr-regex-options rr-menu-toggles");
    var multilineBtn = toggle("regex-multiline-toggle", "toolbar.multiline", "toolbar.multilineHint", actions.onMultiline);
    var dotAllBtn = toggle("regex-dotall-toggle", "toolbar.dotAll", "toolbar.dotAllHint", actions.onDotAll);
    regexOptions.append(multilineBtn, dotAllBtn); panel.appendChild(regexOptions);
    var menuNav = element("div", "rr-menu-nav");
    var menuPrev = button("regex-menu-prev-button", "toolbar.previousShort", "rr-menu-action", function () { actions.onNavigate(-1); }, "up");
    var menuNext = button("regex-menu-next-button", "toolbar.nextShort", "rr-menu-action", function () { actions.onNavigate(1); }, "down");
    menuPrev.appendChild(element("span", "", "toolbar.previousShort")); menuNext.appendChild(element("span", "", "toolbar.nextShort"));
    menuNav.append(menuPrev, menuNext); panel.appendChild(menuNav);
    var settings = button("regex-settings-button", "toolbar.settings", "rr-settings", actions.onSettings); panel.appendChild(settings);
    container.appendChild(panel);

    var feedback = element("div", "rr-feedback"); feedback.hidden = true;
    var status = element("span", "rr-status"); status.id = "regex-search-status";
    status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite"); status.setAttribute("aria-atomic", "true");
    var detail = element("span", "rr-sr-only"); detail.id = "regex-search-status-detail";
    feedback.appendChild(element("span", "rr-feedback-text")); container.append(feedback, status, detail);
    var feedbackText = feedback.firstChild, currentMode = "regex", editingCount = "";
    function startJump() {
      var result = /^(\d+)\/(\d+)/.exec(count.textContent);
      if (locate.disabled || !result || Number(result[2]) < 1) return;
      closeDetails(); editingCount = count.textContent;
      locate.hidden = true; jumpInput.hidden = false; jumpInput.value = result[1];
      jumpInput.setCustomValidity(""); jumpInput.setAttribute("aria-invalid", "false");
      jumpInput.focus({ preventScroll: true }); jumpInput.select();
    }
    function cancelJump(restoreFocus) {
      if (jumpInput.hidden) return;
      jumpInput.hidden = true; locate.hidden = false; editingCount = "";
      jumpInput.setCustomValidity(""); jumpInput.setAttribute("aria-invalid", "false");
      if (restoreFocus) locate.focus({ preventScroll: true });
    }
    function jumpRangeError() {
      var result = /^(\d+)\/(\d+)/.exec(count.textContent);
      var message = t("toolbar.jumpRange", { total: result ? result[2] : "0" });
      jumpInput.setCustomValidity(message); jumpInput.setAttribute("aria-invalid", "true"); jumpInput.title = message;
      jumpInput.reportValidity();
    }
    jumpInput.addEventListener("input", function () {
      jumpInput.setCustomValidity(""); jumpInput.setAttribute("aria-invalid", "false"); jumpInput.title = t("toolbar.jumpHint");
    });
    jumpInput.addEventListener("blur", function () { cancelJump(false); });
    jumpInput.addEventListener("keydown", function (event) {
      if (event.isComposing || event.keyCode === COMPOSITION_KEY_CODE) return;
      if (event.key === "Escape") { event.preventDefault(); cancelJump(true); return; }
      if (event.key !== "Enter") return;
      event.preventDefault();
      var raw = jumpInput.value.trim().replace(/[０-９]/g, function (digit) { return String(digit.charCodeAt(0) - FULLWIDTH_ZERO_CODE); });
      var result = /^(\d+)\/(\d+)/.exec(count.textContent), value = Number(raw);
      if (!/^\d{1,12}$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || !result || value > Number(result[2])) { jumpRangeError(); return; }
      cancelJump(false);
      if (typeof actions.onJump === "function" && actions.onJump(value) === false) { startJump(); if (!jumpInput.hidden) { jumpInput.value = raw; jumpRangeError(); } }
    });
    function outside(event) { if (!container.contains(event.target)) closeDetails(); }
    function closeDetails(restoreFocus) {
      panel.hidden = true; advanced.setAttribute("aria-expanded", "false"); container.removeAttribute("data-details");
      document.removeEventListener("pointerdown", outside, true);
      container.appendChild(feedback); reposition();
      if (restoreFocus) advanced.focus({ preventScroll: true });
    }
    advanced.addEventListener("click", function (event) {
      if (!panel.hidden) { closeDetails(); return; }
      panel.hidden = false; advanced.setAttribute("aria-expanded", "true"); container.setAttribute("data-details", "true");
      panel.insertBefore(feedback, panel.firstChild); document.addEventListener("pointerdown", outside, true);
      reposition();
      if (!event.detail) {
        var first = Array.from(panel.querySelectorAll("button")).find(function (node) {
          return !node.disabled && node.tabIndex >= 0 && node.getClientRects().length;
        });
        if (first) first.focus({ preventScroll: true });
      }
    });
    input.addEventListener("focus", function () { closeDetails(); });
    input.addEventListener("pointerdown", function () { closeDetails(); });
    field.addEventListener("click", function () { input.focus(); });
    // Page hotkeys must not handle arrow keys or typing from this toolbar.
    container.addEventListener("keydown", function (event) { event.stopPropagation(); });
    container.addEventListener("click", function (event) { event.stopPropagation(); });
    function syncCount() {
      if (!jumpInput.hidden && editingCount !== count.textContent) cancelJump(false);
      count.classList.toggle("rr-count-long", count.textContent.length > COUNT_FULL_SIZE_CHARS);
      var result = /^(\d+)\/(\d+)/.exec(count.textContent);
      locate.setAttribute("aria-label", result ? t("toolbar.locateCount", { current: result[1], total: result[2] }) : t("toolbar.locate"));
      locate.title = result ? t("toolbar.jumpHint") : t("toolbar.noMatches");
      menuPrev.disabled = menuNext.disabled = !result || Number(result[2]) < 2;
    }
    function updateOptions(config, caseSensitive, auto) {
      currentMode = config.mode; mode.group.value = currentMode;
      modeQuick.setAttribute("aria-pressed", String(currentMode === "regex"));
      input.placeholder = t("toolbar.find"); input.setAttribute("data-mode", currentMode);
      regexOptions.hidden = currentMode !== "regex";
      [[caseBtn, caseSensitive], [caseMenu, caseSensitive], [wordBtn, config.wholeWord], [autoBtn, auto],
        [multilineBtn, config.multiline], [dotAllBtn, config.dotAll]].forEach(function (item) {
        item[0].classList.toggle("active", !!item[1]); item[0].setAttribute("aria-pressed", String(!!item[1]));
      });
      multilineBtn.disabled = dotAllBtn.disabled = currentMode !== "regex";
      var enabled = !!config.wholeWord || !!auto || currentMode === "regex" && (config.multiline || config.dotAll);
      advanced.setAttribute("data-active-options", String(enabled));
    }
    function setStatus(message, explanation, tone) {
      status.textContent = message || ""; detail.textContent = explanation || "";
      feedbackText.textContent = message || ""; feedback.title = explanation || message || "";
      feedback.hidden = !(tone === "error" || tone === "warning");
      input.title = feedback.hidden ? inputHint : [message, explanation].filter(Boolean).join(" · ");
      container.setAttribute("data-tone", tone || "neutral"); reposition();
    }
    function idle() {
      setStatus(t("toolbar.idle"), "", "neutral"); input.setAttribute("aria-invalid", "false"); scope.setAttribute("aria-invalid", "false");
    }
    function refreshLanguage() {
      globalThis.RRi18n.apply(container); container.lang = globalThis.RRi18n.getLanguage();
      refreshScope();
      inputHint = t("toolbar.inputHint");
      if (feedback.hidden) input.title = inputHint;
      if (jumpInput.getAttribute("aria-invalid") === "true") {
        var result = /^(\d+)\/(\d+)/.exec(count.textContent);
        var message = t("toolbar.jumpRange", { total: result ? result[2] : "0" });
        jumpInput.setCustomValidity(message); jumpInput.title = message;
      }
      syncCount(); reposition();
    }
    function reposition() {
      if (!container.isConnected || !container.hasAttribute("data-regex-rabbit-visible")) return;
      var floating = !panel.hidden ? panel : !feedback.hidden ? feedback : null;
      if (!floating) { container.removeAttribute("data-floating-above"); return; }
      var viewport = window.visualViewport;
      var top = viewport ? viewport.offsetTop : 0, height = viewport ? viewport.height : innerHeight;
      var box = container.getBoundingClientRect();
      var scale = Number(container.style.getPropertyValue("--regex-rabbit-scale")) || 1;
      var above = Math.max(0, box.top - top - 5 * scale);
      var below = Math.max(0, top + height - box.bottom - 5 * scale);
      var required = floating.getBoundingClientRect().height;
      var useAbove = required > below && above > below;
      container.setAttribute("data-floating-above", String(useAbove));
      container.style.setProperty("--rr-popup-height", Math.max(20, (useAbove ? above : below) / scale) + "px", "important");
    }
    function getAvoidRect() {
      var rect = container.getBoundingClientRect();
      var result = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      [panel, feedback].forEach(function (node) {
        if (node.hidden) return;
        var box = node.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0) return;
        result.left = Math.min(result.left, box.left); result.top = Math.min(result.top, box.top);
        result.right = Math.max(result.right, box.right); result.bottom = Math.max(result.bottom, box.bottom);
      });
      result.width = result.right - result.left; result.height = result.bottom - result.top; return result;
    }
    refreshLanguage();
    return { container: container, input: input, dragHandle: dragHandle, jumpInput: jumpInput, caseBtn: caseBtn, autoBtn: autoBtn, countEl: count,
      prevBtn: prev, nextBtn: next, closeBtn: close, modeBtn: modeQuick, wordBtn: wordBtn, locateBtn: locate,
      multilineBtn: multilineBtn, dotAllBtn: dotAllBtn, scopeEl: scope,
      updateOptions: updateOptions, setStatus: setStatus, idle: idle, syncInput: function () {}, syncCount: syncCount,
      confirmLocation: function () {}, refreshLanguage: refreshLanguage, reposition: reposition, getAvoidRect: getAvoidRect,
      cancelJump: cancelJump, isJumpOpen: function () { return !jumpInput.hidden; }, closeDetails: closeDetails, isDetailsOpen: function () { return !panel.hidden; } };
  }
  globalThis.RRSearchToolbar = { create: create };
})();
