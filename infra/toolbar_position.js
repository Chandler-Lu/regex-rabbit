/** Keeps page-local toolbar placement; persistence is opt-in and local to this browser. */
(function () {
  "use strict";
  var SCALE_RANGE = globalThis.RRRuntimePolicy.settings.numericRanges.scale;
  var DEFAULT_RIGHT_PX = 12, DEFAULT_TOP_PX = 8;
  var DRAG_THRESHOLD_PX = 2;
  var KEYBOARD_STEP_PX = 8, LARGE_KEYBOARD_STEP_PX = 32;
  var VIEWPORT_OFFSET_EPSILON_PX = 0.01, VIEWPORT_SIZE_EPSILON_PX = 0.5;
  var STORAGE_KEY = "regexRabbitToolbarPosition", MARGIN = 4;
  function finite(value) { return typeof value === "number" && Number.isFinite(value); }
  function validPosition(value) {
    return value && typeof value === "object" && value.version === 1 &&
      finite(value.x) && value.x >= 0 && value.x <= 1 && finite(value.y) && value.y >= 0 && value.y <= 1;
  }
  function copy(value) { return value ? { version: 1, x: value.x, y: value.y } : null; }
  function create(options) {
    options = options || {};
    var container = options.container, handle = options.handle, onCommit = options.onCommit;
    var onMove = options.onMove, onDragStart = options.onDragStart;
    var position = null, scale = 1, remember = false, shown = false, disposed = false;
    var drag = null, frame = 0, revision = 0, readToken = 0, storageBusy = false, pendingWrite = null;
    var visual = globalThis.visualViewport || null;
    function notifyMove() { if (typeof onMove === "function") { try { onMove(); } catch (_) {} } }
    function viewport() {
      var width = visual && finite(visual.width) && visual.width > 0 ? visual.width : globalThis.innerWidth;
      var height = visual && finite(visual.height) && visual.height > 0 ? visual.height : globalThis.innerHeight;
      return { left: visual && finite(visual.offsetLeft) ? visual.offsetLeft : 0,
        top: visual && finite(visual.offsetTop) ? visual.offsetTop : 0,
        width: finite(width) && width > 0 ? width : 1, height: finite(height) && height > 0 ? height : 1 };
    }
    function updateViewportWidth(view) {
      if (container) container.style.setProperty("--rr-viewport-width", view.width + "px", "important");
    }
    function clearPositionStyle() {
      if (container) ["--rr-left", "--rr-top", "--rr-right"].forEach(function (name) { container.style.removeProperty(name); });
    }
    function bounds(view) {
      if (!container || !container.isConnected) return null;
      var rect = container.getBoundingClientRect(); view = view || viewport();
      if (!finite(rect.width) || !finite(rect.height) || rect.width <= 0 || rect.height <= 0) return null;
      var marginX = view.width > rect.width + MARGIN * 2 ? MARGIN : 0;
      var marginY = view.height > rect.height + MARGIN * 2 ? MARGIN : 0;
      return { rect: rect, left: view.left + marginX, top: view.top + marginY,
        width: Math.max(0, view.width - rect.width - marginX * 2),
        height: Math.max(0, view.height - rect.height - marginY * 2) };
    }
    function writePixels(left, top) {
      container.style.setProperty("--rr-left", (left / scale) + "px", "important");
      container.style.setProperty("--rr-top", (top / scale) + "px", "important");
      container.style.setProperty("--rr-right", "auto", "important");
      notifyMove();
    }
    function applyPixels(left, top) {
      var box = bounds();
      if (!box || !finite(left) || !finite(top)) return false;
      left = Math.max(box.left, Math.min(box.left + box.width, left));
      top = Math.max(box.top, Math.min(box.top + box.height, top));
      position = { version: 1, x: box.width ? (left - box.left) / box.width : 0,
        y: box.height ? (top - box.top) / box.height : 0 };
      writePixels(left, top); return true;
    }
    function refresh() {
      if (!shown || disposed) return;
      var view = viewport(); updateViewportWidth(view);
      var box = bounds(view);
      if (!box) { notifyMove(); return; }
      if (position) { writePixels(box.left + box.width * position.x, box.top + box.height * position.y); return; }
      // Viewport correction is presentation only: it must not become a remembered user move.
      var defaultLeft = view.left + view.width - box.rect.width - DEFAULT_RIGHT_PX * scale, defaultTop = view.top + DEFAULT_TOP_PX * scale;
      var left = Math.max(box.left, Math.min(box.left + box.width, defaultLeft));
      var top = Math.max(box.top, Math.min(box.top + box.height, defaultTop));
      var ordinaryView = Math.abs(view.left) < VIEWPORT_OFFSET_EPSILON_PX && Math.abs(view.top) < VIEWPORT_OFFSET_EPSILON_PX &&
        Math.abs(view.width - globalThis.innerWidth) < VIEWPORT_SIZE_EPSILON_PX && Math.abs(view.height - globalThis.innerHeight) < VIEWPORT_SIZE_EPSILON_PX;
      if (ordinaryView && left === defaultLeft && top === defaultTop) { clearPositionStyle(); notifyMove(); }
      else writePixels(left, top);
    }
    // Callback APIs and Promise APIs both work; runtime.lastError is consumed in the callback.
    function storageCall(method, argument, callback) {
      var completed = false, api;
      function done(ok, value) { if (!completed) { completed = true; callback(ok, value); } }
      try {
        api = globalThis.chrome && chrome.storage && chrome.storage.local;
        if (!api || typeof api[method] !== "function") { done(false); return; }
        var result = api[method](argument, function (value) {
          var error = globalThis.chrome && chrome.runtime && chrome.runtime.lastError;
          done(!error, value);
        });
        if (result && typeof result.then === "function") result.then(function (value) { done(true, value); }, function () { done(false); });
      } catch (_) { done(false); }
    }
    // At most one write and one replacement wait, even during fast repeated keyboard movement.
    function drainWrite() {
      if (storageBusy || !pendingWrite) return;
      var operation = pendingWrite; pendingWrite = null; storageBusy = true;
      storageCall(operation.value ? "set" : "remove", operation.value ?
        Object.fromEntries([[STORAGE_KEY, operation.value]]) : STORAGE_KEY, function () {
          storageBusy = false; drainWrite();
        });
    }
    function queueWrite(value) { pendingWrite = { value: copy(value) }; drainWrite(); }
    function readPosition() {
      if (!remember || disposed || storageBusy || pendingWrite) return;
      var token = ++readToken, startedRevision = revision;
      storageCall("get", STORAGE_KEY, function (ok, values) {
        if (!ok || disposed || !remember || token !== readToken || startedRevision !== revision) return;
        var saved = values && values[STORAGE_KEY];
        if (validPosition(saved)) { position = copy(saved); refresh(); }
      });
    }
    function commit() {
      if (remember && position) queueWrite(position);
      if (typeof onCommit === "function") { try { onCommit(copy(position)); } catch (_) {} }
    }
    function clearFrame() { if (frame) { globalThis.cancelAnimationFrame(frame); frame = 0; } }
    function removeDragListeners() {
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", end, true);
      document.removeEventListener("pointercancel", cancel, true);
    }
    function cancelDrag() {
      if (!drag) { clearFrame(); return; }
      var previous = drag; drag = null; clearFrame(); removeDragListeners();
      if (container) container.removeAttribute("data-rr-dragging");
      try { if (handle && handle.hasPointerCapture && handle.hasPointerCapture(previous.id)) handle.releasePointerCapture(previous.id); } catch (_) {}
    }
    function flushMove() {
      clearFrame();
      if (!drag || !shown || disposed || document.hidden || !container.isConnected) { cancelDrag(); return; }
      var dx = drag.x - drag.startX, dy = drag.y - drag.startY;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD_PX) return;
      if (applyPixels(drag.left + dx, drag.top + dy)) drag.moved = true;
      else cancelDrag();
    }
    function move(event) {
      if (!drag || event.pointerId !== drag.id) return;
      if (event.pointerType === "mouse" && finite(event.buttons) && !(event.buttons & 1)) { cancelDrag(); return; }
      if (!finite(event.clientX) || !finite(event.clientY)) return;
      event.preventDefault(); event.stopPropagation(); drag.x = event.clientX; drag.y = event.clientY;
      if (!frame) frame = globalThis.requestAnimationFrame(function () { frame = 0; flushMove(); });
    }
    function end(event) {
      if (!drag || event.pointerId !== drag.id) return;
      event.preventDefault(); event.stopPropagation();
      if (finite(event.clientX) && finite(event.clientY)) { drag.x = event.clientX; drag.y = event.clientY; }
      flushMove(); var moved = drag && drag.moved; cancelDrag(); if (moved) commit();
    }
    function cancel(event) { if (drag && (!event || event.pointerId === drag.id)) cancelDrag(); }
    function start(event) {
      if (!shown || disposed || drag || document.hidden || handle.disabled || event.isPrimary === false || event.button !== 0 || !finite(event.pointerId)) return;
      if (!finite(event.clientX) || !finite(event.clientY)) return;
      var box = bounds(); if (!box) return;
      event.preventDefault(); event.stopPropagation(); revision++;
      if (typeof onDragStart === "function") { try { onDragStart(); } catch (_) {} }
      if (!shown || disposed) return;
      drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
        left: box.rect.left, top: box.rect.top, moved: false };
      container.setAttribute("data-rr-dragging", "true");
      document.addEventListener("pointermove", move, { capture: true, passive: false });
      document.addEventListener("pointerup", end, { capture: true, passive: false });
      document.addEventListener("pointercancel", cancel, true);
      try { if (handle.setPointerCapture) handle.setPointerCapture(event.pointerId); } catch (_) {}
    }
    function reset() {
      if (disposed) return; cancelDrag(); revision++; readToken++; position = null;
      clearPositionStyle();
      if (shown) refresh(); else { updateViewportWidth(viewport()); notifyMove(); }
      if (remember) queueWrite(null);
      if (typeof onCommit === "function") { try { onCommit(null); } catch (_) {} }
    }
    function key(event) {
      if (!shown || disposed || event.altKey || event.ctrlKey || event.metaKey) return;
      var step = event.shiftKey ? LARGE_KEYBOARD_STEP_PX : KEYBOARD_STEP_PX, dx = 0, dy = 0;
      if (event.key === "Home") { event.preventDefault(); event.stopPropagation(); reset(); return; }
      if (event.key === "ArrowLeft") dx = -step;
      else if (event.key === "ArrowRight") dx = step;
      else if (event.key === "ArrowUp") dy = -step;
      else if (event.key === "ArrowDown") dy = step;
      else return;
      var box = bounds(); if (!box) return;
      event.preventDefault(); event.stopPropagation(); cancelDrag(); revision++;
      if (applyPixels(box.rect.left + dx, box.rect.top + dy)) commit();
    }
    function stopHandleClick(event) { event.preventDefault(); event.stopPropagation(); }
    function visibility() { if (document.hidden) cancelDrag(); else refresh(); }
    function listenView(add) {
      var method = add ? "addEventListener" : "removeEventListener";
      globalThis[method]("resize", refresh); document[method]("visibilitychange", visibility);
      if (visual) { visual[method]("resize", refresh); visual[method]("scroll", refresh); }
    }
    function attach(nextContainer, nextHandle) {
      if (disposed) return; cancelDrag();
      if (handle) { handle.removeEventListener("pointerdown", start); handle.removeEventListener("lostpointercapture", cancel); handle.removeEventListener("keydown", key); handle.removeEventListener("click", stopHandleClick); }
      container = nextContainer; handle = nextHandle;
      if (handle) { handle.addEventListener("pointerdown", start, { passive: false }); handle.addEventListener("lostpointercapture", cancel); handle.addEventListener("keydown", key); handle.addEventListener("click", stopHandleClick); }
      updateViewportWidth(viewport());
      refresh();
    }
    function show() { if (disposed) return; if (!shown) { shown = true; listenView(true); } refresh(); readPosition(); }
    function hide() { if (!shown) return; cancelDrag(); shown = false; readToken++; listenView(false); }
    function setConfig(config) {
      if (disposed || !config) return;
      if (finite(config.scale) && config.scale >= SCALE_RANGE.min && config.scale <= SCALE_RANGE.max && scale !== config.scale) {
        cancelDrag(); scale = config.scale; refresh();
      }
      if (typeof config.rememberPosition === "boolean" && remember !== config.rememberPosition) {
        remember = config.rememberPosition; readToken++;
        if (!remember) queueWrite(null);
        else if (position) queueWrite(position);
        else readPosition();
      }
    }
    function dispose() { if (disposed) return; hide(); attach(null, null); readToken++; disposed = true; }
    attach(container, handle);
    return { show: show, hide: hide, refresh: refresh, setConfig: setConfig, attach: attach, reset: reset, dispose: dispose };
  }
  globalThis.RRToolbarPosition = { create: create };
})();
